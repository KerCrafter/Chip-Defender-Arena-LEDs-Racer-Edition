# Mise en place du staging et du déploiement continu

Une fois pour toutes, depuis le PC ; aucun secret ne passe par le dépôt.

**Raccourci** : `installer-staging.bat` fait l'étape 1, puis `mise-en-place-staging.bat` (copie de
`outils/staging/mise-en-place-staging.bat` dans le dossier du PC) fait les étapes 2 à 4 et vérifie le résultat.
Il demande une connexion GitHub (outil `gh`, installé s'il manque) et un jeton Cloudflare (jamais enregistré).
Les sections ci-dessous décrivent les mêmes étapes à la main.

## Vue d'ensemble

Deux dépôts :
- **`KerCrafter/chip-defender-arena-dev`** (privé) : la source, `staging`, les branches de test, `production`.
  Les sessions Claude y travaillent ; Cloudflare Pages y est branché.
- **`KerCrafter/Chip-Defender-Arena-LEDs-Racer-Edition`** (public) : ne reçoit que les versions publiées
  (branche `production` et étiquettes `prod-…`, copiées par le bouton de promotion). Sa branche `main` est le site
  servi par GitHub Pages jusqu'à la bascule.

| | Staging | Production |
|---|---|---|
| Branche | `staging` (chaque envoi est publié) | `production` (bouton « Promouvoir en production ») |
| Site (Cloudflare Pages, projet `chip-defender-arena`) | `staging.chip-defender-arena.kercrafter.live` | `chip-defender-arena.kercrafter.live` |
| Serveur (Worker) | `cda-serveur-staging` → `auth-staging.kercrafter.live` | `cda-serveur` → `auth.kercrafter.live` |
| Connexion | directe (un nom, sans compte) | GitHub, Discord, Google |
| Clés | les siennes | les siennes |
| Cartes | R2 partagé (lecture seule) `maps-cda.kercrafter.live` | idem |

## 1. Serveur de staging (PC)

Dans le dossier `chip-defender-arena` du PC, double-cliquer **`installer-staging.bat`**.

Il télécharge la branche `staging` du dépôt privé dans `depot-staging` (Git demande une fois de se connecter
à GitHub : c'est un dépôt privé), puis lance
`serveur/setup-staging.mjs`, qui :
- met en ligne le Worker `cda-serveur-staging` (domaine `auth-staging.kercrafter.live` créé automatiquement) ;
- la première fois, fabrique ses propres clés et les envoie directement chez Cloudflare (rien sur le disque) ;
- autorise le staging à lire les cartes R2 (règle CORS, liste dans `outils/cartes/origines-cartes.json`) ;
- vérifie que `https://auth-staging.kercrafter.live/` répond avec `"providers":["direct"]`.

À relancer quand `serveur/` change sur `staging`.

## 2. Clé de publication vers le dépôt public

Sur le PC, dans une invite de commandes :

```
ssh-keygen -t ed25519 -N "" -C "promotion cda" -f cle-publication
```

1. Dépôt **public** → Settings → **Deploy keys** → **Add deploy key** : titre « promotion », coller le contenu de
   `cle-publication.pub`, cocher **Allow write access**.
2. Dépôt **privé** → Settings → **Secrets and variables** → **Actions** → **New repository secret** :
   nom `PUBLIC_DEPLOY_KEY`, coller le contenu de `cle-publication` (la clé privée).
3. Supprimer les deux fichiers `cle-publication*` du PC.

Sans ce secret, la promotion marche quand même, mais n'envoie rien au dépôt public (avertissement dans Actions).

## 2 bis. Première promotion (crée la branche `production`)

Dépôt privé → **Actions** → « Promouvoir en production » → **Run workflow** → taper `PROD`.
La CI du dernier commit de `staging` doit être verte (onglet Actions, workflow « CI »).

## 3. Projet Cloudflare Pages

Tableau de bord Cloudflare → **Workers & Pages** → **Create** → onglet **Pages** → **Connect to Git** :

1. Autoriser l'application Cloudflare sur GitHub pour le dépôt **privé** `KerCrafter/chip-defender-arena-dev`.
2. Nom du projet : **`chip-defender-arena`** (les adresses `*.chip-defender-arena.pages.dev` en dépendent).
3. **Production branch** : `production`.
4. **Framework preset** : None · **Build command** : `npm run build` · **Build output directory** : `dist`.
5. Variables d'environnement : aucune (le build lit `CF_PAGES_BRANCH` : `production` → production, sinon staging).
   Facultatif : `NODE_VERSION` = `22`.
6. **Save and Deploy**.

Puis, dans le projet → **Settings** → **Builds & deployments** → **Branch control** :
- Production branch : `production` ;
- Preview branches : **Custom branches** → inclure `staging` seulement.

## 4. Domaine du staging

Projet Pages → **Custom domains** → **Set up a custom domain** → `staging.chip-defender-arena.kercrafter.live`.
Puis Cloudflare → zone `kercrafter.live` → **DNS** → modifier l'enregistrement CNAME
`staging.chip-defender-arena` pour qu'il pointe vers **`staging.chip-defender-arena.pages.dev`** (proxy activé).
Sans cette modification, le domaine afficherait la production.

Vérifier : https://staging.chip-defender-arena.kercrafter.live montre le bandeau orange **STAGING** en bas à droite.

## 5. Bascule de la production (plus tard, quand le staging a fait ses preuves)

Aujourd'hui la production est servie par GitHub Pages (branche `main`). Pour passer à Cloudflare Pages :

1. Vérifier https://chip-defender-arena.pages.dev (build de la branche `production`).
2. Projet Pages → **Custom domains** → `chip-defender-arena.kercrafter.live` : Cloudflare remplace l'enregistrement
   DNS qui pointe vers GitHub Pages.
3. GitHub → Settings → Pages : désactiver GitHub Pages (après vérification).

Retour arrière à tout moment : relancer « Promouvoir en production » avec `ref` = une étiquette `prod-…` précédente.

## Au quotidien

- Les sessions Claude poussent sur `staging` → la CI teste et construit → Cloudflare Pages publie le staging (≈ 1–2 min).
- Recette sur le staging avec `QA.md`.
- Bouton « Promouvoir en production » quand c'est bon.
- Le serveur de staging se redéploie avec `installer-staging.bat` quand `serveur/` change (la production : `installer-serveur.bat`).
