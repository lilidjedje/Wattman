#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include "esp_timer.h"

#define I2C_SDA      8
#define I2C_SCL      9

const char* WIFI_SSID = "courant_1";
const char* WIFI_PASS = "12345678";
const char* MASTER_IP = "192.168.4.1";

const uint16_t UDP_PORT_DATA  = 8889; // Données B
const uint16_t UDP_PORT_STATS = 8881; // Stats B
/******************************************************
 * STRUCTURES ET PORTS DE CONFIGURATION DYNAMIQUE
 ******************************************************/
struct ConfigPayload {
  uint32_t frequency;   // Fréquence demandée en Hz
  uint32_t duration;    // Durée demandée en secondes
  uint32_t startTrigger;// 1 = Start, 0 = Stop
};

WiFiUDP udpConfig;             // Objet UDP pour intercepter les ordres du Master
const uint16_t CONFIG_PORT = 9999; // Port d'écoute de la configuration (commun aux deux)

WiFiUDP udpData;
WiFiUDP udpStats;
esp_timer_handle_t acqTimer = nullptr;
TaskHandle_t taskCanHandle = nullptr; 

volatile uint32_t acqCount = 0;
volatile uint32_t lostCount = 0;
volatile uint32_t freqReelle = 0;

static const uint8_t INA226_ADDR = 0x40;
static const uint8_t REG_CONFIG  = 0x00;

bool inaWriteRegister16(uint8_t reg, uint16_t value) {
  Wire.beginTransmission(INA226_ADDR);
  Wire.write(reg);
  Wire.write((uint8_t)((value >> 8) & 0xFF));
  Wire.write((uint8_t)(value & 0xFF));
  return (Wire.endTransmission() == 0);
}

