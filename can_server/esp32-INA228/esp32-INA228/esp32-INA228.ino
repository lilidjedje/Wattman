#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WebServer.h>
#include <SPI.h>
#include <mcp_can.h>
#include "esp_timer.h"

// =========================================================================
// CONFIGURATION DES BROCHES MATÉRIELLES SÉCURISÉES POUR ESP32-C3
// =========================================================================
#define I2C_SDA       8
#define I2C_SCL       9

#define PIN_CS_CAN    7  
#define PIN_INT_CAN  10  

#define SPI_SCK       4 
#define SPI_MISO      5  
#define SPI_MOSI      3 

// --- Configuration Spécifique INA228 (Capteur A - Entrée @ 0x40) ---
const uint8_t ADDR_INA228         = 0x40; 
const uint8_t INA228_REG_CONFIG   = 0x00; 
const uint8_t INA228_REG_ADC_CONV = 0x01; 
const uint8_t INA228_REG_VSHUNT   = 0x07; 

// --- Configuration Spécifique INA226 (Capteur B - Sortie @ 0x41) ---
const uint8_t ADDR_INA226         = 0x41; 
const uint8_t INA226_REG_CONFIG   = 0x00; 
const uint8_t INA226_REG_VSHUNT   = 0x01; 

#define CAN_ID_CURRENT_A     0x100  
#define CAN_ID_STATS_A       0x101  
#define CAN_ID_CURRENT_B     0x102  
#define CAN_ID_STATS_B       0x103  
#define CAN_ID_TIME_SYNC     0x105  

const char* AP_SSID = "courant_1";
const char* AP_PASS = "12345678";

MCP_CAN CAN(PIN_CS_CAN);
WebServer server(80);

esp_timer_handle_t acqTimer = nullptr;
TaskHandle_t taskAcqHandle = nullptr;

// Verrou Mutex pour empêcher les collisions sur le bus I2C
SemaphoreHandle_t i2cMutex = nullptr;

volatile uint32_t testDurationSec = 0;
volatile bool     testRunning     = false;
unsigned long     testStartMillis = 0;
volatile uint32_t pcBaseTimestamp = 0; 

volatile uint32_t acqCountA = 0,    acqCountB = 0;
volatile uint32_t lostCountA = 0,   lostCountB = 0;
volatile uint32_t freqReelleA = 0,  freqReelleB = 0;

struct ConfigPayload {
  uint32_t frequency;
  uint32_t duration; 
  uint32_t activeA;
  uint32_t activeB;
};
volatile ConfigPayload currentCfg = {2000, 10, 1, 1};

bool bBusI2COk = false; 

// =========================================================================
// PILOTAGE DES COMPOSANTS MATÉRIELS EN CONFIGURATION MAX SPEED
// =========================================================================
bool writeRegister16(uint8_t addr, uint8_t reg, uint16_t value) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write((uint8_t)((value >> 8) & 0xFF));
  Wire.write((uint8_t)(value & 0xFF));
  return (Wire.endTransmission() == 0);
}

void configureINA228MaxSpeed(uint8_t addr) {
  writeRegister16(addr, INA228_REG_CONFIG, 0x0000); 
  uint16_t adc_config = (0b000 << 12) | (0b000 << 9) | (0b000 << 6) | 0x0D;           
  writeRegister16(addr, INA228_REG_ADC_CONV, adc_config);
}

void configureINA226MaxSpeed(uint8_t addr) {
  uint16_t config_bits = (0b000 << 9) | (0b000 << 6) | (0b000 << 3) | 0b101;         
  writeRegister16(addr, INA226_REG_CONFIG, config_bits);
}

inline int32_t readINA228ShuntRaw() {
  Wire.beginTransmission(ADDR_INA228);
  Wire.write(INA228_REG_VSHUNT);
  if (Wire.endTransmission(false) != 0) return 0;
  if (Wire.requestFrom(ADDR_INA228, (uint8_t)3) == 3) {
    uint32_t raw24 = ((uint32_t)Wire.read() << 16) | ((uint32_t)Wire.read() << 8) | Wire.read();
    if (raw24 & 0x800000) raw24 |= 0xFF000000; 
    return (int32_t)raw24;
  }
  return 0;
}

