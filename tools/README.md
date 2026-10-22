# Cartes Tiny Tapeout pour Chip Defender Arena

`cda_maps.py` télécharge les layouts des projets Tiny Tapeout et les convertit en cartes du jeu.
Il tourne sur ton PC, aussi longtemps qu'il faut, et reprend là où il s'est arrêté.

## Installation (une fois)

- Python 3.9 ou plus récent, et git
- `pip install gdstk numpy pyyaml`

## Lancer

Depuis la racine du dépôt du site (celui qui contient `index.html`) :

```
python3 tools/cda_maps.py --out .
```

Par défaut il traite toutes les navettes SKY130 : tt03p5, tt04, tt05, tt06, tt07, tt08, tt09, ttsky25a, ttsky25b.
Pour en choisir : `--shuttles tt06,tt07`. Pour aller plus vite : `--jobs 6` (chaque conversion d'un grand
projet peut prendre 2 à 4 Go de mémoire : garde une marge).

Il écrit :

- `maps/shuttles.json` : la liste des navettes, que l'écran du MUX propose
- `maps/<navette>/index.json` : le plan de la puce et ses projets
- `maps/<navette>/a<adresse>.bin` : une carte par projet

Le dossier de travail `cda_work/` (dépôts clonés) peut être supprimé à la fin ; il ne faut pas le publier.

## Publier

```
git add maps
git commit -m "Cartes des navettes Tiny Tapeout"
git push
```

GitHub Pages sert les cartes dès que le site est reconstruit. Les navettes apparaissent dans un sélecteur en
haut de l'écran du MUX ; chaque carte n'est téléchargée que lorsqu'on la choisit.

## À savoir

- Compte à peu près 50 à 80 Mo de cartes par navette. GitHub conseille de garder un dépôt sous 1 Go.
- Les navettes IHP et GlobalFoundries utilisent d'autres couches de fabrication : elles ne sont pas prises en charge.
- Quand une navette n'a pas de plan officiel (`docs/images/chip_map.svg`), le MUX montre un plan schématique
  rangé par adresse.
- Un projet sans layout dans le dépôt de la navette reste grisé.

## code_tuiles.py — fiches « code » des tuiles (outils d'exploration en solo)

Pour chaque projet Verilog d'une ou deux tuiles (SKY130, IHP, GF180) : relie chaque cellule du dessin à son module et à
la ligne du code source qui la produit, et exporte la liste des connexions pour la simulation en jeu (banc de test,
sonde de fil, oscilloscope). Sur le PC : double-cliquer `fiches-code.bat` (toutes les navettes de `cartes\maps4`,
reprise là où ça s'est arrêté), puis publier sur R2. Les projets Wokwi, analogiques et les grandes tuiles viendront plus tard.

    python code_tuiles.py --shuttles all --out cartes/maps4 --work travail [--jobs 4] [--only <macro>] [--force]


### Projets Wokwi

Les projets Wokwi (`tt_um_wokwi_<id>`) n'ont pas de code source : leur fiche porte le **schéma du concepteur** à la place.
`code_tuiles.py` lit le dessin Wokwi (`projects/<macro>/wokwi-diagram.json` dans le dépôt de la navette depuis tt04, sinon
téléchargé une fois sur `wokwi.com` et gardé dans `travail/_wokwi/`), le redessine en SVG propre (symboles normalisés, fils
tracés comme le concepteur les a posés dans Wokwi, alimentations en symboles), et relie chaque cellule de la puce à son élément du
schéma (porte, multiplexeur, bascule). En jeu, le scanner montre le schéma, allume l'élément visé et ses fils, et le banc de
test fait circuler les valeurs dessus. Dépend de `wokwi_schema.py` (à côté de `code_tuiles.py`).

Pour ne (re)faire que les projets Wokwi : `python code_tuiles.py --shuttles all --out cartes/maps4 --work travail --wokwi`
