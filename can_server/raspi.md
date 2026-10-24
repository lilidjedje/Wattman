=====================================================================
      MÉMO DES COMMANDES UTILISÉES POUR LE SERVEUR CAN FLASK
=====================================================================

1. NETTOYAGE DES ANCIENNES CONFIGURATIONS WI-FI
---------------------------------------------------------------------
# Supprimer les anciens profils Wi-Fi conflictuels
sudo nmcli connection delete Hotspot
sudo nmcli connection delete wifi-ap

# Débloquer la carte Wi-Fi si elle est verrouillée logiciellement
sudo rfkill unblock wifi
sudo nmcli radio wifi on


2. CONFIGURATION DU POINT D'ACCÈS WI-FI (AUTONOME & AUTOMATIQUE)
---------------------------------------------------------------------
# Créer le profil Wi-Fi "Mon_Reseau_Pi" en mode Point d'Accès (AP)
sudo nmcli connection add type wifi ifname wlan0 con-name "Hotspot" ssid "Mon_Reseau_Pi" mode ap wifi-sec.key-mgmt wpa-psk wifi-sec.psk "raspberry123"

# Définir l'adresse IP fixe du Raspberry Pi sur ce réseau (Passerelle)
sudo nmcli connection modify "Hotspot" ipv4.addresses 10.42.0.1/24 ipv4.method shared

# Forcer le Wi-Fi à s'activer SEUL au démarrage avec priorité maximale
sudo nmcli connection modify "Hotspot" connection.autoconnect yes connection.autoconnect-priority 100

# Démarrer le point d'accès immédiatement
sudo nmcli connection up "Hotspot"

# Vérifier le statut de la carte Wi-Fi (doit être vert / connected)
nmcli device status


3. PRÉPARATION DU CODE PYTHON & FLASK (SANS VENV)
---------------------------------------------------------------------
# Aller dans le dossier du projet
cd ~/can_server

# Autoriser Python à ouvrir le port standard 80 (sans être root)
sudo setcap 'cap_net_bind_service=+ep' /usr/bin/python3

# Lancer le serveur manuellement pour tester (avec l'option de bypass)
python3 app.py --break-system-packages


4. GESTION DU SERVICE DE DÉMARRAGE AUTOMATIQUE (SYSTEMD)
---------------------------------------------------------------------
# Emplacement du fichier de service : /etc/systemd/system/can_server.service
# Pour le modifier : sudo nano /etc/systemd/system/can_server.service

# Recharger la configuration du système après modification du service
sudo systemctl daemon-reload

# Activer le service pour qu'il se lance TOUT SEUL au démarrage du Pi
sudo systemctl enable can_server.service

# Démarrer / Arrêter / Redémarrer le serveur en tâche de fond
sudo systemctl start can_server.service
sudo systemctl stop can_server.service
sudo systemctl restart can_server.service

# Réinitialiser les compteurs d'erreurs si le service s'est bloqué
sudo systemctl reset-failed can_server.service


5. DIAGNOSTIC ET VÉRIFICATION DES ERREURS
---------------------------------------------------------------------
# Voir si le serveur tourne actuellement (statut vert "active (running)")
sudo systemctl status can_server.service

# Lire les dernières lignes de logs (les erreurs Python) si le script crash
sudo journalctl -u can_server.service -n 20 --no-pager


6. ACCÈS AU SERVEUR DEPUIS LE NAVIGATEUR (Une fois connecté au Wi-Fi)
---------------------------------------------------------------------
URL Directe : http://10.42.0.1
URL Locale  : http://can.local
=====================================================================


# Mémo Complet : Configuration du Raspberry Pi & Serveur CAN

Ce document regroupe toutes les commandes nécessaires pour connecter, transférer, configurer et automatiser votre serveur Web CAN sur le Raspberry Pi.

---

## 1. Connexion SSH & Transfert du Projet (Depuis le PC)

