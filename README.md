# Wattman — Engineering Calculator

## Prototype actuel : ESP32-C3 et deux écrans

Le firmware du prototype est
[`esp32C3-multi-INA226-copie.ino`](can_server/esp32C3-multi-INA226-copie/esp32C3-multi-INA226-copie.ino),
version `dual-display-v5 | oled-flip-180`. Garder `wattman_tft.h` dans le même
dossier. Il gère l'OLED SH1106 sur GPIO8/GPIO9 et le TFT couleur 128×128 sur
le SPI partagé avec le MCP2515. Son réseau Wi-Fi est **esp32_mesure**.

- [Branchement des deux écrans et vérifications du prototype](can_server/esp32C3-multi-INA226-copie/BRANCHEMENT_TFT_ST7735.md)
- [Installation Raspberry Pi expliquée pour débutante](desktop/raspberry/GUIDE_DEBUTANTE.md)
- [Collecteur autonome : fonctionnement et limites](desktop/raspberry/README.md)

Le firmware est compilé et téléversé sur le prototype. Le rendu des écrans et
l'installation sur le Raspberry Pi restent à valider sur le matériel.

La version principale est maintenant une application Electron Windows. Elle
conserve les pages et calculs existants, utilise des fichiers projet JSON et
ne démarre aucun serveur HTTP.

## Installer et lancer l'application sur un autre PC Windows

Installe d'abord **Git**, **Python 3.11 ou plus récent** et **Node.js** (qui
inclut npm). Puis ouvre PowerShell et exécute :

```powershell
git clone https://github.com/lilidjedje/Wattman.git
cd Wattman
python -m pip install -r requirements.txt
```

Pour compiler et lancer sur PC Renault : 

```powershell
npm ci
npm start
```

sinon : 
Set-Location 'E:\Wattman-main\Wattman-main'
Remove-Item -LiteralPath .\node_modules -Recurse -Force
npm ci

Ces étapes installent les dépendances et lancent l'application depuis les
sources. Elles sont à refaire sur chaque nouveau PC.

## Générer l'installateur Windows

```powershell
python -m pip install pyinstaller
npm run dist
```

L'installateur est créé dans `dist/Engineering Calculator-Setup-2.0.0.exe`.
Tu peux le transférer sur le PC cible et l'exécuter pour installer
l'application, sans y lancer `npm start`.
Les raccourcis `Ctrl+S` et `Ctrl+O` enregistrent et ouvrent l'intégralité d'un
projet au format JSON. La page « Analyse de logs » pilote directement
l'ESP32-C3 multi INA226, sans Raspberry Pi, via son adresse IP.

> **Important :** GitHub contient le code source et les fichiers nécessaires
> au build, mais pas les bases de mesures, les projets de test, les données
> importées ni les exécutables générés. Transfère séparément les projets ou
> données que tu veux retrouver sur le nouvel ordinateur.

### Connexion ESP32-C3 / multi-INA226

1. Flasher le sketch
   `can_server/esp32C3-multi-INA226-copie/esp32C3-multi-INA226-copie.ino`
   avec le fichier voisin `wattman_tft.h`.
2. Vérifier simplement que le Wi-Fi du PC est activé. L'application crée le
   profil `esp32_mesure` et s'y connecte automatiquement.
3. Ouvrir « Analyse de logs » pour arriver sur **CAN Measurement Workstation**,
   puis choisir la source :
   - **Mesure CAN** pilote l'ESP32-C3 et émet les mesures sur le bus CAN afin
     de les visualiser et de les enregistrer dans CANalyzer. Le fichier `.asc`
     obtenu peut ensuite être importé dans le dashboard.
   - **Mesure numérique** permet de renseigner séparément la fréquence et la
     durée des canaux A et B. Les deux compteurs et le dashboard se mettent à
     jour en direct ; un arrêt anticipé conserve toutes les mesures reçues.
     L'écran SH1106 affiche les courants de chaque canal actif, leur temps
     restant, puis « Mesure finie ».

À l'ouverture de la workstation, le SH1106 affiche « Hello ! Paramétrez votre
mesure ». Il indique ensuite le mode sélectionné et, en mode CAN, demande
d'activer l'enregistrement sur CANalyzer. Ces messages nécessitent le
téléversement du sketch principal.

Le réseau Wi-Fi à rechercher est **esp32_mesure**, mot de passe
**ina226mesure**. Une fois connecté, ouvrir `http://192.168.4.1` pour vérifier
l'accès à l'ESP32. Accepter de rester connecté même si Windows indique
« Pas d'Internet ».

