#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WebServer.h>
#include "esp_timer.h"

// =========================================================================
// CONFIGURATION DES BROCHES MATÉRIELLES SÉCURISÉES (ESP32-S3 N16R8)
// =========================================================================
#define I2C_SDA       1  // Nouvelle broche native SDA
#define I2C_SCL       2  // Nouvelle broche native SCL

// Adresses I2C et registres du capteur INA226
const uint8_t ADDR_INA_A = 0x40; 
const uint8_t ADDR_INA_B = 0x41; 
const uint8_t REG_CONFIG = 0x00;
const uint8_t REG_SHUNT  = 0x01;

const char* AP_SSID = "courant_1";
const char* AP_PASS = "12345678";

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
    // 🔥 VITESSE MAXIMALE ABSOLUE (Conversion Shunt = 140µs, Bus = 140µs, Moyenne = 1)
    // Temps total par mesure : ~280 microsecondes. Parfait pour du 2000 Hz !
    config_bits = (0b000 << 9)   | // AVG : 1 échantillon (Pas de moyenne)
                  (0b000 << 6)   | // VBUS Conversion Time : 140 µs
                  (0b000 << 3)   | // VSHUNT Conversion Time : 140 µs
                  0b111;           // Mode : Shunt and Bus, Continuous
  } 
  else {
    // 📈 MODE STANDARD (Pour 100 Hz / 500 Hz : Conversion = 1.1ms, Moyenne = 1)
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
// CŒUR 1 : TASK D'ACQUISITION ET MONITEUR SÉRIE NUMÉRIQUE
// =========================================================================
void taskAcq(void* parameter) {
  // Initialisation isolée du contrôleur I2C matériel sur le Core 1
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(400000);
  Wire.setTimeOut(25);
  Serial.println("[I2C] Initialisé avec succès sur le Core 1 (GPIO 1 & 2).");

  uint32_t lastPrintMs = 0;
  uint32_t lastSnapshotA = 0, lastSnapshotB = 0;
  
  // Variables pour stocker les valeurs lues
  float IA = 0.0;
  float IB = 0.0;

  for (;;) {
    if (!testRunning) {
      vTaskDelay(pdMS_TO_TICKS(10));
      continue;
    }

    // Attente du signal d'interruption matérielle émis par le Timer
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

    // Traitement numérique du capteur A
    if (currentCfg.activeA) {
      acqCountA++;
      int16_t rawA = readINA226ShuntRaw(ADDR_INA_A);
      IA = rawA * 2.5e-6f / 0.1f; // Calcul d'intensité en Ampères
    }

    // Traitement numérique du capteur B
    if (currentCfg.activeB) {
      acqCountB++;
      int16_t rawB = readINA226ShuntRaw(ADDR_INA_B);
      IB = rawB * 2.5e-6f / 0.1f; // Calcul d'intensité en Ampères
    }

    // 🖥️ AFFICHAGE NUMÉRIQUE TOUTES LES 250MS POUR NE PAS SATURER L'USB SÉRIE
    uint32_t nowMs = millis();
    if (nowMs - lastPrintMs >= 250) {
      freqReelleA = acqCountA - lastSnapshotA;
      freqReelleB = acqCountB - lastSnapshotB;
      lastSnapshotA = acqCountA;
      lastSnapshotB = acqCountB;
      lastPrintMs = nowMs;

      Serial.printf("[MESURE LIVE] T: %lu ms | Capteur A: %.4f A (Freq: %lu Hz, Perdu: %lu) | Capteur B: %.4f A (Freq: %lu Hz, Perdu: %lu)\n", 
                    (nowMs - testStartMillis), 
                    currentCfg.activeA ? IA : 0.0f, freqReelleA * 4, lostCountA,
                    currentCfg.activeB ? IB : 0.0f, freqReelleB * 4, lostCountB);
    }

    // Contrôle d'arrêt automatique de la session
    if (nowMs - testStartMillis >= testDurationSec * 1000UL) {
      testRunning = false;
      esp_timer_stop(acqTimer);
      Serial.println("\n==================================================");
      Serial.printf("🛑 FIN DE L'ACQUISITION | Total points A: %lu | Total points B: %lu\n", acqCountA, acqCountB);
      Serial.println("==================================================");
    }
  }
}

// =========================================================================
// CŒUR 0 : SERVICES DU SERVEUR WEB INTERNE ET INTERFACE GRAPHIQUE
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
  <h1>Générateur Numérique (S3 Dual-Core Sans CAN)</h1>
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

  uint64_t period_us = 1000000ULL / targetFreq;
  testStartMillis = millis();
  testRunning = true;
  esp_timer_start_periodic(acqTimer, period_us);

  Serial.println("\n==================================================");
  Serial.printf("🚀 TEST LANCÉ DEPUIS L'INTERFACE WEB | Freq Target: %lu Hz | Durée: %lu s\n", targetFreq, testDurationSec);
  Serial.println("==================================================");

  server.send(200, "text/plain", "Test démarré.");
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
  delay(1000); 

  Serial.println("\n[SYSTEM] Démarrage du banc de test sans CAN...");

  esp_timer_create_args_t targs = {};
  targs.callback = &onAcqTimer;
  targs.dispatch_method = ESP_TIMER_TASK;
  targs.name = "timer_global";
  esp_timer_create(&targs, &acqTimer);

  // Configuration de la répartition matérielle double cœur
  xTaskCreatePinnedToCore(taskWeb, "taskWeb", 8192, nullptr, 1, nullptr, 0); // Core 0 : Wi-Fi & Web
  xTaskCreatePinnedToCore(taskAcq, "taskAcq", 8192, nullptr, 4, &taskAcqHandle, 1); // Core 1 : Acquisition I2C pure
  
  Serial.println("[SYSTEME OK] Architecture Dual-Core ESP32-S3 chargée.");
}

void loop() { 
  vTaskDelay(pdMS_TO_TICKS(1000)); 
}