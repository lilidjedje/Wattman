#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <WebServer.h>
#include <SPI.h>
#include <mcp_can.h>
#include "esp_timer.h"

// --- Configuration des Broches Matérielles ---
#define I2C_SDA       8
#define I2C_SCL       9
#define PIN_CS_CAN    7
#define PIN_INT_CAN  10
#define SPI_SCK       4
#define SPI_MISO      5  
#define SPI_MOSI      3

const uint8_t ADDR_INA_A = 0x40; 
const uint8_t ADDR_INA_B = 0x41; 
const uint8_t REG_CONFIG = 0x00;
const uint8_t REG_SHUNT  = 0x01;

#define CAN_ID_CURRENT_A     0x100  
#define CAN_ID_STATS_A       0x101  
#define CAN_ID_CURRENT_B     0x102  
#define CAN_ID_STATS_B       0x103  
#define CAN_ID_TIME_SYNC     0x105  

// L'ESP32-C3 rejoint le point d'accès créé par le Raspberry Pi.
// Le navigateur parle au Pi ; seul le Pi communique directement avec cette API.
#ifndef STA_WIFI_SSID
#define STA_WIFI_SSID ""
#endif
#ifndef STA_WIFI_PASS
#define STA_WIFI_PASS ""
#endif
const char* WIFI_SSID = STA_WIFI_SSID;
const char* WIFI_PASS = STA_WIFI_PASS;
const char* ACCESS_POINT_SSID = "ESP32C3-Mesure";
const char* ACCESS_POINT_PASS = "ina226mesure";
const char* DEVICE_HOSTNAME = "esp32c3-mesure";

MCP_CAN CAN(PIN_CS_CAN);
WebServer server(80);
WiFiServer streamServer(3333);
WiFiClient streamClient;
esp_timer_handle_t acqTimer = nullptr;
TaskHandle_t taskAcqHandle = nullptr;
QueueHandle_t streamQueue = nullptr;
SemaphoreHandle_t streamClientMutex = nullptr;
SemaphoreHandle_t canMutex = nullptr;

volatile uint32_t testDurationSec = 0;
volatile uint32_t testDurationSecA = 0, testDurationSecB = 0;
volatile uint32_t targetFrequencyA = 0, targetFrequencyB = 0;
volatile uint32_t timerFrequency = 1000;
volatile uint32_t schedulerAccumulatorA = 0, schedulerAccumulatorB = 0;
volatile bool     testRunning     = false;
unsigned long     testStartMillis = 0;
volatile uint64_t testStartMicros = 0;
volatile uint32_t lastElapsedSec = 0;
volatile bool sensorRunningA = false;
volatile bool sensorRunningB = false;
volatile bool sensorFinishedA = false;
volatile bool sensorFinishedB = false;
volatile bool canReady = false;
volatile uint32_t canTxOk = 0;
volatile uint32_t canTxErrors = 0;
volatile uint8_t canLastTxResult = CAN_OK;
volatile uint8_t canErrorFlags = 0;
volatile uint8_t canTxErrorCount = 0;
volatile uint8_t canOscillatorMHz = 8;
volatile bool digitalStreamMode = false;

// Variable pour stocker le temps d'origine fourni par le PC
volatile uint32_t pcBaseTimestamp = 0; 

volatile uint32_t acqCountA = 0,    acqCountB = 0;
volatile uint32_t lostCountA = 0,   lostCountB = 0;
volatile uint32_t freqReelleA = 0,  freqReelleB = 0;

struct ConfigPayload {
  uint32_t frequency;
  uint32_t duration; 
  uint32_t frequencyA;
  uint32_t frequencyB;
  uint32_t durationA;
  uint32_t durationB;
  uint32_t activeA;
  uint32_t activeB;
};
volatile ConfigPayload currentCfg = {1000, 10, 1000, 1000, 10, 10, 1, 1};