### A. Connexion en SSH
Ouvrez un terminal (**PowerShell** sur Windows ou **Terminal** sur Mac/Linux) et connectez-vous au Pi :
```bash
# Connexion via le nom d'hôte par défaut
ssh admin@raspberrypi.local

# Connexion via l'IP temporaire (si le câble est relié directement au PC)
ssh admin@192.168.137.10

# Connexion via l'IP du point d'accès (une fois le Wi-Fi configuré)
ssh admin@10.42.0.1

# Transférer le dossier complet vers le répertoire de l'utilisateur 'admin'
scp -r ./can_server admin@raspberrypi.local:/home/admin/


# Supprimer les anciens profils Wi-Fi défectueux
sudo nmcli connection delete Hotspot
sudo nmcli connection delete wifi-ap

# S'assurer que la carte Wi-Fi est bien activée et débloquée
sudo rfkill unblock wifi
sudo nmcli radio wifi on

# 1. Créer le profil Wi-Fi "Mon_Reseau_Pi" en mode Point d'Accès (AP)
sudo nmcli connection add type wifi ifname wlan0 con-name "Hotspot" ssid "Mon_Reseau_Pi" mode ap wifi-sec.key-mgmt wpa-psk wifi-sec.psk "raspberry123"

# 2. Définir l'adresse IP fixe du Raspberry Pi (Passerelle d'accès)
sudo nmcli connection modify "Hotspot" ipv4.addresses 10.42.0.1/24 ipv4.method shared

# 3. Forcer le Wi-Fi à s'activer SEUL au démarrage avec une priorité maximale
sudo nmcli connection modify "Hotspot" connection.autoconnect yes connection.autoconnect-priority 100

# 4. Allumer le point d'accès immédiatement
sudo nmcli connection up "Hotspot"

# 5. Vérifier que la carte wlan0 est bien en mode "connected (to hotspot)"
nmcli device status

# Aller dans le dossier du projet
cd ~/can_server

# Autoriser l'exécutable Python global à ouvrir le port standard 80
sudo setcap 'cap_net_bind_service=+ep' /usr/bin/python3

# Lancer manuellement le serveur pour test (avec l'option de bypass des packages système)
python3 app.py --break-system-packages

sudo nano /etc/systemd/system/can_server.service
[Unit]
Description=Serveur Web CAN Flask automatique
After=network.target network-online.target NetworkManager.service

[Service]
Type=simple
User=admin
WorkingDirectory=/home/admin/can_server
Environment="ESP32_BASE_URL=http://esp32c3-mesure.local"
Environment="ESP32_SIMULATOR=0"
ExecStart=/usr/bin/python3 app.py --break-system-packages
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target

# Recharger le système après modification du fichier .service
sudo systemctl daemon-reload

# Activer le lancement automatique au démarrage du Pi
sudo systemctl enable can_server.service

# Piloter l'application en tâche de fond
sudo systemctl start can_server.service
sudo systemctl stop can_server.service
sudo systemctl restart can_server.service

# Débloquer le service s'il s'est mis en sécurité suite à des crashs répétés
sudo systemctl reset-failed can_server.service

# Vérifier si le service est bien actif (rechercher la ligne verte "active (running)")
sudo systemctl status can_server.service

# Afficher les 20 dernières lignes de logs Python (Idéal pour voir les fautes de frappe ou crashs de code)
sudo journalctl -u can_server.service -n 20 --no-pager



sudo nmcli connection modify Mon_Reseau_Pi 802-11-wireless.band bg
sudo nmcli connection modify Mon_Reseau_Pi 802-11-wireless.channel 6
sudo nmcli connection modify Mon_Reseau_Pi 802-11-wireless-security.key-mgmt wpa-psk
sudo nmcli connection up Mon_Reseau_Pi


hw_mode=g
channel=6


# 1. On modifie la bande pour forcer le 2.4 GHz (bg)
sudo nmcli connection modify Mon_Reseau_Pi 802-11-wireless.band bg

# 2. On fixe un canal standard compatible (ex: le canal 6)
sudo nmcli connection modify Mon_Reseau_Pi 802-11-wireless.channel 6

# 3. On applique et on redémarre le réseau du Pi
sudo nmcli connection up Mon_Reseau_Pi

netsh wlan show networks mode=bssid


=====================================================================
NOUVEAU PARCOURS ACQUISITION ESP32-C3 ET DASHBOARD
=====================================================================

1. Firmware à flasher
---------------------------------------------------------------------
Utiliser exclusivement :

    esp32C3-multi-INA226/esp32C3-multi-INA226.ino

Le sketch rejoint le point d'accès `Mon_Reseau_Pi`, publie le nom
`esp32c3-mesure.local` et expose les routes utilisées par le Raspberry Pi :

    POST /api/acquisition/start
    POST /api/acquisition/stop
    GET  /api/acquisition/status

Le navigateur ne commande pas directement l'ESP32-C3. Toutes les commandes
passent par le serveur Flask du Raspberry Pi.


2. Variables du service systemd
---------------------------------------------------------------------
Ajouter ou vérifier ces lignes dans `/etc/systemd/system/can_server.service` :

    Environment="ESP32_BASE_URL=http://esp32c3-mesure.local"
    Environment="ESP32_SIMULATOR=0"
    Environment="CAN_INTERFACE=can0"
    Environment="CAN_COLLECTOR_ENABLED=1"

Puis appliquer :

    sudo systemctl daemon-reload
    sudo systemctl restart can_server.service
    sudo journalctl -u can_server.service -n 50 --no-pager


3. Réception automatique des mesures CAN
---------------------------------------------------------------------
Le serveur écoute l'interface SocketCAN indiquée par `CAN_INTERFACE`. L'interface
`can0` doit déjà être créée par le pilote du contrôleur CAN du Raspberry Pi.
Après avoir appliqué l'overlay correspondant exactement au matériel CAN utilisé,
activer le bus à 500 kbit/s :

    sudo ip link set can0 down
    sudo ip link set can0 type can bitrate 500000 restart-ms 100
    sudo ip link set can0 up
    ip -details link show can0

Vérification avant une mesure :

    candump can0

Les identifiants émis par le sketch sont :

    0x100  courant canal A
    0x101  statistiques canal A
    0x102  courant canal B
    0x103  statistiques canal B
    0x105  synchronisation temporelle

Si le Raspberry Pi ne possède pas d'interface CAN, utiliser :

    Environment="CAN_COLLECTOR_ENABLED=0"

L'acquisition ESP32-C3 reste pilotable. Les fichiers ASC peuvent ensuite être
ingérés dans le module « Analyse de logs » avant de recharger le dashboard.


4. Synchronisation des références théoriques
---------------------------------------------------------------------
Depuis le serveur principal, le bouton « CAN Server » envoie au Raspberry Pi :

    - le projet actif ;
    - les Devices DCDC encore présents ;
    - les ECU de veille DM1, DM2 et Customer Mode ;
    - les courants modifiés ;
    - les profils temporels DCDC et leurs pourcentages.

La synchronisation est effectuée par un formulaire POST vers :

    http://10.42.0.1/import-theory

Le fichier reçu est conservé sur le Raspberry Pi dans :

    data/theory_snapshot.json

Les sessions de mesure sont enregistrées dans :

    data/measurement_sessions.json


=====================================================================
STABILISATION DU POINT D'ACCÈS RASPBERRY PI
=====================================================================

Le profil NetworkManager utilisé ci-dessous s'appelle `Hotspot`. Vérifier son
nom réel avant toute modification :

    nmcli -f NAME,TYPE,DEVICE connection show --active

Appliquer une configuration AP fixe, sans économie d'énergie et avec une
reconnexion sans limite :

    sudo nmcli connection modify "Hotspot" connection.autoconnect yes
    sudo nmcli connection modify "Hotspot" connection.autoconnect-priority 999
    sudo nmcli connection modify "Hotspot" connection.autoconnect-retries 0
    sudo nmcli connection modify "Hotspot" 802-11-wireless.powersave 2
    sudo nmcli connection modify "Hotspot" 802-11-wireless.band bg
    sudo nmcli connection modify "Hotspot" 802-11-wireless.channel 6
    sudo nmcli connection modify "Hotspot" ipv4.method shared
    sudo nmcli connection modify "Hotspot" ipv4.addresses 10.42.0.1/24

Redémarrer ensuite le Raspberry Pi afin d'appliquer le profil sans risquer de
laisser le point d'accès arrêté au milieu d'une session SSH :

    sudo reboot

Après reconnexion :

    nmcli -f NAME,TYPE,DEVICE connection show --active
    nmcli -f 802-11-wireless.powersave,connection.autoconnect,connection.autoconnect-retries connection show "Hotspot"

Diagnostic d'alimentation et de pilote Wi-Fi :

    vcgencmd get_throttled
    vcgencmd measure_temp
    dmesg -T | grep -Ei 'under-voltage|wlan0|brcmfmac'
    sudo journalctl -u NetworkManager -n 100 --no-pager

`get_throttled=0x0` est le résultat attendu. Toute valeur contenant le bit
`0x1` ou `0x10000` indique une sous-tension actuelle ou passée : remplacer
l'alimentation et le câble d'alimentation du Raspberry Pi.


=====================================================================
PROCÉDURE DE FLASH ESP32-C3
=====================================================================

Le sketch utilise actuellement GPIO8 et GPIO9 pour l'I2C. Ces deux broches font
partie des broches de strapping de l'ESP32-C3 ; GPIO9 sert également à forcer le
mode de téléchargement.

Pour téléverser de manière fiable :

    1. Débrancher l'alimentation externe de l'ESP32-C3.
    2. Débrancher temporairement INA226, MCP2515 et toutes les liaisons GPIO.
    3. Alimenter l'ESP32-C3 uniquement par un câble USB de données court.
    4. Fermer le moniteur série et tout logiciel utilisant le port COM.
    5. Sélectionner `ESP32C3 Dev Module` et une vitesse d'upload de 115200.
    6. Maintenir BOOT, appuyer puis relâcher RESET, puis relâcher BOOT.
    7. Lancer immédiatement le téléversement.
    8. Après succès, appuyer sur RESET puis reconnecter les périphériques.

Si le port COM disparaît pendant l'écriture, changer de câble USB, de port USB
et réinstaller le pilote correspondant au convertisseur USB-série de la carte.
