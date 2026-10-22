# Recette (QA) · Chip Defender Arena

À dérouler **sur le staging** (https://staging.chip-defender-arena.kercrafter.live) avant chaque promotion en production.
Connexion : formulaire « Connexion directe (test) », un nom par testeur (Alice, Bob…). Même nom = même joueur.

Colonne **Auto** : test qui couvre déjà le point (`test/unit/…` lancé par la CI à chaque envoi, `test/e2e/…` lancé par la session Claude avant chaque envoi). Un point sans test automatique se vérifie à la main.
Cocher `[x]` dans la demande de promotion (ou noter la version `STAGING · xxxxxxx` du bandeau et le résultat).

Légende : 🖥️ PC · 📱 téléphone · 👥 au moins deux joueurs (deux navigateurs, ou PC + téléphone)

## 0. Avant de commencer

| # | Vérification | Auto |
|---|---|---|
| 0.1 | Le bandeau orange **STAGING · version** est visible en bas à droite de la page | `e2e/sec.js` |
| 0.2 | La version du bandeau = dernier commit de `staging` (onglet Actions : CI verte) | `ci.yml` |
| 0.3 | Aucune erreur rouge dans la console du navigateur au chargement (F12) | `e2e/sec.js` (« aucune erreur ») |
| 0.4 | Mise à jour en douceur : page ouverte pendant un nouveau déploiement → proposition de recharger, la partie reprend | — (la reprise elle-même : `e2e/resume.js`) |

## 1. Accueil, menus, solo

| # | Vérification | Auto |
|---|---|---|
| 1.1 | Page d'accueil : présentation, modes, section Exploration et annonce Coop, vignettes des armes | — |
| 1.2 | 🖥️ Solo : lancer une partie, se déplacer, tirer, changer d'arme (molette, 1/2/3) | — |
| 1.3 | 📱 Solo : joystick, boutons TIR/SAUT/⇄, vue en portrait et en paysage | — |
| 1.4 | Changement de langue FR ⇄ EN : aucun texte resté en français dans les menus | — (build : « traduits N / M ») |
| 1.5 | Clic droit : aucun menu contextuel du navigateur (sauf dans les champs de saisie) | — |
| 1.6 | Application installable (PWA) et solo hors ligne | — |

## 2. Cartes (tuiles)

| # | Vérification | Auto |
|---|---|---|
| 2.1 | Choix d'une navette et d'un projet : la tuile se charge (SKY130, IHP, GF180) | `e2e/modesmap.js` |
| 2.2 | Grande tuile (ex. tt06) : chargement au fil du déplacement, pas de saccade longue | `e2e/bigmp.js` (👥) |
| 2.3 | Rayon X, couches, vias visibles | `e2e/invpop.js` (vias en coop) |

## 3. Exploration (solo)

| # | Vérification | Auto |
|---|---|---|
| 3.1 | Toujours un outil en main ; molette / 1 / 2 / 3 changent d'outil comme des armes ; modèle propre à chaque outil | `e2e/invpop.js` (outil en main, E ne range plus) |
| 3.2 | Scanner de poche : couleurs par module, fiche d'une cellule, ligne de code source | — |
| 3.3 | Projet Wokwi : le scanner montre le schéma du concepteur | — |
| 3.4 | Sonde et oscilloscope : l'état est retrouvé en revenant à l'outil | — |
| 3.5 | Banc de test : horloge, pas à pas, valeurs des bascules cohérentes | `unit/gate-sim.test.mjs` |
| 3.6 | Clic droit libère la souris en exploration | — |

## 4. En ligne : connexion et salon (👥)

| # | Vérification | Auto |
|---|---|---|
| 4.1 | Sans compte : écran de connexion, aucune salle ouverte | `e2e/sec.js` |
| 4.2 | Connexion directe → retour au salon avec le nom choisi | `e2e/sec.js` |
| 4.3 | Messages du salon reçus par les autres, joueurs en ligne listés | `e2e/sec.js` |
| 4.4 | Même compte dans un 2ᵉ onglet : choix « Jouer ici » / « Changer de compte » | — |
| 4.5 | Déconnexion → retour à l'écran de connexion | `e2e/sec.js` |
| 4.6 | Staging : **aucun** bouton GitHub / Discord / Google | `e2e/sec.js`, `unit/auth-providers.test.mjs` |

## 5. Parties multijoueur (👥)

| # | Vérification | Auto |
|---|---|---|
| 5.1 | Partie publique : annoncée dans le salon, un autre joueur la rejoint, la partie démarre chez lui | `e2e/sec.js` |
| 5.2 | Partie privée : jamais annoncée ; invitation depuis le salon et par lien | `e2e/sec.js` |
| 5.3 | Pop-in d'invitation au-dessus de tout, « Rejoindre » fonctionne (souris capturée ou non) | `e2e/invpop.js` |
| 5.4 | Lien d'invitation tenu à jour dans la barre d'adresse | `e2e/resume.js` |
| 5.5 | Partie privée : l'hôte accepte / refuse un joueur qui revient ; accepté une fois = accepté toujours | `e2e/entry.js` |
| 5.6 | Chaque mode (équipes, CTF, course…) se lance sur sa carte | `e2e/modesmap.js` (puce chargée à la volée) |
| 5.7 | Chat en partie (T / Entrée, bouton Chat), au-dessus du panneau de vie | — |
| 5.8 | L'hôte quitte : les autres reviennent au salon | `e2e/sec.js` |

## 6. Coop Exploration (👥)

| # | Vérification | Auto |
|---|---|---|
| 6.1 | Solo → Échap → « Inviter des amis » : la partie devient coop, lien partageable | `e2e/solocoop3.js` |
| 6.2 | Banc de test partagé : l'invité voit la même horloge et les mêmes bascules | `e2e/coop.js` |
| 6.3 | Sondes des autres joueurs visibles, y compris l'alimentation | `e2e/coop.js` (réseau d'alimentation) |
| 6.4 | Réglages de l'hôte : banc ouvert à tous / hôte seul ; vol, couches, téléportation | `e2e/coop.js` |
| 6.5 | Rejoindre en cours : pas d'écran « éliminé » | `e2e/solocoop3.js` |

## 7. Reprise et reconnexion (👥, 📱 conseillé)

| # | Vérification | Auto |
|---|---|---|
| 7.1 | Recharger la page en partie : retour dans la même partie | `e2e/resume.js` |
| 7.2 | L'hôte recharge : 90 s de grâce, la partie ne se ferme pas | `e2e/resume.js` |
| 7.3 | 📱 Téléphone en veille 1–2 min puis réveil : le joueur revient, pas de « connexion perdue » chez les autres | `freeze` (approximation, hors suite) |
| 7.4 | Lien d'invitation ouvert sans compte : connexion puis arrivée directe dans la partie | `e2e/solocoop3.js` |

## 8. Staging seulement : sécurité de l'environnement

| # | Vérification | Auto |
|---|---|---|
| 8.1 | https://auth-staging.kercrafter.live/ répond `"providers":["direct"]` | `serveur/setup-staging.mjs` (fin) |
| 8.2 | https://auth.kercrafter.live/ (production) **ne contient pas** `direct` | `unit/auth-providers.test.mjs` (garde-fou) |
| 8.3 | Le staging n'est pas indexé (`robots.txt` : Disallow) | build (`noindex`) |

## Ajouter un point

Chaque nouvelle fonctionnalité ajoute une ligne ici, dans la bonne section, avec son test automatique s'il existe
(ou « — » et la manipulation exacte à faire). Une correction de bug ajoute la vérification qui l'aurait détecté.
