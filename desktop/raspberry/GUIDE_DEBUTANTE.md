# Préparer le Raspberry Pi pour les mesures Wattman

Ce guide s'adresse à une personne qui débute. Suivre les étapes dans l'ordre.
Les commandes sont à copier dans le terminal indiqué, puis à valider avec **Entrée**.

**État actuel :** le programme du collecteur est préparé et testé sur PC.
L'installation et les essais avec le vrai Raspberry Pi restent à effectuer.
Le firmware ESP32 `dual-display-v5 | oled-flip-180` a été compilé et téléversé
sur le prototype le 4 novembre 2026. Pour un autre ESP32, téléverser également
le firmware compatible. Le rendu réel des deux écrans reste à vérifier.

## 1. Comprendre le montage retenu

Le Raspberry Pi remplace le PC pour enregistrer les mesures. Le PC sert à
lancer les essais et à consulter les résultats.

```text
PC ── Wi-Fi ou Ethernet ── Box / routeur ── Ethernet ── Raspberry Pi
                                                       │
                                                      Wi-Fi
                                                       │
                                                     ESP32
                                                       │
                                                    INA226

En mode CAN : ESP32 / MCP2515 ── bus CAN ── VN1610 ── USB ── PC
```

Le Pi et l'ESP32 doivent avoir une alimentation indépendante du PC.
Le câble Ethernet du Pi va vers la box ou un routeur qui reste allumé.
Une liaison Ethernet uniquement vers le PC ne permettrait plus de consulter
le Pi par ce chemin lorsque le PC est éteint.

Le Pi utilise son Wi-Fi pour joindre l'ESP32 et son Ethernet pour joindre le
PC et Internet. Deux adresses IP différentes sur le Pi sont donc normales.
Si ton Pi n'a pas de Wi-Fi ou de port Ethernet, il faut adapter le montage
avant de suivre les étapes réseau ci-dessous.

Ce guide n'active pas de réseau USB : cette possibilité dépend du modèle du
Pi. Le lecteur USB de carte SD suffit pour préparer le système.

## 2. Reconnaître les deux terminaux

| Où ? | Comment le reconnaître ? | Commandes à y saisir |
|---|---|---|
| PC Windows : PowerShell | Exemple : `PS E:\Wattman-main\Wattman-main>` | Les blocs marqués « PC Windows » |
| Raspberry Pi : terminal SSH | Exemple : `wattman@wattman-recorder:~ $` | Les blocs marqués « Raspberry Pi » |

Pour ouvrir PowerShell : rechercher **PowerShell** dans le menu Démarrer.
Pour ouvrir le terminal du Pi : utiliser la commande `ssh` donnée plus bas.

Ne pas copier les indications `PS ...>` ou `wattman@... $` : elles montrent
seulement où le terminal attend ta prochaine commande.

Quelques repères : `sudo` demande les droits administrateur ; `~` représente
ton dossier personnel ; `cd` change de dossier ; `Ctrl+C` interrompt une commande.
Ne pas utiliser `Ctrl+C` au milieu d'une installation qui progresse normalement.

## 3. Préparer une carte SD propre — sur le PC

**Cette opération efface la carte sélectionnée, y compris l'ancien programme.**
Sauvegarder d'abord ce que tu souhaites conserver. Si l'ancien Pi fonctionne,
l'arrêter avec `sudo poweroff`, attendre son arrêt, puis retirer son alimentation
avant d'enlever la carte.

Insérer la SD dans un lecteur sur le PC. Dans **Raspberry Pi Imager** :

1. Choisir le modèle exact du Pi.
2. Choisir **Raspberry Pi OS Lite**, 64 bits si compatible avec ce modèle.
3. Choisir la microSD et vérifier sa capacité.
4. Renseigner les personnalisations ci-dessous.
5. Écrire, laisser la vérification finir, puis éjecter la carte.