inline int16_t readINA226ShuntRaw() {
  Wire.beginTransmission(ADDR_INA226);
  Wire.write(INA226_REG_VSHUNT);
  if (Wire.endTransmission(false) != 0) return 0;
  if (Wire.requestFrom(ADDR_INA226, (uint8_t)2) == 2) {
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
// TRANSMISSION CAN ET MÉTROLOGIE (SÉCURISÉE PAR MUTEX)
// =========================================================================
void taskAcq(void* parameter) {
  if (!Wire.begin(I2C_SDA, I2C_SCL)) {
    bBusI2COk = false;
  } else {
    Wire.setClock(1000000);
    Wire.setTimeOut(20);
    bBusI2COk = true;
  }

  SPI.begin(SPI_SCK, SPI_MISO, SPI_MOSI, PIN_CS_CAN);
  SPI.setFrequency(4000000);
  CAN.begin(MCP_ANY, CAN_500KBPS, MCP_8MHZ);
  CAN.setMode(MCP_NORMAL);

  uint32_t lastPrintMs = 0;
  uint32_t lastSnapshotA = 0, lastSnapshotB = 0;
  byte canPacket[8] = {0};
  bool toggleSwitch = false;

  for (;;) {
    if (!testRunning) {
      vTaskDelay(pdMS_TO_TICKS(20));
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

    if (!bBusI2COk) { lostCountA++; lostCountB++; continue; }

    // --- PRISE DU VERROU I2C AVANT LECTURE ---
    if (xSemaphoreTake(i2cMutex, pdMS_TO_TICKS(5)) == pdTRUE) {
      
      if (toggleSwitch) {
        if (currentCfg.activeA) {
          acqCountA++;
          int32_t rawA = readINA228ShuntRaw();
          float IA = rawA * 312.5e-9f / 0.01f;
          memset(canPacket, 0, 8); memcpy(&canPacket[0], &IA, sizeof(float));
          CAN.sendMsgBuf(CAN_ID_CURRENT_A, 0, 8, canPacket);
        }
      } else {
        if (currentCfg.activeB) {
          acqCountB++;
          int16_t rawB = readINA226ShuntRaw();
          float IB = rawB * 2.5e-6f / 0.1f;
          memset(canPacket, 0, 8); memcpy(&canPacket[0], &IB, sizeof(float));
          CAN.sendMsgBuf(CAN_ID_CURRENT_B, 0, 8, canPacket);
        }
      }
      toggleSwitch = !toggleSwitch;

      xSemaphoreGive(i2cMutex); // LIBÉRATION DU BUS I2C
    } else {
      // Si le bus était occupé par le serveur Web, on compte un paquet manqué
      if (toggleSwitch) lostCountA++; else lostCountB++;
    }

    uint32_t nowMs = millis();
    if (nowMs - lastPrintMs >= 1000) {
      freqReelleA = acqCountA - lastSnapshotA;
      freqReelleB = acqCountB - lastSnapshotB;
      lastSnapshotA = acqCountA; lastSnapshotB = acqCountB;
      lastPrintMs = nowMs;

      if (currentCfg.activeA) {
        uint16_t statsA[2] = {(uint16_t)freqReelleA, (uint16_t)lostCountA};
        memset(canPacket, 0, 8); memcpy(&canPacket[0], &statsA[0], 2); memcpy(&canPacket[2], &statsA[1], 2);
        CAN.sendMsgBuf(CAN_ID_STATS_A, 0, 8, canPacket);
      }
      if (currentCfg.activeB) {
        uint16_t statsB[2] = {(uint16_t)freqReelleB, (uint16_t)lostCountB};
        memset(canPacket, 0, 8); memcpy(&canPacket[0], &statsB[0], 2); memcpy(&canPacket[2], &statsB[1], 2);
        CAN.sendMsgBuf(CAN_ID_STATS_B, 0, 8, canPacket);
      }

      uint32_t calcul_ts = pcBaseTimestamp + ((nowMs - testStartMillis) / 1000UL);
      memset(canPacket, 0, 8); memcpy(&canPacket[0], &calcul_ts, 4);
      CAN.sendMsgBuf(CAN_ID_TIME_SYNC, 0, 4, canPacket);
    }

    if (nowMs - testStartMillis >= testDurationSec * 1000UL) {
      testRunning = false;
      esp_timer_stop(acqTimer);
    }
  }
}

// =========================================================================
// SERVICES INTERFACE WEB
// =========================================================================
void handleRoot() {
  static const char HTML[] PROGMEM = R"HTML(
<!DOCTYPE html><html lang="fr"><head>
<meta charset="utf-8"><title>Contrôle Bus Hybride INA</title>
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
.progress-container{margin-top:1rem;display:none;}
.progress-bar-bg{background:#e2e8f0;border-radius:6px;overflow:hidden;height:20px;width:100%;border:1px solid #cbd5e1;}
.progress-bar-fill{background:#3b82f6;height:100%;width:0%;transition:width 0.3s ease;}
</style>
</head><body>
  <h1>Générateur CAN - INA228 / INA226 Mutex</h1>
  <div class="card">
    <h2>📊 État de l'acquisition</h2>
    <div id="statusText" style="font-weight:bold; color:#64748b;">Statut : Prêt</div>
    <div class="progress-container" id="progressContainer">
      <div class="progress-bar-bg"><div class="progress-bar-fill" id="progressBarFill"></div></div>
    </div>
  </div>
  <form id="formConfig">
    <input type="hidden" id="clientTime" name="clientTime">
    <div class="card">
      <h2>⚙️ Configuration des Fréquences Intercalées</h2>
      <label>Vitesse Globale du Timer</label>
      <select name="freq">
        <option value="1000">1000 Hz (500 Hz par capteur)</option>
        <option value="2000" selected>2000 Hz (1000 Hz par capteur)</option>
        <option value="4000">4000 Hz (2000 Hz par capteur)</option>
      </select><br><br>
      <label>Durée</label>
      <div class="duration-group">
        <input type="number" name="dureeValeur" min="1" value="10" required>
        <select name="dureeUnite"><option value="s">Secondes</option></select>
      </div>
    </div>
    <div class="card">
      <label><input type="checkbox" name="activeA" value="1" checked style="width:auto"> Capteur A (INA228)</label><br>
      <label><input type="checkbox" name="activeB" value="1" checked style="width:auto"> Capteur B (INA226)</label>
    </div>
    <button type="submit">🚀 Lancer l'acquisition</button>
  </form>
  <script>
    let intervalStatus = null;
    document.getElementById("formConfig").addEventListener("submit", function(e) {
      e.preventDefault();
      document.getElementById("clientTime").value = Math.floor(Date.now() / 1000);
      fetch("/setDuration", { method: "POST", body: new FormData(this) }).then(() => { demarrerSuiviJauge(); });
    });
    function demarrerSuiviJauge() {
      document.getElementById("progressContainer").style.display = "block";
      if(intervalStatus) clearInterval(intervalStatus);
      intervalStatus = setInterval(() => {
        fetch("/getStatus").then(r => r.json()).then(data => {
          if (!data.running) { clearInterval(intervalStatus); document.getElementById("progressBarFill").style.width = "100%"; }
          else { let p = (data.elapsed / data.total) * 100; document.getElementById("progressBarFill").style.width = p + "%"; }
        });
      }, 1000);
    }
  </script>
</body></html>
)HTML";
  server.send(200, "text/html; charset=utf-8", HTML);
}

void handleGetStatus() {
  uint32_t elapsed = 0;
  if (testRunning) elapsed = (millis() - testStartMillis) / 1000UL;
  String json = "{\"running\":" + String(testRunning ? "true" : "false") + ",\"elapsed\":" + String(elapsed) + ",\"total\":" + String(testDurationSec) + ",\"i2cOk\":" + String(bBusI2COk ? "true" : "false") + "}";
  server.send(200, "application/json", json);
}

void handleStop() {
  esp_timer_stop(acqTimer);
  testRunning = false;
  server.send(200, "text/plain", "Coupé.");
}

void handleSetDuration() {
  if (testRunning) return;
  if (server.hasArg("clientTime")) pcBaseTimestamp = server.arg("clientTime").toInt();
  
  uint32_t targetFreq = server.arg("freq").toInt();
  uint32_t valeurSaisie = server.arg("dureeValeur").toInt();
  testDurationSec = valeurSaisie;

  currentCfg.frequency = targetFreq; currentCfg.duration = testDurationSec;
  currentCfg.activeA = server.hasArg("activeA") ? 1 : 0; currentCfg.activeB = server.hasArg("activeB") ? 1 : 0;

  // --- SÉCURISATION DU BUS I2C PENDANT LA CONFIGURATION VIA MUTEX ---
  if (xSemaphoreTake(i2cMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
    Wire.setClock(1000000);
    if (currentCfg.activeA) configureINA228MaxSpeed(ADDR_INA228);
    if (currentCfg.activeB) configureINA226MaxSpeed(ADDR_INA226);
    xSemaphoreGive(i2cMutex);
  }

  acqCountA = 0; lostCountA = 0; acqCountB = 0; lostCountB = 0;

  byte canPacketTime[8] = {0}; memcpy(&canPacketTime[0], (const void*)&pcBaseTimestamp, 4);
  CAN.sendMsgBuf(CAN_ID_TIME_SYNC, 0, 4, canPacketTime);
  
  testStartMillis = millis(); testRunning = true;
  esp_timer_start_periodic(acqTimer, 1000000ULL / targetFreq);
  server.send(200, "text/plain", "OK");
}

void taskWeb(void* parameter) {
  WiFi.mode(WIFI_AP); WiFi.softAP(AP_SSID, AP_PASS);
  server.on("/", HTTP_GET, handleRoot); server.on("/setDuration", HTTP_POST, handleSetDuration);
  server.on("/getStatus", HTTP_GET, handleGetStatus); server.on("/stop", HTTP_GET, handleStop);          
  server.begin();
  
  for (;;) { 
    server.handleClient(); 
    vTaskDelay(pdMS_TO_TICKS(40)); 
  }
}

// =========================================================================
// SETUP UNIQUE CORE (ESP32-C3)
// =========================================================================
void setup() {
  delay(2000); 
  Serial.begin(115200);

  // Initialisation du Mutex de protection I2C avant de lancer les tâches
  i2cMutex = xSemaphoreCreateMutex();
  
  esp_timer_create_args_t targs = {};
  targs.callback = &onAcqTimer;
  targs.dispatch_method = ESP_TIMER_TASK;
  targs.name = "timer_global";
  esp_timer_create(&targs, &acqTimer);

  xTaskCreate(taskAcq, "taskAcq", 4096, nullptr, 4, &taskAcqHandle);
  xTaskCreate(taskWeb, "taskWeb", 4096, nullptr, 1, nullptr);
  
  Serial.println("[SYSTEME OK] Mutex d'exclusion mutuelle I2C actif.");
}

void loop() { 
  vTaskDelay(pdMS_TO_TICKS(1000)); 
}