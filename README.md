# Chip Defender Arena · LEDs Racer Edition

FPS multijoueur dans le layout réel des puces Tiny Tapeout — KerCrafter Lab.

Dépôt de développement (privé). Les versions publiées sont copiées sur le dépôt public
[Chip-Defender-Arena-LEDs-Racer-Edition](https://github.com/KerCrafter/Chip-Defender-Arena-LEDs-Racer-Edition) (branche `production`).

| Environnement | Site | Serveur | Branche |
|---|---|---|---|
| Production | https://chip-defender-arena.kercrafter.live | https://auth.kercrafter.live (`cda-serveur`) | `production` (bouton de promotion) |
| Staging | https://staging.chip-defender-arena.kercrafter.live | https://auth-staging.kercrafter.live (`cda-serveur-staging`) | `staging` (chaque envoi) |

```
staging  ──push──▶ CI (tests + build) ──▶ Cloudflare Pages ──▶ staging.chip-defender-arena…
   │
   └─ recette QA.md ─▶ bouton « Promouvoir en production » ─▶ production ──▶ Cloudflare Pages ──▶ chip-defender-arena…
```

## Organisation

| Dossier | Contenu |
|---|---|
| `game.html` | la page du jeu (en cours de découpage en modules) |
| `src/` | modules à responsabilité unique, inclus par le build (`/*@include*/`) |
| `i18n/` | traduction anglaise appliquée au build |
| `assets/` | PWA (service worker, icônes, bibliothèques), sons, vignettes, fiches code |
| `data/` | index des cartes |
| `config/<env>/` | configuration publique par environnement |
| `build/build.py` | construit `dist/` pour un environnement |
| `serveur/` | Worker Cloudflare (connexion, relais, TURN) ; `setup.mjs` production, `setup-staging.mjs` staging |
| `tools/`, `outils/` | fabrication et publication des cartes, fiches code, DNS |
| `test/unit/` | tests de la logique pure (`npm test`, lancés par la CI) |
| `test/e2e/` | tests de bout en bout (Playwright), voir son README |
| `QA.md` | recette avant promotion |
| `docs/STAGING.md` | mise en place Cloudflare Pages et serveur de staging |

## Construire

```
npm run build:staging      # ou build:production ; résultat dans dist/
npm test
```