| Paramètre | Valeur à choisir |
|---|---|
| Nom d'hôte | `wattman-recorder` |
| Nom d'utilisateur | `wattman` |
| Mot de passe | Choisir le tien ; le conserver sans me l'envoyer |
| Fuseau horaire | `Europe/Paris` |
| Clavier | Français |
| Pays Wi-Fi | `FR` |
| SSH / accès distant | Activé |
| Authentification SSH | Par mot de passe, sauf si tu utilises déjà une clé SSH |
| Wi-Fi initial, si demandé | Celui de la box ; Ethernet sera conservé ensuite |

Si Windows propose ensuite de formater une partition, **annuler**.
Il n'est pas nécessaire de renommer manuellement les partitions de la SD.

Installer Imager : https://www.raspberrypi.com/software/

## 4. Premier démarrage

Remettre la carte dans le Pi, brancher Ethernet à la box, puis son alimentation.
Attendre quelques minutes. Le PC doit être sur le réseau de la même box.

**PC Windows — PowerShell :**

```powershell
ssh wattman@wattman-recorder.local
```

À la première connexion, SSH peut demander de confirmer l'identité de la
machine : vérifier que tu contactes bien ton nouveau Pi, puis saisir `yes`.
Entrer le mot de passe choisi dans Imager. **Rien ne s'affiche pendant la saisie**,
pas même des étoiles : c'est normal.

Résultat attendu : une ligne semblable à `wattman@wattman-recorder:~ $`.
À partir de là, les commandes de ce terminal sont exécutées sur le Pi.

Si le nom ne fonctionne pas, chercher le Pi dans la liste des appareils/DHCP
de la box. Par exemple, si son adresse est `192.168.1.42` :

```powershell
ssh wattman@192.168.1.42
```

Cette adresse est un **exemple**, pas l'adresse imposée à ton Pi.
Nous pourrons utiliser ton IP réelle plus tard.

## 5. Vérifier et mettre à jour le Pi

**Raspberry Pi — terminal SSH.** Saisir une commande à la fois.

```bash
whoami
```

Affiche l'utilisateur connecté. Résultat attendu : `wattman`.

```bash
hostname
```

Affiche le nom du Pi. Résultat attendu : `wattman-recorder`.

```bash
sudo apt update
```

Actualise la liste des logiciels disponibles. Une demande de mot de passe
concerne celui du compte `wattman`. Attendre le retour de l'invite de commande.

```bash
sudo apt full-upgrade -y
```

Installe les mises à jour du système. Cette étape peut prendre plusieurs minutes.
Si une erreur apparaît, conserver son texte avant de passer à la suite.

```bash
sudo apt install -y python3-venv unzip network-manager curl
```

Installe les outils utiles : environnement Python, ouverture de l'archive,
gestion réseau et vérification de l'API ESP32.

```bash
sudo timedatectl set-timezone Europe/Paris
sudo timedatectl set-ntp true
timedatectl
```

Vérifier la date et l'heure. Le fuseau doit être `Europe/Paris` ; laisser le Pi
accéder à Internet pour synchroniser son horloge. Une date incorrecte fausse
les horodatages envoyés à l'ESP32 : ne pas démarrer un essai avant correction.

```bash
df -h /
```

Affiche l'espace du stockage principal. La colonne `Avail` ou `Dispo` indique
l'espace libre. Ne pas confondre capacité totale et espace restant.

Redémarrer une fois après les mises à jour, **avant toute mesure** :

```bash
sudo reboot
```

La connexion SSH se ferme : c'est normal. Attendre le retour du Pi, puis
relancer depuis PowerShell `ssh wattman@wattman-recorder.local`.

## 6. Envoyer le programme depuis le PC

Conserver le terminal SSH. Ouvrir **une deuxième fenêtre PowerShell sur le PC**.

**PC Windows :**

```powershell
Set-Location 'E:\Wattman-main\Wattman-main'
python desktop/raspberry/package.py
```

La deuxième commande prépare `desktop-build\wattman-recorder.zip`, sans copier
les bases de mesures et les projets privés du PC.

