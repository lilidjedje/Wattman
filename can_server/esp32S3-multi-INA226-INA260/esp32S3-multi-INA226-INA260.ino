#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WebServer.h>
#include <SPI.h>
#include <mcp_can.h>
#include "esp_timer.h"

// =========================================================================
// CONFIGURATION DES BROCHES MATÉRIELLES (ESP32-S3 NON-CONFLIT)
// =========================================================================
#define I2C_SDA       3
#define I2C_SCL       2

#define PIN_CS_CAN    4
#define PIN_INT_CAN   8

#define SPI_SCK       6
#define SPI_MISO      7
#define SPI_MOSI      5

// Adresses I2C
const uint8_t ADDR_INA260 = 0x40; // Capteur A (INA260)
const uint8_t ADDR_INA226 = 0x41; // Capteur B (INA226)

// Registres spécifiques au INA260
const uint8_t REG_260_CONFIG  = 0x00;
const uint8_t REG_260_CURRENT = 0x01;

// Registres spécifiques au INA226
const uint8_t REG_226_CONFIG  = 0x00;
const uint8_t REG_226_SHUNT   = 0x01;

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

esp_timer_handle_t acqTimer = nullptr;
TaskHandle_t taskAcqHandle = nullptr;

// Signaux d'état de session partagés (FreeRTOS Atomics)
volatile uint32_t testDurationSec = 0;
volatile bool     testRunning     = false;
unsigned long     testStartMillis = 0;
volatile uint32_t pcBaseTimestamp = 0; 

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

// =========================================================================
// PILOTAGE DES COMPOSANTS MATÉRIELS I2C (INA226 & INA260)
// =========================================================================
bool i2cWriteRegister16(uint8_t addr, uint8_t reg, uint16_t value) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write((uint8_t)((value >> 8) & 0xFF));
  Wire.write((uint8_t)(value & 0xFF));
  return (Wire.endTransmission() == 0);
}

inline int16_t i2cReadRegister16(uint8_t addr, uint8_t reg) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return 0;
  if (Wire.requestFrom(addr, (uint8_t)2) == 2) {
    return (int16_t)((Wire.read() << 8) | Wire.read());
  }
  return 0;
}

void configureSensors(uint32_t freq) {
  uint16_t config_bits_226;
  uint16_t config_bits_260;
  
  if (freq >= 900) {
    // VITESSE MAXIMALE ABSOLUE (Conversion ~140µs par registre, Moyenne = 1)
    // INA226 : VBUS = 140µs, VSHUNT = 140µs -> Total ~280µs
    config_bits_226 = (0b000 << 9) | (0b000 << 6) | (0b000 << 3) | 0b111;
    // INA260 : VBUS = 140µs, CURRENT = 140µs -> Total ~280µs
    config_bits_260 = (0b000 << 9) | (0b000 << 6) | (0b000 << 3) | 0b111;
  } 
  else {
    // MODE STANDARD (Conversion = 1.1ms, Moyenne = 1)
    config_bits_226 = (0b000 << 9) | (0b100 << 6) | (0b100 << 3) | 0b111;
    config_bits_260 = (0b000 << 9) | (0b100 << 6) | (0b100 << 3) | 0b111;
  }
  
  if (currentCfg.activeA) i2cWriteRegister16(ADDR_INA260, REG_260_CONFIG, config_bits_260);
  if (currentCfg.activeB) i2cWriteRegister16(ADDR_INA226, REG_226_CONFIG, config_bits_226);
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

  SPI.begin(SPI_SCK, SPI_MISO, SPI_MOSI, PIN_CS_CAN);
  SPI.setFrequency(4000000);
  CAN.begin(MCP_ANY, CAN_500KBPS, MCP_8MHZ);
  CAN.setMode(MCP_NORMAL);

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

    // --- Traitement du Capteur A : INA260 (Adresse 0x40) ---
    if (currentCfg.activeA) {
      acqCountA++;
      int16_t rawCurrent260 = i2cReadRegister16(ADDR_INA260, REG_260_CURRENT);
      // Échelle fixe du INA260 : 1 LSB = 1.25 mA = 0.00125 A
      float IA = rawCurrent260 * 0.00125f; 
      
      memset(canPacket, 0, 8);
      memcpy(&canPacket[0], &IA, sizeof(float));
      CAN.sendMsgBuf(CAN_ID_CURRENT_A, 0, 8, canPacket);
    }

    // --- Traitement du Capteur B : INA226 (Adresse 0x41) ---
    if (currentCfg.activeB) {
      acqCountB++;
      int16_t rawShunt226 = i2cReadRegister16(ADDR_INA226, REG_226_SHUNT);
      // Échelle du INA226 : 1 LSB = 2.5 µV. Avec shunt externe de 0.1 Ohm :
      float IB = rawShunt226 * 2.5e-6f / 0.1f;
      
      memset(canPacket, 0, 8);
      memcpy(&canPacket[0], &IB, sizeof(float));
      CAN.sendMsgBuf(CAN_ID_CURRENT_B, 0, 8, canPacket);
    }

    // Consolidation périodique des paquets statistiques (toutes les 1s)
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

    if (nowMs - testStartMillis >= testDurationSec * 1000UL) {
      testRunning = false;
      esp_timer_stop(acqTimer);
      Serial.println("[SYSTEM] Fin de l'acquisition.");
    }
  }
}

