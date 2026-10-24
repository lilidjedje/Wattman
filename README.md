# Engineering Calculator — application bureau autonome

La version principale est maintenant une application Electron Windows. Elle
conserve les pages et calculs existants, utilise des fichiers projet JSON et
ne démarre aucun serveur HTTP.

## Prérequis

Python 3.11+ et Node.js/npm sont nécessaires. Installe les dépendances depuis
la racine du dépôt :

```powershell
python -m pip install -r requirements.txt
npm ci
```

## Lancer et générer le `.exe`

```powershell
npm start
```

Pour produire l'installateur Windows :

```powershell
python -m pip install pyinstaller
npm run dist
```

Le résultat est créé dans `dist/Engineering Calculator-Setup-2.0.0.exe`.
Les raccourcis `Ctrl+S` et `Ctrl+O` enregistrent et ouvrent l'intégralité d'un
projet au format JSON. La page « Analyse de logs » pilote directement
l'ESP32-C3 multi INA226, sans Raspberry Pi, via son adresse IP.

### Connexion ESP32-C3 / multi-INA226

1. Flasher le sketch
   `can_server/esp32C3-multi-INA226/esp32C3-multi-INA226.ino`.
2. Vérifier simplement que le Wi-Fi du PC est activé. L'application crée le
   profil `ESP32C3-Mesure` et s'y connecte automatiquement.
3. Ouvrir « Analyse de logs » pour arriver sur **CAN Measurement Workstation**,
   puis choisir la source :
   - **Mesure CAN** pilote l'ESP32-C3 et émet les mesures sur le bus CAN afin
     de les visualiser et de les enregistrer dans CANalyzer. Le fichier `.asc`
     obtenu peut ensuite être importé dans le dashboard.
   - **Mesure numérique** permet de renseigner séparément la fréquence et la
     durée des canaux A et B. Les deux compteurs et le dashboard se mettent à
     jour en direct ; un arrêt anticipé conserve toutes les mesures reçues.

Le MCP2515 est obligatoire uniquement en mode CAN. En mode numérique, les
valeurs INA226 sont envoyées directement vers le `.exe` sur le flux TCP local
`192.168.4.1:3333`, enregistrées dans la base puis proposées au dashboard sans
passer par le bus CAN et sans import `.asc`.

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