```powershell
scp desktop-build/wattman-recorder.zip wattman@wattman-recorder.local:~/
```

`scp` copie l'archive sur le Pi. Saisir le mot de passe si demandé et attendre
la fin de la copie. Remplacer le nom du Pi par son IP réelle si nécessaire.

**Raspberry Pi — revenir dans le terminal SSH :**

```bash
ls -lh ~/wattman-recorder.zip
```

Vérifie que l'archive est arrivée. Si le terminal indique qu'elle n'existe pas,
reprendre l'étape de copie depuis le PC.

```bash
mkdir -p ~/Wattman
unzip -o ~/wattman-recorder.zip -d ~/Wattman
cd ~/Wattman
```

Ces commandes créent le dossier du programme, extraient l'archive puis entrent
dans ce dossier. `-o` autorise le remplacement des fichiers du programme lors
d'une installation ultérieure ; les données de mesure sont dans un autre dossier.

## 7. Installer le service permanent

**Raspberry Pi :**

```bash
bash desktop/raspberry/install.sh
```

Ne pas ajouter `sudo` devant cette commande. Le script demande lui-même les
droits administrateur pour les opérations qui en ont besoin.

Il installe les dépendances Python dans `~/Wattman/.venv-recorder`, crée le
dossier `~/wattman-data`, puis installe et active le service `wattman-recorder`.
Un **service** est un programme que le Pi lance et garde actif sans terminal ouvert.

Vérifier son état :

```bash
sudo systemctl status wattman-recorder --no-pager
```

Résultat attendu : `active (running)`. `enabled` signifie que le service
redémarrera avec le Pi. Si l'état est `failed`, consulter la section dépannage.
Une erreur de communication avec l'ESP32 à cette étape peut simplement venir
du fait que sa liaison Wi-Fi n'est pas encore configurée.

## 8. Connecter le Wi-Fi du Pi à l'ESP32

**Garder le câble Ethernet branché.** Le Wi-Fi du Pi va quitter le réseau de
la box pour rejoindre celui de l'ESP32 ; Ethernet maintient l'accès au Pi.
Alimenter l'ESP32 indépendamment du PC.

**Raspberry Pi :**

```bash
nmcli device status
```

Chercher la ligne de type `wifi`. Son nom est généralement `wlan0`.
Si le nom est différent, le remplacer dans les commandes suivantes.

```bash
sudo nmcli radio wifi on
nmcli device wifi list ifname wlan0
```

La première commande active le Wi-Fi. La seconde liste les réseaux visibles.
Le firmware **copie** utilisé ici crée `esp32_mesure`, mot de passe
`ina226mesure`. Ne pas confondre ce réseau avec les noms d'anciens firmwares.

```bash
sudo nmcli --ask device wifi connect esp32_mesure ifname wlan0 name wattman-esp32
```

Saisir `ina226mesure` lorsque le mot de passe Wi-Fi est demandé. Ce mot de passe
est celui de l'ESP32, pas celui du compte `wattman`.

Configurer ce profil pour les prochains démarrages :

```bash
sudo nmcli connection modify wattman-esp32 connection.autoconnect yes connection.autoconnect-priority 100 ipv4.never-default yes ipv6.never-default yes
sudo nmcli connection up wattman-esp32
```

Le profil se reconnectera automatiquement avec priorité. `never-default`
préserve l'utilisation d'Ethernet pour les destinations extérieures au réseau
ESP32, notamment Internet. Ces commandes sont à faire hors mesure.

```bash
nmcli device status
hostname -I
```

Résultat attendu : Ethernet connecté à la box et Wi-Fi connecté au profil
`wattman-esp32`. `hostname -I` peut afficher plusieurs adresses. Pour le PC,
utiliser le nom `wattman-recorder.local` ou l'IP Ethernet attribuée par la box,
pas l'IP Wi-Fi du Pi sur le petit réseau de l'ESP32.

