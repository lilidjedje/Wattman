# Collecteur Wattman autonome sur Raspberry Pi

Pour une première installation, suivre le [guide détaillé pour débutante](GUIDE_DEBUTANTE.md).

État : code préparé et tests logiciels réalisés sur PC. Installation et
validation sur le Raspberry Pi encore nécessaires. Un firmware v4 ou plus récent
doit aussi être téléversé ; utiliser `dual-display-v5` pour le montage à deux
écrans. La version OLED v3 ne fournit pas le miroir CAN.

## 1. Remettre la carte SD à zéro

1. Sauvegarder les fichiers de l'ancien programme à conserver. Arrêter le Pi
   (`sudo poweroff` si accessible), puis retirer son alimentation et sa SD.
2. Insérer la microSD dans un lecteur USB sur le PC. La liaison USB au Pi
   n'est pas nécessaire pour cette opération.
3. Installer Raspberry Pi Imager depuis https://www.raspberrypi.com/software/.
4. Sélectionner le modèle exact du Pi, puis **Raspberry Pi OS Lite** proposé
   pour ce modèle (64 bits si compatible). Il n'est pas nécessaire d'installer
   un bureau graphique.
5. Choisir la microSD comme stockage. Vérifier sa capacité pour éviter de
   sélectionner un autre disque : l'écriture efface entièrement cette carte.
6. Dans les personnalisations d'Imager, saisir :
   - nom d'hôte : `wattman-recorder` ;
   - utilisateur : `wattman` ;
   - mot de passe : choisir un mot de passe personnel, à conserver localement ;
   - pays Wi-Fi : `FR` ;
   - fuseau horaire : `Europe/Paris` ; clavier français ;
   - accès distant : activer SSH, authentification par mot de passe (ou clé si
     vous utilisez déjà une clé SSH) ;
   - Wi-Fi initial : réseau domestique, si Ethernet indisponible à cette étape.
7. Écrire, laisser Imager vérifier, puis éjecter la SD. Si Windows propose de
   formater une partition Linux après l'écriture, annuler cette proposition.
8. Remettre la SD dans le Pi. Brancher Ethernet à la box, puis une alimentation
   propre au Pi. Attendre le premier démarrage pendant quelques minutes.

Ne pas alimenter le Pi ni l'ESP32 uniquement par le PC : ils s'éteindraient avec lui.
Pour une configuration réseau par USB sans Ethernet, le mode gadget dépend du
modèle exact du Pi ; ne pas appliquer une recette USB générique.

## 2. Première connexion

Dans PowerShell sur le PC :

```powershell
ssh wattman@wattman-recorder.local
```

Si le nom ne répond pas, lire l'adresse attribuée au Pi dans la liste DHCP de
la box, puis utiliser `ssh wattman@ADRESSE_IP`. Aucune IP fixe n'est nécessaire
au départ. Une réservation DHCP pourra être ajoutée dans la box ensuite.

Sur le Pi :

```bash
sudo apt update
sudo apt full-upgrade -y
sudo apt install -y python3-venv unzip network-manager
hostname
timedatectl
df -h
```

Vérifier le nom et une date correcte. L'horloge du Pi fournit les horodatages
à l'ESP32 ; laisser sa synchronisation réseau fonctionner avant un essai.

## 3. Installer le collecteur

Sur le PC, à la racine du projet :

```powershell
python desktop/raspberry/package.py
scp desktop-build/wattman-recorder.zip wattman@wattman-recorder.local:~/
```

Sur le Pi :

```bash
mkdir -p ~/Wattman
unzip -o ~/wattman-recorder.zip -d ~/Wattman
cd ~/Wattman
bash desktop/raspberry/install.sh
```

Le service `wattman-recorder` démarre automatiquement, sans ouvrir de session
SSH ni garder le PC allumé. Les données sont dans
`/home/wattman/wattman-data/can_data/mesures.db` et les sessions dans
`measurement_sessions.json` du même dossier.

## 4. Relier le Pi à l'ESP32

Configuration retenue : Ethernet Pi → box pour le pilotage depuis le PC ;
Wi-Fi Pi → ESP32 pour les mesures. Le Wi-Fi et Ethernet du Pi peuvent avoir
des adresses différentes : c'est normal.

Le sketch **copie** utilise `esp32_mesure`, mot de passe `ina226mesure`.
Il diffère du nom indiqué pour l'ancien sketch principal dans le README racine.

```bash
nmcli device status
nmcli device wifi list
sudo nmcli --ask device wifi connect esp32_mesure ifname wlan0
curl http://192.168.4.1/api/acquisition/status
```

Saisir le mot de passe quand `nmcli` le demande. Si l'interface Wi-Fi n'est pas
`wlan0`, remplacer ce nom par celui affiché par `nmcli device status`.
Conserver Ethernet branché pendant cette opération et pendant les essais.
Ne pas déconnecter le Pi du Wi-Fi de l'ESP32 en cours de mesure.

Le firmware **autonomous-recorder-v4**, variante `esp32C3-multi-INA226-copie`,
doit répondre avec `"recorder_mirror_supported": true`. Sinon, le collecteur
refuse de démarrer une acquisition autonome plutôt que de promettre un
enregistrement qui ne peut pas avoir lieu.

## 5. Utiliser depuis le PC