struct __attribute__((packed)) StreamFrame {
  uint16_t magic;
  uint8_t version;
  uint8_t length;
  uint16_t identifier;
  uint64_t timestampUs;
  uint8_t payload[8];
};

volatile bool streamConnected = false;

bool sendCanFrame(uint16_t identifier, uint8_t length, byte* payload) {
  bool delivered = false;
  if (!digitalStreamMode) {
    xSemaphoreTake(canMutex, portMAX_DELAY);
    canLastTxResult = canReady ? CAN.sendMsgBuf(identifier, 0, length, payload) : CAN_FAILINIT;
    const bool canDelivered = canLastTxResult == CAN_OK;
    if (canReady) {
      canErrorFlags = CAN.getError();
      canTxErrorCount = CAN.errorCountTX();
    }
    xSemaphoreGive(canMutex);
    if (canDelivered) {
      canTxOk++;
      delivered = true;
    } else {
      canTxErrors++;
    }
  }
  if (digitalStreamMode && streamConnected && streamQueue && length <= 8) {
    StreamFrame frame = {};
    frame.magic = 0xA55A;
    frame.version = 1;
    frame.length = length;
    frame.identifier = identifier;
    const uint64_t elapsedUs = testStartMicros ? esp_timer_get_time() - testStartMicros : 0;
    frame.timestampUs = ((uint64_t)pcBaseTimestamp * 1000000ULL) + elapsedUs;
    memcpy(frame.payload, payload, length);
    if (xQueueSend(streamQueue, &frame, 0) == pdTRUE) delivered = true;
  }
  return delivered;
}

bool initializeCan(uint8_t oscillatorMHz = 8) {
  xSemaphoreTake(canMutex, portMAX_DELAY);
  const byte clock = oscillatorMHz == 16 ? MCP_16MHZ : MCP_8MHZ;
  canReady = CAN.begin(MCP_ANY, CAN_500KBPS, clock) == CAN_OK;
  if (canReady) {
    // begin() leaves this library in loopback: a successful begin alone does
    // not mean that any frame can leave the controller.
    canReady = CAN.setMode(MCP_NORMAL) == CAN_OK;
  }
  if (canReady) {
    canOscillatorMHz = oscillatorMHz;
    canErrorFlags = CAN.getError();
    canTxErrorCount = CAN.errorCountTX();
    Serial.printf("[CAN] MCP2515 pret : 500 kbit/s, quartz %u MHz.\n", canOscillatorMHz);
  } else {
    Serial.printf(
      "[CAN] MCP2515 indisponible avec quartz %u MHz. Verifiez SPI et alimentation.\n",
      oscillatorMHz
    );
  }
  xSemaphoreGive(canMutex);
  return canReady;
}

void taskStream(void* parameter) {
  StreamFrame frame;
  for (;;) {
    if (xQueueReceive(streamQueue, &frame, pdMS_TO_TICKS(250)) != pdTRUE) continue;
    if (!streamClientMutex) continue;
    xSemaphoreTake(streamClientMutex, portMAX_DELAY);
    if (streamConnected && streamClient.connected()) {
      const size_t written = streamClient.write((const uint8_t*)&frame, sizeof(frame));
      if (written != sizeof(frame)) {
        streamClient.stop();
        streamConnected = false;
      }
    } else {
      streamConnected = false;
    }
    xSemaphoreGive(streamClientMutex);
  }
}

void stopAcquisition(bool completed) {
  lastElapsedSec = completed ? testDurationSec : (millis() - testStartMillis) / 1000UL;
  testRunning = false;
  sensorFinishedA = sensorFinishedA || (completed && currentCfg.activeA);
  sensorFinishedB = sensorFinishedB || (completed && currentCfg.activeB);
  sensorRunningA = false;
  sensorRunningB = false;
  esp_timer_stop(acqTimer);
}