## 9. Vérifier que le Pi voit le bon firmware ESP32

**Raspberry Pi :**

```bash
curl --max-time 5 http://192.168.4.1/api/acquisition/status
```

Le résultat est du texte au format JSON, avec notamment `running` et les
canaux. Il faut trouver :

```json
"recorder_mirror_supported": true
```

Cette propriété confirme la compatibilité avec le collecteur autonome.
**Si elle est absente, s'arrêter ici : il faut téléverser le firmware compatible**
`esp32C3-multi-INA226-copie` depuis le PC (`dual-display-v5` avec les deux écrans). Installer le Pi ne met pas
automatiquement à jour le programme de l'ESP32.

`192.168.4.1` est ici l'adresse de l'ESP32. Ce n'est pas celle du Pi.

## 10. Vérifier la configuration du collecteur

**Raspberry Pi :**

```bash
sudo cat /etc/wattman/recorder.env
```

Avec le compte choisi dans ce guide, le résultat attendu est :

```text
ENGINEERING_APP_DATA=/home/wattman/wattman-data
ESP32_BASE_URL=http://192.168.4.1
WATTMAN_PORT=8080
```

Ces lignes sont le **contenu du fichier**, pas des commandes à taper séparément.
Le script les crée normalement sans intervention.

Si une correction est nécessaire, et seulement hors mesure :

```bash
sudo nano /etc/wattman/recorder.env
```

Dans l'éditeur, modifier la ligne concernée. Enregistrer avec `Ctrl+O`, valider
le nom du fichier avec Entrée, puis quitter avec `Ctrl+X`.

Appliquer une modification hors mesure :

```bash
sudo systemctl restart wattman-recorder
sudo systemctl status wattman-recorder --no-pager
```

Un redémarrage du service coupe sa collecte : ne pas le faire pendant un essai.

Tester la page depuis le Pi :

```bash
curl --max-time 10 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/analyse_logs/
```

Résultat attendu : `200`. `127.0.0.1` signifie « ce Pi lui-même ».

## 11. Ouvrir l'interface depuis le PC

Dans le **navigateur du PC**, saisir :

```text
http://wattman-recorder.local:8080/analyse_logs/
```

Si nécessaire, remplacer le nom par l'IP Ethernet du Pi.
Par exemple : `http://192.168.1.42:8080/analyse_logs/`.

Utiliser cette interface du Pi pour les essais autonomes. L'ancien mode PC
direct reste dépendant du PC. Le Pi doit rester joignable depuis le PC via la box.

Pour utiliser l'application Electron des sources avec le même Pi, fermer
d'abord toutes ses anciennes instances, puis dans **PowerShell sur le PC** :

```powershell
Set-Location 'E:\Wattman-main\Wattman-main'
$env:WATTMAN_RECORDER_URL='http://wattman-recorder.local:8080'
npm start
```

Ce réglage vaut pour ce lancement depuis cette fenêtre PowerShell. Ne pas
supposer qu'un ancien raccourci d'une version installée utilise ce réglage.

## 12. Premier essai : commencer petit

Faire cette vérification en numérique, puis refaire en CAN après vérification
du câblage MCP2515 et du débit 500 kbit/s.

1. Ouvrir l'interface du Pi et choisir un seul canal, A.
2. Régler **1 Hz** et **10 minutes**. C'est un test de fonctionnement, pas une
   prescription de fréquence pour toutes les futures mesures.
3. Démarrer. Vérifier que les compteurs avancent.
4. Tenter un deuxième démarrage : une fenêtre doit refuser cette action sans
   remettre à zéro la mesure active.
5. Fermer l'interface et l'application pendant deux minutes.
6. Rouvrir la même adresse : la mesure doit avoir continué.
7. Refaire un essai en déconnectant le PC du réseau.
8. Refaire ensuite avec le PC complètement éteint pendant une partie du test.
9. À la fin, consulter les données, les pertes et l'intégrité. Ne pas valider
   une session `incomplete` comme un enregistrement complet.
