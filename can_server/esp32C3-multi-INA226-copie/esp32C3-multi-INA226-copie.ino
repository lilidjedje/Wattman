#include <Arduino.h>
#include <Wire.h>
#include <Preferences.h>
#include <math.h>
#include <algorithm>
#include <U8x8lib.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <WebServer.h>
#include <SPI.h>
#include <mcp_can.h>
#include "esp_timer.h"

constexpr const char* FIRMWARE_VERSION = "esp32C3-multi-INA226 | dual-display-v11 | full-coverage-integration | range-correction";

void printFirmwareVersion() {
  Serial.printf("[FIRMWARE] %s | build %s %s\n", FIRMWARE_VERSION, __DATE__, __TIME__);
}

// --- Configuration des Broches Matérielles ---
// ESP32-C3 Mini / SuperMini: GPIO8/9 are used by I2C; keep GPIO2 and 18/19 free.
#if !defined(CONFIG_IDF_TARGET_ESP32C3)
#error "Select ESP32C3 Dev Module, USB CDC On Boot: Enabled."
#endif
#define I2C_SDA 8
#define I2C_SCL 9
#define PIN_CS_CAN 7
#define PIN_INT_CAN 10
#define SPI_SCK 4
#define SPI_MISO 5
#define SPI_MOSI 6

const uint8_t ADDR_INA_A = 0x40;
const uint8_t ADDR_INA_B = 0x44;
const uint8_t REG_CONFIG = 0x00;
const uint8_t REG_SHUNT = 0x01;

// I = Vshunt / Rshunt ; INA226 shunt voltage resolution: 2.5 uV/LSB.
constexpr float SHUNT_VOLTAGE_LSB_V = 2.5e-6f;
constexpr float RSHUNT_A_OHMS = 0.010f;  // R010: 10 mOhm
constexpr float RSHUNT_B_OHMS = 0.010f;  // R010: 10 mOhm

#define CAN_ID_CURRENT_A 0x100
#define CAN_ID_STATS_A 0x101
#define CAN_ID_CURRENT_B 0x102
#define CAN_ID_STATS_B 0x103
#define CAN_ID_TIME_SYNC 0x105

constexpr bool CAN_ZERO_CURRENT_TEST = false;  // Real INA measurements, including zero current.

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
const char* ACCESS_POINT_SSID = "esp32_mesure";
const char* ACCESS_POINT_PASS = "ina226mesure";
const char* DEVICE_HOSTNAME = "esp32c3-mesure";

MCP_CAN CAN(PIN_CS_CAN);
WebServer server(80);
WiFiServer streamServer(3333);
WiFiClient streamClient;
esp_timer_handle_t acqTimer = nullptr;
TaskHandle_t taskAcqHandle = nullptr;
TaskHandle_t taskOledHandle = nullptr;
QueueHandle_t streamQueue = nullptr;
SemaphoreHandle_t streamClientMutex = nullptr;
SemaphoreHandle_t canMutex = nullptr;
SemaphoreHandle_t i2cMutex = nullptr;

volatile uint32_t testDurationSec = 0;
volatile uint32_t testDurationSecA = 0, testDurationSecB = 0;
volatile uint32_t targetFrequencyA = 0, targetFrequencyB = 0;
volatile uint32_t timerFrequency = 1000;
volatile uint32_t schedulerAccumulatorA = 0, schedulerAccumulatorB = 0;
volatile bool testRunning = false;
unsigned long testStartMillis = 0;
volatile uint64_t testStartMicros = 0;
volatile uint32_t lastElapsedSec = 0;
volatile bool sensorRunningA = false;
volatile bool sensorRunningB = false;
volatile bool sensorFinishedA = false;
volatile bool sensorFinishedB = false;
volatile bool sensorStoppedA = false, sensorStoppedB = false;
volatile bool canReady = false;
volatile uint32_t canTxOk = 0;
volatile uint32_t canTxErrors = 0;
volatile uint8_t canLastTxResult = CAN_OK;
volatile uint16_t canLastTxId = 0;
volatile uint8_t canErrorFlags = 0;
volatile uint8_t canTxErrorCount = 0;
volatile uint8_t canOscillatorMHz = 8;
volatile bool digitalStreamMode = false;
volatile bool recorderMirror = false;

// Variable pour stocker le temps d'origine fourni par le PC
volatile uint32_t pcBaseTimestamp = 0;
volatile uint64_t pcBaseTimestampUs = 0;
volatile bool streamEndPending = false;
volatile bool acquisitionBusy = false;
volatile float latestCurrentA = 0.0f, latestCurrentB = 0.0f;
volatile bool latestValidA = false, latestValidB = false;
uint64_t lastSampleMicrosA = 0;
uint64_t lastSampleMicrosB = 0;
enum OledScreenState : uint8_t {
  OLED_WELCOME,
  OLED_DIGITAL_SELECTED,
  OLED_CAN_SELECTED,
  OLED_DIGITAL_RUNNING,
  OLED_MEASUREMENT_RUNNING,
  OLED_CAN_RECORDING,
  OLED_MEASUREMENT_FINISHED
};
volatile OledScreenState oledScreenState = OLED_WELCOME;
volatile bool oledInitialized = false;
U8X8_SH1106_128X64_NONAME_HW_I2C oled(U8X8_PIN_NONE, I2C_SCL, I2C_SDA);

// SH1106 128x64: 8x8 pixel cells, with an empty cell on each edge.
// Six useful rows of 14 characters: x=8..119, y=8..55.
constexpr uint8_t OLED_COLUMNS = 16;
constexpr uint8_t OLED_ROWS = 8;
constexpr uint8_t OLED_TEXT_COLUMNS = OLED_COLUMNS - 2;
constexpr uint8_t OLED_TEXT_ROWS = OLED_ROWS - 2;
constexpr uint32_t OLED_BUS_HZ = 400000;
char oledPrevious[OLED_ROWS][OLED_COLUMNS];  // Accessed only by taskOled.

void drawOledLines(char lines[8][17]) {
  for (uint8_t row = 0; row < OLED_TEXT_ROWS; ++row) {
    char padded[OLED_TEXT_COLUMNS];
    memset(padded, ' ', sizeof(padded));
    memcpy(padded, lines[row], strnlen(lines[row], OLED_TEXT_COLUMNS));
    for (uint8_t col = 0; col < OLED_TEXT_COLUMNS;) {
      if (padded[col] == oledPrevious[row + 1][col + 1]) {
        ++col;
        continue;
      }
      // At most two tiles per transaction; release I2C between updates so
      // higher-priority INA reads can proceed. Never clear the whole frame.
      const uint8_t first = col;
      char changed[3] = {};
      uint8_t count = 0;
      while (col < OLED_TEXT_COLUMNS && count < 2
             && padded[col] != oledPrevious[row + 1][col + 1]) {
        changed[count++] = padded[col++];
      }
      if (xSemaphoreTake(i2cMutex, pdMS_TO_TICKS(2)) != pdTRUE) return;
      Wire.setClock(OLED_BUS_HZ);
      oled.drawString(first + 1, row + 1, changed);
      Wire.setClock(400000);
      xSemaphoreGive(i2cMutex);
      memcpy(&oledPrevious[row + 1][first + 1], changed, count);
      vTaskDelay(1);
    }
  }
}

void formatOledCurrent(char* output, char channel, float current, bool valid) {
  if (!valid) { snprintf(output, 17, "%c: attente", channel); return; }
  if (fabsf(current) >= 1.0f) snprintf(output, 17, "%c %7.4f A", channel, current);
  else if (fabsf(current) >= 0.001f) snprintf(output, 17, "%c %7.3f mA", channel, current * 1000.0f);
  else snprintf(output, 17, "%c %7.2f uA", channel, current * 1000000.0f);
}

