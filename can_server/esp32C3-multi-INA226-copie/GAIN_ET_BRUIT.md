# Correction du CSV 1 A et filtrage (v9)

Voie confirmee par l'utilisateur : A. CSV fourni : sept moyennes de fenetres,
reference Fluke constante 1,006600 A, moyenne des sept valeurs INA 0,893113 A.
Facteur relatif a la sortie deja calibree : 1,006600 / 0,893113 = 1,1270690271.
Les points sont ponderes egalement comme le biais du tableau de calibration ;
ce n'est pas la moyenne de l'enregistrement complet (points bruts non fournis).

Le facteur CSV_OUTPUT_SCALE est applique uniquement a A, apres le zero et le
gain NVS existants. B reste a 1. Il suppose que les coefficients NVS et le
montage sont les memes que pour le CSV. Ne pas importer le meme facteur une
seconde fois dans la calibration NVS. Une nouvelle calibration reference mesure
les ADC bruts et remplace le gain en tenant compte du facteur CSV au denominateur.
Les zeros par profil et la calibration robuste existants sont conserves.

Ce point unique ne permet pas de separer erreur de gain et erreur d'offset.
Il ne valide pas la linearite a d'autres courants. L'ancienne capture a zero
n'est pas combinee avec ce CSV : les conditions et coefficients ont pu changer.
La correction ramene la moyenne des sept anciens points a 1,006600 A, mais les
points corriges restent environ entre 0,987158 et 1,013637 A.

## Filtre causal par voie

1. Mediane glissante des trois derniers echantillons : rejette un pic isole.
2. Moyenne glissante de ceil(frequence * 20 ms) echantillons, maximum 40.

| Frequence | Moyenne (echantillons) | Retard approx. mediane + moyenne |
| --- | --- | --- |
| 100 Hz | 2 | 15 ms |
| 400 Hz | 8 | 11,25 ms |
| 500 Hz | 10 | 11 ms |
| 1000 Hz | 20 | 10,5 ms |
| 2000 Hz | 40 | 10,25 ms |

La mediane est non lineaire : son retard depend du signal. Aux tres faibles
frequences, son retard d'environ un echantillon devient significatif.
Le filtre est remis a zero avant chaque acquisition, sans remplissage par des
zeros artificiels. Chaque mesure valide produit une valeur de sortie, sans
attente ajoutee ni decimation. CAN et numerique utilisent la meme valeur filtree.
Les pics correspondant a de vrais evenements courts sont aussi attenues.

Les profils de conversion materielle restent identiques : les changer rendrait
les zeros par profil deja calibres moins fiables. Les mesures ADC brutes restent
utilisees pour la calibration, sans filtre logiciel. Les flux existants et donc
les graphiques nommes « Brut » recoivent desormais le courant filtre : ce libelle
ne signifie plus « ADC non filtre ». Aucun nouveau canal brut n'est ajoute au
protocole. CURRENT_FILTER_ENABLED=false permet de comparer sans filtre logiciel.

Le filtrage preserve la cadence demandee mais pas la bande passante du signal.
Il ne garantit pas l'absence de pertes de transport : verifier les compteurs,
les horodatages et la completude sur carte. L'API existante limite la somme des
frequences A+B a 2000 Hz. L'ecart-type affiche apres filtrage mesure la dispersion
de la sortie filtree, pas le bruit intrinseque de l'ADC.

La distribution de bruit est asymetrique sur la capture : une mediane peut en
deplacer la moyenne. Refaire une comparaison au Fluke apres filtrage, puis verifier
le zero et plusieurs courants. Aucun logiciel ne garantit un ecart nul a partir
de sept moyennes et sans nouveau test physique.