10. Une fois ces essais réussis, essayer une nuit avant plusieurs jours.

Pendant l'extinction du PC, **ne pas couper la box, le Pi ou l'ESP32 et ne pas
déconnecter le Wi-Fi du Pi de l'ESP32**. La déconnexion autorisée est celle du PC.

Le moteur actuel traite une seule session à la fois, incluant A et/ou B avec
leurs réglages. Il refuse aussi de lancer une deuxième session séparée sur B
pendant qu'une session A est active.

## 13. Où sont conservées les données ?

| Élément | Chemin sur le Pi |
|---|---|
| Programme | `/home/wattman/Wattman` |
| Configuration du service | `/etc/wattman/recorder.env` |
| Base des mesures brutes | `/home/wattman/wattman-data/can_data/mesures.db` |
| Historique des sessions | `/home/wattman/wattman-data/can_data/measurement_sessions.json` |

Les mesures autonomes numériques et CAN sont enregistrées dans SQLite, une
base de données sur la SD. Le Pi ne produit pas continuellement les milliers
de petits fichiers Excel de l'ancien mode PC pendant un essai de plusieurs jours.
Le dashboard lit les mesures de la base du Pi.

Pour vérifier la place restante :

```bash
df -h ~/wattman-data
du -sh ~/wattman-data
```

La première commande donne l'espace libre du stockage ; la seconde donne
l'espace occupé par le dossier Wattman. Une fréquence plus élevée produit plus
de données. Le programme refuse un démarrage si son estimation dépasse l'espace
disponible, mais il faut aussi surveiller les autres usages de la carte.

## 14. Sauvegarder sans abîmer la base

Faire cette première sauvegarde **après la fin d'une mesure**, sans nouvelle
mesure en cours. Ne pas simplement copier le `.db` d'une base active : SQLite
peut aussi utiliser les fichiers `-wal` et `-shm`.

**Raspberry Pi :** copier tout le bloc suivant, y compris la ligne finale `PY`.

```bash
python3 - <<'PY'
from pathlib import Path
from datetime import datetime
import sqlite3
import shutil

source = Path.home() / 'wattman-data' / 'can_data'
destination = Path.home() / 'wattman-sauvegardes' / datetime.now().strftime('%Y%m%d-%H%M%S')
destination.mkdir(parents=True, exist_ok=False)
database = source / 'mesures.db'
if not database.exists():
    raise SystemExit('Base introuvable : aucune sauvegarde de mesures créée.')
with sqlite3.connect(f'{database.as_uri()}?mode=ro', uri=True) as original:
    with sqlite3.connect(destination / 'mesures.db') as copie:
        original.backup(copie)
sessions = source / 'measurement_sessions.json'
if sessions.exists():
    shutil.copy2(sessions, destination / sessions.name)
print('Sauvegarde créée :', destination)
PY
```

Le script crée une copie cohérente de la base, puis copie l'historique des
sessions. Il affiche le chemin de la sauvegarde.

**PC Windows**, pour récupérer le dossier de sauvegardes :

```powershell
Set-Location 'E:\Wattman-main\Wattman-main'
scp -r wattman@wattman-recorder.local:~/wattman-sauvegardes ./sauvegardes-raspberry
```

## 15. Arrêter et redémarrer proprement

Fermer le terminal SSH avec `exit` ne coupe pas le service : la mesure continue.

Pour éteindre le Pi, terminer ou arrêter explicitement la mesure dans
l'interface, attendre la fin de l'enregistrement, puis saisir sur le Pi :

```bash
sudo poweroff
```

La connexion SSH se ferme. Attendre l'arrêt du Pi avant de retirer l'alimentation.
Pour le remettre en route, remettre son alimentation.

Pour un redémarrage, uniquement hors mesure :

```bash
sudo reboot
```

Le service se relance au démarrage. **Une mesure coupée par un redémarrage du
Pi ne reprend pas automatiquement sans pertes** : elle est signalée incomplète.
Cette solution couvre l'arrêt du PC, pas la perte d'alimentation du collecteur.

