# Deux écrans sur le même ESP32-C3 : OLED et TFT couleur

## Matériel et version

- Premier écran : OLED SH1106 déjà raccordé en I²C sur GPIO8/GPIO9.
- Deuxième écran : référence fournie `1005012718734000`, identifiée comme
  TFT SPI ST7735S 1,44 pouce, 128 × 128 pixels. C'est un LCD couleur, même si
  on l'appelle parfois OLED par habitude.
- Broches confirmées par l'utilisatrice, dans l'ordre :
  `LED SCK SDA A0 RESET CS GND VCC`.
- Firmware à compiler : `esp32C3-multi-INA226-copie.ino`, version
  `dual-display-v5`, avec le fichier voisin `wattman_tft.h`.

La page AliExpress n'était pas accessible directement. L'identification du
contrôleur et de la résolution provient de la référence retrouvée ; le
branchement ci-dessous suit les huit étiquettes confirmées. La variante de
dalle, son orientation et la luminosité restent à vérifier sur le matériel.

## Branchement exact prévu par le firmware

**Débrancher l'alimentation du prototype avant de raccorder les fils.**
Les nombres ci-dessous sont les **numéros GPIO**, pas la position des broches
sur le connecteur de la carte ESP32-C3.

| Position donnée | Broche du TFT | Raccorder à | Rôle |
|---|---|---|---|
| 1 | LED | 3V3 via une résistance série de 100 Ω | Rétroéclairage allumé en permanence |
| 2 | SCK | GPIO4 | Horloge SPI, partagée avec le MCP2515 |
| 3 | SDA | GPIO6 | Données SPI MOSI, partagées avec le MCP2515 |
| 4 | A0 | GPIO1 | Sélection données/commandes, aussi appelée DC |
| 5 | RESET | GPIO3 | Réinitialisation matérielle du TFT au démarrage |
| 6 | CS | GPIO0 | Sélection du TFT, indépendante du CS CAN |
| 7 | GND | GND de l'ESP32 | Masse commune |
| 8 | VCC | 3V3 de l'ESP32 | Alimentation du module |

La résistance de 100 Ω est une connexion prudente pour limiter le courant du
rétroéclairage lorsque son circuit intégré au module n'est pas documenté.
Elle peut réduire la luminosité. Ne pas alimenter LED directement depuis un
GPIO. La possibilité de modifier cette résistance dépend du module réel.

La notice LCDWIKI du MSP1443, de brochage identique, autorise LED directement
sur 3,3 V pour un éclairage permanent. Ce n'est pas une identification certaine
du module AliExpress : vérifier le marquage ou une photo du dos avant de
conclure que la résistance externe est inutile sur cet exemplaire.
Notice : https://www.lcdwiki.com/res/MSP1443/1.44inch_SPI_Module_MSP1443_User_Manual_EN.pdf

Les niveaux de signaux sont en **3,3 V**. Ne pas injecter 5 V sur les GPIO.
Si la dalle ne s'initialise pas avec VCC à 3,3 V, vérifier son régulateur et sa
documentation avant de changer sa tension ; le brochage seul ne précise pas
le circuit d'alimentation du module.

Deux pièges de noms :

- `SDA` sur ce TFT signifie **MOSI SPI** : ne pas le relier au SDA I²C GPIO8.
- `A0` sur le TFT signifie **DC** : le relier à GPIO1, pas à GPIO0.

## Ce qui reste branché comme avant

| Élément | Broches ESP32-C3 |
|---|---|
| OLED SDA / SCL | GPIO8 / GPIO9 |
| INA226 SDA / SCL | GPIO8 / GPIO9, bus I²C commun protégé |
| MCP2515 SCK / MOSI / MISO | GPIO4 / GPIO6 / GPIO5 |
| MCP2515 CS | GPIO7 |
| MCP2515 INT | GPIO10 |
| USB natif | GPIO18 / GPIO19, ne pas raccorder le TFT dessus |

Le TFT n'a pas de sortie MISO à raccorder. Les fils GPIO4 et GPIO6 vont donc
à la fois au TFT et au MCP2515. Leurs CS sont distincts : TFT GPIO0, CAN GPIO7.
Toutes les masses doivent être communes.

## Ce que montre chaque écran

### OLED existant

L'orientation du SH1106 est maintenant inversée de 180° (`setFlipMode(1)`)
pour corriger le sens constaté sur le prototype. Cette modification prend
effet après téléversement du nouveau firmware.

Pendant une mesure **numérique**, il affiche les valeurs des canaux configurés
à partir de la dernière mesure disponible, une fois par seconde. L'acquisition
conserve sa propre fréquence : l'OLED ne limite pas les mesures à 1 Hz.

- À partir de 1 A en valeur absolue : affichage en A.
- Entre 1 mA inclus et 1 A : affichage en mA.
- En dessous de 1 mA : affichage en `uA`, notation ASCII de µA.

Le changement d'unité ne modifie ni le courant mesuré ni la précision des INA226.
Le signe du courant est conservé. Le canal non configuré n'est pas affiché.

Pendant une mesure **CAN**, il affiche, sur plusieurs lignes :

> Ouvrez CANalyzer pour visualiser les valeurs de courants

### TFT couleur

