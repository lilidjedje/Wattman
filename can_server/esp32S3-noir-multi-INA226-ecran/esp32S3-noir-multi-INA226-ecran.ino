#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WebServer.h>
#include <SPI.h>
#include <mcp_can.h>
#include "esp_timer.h"

// Inclusions pour l'écran 128x128 ST7735
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>

// =========================================================================
// CONFIGURATION DES BROCHES MATÉRIELLES (ESP32-S3 NON-CONFLIT)
// =========================================================================
// =========================================================================
// CONFIGURATION DES BROCHES MATÉRIELLES (ESP32-S3 OPTIMISÉ SANS GPIO 3)
// =========================================================================
// Capteurs INA226 (Bus I2C sécurisé et neutre au démarrage)
#define I2C_SDA       15  // Ligne de Données I2C (GPIO 15)
#define I2C_SCL       16  // Ligne d'Horloge I2C (GPIO 16)

// BUS SPI PARTAGÉ (FSPI Matériel Natif — Couleur Orange en Bas à Gauche)
#define SPI_SCK       12  // Ligne Horloge commune (Vers SCK du CAN et SCK de l'écran)
#define SPI_MISO      13  // Ligne Données Entrantes (Vers SO/MISO du CAN uniquement)
#define SPI_MOSI      11  // Ligne Données Sortantes (Vers SI/MOSI du CAN et SDA de l'écran)

// Périphérique 1 : Contrôleur CAN MCP2515
#define PIN_CS_CAN    8   // Broche CS dédiée au CAN (GPIO 8)
#define PIN_INT_CAN   4   // Broche Interruption dédiée au CAN (GPIO 4)

// Périphérique 2 : Écran TFT 128x128 (ST7735)
#define PIN_CS_TFT    9   // Broche CS dédiée à l'écran (GPIO 9)
#define PIN_DC_TFT    10  // Broche Data/Command dédiée à l'écran — Notée A0 (GPIO 10)
#define PIN_RST_TFT   14  // Broche Reset dédiée à l'écran — Notée RESET (GPIO 14)

// Adresses I2C et registres du capteur INA226
const uint8_t ADDR_INA_A = 0x40; 
const uint8_t ADDR_INA_B = 0x41; 
const uint8_t REG_CONFIG = 0x00;
const uint8_t REG_SHUNT  = 0x01;

// Identifiants du réseau de trames CAN
#define CAN_ID_CURRENT_A     0x100  
#define CAN_ID_STATS_A       0x101  
#define CAN_ID_CURRENT_B     0x102  
#define CAN_ID_STATS_B       0x103  
#define CAN_ID_TIME_SYNC     0x105  

const char* AP_SSID = "courant_1";
const char* AP_PASS = "12345678";

// Initialisation des objets de périphériques
MCP_CAN CAN(PIN_CS_CAN);
WebServer server(80);

// Déclaration de l'écran avec le bus SPI matériel partagé
Adafruit_ST7735 tft = Adafruit_ST7735(PIN_CS_TFT, PIN_DC_TFT, PIN_RST_TFT);

esp_timer_handle_t acqTimer = nullptr;
TaskHandle_t taskAcqHandle = nullptr;


#define ST7735_GRAY 0x8410  // Définition de la couleur grise en RGB565

// Signaux d'état de session partagés (FreeRTOS Atomics)
volatile uint32_t testDurationSec = 0;
volatile bool     testRunning     = false;
unsigned long     testStartMillis = 0;
volatile uint32_t pcBaseTimestamp = 0; 

// Variables de stockage du courant INSTANTANÉ lues par le Cœur 1, affichées par le Cœur 0
volatile float courantInstantaneA = 0.0f;
volatile float courantInstantaneB = 0.0f;

// Compteurs et statistiques d'acquisition
volatile uint32_t acqCountA = 0,    acqCountB = 0;
volatile uint32_t lostCountA = 0,   lostCountB = 0;
volatile uint32_t freqReelleA = 0,  freqReelleB = 0;

struct ConfigPayload {
  uint32_t frequency;
  uint32_t duration; 
  uint32_t activeA;
  uint32_t activeB;
};
volatile ConfigPayload currentCfg = {1000, 10, 1, 1};

// Settings SPI spécifiques à chaque composant pour éviter les conflits de registres
SPISettings canSPISettings(4000000, MSBFIRST, SPI_MODE0);
SPISettings tftSPISettings(16000000, MSBFIRST, SPI_MODE0); // L'écran peut tourner plus vite (16MHz)

