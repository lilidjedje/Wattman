#include <SPI.h>
#include <mcp_can.h>
#include <string.h>

// Arduino Uno: SPI sur 11 (MOSI), 12 (MISO), 13 (SCK); CS sur 10.
constexpr uint8_t PIN_CS_CAN = 10;
// Choisir la frequence inscrite sur le quartz du module MCP2515.
constexpr uint8_t CAN_OSCILLATOR_MHZ = 8;
static_assert(CAN_OSCILLATOR_MHZ == 8 || CAN_OSCILLATOR_MHZ == 16,
              "Le quartz MCP2515 doit etre configure en 8 ou 16 MHz");
static_assert(sizeof(float) == 4, "Le decodage CAN attend des float 32 bits");

MCP_CAN CAN(PIN_CS_CAN);
bool canReady = false;
uint32_t receivedFrames = 0;
uint32_t lastWaitingMessageMillis = 0;
uint32_t lastDisplayMillis = 0;
unsigned long pendingId = 0;
byte pendingExtended = 0;
byte pendingLength = 0;
byte pendingData[8] = {};
bool pendingCurrentFrame = false;

uint16_t readUint16LE(const byte* data) {
    return (uint16_t)data[0] | ((uint16_t)data[1] << 8);
}

uint32_t readUint32LE(const byte* data) {
    return (uint32_t)data[0]
        | ((uint32_t)data[1] << 8)
        | ((uint32_t)data[2] << 16)
        | ((uint32_t)data[3] << 24);
}

void printData(const byte* data, byte length) {
    Serial.print(F(" DATA="));
    const byte bytesToPrint = length > 8 ? 8 : length;
    for (byte i = 0; i < bytesToPrint; ++i) {
        if (data[i] < 0x10) Serial.print('0');
        Serial.print(data[i], HEX);
        if (i + 1 < bytesToPrint) Serial.print(' ');
    }
}

void printFrame(unsigned long id, byte extended, byte length, const byte* data) {
    Serial.print(extended ? F("[EXT] ") : F("[STD] "));
    Serial.print(millis());
    Serial.print(F(" ms #"));
    Serial.print(receivedFrames);
    Serial.print(F(" ID=0x"));
    if (id < 0x100) Serial.print('0');
    if (id < 0x10) Serial.print('0');
    Serial.print(id, HEX);
    Serial.print(F(" DLC="));
    Serial.print(length);

    switch (id) {
        case 0x100:
        case 0x102: {
            Serial.print(id == 0x100 ? F(" COURANT_A=") : F(" COURANT_B="));
            if (length < 4) {
                Serial.print(F("DLC_INVALIDE"));
                break;
            }
            float currentAmps;
            memcpy(&currentAmps, data, sizeof(currentAmps));
            Serial.print(currentAmps, 6);
            Serial.print(F(" A ("));
            Serial.print(currentAmps * 1000.0f, 3);
            Serial.print(F(" mA)"));
            break;
        }

        case 0x101:
        case 0x103:
            Serial.print(id == 0x101 ? F(" STATS_A") : F(" STATS_B"));
            if (length < 4) {
                Serial.print(F(" DLC_INVALIDE"));
                break;
            }
            Serial.print(F(" frequence="));
            Serial.print(readUint16LE(data));
            Serial.print(F(" Hz pertes="));
            Serial.print(readUint16LE(data + 2));
            break;

        case 0x105:
            Serial.print(F(" HORODATAGE_UNIX="));
            if (length < 4) {
                Serial.print(F("DLC_INVALIDE"));
                break;
            }
            Serial.print(readUint32LE(data));
            Serial.print(F(" s"));
            break;

        default:
            Serial.print(F(" TRAME_NON_DECODEE"));
            break;
    }

    printData(data, length);
    Serial.println();
}

void setup() {
    // Meme debit que le programme de reception de reference.
    Serial.begin(115200);
    delay(500);

    Serial.println(F("\n[UNO] Recepteur CAN MCP2515"));
    Serial.println(F("[UNO] CAN: 500 kbit/s; moniteur serie: 115200 bauds"));
    Serial.println(F("[DECODAGE] 100=Courant A, 101=Stats A, 102=Courant B,"));
    Serial.println(F("[DECODAGE] 103=Stats B, 105=Horodatage Unix."));

    const byte clock = CAN_OSCILLATOR_MHZ == 16 ? MCP_16MHZ : MCP_8MHZ;
    if (CAN.begin(MCP_ANY, CAN_500KBPS, clock) != CAN_OK) {
        Serial.println(F("[ERREUR] Initialisation MCP2515 impossible."));
        Serial.println(F("[ERREUR] Verifier alimentation, masse, SPI, CS et quartz."));
        return;
    }

    if (CAN.setMode(MCP_NORMAL) != CAN_OK) {
        Serial.println(F("[ERREUR] Impossible de passer en mode CAN normal."));
        return;
    }

    canReady = true;
    lastWaitingMessageMillis = millis();
    lastDisplayMillis = lastWaitingMessageMillis;
    Serial.println(F("[OK] MCP2515 pret; attente des trames CAN..."));
}

void loop() {
    if (!canReady) {
        delay(1000);
        return;
    }

    // Lire toutes les trames disponibles, mais ne journaliser qu'un courant par seconde.
    for (uint8_t n = 0; n < 32 && CAN.checkReceive() == CAN_MSGAVAIL; ++n) {
        unsigned long rxId = 0;
        byte extended = 0;
        byte length = 0;
        byte data[8] = {};

        if (CAN.readMsgBuf(&rxId, &extended, &length, data) != CAN_OK) {
            Serial.println(F("[ERREUR] Lecture d'une trame CAN impossible."));
            continue;
        }

        ++receivedFrames;
        if ((rxId == 0x100 || rxId == 0x102) && length >= 4) {
            pendingId = rxId;
            pendingExtended = extended;
            pendingLength = length;
            memcpy(pendingData, data, sizeof(pendingData));
            pendingCurrentFrame = true;
        }
    }

    const uint32_t now = millis();
    if (pendingCurrentFrame && now - lastDisplayMillis >= 1000) {
        printFrame(pendingId, pendingExtended, pendingLength, pendingData);
        pendingCurrentFrame = false;
        lastDisplayMillis = now;
    }

    if (receivedFrames == 0 && now - lastWaitingMessageMillis >= 2000) {
        lastWaitingMessageMillis = now;
        Serial.print(F("[ATTENTE] Aucune trame recue; etat erreur MCP2515=0x"));
        Serial.println(CAN.getError(), HEX);
    }
}