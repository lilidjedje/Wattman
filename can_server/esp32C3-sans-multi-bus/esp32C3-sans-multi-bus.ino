/******************************************************
 * INCLUDES & CONFIGURATION
 ******************************************************/
#include <Arduino.h>
#include <Wire.h>
#include "INA226.h"
#include <SPI.h>
#include <mcp_can.h>
#include <WiFi.h>
#include <WebServer.h>
#include "esp_timer.h"

// --- Broches ESP32-C3 (Sécurisées)
#define PIN_CS_CAN   7
#define PIN_INT_CAN  10
#define I2C_SDA      8
#define I2C_SCL      9
#define SPI_SCK      4
#define SPI_MISO     5  // Broche 5 stable (évite le conflit de boot de la broche 2)
#define SPI_MOSI     3

// --- IDs CAN conformes au DBC
#define CAN_ID_CURRENT_MEAS  0x100  // Signal : courant_A
#define CAN_ID_ACQ_STATS     0x101  // Signaux : freq_reel, lost_count

// --- Wi‑Fi AP
const char* AP_SSID = "courant_1";
const char* AP_PASS = "12345678";

MCP_CAN CAN(PIN_CS_CAN);
INA226 ina(0x40, &Wire);
WebServer server(80);

// --- Gestion du test
volatile uint32_t testDurationSec = 0;
volatile bool     testRunning     = false;
unsigned long     testStartMillis = 0;

// --- Horloge & Tâches
esp_timer_handle_t acqTimer = nullptr;
volatile uint32_t  acqFrequency = 1000;   // Hz
volatile uint64_t  acqPeriod_us = 1000;   // µs
TaskHandle_t       taskWebHandle = nullptr;
TaskHandle_t       taskCanHandle = nullptr;

// --- Statistiques d'acquisition
volatile uint32_t acqCount = 0;        
volatile uint32_t lostCount = 0;       
volatile uint32_t freqReelle = 0;      

// --- Prototypes
void handleRoot();
void handleSetDuration();
void handleProgress();
void handleNotFound();
void taskWeb(void* parameter);
void taskCan(void* parameter);
void IRAM_ATTR onAcqTimer(void* arg);
void updateAcquisitionFrequency(uint32_t freq);
void configureINA226ForFrequency(uint32_t f_hz);

/******************************************************
 * INTERFACES MATÉRIELLES (INA226)
 ******************************************************/
static const uint8_t INA226_ADDR = 0x40;
static const uint8_t REG_CONFIG  = 0x00;

bool inaWriteRegister16(uint8_t reg, uint16_t value) {
  Wire.beginTransmission(INA226_ADDR);
  Wire.write(reg);
  Wire.write((uint8_t)((value >> 8) & 0xFF));
  Wire.write((uint8_t)(value & 0xFF));
  return (Wire.endTransmission() == 0);
}

void configureINA226ForFrequency(uint32_t f_hz) {
  uint8_t avg = 0b000, vbus = 0b000, vsh = 0b000;
  uint8_t mode = (f_hz > 1500) ? 0b101 : 0b111;

  uint16_t config =
    ((uint16_t)avg  << 9) |
    ((uint16_t)vbus << 6) |
    ((uint16_t)vsh  << 3) |
    ((uint16_t)mode);

  if (!inaWriteRegister16(REG_CONFIG, config)) {
    Serial.println("[INA226] Échec configuration.");
  } else {
    Serial.printf("[INA226] Config OK: f=%u Hz, mode=%s, CT=140us\n",
                  f_hz, (mode == 0b101 ? "Shunt-only" : "Shunt+Bus"));
  }
}

inline int16_t readINA226ShuntRaw() {
  Wire.beginTransmission(INA226_ADDR);
  Wire.write(0x01); 
  if (Wire.endTransmission(false) != 0) return 0;
  if (Wire.requestFrom(INA226_ADDR, (uint8_t)2) == 2) {
    return (int16_t)((Wire.read() << 8) | Wire.read());
  }
  return 0;
}

/******************************************************
 * TIMER ET UTILS
 ******************************************************/
void IRAM_ATTR onAcqTimer(void* arg) {
  if (taskCanHandle) {
    xTaskNotifyGive(taskCanHandle);
  }
}

void updateAcquisitionFrequency(uint32_t freq) {
  if (freq < 1) return;
  acqFrequency = freq;
  acqPeriod_us = 1000000ULL / (uint64_t)freq;
  configureINA226ForFrequency(freq);
}

inline void startAcqTimer() {
  if (!acqTimer) return;
  esp_timer_stop(acqTimer);
  esp_err_t err = esp_timer_start_periodic(acqTimer, acqPeriod_us);
  if (err != ESP_OK) Serial.printf("[TIMER] Erreur start: %d\n", (int)err);
}