| Action dans l'application | Message / affichage TFT |
|---|---|
| Ouvrir le choix du mode d'analyse d'un projet | Bonjour [Pilot Wattman], bienvenue sur le projet [nom] |
| Entrer dans Analyse des logs | Choisissez une méthode de mesure |
| Cliquer sur mesure numérique | Vous avez choisi mesure numérique |
| Cliquer sur mesure CAN | Vous avez choisi mesure CAN |
| Ouvrir l'acquisition numérique | Veuillez vous connecter au Wi-Fi esp32_mesure avant de démarrer une mesure |
| Ouvrir l'acquisition CAN | Même consigne Wi-Fi, puis une page demandant d'activer l'enregistrement sur CANalyzer |
| Démarrer une mesure | Cartes des canaux configurés, fréquence demandée, temps restant et barre de progression |
| Fin d'un canal | Carte de ce canal en vert avec « Canal terminé » ; l'autre continue son décompte |
| Arrêter manuellement un canal | Carte marquée « Canal arrêté » en orange |
| Fin de l'ensemble | Titre « MESURE TERMINEE » et états des canaux conservés |

Le nom du Wattman vient du champ **Pilot Wattman** du projet. Le nom du projet
vient de son champ **Nom**. Ces noms sont limités à 64 caractères dans le
message transmis à l'ESP32.

Le TFT utilise un fond sombre, du texte clair, du cyan pendant l'acquisition,
du vert pour les canaux terminés et de l'orange pour les arrêts manuels.
Le rendu est calculé sur un canevas de 128 × 128 pixels ; les marges et
emplacements des cartes sont fixes. Seules les bandes modifiées sont envoyées
au TFT pour réduire le clignotement et l'occupation du bus SPI.

Les longs textes et noms passent sur plusieurs pages, renouvelées toutes les
6 secondes, avec un indicateur de page. Les principaux accents français sont
convertis pour la police de l'écran ; certains caractères rares sont remplacés.

Le TFT reçoit les étapes de navigation seulement si l'application peut joindre
l'ESP32, directement ou via le Pi. Sans liaison, l'application reste utilisable
et réessaie le dernier message tant que la page reste ouverte. Aucun écran
relié uniquement à l'ESP32 ne peut connaître un clic effectué sur un PC isolé.
Les messages de navigation ne remplacent pas le suivi d'une mesure déjà active.

Avec le collecteur autonome Raspberry Pi, c'est le **Pi** qui doit être relié
au Wi-Fi `esp32_mesure`. Le PC reste sur le réseau permettant de joindre le
Pi ; il n'a pas à quitter ce réseau pour se connecter directement à l'ESP32.

## Démarrage et reconnexion de l'alimentation

À chaque démarrage électrique de l'ESP32, le firmware :

1. Initialise les CS des périphériques SPI.
2. Réinitialise le TFT par sa broche RESET.
3. Charge le mode ST7735 128 × 128, la rotation et le format couleur.
4. Sort le contrôleur de veille et active l'affichage.
5. Affiche le dernier accueil projet mémorisé, ou un message d'écran prêt.

Le projet et le pilote sont mémorisés lorsque l'accueil projet est reçu. Les
écritures ne sont pas répétées si les noms n'ont pas changé. Après une coupure
d'alimentation, un ancien essai n'est pas affiché comme s'il était toujours actif.

Le rétroéclairage est alimenté depuis 3V3. Il ne dépend donc pas d'un GPIO ni
de la fin d'une mesure. Le firmware réaffirme régulièrement l'allumage du TFT.

Cette initialisation vise le débranchement/rebranchement **de tout le prototype**.
Couper uniquement l'alimentation du TFT en laissant l'ESP32 actif est un autre
cas : le TFT n'a pas de liaison de retour permettant de détecter sa perte d'état.
Une coupure du prototype interrompt aussi une acquisition en cours.

## Bibliothèques et compilation

Avec Arduino IDE, sélectionner **ESP32C3 Dev Module**, activer **USB CDC On Boot**,
puis installer dans le gestionnaire de bibliothèques :

- U8g2 ;
- mcp_can ;
- Adafruit ST7735 and ST7789 Library ;
- Adafruit GFX Library et Adafruit BusIO, dépendances proposées à l'installation.

Garder `wattman_tft.h` dans le même dossier que le `.ino`. Ne pas compiler
l'ancien sketch S3, dont les broches sont différentes.

La constante `TFT_ROTATION` dans `wattman_tft.h` vaut 0. Les valeurs 1, 2 et 3
permettent les autres orientations. Si l'image est décalée ou les couleurs
incorrectes, vérifier la variante de dalle avant de changer arbitrairement les
offsets ou le câblage : `INITR_144GREENTAB` est le profil initial retenu.

## Essais à effectuer sur le matériel

1. Couper l'alimentation, brancher le TFT selon le tableau, puis vérifier tous
   les fils avant remise sous tension.
2. Téléverser `dual-display-v5`, puis vérifier le message de démarrage.
3. Couper et remettre l'alimentation du prototype trois fois. Le TFT et
   l'OLED doivent repartir à chaque fois sans bouton RESET manuel.
4. Ouvrir un projet avec un nom long et un nom accentué. Vérifier les pages,
   les marges et les accents.
5. Parcourir les étapes numérique et CAN et contrôler chaque message.
6. Démarrer A seul en numérique : seuls les courants de A et la carte TFT A
   doivent apparaître. Refaire avec B seul.
7. Démarrer A pendant 10 secondes et B pendant 20 secondes : A doit rester
   affiché terminé pendant le décompte de B.
8. Vérifier le changement d'unité sur l'OLED avec les courants disponibles.
9. Refaire en CAN : le TFT garde le suivi, l'OLED demande d'ouvrir CANalyzer.
10. Vérifier la fréquence réellement reçue et les pertes avec les deux écrans
    actifs, au débit utilisé pour les essais réels.

Une compilation réussie ne prouve pas le câblage, la luminosité, les couleurs
ni la stabilité électrique du prototype. Ces points nécessitent ces essais.

## Références

- Référence utilisateur : https://fr.aliexpress.com/item/1005012718734000.html
- Pilote Adafruit ST7735 : https://github.com/adafruit/Adafruit-ST7735-Library