void configureINA226() {
  uint16_t config = (0b000 << 9) | (0b001 << 6) | (0b001 << 3) | 0b111;
  inaWriteRegister16(REG_CONFIG, config);
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

void IRAM_ATTR onAcqTimer(void* arg) {
  if (taskCanHandle) {
    xTaskNotifyGive(taskCanHandle);
  }
}

void taskAcq(void* parameter) {
  // 1. Initialisation initiale standard du bus I2C
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(400000); // 400 kHz par défaut pour les fréquences standards
  configureINA226(); 

  // Ouvrir le port UDP pour intercepter les ordres de configuration du Master
  udpConfig.begin(CONFIG_PORT);

  uint32_t lastPrintMs = 0;
  uint32_t lastAcqSnapshot = 0;
  
  uint32_t testDurationSec = 0;
  unsigned long testStartMillis = 0;
  bool testRunning = false;

  for (;;) {
    // ====================================================================
    // ÉTAPE 1 : RÉCEPTION ET RECONFIGURATION TECHNIQUE À LA VOLÉE
    // ====================================================================
    if (udpConfig.parsePacket() >= sizeof(ConfigPayload)) {
      ConfigPayload cfg;
      udpConfig.read((uint8_t*)&cfg, sizeof(cfg));
      
      if (cfg.startTrigger == 1) {
        // A. Ajustement matériel de la vitesse du bus I2C
        if (cfg.frequency >= 2000) {
          Wire.setClock(1000000); // Mode Fast Mode Plus (1 MHz) pour libérer du temps CPU
          Serial.println("[I2C] Mode ultra-rapide 1 MHz activé.");
        } else {
          Wire.setClock(400000);  // Retour au mode standard 400 kHz pour préserver la stabilité
        }

        // B. Modification de la période du timer matériel de l'ESP32
        uint64_t new_period_us = 1000000ULL / cfg.frequency;
        esp_timer_stop(acqTimer);
        esp_err_t err = esp_timer_start_periodic(acqTimer, new_period_us);
        
        if (err == ESP_OK) {
          Serial.printf("[CONFIG] Timer matériel ajusté sur : %u Hz\n", cfg.frequency);
        }

        // C. Ajustement des registres internes de l'INA226 (Élimination des goulots d'étranglement)
        uint16_t config_bits;
        
        if (cfg.frequency >= 2000) {
          // VITESSE MAXIMALE (2000 Hz et plus) :
          // - Mode : Shunt-Only (0b101) -> Évite de perdre du temps à mesurer la tension du bus
          // - Temps de conversion Shunt : 204 µs (0b001) -> Nécessaire pour tenir dans la fenêtre de 500µs
          // - Moyennage : Aucun (Averaging 1 -> 0b000)
          config_bits = (0b000 << 9) | (0b001 << 6) | (0b001 << 3) | 0b101;
          Serial.println("[INA226] Profil Haute Performance activé (Conversion: 204µs, Shunt-Only).");
        } else {
          // MODE STANDARD (100 Hz à 1000 Hz) :
          // - Mode : Shunt + Bus (0b111) -> Mesure complète du courant et de la tension
          // - Temps de conversion Shunt : 1.1 ms (0b100) ou ajusté selon ton besoin standard
          // - Moyennage : Aucun (0b000)
          config_bits = (0b000 << 9) | (0b100 << 6) | (0b100 << 3) | 0b111;
          Serial.println("[INA226] Profil Standard activé (Conversion: 1.1ms, Shunt+Bus).");
        }
        
        inaWriteRegister16(REG_CONFIG, config_bits);
        
        // D. Réinitialisation complète des compteurs de performance locaux
        acqCount = 0;
        lostCount = 0;
        lastAcqSnapshot = 0;
        
        testDurationSec = cfg.duration;
        testStartMillis = millis();
        testRunning = true;
        
        Serial.printf("[CONFIG] Session d'acquisition lancée pour %u secondes\n", cfg.duration);
      }
    }

    // Mise en attente de la tâche si aucun ordre de marche n'est actif
    if (!testRunning) {
      vTaskDelay(pdMS_TO_TICKS(10));
      continue;
    }

    // ====================================================================
    // ÉTAPE 2 : ATTENTE SYNCHRONE DU SIGNAL DU TIMER ET ANALYSE DES PERTES
    // ====================================================================
    uint32_t nNotify = ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));
    
    if (nNotify == 0) {
      // Le timer n'a pas réussi à réveiller la tâche (saturation Wi-Fi ou I2C)
      lostCount++;
      continue;
    }

    acqCount++;
    if (nNotify > 1) {
      // Si nNotify > 1, plusieurs interruptions ont eu lieu pendant que l'ESP32 était bloqué
      lostCount += (nNotify - 1); 
    }

    // ====================================================================
    // ÉTAPE 3 : LECTURE I2C ET ENVOI UDP DES DONNÉES EN TEMPS RÉEL
    // ====================================================================
    int16_t raw = readINA226ShuntRaw();
    float I = raw * 2.5e-6f / 0.1f; // Résolution Shunt : 2.5 µV / R_shunt : 0.1 Ohm

    udpData.beginPacket(MASTER_IP, UDP_PORT_DATA);
    udpData.write((uint8_t*)&I, sizeof(I));
    udpData.endPacket();

    // ====================================================================
    // ÉTAPE 4 : EXPÉDITION DES STATISTIQUES ISOLÉES (TOUTES LES 1000 MS)
    // ====================================================================
    uint32_t nowMs = millis();
    if (nowMs - lastPrintMs >= 1000) {
      freqReelle = acqCount - lastAcqSnapshot;
      lastAcqSnapshot = acqCount;
      lastPrintMs = nowMs;

      // Préparation du paquet de performance : [Fréquence Réelle, Pertes Locales]
      uint16_t statBuffer[2] = {(uint16_t)freqReelle, (uint16_t)lostCount};
      
      udpStats.beginPacket(MASTER_IP, UDP_PORT_STATS);
      udpStats.write((uint8_t*)statBuffer, sizeof(statBuffer));
      udpStats.endPacket();
    }

    // ====================================================================
    // ÉTAPE 5 : ARRÊT PROPRE ET FIN DE FENÊTRE DE SÉCURITÉ
    // ====================================================================
    if (millis() - testStartMillis >= testDurationSec * 1000UL) {
      testRunning = false;
      esp_timer_stop(acqTimer); // Désactivation immédiate de l'interruption pour libérer le CPU
      Serial.println("[ACQ] Fenêtre d'acquisition terminée. Repos matériel.");
    }
  }
}

void setup() {
  Serial.begin(115200);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(100); }

  esp_timer_create_args_t targs = {};
  targs.callback = &onAcqTimer;
  targs.dispatch_method = ESP_TIMER_TASK;
  targs.name = "acq_sat2";
  esp_timer_create(&targs, &acqTimer);
  esp_timer_start_periodic(acqTimer, 1000); 

  xTaskCreatePinnedToCore(taskAcq, "taskAcq", 4096, nullptr, 2, &taskCanHandle, 0);
}

void loop() { vTaskDelay(pdMS_TO_TICKS(1000)); }