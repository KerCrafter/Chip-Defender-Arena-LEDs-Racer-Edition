# Serveur Cloudflare de Chip Defender Arena

Un seul Worker Cloudflare (offre gratuite) qui gère :

| Adresse | Rôle |
|---|---|
| `GET /` | état : fournisseurs actifs, clé publique, TURN |
| `GET /login/{github,discord,google}?r=<page du jeu>` | départ vers le fournisseur |
| `GET /login/direct?r=<page du jeu>&name=<nom>` | staging seulement : session directe |
| `GET /callback/{fournisseur}` | retour du fournisseur → session de 7 jours renvoyée au jeu dans `#cda=…` |
| `POST /session` (`Authorization: Bearer <session>`, `{"pk": "<clé Nostr>"}`) | clé du salon de l'heure `K(h)` (et `K(h+1)` après h:55) + jeton d'identité signé (65 min) |
| `GET /turn` (`Authorization: Bearer <jeton>`) | serveurs TURN Cloudflare pour le mode anonyme |
| `wss://…/relay?t=<jeton>` | relais Nostr privé du salon (Durable Object) |

## Installation

Sous Windows : double-clique `installer-serveur.bat` (dossier `chip-defender-arena`). Ailleurs :

```
npm install
node setup.mjs
```

L'assistant guide pas à pas : compte Cloudflare, mise en ligne, clés, GitHub, Discord, Google, TURN, puis publie `auth.json` (configuration publique) à la racine du site.

## Fournisseurs d'identité (adaptateurs)

`src/auth/providers.js` : GitHub, Discord, Google (OAuth, actifs si leurs secrets sont posés) et **direct**
(un nom, sans compte : tests). La connexion directe n'existe que sur le Worker de staging (`AUTH_DIRECT=1`,
`wrangler.toml` → `[env.staging]`) ou en local (`DEV=1`), et le code la refuse si `SITE_ORIGINS` contient la production.

## Staging

```
installer-staging.bat (dossier du PC)   # ou : node setup-staging.mjs
```

Met en ligne `cda-serveur-staging` (`auth-staging.kercrafter.live`), avec ses propres clés. Voir `docs/STAGING.md`.

## Essai en local

```
# .dev.vars : MASTER, SIGN_KEY, PUBLIC_KEY, DEV=1 (adresses localhost autorisées)
npx wrangler dev --env staging --port 8787 --ip 127.0.0.1
npm i --no-save nostr-tools ws && node test/e2e.mjs
```

Ne mets jamais `DEV=1` ni `AUTH_DIRECT=1` en production.
