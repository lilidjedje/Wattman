# Design system Renault Engineering — Wattman

Couche visuelle chargée par toutes les pages (sauf `export_synthesis_pdf.html`, qui
produit les PDF officiels et reste inchangée). Elle ne modifie aucun calcul, aucune
donnée et aucune règle métier.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `static/design-system/tokens.css` | Tokens : couleurs, typographie, espacements, rayons, ombres, mouvement, thèmes clair/sombre |
| `static/design-system/components.css` | Surcouche des composants existants (cartes, boutons, formulaires, sommaire, dialogues, tableaux), barre d'application, outils graphiques et tableaux |
| `static/design-system/rg-ui.js` | Thème (`rg-theme`), animations réduites (`rg-motion`), barre d'application, apparitions progressives |
| `static/design-system/rg-charts.js` | Plugin Chart.js global : thème, réticule, zoom/déplacement, export PNG/CSV |
| `static/design-system/rg-grid.js` | Data grid progressif sur les tableaux en lecture seule |
| `static/design-system/rg-hero3d.js` | Scène 3D filaire de l'accueil (Canvas 2D, sans dépendance) |

Ordre de chargement : feuilles historiques → `tokens.css` → `components.css`.
`rg-charts.js` est inséré juste après chaque librairie Chart.js.

## Identité

Source : Brandhub Renault Group (page publique consultée le 2026-11-15). La palette
primaire y est décrite comme « noir et blanc », avec du gris minéral. Aucun code
couleur n'y est publié en texte. Les valeurs de `tokens.css` sont donc une
interprétation **à faire valider par la charte officielle**.

- Le jaune (`--rg-accent` / `--rg-yellow`) est un accent unique et rare (filets,
  état actif, focus en thème sombre). Le Brandhub ne le mentionne pas. Il se
  modifie dans `tokens.css` uniquement.
- La police Renault Group est propriétaire et réservée à un usage interne. Elle
  n'est pas embarquée. Pile utilisée : Segoe UI Variable → Segoe UI → Arial (fallback
  indiqué par le Brandhub).
- Le logotype et le monogramme Renault ne sont pas reproduits. La marque de la
  barre d'application est un pictogramme original.

## Règles de données (non négociables)

1. Les classes `.xl-*` (`static/excel-colors.css`) gardent leurs couleurs Excel. Les
   tableaux restent une « feuille » claire, y compris en thème sombre.
2. Graphiques : le zoom et le déplacement ne changent que les bornes d'affichage.
   L'export CSV écrit les valeurs sources, avant toute décimation Chart.js
   (`dataset._data`), sans arrondi.
3. Décimation : le backend réduit les séries de mesure à 4 000 points maximum par
   min/max (`can_server/app.py`, `decimate_chart_points`). Les extrêmes et les
   premier et dernier points sont conservés. Aucune décimation supplémentaire n'est
   ajoutée côté design system.
4. Data grid : tri, filtre et masquage agissent sur l'affichage. « Ordre d'origine »
   (ou le 3e clic sur l'en-tête) restaure l'ordre exact. Le texte, les classes et les
   styles des cellules ne sont jamais modifiés.

## Data grid — activation

Activation automatique quand un tableau remplit toutes ces conditions : une seule
ligne d'en-tête, aucune cellule fusionnée, aucun champ de saisie dans le corps,
au moins 4 lignes.
Pour forcer : `data-rg-grid="on"`. Pour exclure : `data-rg-grid="off"`.

Fonctions : recherche globale, tri 3 états (nombres au format FR reconnus, vides en
bas), masquage et redimensionnement des colonnes, densité, en-tête fixe, sélection
(Ctrl/Maj + clic), copie au format tableur, export CSV (sélection ou vue filtrée).
Les préférences sont enregistrées par page et par tableau (`localStorage`, clé
`rg-grid:*`).

## Graphiques — interactions

| Geste | Effet |
| --- | --- |
| Molette | Zoom horizontal autour du curseur |
| Alt + molette | Zoom vertical |
| Glisser (une fois zoomé) | Déplacement |
| Maj + glisser | Sélection d'une plage |
| Double-clic / bouton ↺ | Vue initiale |
| Survol | Réticule et coordonnées exactes sur les axes |

Le dashboard de mesure (`can_server/templates/dashboard.html`) garde sa propre
navigation. Le plugin n'ajoute que le thème, le réticule et les exports.
Pour désactiver le plugin sur un graphique : `options.plugins.rgStudio = false`.

## Accessibilité et mouvement

- `prefers-reduced-motion` et le bouton « Animations réduites » de la barre
  coupent les transitions, les apparitions et la rotation 3D (image fixe).
- Transitions de page : View Transitions natives de Chromium (fondu de 140 à
  220 ms).
- Focus visible sur tous les contrôles. Les en-têtes triables sont accessibles au
  clavier (Entrée / Espace).

## Tests

```powershell
npx electron tests/electron_design_system.cjs            # non-régression visuelle et données
npx electron tests/visual/capture_screens.cjs --out=outputs/screens [--theme=dark] [--only=home,synthesis]
```

Sous VS Code, lancez `$env:ELECTRON_RUN_AS_NODE=$null` avant ces commandes : le
terminal intégré définit cette variable, et Electron démarre alors en mode Node.
