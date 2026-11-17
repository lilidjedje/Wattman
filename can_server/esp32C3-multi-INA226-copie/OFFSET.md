# Suppression de l'offset INA226 (firmware v8 « robust-zero »)

## Pourquoi l'offset restait

Essai à vide du 17/11/2026, voie A, 100 Hz, Fluke ≈ 0,036 mA :

| Grandeur | Valeur | En codes ADC (R010, 0,25 mA/code) |
|---|---|---|
| Moyenne INA | −5,6 à −6,4 mA | ≈ −24 codes (≈ −59 µV) |
| σ par fenêtre | 5,5 à 6,6 mA | ≈ 24 codes |

La tare v7 refusait le zéro dès que l'écart-type **par échantillon** dépassait
0,5 mA (2 codes). Avec 6 mA de bruit, elle répondait 422 « Unstable readings » et
aucun zéro n'était enregistré : l'offset de −6 mA passait tel quel dans les mesures.
Ce bruit n'empêche pourtant pas d'estimer précisément le zéro : la moyenne de
1200 échantillons a une incertitude d'environ 6 / √1200 ≈ 0,17 mA.

## Ce que fait la v8

Courant appliqué : `I = (raw − zero[profil]) × 2,5 µV / Rshunt × gain`

1. **Un zéro par profil de conversion.** L'offset de l'INA226 varie avec le temps
   de conversion et le moyennage. Le firmware mesure un zéro pour chaque profil
   d'acquisition et applique celui du profil actif :
   ≤ 100 Hz (4 × 2,116 ms), ≤ 400 Hz (2,116 ms), ≤ 1000 Hz (588 µs), au-delà (204 µs).
2. **Estimateur robuste.** Pour chaque profil :
   - médiane `m`, `MAD = médiane|x − m|`, `σr = 1,4826 × MAD` ;
   - rejet des pics `|x − m| > 4 σr` (refus si plus de 5 % des points) ;
   - zéro = moyenne des points conservés. Le bruit sert de *dither* : le zéro est
     connu au-dessous d'un code ADC.
3. **Critère d'acceptation sur la moyenne, pas sur le bruit.**
   `SE = max(σ / √N, écart-type des 8 moyennes de blocs / √8)`. Le terme de blocs
   tient compte du bruit corrélé (secteur 50 Hz, Wi-Fi). Le profil 100 Hz exige
   SE ≤ 1 code (0,25 mA) ; sinon la calibration est refusée et rien ne change.
   Pour un profil rapide trop bruité, le firmware reprend le zéro du profil 100 Hz,
   et la réponse l'indique (`inherited_from_100Hz`).
4. **Contrôle de dérive.** La pente des moindres carrés sur la fenêtre de capture
   doit rester sous `max(2 codes, 3 σ √(12/N))`. Sinon il faut attendre la stabilité
   thermique.
5. **Gain** : la même capture robuste est utilisée. Le critère est SE ≤ 0,1 % de la
   référence (au minimum 1 code).

Les anciens coefficients (v1) sont migrés automatiquement : leur zéro est copié
sur les 4 profils. Le flux CAN/numérique, le timing et le format des trames ne
changent pas.

### Ce qui n'est volontairement pas fait

- **Pas de filtre passe-haut ni de suivi automatique du zéro.** Un offset est une
  composante continue : un filtre qui l'enlève supprime aussi un vrai courant
  continu. Ce serait masquer une mesure, pas corriger un capteur.
- **Pas de tare au démarrage**, car un courant réel serait pris pour un offset.
- **Pas de compensation en température** : la dérive de l'offset de l'INA226
  (0,02 µV/°C typ.) vaut environ 0,002 mA/°C sur R010, ce qui est négligeable ici.

## Procédure (PowerShell)

1. Laisser chauffer 10 min. Aucun courant dans le shunt (charge débranchée). Arrêter
   toute acquisition.
2. Tare des 4 profils, environ 28 s par voie :

```powershell
$esp = 'http://192.168.4.1'
Invoke-RestMethod -Method Post -Uri "$esp/api/calibration" -Body @{channel='A'; action='zero'} -TimeoutSec 60 | ConvertTo-Json -Depth 6
Invoke-RestMethod -Method Post -Uri "$esp/api/calibration" -Body @{channel='B'; action='zero'} -TimeoutSec 60 | ConvertTo-Json -Depth 6
```

   Lire `zero_mA` (≈ −6 mA attendu pour A), `se_mA`, `outliers` et `drift_mA`
   pour chaque profil. Le moniteur série affiche aussi une ligne `[CAL A P0] ...`
   par profil.
3. Une nouvelle tare remet le gain à 1 : refaire la référence avec le Fluke
   (courant stable, valeur lue en ampères) :

```powershell
Invoke-RestMethod -Method Post -Uri "$esp/api/calibration" -Body @{channel='A'; action='reference'; reference_A='0.29586'} -TimeoutSec 60
```

4. Vérifier : `Invoke-RestMethod "$esp/api/calibration" | ConvertTo-Json -Depth 6`,
   puis refaire la campagne d'offset de 60 s dans l'onglet Calibration. Résultat
   attendu : moyenne INA à 0 ± 0,3 mA (le σ reste ≈ 6 mA, c'est du bruit, pas de
   l'offset).

En cas de réponse 422, le message indique la cause (pics, dérive ou moyenne trop
incertaine) et les coefficients précédents sont conservés.

## Le bruit de 6 mA reste un sujet matériel

24 codes RMS, soit 60 µV, c'est environ 20 fois le bruit attendu de l'INA226 avec
ce réglage. L'offset de 59 µV dépasse aussi le maximum constructeur (10 µV). Ces
deux valeurs pointent vers le montage : prises Kelvin sur le shunt, boucle de masse
avec le Fluke en série, fils de puissance longs, couplage secteur ou Wi-Fi. Une tare
corrige la partie constante ; seul le câblage réduit le bruit. Le lissage du
dashboard (moyenne glissante) reste l'endroit où filtrer l'affichage.

Référence : https://www.ti.com/lit/ds/symlink/ina226.pdf
