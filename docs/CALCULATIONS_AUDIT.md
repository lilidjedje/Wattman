# Vérification des calculs Wattman

Audit du 12 novembre 2026. Les tests portent sur les calculs logiciels et les
formules de référence disponibles dans ce dépôt. Les classeurs sources ne sont
pas tous exempts d'erreurs : voir les références cassées ci-dessous.

Dernière exécution : **29 suites sur 29 réussies**, avec 500 itérations et la
graine `20261112`. Les nouveaux contrôles ont effectué 182 364 comparaisons
de cellules Customer, 68 000 comparaisons DCDC/WLTC, 28 511 contrôles de
propriétés numériques et 816 comparaisons de formules sur 12 exports, auxquels
s'ajoutent les intégrales analytiques et les tests de référence existants.

## Relancer les vérifications

Installer les dépendances habituelles du projet (`npm ci` et
`python -m pip install -r requirements.txt`), puis, depuis la racine :

```powershell
npm run test:calculations
npm run test:all
```

Pour répéter davantage les cas numériques, ou changer les valeurs explorées :

```powershell
python tests/run_calculation_audit.py --all --iterations 500 --seed 20261112
python tests/run_calculation_audit.py --iterations 2000 --seed 42 --report outputs/calculation-audit-seed42/results.json
python tests/inspect_excel_references.py
```

Une même graine (`seed`) reproduit les mêmes entrées. Les erreurs indiquent le
cas, le calcul et les valeurs obtenues et attendues. Le nombre d'itérations agit
sur les tests numériques aléatoires. Les tests de référence et les douze exports
de dimensionnement gardent leur jeu de cas fixe.

Le lanceur produit `outputs/calculation-audit/results.json` et un journal par
suite. Il renvoie un code non nul si une suite échoue et continue les autres
vérifications. Chaque fichier de tests tourne dans son propre processus : les
serveurs Flask racine et mesure s'appellent tous les deux `app`, et leur import
dans un même processus provoquait des collisions sans rapport avec les calculs.
Les données des tests de services sont temporaires et les acquisitions simulées.

## Calculs contrôlés

| Domaine | Vérification indépendante | Tests |
| --- | --- | --- |
| Unités | A, mA, µA, décimales françaises, conversions aller-retour | `test_current_units.cjs`, `test_wattman_current.cjs`, `test_calculation_properties.cjs` |
| Courants de veille | Somme des courants × coefficients, contributions techniques/SmartMOS, sélection, migration des unités, Ah/j = µA × 24 / 10⁶ | `test_sleep_current.cjs`, `test_autonomy_current_contributions.cjs`, propriétés numériques |
| DM1 / DM2 | Capacité × écart de SOC, déduction des consommations fixes, réveils, TWT, vieillissement, fonctions personnalisées, autonomie et unités de durée | `test_dm_energy.cjs`, propriétés numériques |
| Customer / sans unplug / PIE | Lecture des vraies formules de `Consoveille.xlsx`, réévaluation indépendante en Python, comparaison des résultats et totaux intermédiaires avec le JavaScript | `test_excel_calculation_oracle.py`, `test_customer_autonomy.cjs` |
| DCDC / WLTC | Sommes pondérées Base et Upper dans les six tableaux, profils, modifications, suppressions et auxiliaires | `test_homologation_reference.py`, `test_homologation_properties.cjs`, `test_synthesis.cjs` |
| Exports de dimensionnement | Réévaluation des SUMPRODUCT et bilans en Ah sur 12 exports, listes vides, limites de capacité et ajouts de lignes au-delà des modèles | `test_sizing_calculations.py`, `test_dcdc_adaptations_export.py` |
| Biberonnage 30 / 90 jours | Références Excel quotidiennes, SOC, Q = I × t, Ah/Wh, événements périodiques et au seuil, consommations auxiliaires et acceptation de charge | `test_biberonnage.cjs`, propriétés numériques |
| Mesures et autonomie | Intégrale analytique d'un courant linéaire, bornes entre échantillons, changements de profil, lacunes d'acquisition et indépendance des canaux A/B | `test_autonomy_integration.py`, `test_measurement_dashboard.py`, `test_asc_analysis_audit.py` |
| Synthèse et sauvegarde | Cohérence des résultats sélectionnés, nombres exportés et durée propre à chaque rapport | tests de synthèse, d'exports et de routes existants |