inline void stopAcqTimer() {
  if (!acqTimer) return;
  esp_timer_stop(acqTimer);
}

/******************************************************
 * PAGE WEB SERVEUR
 ******************************************************/
void handleRoot() {
  static const char HTML[] PROGMEM = R"HTML(
<!DOCTYPE html><html lang="fr"><head>
<meta charset="utf-8"><title>ESP32-C3 CAN Control</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:Segoe UI,Arial;margin:2rem;color:#222}
label{font-weight:600}
input, select{padding:0.4rem;font-size:1rem;margin-top:0.3rem}
button{padding:0.6rem 1rem;font-size:1rem;cursor:pointer;background:#1976d2;color:white;border:none;border-radius:4px;margin-top:1rem;}
#progressContainer{margin-top:1rem;width:100%;background:#ddd;border-radius:6px;height:20px;overflow:hidden;display:none}
#progressBar{height:100%;background:#4caf50;width:0%;transition:width 0.3s}
</style>
</head><body>
  <h1>Contrôle Acquisition CAN</h1>

  <form id="formDuration">
    <label>Durée du test (s)</label><br>
    <input type="number" name="duree" min="1" value="10" required><br><br>

    <label>Fréquence d'acquisition (Hz)</label><br>
    <select name="freq" required>
      <option>10</option><option>50</option><option>100</option><option>200</option>
      <option>500</option><option>800</option><option selected>1000</option>
      <option>1500</option><option>2000</option><option>2500</option><option>3000</option>
    </select><br><br>

    <button type="submit">Démarrer le test</button>
  </form>

  <div id="progressText" style="margin-top:1rem;font-size:1.1rem;"></div>
  <div id="progressContainer"><div id="progressBar"></div></div>

  <script>
    document.getElementById("formDuration").addEventListener("submit", function(e) {
      e.preventDefault();
      const formData = new FormData(this);
      fetch("/setDuration", { method: "POST", body: formData })
      .then(r => r.text())
      .then(txt => {
        alert(txt);
        document.getElementById("progressContainer").style.display = "block";
      })
      .catch(err => alert("Erreur: " + err));
    });

    function updateProgress(){
      fetch("/progress").then(r => r.json()).then(p => {
        const bar = document.getElementById("progressBar");
        const text = document.getElementById("progressText");

        if(!p.running){
          if (p.duration > 0 && p.elapsed >= p.duration) {
            bar.style.width = "100%";
            text.innerHTML = "Test terminé (" + p.duration + " s, Réel: " + p.freq + " Hz)";
          } else {
            bar.style.width = "0%";
            text.innerHTML = "Prêt. En attente de démarrage.";
          }
          return;
        }

        const percent = p.duration > 0 ? (p.elapsed / p.duration) * 100 : 0;
        bar.style.width = percent + "%";
        text.innerHTML = "Test en cours : " + p.elapsed + " / " + p.duration +
                         " s — Fréquence réelle : " + p.freq + " Hz | Pertes : " + p.lost;
      });
    }
    setInterval(updateProgress, 500);
  </script>
</body></html>
)HTML";

  server.send(200, "text/html; charset=utf-8", HTML);
}

void handleSetDuration() {
  if (!server.hasArg("duree")) {
    server.send(400, "text/plain", "Paramètre manquant: duree");
    return;
  }

  if (testRunning) {
    testRunning = false;
    stopAcqTimer();
    delay(10);
  }

  testDurationSec = server.arg("duree").toInt();
  if (testDurationSec == 0) {
    server.send(400, "text/plain", "Durée invalide");
    return;
  }

  if (server.hasArg("freq")) {
    uint32_t freq = server.arg("freq").toInt();
    updateAcquisitionFrequency(freq);
  }

  acqCount = 0;
  lostCount = 0;
  freqReelle = 0;

  testRunning = true;
  testStartMillis = millis();
  startAcqTimer();

  server.send(200, "text/plain", "Test lancé pour " + String(testDurationSec) + " s à " + String(acqFrequency) + " Hz");
}

void handleProgress() {
  unsigned long elapsed = testRunning ? (millis() - testStartMillis) / 1000 : 0;

  String json = "{";
  json += "\"running\":" + String(testRunning ? "true" : "false") + ",";
  json += "\"elapsed\":" + String(elapsed) + ",";
  json += "\"duration\":" + String(testDurationSec) + ",";
  json += "\"freq\":" + String(freqReelle) + ",";
  json += "\"lost\":" + String(lostCount);
  json += "}";
  server.send(200, "application/json", json);
}

void handleNotFound() {
  server.send(404, "text/plain", "Not found");
}