Le firmware démarre le point d'accès avant les périphériques externes et
vérifie sa création (nouvelle tentative toutes les 2 secondes en cas d'échec).
Le MCP2515 est initialisé uniquement au démarrage d'une mesure CAN.
Après cette modification, téléverser à nouveau le sketch principal indiqué
ci-dessus et redémarrer la carte. Le moniteur série à **115200 bauds** doit
afficher `[WIFI] Point d'acces visible : esp32_mesure` ou l'erreur de démarrage.
Attention : l'ancienne copie sous `can_server/can_server_deploy/` utilise le
Wi-Fi du Raspberry Pi et ne crée pas ce point d'accès.

Le MCP2515 est obligatoire uniquement en mode CAN. En mode numérique, les
valeurs INA226 sont envoyées directement vers le `.exe` sur le flux TCP local
`192.168.4.1:3333`, enregistrées dans la base puis proposées au dashboard sans
passer par le bus CAN et sans import `.asc`.

En mode CAN, sélectionner le quartz **8 MHz ou 16 MHz** réellement monté sur
le MCP2515 ; ce réglage est distinct du débit du bus, fixé à **500 kbit/s**.
Le firmware ne change plus de quartz après un échec d'émission. Une première
trame sans acquittement n'annule plus l'acquisition : CANalyzer/CANoe peut
être démarré pendant la mesure. Les compteurs d'envois confirmés et d'échecs
sont affichés dans l'écran d'acquisition. La correction nécessite de
téléverser à nouveau le sketch principal sur l'ESP32-C3.

---

# Ancien mode Web (conservé pour compatibilité)

Une application web intuitive pour importer et afficher les données des fichiers Excel.

## Fonctionnalités

✅ **Import facile** - Cliquez ou glissez un fichier Excel (.xlsx ou .xls)
✅ **Affichage graphique** - Visualisez tous les tableaux de manière claire et intuitive
✅ **Multi-feuilles** - Support complet des fichiers Excel avec plusieurs feuilles
✅ **Navigation fluide** - Basculez facilement entre les différentes feuilles
✅ **Export CSV** - Exportez chaque tableau en CSV
✅ **Interface responsive** - Fonctionne sur tous les appareils (desktop, tablet, mobile)

## Lancer le mode Web historique

```bash
python app.py
```

L'application sera accessible à: **http://localhost:5000**

Les dépendances Python sont les mêmes que pour l'application Electron.

### Étapes d'utilisation

1. **Accédez à la page d'importation** - Ouvrez http://localhost:5000/import_project

2. **Importez un fichier Excel**
   - Cliquez sur la zone de dépôt ou glissez un fichier Excel
   - Le fichier doit être au format .xlsx ou .xls

3. **Visualisez les données**
   - Les tableaux s'affichent automatiquement après l'importation
   - Naviguez entre les feuilles avec les onglets en haut
   - Chaque tableau affiche le nombre de lignes

4. **Actions supplémentaires**
   - Cliquez sur "Exporter CSV" pour télécharger la feuille actuelle
   - Cliquez sur "Retour" pour importer un autre fichier

## Architecture

```
Wattman/
├── app.py                 # Application Flask et point d'entrée du backend
├── desktop/               # Application Electron et scripts de build
├── can_server/            # Mesures CAN, collecteur et firmware ESP32
├── static/                # JavaScript et styles de l'interface
├── templates/             # Pages HTML
├── tests/                 # Tests automatisés
├── package.json           # Dépendances et commandes Electron
└── requirements.txt       # Dépendances Python portables
```

## Fichiers HTML

### import_project.html
- Page d'accueil avec zone de dépôt pour les fichiers
- Interface utilisateur intuitive avec feedback visuel
- Gestion des erreurs claire et informative

### display_excel.html
- Affichage des données en tableaux interactifs
- Onglets pour naviguer entre les feuilles
- Recherche intégrée (prête pour une future amélioration)
- Export en CSV par feuille

## API Endpoints

### GET /
Redirige vers `/import_project`

### GET /import_project
Affiche la page d'importation du fichier Excel

### POST /upload
Traite l'upload du fichier Excel
- Paramètre: `file` (multipart form data)
- Réponse: JSON avec les données du fichier

### GET /display
Affiche la page d'affichage des données

## Limitations

- Taille maximale des fichiers: 50 MB
- Formats supportés: .xlsx et .xls
- Les données sont chargées dans sessionStorage (temporaire, pendant la session)

## Améliorations futures possibles

- Persistance des données (base de données)
- Filtrage et tri avancés
- Graphiques et visualisations
- Export en PDF
- Support des formules Excel
- Synchronisation avec le serveur

## Support des formats

✅ Excel 2007-2019 (.xlsx)
✅ Excel 97-2003 (.xls)

## Notes

- Les fichiers uploadés sont stockés dans le dossier `uploads/`
- Les données sont conservées en mémoire pendant la session active
- La session réinitialise lors du rafraîchissement de la page

## Licence

Ce projet est fourni à titre d'exemple.

---

**Version:** 2.0



Fait en sorte dans les mesures numériques que les excels de mesure numérique respecte bien le nombre de mesures par secondes en fonction de la fréquence d'acuquositon et que pour chaque canal A et B respecte date et heure de chaque mesure (d'ailleurs dans l'excel mets date et heure de chaque mesure et mesure en mA ou en A ou en micro A et la fréquence d'acquisiton réelle à ce moment la (pas d'autres lignes)). et je veux que le chemin des excel soit dans le projet wattman main 

Pour la partie excel, j'ai lancé un test de 1000 Hz et pourtant je n'ai que 3000 lignes alors que je suis censé avoir 1000 mesures par seconde (une ligne par mesure), rectifie ca 

enlève en haut de import dashboard nombre de mesures totales

Je veux que mon analyse puisse prendre en compte tout mes fichiers .asc sans limite de 3, meme s'il y en a des centaines. 

dans les tableaux canal A et canal B enlève les colonne noms du fichiers sour ce, et en bas des tableaux la ou on peut changer de pages, je veux pouvoir changer de page recevin à la précédente, mais aussi pouvoir choisir vers quelle page aller sur (nombre de pages totals apparent )

je n'ai aucun bouton ou je peux enregistrer mes dashboards, ajoute le et fait en sorte que les enregistrements de dashboard fonctionnent (meme quand on eteint et se reconnecte au projet)