L'oracle Excel utilise un interpréteur limité à l'arithmétique, aux références
de cellules et à SUM, MIN, MAX et SUMPRODUCT. Il refuse les constructions non
prises en charge. Il ne réutilise pas l'évaluateur JavaScript de l'application.
Les entrées liées à d'autres feuilles, hors du périmètre de l'oracle Customer,
proviennent des valeurs enregistrées dans le classeur. Les formules locales et
les sous-totaux PIE sont recalculés. Les comparaisons utilisent des tolérances
numériques explicites, sans arrondir le modèle pour faire passer les tests.

## Corrections apportées

- DM : les paramètres absents ou vides conservent leurs valeurs par défaut.
  Auparavant `Number('')` les transformait en zéro, notamment la période et les
  courants de réveil.
- DM : une période de réveil nulle ou négative désactive les réveils. Elle
  n'est plus remplacée par 0,0001 heure, ce qui créait une consommation excessive.
- Équilibrage : une période nulle ou négative donne une consommation nulle dans
  les calculs DM, Customer et les affichages associés, sans division par zéro.
- Courants et autonomies : prise en compte des espaces de regroupement français,
  y compris les espaces insécables, dans les convertisseurs numériques concernés.
- Analyse des mesures : un courant de profil explicitement nul reste nul. Seule
  une valeur absente utilise le courant nominal, pour les limites, pics et
  comparaisons individuelles.
- Analyse WLTC : couverture continue des 1 800 secondes, avec les bornes communes
  des trois profils. Les anciennes plages omettaient notamment 8,16–12,25 minutes.
- Tests existants : adaptation aux exports séparés par module, à la génération
  PDF native et à l'authentification du collecteur, sans désactiver celle-ci.

## Références Excel encore en erreur

`python tests/inspect_excel_references.py` inspecte les sept classeurs sources
sans les modifier. Les adresses, feuilles, formules et erreurs sont enregistrées
dans `outputs/calculation-audit/excel-source-inventory.json`.

Exemples constatés dans les sources, avant modification des données :

- `DCDC.xlsx` et `DCDC - Test calcul.xlsx` : `Bilan -7°C!AD105` et `AD107`
  contiennent directement `#REF!` dans leurs formules.
- `Consoveille.xlsx` : `Logistic Mode!F42` contient des références supprimées,
  avec propagation sur les cellules suivantes. Des erreurs existent également
  dans `Logistic Wo unplug`, `Customer Mode` et plusieurs feuilles de biberonnage
  ou d'essais historiques.
- `excel_templates/DCDC Test.xlsx` : 138 erreurs `#REF!` enregistrées dans
  `Profil Safety EV`.
- `Consoveille - Test Calcul.xlsx` : des milliers d'erreurs enregistrées,
  notamment `#REF!` et `#DIV/0!`. Ce fichier ne doit pas servir d'oracle global
  sans examiner les cellules utilisées.

Les tests valident les résultats applicatifs indiqués dans le tableau, pas
l'intégralité des feuilles historiques conservées dans les fichiers sources ou
recopiées dans certains exports. L'inventaire distingue les erreurs enregistrées
des références cassées présentes dans le texte des formules. Ce n'est pas un
recalcul complet par Microsoft Excel. Les références supprimées sans origine
identifiable restent à reconstruire depuis une version intacte ou une formule
métier confirmée. Le comportement du matériel ESP32/INA226 n'est pas validé par
ces tests logiciels.
