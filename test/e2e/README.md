# Tests de bout en bout

Navigateur réel (Chromium via Playwright), serveur de connexion local, site construit en configuration staging.

## Préparer (une fois par modification)

```
cd test/e2e && npm install            # Playwright (navigateur : npx playwright install chromium, sauf si fourni)
CDA_MAPS_DIR=/chemin/vers/maps4 ./prepare.sh
```

`prepare.sh` construit le site dans `test/e2e/site` avec un `auth.json` local (serveur `127.0.0.1:8787`,
connexion directe, clé publique lue sur le serveur). `CDA_MAPS_DIR` pointe vers un dossier `maps4/` de cartes
(au moins `shuttles.json`, `ttsky25b/a580.bin` + `meta.json`, et les navettes testées par `modesmap.js`).

## Lancer les serveurs (deux terminaux)

```
cd test/e2e/site && python3 -m http.server 8765 --bind 127.0.0.1
cd serveur && npx wrangler dev --env staging --port 8787 --ip 127.0.0.1
```

`serveur/.dev.vars` (jamais commité) : `MASTER`, `SIGN_KEY`, `PUBLIC_KEY` de test et `DEV=1`
(autorise les adresses `localhost` / `127.0.0.1`).

## Lancer

```
./run.sh                 # suite principale : sec coop entry invpop resume solocoop3 modesmap
./run.sh sec entry       # seulement certains tests
node bigmp.js            # grande tuile à plusieurs (long)
```

Chaque test affiche `OK` / `ÉCHEC` ligne par ligne et finit par « aucune erreur » ou la liste des erreurs de page.
Variables : `CDA_SITE`, `CDA_SRV`, `CHROME` (chemin de Chromium), `CDA_SHOTS` (captures, `shots/` par défaut).

| Test | Couvre (voir QA.md) |
|---|---|
| `sec.js` | connexion directe, salon chiffré, parties publique / privée, invitations, déconnexion |
| `coop.js` | coop exploration : banc partagé, sondes, réglages de l'hôte |
| `entry.js` | approbation des entrées dans une partie privée |
| `invpop.js` | fenêtre d'invitation, outils toujours en main, vias en coop |
| `resume.js` | reprise après rechargement, grâce de l'hôte, reconnexion |
| `solocoop3.js` | solo → coop, arrivée par lien sans compte |
| `modesmap.js` | lancement des modes sur des puces chargées à la volée |
| `bigmp.js` | grande tuile en multijoueur |
