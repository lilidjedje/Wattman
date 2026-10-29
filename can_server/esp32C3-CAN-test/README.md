# Test autonome ESP32-C3 / MCP2515

Ce sketch remplace temporairement le firmware de mesure. Il ne demande ni
Wi-Fi, ni application Wattman, ni INA226. Il teste une trame en boucle interne,
puis emet des trames CAN physiques a 500 kbit/s.

1. Installer la bibliotheque **MCP_CAN_lib de Cory J. Fowler**, comme pour le
   firmware principal, et selectionner la carte ESP32-C3 dans Arduino IDE.
2. Ouvrir `esp32C3-CAN-test.ino`. Regler `CAN_OSCILLATOR_MHZ` sur **8 ou 16**
   suivant le quartz du module MCP2515. Ce reglage ne peut pas etre deduit du
   test interne : un quartz mal configure peut reussir en loopback.
3. Conserver le cablage SPI : CS=GPIO7, SCK=GPIO4, MISO=GPIO5, MOSI=GPIO3.
   INT n'est pas utilise (lecture par interrogation).
4. Relier CAN-H, CAN-L et la masse commune a l'interface CANalyzer. Le module
   doit inclure un transceiver CAN alimente et actif. Respecter les niveaux
   logiques 3,3 V de l'ESP32-C3 sur SPI.
5. Verifier les terminaisons : **120 ohms a chaque extremite**, soit environ
   **60 ohms entre CAN-H et CAN-L, installation hors tension**. Une seule
   resistance 120 ohms ne remplace pas les deux terminaisons.
6. Configurer le bon canal CANalyzer en CAN classique, 500 kbit/s, mode actif
   (pas silencieux / listen-only), puis demarrer la mesure et ouvrir Trace.
7. Televerser le sketch et ouvrir le moniteur serie a **115200 bauds**.
   Appuyer sur RESET pour revoir les messages de demarrage.

Resultats attendus :

- `[INIT OK]`, puis `[LOOPBACK OK]` : communication avec le controleur et
  trajet CAN interne valides. Cela ne valide ni transceiver, ni cablage,
  ni debit physique correct.
- `[TX OK]` toutes les 500 ms et ID **0x123**, standard, DLC **8** dans
  CANalyzer : emission acquittee sur le bus. Les quatre premiers octets
  contiennent un compteur little-endian ; les suivants sont `55 AA 12 34`.
  Sur un bus avec plusieurs participants, l'ACK peut venir d'un autre noeud.
- Envoyer une trame standard **0x321** depuis le panneau d'emission de
  CANalyzer : elle doit apparaitre en `[RX]` sur le moniteur serie. Cela
  teste aussi le sens CANalyzer vers ESP32.
- `[INIT ECHEC]` ou `[LOOPBACK ECHEC]` : examiner alimentation, SPI, CS et
  module avant de chercher du cote du bus externe.
- Loopback OK mais TX en echec : examiner quartz reel, canal et mode actif
  CANalyzer, transceiver, masse commune, CAN-H/CAN-L et terminaisons. Ce
  resultat seul ne permet pas d'attribuer l'echec uniquement a un ACK absent.
  `TEC`/`REC` sont les compteurs d'erreurs ; `EFLG` affiche les indicateurs,
  dont BUS-OFF. Apres correction du cablage, appuyer sur RESET pour repartir
  d'un controleur reinitialise.

Apres le diagnostic, reteleverser le firmware principal pour retrouver le
Wi-Fi et les mesures dans l'application.

API utilisee : https://github.com/coryjfowler/MCP_CAN_lib
