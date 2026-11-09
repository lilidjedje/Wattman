# ESP32-C3 multi INA226

- INA A, adresse I2C `0x40` : shunt **R010 = 0,010 ohm**.
- INA B, adresse I2C `0x41` : shunt **R100 = 0,100 ohm**.
- Conversion : `I = valeur_signee * 2,5e-6 / Rshunt` (amperes).
- Le mode CAN de remplacement des zeros par 42 A est desactive.

## Compilation et televersement

Depuis PowerShell, executer `./upload.ps1`. Le script compile pour
`esp32:esp32:esp32c3:CDCOnBoot=cdc` et detecte le port USB Espressif.
Si plusieurs cartes sont connectees, preciser `./upload.ps1 -Port COM5`
(adapter le numero au Gestionnaire de peripheriques).

Dans Arduino IDE, choisir **ESP32C3 Dev Module**, **USB CDC On Boot: Enabled**
et le port du **Peripherique serie USB**, pas un lien serie Bluetooth.
Le 29 octobre 2026, l'ESP32 etait sur COM5 ; COM3 et COM4 etaient Bluetooth.
Le numero peut changer apres reconnexion.

L'erreur « Could not open COM4 » intervient avant l'ecriture du firmware.
Les pourcentages d'utilisation de flash et RAM ne signalent pas une erreur.
Si le port USB ne repond pas, fermer le moniteur serie, maintenir BOOT,
appuyer puis relacher RESET/EN, relacher BOOT et relancer le televersement.
Si Windows signale encore un peripherique defaillant, verifier le cable USB
de donnees, la connexion et le pilote ; une modification du .ino ne peut
pas reparer un port USB inaccessible.

## Cablage ESP32-C3 Mini / SuperMini

| Signal | GPIO |
| --- | --- |
| SDA des deux INA226 | 0 |
| SCL des deux INA226 | 1 |
| MCP2515 SCK | 4 |
| MCP2515 MISO | 5 |
| MCP2515 MOSI | 6 |
| MCP2515 CS | 7 |
| MCP2515 INT (reserve, non utilise) | 10 |

**Deplacer SDA de GPIO8 vers GPIO0 et SCL de GPIO9 vers GPIO1**, hors tension.
Les adresses et shunts restent A=0x40/R010 et B=0x41/R100.
GPIO2/8/9 restent libres pour le demarrage ; GPIO18/19 restent dedies a l'USB.
Les signaux I2C/SPI doivent etre compatibles 3,3 V, avec masse commune.
Cette configuration suppose une carte Mini avec USB natif et GPIO0/1 exposes.

Au demarrage, le moniteur USB a 115200 affiche le brochage, la detection
I2C de chaque INA et le message READY. Une carte sans INA/CAN doit quand
meme proposer le Wi-Fi ESP32C3-Mesure, cle ina226mesure, API 192.168.4.1.
La creation des ressources, du timer et des taches est maintenant verifiee.
L'attente du moniteur USB est limitee a 1,5 seconde.

SPI aligne sur le schema SuperMini fourni : SCK=4, MISO=5, MOSI=6, CS=7.
Deplacer MOSI de GPIO3 vers GPIO6 si le montage suivait la version precedente.
Les etiquettes SDA=8/SCL=9 du schema sont des valeurs par defaut ; ce firmware
configure explicitement SDA=0/SCL=1 pour liberer les broches de demarrage.
INA A : A0/A1 vers GND pour 0x40 ; INA B : A0 vers VS, A1 vers GND pour 0x41
(selon les ponts d'adresse du module). IN+/IN- restent sur le circuit mesure,
jamais sur les GPIO. Ne pas appliquer de signaux 5 V aux GPIO de l'ESP32.

## OLED SH1106 et acquisition numerique

Installer la bibliotheque U8g2 (olikraus). Ecran SH1106 128x64, adresse I2C
par defaut 0x3C : SDA -> GPIO20, SCL -> GPIO21, GND commun, alimentation
compatible 3,3 V. Les INA226 restent seuls sur Wire : SDA0 / SCL1.
Ne pas relier les lignes de donnees de ces deux bus.

Le SH1106 utilise un I2C logiciel separe, dans taskOled de priorite 1.
La tache INA226 est de priorite 3, le flux Wi-Fi de priorite 2. L'ecran
rafraichit les valeurs mesurees et les temps restants chaque seconde ; il ne
relit jamais les INA et n'envoie pas les echantillons a Excel. L'affichage ne
modifie donc pas la cadence des acquisitions. Wattman lui transmet les etats
de l'interface : message d'accueil, mode choisi et rappel CANalyzer. En mode
numerique, l'ecran indique les courants A/B et le compte a rebours de chaque
canal, puis « Mesure finie ». Televerser ce sketch pour activer ces messages.
OLED_SDA/OLED_SCL peuvent etre modifies a la compilation.

La synchronisation PC utilise timestamp_us (epoch Unix en microsecondes).
L'ESP32 horodate chaque trame depuis esp_timer_get_time, independamment
du reseau et de l'ecran. La trame finale 0x106, apres vidage de la file,
contient les nombres A/B generes pour verifier les pertes de transport.
L'ancien protocole timestamp en secondes reste accepte.

Les fichiers Excel sont crees sur le PC par un worker depuis la base SQLite,
pas par le microcontroleur. Chaque canal a ses fichiers Canal_A/B_000001.xlsx,
avec 999 mesures maximum et une ligne d'en-tete. Aucun courant n'est interpole.
Le dernier fichier, meme incomplet, est ferme a la fin ou a l'arret du flux.
manifest.json indique les comptages, horodatages et durees par canal,
ainsi que les pertes de transport constatees. Les colonnes de courant sont
numeriques en A ou mA ; les dates/heures et epochs conservent les microsecondes.
La frequence entre mesures est calculee sur les intervalles reels, pas imposee
artificiellement a la valeur demandee.

La compilation ne televerse pas le firmware. Verifier sur le montage reel
la cadence et les compteurs de pertes, avec OLED actif, avant une campagne.
