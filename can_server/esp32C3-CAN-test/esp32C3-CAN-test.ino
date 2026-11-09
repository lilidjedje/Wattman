#include <Arduino.h>
#include <SPI.h>
#include <mcp_can.h>

// Same SPI wiring as the main firmware. No Wi-Fi or INA226 required.
constexpr uint8_t PIN_CS_CAN = 7;
constexpr uint8_t SPI_SCK = 4;
constexpr uint8_t SPI_MISO = 5;
constexpr uint8_t SPI_MOSI = 3;
// Set this to the frequency PRINTED ON THE MCP2515 MODULE CRYSTAL.
// Loopback cannot determine whether the real crystal is 8 or 16 MHz.
constexpr uint8_t CAN_OSCILLATOR_MHZ = 8;
static_assert(CAN_OSCILLATOR_MHZ == 8 || CAN_OSCILLATOR_MHZ == 16,
              "Select an 8 or 16 MHz crystal");

MCP_CAN CAN(PIN_CS_CAN);
bool ready = false;
uint32_t sequence = 0;
uint32_t txOk = 0, txFailed = 0, rxCount = 0;
uint32_t lastSend = 0;

void printErrors() {
  const uint8_t flags = CAN.getError();
  Serial.printf(" EFLG=0x%02X TEC=%u REC=%u", flags,
                CAN.errorCountTX(), CAN.errorCountRX());
  if (flags & 0x20) Serial.print(" BUS-OFF");
  if (flags & 0x10) Serial.print(" TX-PASSIVE");
  if (flags & 0x08) Serial.print(" RX-PASSIVE");
  Serial.println();
}

bool testLoopback() {
  if (CAN.setMode(MCP_LOOPBACK) != CAN_OK) return false;
  byte expected[8] = {0x55, 0xAA, 0x00, 0xFF, 0x12, 0x34, 0x56, 0x78};
  if (CAN.sendMsgBuf(0x123, 0, 8, expected) != CAN_OK) return false;
  const uint32_t started = millis();
  while (CAN.checkReceive() != CAN_MSGAVAIL) {
    if (millis() - started >= 200) return false;
    delay(1);
  }
  unsigned long id = 0;
  byte length = 0, data[8] = {};
  if (CAN.readMsgBuf(&id, &length, data) != CAN_OK) return false;
  return id == 0x123 && length == 8 && memcmp(data, expected, 8) == 0;
}

void setup() {
  Serial.begin(115200);
  delay(2000);  // Give the USB serial monitor time to open; never wait forever.
  Serial.println("\n=== ESP32-C3 / MCP2515 : diagnostic CAN ===");
  Serial.printf("500 kbit/s, quartz configure : %u MHz\n", CAN_OSCILLATOR_MHZ);
  SPI.begin(SPI_SCK, SPI_MISO, SPI_MOSI, PIN_CS_CAN);
  const byte clock = CAN_OSCILLATOR_MHZ == 16 ? MCP_16MHZ : MCP_8MHZ;
  if (CAN.begin(MCP_ANY, CAN_500KBPS, clock) != CAN_OK) {
    Serial.println("[INIT ECHEC] Verifier alimentation, masse, SPI et CS.");
    return;
  }
  Serial.println("[INIT OK] Configuration MCP2515 acceptee.");
  if (!testLoopback()) {
    Serial.println("[LOOPBACK ECHEC] Trame interne incorrecte/absente : verifier module et SPI.");
    printErrors();
    return;
  }
  Serial.println("[LOOPBACK OK] SPI et trajet interne testes. Bus physique NON teste.");
  if (CAN.setMode(MCP_NORMAL) != CAN_OK) {
    Serial.println("[MODE ECHEC] Impossible de passer en mode normal.");
    return;
  }
  Serial.println("[BUS] Emission ID standard 0x123, DLC 8, toutes les 500 ms.");
  Serial.println("[BUS] Ouvrir CANalyzer en mode actif a 500 kbit/s pour acquitter.");
  Serial.println("[BUS] Envoyer aussi ID 0x321 depuis CANalyzer pour tester la reception.");
  ready = true;
}

void loop() {
  if (!ready) {
    delay(1000);
    return;
  }
  // Limit each iteration so a busy bus cannot starve periodic transmission.
  for (uint8_t n = 0; n < 16 && CAN.checkReceive() == CAN_MSGAVAIL; ++n) {
    unsigned long id = 0;
    byte length = 0, data[8] = {};
    if (CAN.readMsgBuf(&id, &length, data) == CAN_OK) {
      ++rxCount;
      Serial.printf("[RX] ID/flags=0x%08lX DLC=%u DATA=", id, length);
      for (uint8_t i = 0; i < length && i < 8; ++i) Serial.printf("%02X ", data[i]);
      Serial.println();
    }
  }
  if (millis() - lastSend >= 500) {
    lastSend = millis();
    // Little-endian counter then a fixed recognizable pattern.
    byte data[8] = {byte(sequence), byte(sequence >> 8), byte(sequence >> 16),
                    byte(sequence >> 24), 0x55, 0xAA, 0x12, 0x34};
    const byte result = CAN.sendMsgBuf(0x123, 0, 8, data);
    if (result == CAN_OK) ++txOk;
    else ++txFailed;
    Serial.printf("[TX %s] seq=%lu retour=%u OK=%lu ECHECS=%lu RX=%lu",
                  result == CAN_OK ? "OK" : "ECHEC",
                  (unsigned long)sequence++, result, (unsigned long)txOk,
                  (unsigned long)txFailed, (unsigned long)rxCount);
    printErrors();
    // Leave hardware retries active after a timeout. abortTX() in this
    // library leaves ABAT set and can make later sends falsely report OK.
    // Buffers may stay busy until the bus is repaired; RESET restarts the test.
  }
  delay(1);
}
