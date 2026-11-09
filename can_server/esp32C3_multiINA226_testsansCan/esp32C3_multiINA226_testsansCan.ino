#include <WiFi.h>
#include <WiFiUdp.h>
#include <ArduinoJson.h>

// --- Configuration Wi-Fi (Mets tes identifiants qui marchent) ---
const char* WIFI_SSID = "Mon_Reseau_Pi";
const char* WIFI_PASS = "raspberry123";

// --- Ports UDP ---
const unsigned int localPort = 8888;      // Port d'écoute de l'ESP32
const unsigned int remotePort = 9999;     // Port d'écoute du Raspberry Pi
IPAddress raspberryIP(10, 42, 0, 1);      // IP par défaut du Raspberry Pi AP

WiFiUDP udp;
char packetBuffer[255]; // Buffer pour stocker le paquet reçu

// --- Variables d'acquisition ---
bool is_running = false;
uint32_t current_session_id = 0;
uint32_t target_frequency = 1000; 
uint32_t test_duration = 10;      
bool capteur_A_active = true;
bool capteur_B_active = true;

uint32_t timestamp_start_session = 0;
uint32_t last_send_time = 0;
uint32_t total_points_mesures = 0;

void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.println("\n[SYSTEM] Démarrage du firmware UDP...");

  // Connexion Wi-Fi
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.print("[WIFI] Connexion...");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\n[WIFI] 🎉 Connecté !");
  Serial.print("[WIFI] Mon IP : ");
  Serial.println(WiFi.localIP());

  // Démarrage du serveur UDP
  udp.begin(localPort);
  Serial.printf("[UDP] Écoute sur le port %d\n", localPort);
}

void loop() {
  // 1. Écoute des paquets UDP entrants (Ordres du Raspberry Pi)
  int packetSize = udp.parsePacket();
  if (packetSize) {
    int len = udp.read(packetBuffer, 255);
    if (len > 0) {
      packetBuffer[len] = 0;
    }
    
    // Analyse du JSON reçu
    DynamicJsonDocument doc(512);
    DeserializationError error = deserializeJson(doc, packetBuffer);

    if (!error) {
      bool server_running = doc["running"];
      if (server_running) {
        current_session_id = doc["session_id"];
        target_frequency = doc["frequency"];
        test_duration = doc["duration"];
        capteur_A_active = (doc["activeA"] == 1);
        capteur_B_active = (doc["activeB"] == 1);

        total_points_mesures = 0;
        timestamp_start_session = millis();
        is_running = true;

        Serial.printf("\n🚀 UDP START [Session #%d] Freq: %dHz\n", current_session_id, target_frequency);
      } else {
        is_running = false;
        Serial.println("\n🛑 UDP STOP demandé par le Pi.");
      }
    }
  }

  // 2. Envoi des données si l'acquisition est active
  if (is_running) {
    uint32_t temps_ecoule = (millis() - timestamp_start_session) / 1000;

    if (temps_ecoule >= test_duration) {
      is_running = false;
      Serial.printf("\n⌛ FIN DE TEMPS. Total points envoyés : %d\n", total_points_mesures);
      return;
    }

    // Calcul de l'intervalle selon la fréquence demandée (ex: 1000Hz = 1ms)
    uint32_t intervalle_ms = 1000 / target_frequency;
    if (millis() - last_send_time >= intervalle_ms) {
      last_send_time = millis();
      total_points_mesures++;

      // Simulation des capteurs
      float valA = capteur_A_active ? (1.25 + ((rand() % 100) / 500.0)) : 0.0;
      float valB = capteur_B_active ? (0.85 + ((rand() % 100) / 1000.0)) : 0.0;

      // Construction d'un message ultra-léger en texte brut (CSV) pour aller très vite
      // Format : session_id,temps_ms,valA,valB
      String dataPayload = String(current_session_id) + "," + 
                           String(millis() - timestamp_start_session) + "," + 
                           String(valA, 3) + "," + 
                           String(valB, 3);

      // Envoi direct en UDP vers l'IP du Raspberry Pi
      udp.beginPacket(raspberryIP, remotePort);
      udp.print(dataPayload);
      udp.endPacket();

      // Debug visuel toutes les 500ms pour ne pas saturer le moniteur série
      if (total_points_mesures % (target_frequency / 2) == 0) {
        Serial.printf("[UDP SEND] -> %s\n", dataPayload.c_str());
      }
    }
  }
}