## 16. Dépannage : quoi regarder ?

### Impossible de se connecter en SSH

Vérifier l'alimentation, Ethernet, le réseau du PC, puis l'IP dans la box.
`Connection refused` peut indiquer que SSH n'est pas activé ; un délai dépassé
peut indiquer un problème d'adresse ou de réseau.

Après une réinstallation, SSH peut signaler une identité différente. Seulement
si tu viens bien de réinstaller ton propre Pi, supprimer l'ancienne empreinte
sur le PC, puis reconnecter :

```powershell
ssh-keygen -R wattman-recorder.local
ssh wattman@wattman-recorder.local
```

Si tu utilises une IP, supprimer l'empreinte de cette IP à la place du nom.

### Le réseau ESP32 n'apparaît pas

Sur le Pi :

```bash
sudo nmcli device wifi rescan ifname wlan0
nmcli device wifi list ifname wlan0
```

Vérifier l'alimentation de l'ESP32, la proximité et le bon firmware.

### L'ESP32 ne répond pas à curl

```bash
nmcli device status
ip route get 192.168.4.1
curl --max-time 5 http://192.168.4.1/api/acquisition/status
```

La route vers `192.168.4.1` doit passer par le Wi-Fi relié à l'ESP32. Conserver
le message d'erreur exact. Ne pas modifier au hasard les adresses IP.

### Le service est en erreur ou l'interface ne répond pas

```bash
sudo systemctl status wattman-recorder --no-pager
journalctl -u wattman-recorder -n 100 --no-pager
```

La première commande donne l'état ; la seconde affiche les 100 dernières lignes
du journal. Copier les erreurs pour diagnostic, en masquant tout mot de passe.

Pour suivre le journal en direct :

```bash
journalctl -u wattman-recorder -f
```

Quitter cet affichage avec `Ctrl+C` ne stoppe pas le service.

### Le PC ne voit pas l'interface mais curl fonctionne sur le Pi

Vérifier Ethernet et essayer l'IP Ethernet du Pi dans le navigateur du PC,
avec `:8080/analyse_logs/`. Éviter un réseau invité qui isole les appareils.

### Le collecteur refuse de démarrer

Lire le message : test déjà actif, firmware incompatible ou place insuffisante
sont trois causes différentes. Un test actif doit être terminé ou arrêté
explicitement ; ne pas redémarrer l'ESP32 pour contourner ce contrôle.

## 17. Limite de CANalyzer et du VN1610

CANalyzer 10.0 tourne sur le PC. Avec le VN1610 USB, il n'enregistre pas lorsque
Windows est arrêté, en veille ou en hibernation. Pour son propre enregistrement,
le PC doit rester éveillé ; l'écran peut être éteint.

Avec le montage de ce guide, le Pi conserve les **mesures de courant produites
par l'ESP32**, même en mode CAN lorsque le PC est éteint. Ce miroir de mesures
n'est pas l'enregistrement de toutes les trames circulant sur un bus CAN externe.
La mise en service CANalyzer est détaillée dans le fichier `README.md` voisin.

## 18. Ce que tu peux me transmettre après la préparation

Quand le Pi sera démarré, communiquer son modèle, son IP Ethernet ou son nom
qui fonctionne, ainsi que les sorties de :

```bash
hostname
hostname -I
nmcli device status
sudo systemctl status wattman-recorder --no-pager
```

**Ne pas transmettre ton mot de passe.** La configuration réseau USB éventuelle
et la validation réelle du montage pourront alors être adaptées à ton Pi.

## Références

- Préparation et démarrage du Pi : https://www.raspberrypi.com/documentation/computers/getting-started.html
- Commandes réseau `nmcli` : https://networkmanager.dev/docs/api/latest/nmcli.html
- Mode autonome Vector : https://support.vector.com/kb?id=kb_article_view&sysparm_article=KB0012397