// =========================================================================
// SERVICES DU SERVEUR WEB INTERNE ET DES FLUX RADIO WI-FI
// =========================================================================
void handleRoot() {
  static const char HTML[] PROGMEM = R"HTML(
<!DOCTYPE html><html lang="fr"><head>
<meta charset="utf-8"><title>Contrôle INA260 + INA226</title>
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
  <h1>Générateur CAN (INA260 [A] & INA226 [B])</h1>
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
      <label><input type="checkbox" name="activeA" value="1" checked style="width:auto"> Capteur A (INA260 - 0x40)</label><br>
      <label><input type="checkbox" name="activeB" value="1" checked style="width:auto"> Capteur B (INA226 - 0x41)</label>
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
      if(confirm("Voulez-vous vraiment couper l'acquisition ?")) {
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

  configureSensors(targetFreq);

  acqCountA = 0; lostCountA = 0;
  acqCountB = 0; lostCountB = 0;

  byte canPacketTime[8] = {0};
  memcpy(&canPacketTime[0], (const void*)&pcBaseTimestamp, 4);
  CAN.sendMsgBuf(CAN_ID_TIME_SYNC, 0, 4, canPacketTime);

  uint64_t period_us = 1000000ULL / targetFreq;
  testStartMillis = millis();
  testRunning = true;
  esp_timer_start_periodic(acqTimer, period_us);

  server.send(200, "text/plain", "🚀 Test démarré.");
}

void taskWeb(void* parameter) {
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASS);
  server.on("/", HTTP_GET, handleRoot);
  server.on("/setDuration", HTTP_POST, handleSetDuration);
  server.on("/getStatus", HTTP_GET, handleGetStatus); 
  server.on("/stop", HTTP_GET, handleStop);           
  server.begin();
  
  for (;;) { 
    server.handleClient(); 
    vTaskDelay(pdMS_TO_TICKS(10)); 
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

  xTaskCreatePinnedToCore(taskWeb, "taskWeb", 8192, nullptr, 1, nullptr, 0);
  xTaskCreatePinnedToCore(taskAcq, "taskAcq", 8192, nullptr, 4, &taskAcqHandle, 1);
  
  Serial.println("[SYSTEME OK] Architecture Mixte INA260 + INA226 Prête.");
}

void loop() { 
  vTaskDelay(pdMS_TO_TICKS(1000)); 
}