void stopSensor(char sensor) {
  if (sensor == 'A') {
    sensorRunningA = false;
    sensorFinishedA = true;
  }
  if (sensor == 'B') {
    sensorRunningB = false;
    sensorFinishedB = true;
  }
  if (!sensorRunningA && !sensorRunningB) stopAcquisition(false);
}

bool inaWriteRegister16(uint8_t addr, uint8_t reg, uint16_t value) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write((uint8_t)((value >> 8) & 0xFF));
  Wire.write((uint8_t)(value & 0xFF));
  return (Wire.endTransmission() == 0);
}

void configureINA226(uint8_t addr, uint32_t freq) {
  uint16_t config_bits;
  if (freq >= 2000) {
    config_bits = (0b000 << 9) | (0b001 << 6) | (0b001 << 3) | 0b101;
  } else {
    config_bits = (0b000 << 9) | (0b100 << 6) | (0b100 << 3) | 0b111;
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
    xTaskNotifyGive(taskAcqHandle);
  }
}

void taskAcq(void* parameter) {
  uint32_t lastPrintMs = 0;
  uint32_t lastSnapshotA = 0, lastSnapshotB = 0;
  byte canPacket[8] = {0};

  for (;;) {
    if (!testRunning) {
      lastSnapshotA = acqCountA;
      lastSnapshotB = acqCountB;
      lastPrintMs = millis();
      vTaskDelay(pdMS_TO_TICKS(10));
      continue;
    }

    const uint32_t elapsedMs = millis() - testStartMillis;
    if (sensorRunningA && elapsedMs >= testDurationSecA * 1000UL) {
      sensorRunningA = false;
      sensorFinishedA = true;
    }
    if (sensorRunningB && elapsedMs >= testDurationSecB * 1000UL) {
      sensorRunningB = false;
      sensorFinishedB = true;
    }
    if (!sensorRunningA && !sensorRunningB) {
      stopAcquisition(true);
      Serial.println("[SYSTEM] Fin des acquisitions A et B.");
      continue;
    }

    uint32_t nNotify = ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));
    if (nNotify == 0) {
      if (sensorRunningA) lostCountA++;
      if (sensorRunningB) lostCountB++;
      continue;
    }

    schedulerAccumulatorA += targetFrequencyA * nNotify;
    schedulerAccumulatorB += targetFrequencyB * nNotify;
    const uint32_t dueA = schedulerAccumulatorA / timerFrequency;
    const uint32_t dueB = schedulerAccumulatorB / timerFrequency;
    schedulerAccumulatorA %= timerFrequency;
    schedulerAccumulatorB %= timerFrequency;
    const bool acquireA = sensorRunningA && dueA > 0;
    const bool acquireB = sensorRunningB && dueB > 0;
    if (acquireA && dueA > 1) lostCountA += dueA - 1;
    if (acquireB && dueB > 1) lostCountB += dueB - 1;

    if (acquireA) {
      acqCountA++;
      int16_t rawA = readINA226ShuntRaw(ADDR_INA_A);
      float IA = rawA * 2.5e-6f / 0.1f;
      memset(canPacket, 0, 8);
      memcpy(&canPacket[0], &IA, sizeof(float));
      if (!sendCanFrame(CAN_ID_CURRENT_A, 4, canPacket)) lostCountA++;
    }

    if (acquireB) {
      acqCountB++;
      int16_t rawB = readINA226ShuntRaw(ADDR_INA_B);
      float IB = rawB * 2.5e-6f / 0.1f;
      memset(canPacket, 0, 8);
      memcpy(&canPacket[0], &IB, sizeof(float));
      if (!sendCanFrame(CAN_ID_CURRENT_B, 4, canPacket)) lostCountB++;
    }

    uint32_t nowMs = millis();
    if (nowMs - lastPrintMs >= 1000) {
      // Recover a bus-off controller using the selected physical crystal.
      // Missing an ACK never justifies changing the CAN bit timing.
      if (!digitalStreamMode && (canErrorFlags & 0x20)) initializeCan(canOscillatorMHz);
      if (sensorRunningA) freqReelleA = acqCountA - lastSnapshotA;
      if (sensorRunningB) freqReelleB = acqCountB - lastSnapshotB;
      lastSnapshotA = acqCountA;
      lastSnapshotB = acqCountB;
      lastPrintMs = nowMs;

      if (sensorRunningA) {
        uint16_t statsA[2] = {(uint16_t)freqReelleA, (uint16_t)lostCountA};
        memset(canPacket, 0, 8);
        memcpy(&canPacket[0], &statsA[0], 2);
        memcpy(&canPacket[2], &statsA[1], 2);
        if (!sendCanFrame(CAN_ID_STATS_A, 4, canPacket)) lostCountA++;
      }

      if (sensorRunningB) {
        uint16_t statsB[2] = {(uint16_t)freqReelleB, (uint16_t)lostCountB};
        memset(canPacket, 0, 8);
        memcpy(&canPacket[0], &statsB[0], 2);
        memcpy(&canPacket[2], &statsB[1], 2);
        if (!sendCanFrame(CAN_ID_STATS_B, 4, canPacket)) lostCountB++;
      }

      // Envoi du timestamp calculé à partir de la valeur initiale reçue du PC
      uint32_t calcul_ts = pcBaseTimestamp + ((nowMs - testStartMillis) / 1000UL);
      memset(canPacket, 0, 8);
      memcpy(&canPacket[0], &calcul_ts, 4);
      sendCanFrame(CAN_ID_TIME_SYNC, 4, canPacket);
    }
  }
}

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
  <h1>Générateur de Trames CAN Autonome</h1>
  <div class="card">
    <h2>État de l'acquisition</h2>
    <div id="statusText" style="font-weight:bold; color:#64748b;">Statut : Prêt / En attente</div>
    <div class="progress-container" id="progressContainer">
      <div class="progress-bar-bg"><div class="progress-bar-fill" id="progressBarFill"></div></div>
      <div class="progress-text" id="progressText">0% (0s / 0s)</div>
    </div>
    <button onclick="stopperAcquisition()" class="btn-stop" id="btnStop">Arrêter le Test</button>
  </div>
  <form id="formConfig">
    <input type="hidden" id="clientTime" name="clientTime">
    
    <div class="card">
      <h2>Configuration Globale</h2>
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
    <div style="max-width:500px"><button type="submit">Lancer l'acquisition</button></div>
  </form>
  <script>
    let intervalStatus = null;
    document.getElementById("formConfig").addEventListener("submit", function(e) {
      e.preventDefault();
      // Injecte dynamiquement les secondes exactes de la machine locale
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
    server.send(423, "text/plain", "Acquisition déjà en cours.");
    return;
  }
  
  // Récupération de l'heure envoyée par le client web
  if (server.hasArg("clientTime")) {
    pcBaseTimestamp = server.arg("clientTime").toInt();
  } else {
    pcBaseTimestamp = 1781582267; // Fallback par défaut juin 2026
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
  currentCfg.frequencyA = currentCfg.activeA ? targetFreq : 0;
  currentCfg.frequencyB = currentCfg.activeB ? targetFreq : 0;
  currentCfg.durationA = currentCfg.activeA ? testDurationSec : 0;
  currentCfg.durationB = currentCfg.activeB ? testDurationSec : 0;
  targetFrequencyA = currentCfg.frequencyA;
  targetFrequencyB = currentCfg.frequencyB;
  testDurationSecA = currentCfg.durationA;
  testDurationSecB = currentCfg.durationB;
  timerFrequency = targetFreq;
  schedulerAccumulatorA = 0;
  schedulerAccumulatorB = 0;
  sensorRunningA = currentCfg.activeA;
  sensorRunningB = currentCfg.activeB;
  sensorFinishedA = false;
  sensorFinishedB = false;

  if (targetFreq >= 2000) Wire.setClock(1000000);
  else Wire.setClock(400000); 

  if (currentCfg.activeA) configureINA226(ADDR_INA_A, targetFreq);
  if (currentCfg.activeB) configureINA226(ADDR_INA_B, targetFreq);

  acqCountA = 0; lostCountA = 0;
  acqCountB = 0; lostCountB = 0;

  // Envoi forcé immédiat du paquet temporel de milliseconde 0 avant les signaux INA
  byte canPacketTime[8] = {0};
  memcpy(&canPacketTime[0], (const void*)&pcBaseTimestamp, 4);
  sendCanFrame(CAN_ID_TIME_SYNC, 4, canPacketTime);

  uint64_t period_us = 1000000ULL / targetFreq;
  testStartMillis = millis();
  testRunning = true;
  esp_timer_start_periodic(acqTimer, period_us);

  server.send(200, "text/plain", "Test démarré.");
}

String jsonBool(bool value) {
  return value ? "true" : "false";
}

void sendAcquisitionStatus(int statusCode = 200) {
  uint32_t elapsed = testRunning ? (millis() - testStartMillis) / 1000UL : lastElapsedSec;
  String json = "{\"running\":" + jsonBool(testRunning);
  json += ",\"duration\":" + String(testDurationSec);
  json += ",\"elapsed\":" + String(elapsed);
  json += ",\"frequency\":" + String(currentCfg.frequency);
  json += ",\"acquisition_mode\":\"";
  json += digitalStreamMode ? "digital" : "can";
  json += "\"";
  json += ",\"can\":{\"ready\":" + jsonBool(canReady);
  json += ",\"bitrate\":500000,\"oscillator_mhz\":" + String(canOscillatorMHz);
  json += ",\"tx_ok\":" + String(canTxOk);
  json += ",\"tx_errors\":" + String(canTxErrors);
  json += ",\"last_tx_result\":" + String(canLastTxResult);
  json += ",\"error_flags\":" + String(canErrorFlags);
  json += ",\"tx_error_count\":" + String(canTxErrorCount);
  json += ",\"tcp_connected\":" + jsonBool(streamConnected);
  json += "}";
  json += ",\"sensors\":{\"A\":{\"running\":" + jsonBool(sensorRunningA);
  json += ",\"finished\":" + jsonBool(sensorFinishedA);
  json += ",\"duration\":" + String(testDurationSecA);
  json += ",\"elapsed\":" + String(min(elapsed, uint32_t(testDurationSecA)));
  json += ",\"requested_frequency\":" + String(targetFrequencyA);
  json += ",\"samples\":" + String(acqCountA);
  json += ",\"lost\":" + String(lostCountA);
  json += ",\"frequency\":" + String(freqReelleA);
  json += "},\"B\":{\"running\":" + jsonBool(sensorRunningB);
  json += ",\"finished\":" + jsonBool(sensorFinishedB);
  json += ",\"duration\":" + String(testDurationSecB);
  json += ",\"elapsed\":" + String(min(elapsed, uint32_t(testDurationSecB)));
  json += ",\"requested_frequency\":" + String(targetFrequencyB);
  json += ",\"samples\":" + String(acqCountB);
  json += ",\"lost\":" + String(lostCountB);
  json += ",\"frequency\":" + String(freqReelleB);
  json += "}}}";
  server.send(statusCode, "application/json", json);
}

void sendAcquisitionError(int statusCode, const char* message) {
  server.send(statusCode, "application/json", String("{\"message\":\"") + message + "\"}");
}

void handleApiStartAcquisition() {
  if (testRunning) {
    sendAcquisitionError(423, "Une mesure est deja en cours.");
    return;
  }
  String requestedMode = server.arg("mode");
  requestedMode.toLowerCase();
  if (requestedMode.length() == 0) requestedMode = "can";
  if (requestedMode != "can" && requestedMode != "digital") {
    sendAcquisitionError(400, "Mode invalide : utilisez can ou digital.");
    return;
  }
  digitalStreamMode = requestedMode == "digital";

  // Le POST HTTP peut arriver juste après l'ouverture du socket TCP, avant
  // l'itération suivante de taskWeb. Accepter immédiatement ce client évite
  // de refuser à tort le démarrage de la mesure numérique.
  if (digitalStreamMode && !streamConnected && streamServer.hasClient()) {
    WiFiClient incoming = streamServer.available();
    xSemaphoreTake(streamClientMutex, portMAX_DELAY);
    if (streamClient) streamClient.stop();
    streamClient = incoming;
    streamClient.setNoDelay(true);
    streamConnected = true;
    xSemaphoreGive(streamClientMutex);
  }

  // En mode CAN, le MCP2515 est obligatoire. En mode numérique, les mesures
  // INA226 partent uniquement sur le flux Wi-Fi direct vers l'application.
  if (!digitalStreamMode) {
    // Fermer explicitement un éventuel flux numérique précédent. En mode CAN,
    // aucune trame ne doit partir sur le port TCP 3333.
    xSemaphoreTake(streamClientMutex, portMAX_DELAY);
    if (streamClient) streamClient.stop();
    streamConnected = false;
    xSemaphoreGive(streamClientMutex);
    StreamFrame discardedFrame;
    while (xQueueReceive(streamQueue, &discardedFrame, 0) == pdTRUE) {}
  }
  uint8_t requestedOscillatorMHz = canOscillatorMHz;
  if (!digitalStreamMode && server.hasArg("oscillator_mhz")) {
    const int requestedClock = server.arg("oscillator_mhz").toInt();
    if (requestedClock != 8 && requestedClock != 16) {
      sendAcquisitionError(400, "Quartz CAN invalide : utilisez 8 ou 16 MHz.");
      return;
    }
    requestedOscillatorMHz = requestedClock;
  }
  if (!digitalStreamMode && !initializeCan(requestedOscillatorMHz)) {
    sendAcquisitionError(
      503,
      "CAN obligatoire : MCP2515 indisponible. Verifiez le cablage SPI, "
      "l'alimentation et le quartz du module."
    );
    return;
  }
  if (digitalStreamMode && !streamConnected) {
    sendAcquisitionError(503, "Application non connectee au flux numerique Wi-Fi.");
    return;
  }
  uint32_t frequency = server.arg("frequency").toInt();
  uint32_t duration = server.arg("duration").toInt();
  bool activeA = server.arg("activeA").toInt() == 1;
  bool activeB = server.arg("activeB").toInt() == 1;
  uint32_t frequencyA = activeA ? server.arg("frequencyA").toInt() : 0;
  uint32_t frequencyB = activeB ? server.arg("frequencyB").toInt() : 0;
  uint32_t durationA = activeA ? server.arg("durationA").toInt() : 0;
  uint32_t durationB = activeB ? server.arg("durationB").toInt() : 0;
  if (activeA && frequencyA == 0) frequencyA = frequency;
  if (activeB && frequencyB == 0) frequencyB = frequency;
  if (activeA && durationA == 0) durationA = duration;
  if (activeB && durationB == 0) durationB = duration;

  if ((!activeA && !activeB)
      || (activeA && (frequencyA < 1 || frequencyA > 2000 || durationA < 1))
      || (activeB && (frequencyB < 1 || frequencyB > 2000 || durationB < 1))) {
    sendAcquisitionError(400, "Parametres de mesure invalides.");
    return;
  }
  if (frequencyA + frequencyB > 2000) {
    sendAcquisitionError(400, "La somme des frequences A et B ne doit pas depasser 2000 Hz.");
    return;
  }

  pcBaseTimestamp = server.arg("timestamp").toInt();
  timerFrequency = max(frequencyA, frequencyB);
  testDurationSec = max(durationA, durationB);
  targetFrequencyA = frequencyA;
  targetFrequencyB = frequencyB;
  testDurationSecA = durationA;
  testDurationSecB = durationB;
  currentCfg.frequency = timerFrequency;
  currentCfg.duration = testDurationSec;
  currentCfg.frequencyA = frequencyA;
  currentCfg.frequencyB = frequencyB;
  currentCfg.durationA = durationA;
  currentCfg.durationB = durationB;
  currentCfg.activeA = activeA ? 1 : 0;
  currentCfg.activeB = activeB ? 1 : 0;
  sensorRunningA = activeA;
  sensorRunningB = activeB;
  sensorFinishedA = false;
  sensorFinishedB = false;
  lastElapsedSec = 0;
  acqCountA = 0; lostCountA = 0; freqReelleA = 0;
  acqCountB = 0; lostCountB = 0; freqReelleB = 0;
  schedulerAccumulatorA = 0;
  schedulerAccumulatorB = 0;
  canTxOk = 0;
  canTxErrors = 0;
  canLastTxResult = CAN_OK;

  Wire.setClock(timerFrequency >= 2000 ? 1000000 : 400000);
  if (activeA) configureINA226(ADDR_INA_A, frequencyA);
  if (activeB) configureINA226(ADDR_INA_B, frequencyB);

  testStartMillis = millis();
  testStartMicros = esp_timer_get_time();
  byte timePacket[4] = {0};
  memcpy(timePacket, (const void*)&pcBaseTimestamp, sizeof(pcBaseTimestamp));
  bool transportReady = sendCanFrame(CAN_ID_TIME_SYNC, sizeof(timePacket), timePacket);
  // A CAN listener may start after acquisition. A missing first ACK must not
  // cancel all future samples or silently change an 8 MHz crystal to 16 MHz.
  if (digitalStreamMode && !transportReady) {
    sendAcquisitionError(
      503,
      "L'application ne recoit pas le flux numerique Wi-Fi."
    );
    return;
  }

  testRunning = true;
  esp_err_t timerStatus = esp_timer_start_periodic(acqTimer, 1000000ULL / timerFrequency);
  if (timerStatus != ESP_OK) {
    stopAcquisition(false);
    sendAcquisitionError(500, "Le timer d'acquisition n'a pas demarre.");
    return;
  }
  sendAcquisitionStatus();
}

void handleApiStopAcquisition() {
  String sensor = server.arg("sensor");
  sensor.toUpperCase();
  if (sensor == "A") {
    stopSensor('A');
  } else if (sensor == "B") {
    stopSensor('B');
  } else if (sensor == "ALL") {
    stopAcquisition(false);
  } else {
    sendAcquisitionError(400, "Capteur invalide.");
    return;
  }
  sendAcquisitionStatus();
}

// Start the radio before any external peripheral can delay setup().
bool startAccessPoint() {
  WiFi.persistent(false);
  WiFi.setHostname(DEVICE_HOSTNAME);
  // Station mode is only needed when optional router credentials are supplied.
  if (!WiFi.mode(strlen(WIFI_SSID) > 0 ? WIFI_AP_STA : WIFI_AP)) {
    Serial.println("[WIFI] Echec de l'activation de la radio.");
    return false;
  }
  WiFi.setSleep(false);
  const IPAddress apIP(192, 168, 4, 1);
  const IPAddress subnet(255, 255, 255, 0);
  if (!WiFi.softAPConfig(apIP, apIP, subnet)
      || !WiFi.softAP(ACCESS_POINT_SSID, ACCESS_POINT_PASS, 1, 0, 4)) {
    Serial.println("[WIFI] Echec de creation du point d'acces; nouvelle tentative dans 2 s.");
    WiFi.mode(WIFI_OFF);
    return false;
  }
  Serial.printf("[WIFI] Point d'acces visible : %s (canal 1), IP: ", ACCESS_POINT_SSID);
  Serial.println(WiFi.softAPIP());
  return true;
}

void taskWeb(void* parameter) {
  // La connexion à un réseau local est facultative. Le point d'accès direct
  // reste disponible même si aucun routeur n'est présent.
  if (strlen(WIFI_SSID) > 0) {
    WiFi.setAutoReconnect(true);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.print("[WIFI] Connexion optionnelle au reseau ");
    Serial.print(WIFI_SSID);
    const uint32_t connectionStartedAt = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - connectionStartedAt < 10000) {
      Serial.print('.');
      vTaskDelay(pdMS_TO_TICKS(500));
    }
    Serial.println();
    if (WiFi.status() == WL_CONNECTED) {
      Serial.print("[WIFI] Adresse sur le reseau local: ");
      Serial.println(WiFi.localIP());
    } else {
      Serial.println("[WIFI] Reseau local indisponible; point d'acces autonome conserve.");
    }
  }

  if (MDNS.begin(DEVICE_HOSTNAME)) {
    MDNS.addService("http", "tcp", 80);
    Serial.print("[WIFI] API disponible sur http://");
    Serial.print(DEVICE_HOSTNAME);
    Serial.println(".local");
  } else {
    Serial.println("[WIFI] mDNS indisponible; utiliser l'adresse IP affichee ci-dessus.");
  }

  server.on("/", HTTP_GET, handleRoot);
  server.on("/api/acquisition/start", HTTP_POST, handleApiStartAcquisition);
  server.on("/api/acquisition/stop", HTTP_POST, handleApiStopAcquisition);
  server.on("/api/acquisition/status", HTTP_GET, []() { sendAcquisitionStatus(); });
  server.begin();
  Serial.println("[HTTP] API de controle active sur le port 80.");
  streamServer.begin();
  streamServer.setNoDelay(true);
  for (;;) {
    // Traiter HTTP avant hasClient() : selon la version du cœur ESP32,
    // hasClient() peut attendre une nouvelle connexion TCP et affamer l'API.
    server.handleClient();
    if (streamServer.hasClient()) {
      WiFiClient incoming = streamServer.available();
      xSemaphoreTake(streamClientMutex, portMAX_DELAY);
      if (streamClient) streamClient.stop();
      streamClient = incoming;
      streamClient.setNoDelay(true);
      streamConnected = true;
      xSemaphoreGive(streamClientMutex);
      Serial.println("[TCP] Application connectee au flux numerique sur le port 3333.");
    }
    vTaskDelay(pdMS_TO_TICKS(2));
  }
}

