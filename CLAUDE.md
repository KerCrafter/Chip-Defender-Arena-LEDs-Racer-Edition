# Règles pour les sessions Claude sur ce dépôt

## Dépôts
- Ce dépôt (**`KerCrafter/chip-defender-arena-dev`**, privé) est le seul où l'on travaille.
- Le dépôt public `KerCrafter/Chip-Defender-Arena-LEDs-Racer-Edition` ne reçoit que les versions publiées, par le
  bouton de promotion. Ne jamais y pousser de branche de travail (elles y deviendraient publiques).

## Branches
- **`staging`** : branche de travail. Toute modification part d'ici et y est poussée. Chaque envoi est construit
  et publié automatiquement par Cloudflare Pages sur https://staging.chip-defender-arena.kercrafter.live.
- **`production`** : jamais modifiée directement. Elle avance seulement par le bouton « Promouvoir en production »
  (GitHub → Actions), déclenché par Clément après la recette `QA.md`.
- Branches de test : `test/<sujet>`, publiées en aperçu par Cloudflare Pages si on les ajoute aux branches d'aperçu.
- Le `main` du dépôt public est l'ancien site construit, servi par GitHub Pages jusqu'à la bascule vers Cloudflare Pages.
  Ne plus y pousser (sauf correctif urgent de la production actuelle, à reporter ensuite dans `staging`).

## On modifie la source, jamais le résultat
- Source : `game.html`, `src/`, `i18n/`, `assets/`, `config/`, `data/`, `serveur/`, `tools/`, `outils/`.
- `dist/` est produit par `build/build.py` et n'est jamais commité. Ne jamais éditer un `index.html` construit.
- Textes visibles : ajouter la traduction anglaise dans `i18n/en_html.json` (HTML) ou `i18n/en_js.json` (JS).
  Le build affiche « traduits N / M » : ne pas faire baisser N.
- Configuration publique par environnement : `config/<env>/` (auth.json, cartes.json, dons.json, site.json).

## Avant chaque envoi sur staging
1. `npm test` (tests unitaires, logique pure) : tout vert.
2. `npm run build:staging` et `npm run build:production` : sans erreur (les garde-fous de production sont dans le build).
3. Tests de bout en bout touchant la zone modifiée (`test/e2e/README.md`), au minimum `sec.js`.
4. `QA.md` : ajouter / mettre à jour la ligne de recette de la fonctionnalité (et son test s'il existe).
5. Message de commit en français, qui dit ce qui change pour le joueur.

## TDD et architecture
- Nouvelle logique : écrire d'abord le test dans `test/unit/` (node:test, sans navigateur), puis le code.
- La logique pure va dans des modules sans dépendance au navigateur ni au réseau (`src/…`, exportés en UMD
  comme `src/gate-sim.js`). Le navigateur, le réseau, le stockage, l'authentification sont des **adaptateurs**.
- Côté serveur, les fournisseurs d'identité sont des adaptateurs (`serveur/src/auth/providers.js`).
- Le découpage progressif de `game.html` (domaine / ports / adaptateurs) se fait module par module, chacun
  avec ses tests, sans changer le comportement (vérifié par la suite e2e).

## Sécurité (non négociable)
- Aucun secret dans le dépôt, ni dans `config/`, ni dans `auth.json` / `version.json`. Les secrets vont
  directement chez Cloudflare (`wrangler secret`), depuis le PC de Clément.
- Jamais `DEV=1` ni `AUTH_DIRECT=1` sur le Worker de production. La connexion directe est réservée au Worker
  `cda-serveur-staging` ; le code la refuse si `SITE_ORIGINS` contient la production.
- La zone DNS est chez Cloudflare ; le domaine reste enregistré chez OVH.