void taskOled(void*) {
  xSemaphoreTake(i2cMutex, portMAX_DELAY);
  oled.setBusClock(OLED_BUS_HZ);
  oled.begin();
  oled.setPowerSave(0);
  oled.setFlipMode(1);  // Rotate the existing SH1106 by 180 degrees.
  oled.setFont(u8x8_font_chroma48medium8_r);
  oled.clearDisplay();
  memset(oledPrevious, ' ', sizeof(oledPrevious));
  xSemaphoreGive(i2cMutex);
  oledInitialized = true;
  uint32_t lastKeepAwake = millis();
  uint32_t lastIdleRedraw = millis();
  bool wasRunning = false;
  for (;;) {
    const uint32_t now = millis();
    const bool running = testRunning;
    // Keep the panel awake independently of acquisition and HTTP clients.
    // All OLED commands share the INA mutex, including this short command.
    if ((!running && wasRunning) || now - lastKeepAwake >= 1000) {
      if (xSemaphoreTake(i2cMutex, pdMS_TO_TICKS(2)) == pdTRUE) {
        Wire.setClock(OLED_BUS_HZ);
        oled.setPowerSave(0);
        Wire.setClock(400000);
        xSemaphoreGive(i2cMutex);
        lastKeepAwake = now;
      }
    }
    // The text cache cannot detect a blank panel or an interrupted I2C write.
    // Retry the entire useful area at rest, without clearing or flashing it.
    if (!running && (wasRunning || now - lastIdleRedraw >= 5000)) {
      memset(oledPrevious, 0, sizeof(oledPrevious));
      lastIdleRedraw = now;
    }
    wasRunning = running;
    char lines[8][17] = {};
    char currentA[17];
    char currentB[17];
    char remainingA[17];
    char remainingB[17];
    const OledScreenState screen = testRunning
        ? (digitalStreamMode ? OLED_DIGITAL_RUNNING : OLED_CAN_RECORDING)
        : oledScreenState;

    switch (screen) {
      case OLED_WELCOME:
        snprintf(lines[0], sizeof(lines[0]), "Hello !");
        snprintf(lines[1], sizeof(lines[1]), "Reglez votre");
        snprintf(lines[2], sizeof(lines[2]), "mesure");
        break;
      case OLED_DIGITAL_SELECTED:
        snprintf(lines[0], sizeof(lines[0]), "Mode choisi :");
        snprintf(lines[1], sizeof(lines[1]), "Numerique");
        break;
      case OLED_CAN_SELECTED:
        snprintf(lines[0], sizeof(lines[0]), "Mode choisi :");
        snprintf(lines[1], sizeof(lines[1]), "Mesure CAN");
        break;
      case OLED_DIGITAL_RUNNING:
      case OLED_MEASUREMENT_RUNNING:
        {
          const float a = latestCurrentA, b = latestCurrentB;
          formatOledCurrent(currentA, 'A', a, latestValidA);
          formatOledCurrent(currentB, 'B', b, latestValidB);
          const uint32_t elapsed = (millis() - testStartMillis) / 1000UL;
          auto formatRemaining = [elapsed](char* output, char channel, bool running,
                                           bool finished, uint32_t duration) {
            if (finished) {
              snprintf(output, 17, "%c: terminee", channel);
            } else if (!running) {
              snprintf(output, 17, "%c: inactive", channel);
            } else {
              const uint32_t remaining = elapsed < duration ? duration - elapsed : 0;
              const uint32_t hours = remaining / 3600UL;
              const uint32_t minutes = (remaining / 60UL) % 60UL;
              const uint32_t seconds = remaining % 60UL;
              snprintf(output, 17, "%c %lu:%02lu:%02lu", channel,
                       (unsigned long)hours, (unsigned long)minutes,
                       (unsigned long)seconds);
            }
          };
          formatRemaining(remainingA, 'A', sensorRunningA, sensorFinishedA, testDurationSecA);
          formatRemaining(remainingB, 'B', sensorRunningB, sensorFinishedB, testDurationSecB);
          snprintf(lines[0], sizeof(lines[0]), "%s",
                   screen == OLED_DIGITAL_RUNNING ? "NUMERIQUE ACTIF" : "MESURE EN COURS");
          uint8_t row = 1;
          if (targetFrequencyA > 0) {
            snprintf(lines[row++], sizeof(lines[0]), "%s", currentA);
            snprintf(lines[row++], sizeof(lines[0]), "%s", remainingA);
          }
          if (targetFrequencyB > 0) {
            snprintf(lines[row++], sizeof(lines[0]), "%s", currentB);
            snprintf(lines[row++], sizeof(lines[0]), "%s", remainingB);
          }
          break;
        }
      case OLED_CAN_RECORDING:
        snprintf(lines[0], sizeof(lines[0]), "Ouvrez");
        snprintf(lines[1], sizeof(lines[1]), "CANalyzer pour");
        snprintf(lines[2], sizeof(lines[2]), "visualiser les");
        snprintf(lines[3], sizeof(lines[3]), "valeurs de");
        snprintf(lines[4], sizeof(lines[4]), "courants");
        break;
      case OLED_MEASUREMENT_FINISHED:
        snprintf(lines[0], sizeof(lines[0]), "Mesure finie");
        snprintf(lines[1], sizeof(lines[1]), "%s", sensorFinishedA ? "A: terminee" : "A: arretee");
        snprintf(lines[2], sizeof(lines[2]), "%s", sensorFinishedB ? "B: terminee" : "B: arretee");
        break;
    }

    drawOledLines(lines);
    // One current snapshot per second; acquisition remains independently timed.
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));
  }
}


volatile uint32_t acqCountA = 0, acqCountB = 0;
volatile uint32_t lostCountA = 0, lostCountB = 0;
volatile uint32_t freqReelleA = 0, freqReelleB = 0;

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
volatile ConfigPayload currentCfg = { 1000, 10, 1000, 1000, 10, 10, 1, 1 };

struct __attribute__((packed)) StreamFrame {
  uint16_t magic;
  uint8_t version;
  uint8_t length;
  uint16_t identifier;
  uint64_t timestampUs;
  uint8_t payload[8];
};

volatile bool streamConnected = false;
#include "wattman_tft.h"
QueueHandle_t canTransmitQueue = nullptr;
bool initializeCan(uint8_t oscillatorMHz);

// CAN acknowledgements must never block INA acquisition or Pi recording.
void taskCanTransmit(void*) {
  StreamFrame frame;
  uint32_t lastRecovery = 0;
  for (;;) {
    if (xQueueReceive(canTransmitQueue, &frame, portMAX_DELAY) != pdTRUE) continue;
    if ((canErrorFlags & 0x20) && millis() - lastRecovery >= 1000) {
      lastRecovery = millis();
      initializeCan(canOscillatorMHz);
    }
    xSemaphoreTake(canMutex, portMAX_DELAY);
    canLastTxId = frame.identifier;
    canLastTxResult = canReady ? CAN.sendMsgBuf(frame.identifier, 0, frame.length, frame.payload) : CAN_FAILINIT;
    if (canReady) {
      canErrorFlags = CAN.getError();
      canTxErrorCount = CAN.errorCountTX();
    }
    xSemaphoreGive(canMutex);
    if (canLastTxResult == CAN_OK) ++canTxOk;
    else ++canTxErrors;
  }
}

bool sendCanFrame(uint16_t identifier, uint8_t length, byte* payload) {
  bool delivered = false;
  if (!digitalStreamMode && !recorderMirror) {
    xSemaphoreTake(canMutex, portMAX_DELAY);
    canLastTxId = identifier;
    canLastTxResult = canReady ? CAN.sendMsgBuf(identifier, 0, length, payload) : CAN_FAILINIT;
    const bool canDelivered = canLastTxResult == CAN_OK;
    if (canReady) {
      canErrorFlags = CAN.getError();
      canTxErrorCount = CAN.errorCountTX();
    }
    xSemaphoreGive(canMutex);
    if (canDelivered) {
      canTxOk = canTxOk + 1;
      delivered = true;
    } else {
      canTxErrors = canTxErrors + 1;
    }
  }
  if ((digitalStreamMode || recorderMirror) && streamConnected && streamQueue && length <= 8) {
    StreamFrame frame = {};
    frame.magic = 0xA55A;
    frame.version = 1;
    frame.length = length;
    frame.identifier = identifier;
    const uint64_t elapsedUs = testStartMicros ? esp_timer_get_time() - testStartMicros : 0;
    frame.timestampUs = (pcBaseTimestampUs ? pcBaseTimestampUs : (uint64_t)pcBaseTimestamp * 1000000ULL) + elapsedUs;
    memcpy(frame.payload, payload, length);
    if (xQueueSend(streamQueue, &frame, 0) == pdTRUE) delivered = true;
    if (recorderMirror && !digitalStreamMode && canTransmitQueue) {
      // Mirror only the original CAN payload, with its original identifier.
      if (xQueueSend(canTransmitQueue, &frame, 0) != pdTRUE) ++canTxErrors;
    }
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
      oscillatorMHz);
  }
  xSemaphoreGive(canMutex);
  return canReady;
}