void taskWeb(void* parameter) {
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASS);

  Serial.print("[WEB] AP IP : ");
  Serial.println(WiFi.softAPIP());

  server.on("/",           HTTP_GET,  handleRoot);
  server.on("/setDuration", HTTP_POST, handleSetDuration);
  server.on("/progress",    HTTP_GET,  handleProgress);
  server.onNotFound(handleNotFound);
  server.begin();

  for (;;) {
    server.handleClient();
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

/******************************************************
 * TÂCHE ACQUISITION ET TRANSMISSION CAN
 ******************************************************/
void taskCan(void* parameter) {
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(400000);

  if (!ina.begin()) Serial.println("[CAN] INA226 non détecté !");
  else               Serial.println("[CAN] INA226 détecté");

  configureINA226ForFrequency(acqFrequency);

  SPI.begin(SPI_SCK, SPI_MISO, SPI_MOSI, PIN_CS_CAN);
  SPI.setFrequency(4000000); // Protection horloge pour Quartz 8MHz

  if (CAN.begin(MCP_ANY, CAN_500KBPS, MCP_8MHZ) == CAN_OK)
    Serial.println("[CAN] MCP2515 OK");
  else
    Serial.println("[CAN] ERREUR INITIALISATION MCP2515");

  CAN.setMode(MCP_NORMAL);

  uint32_t lastPrintMs = 0;
  uint32_t lastAcqSnapshot = 0;

  for (;;) {
    if (!testRunning) {
      stopAcqTimer();
      vTaskDelay(pdMS_TO_TICKS(5));
      continue;
    }

    // --- Attente du top du timer matériel
    uint32_t nNotify = ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));
    if (!testRunning) continue;

    if (nNotify == 0) {
      lostCount++;
      continue;
    }

    acqCount++;
    if (nNotify > 1) {
      lostCount += (nNotify - 1); // Cumul des interruptions manquées
    }

    // --- Calcul stable de la fréquence réelle (Toutes les 1000 ms)
    uint32_t nowMs = millis();
    if (nowMs - lastPrintMs >= 1000) {
      freqReelle = acqCount - lastAcqSnapshot;
      lastAcqSnapshot = acqCount;
      lastPrintMs = nowMs;

      // Envoi de la trame de STATISTIQUES (0x101)
      uint16_t freq16 = (uint16_t)freqReelle;
      uint16_t lost16 = (uint16_t)lostCount;
      byte stats_data[8] = {0};
      
      memcpy(&stats_data[0], &freq16, 2); // Octet 0-1 : Fréquence Réelle (Hz)
      memcpy(&stats_data[2], &lost16, 2); // Octet 2-3 : Nombre de mesures ratées
      
      CAN.sendMsgBuf(CAN_ID_ACQ_STATS, 0, 8, stats_data);

      Serial.printf("[ACQ] freq_reelle=%lu Hz | lost=%lu | total=%lu\n", freqReelle, lostCount, acqCount);
    }

    // --- Mesure du courant (INA226)
    int16_t raw = readINA226ShuntRaw();
    float I = raw * 2.5e-6f / 0.1f; // Résolution Shunt 2.5 µV / R_shunt 0.1 Ohm

    // --- Envoi de la trame de MESURE DU COURANT (0x100) à chaque cycle
    byte current_data[8] = {0};
    memcpy(&current_data[0], &I, 4); // Octet 0-3 : Valeur courant float (4 octets)
    
    CAN.sendMsgBuf(CAN_ID_CURRENT_MEAS, 0, 8, current_data);

    // --- Condition d'arrêt automatique du test
    if (millis() - testStartMillis >= testDurationSec * 1000UL) {
      testRunning = false;
      stopAcqTimer();
      Serial.println("[CAN] Fin de la durée du test demandée");
    }
  }
}

/******************************************************
 * SETUP / LOOP MAIN
 ******************************************************/
void setup() {
  Serial.begin(115200);
  delay(500);

  esp_timer_create_args_t targs = {};
  targs.callback = &onAcqTimer;
  targs.arg = nullptr;
  targs.dispatch_method = ESP_TIMER_TASK;
  targs.name = "acq";
  
  if (esp_timer_create(&targs, &acqTimer) != ESP_OK) {
    Serial.println("[TIMER] Échec de création");
  }

  updateAcquisitionFrequency(1000);

  // Exécution conjointe sur le processeur (Le CAN possède une priorité stricte 2 > 1)
  xTaskCreatePinnedToCore(taskWeb, "taskWeb", 4096, nullptr, 1, &taskWebHandle, 0);
  xTaskCreatePinnedToCore(taskCan, "taskCan", 4096, nullptr, 2, &taskCanHandle, 0);
}

void loop() {
  vTaskDelay(pdMS_TO_TICKS(1000));
}