// =========================================================================
// PILOTAGE DES COMPOSANTS MATÉRIELS I2C (INA226)
// =========================================================================
bool inaWriteRegister16(uint8_t addr, uint8_t reg, uint16_t value) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write((uint8_t)((value >> 8) & 0xFF));
  Wire.write((uint8_t)(value & 0xFF));
  return (Wire.endTransmission() == 0);
}

void configureINA226(uint8_t addr, uint32_t freq) {
  uint16_t config_bits;
  
  if (freq >= 900) {
    config_bits = (0b000 << 9)   | // AVG : 1 échantillon (Pas de moyenne)
                  (0b000 << 6)   | // VBUS Conversion Time : 140 µs
                  (0b000 << 3)   | // VSHUNT Conversion Time : 140 µs
                  0b111;           // Mode : Shunt and Bus, Continuous
  } else {
    config_bits = (0b000 << 9)   | // AVG : 1 échantillon
                  (0b100 << 6)   | // VBUS Conversion Time : 1.1 ms
                  (0b100 << 3)   | // VSHUNT Conversion Time : 1.1 ms
                  0b111;           // Mode : Shunt and Bus, Continuous
  }
  inaWriteRegister16(addr, REG_CONFIG, config_bits);
}

inline int16_t readINA226ShuntRaw(uint8_t addr) {
  Wire.beginTransmission(addr);
  Wire.write(REG_SHUNT);
  if (Wire.endTransmission(false) != 0) return 0;
  if (Wire.requestFrom(addr, (uint8_t)2) == 2) {
    return (int16_t)((Wire.read() << 8) | Wire.read());
  }
  return 0;
}

void IRAM_ATTR onAcqTimer(void* arg) {
  if (taskAcqHandle) {
    BaseType_t xHigherPriorityTaskWoken = pdFALSE;
    vTaskNotifyGiveFromISR(taskAcqHandle, &xHigherPriorityTaskWoken);
    if (xHigherPriorityTaskWoken) {
      portYIELD_FROM_ISR();
    }
  }
}

// =========================================================================
// CŒUR 1 : APPLICATION DE MÉTROLOGIE ET TRANSMISSION CAN TRACEUR
// =========================================================================
void taskAcq(void* parameter) {
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(400000);
  Wire.setTimeOut(25);

  SPI.begin(SPI_SCK, SPI_MISO, SPI_MOSI);
  
  // Utilisation des transactions SPI pour cohabiter proprement avec l'écran
  SPI.beginTransaction(canSPISettings);
  CAN.begin(MCP_ANY, CAN_500KBPS, MCP_8MHZ);
  CAN.setMode(MCP_NORMAL);
  SPI.endTransaction();

  uint32_t lastPrintMs = 0;
  uint32_t lastSnapshotA = 0, lastSnapshotB = 0;
  byte canPacket[8] = {0};

  for (;;) {
    if (!testRunning) {
      vTaskDelay(pdMS_TO_TICKS(10));
      continue;
    }

    uint32_t nNotify = ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(500));
    if (nNotify == 0) {
      if (currentCfg.activeA) lostCountA++;
      if (currentCfg.activeB) lostCountB++;
      continue;
    }

    if (nNotify > 1) {
      if (currentCfg.activeA) lostCountA += (nNotify - 1);
      if (currentCfg.activeB) lostCountB += (nNotify - 1);
    }

    // Ouverture transaction SPI pour le contrôleur CAN MCP2515
    SPI.beginTransaction(canSPISettings);

    if (currentCfg.activeA) {
      acqCountA++;
      int16_t rawA = readINA226ShuntRaw(ADDR_INA_A);
      float IA = rawA * 2.5e-6f / 0.1f;
      courantInstantaneA = IA; // Écriture ultra-rapide pour partage Cœur 0
      
      memset(canPacket, 0, 8);
      memcpy(&canPacket[0], &IA, sizeof(float));
      CAN.sendMsgBuf(CAN_ID_CURRENT_A, 0, 8, canPacket);
    }

    if (currentCfg.activeB) {
      acqCountB++;
      int16_t rawB = readINA226ShuntRaw(ADDR_INA_B);
      float IB = rawB * 2.5e-6f / 0.1f;
      courantInstantaneB = IB; // Écriture ultra-rapide pour partage Cœur 0
      
      memset(canPacket, 0, 8);
      memcpy(&canPacket[0], &IB, sizeof(float));
      CAN.sendMsgBuf(CAN_ID_CURRENT_B, 0, 8, canPacket);
    }

    uint32_t nowMs = millis();
    if (nowMs - lastPrintMs >= 1000) {
      freqReelleA = acqCountA - lastSnapshotA;
      freqReelleB = acqCountB - lastSnapshotB;
      lastSnapshotA = acqCountA;
      lastSnapshotB = acqCountB;
      lastPrintMs = nowMs;

      if (currentCfg.activeA) {
        uint16_t statsA[2] = {(uint16_t)freqReelleA, (uint16_t)lostCountA};
        memset(canPacket, 0, 8);
        memcpy(&canPacket[0], &statsA[0], 2);
        memcpy(&canPacket[2], &statsA[1], 2);
        CAN.sendMsgBuf(CAN_ID_STATS_A, 0, 8, canPacket);
      }

      if (currentCfg.activeB) {
        uint16_t statsB[2] = {(uint16_t)freqReelleB, (uint16_t)lostCountB};
        memset(canPacket, 0, 8);
        memcpy(&canPacket[0], &statsB[0], 2);
        memcpy(&canPacket[2], &statsB[1], 2);
        CAN.sendMsgBuf(CAN_ID_STATS_B, 0, 8, canPacket);
      }

      uint32_t calcul_ts = pcBaseTimestamp + ((nowMs - testStartMillis) / 1000UL);
      memset(canPacket, 0, 8);
      memcpy(&canPacket[0], &calcul_ts, 4);
      CAN.sendMsgBuf(CAN_ID_TIME_SYNC, 0, 4, canPacket);
    }

    // Fermeture de la transaction SPI CAN
    SPI.endTransaction();

    if (nowMs - testStartMillis >= testDurationSec * 1000UL) {
      testRunning = false;
      esp_timer_stop(acqTimer);
      Serial.println("[SYSTEM] Fin de l'acquisition.");
    }
  }
}

