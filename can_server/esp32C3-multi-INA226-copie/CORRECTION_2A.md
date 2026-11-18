# Correction de plage 2 A — v12

Source : `Calibration_INA226_all.csv`, sept fenêtres de R1 entre 0 et 60 s.
Référence Fluke constante : 2,213300 A. Moyenne non pondérée des sept moyennes
INA : 2,574065286 A. Biais : +360,765286 mA. La moyenne est calculée comme
le biais des points de contrôle, pas comme la moyenne de toute l'acquisition.

Le CSV est interprété comme une acquisition de la voie A avec le firmware v11,
le même montage, les mêmes coefficients NVS et les mêmes réglages de mesure.
Le fichier ne contient pas ces métadonnées : vérifier ces conditions sur le banc.

## Application

La valeur du CSV comprend déjà le facteur de plage v11 de 1,031848.
L'entrée du nouveau point est donc 2,574065286 / 1,031848 = 2,494616732 A.
Son facteur est 2,213300 / 2,494616732 = 0,887230480.
Appliquer directement 2,213300 / 2,574065286 dans cette table serait incorrect.

Le facteur précédent reste strictement identique pour toute entrée de table
de module inférieur ou égal à 1,2 A (sortie v11 jusqu'à 1,2382176 A).
Les plages validées autour de 900 mA et 1 A sont donc préservées. Le facteur
est interpolé jusqu'au nouveau point, puis maintenu au-delà, selon la règle
existante de la table. Aucun saut n'est introduit. La voie B reste inchangée.

La transition et les valeurs supérieures ne sont pas validées physiquement.
La correction est symétrique en signe comme la table existante ; les courants
négatifs ne sont pas validés par ce CSV. Ce point unique ne démontre ni un
offset constant ni une erreur de gain globale. Il ne faut pas appliquer une
soustraction de 360,765 mA à toutes les mesures ni recalibrer le gain global
avec ce même facteur. Une modification de la calibration NVS ou du montage
nécessite de revalider les points de plage.

## Validation

`python tests/test_firmware_range_correction.py` compile et exécute sur le PC
la fonction C++ extraite du firmware : conservation exacte des petites plages,
relecture des sept fenêtres, continuité, monotonie, symétrie et voie B.
Sur les anciens points corrigés, l'écart résiduel est inférieur à 0,1 mA.
C'est une vérification numérique, pas une précision garantie du capteur.

Après compilation et téléversement de v12, refaire les acquisitions à 900 mA,
1 A et 2 A, puis tester des niveaux intermédiaires. La compilation du firmware
et les essais sur carte restent distincts du test C++ sur PC.

Le filtre et les temps de conversion sont inchangés. Le minimum Allan annoncé
ne justifie pas à lui seul « au-delà, la dérive domine » ni une fenêtre de
lissage pour des courants variables. Le CSV de points de contrôle ne permet
pas de recalculer cet Allan ; il faudrait les échantillons horodatés complets.

## v13 : même moteur sur les deux voies

La voie B utilise désormais sa propre table dans le même moteur d'interpolation
que A. Sa table vaut 1 tant qu'aucune campagne B n'est fournie. Le facteur CSV
de 1,1270690271 et les facteurs de plage A proviennent du capteur A ; ils ne
sont pas une formule physique commune et ne sont pas copiés sur B.
Les deux voies utilisent déjà la conversion shunt, le zéro par profil, le gain
NVS, la médiane, la moyenne glissante et le choix du temps d'intégration.
Leurs mémoires de filtrage et leurs coefficients de calibration sont séparés.
Le test C++ vérifie aussi l'identité des filtres A/B et l'absence de mélange
entre leurs états, aux quatre fréquences de profil.
