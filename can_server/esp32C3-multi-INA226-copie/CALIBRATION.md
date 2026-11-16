# Calibration INA226 sur ESP32-C3

Cette version corrige la lecture et ajoute une calibration affine persistante par
voie : I = (raw - zero_raw) * 2,5 ?V / Rshunt * gain. Aucun coefficient n'est
d?duit des seules valeurs envoy?es dans la conversation. Il faut effectuer les
captures avec le capteur r?el et le multim?tre comme r?f?rence.

## Changements

- I?C ? 400 kHz dans toutes les fonctions, y compris apr?s l'affichage OLED.
- Lecture des octets MSB et LSB dans deux instructions distinctes.
- Erreurs I?C et saturation : ?chantillon non envoy?, compteur lost incr?ment?,
  affichage invalid?. Pas de z?ro ou de derni?re mesure inject?s ? leur place.
- ?criture de configuration v?rifi?e par relecture ; d?marrage refus? en cas
  d'?chec. Attente de stabilisation avant le d?marrage du timer.
- Conversion continue du shunt seul : ? 100 Hz, moyenne interne de 4 conversions
  de 1,1 ms ; jusqu'? 400 Hz, une conversion de 2,116 ms ; au-dessus, 588 ?s.
  Le registre de tension bus n'est plus actualis? dans ce mode.
- Calibration z?ro et gain stock?e en flash ; utilis?e en CAN et en num?rique.
- Capture de calibration : 128 observations distinctes, contr?le d'?cart-type,
  d'?tendue, de saturation, d'erreurs I?C et de coh?rence du gain (0,8 ? 1,2).
  Un gain hors limites n?cessite un diagnostic, pas un ajustement forc?.
- Refaire le z?ro invalide le gain pr?c?dent : refaire ensuite la r?f?rence.

## Proc?dure (PowerShell)

T?l?verser le sketch esp32C3-multi-INA226-copie.ino avec la cible ESP32-C3,
USB CDC activ?. Se connecter au Wi-Fi de l'ESP32. Arr?ter toute acquisition
avant chaque capture de calibration. Les appels ci-dessous sont ? effectuer
sur le PC connect? ? ce r?seau ; adapter l'adresse si n?cessaire.

```powershell
$inaBase = 'http://192.168.4.1'
Invoke-RestMethod "$inaBase/api/calibration"
```

1. Supprimer le courant dans le shunt (z?ro r?el), en conservant le capteur
   aliment? et le montage de mesure r?f?renc?. Capturer le z?ro :

```powershell
Invoke-RestMethod "$inaBase/api/calibration" -Method Post -Body @{
    channel='A'; action='zero'
}
```

2. Appliquer un courant constant et stable. Saisir la valeur r?ellement lue
   sur le multim?tre en **amp?res**, avec un point d?cimal. Par exemple,
   295,86 mA = 0.29586 A (adapter cette valeur ? la nouvelle lecture) :

```powershell
Invoke-RestMethod "$inaBase/api/calibration" -Method Post -Body @{
    channel='A'; action='reference'; reference_A='0.29586'
}
```

3. V?rifier que zero_calibrated et gain_calibrated sont true pour A.
   Relancer une acquisition ? 100 Hz, puis ? 1000 Hz. Comparer des moyennes
   sur une m?me dur?e avec le multim?tre et v?rifier s?par?ment l'?tendue
   des valeurs instantan?es. Lire i2c_errors et saturations avant et apr?s.
   Ces compteurs sont cumulatifs depuis le d?marrage.
4. V?rifier d'autres courants, notamment 100 mA, 300 mA, 1 A, puis les courants
   plus ?lev?s compatibles avec le module et le banc. Une r?f?rence unique
   corrige le gain, mais ne d?montre ni la lin?arit? ni la pr?cision partout.
5. Red?marrer l'ESP32 et v?rifier que les coefficients sont conserv?s.

Pour la voie B, remplacer channel='A' par channel='B'. B est configur?e pour
un R010 ? l'adresse 0x44 ; A pour un R010 ? l'adresse 0x40.
Pour annuler une calibration :

```powershell
Invoke-RestMethod "$inaBase/api/calibration" -Method Post -Body @{
    channel='A'; action='reset'
}
```

Une r?ponse 422 avec std_A et peak_to_peak_A signifie que les lectures restent
instables : aucun nouveau coefficient n'a ?t? appliqu?. Une r?ponse 503 indique
un probl?me de lecture ou de configuration I?C. Ne pas compenser ces d?fauts
avec un facteur arbitraire. Le flux existant conserve son format ; les erreurs
cr?ent des trous d'?chantillonnage, pas des faux courants.

## Limites physiques et validation au banc

| Voie | Shunt | Pas nominal de courant | Pleine ?chelle ADC positive |
|---|---|---|---|
| A | R010, 0,010 ohm | 250 ?A | environ 8,192 A |
| B | R010, 0,010 ohm | 250 ?A | environ 8,192 A |

La moyenne peut r?duire le bruit, mais ne garantit pas une pr?cision ? 100 ?A.
L'offset maximal de 10 ?V repr?sente 1 mA sur R010 avant calibration ; sa d?rive
et les erreurs thermiques restent pr?sentes apr?s calibration. Une gamme plus
sensible est n?cessaire pour garantir les petits courants. Le R100 am?liore la
sensibilit? mais ne couvre pas 8 A. Il faut plusieurs gammes pour couvrir la
plage demand?e avec une pr?cision d?finie.

? 8 A, le R010 dissipe 0,64 W : v?rifier la puissance admissible du vrai shunt,
les pistes, les borniers et l'?chauffement. La photo seule ne permet pas de
qualifier le module ? ce courant. La pleine ?chelle ADC ne garantit pas la
capacit? ?lectrique/thermique du module.

1000 ?chantillons/s est une cible logicielle ; le temps de conversion choisi
est compatible. Le d?bit r?ellement livr? doit ?tre mesur? avec le Wi-Fi,
l'?cran et les autres voies actifs. Une calibration obtenue ? 100 Hz corrige
le z?ro/gain commun, mais les caract?ristiques de bruit diff?rent ? 1000 Hz.
Le multim?tre int?gre plus longtemps : ses derni?res d?cimales ne constituent
pas un objectif de pr?cision pour chaque ?chantillon ? 1000 Hz.

Documentation mat?rielle : https://www.ti.com/lit/ds/symlink/ina226.pdf

## Correction du shunt B (16 novembre 2026)

Les deux modules ont un R010 (0,010 ohm). B utilise 0x44 et la meme conversion que A : 250 microamperes par point ADC avant correction zero/gain. Le R100 mentionne dans les anciennes versions etait une hypothese incorrecte. Les anciennes calibrations B sont ignorees ; refaire le zero puis la reference. La limite logicielle de reference est de 7,5 A pour les deux voies ; elle ne qualifie pas la puissance admissible du module. Verifier les courants maximaux sur le materiel reel.
