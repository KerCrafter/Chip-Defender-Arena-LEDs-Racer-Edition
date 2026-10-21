# Modules partagés du jeu

Ces fichiers sont inclus dans la page par `build.py` (`<script>/*@include src/…*/</script>`). Chacun a une seule responsabilité et ne connaît pas le reste du jeu.

| Fichier | Rôle | Ne sait rien de |
|---|---|---|
| `cda-codec.js` | Lire et écrire les formats de carte (CDA2, CDA3, CDA4) | Jeu, affichage, réseau |
| `world-store.js` | **Magasin du monde** : les formes en mémoire, rangées par bloc de 80 µm ; ajout et retrait d'un bloc sans rien reconstruire ; recherches spatiales (`each`, `at`) ; numéro fixe d'une forme (`gid` = bloc × 2¹⁸ + rang) | Affichage, réseau, règles du jeu |
| `world-worker.js` | **Fil de calcul des blocs** (Web Worker) : décompresse un bloc CDA4 et le prépare (formes en coordonnées de jeu, grille de recherche, ordre par sous-bloc d'affichage) hors de l'écran | Tout ce qui n'est pas la préparation d'un bloc |
| `gate-sim.js` | **Simulateur porte par porte** (solo) : déduit la fonction de chaque cellule SKY130 depuis son nom, la compile en petit programme (sans `eval`), propage la logique et fait avancer les bascules d'un cycle d'horloge | Affichage, carte, règles du jeu |

Côté page (`game.html`), les autres rôles s'appuient sur ces modules :

- **Chargement au fil du déplacement** (`streamTick`, `streamWork`) : décide quels blocs garder autour du joueur. En solo, sur une grande tuile, les blocs sont gardés à moins de 64 µm et retirés au-delà de 92 µm. Chaque image dispose d'un budget de quelques millisecondes.
- **Affichage 3D** (`chunkGen`, `dropChunks`) : un bloc arrivé s'affiche sous-bloc par sous-bloc, du plus proche au plus lointain, puis est libéré quand il est retiré.
- **Jeu** : les collisions, les tirs, les échelles et les véhicules interrogent le magasin (`WS.each`, `WS.at`). Les dégâts circulent sur le réseau par numéro fixe (`boxOut`, `boxIn`, `encD`, `decD`), donc tous les joueurs désignent la même forme, quel que soit l'ordre de chargement.

En multijoueur, la fenêtre du microscope est chargée d'un coup au début de la manche, avec la même découpe pour tous les joueurs.