void taskStream(void* parameter) {
  StreamFrame frame;
  for (;;) {
    if (xQueueReceive(streamQueue, &frame, pdMS_TO_TICKS(20)) != pdTRUE) {
      if (!streamEndPending || acquisitionBusy) continue;
      frame = {};
      frame.magic = 0xA55A;
      frame.version = 1;
      frame.length = 8;
      frame.identifier = 0x106;
      frame.timestampUs = pcBaseTimestampUs + (esp_timer_get_time() - testStartMicros);
      const uint32_t counts[2] = { acqCountA, acqCountB };
      memcpy(frame.payload, counts, sizeof(counts));
      streamEndPending = false;
    }
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
  if (!completed) {
    sensorStoppedA = sensorStoppedA || sensorRunningA;
    sensorStoppedB = sensorStoppedB || sensorRunningB;
  }
  lastElapsedSec = completed ? testDurationSec : (millis() - testStartMillis) / 1000UL;
  testRunning = false;
  if (completed && digitalStreamMode) oledScreenState = OLED_MEASUREMENT_FINISHED;
  if (digitalStreamMode || recorderMirror) streamEndPending = true;
  sensorFinishedA = sensorFinishedA || (completed && currentCfg.activeA);
  sensorFinishedB = sensorFinishedB || (completed && currentCfg.activeB);
  sensorRunningA = false;
  sensorRunningB = false;
  if (!digitalStreamMode && !sensorRunningA && !sensorRunningB) {
    oledScreenState = OLED_CAN_RECORDING;
  }
  if (taskOledHandle) xTaskNotifyGive(taskOledHandle);
  esp_timer_stop(acqTimer);
}

void stopSensor(char sensor) {
  if (sensor == 'A') {
    sensorStoppedA = true;
    sensorRunningA = false;
    sensorFinishedA = true;
  }
  if (sensor == 'B') {
    sensorStoppedB = true;
    sensorRunningB = false;
    sensorFinishedB = true;
  }
  if (!sensorRunningA && !sensorRunningB) stopAcquisition(false);
}

bool inaWriteRegister16(uint8_t addr, uint8_t reg, uint16_t value) {
  xSemaphoreTake(i2cMutex, portMAX_DELAY);
  Wire.setClock(400000);
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write((uint8_t)((value >> 8) & 0xFF));
  Wire.write((uint8_t)(value & 0xFF));
  const bool success = Wire.endTransmission() == 0;
  xSemaphoreGive(i2cMutex);
  return success;
}

// Explicitly sequence reads: never depend on evaluation order of Wire.read().
bool inaReadRegister16(uint8_t addr, uint8_t reg, uint16_t& value) {
  xSemaphoreTake(i2cMutex, portMAX_DELAY);
  Wire.setClock(400000);
  Wire.beginTransmission(addr);
  Wire.write(reg);
  bool ok = Wire.endTransmission(false) == 0;
  if (ok) ok = Wire.requestFrom(addr, (uint8_t)2) == 2;
  if (ok) {
    const uint8_t msb = Wire.read();
    const uint8_t lsb = Wire.read();
    value = (uint16_t(msb) << 8) | lsb;
  }
  xSemaphoreGive(i2cMutex);
  return ok;
}

// The INA226 input offset depends on the conversion time and on averaging, so
// each acquisition profile has its own zero. Profiles (shunt only, continuous,
// worst-case conversion-time margin included):
//   0: <=100 Hz  -> AVG x CT block filling ~90 % of the period (chooseIntegration)
//   1: <=400 Hz  -> 2.116 ms
//   2: <=1000 Hz -> 588 us
//   3: above     -> 204 us
constexpr uint8_t INA_PROFILE_COUNT = 4;
// CSV channel A: mean of seven checkpoint means = 0.893113 A,
// simultaneous Fluke = 1.006600 A. This scales the PREVIOUSLY calibrated output.
// B has no reference dataset and must not inherit A's correction.
constexpr float CSV_OUTPUT_SCALE[2] = {1.1270690271f, 1.0f};
// Per-range correction, applied on top of the output above (channel A only).
// Each point = {INA current shown WITHOUT this table [A], factor = Fluke / INA}.
// The factor is interpolated linearly in |I| between points and held constant
// outside them. Add one point per measured range (below 500 mA target 0.1 %,
// above 0.3 %). Only add points from a campaign whose reading is stable.
struct RangePoint { float current; float factor; };
// 2026-11-18, ~900 mA campaign (R1, 11 windows): Fluke mean 0.901909 A,
// INA mean 0.874071 A -> 1.031848.
constexpr RangePoint RANGE_CORRECTION_A[] = {
  {0.874071f, 1.031848f},
};
constexpr size_t RANGE_CORRECTION_A_COUNT = sizeof(RANGE_CORRECTION_A) / sizeof(RANGE_CORRECTION_A[0]);

float rangeCorrection(uint8_t i, float current) {
  if (i != 0 || RANGE_CORRECTION_A_COUNT == 0) return 1.0f;
  const float x = fabsf(current);
  const RangePoint* p = RANGE_CORRECTION_A;
  if (x <= p[0].current) return p[0].factor;
  for (size_t k = 1; k < RANGE_CORRECTION_A_COUNT; ++k) {
    if (x <= p[k].current) {
      const float t = (x - p[k - 1].current) / (p[k].current - p[k - 1].current);
      return p[k - 1].factor + t * (p[k].factor - p[k - 1].factor);
    }
  }
  return p[RANGE_CORRECTION_A_COUNT - 1].factor;
}
constexpr bool CURRENT_FILTER_ENABLED = true;
constexpr uint32_t CURRENT_AVERAGE_MS = 20;
constexpr uint8_t CURRENT_FILTER_CAPACITY = 40; // 20 ms at max supported 2000 Hz.
struct CurrentFilter {
  float previous[3] = {};
  float values[CURRENT_FILTER_CAPACITY] = {};
  double sum = 0;
  uint8_t historyCount = 0, historyPos = 0, count = 0, pos = 0, width = 1;
};
CurrentFilter currentFilters[2]; // Only acquisition accesses these after start.

void resetCurrentFilter(uint8_t i, uint32_t frequency) {
  currentFilters[i] = CurrentFilter{};
  uint32_t width = (frequency * CURRENT_AVERAGE_MS + 999) / 1000;
  if (width < 1) width = 1;
  if (width > CURRENT_FILTER_CAPACITY) width = CURRENT_FILTER_CAPACITY;
  currentFilters[i].width = (uint8_t)width;
}

float filterCurrent(uint8_t i, float input) {
  if (!CURRENT_FILTER_ENABLED) return input;
  CurrentFilter& f = currentFilters[i];
  f.previous[f.historyPos] = input;
  f.historyPos = (f.historyPos + 1) % 3;
  if (f.historyCount < 3) ++f.historyCount;
  float sample = input;
  if (f.historyCount == 3) {
    const float a = f.previous[0], b = f.previous[1], c = f.previous[2];
    sample = fmaxf(fminf(a, b), fminf(fmaxf(a, b), c));
  }
  if (f.count == f.width) f.sum -= f.values[f.pos];
  else ++f.count;
  f.values[f.pos] = sample;
  f.sum += sample;
  f.pos = (f.pos + 1) % f.width;
  return (float)(f.sum / f.count); // No delay, no zero-filled startup transient.
}

constexpr uint32_t INA_PROFILE_FREQ[INA_PROFILE_COUNT] = {100, 400, 1000, 2000};
volatile uint8_t inaActiveProfile[2] = {0, 0};

uint8_t inaProfileFor(uint32_t freq) {
  return freq <= 100 ? 0 : (freq <= 400 ? 1 : (freq <= 1000 ? 2 : 3));
}

// Full-coverage integration for profile 0 (<= 100 Hz). Each read returns the
// mean of one INA block (AVG x CT). A block covering ~90 % of the sampling period
// (typical timing, ~99 % at the +10 % worst case) cancels the load ripple at
// every multiple of the sampling frequency: exactly the components that alias to
// near-DC drift. The old fixed 4 x 2.116 ms block covered only ~42 % at 50 Hz.
// 100 Hz -> 64 x 140 us = 8.96 ms ; 50 Hz -> 128 x 140 us = 17.9 ms.
constexpr uint16_t INA_CT_US[8] = {140, 204, 332, 588, 1100, 2116, 4156, 8244};
constexpr uint16_t INA_AVG_N[8] = {1, 4, 16, 64, 128, 256, 512, 1024};
uint32_t chooseIntegration(uint32_t freq, uint16_t& avgCode, uint16_t& ctCode) {
  const uint32_t target = (uint32_t)(900000ULL / (freq ? freq : 1)); // 90 % of period, us
  uint32_t best = 0;
  avgCode = 1; ctCode = 5;
  for (uint16_t a = 0; a < 8; ++a)
    for (uint16_t c = 0; c < 8; ++c) {
      const uint32_t block = (uint32_t)INA_AVG_N[a] * INA_CT_US[c];
      if (block <= target && (block > best || (block == best && a > avgCode))) {
        best = block; avgCode = a; ctCode = c;
      }
    }
  return best;
}

bool configureINA226(uint8_t addr, uint32_t freq) {
  const uint8_t profile = inaProfileFor(freq);
  uint16_t avg = profile == 0 ? 1 : 0;
  uint16_t ct = profile <= 1 ? 5 : (profile == 2 ? 3 : 1);
  uint32_t blockUs = (uint32_t)INA_AVG_N[avg] * INA_CT_US[ct];
  if (profile == 0) blockUs = chooseIntegration(freq, avg, ct);
  const uint16_t config = (avg << 9) | (ct << 6) | (ct << 3) | 0b101;
  uint16_t actual = 0;
  if (!inaWriteRegister16(addr, REG_CONFIG, config)
      || !inaReadRegister16(addr, REG_CONFIG, actual)
      || (actual & 0x0FFF) != config) return false;
  // Discard the previous configuration's conversion: wait one worst-case block.
  delay(max<uint32_t>(12, blockUs * 11 / 10000 + 2));
  inaActiveProfile[addr == ADDR_INA_B ? 1 : 0] = profile;
  resetCurrentFilter(addr == ADDR_INA_B ? 1 : 0, freq);
  return true;
}

Preferences calibrationStore;
// Raw ADC counts at zero current, one value per conversion profile.
float calibrationZero[2][INA_PROFILE_COUNT] = {{0, 0, 0, 0}, {0, 0, 0, 0}};
float calibrationGain[2] = {1, 1};
bool calibrationHasZero[2] = {false, false};
bool calibrationHasGain[2] = {false, false};
volatile uint32_t inaReadErrors[2] = {0, 0};
volatile uint32_t inaSaturations[2] = {0, 0};

// v2 record: zero[4] (counts), gain, hasZero, hasGain.
constexpr size_t CAL_RECORD_V2 = INA_PROFILE_COUNT + 3;
const char* calibrationKeyV2(int i) { return i ? "calB-v2" : "calA-v2"; }

void loadCalibration() {
  if (!calibrationStore.begin("ina-cal-v1", false)) return;
  for (int i = 0; i < 2; ++i) {
    float v2[CAL_RECORD_V2] = {0, 0, 0, 0, 1, 0, 0};
    if (calibrationStore.getBytesLength(calibrationKeyV2(i)) == sizeof(v2)) {
      calibrationStore.getBytes(calibrationKeyV2(i), v2, sizeof(v2));
    } else {
      // Migrate the single-profile v1 record (measured at 100 Hz) to every profile.
      // B's old record used the incorrect R100 conversion; recalibrate for R010.
      float v1[4] = {0, 1, 0, 0};
      if (calibrationStore.getBytesLength(i ? "recordB-r010" : "recordA") == sizeof(v1))
        calibrationStore.getBytes(i ? "recordB-r010" : "recordA", v1, sizeof(v1));
      for (int p = 0; p < INA_PROFILE_COUNT; ++p) v2[p] = v1[0];
      v2[4] = v1[1]; v2[5] = v1[2]; v2[6] = v1[3];
    }
    bool valid = isfinite(v2[4]) && v2[4] >= 0.8f / CSV_OUTPUT_SCALE[i] && v2[4] <= 1.2f;
    for (int p = 0; p < INA_PROFILE_COUNT; ++p) {
      valid = valid && isfinite(v2[p]) && fabsf(v2[p]) <= 40;
      calibrationZero[i][p] = v2[p];
    }
    calibrationGain[i] = v2[4];
    calibrationHasZero[i] = v2[5] == 1;
    calibrationHasGain[i] = v2[6] == 1;
    if (!valid) {
      for (int p = 0; p < INA_PROFILE_COUNT; ++p) calibrationZero[i][p] = 0;
      calibrationGain[i] = 1;
      calibrationHasZero[i] = calibrationHasGain[i] = false;
    }
  }
}

bool readCalibratedCurrent(uint8_t index, int16_t& raw, float& current) {
  uint16_t bits;
  if (!inaReadRegister16(index ? ADDR_INA_B : ADDR_INA_A, REG_SHUNT, bits)) {
    ++inaReadErrors[index]; return false;
  }
  raw = (int16_t)bits;
  if (raw >= 32760 || raw <= -32760) {
    ++inaSaturations[index]; return false;
  }
  // I = (raw - zero[profile]) * 2.5 uV / Rshunt * gain
  current = (raw - calibrationZero[index][inaActiveProfile[index]]) * SHUNT_VOLTAGE_LSB_V
      / (index ? RSHUNT_B_OHMS : RSHUNT_A_OHMS) * calibrationGain[index]
      * CSV_OUTPUT_SCALE[index];
  current *= rangeCorrection(index, current);
  current = filterCurrent(index, current);
  return true;
}

void IRAM_ATTR onAcqTimer(void* arg) {
  if (taskAcqHandle) {
    xTaskNotifyGive(taskAcqHandle);
  }
}

void taskAcq(void* parameter) {
  uint32_t lastPrintMs = 0;
  uint64_t observedStart = 0;
  uint32_t lastSnapshotA = 0, lastSnapshotB = 0;
  uint16_t lastDisplayedCanId = 0;
  float lastDisplayedCanCurrent = 0.0f;
  byte lastDisplayedCanData[4] = { 0 };
  bool lastDisplayedCanSendOk = false;
  bool hasCanSampleToDisplay = false;
  byte canPacket[8] = { 0 };

  for (;;) {
    // The timer wakes this task directly, including the first sample at t=0.
    const uint32_t nNotify = ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));
    if (!testRunning) {
      lastSnapshotA = acqCountA;
      lastSnapshotB = acqCountB;
      lastPrintMs = millis();
      continue;
    }

    if (observedStart != testStartMicros) {
      observedStart = testStartMicros;
      lastSnapshotA = 0;
      lastSnapshotB = 0;
      lastPrintMs = testStartMillis;
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

    if (nNotify == 0) {
      if (sensorRunningA) lostCountA = lostCountA + 1;
      if (sensorRunningB) lostCountB = lostCountB + 1;
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

    acquisitionBusy = true;
    if (acquireA) {
      acqCountA = acqCountA + 1;
      const uint64_t sampleMicros = esp_timer_get_time();
      const uint64_t intervalMicros = lastSampleMicrosA ? sampleMicros - lastSampleMicrosA : 0;
      lastSampleMicrosA = sampleMicros;
      const uint16_t sampleFrequencyA = intervalMicros
                                          ? (uint16_t)min((1000000ULL + intervalMicros / 2) / intervalMicros, 65535ULL)
                                          : (uint16_t)targetFrequencyA;
      int16_t rawA = 0;
      float IA = 0;
      if (readCalibratedCurrent(0, rawA, IA)) {
        latestCurrentA = IA;
        latestValidA = true;
        if (!digitalStreamMode && CAN_ZERO_CURRENT_TEST && rawA == 0) {
          IA = 42.0f + (((millis() - testStartMillis) / 1000UL) % 10UL) / 10.0f;
        }
        memset(canPacket, 0, 8);
        memcpy(&canPacket[0], &IA, sizeof(float));
        if (digitalStreamMode) memcpy(&canPacket[4], &sampleFrequencyA, sizeof(sampleFrequencyA));
        const bool sent = sendCanFrame(CAN_ID_CURRENT_A, digitalStreamMode ? 6 : 4, canPacket);
        if (!sent) lostCountA = lostCountA + 1;
        if (!digitalStreamMode) {
          lastDisplayedCanId = CAN_ID_CURRENT_A;
          lastDisplayedCanCurrent = IA;
          memcpy(lastDisplayedCanData, canPacket, sizeof(lastDisplayedCanData));
          lastDisplayedCanSendOk = sent;
          hasCanSampleToDisplay = true;
        }
      } else {
        latestValidA = false;
        ++lostCountA;
      }
    }

    if (acquireB) {
      acqCountB = acqCountB + 1;
      const uint64_t sampleMicros = esp_timer_get_time();
      const uint64_t intervalMicros = lastSampleMicrosB ? sampleMicros - lastSampleMicrosB : 0;
      lastSampleMicrosB = sampleMicros;
      const uint16_t sampleFrequencyB = intervalMicros
                                          ? (uint16_t)min((1000000ULL + intervalMicros / 2) / intervalMicros, 65535ULL)
                                          : (uint16_t)targetFrequencyB;
      int16_t rawB = 0;
      float IB = 0;
      if (readCalibratedCurrent(1, rawB, IB)) {
        latestCurrentB = IB;
        latestValidB = true;
        if (!digitalStreamMode && CAN_ZERO_CURRENT_TEST && rawB == 0) {
          IB = 42.0f + (((millis() - testStartMillis) / 1000UL) % 10UL) / 10.0f;
        }
        memset(canPacket, 0, 8);
        memcpy(&canPacket[0], &IB, sizeof(float));
        if (digitalStreamMode) memcpy(&canPacket[4], &sampleFrequencyB, sizeof(sampleFrequencyB));
        const bool sent = sendCanFrame(CAN_ID_CURRENT_B, digitalStreamMode ? 6 : 4, canPacket);
        if (!sent) lostCountB = lostCountB + 1;
        if (!digitalStreamMode) {
          lastDisplayedCanId = CAN_ID_CURRENT_B;
          lastDisplayedCanCurrent = IB;
          memcpy(lastDisplayedCanData, canPacket, sizeof(lastDisplayedCanData));
          lastDisplayedCanSendOk = sent;
          hasCanSampleToDisplay = true;
        }
      } else {
        latestValidB = false;
        ++lostCountB;
      }
    }

    acquisitionBusy = false;
    uint32_t nowMs = millis();
    if (nowMs - lastPrintMs >= 1000) {
      // Recover a bus-off controller using the selected physical crystal.
      // Missing an ACK never justifies changing the CAN bit timing.
      if (!digitalStreamMode && !recorderMirror && (canErrorFlags & 0x20)) initializeCan(canOscillatorMHz);
      if (sensorRunningA) freqReelleA = acqCountA - lastSnapshotA;
      if (sensorRunningB) freqReelleB = acqCountB - lastSnapshotB;
      lastSnapshotA = acqCountA;
      lastSnapshotB = acqCountB;
      lastPrintMs = nowMs;

      if (sensorRunningA) {
        uint16_t statsA[2] = { (uint16_t)freqReelleA, (uint16_t)lostCountA };
        memset(canPacket, 0, 8);
        memcpy(&canPacket[0], &statsA[0], 2);
        memcpy(&canPacket[2], &statsA[1], 2);
        if (!sendCanFrame(CAN_ID_STATS_A, 4, canPacket)) lostCountA = lostCountA + 1;
      }

      if (sensorRunningB) {
        uint16_t statsB[2] = { (uint16_t)freqReelleB, (uint16_t)lostCountB };
        memset(canPacket, 0, 8);
        memcpy(&canPacket[0], &statsB[0], 2);
        memcpy(&canPacket[2], &statsB[1], 2);
        if (!sendCanFrame(CAN_ID_STATS_B, 4, canPacket)) lostCountB = lostCountB + 1;
      }

      // Envoi du timestamp calculé à partir de la valeur initiale reçue du PC
      uint32_t calcul_ts = pcBaseTimestamp + ((nowMs - testStartMillis) / 1000UL);
      memset(canPacket, 0, 8);
      memcpy(&canPacket[0], &calcul_ts, 4);
      sendCanFrame(CAN_ID_TIME_SYNC, 4, canPacket);
      if (!digitalStreamMode) {
        if (hasCanSampleToDisplay) {
          Serial.printf(
            "[CAN TX] ID=0x%03X DLC=4 DATA=%02X %02X %02X %02X courant=%.1f A statut=%s | OK=%lu erreurs=%lu flags=0x%02X TXerr=%u\n",
            (unsigned)lastDisplayedCanId,
            lastDisplayedCanData[0],
            lastDisplayedCanData[1],
            lastDisplayedCanData[2],
            lastDisplayedCanData[3],
            lastDisplayedCanCurrent,
            lastDisplayedCanSendOk ? "OK" : "ECHEC",
            (unsigned long)canTxOk,
            (unsigned long)canTxErrors,
            (unsigned)canErrorFlags,
            (unsigned)canTxErrorCount);
          hasCanSampleToDisplay = false;
        } else {
          Serial.println("[CAN TX] Aucune trame courant a afficher pendant cette seconde.");
        }
      }
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
      <label><input type="checkbox" name="activeB" value="1" checked style="width:auto"> Capteur B (Sortie - 0x44)</label>
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
    pcBaseTimestamp = 1781582267;  // Fallback par défaut juin 2026
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
  sensorStoppedA = false;
  sensorStoppedB = false;

  xSemaphoreTake(i2cMutex, portMAX_DELAY);
  Wire.setClock(400000);
  xSemaphoreGive(i2cMutex);

  if ((currentCfg.activeA && !configureINA226(ADDR_INA_A, targetFreq))
      || (currentCfg.activeB && !configureINA226(ADDR_INA_B, targetFreq))) {
    sensorRunningA = sensorRunningB = false;
    server.send(503, "text/plain", "INA configuration/readback failed"); return;
  }

  acqCountA = 0;
  lostCountA = 0;
  acqCountB = 0;
  lostCountB = 0;

  // Envoi forcé immédiat du paquet temporel de milliseconde 0 avant les signaux INA
  byte canPacketTime[8] = { 0 };
  memcpy(&canPacketTime[0], (const void*)&pcBaseTimestamp, 4);
  sendCanFrame(CAN_ID_TIME_SYNC, 4, canPacketTime);

  uint64_t period_us = 1000000ULL / targetFreq;
  testStartMillis = millis();
  xSemaphoreTake(i2cMutex, portMAX_DELAY);
  testRunning = true;
  xSemaphoreGive(i2cMutex);
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
  json += ",\"recorder_mirror_supported\":true";
  json += ",\"recorder_mirror\":" + jsonBool(recorderMirror);
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

// ---------------------------------------------------------------------------
// Offset (zero) and gain calibration. Allowed only while idle. Never automatic:
// a real DC current must never be mistaken for sensor offset, so the firmware
// does not auto-tare at boot nor track the zero during acquisitions.
//
// Robust zero estimator, per conversion profile p (raw values x_k in ADC counts):
//   median m, MAD = median|x_k - m|, sigma_r = 1.4826 * MAD   (Gaussian-consistent)
//   keep |x_k - m| <= 4 * sigma_r                              (spike rejection)
//   zero_p = mean of kept samples                              (sub-LSB, noise acts as dither)
//   SE = max(sigma_kept / sqrt(N_kept), sd(8 block means) / sqrt(8))
//        (block term catches correlated noise, e.g. mains pickup)
//   drift = least-squares slope * (N - 1), must stay below max(2, 3 * sigma*sqrt(12/N)) counts
// Applied current: I = (raw - zero_p) * 2.5 uV / Rshunt * gain
// ---------------------------------------------------------------------------
constexpr int CAL_MAX_SAMPLES = 2000;
constexpr int CAL_BLOCKS = 8;
constexpr int CAL_SAMPLES[INA_PROFILE_COUNT] = {1200, 1500, 2000, 2000};
// delay(n) waits at least n-1 ms: each period exceeds the worst-case conversion
// time (9.312 / 2.328 / 0.647 / 0.224 ms). Total capture is about 28 s.
constexpr uint32_t CAL_PERIOD_MS[INA_PROFILE_COUNT] = {11, 4, 2, 2};
constexpr double CAL_MAX_OUTLIER_FRACTION = 0.05;
constexpr double CAL_ZERO_MAX_SE_COUNTS = 1.0;      // 0.25 mA on R010, profile 0 (100 Hz)
constexpr double CAL_FAST_ZERO_MAX_SE_COUNTS = 2.0; // faster profiles, else inherit profile 0
int16_t calSamples[CAL_MAX_SAMPLES];  // time order
int16_t calSorted[CAL_MAX_SAMPLES];   // sorted copy for the median
uint16_t calDeviations[CAL_MAX_SAMPLES];
String lastCalibrationReport[2] = {"null", "null"};

struct CalCapture {
  int n = 0, kept = 0, outliers = 0;
  double estimate = 0, mean = 0, stdKept = 0, median = 0, sigmaRobust = 0;
  double se = 0, drift = 0, driftLimit = 0, blockSpread = 0;
};

// Returns 0 on success, otherwise an HTTP status; `error` explains why.
int captureRobust(uint8_t i, uint8_t profile, CalCapture& c, const char*& error) {
  const uint8_t addr = i ? ADDR_INA_B : ADDR_INA_A;
  if (!configureINA226(addr, INA_PROFILE_FREQ[profile])) { error = "INA configuration failed."; return 503; }
  const int n = CAL_SAMPLES[profile];
  double rawSum = 0;
  for (int k = 0; k < n; ++k) {
    delay(CAL_PERIOD_MS[profile]); // Each observation is a distinct conversion.
    uint16_t bits;
    if (!inaReadRegister16(addr, REG_SHUNT, bits)) { ++inaReadErrors[i]; error = "I2C failure."; return 503; }
    const int16_t raw = (int16_t)bits;
    if (raw >= 32760 || raw <= -32760) { ++inaSaturations[i]; error = "ADC saturated."; return 422; }
    calSamples[k] = raw;
    rawSum += raw;
  }
  c.n = n; c.mean = rawSum / n;

  // Median / MAD robust scale on a sorted copy (calSamples keeps time order).
  memcpy(calSorted, calSamples, n * sizeof(int16_t));
  std::sort(calSorted, calSorted + n);
  c.median = (n % 2) ? calSorted[n / 2] : 0.5 * (calSorted[n / 2 - 1] + calSorted[n / 2]);
  for (int k = 0; k < n; ++k) calDeviations[k] = (uint16_t)fmin(65535.0, fabs(calSorted[k] - c.median));
  std::sort(calDeviations, calDeviations + n);
  const double mad = (n % 2) ? calDeviations[n / 2] : 0.5 * (calDeviations[n / 2 - 1] + calDeviations[n / 2]);
  c.sigmaRobust = fmax(1.4826 * mad, 1.0); // Floor at 1 count: quantisation alone is ~0.29.
  const double clip = 4 * c.sigmaRobust;

  // Single time-ordered pass over the kept samples: clipped mean/variance,
  // least-squares drift and block means (all immune to the rejected spikes).
  double kMeanClip = 0, kM2 = 0, sk = 0, skk = 0, sx = 0, skx = 0;
  double blockSums[CAL_BLOCKS] = {};
  int blockCounts[CAL_BLOCKS] = {};
  int kept = 0;
  for (int k = 0; k < n; ++k) {
    const double x = calSamples[k];
    if (fabs(x - c.median) > clip) continue;
    ++kept;
    const double d = x - kMeanClip;
    kMeanClip += d / kept;
    kM2 += d * (x - kMeanClip);
    sk += k; skk += (double)k * k; sx += x; skx += k * x;
    const int b = (int)((int64_t)k * CAL_BLOCKS / n);
    blockSums[b] += x; ++blockCounts[b];
  }
  c.kept = kept; c.outliers = n - kept;
  c.estimate = kMeanClip;
  c.stdKept = kept > 1 ? sqrt(kM2 / (kept - 1)) : 0;
  const double sxxK = kept * skk - sk * sk;
  c.drift = sxxK > 0 ? (kept * skx - sk * sx) / sxxK * (n - 1) : 0;
  c.driftLimit = fmax(2.0, 3 * c.stdKept * sqrt(12.0 / (kept > 0 ? kept : 1)));

  // Correlated-noise aware standard error from block means.
  double bMean = 0, bM2 = 0, bMin = 1e9, bMax = -1e9;
  int blocks = 0;
  for (int b = 0; b < CAL_BLOCKS; ++b) {
    if (!blockCounts[b]) continue;
    const double m = blockSums[b] / blockCounts[b];
    ++blocks;
    const double d = m - bMean;
    bMean += d / blocks;
    bM2 += d * (m - bMean);
    bMin = fmin(bMin, m); bMax = fmax(bMax, m);
  }
  c.blockSpread = blocks ? bMax - bMin : 0;
  const double blockSe = blocks > 1 ? sqrt(bM2 / (blocks - 1)) / sqrt((double)blocks) : 0;
  c.se = fmax(c.stdKept / sqrt((double)(kept > 0 ? kept : 1)), blockSe);

  Serial.printf("[CAL %c P%u] N=%d zero=%.3f counts median=%.1f sigma=%.2f robust=%.2f SE=%.3f drift=%.2f/%.2f outliers=%d\n",
                i ? 'B' : 'A', profile, n, c.estimate, c.median, c.stdKept, c.sigmaRobust,
                c.se, c.drift, c.driftLimit, c.outliers);
  if (kept < 2 || c.outliers > n * CAL_MAX_OUTLIER_FRACTION) { error = "Too many spikes (>5 %): check wiring/EMI."; return 422; }
  if (fabs(c.drift) > c.driftLimit) { error = "Zero drifts during capture: wait for thermal stability."; return 422; }
  return 0;
}

String captureJson(const CalCapture& c, double step) {
  String json = "{\"zero_raw\":" + String(c.estimate, 4);
  json += ",\"zero_mA\":" + String(c.estimate * step * 1000, 4);
  json += ",\"se_mA\":" + String(c.se * step * 1000, 4);
  json += ",\"std_mA\":" + String(c.stdKept * step * 1000, 3);
  json += ",\"robust_sigma_mA\":" + String(c.sigmaRobust * step * 1000, 3);
  json += ",\"drift_mA\":" + String(c.drift * step * 1000, 4);
  json += ",\"block_spread_mA\":" + String(c.blockSpread * step * 1000, 4);
  json += ",\"samples\":" + String(c.n) + ",\"outliers\":" + String(c.outliers) + "}";
  return json;
}

void handleCalibrationStatus() {
  String json = "{\"firmware\":\"" + String(FIRMWARE_VERSION) + "\",\"channels\":[";
  for (int i = 0; i < 2; ++i) {
    if (i) json += ",";
    const double step = SHUNT_VOLTAGE_LSB_V / (i ? RSHUNT_B_OHMS : RSHUNT_A_OHMS);
    json += "{\"channel\":\"" + String(i ? "B" : "A") + "\",\"zero_raw\":";
    json += String(calibrationZero[i][0], 6); // 100 Hz profile, kept for compatibility.
    json += ",\"zero_profiles\":[";
    for (int p = 0; p < INA_PROFILE_COUNT; ++p) {
      if (p) json += ",";
      json += "{\"max_hz\":" + String(p == 3 ? 0 : INA_PROFILE_FREQ[p]);
      json += ",\"zero_raw\":" + String(calibrationZero[i][p], 4);
      json += ",\"zero_mA\":" + String(calibrationZero[i][p] * step * 1000, 4) + "}";
    }
    json += "],\"active_profile\":" + String(inaActiveProfile[i]);
    json += ",\"gain\":" + String(calibrationGain[i], 8);
    json += ",\"csv_output_scale\":" + String(CSV_OUTPUT_SCALE[i], 8);
    json += ",\"effective_gain\":" + String(calibrationGain[i] * CSV_OUTPUT_SCALE[i], 8);
    json += ",\"filter_enabled\":" + jsonBool(CURRENT_FILTER_ENABLED);
    json += ",\"filter_average_ms\":" + String(CURRENT_AVERAGE_MS);
    json += ",\"zero_calibrated\":" + jsonBool(calibrationHasZero[i]);
    json += ",\"gain_calibrated\":" + jsonBool(calibrationHasGain[i]);
    json += ",\"i2c_errors\":" + String(inaReadErrors[i]);
    json += ",\"saturations\":" + String(inaSaturations[i]);
    json += ",\"last_calibration\":" + lastCalibrationReport[i] + "}";
  }
  server.send(200, "application/json", json + "]}");
}

void handleCalibration() {
  if (testRunning || acquisitionBusy || streamEndPending) {
    sendAcquisitionError(423, "Stop acquisition and wait for stream completion first."); return;
  }
  const String channel = server.arg("channel");
  const String action = server.arg("action");
  if ((channel != "A" && channel != "B")
      || (action != "zero" && action != "reference" && action != "reset")) {
    sendAcquisitionError(400, "Use channel=A|B and action=zero|reference|reset."); return;
  }
  const int i = channel == "B" ? 1 : 0;
  const uint8_t addr = i ? ADDR_INA_B : ADDR_INA_A;
  const double step = SHUNT_VOLTAGE_LSB_V / (i ? RSHUNT_B_OHMS : RSHUNT_A_OHMS);
  double reference = 0;
  if (action == "reference") {
    const String input = server.arg("reference_A");
    char* end = nullptr;
    reference = strtod(input.c_str(), &end);
    const double limit = 7.5;
    if (input.isEmpty() || end == input.c_str() || *end != '\0'
        || !isfinite(reference) || fabs(reference) < 0.05 || fabs(reference) > limit
        || !calibrationHasZero[i]) {
      sendAcquisitionError(400, "Zero first; reference_A must be signed amperes, 0.05..7.5 A (R010)."); return;
    }
  }

  float zero[INA_PROFILE_COUNT];
  for (int p = 0; p < INA_PROFILE_COUNT; ++p) zero[p] = calibrationZero[i][p];
  float gain = calibrationGain[i];
  bool hasZero = calibrationHasZero[i], hasGain = calibrationHasGain[i];
  String report = "null";

  if (action == "zero") {
    // Profile 0 (<=100 Hz) is mandatory; the others fall back to it if their own
    // capture is not trustworthy (their offset difference is below that noise).
    String profiles = "[";
    for (int p = 0; p < INA_PROFILE_COUNT; ++p) {
      CalCapture c;
      const char* error = "";
      const int status = captureRobust(i, p, c, error);
      bool ok = status == 0;
      if (ok && fabs(c.estimate) > 40) { ok = false; error = "Zero beyond +/-40 counts: remove current / check montage."; }
      const double maxSe = p == 0 ? CAL_ZERO_MAX_SE_COUNTS : CAL_FAST_ZERO_MAX_SE_COUNTS;
      if (ok && c.se > maxSe) { ok = false; error = "Mean too uncertain (noise): reduce EMI or average longer."; }
      if (p == 0 && !ok) {
        configureINA226(addr, 100);
        String body = "{\"message\":\"" + String(error) + " Calibration unchanged.\",\"profile_100Hz\":";
        body += (status == 503 || c.n == 0) ? "null" : captureJson(c, step);
        server.send(status ? status : 422, "application/json", body + "}");
        return;
      }
      zero[p] = ok ? c.estimate : zero[0];
      if (p) profiles += ",";
      profiles += "{\"max_hz\":" + String(p == 3 ? 0 : INA_PROFILE_FREQ[p]);
      profiles += ",\"source\":\"" + String(ok ? "measured" : "inherited_from_100Hz") + "\"";
      if (!ok) profiles += ",\"reason\":\"" + String(error) + "\"";
      profiles += ",\"capture\":" + (c.n ? captureJson(c, step) : String("null")) + "}";
    }
    report = "{\"action\":\"zero\",\"profiles\":" + profiles + "]}";
    gain = 1; hasZero = true; hasGain = false; // A new zero invalidates the old gain reference.
  } else if (action == "reference") {
    CalCapture c;
    const char* error = "";
    const int status = captureRobust(i, 0, c, error);
    const double maxSe = fmax(CAL_ZERO_MAX_SE_COUNTS, fabs(reference) * 0.001 / step); // 0.1 % of reading
    if (status == 0 && c.se > maxSe) error = "Mean too uncertain (noise): reduce EMI or average longer.";
    if (status != 0 || c.se > maxSe) {
      String body = "{\"message\":\"" + String(error) + " Calibration unchanged.\",\"capture\":";
      body += c.n ? captureJson(c, step) : String("null");
      server.send(status ? status : 422, "application/json", body + "}");
      return;
    }
    // Replace the gain using unfiltered ADC capture, including the CSV scale
    // in the denominator so a later reference does not double-correct it.
    double measured = (c.estimate - zero[0]) * step * CSV_OUTPUT_SCALE[i];
    measured *= rangeCorrection(i, (float)measured); // Same chain as readCalibratedCurrent.
    const double proposed = reference / measured;
    if (!isfinite(proposed) || proposed * CSV_OUTPUT_SCALE[i] < 0.8
        || proposed * CSV_OUTPUT_SCALE[i] > 1.2) {
      sendAcquisitionError(422, "Gain outside 0.8..1.2: investigate readings/shunt before calibration."); return;
    }
    gain = proposed; hasGain = true;
    report = "{\"action\":\"reference\",\"reference_A\":" + String(reference, 6)
           + ",\"measured_A\":" + String(measured, 6) + ",\"gain\":" + String(gain, 8)
           + ",\"capture\":" + captureJson(c, step) + "}";
  } else {
    for (int p = 0; p < INA_PROFILE_COUNT; ++p) zero[p] = 0;
    gain = 1; hasZero = hasGain = false;
    report = "{\"action\":\"reset\"}";
  }
  if (action != "reset") configureINA226(addr, 100);

  // One versioned blob commits a complete calibration atomically.
  float record[CAL_RECORD_V2];
  for (int p = 0; p < INA_PROFILE_COUNT; ++p) record[p] = zero[p];
  record[4] = gain; record[5] = hasZero ? 1.0f : 0.0f; record[6] = hasGain ? 1.0f : 0.0f;
  if (calibrationStore.putBytes(calibrationKeyV2(i), record, sizeof(record)) != sizeof(record)) {
    sendAcquisitionError(500, "Calibration could not be saved."); return;
  }
  for (int p = 0; p < INA_PROFILE_COUNT; ++p) calibrationZero[i][p] = zero[p];
  calibrationGain[i] = gain;
  calibrationHasZero[i] = hasZero;
  calibrationHasGain[i] = hasGain;
  lastCalibrationReport[i] = report;
  latestValidA = latestValidB = false;
  handleCalibrationStatus();
}

void handleApiStartAcquisition() {
  if (testRunning) {
    sendAcquisitionError(423, "Un test est deja actif sur ce canal. Attendez la fin avant d'en lancer un autre.");
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
  recorderMirror = server.arg("recorder_mirror").toInt() == 1;
  Serial.printf(
    "[ACQ] Mode demande: %s%s\n",
    digitalStreamMode ? "numerique Wi-Fi" : "CAN",
    digitalStreamMode ? " (aucune trame CAN ne sera emise)" : "");
  if (!digitalStreamMode && CAN_ZERO_CURRENT_TEST) {
    Serial.println("[CAN TEST] Mesure INA brute nulle: envoi de 42.0 a 42.9 A, puis repetition.");
  }

  // Le POST HTTP peut arriver juste après l'ouverture du socket TCP, avant
  // l'itération suivante de taskWeb. Accepter immédiatement ce client évite
  // de refuser à tort le démarrage de la mesure numérique.
  if ((digitalStreamMode || recorderMirror) && !streamConnected && streamServer.hasClient()) {
    WiFiClient incoming = streamServer.accept();
    xSemaphoreTake(streamClientMutex, portMAX_DELAY);
    if (streamClient) streamClient.stop();
    streamClient = incoming;
    streamClient.setNoDelay(true);
    streamConnected = true;
    xSemaphoreGive(streamClientMutex);
  }

  // En mode CAN, le MCP2515 est obligatoire. En mode numérique, les mesures
  // INA226 partent uniquement sur le flux Wi-Fi direct vers l'application.
  if (!digitalStreamMode && !recorderMirror) {
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
      "l'alimentation et le quartz du module.");
    return;
  }
  if ((digitalStreamMode || recorderMirror) && !streamConnected) {
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
  pcBaseTimestampUs = server.hasArg("timestamp_us") ? strtoull(server.arg("timestamp_us").c_str(), nullptr, 10) : (uint64_t)pcBaseTimestamp * 1000000ULL;
  if (pcBaseTimestampUs < 1000000000000000ULL) {
    sendAcquisitionError(400, "Horloge PC non synchronisee.");
    return;
  }
  streamEndPending = false;
  latestValidA = false;
  latestValidB = false;
  lastSampleMicrosA = 0;
  lastSampleMicrosB = 0;
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
  sensorStoppedA = false;
  sensorStoppedB = false;
  acqCountA = 0;
  lostCountA = 0;
  freqReelleA = 0;
  acqCountB = 0;
  lostCountB = 0;
  freqReelleB = 0;
  schedulerAccumulatorA = 0;
  schedulerAccumulatorB = 0;
  canTxOk = 0;
  canTxErrors = 0;
  canLastTxResult = CAN_OK;

  xSemaphoreTake(i2cMutex, portMAX_DELAY);
  Wire.setClock(400000);
  xSemaphoreGive(i2cMutex);
  if ((activeA && !configureINA226(ADDR_INA_A, frequencyA))
      || (activeB && !configureINA226(ADDR_INA_B, frequencyB))) {
    sensorRunningA = sensorRunningB = false;
    sendAcquisitionError(503, "INA configuration/readback failed"); return;
  }

  testStartMillis = millis();
  testStartMicros = esp_timer_get_time();
  byte timePacket[4] = { 0 };
  memcpy(timePacket, (const void*)&pcBaseTimestamp, sizeof(pcBaseTimestamp));
  bool transportReady = sendCanFrame(CAN_ID_TIME_SYNC, sizeof(timePacket), timePacket);
  if (!digitalStreamMode) {
    Serial.printf(
      "[CAN] Demarrage mesure: canal A=%s (%lu Hz), canal B=%s (%lu Hz), premier envoi=%s\n",
      activeA ? "ON" : "OFF",
      (unsigned long)frequencyA,
      activeB ? "ON" : "OFF",
      (unsigned long)frequencyB,
      transportReady ? "OK" : "ECHEC");
  }
  // A CAN listener may start after acquisition. A missing first ACK must not
  // cancel all future samples or silently change an 8 MHz crystal to 16 MHz.
  if (digitalStreamMode && !transportReady) {
    sendAcquisitionError(
      503,
      "L'application ne recoit pas le flux numerique Wi-Fi.");
    return;
  }

  // Start each active channel at t=0, then keep its own timer-driven cadence.
  schedulerAccumulatorA = activeA ? timerFrequency - frequencyA : 0;
  schedulerAccumulatorB = activeB ? timerFrequency - frequencyB : 0;
  oledScreenState = digitalStreamMode ? OLED_DIGITAL_RUNNING : OLED_MEASUREMENT_RUNNING;
  xSemaphoreTake(displayStateMutex, portMAX_DELAY);
  tftStage = TFT_ACQUISITION;
  xSemaphoreGive(displayStateMutex);
  if (taskOledHandle) xTaskNotifyGive(taskOledHandle);
  testRunning = true;
  esp_err_t timerStatus = esp_timer_start_periodic(acqTimer, 1000000ULL / timerFrequency);
  if (timerStatus != ESP_OK) {
    stopAcquisition(false);
    sendAcquisitionError(500, "Le timer d'acquisition n'a pas demarre.");
    return;
  }
  xTaskNotifyGive(taskAcqHandle);
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
  if (digitalStreamMode && !testRunning) oledScreenState = OLED_MEASUREMENT_FINISHED;
  sendAcquisitionStatus();
}

void handleApiDisplay() {
  String requestedState = server.arg("state");
  requestedState.toLowerCase();
  OledScreenState requestedScreen;
  TftStage requestedTft;
  if (requestedState == "welcome" || requestedState == "method_selection") {
    requestedScreen = OLED_WELCOME;
    requestedTft = TFT_METHOD;
  } else if (requestedState == "project_welcome") {
    requestedScreen = OLED_WELCOME;
    requestedTft = TFT_PROJECT;
  } else if (requestedState == "digital_selected") {
    requestedScreen = OLED_DIGITAL_SELECTED;
    requestedTft = TFT_DIGITAL_SELECTED;
  } else if (requestedState == "can_selected") {
    requestedScreen = OLED_CAN_SELECTED;
    requestedTft = TFT_CAN_SELECTED;
  } else if (requestedState == "digital_ready") {
    requestedScreen = OLED_DIGITAL_SELECTED;
    requestedTft = TFT_DIGITAL_READY;
  } else if (requestedState == "can_ready") {
    requestedScreen = OLED_CAN_SELECTED;
    requestedTft = TFT_CAN_READY;
  } else {
    server.send(400, "application/json", "{\"message\":\"Etat OLED invalide.\"}");
    return;
  }
  if (!testRunning) {
    xSemaphoreTake(displayStateMutex, portMAX_DELAY);
    tftStage = requestedTft;
    if (requestedTft == TFT_PROJECT) {
      strlcpy(displayPilot, server.arg("pilot").c_str(), sizeof(displayPilot));
      strlcpy(displayProject, server.arg("project").c_str(), sizeof(displayProject));
    }
    xSemaphoreGive(displayStateMutex);
    if (requestedTft == TFT_PROJECT) {
      if (displayPreferences.getString("pilot") != displayPilot) displayPreferences.putString("pilot", displayPilot);
      if (displayPreferences.getString("project") != displayProject) displayPreferences.putString("project", displayProject);
    }
    oledScreenState = requestedScreen;
    if (taskOledHandle) xTaskNotifyGive(taskOledHandle);
  }
  server.send(200, "application/json", testRunning
      ? "{\"status\":\"success\",\"applied\":false}"
      : "{\"status\":\"success\",\"applied\":true}");
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
  server.on("/api/display", HTTP_GET, handleApiDisplay);
  server.on("/api/calibration", HTTP_GET, handleCalibrationStatus);
  server.on("/api/calibration", HTTP_POST, handleCalibration);
  server.on("/api/acquisition/start", HTTP_POST, handleApiStartAcquisition);
  server.on("/api/acquisition/stop", HTTP_POST, handleApiStopAcquisition);
  server.on("/api/acquisition/status", HTTP_GET, []() {
    sendAcquisitionStatus();
  });
  server.begin();
  Serial.println("[HTTP] API de controle active sur le port 80.");
  streamServer.begin();
  streamServer.setNoDelay(true);
  for (;;) {
    // Traiter HTTP avant hasClient() : selon la version du cœur ESP32,
    // hasClient() peut attendre une nouvelle connexion TCP et affamer l'API.
    server.handleClient();
    if (streamServer.hasClient()) {
      WiFiClient incoming = streamServer.accept();
      xSemaphoreTake(streamClientMutex, portMAX_DELAY);
      if (testRunning && streamConnected && streamClient.connected()) {
        incoming.stop(); // A second PC must not steal the Pi's recording stream.
      } else {
        if (streamClient) streamClient.stop();
        streamClient = incoming;
        streamClient.setNoDelay(true);
        streamConnected = true;
      }
      xSemaphoreGive(streamClientMutex);
      Serial.println("[TCP] Application connectee au flux numerique sur le port 3333.");
    }
    vTaskDelay(pdMS_TO_TICKS(2));
  }
}

void fatalStartup(const char* message) {
  for (;;) {
    Serial.printf("[FATAL] %s\n", message);
    delay(2000);
  }
}

void setup() {
  Serial.begin(115200);
  const uint32_t serialStartedAt = millis();
  while (!Serial && millis() - serialStartedAt < 1500) delay(10);
  printFirmwareVersion();
  loadCalibration();
  Serial.println("\n[BOOT] Wattman ESP32-C3 Mini - INA A R010 / INA B R010");
  Serial.printf("[I2C] SDA=%u SCL=%u; A=0x%02X (0.010 ohm), B=0x%02X (0.010 ohm)\n", I2C_SDA, I2C_SCL, ADDR_INA_A, ADDR_INA_B);
  canMutex = xSemaphoreCreateMutex();
  displayStateMutex = xSemaphoreCreateMutex();
  if (!displayStateMutex) fatalStartup("Display mutex creation failed.");
  displayPreferences.begin("wattman-display", false);
  strlcpy(displayPilot, displayPreferences.getString("pilot").c_str(), sizeof(displayPilot));
  strlcpy(displayProject, displayPreferences.getString("project").c_str(), sizeof(displayProject));
  if (displayPilot[0] || displayProject[0]) tftStage = TFT_PROJECT;
  streamClientMutex = xSemaphoreCreateMutex();
  i2cMutex = xSemaphoreCreateMutex();
  streamQueue = xQueueCreate(2048, sizeof(StreamFrame));
  canTransmitQueue = xQueueCreate(64, sizeof(StreamFrame));
  if (!canTransmitQueue) fatalStartup("CAN queue creation failed.");
  if (!canMutex || !streamClientMutex || !i2cMutex || !streamQueue) fatalStartup("Resource allocation failed.");
  if (!Wire.begin(I2C_SDA, I2C_SCL)) fatalStartup("I2C initialization failed.");
  Wire.setClock(400000);
  Wire.setTimeOut(20);
  const uint8_t addresses[] = { ADDR_INA_A, ADDR_INA_B };
  for (uint8_t addr : addresses) {
    Wire.beginTransmission(addr);
    Serial.printf("[I2C] INA 0x%02X: %s\n", addr,
                  Wire.endTransmission() == 0 ? "detected" : "absent (check wiring)");
  }
  Serial.printf("[SPI] SCK=%u MISO=%u MOSI=%u CS=%u\n", SPI_SCK, SPI_MISO, SPI_MOSI, PIN_CS_CAN);
  // External MCP2515 initializes on demand; its absence cannot block Wi-Fi.
  pinMode(PIN_CS_CAN, OUTPUT);
  digitalWrite(PIN_CS_CAN, HIGH);
  pinMode(TFT_CS, OUTPUT);
  digitalWrite(TFT_CS, HIGH);
  SPI.begin(SPI_SCK, SPI_MISO, SPI_MOSI, PIN_CS_CAN);
  initializeMessageTft();
  esp_timer_create_args_t targs = {};
  targs.callback = &onAcqTimer;
  targs.dispatch_method = ESP_TIMER_TASK;
  targs.name = "timer_global";
  if (esp_timer_create(&targs, &acqTimer) != ESP_OK) fatalStartup("Timer creation failed.");
  while (!startAccessPoint()) delay(2000);
  if (xTaskCreate(taskAcq, "taskAcq", 4096, nullptr, 3, &taskAcqHandle) != pdPASS
      || xTaskCreate(taskCanTransmit, "taskCanTransmit", 4096, nullptr, 1, nullptr) != pdPASS
      || xTaskCreate(taskStream, "taskStream", 4096, nullptr, 4, nullptr) != pdPASS
      || xTaskCreate(taskWeb, "taskWeb", 8192, nullptr, 2, nullptr) != pdPASS
      || xTaskCreate(taskOled, "taskOled", 4096, nullptr, 1, &taskOledHandle) != pdPASS
      || xTaskCreate(taskTft, "taskTft", 6144, nullptr, 1, nullptr) != pdPASS) {
    fatalStartup("Task creation failed.");
  }
  Serial.println("[READY] HTTP port 80; TCP stream port 3333.");
}

void loop() {
  // Reprint identification when a monitor connects after startup.
  static bool serialWasConnected = false;
  const bool serialConnected = bool(Serial);
  if (serialConnected && !serialWasConnected) printFirmwareVersion();
  serialWasConnected = serialConnected;
  vTaskDelay(pdMS_TO_TICKS(100));
}