Ouvrir : `http://wattman-recorder.local:8080/analyse_logs/`.
Toutes les commandes doivent être lancées depuis cette interface du Pi.
On peut la fermer, quitter le Wi-Fi du PC ou éteindre le PC ; le Pi conserve
son propre flux et sa base. Revenir à la même adresse pour retrouver les données.

Pour que l'application Electron utilise le même collecteur, la fermer puis,
depuis PowerShell à la racine du projet :

```powershell
$env:WATTMAN_RECORDER_URL='http://wattman-recorder.local:8080'
npm start
```

L'application doit avoir été relancée avec cette variable ; une ancienne
instance déjà ouverte continue à utiliser son ancien mode. Fermer l'instance
distante n'envoie aucun ordre d'arrêt au Pi. Le mode PC direct reste dépendant
du PC et ne doit pas servir à un essai autonome.

Le Pi enregistre les mesures brutes dans SQLite dans les deux modes. Il ne
génère pas continuellement des milliers de fichiers Excel de 1 000 lignes
pendant plusieurs jours. Le dashboard exploite la base enregistrée sur le Pi.
L'API vérifie l'espace disponible avant de démarrer, avec une marge de
512 octets par mesure et 256 Mio réservés. Commencer à basse fréquence pour
une mesure de veille, puis valider la cadence utile sur le montage réel.

Une session peut inclure A et B, avec durées/fréquences propres. Le moteur
actuel exécute une seule session à la fois : il refuse aussi de démarrer une
seconde session sur un autre canal tant que la première n'est pas terminée.
Un conflit affiche une fenêtre et conserve l'acquisition existante.

## 6. CANalyzer 10.0 et VN1610

Le VN1610 est une interface USB : CANalyzer sur le PC n'enregistre pas lorsque
Windows est en veille, en hibernation ou arrêté. Le mode autonome de la gamme
VN8900 ne rend pas un VN1610 autonome.

Pour observer en parallèle pendant que le PC est allumé :

1. Relier le VN1610 au PC et au même bus de mesure que le MCP2515 ; masse
   commune et terminaison adaptées au bus réel.
2. Dans Vector Hardware Configuration, affecter le canal physique VN1610 au
   canal CAN de l'application CANalyzer.
3. Dans CANalyzer, choisir 500 kbit/s et le DBC du projet pour décoder les IDs
   0x100 et 0x102, contenant les courants flottants A et B.
4. Activer le bloc Logging du Measurement Setup, choisir un chemin et un
   fichier ASC ou BLF, puis lancer la mesure CANalyzer.
5. Depuis l'interface Pi, démarrer la mesure CAN ; l'observation et le log
   CANalyzer fonctionnent pendant que le PC et sa mesure restent actifs.

Pour laisser CANalyzer enregistrer toute la nuit, garder Windows éveillé,
alimenté, sans veille/hibernation ; seul l'écran peut être éteint. Verrouiller
la session ne remplace pas une vérification des réglages d'alimentation.

Quand le PC s'éteint, seul le Pi poursuit l'enregistrement des **mesures de
courant produites par l'ESP32**. Le miroir TCP ne constitue pas une capture
de toutes les trames du bus ni une preuve de livraison CAN. Les erreurs
d'acquittement sont comptées séparément et ne doivent pas bloquer les INA.
Pour enregistrer tout le bus PC éteint, il faut en plus un logger CAN autonome
ou une interface CAN compatible avec le Pi et son collecteur.

## 7. Validation indispensable avant plusieurs jours

Pour chaque mode (numérique puis CAN) :

1. Démarrer A à 1 Hz pendant 10 minutes ; vérifier l'augmentation du compteur.
2. Tenter un autre démarrage : vérifier la fenêtre d'erreur et l'absence de
   remise à zéro des compteurs de la session active.
3. Fermer l'application et toutes les pages du Pi pendant 2 minutes.
4. Rouvrir l'interface : vérifier les données de toute la période.
5. Refaire en déconnectant le PC du réseau, puis avec le PC réellement éteint.
6. En CAN, vérifier les mesures sur le Pi avec CANalyzer fermé et VN1610
   débranché du PC, puis reprendre l'observation CANalyzer.
7. À la fin, vérifier les pertes et l'intégrité (compteurs attendus/reçus).
   Ne pas valider une session affichée `incomplete` comme une capture complète.
8. Faire ensuite un essai d'une nuit avant de passer à plusieurs jours.

Le Pi et l'ESP32 doivent rester alimentés. Le logiciel ne promet pas de
continuité après une panne du Pi, une coupure de sa SD ou de la liaison
Pi–ESP32. Une session interrompue par le redémarrage du collecteur est marquée
incomplète. Les échantillons absents ne sont pas inventés ni interpolés.

Diagnostic du service :

```bash
sudo systemctl status wattman-recorder --no-pager
journalctl -u wattman-recorder -n 100 --no-pager
df -h ~/wattman-data
```

Ne pas redémarrer le service pendant un test. Pour sauvegarder la base en
activité, utiliser l'API de sauvegarde SQLite (`sqlite3.Connection.backup`),
pas une simple copie du fichier `.db` en oubliant son journal WAL.

Références :
- https://www.raspberrypi.com/documentation/computers/getting-started.html
- https://support.vector.com/kb?id=kb_article_view&sysparm_article=KB0012397
