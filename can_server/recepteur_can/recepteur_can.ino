#include <SPI.h>
#include <mcp_can.h>

// Sur l'Uno, le CS est branché sur le Pin 10
const int SPI_CS_PIN = 10;
MCP_CAN CAN(SPI_CS_PIN);

void setup() {
    Serial.begin(115200);
    while (!Serial) { delay(10); }

    Serial.println("[UNO] Initialisation du sniffer CAN...");

    // Configuration identique à l'ESP32 : 500Kbps et Quartz 8MHz
    if (CAN.begin(MCP_ANY, CAN_500KBPS, MCP_8MHZ) == CAN_OK) {
        Serial.println("[UNO] MCP2515 initialisé avec SUCCÈS !");
        CAN.setMode(MCP_NORMAL); // Prêt à recevoir
    } else {
        Serial.println("[UNO] ❌ ÉCHEC critique de l'initialisation du MCP2515.");
        while (1) { delay(100); }
    }
}

void loop() {
    long unsigned int rxId;
    unsigned char len = 0;
    unsigned char rxBuf[8];

    // Vérifie si une trame est disponible
    if (CAN.checkReceive() == CAN_MSGAVAIL) {
        CAN.readMsgBuf(&rxId, &len, rxBuf); // Lit la trame
        
        Serial.print("📥 Trame reçue ! ID: 0x");
        Serial.print(rxId, HEX);
        Serial.print(" | DLC: ");
        Serial.print(len);
        Serial.print(" | Données: ");
        
        for (int i = 0; i < len; i++) {
            if (rxBuf[i] < 0x10) Serial.print("0");
            Serial.print(rxBuf[i], HEX);
            Serial.print(" ");
        }
        Serial.println();
    }
}