void setup() {
  Serial.begin(115200);
  while (!startAccessPoint()) {
    delay(2000);
  }
  // Complete peripheral initialization before the HTTP task can access it.
  canMutex = xSemaphoreCreateMutex();
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(400000);
  SPI.begin(SPI_SCK, SPI_MISO, SPI_MOSI, PIN_CS_CAN);
  // CAN is initialized by handleApiStartAcquisition() only for CAN mode.
  // A missing MCP2515 must not delay Wi-Fi or digital acquisition.
  esp_timer_create_args_t targs = {};
  targs.callback = &onAcqTimer;
  targs.dispatch_method = ESP_TIMER_TASK;
  targs.name = "timer_global";
  esp_timer_create(&targs, &acqTimer);
  streamQueue = xQueueCreate(512, sizeof(StreamFrame));
  streamClientMutex = xSemaphoreCreateMutex();
  xTaskCreate(taskAcq, "taskAcq", 4096, nullptr, 2, &taskAcqHandle);
  xTaskCreate(taskStream, "taskStream", 4096, nullptr, 2, nullptr);
  if (xTaskCreate(taskWeb, "taskWeb", 8192, nullptr, 2, nullptr) != pdPASS) {
    Serial.println("[HTTP] Echec de creation de taskWeb : memoire insuffisante.");
  }
}

void loop() { vTaskDelay(pdMS_TO_TICKS(1000)); }