// =========================================================================
// CŒUR 0 : SERVICES DU SERVEUR WEB INTERNE ET DES FLUX RADIO WI-FI
// =========================================================================
void handleRoot() {
  static const char HTML[] PROGMEM = R"HTML(
<!DOCTYPE html><html lang="fr"><head>
<meta charset="utf-8"><title>Contrôle Point d'Accès INA226</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:Segoe UI,Arial;margin:1.5rem;color:#222;background:#f8fafc}
.card{background:white;padding:1.5rem;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.05);margin-bottom:1rem;max-width:500px}
h2{margin-top:0;color:#1e293b;font-size:1.1rem}
label{font-weight:600;font-size:0.9rem}
input, select{padding:0.4rem;font-size:1rem;margin-top:0.3rem;width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:4px}
.duration-group{display:flex;gap:10px;}
.duration-group input{flex:2;}
.duration-group select{flex:1;}
button{padding:0.7rem;font-size:1rem;cursor:pointer;background:#10b981;color:white;border:none;border-radius:4px;width:100%;font-weight:600;margin-top:1rem}
.btn-stop{background:#dc2626;margin-top:0.5rem;display:none;}
.progress-container{margin-top:1rem;display:none;}
.progress-bar-bg{background:#e2e8f0;border-radius:6px;overflow:hidden;height:20px;width:100%;border:1px solid #cbd5e1;}
.progress-bar-fill{background:#3b82f6;height:100%;width:0%;transition:width 0.3s ease;}
.progress-text{font-size:0.85rem;color:#475569;margin-top:0.3rem;text-align:center;font-weight:bold;}
</style>
</head><body>
  <h1>Générateur de Trames CAN Autonome (S3 Dual-Core)</h1>
  <div class="card">
    <h2>📊 État de l'acquisition</h2>
    <div id="statusText" style="font-weight:bold; color:#64748b;">Statut : Prêt / En attente</div>
    <div class="progress-container" id="progressContainer">
      <div class="progress-bar-bg"><div class="progress-bar-fill" id="progressBarFill"></div></div>
      <div class="progress-text" id="progressText">0% (0s / 0s)</div>
    </div>
    <button onclick="stopperAcquisition()" class="btn-stop" id="btnStop">🛑 Arrêter le Test</button>
  </div>
  <form id="formConfig">
    <input type="hidden" id="clientTime" name="clientTime">
    
    <div class="card">
      <h2>⚙️ Configuration Globale</h2>
      <label>Fréquence (Hz)</label>
      <select name="freq">
        <option value="100">100 Hz</option> <option value="500">500 Hz</option>
        <option value="1000" selected>1000 Hz</option> <option value="2000">2000 Hz</option>
      </select><br><br>
      <label>Durée de l'enregistrement</label>
      <div class="duration-group">
        <input type="number" name="dureeValeur" min="1" value="10" required>
        <select name="dureeUnite">
          <option value="s">Secondes</option> <option value="m">Minutes</option>
          <option value="h">Heures</option> <option value="j">Jours</option>
        </select>
      </div>
    </div>
    <div class="card">
      <label><input type="checkbox" name="activeA" value="1" checked style="width:auto"> Capteur A (Entrée - 0x40)</label><br>
      <label><input type="checkbox" name="activeB" value="1" checked style="width:auto"> Capteur B (Sortie - 0x41)</label>
    </div>
    <div style="max-width:500px"><button type="submit">🚀 Lancer l'acquisition</button></div>
  </form>
  <script>
    let intervalStatus = null;
    document.getElementById("formConfig").addEventListener("submit", function(e) {
      e.preventDefault();
      document.getElementById("clientTime").value = Math.floor(Date.now() / 1000);
      
      fetch("/setDuration", { method: "POST", body: new FormData(this) })
      .then(r => r.text()).then(txt => { alert(txt); demarrerSuiviJauge(); });
    });
    function demarrerSuiviJauge() {
      document.getElementById("progressContainer").style.display = "block";
      document.getElementById("btnStop").style.display = "block";
      document.getElementById("statusText").innerText = "Statut : Acquisition en cours...";
      document.getElementById("statusText").style.color = "#10b981";
      if(intervalStatus) clearInterval(intervalStatus);
      intervalStatus = setInterval(() => {
        fetch("/getStatus").then(r => r.json()).then(data => {
          if (!data.running) {
            clearInterval(intervalStatus);
            document.getElementById("progressBarFill").style.width = "100%";
            document.getElementById("progressText").innerText = "Terminé !";
            document.getElementById("statusText").innerText = "Statut : Libre / Session achevée.";
            document.getElementById("statusText").style.color = "#2563eb";
            document.getElementById("btnStop").style.display = "none";
          } else {
            let p = (data.elapsed / data.total) * 100;
            document.getElementById("progressBarFill").style.width = p + "%";
            document.getElementById("progressText").innerText = Math.round(p) + "% (" + data.elapsed + "s / " + data.total + "s)";
          }
        });
      }, 1000);
    }
    function stopperAcquisition() {
      if(confirm("Voulez-vous vraiment couper immédiatement l'acquisition ?")) {
        fetch("/stop").then(r => r.text()).then(txt => {
          alert(txt); clearInterval(intervalStatus);
          document.getElementById("btnStop").style.display = "none";
          document.getElementById("statusText").innerText = "Statut : Prêt / Interrompu.";
          document.getElementById("statusText").style.color = "#64748b";
        });
      }
    }
  </script>
</body></html>
)HTML";
  server.send(200, "text/html; charset=utf-8", HTML);
}

void handleGetStatus() {
  uint32_t elapsed = 0;
  if (testRunning) elapsed = (millis() - testStartMillis) / 1000UL;
  String json = "{\"running\":" + String(testRunning ? "true" : "false") + ",\"elapsed\":" + String(elapsed) + ",\"total\":" + String(testDurationSec) + "}";
  server.send(200, "application/json", json);
}

void handleStop() {
  esp_timer_stop(acqTimer);
  testRunning = false;
  server.send(200, "text/plain", "Acquisition coupée.");
}

void handleSetDuration() {
  if (testRunning) {
    server.send(423, "text/plain", "⚠️ Acquisition déjà en cours.");
    return;
  }
  
  if (server.hasArg("clientTime")) {
    pcBaseTimestamp = server.arg("clientTime").toInt();
  } else {
    pcBaseTimestamp = 1781582267; 
  }

  uint32_t targetFreq = server.arg("freq").toInt();
  uint32_t valeurSaisie = server.arg("dureeValeur").toInt();
  String uniteSaisie = server.arg("dureeUnite");

  if (uniteSaisie == "m") testDurationSec = valeurSaisie * 60UL;
  else if (uniteSaisie == "h") testDurationSec = valeurSaisie * 3600UL;
  else if (uniteSaisie == "j") testDurationSec = valeurSaisie * 86400UL;
  else testDurationSec = valeurSaisie;

  currentCfg.frequency = targetFreq;
  currentCfg.duration = testDurationSec;
  currentCfg.activeA = server.hasArg("activeA") ? 1 : 0;
  currentCfg.activeB = server.hasArg("activeB") ? 1 : 0;

  if (targetFreq >= 2000) Wire.setClock(1000000);
  else Wire.setClock(400000); 

  if (currentCfg.activeA) configureINA226(ADDR_INA_A, targetFreq);
  if (currentCfg.activeB) configureINA226(ADDR_INA_B, targetFreq);

  acqCountA = 0; lostCountA = 0;
  acqCountB = 0; lostCountB = 0;

  SPI.beginTransaction(canSPISettings);
  byte canPacketTime[8] = {0};
  memcpy(&canPacketTime[0], (const void*)&pcBaseTimestamp, 4);
  CAN.sendMsgBuf(CAN_ID_TIME_SYNC, 0, 4, canPacketTime);
  SPI.endTransaction();

  uint64_t period_us = 1000000ULL / targetFreq;
  testStartMillis = millis();
  testRunning = true;
  esp_timer_start_periodic(acqTimer, period_us);

  server.send(200, "text/plain", "🚀 Test démarré.");
}

// Fonction de dessin sur l'écran (Exécutée sur le Cœur 0 uniquement)
void rafraichirEcranTFT() {
  SPI.beginTransaction(tftSPISettings);
  
  // Zone Canal A
  tft.fillRect(0, 32, 128, 20, ST7735_BLACK); // Efface la zone numérique uniquement pour éviter le clignotement
  tft.setCursor(5, 35);
  if (currentCfg.activeA) {
    tft.setTextColor(ST7735_RED);
    tft.printf("%.3f A", courantInstantaneA);
  } else {
    tft.setTextColor(ST7735_WHITE); // À la place de ST7735_GRAY
    tft.print("DESACTIVE");
  }

  // Zone Canal B
  tft.fillRect(0, 92, 128, 20, ST7735_BLACK);
  tft.setCursor(5, 95);
  if (currentCfg.activeB) {
    tft.setTextColor(ST7735_BLUE);
    tft.printf("%.3f A", courantInstantaneB);
  } else {
    tft.setTextColor(ST7735_WHITE); // À la place de ST7735_GRAY
    tft.print("DESACTIVE");
  }

  SPI.endTransaction();
}

void taskWeb(void* parameter) {
  // Initialisation de l'écran SPI (Démarrage unique sur Cœur 0)
  SPI.beginTransaction(tftSPISettings);
  tft.initR(INITR_144GREENTAB); // Initialisation pour écran ST7735 standard 128x128
  tft.setRotation(1);
  tft.fillScreen(ST7735_BLACK);
  tft.setTextSize(1);
  
  // Dessin des étiquettes fixes pour éviter de rafraîchir tout l'écran inutilement
  tft.setTextColor(ST7735_WHITE);
  tft.setCursor(5, 10);  tft.print("CANAL A (ENTREE):");
  tft.setCursor(5, 70);  tft.print("CANAL B (SORTIE):");
  SPI.endTransaction();

  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASS);
  server.on("/", HTTP_GET, handleRoot);
  server.on("/setDuration", HTTP_POST, handleSetDuration);
  server.on("/getStatus", HTTP_GET, handleGetStatus); 
  server.on("/stop", HTTP_GET, handleStop);           
  server.begin();
  
  uint32_t chronoEcran = 0;

  for (;;) { 
    server.handleClient(); 
    
    // Rafraîchissement asynchrone de l'écran toutes les 200ms (5 Hz)
    uint32_t maintenant = millis();
    if (maintenant - chronoEcran >= 200) {
      chronoEcran = maintenant;
      rafraichirEcranTFT();
    }

    vTaskDelay(pdMS_TO_TICKS(5)); // Laisser le processeur respirer
  }
}

// =========================================================================
// INSTANCIATION DES CŒURS (SETUP PRINCIPAL)
// =========================================================================
void setup() {
  Serial.begin(115200);
  
  esp_timer_create_args_t targs = {};
  targs.callback = &onAcqTimer;
  targs.dispatch_method = ESP_TIMER_TASK;
  targs.name = "timer_global";
  esp_timer_create(&targs, &acqTimer);

  // Allocation explicite des tâches FreeRTOS sur les cœurs de l'ESP32-S3
  xTaskCreatePinnedToCore(taskWeb, "taskWeb", 8192, nullptr, 1, nullptr, 0); // Core 0 (Wi-Fi + Écran)
  xTaskCreatePinnedToCore(taskAcq, "taskAcq", 8192, nullptr, 4, &taskAcqHandle, 1); // Core 1 (INA226 + CAN)
  
  Serial.println("[SYSTEME OK] Architecture Dual-Core ESP32-S3 chargee.");
}

void loop() { 
  vTaskDelay(pdMS_TO_TICKS(1000)); 
}