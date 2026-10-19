# Serveur Cloudflare de Chip Defender Arena

Un seul Worker Cloudflare (offre gratuite) qui gère :

| Adresse | Rôle |
|---|---|
| `GET /` | état : fournisseurs actifs, clé publique, TURN |
| `GET /login/{github,discord,google}?r=<page du jeu>` | départ vers le fournisseur |
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

## Essai en local

```
# .dev.vars : MASTER, SIGN_KEY, PUBLIC_KEY, DEV=1 (active le fournisseur « dev » et les adresses localhost)
npx wrangler dev
npm i --no-save nostr-tools ws && node test/e2e.mjs
```

Ne mets jamais `DEV=1` en production.
