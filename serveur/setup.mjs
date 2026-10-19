#!/usr/bin/env node
/* Chip Defender Arena · assistant d'installation du serveur Cloudflare
   ====================================================================
   Lance-le avec « installer-serveur.bat » (Windows) ou « node setup.mjs ».
   Il te guide écran par écran : compte Cloudflare, déploiement, clés, GitHub, Discord, Google,
   mode anonyme (TURN), puis publie la configuration publique du site (auth.json).
   Les secrets tapés ici partent directement chez Cloudflare (wrangler secret bulk) ;
   ils ne sont écrits nulle part sur le disque, sauf un fichier temporaire effacé aussitôt. */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE_DIR = resolve(HERE, "..");                 // le dépôt du site (serveur/ est dedans)
const STATE_F = join(HERE, ".cda-setup.json");        // rien de secret ici
const SITE_URL = "https://chip-defender-arena.kercrafter.live";
const WRANGLER = join(HERE, "node_modules", "wrangler", "bin", "wrangler.js");
const WIN = process.platform === "win32";

/* ---------- affichage ---------- */
const C = process.stdout.isTTY ? { b: s => `\x1b[1m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, c: s => `\x1b[36m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m` } : { b: s => s, g: s => s, y: s => s, c: s => s, r: s => s, d: s => s };
const say = (...a) => console.log(...a);
const title = t => say("\n" + C.b(C.c("━━ " + t + " " + "━".repeat(Math.max(3, 60 - t.length)))));
const step = (n, t) => say(`  ${C.b(n + ".")} ${t}`);
const value = (label, v) => say(`     ${label} : ${C.b(C.y(v))}`);
const okMsg = t => say(C.g("  ✔ " + t));
const warn = t => say(C.y("  ! " + t));
const fail = t => say(C.r("  ✘ " + t));

/* ---------- saisie ---------- */
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let muted = false;
rl._writeToOutput = s => { if (!muted || /[\r\n]/.test(s)) process.stdout.write(muted ? s.replace(/[^\r\n]/g, "") : s); };
const ask = q => new Promise(r => rl.question(C.b("  ? ") + q + " ", a => r(a.trim())));
async function askSecret(q) { const p = ask(q + C.d(" (le texte collé ne s'affiche pas)")); muted = true; const a = await p; muted = false; say(a ? C.d("     reçu (" + a.length + " caractères)") : C.d("     rien saisi")); return a; }
async function yes(q, def = true) { const a = (await ask(q + (def ? " [O/n]" : " [o/N]"))).toLowerCase(); return a ? a.startsWith("o") || a.startsWith("y") : def; }
const pause = (q = "Appuie sur Entrée quand c'est fait…") => ask(q);

/* ---------- outils ---------- */
function openUrl(u) {
  try {
    if (WIN) spawn("cmd", ["/c", "start", "", u], { detached: true, stdio: "ignore" }).unref();
    else spawn(process.platform === "darwin" ? "open" : "xdg-open", [u], { detached: true, stdio: "ignore" }).unref();
  } catch (e) {}
  say(C.d("     (ouvert dans ton navigateur : " + u + ")"));
}
function wr(args, opts = {}) { return spawnSync(process.execPath, [WRANGLER, ...args], { cwd: HERE, encoding: "utf8", ...opts }); }
function wrLive(args) { // affiche tout en direct (les questions de wrangler restent possibles) et renvoie la sortie
  return new Promise(res => {
    const p = spawn(process.execPath, [WRANGLER, ...args], { cwd: HERE, stdio: ["inherit", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", d => { out += d; process.stdout.write(d); });
    p.stderr.on("data", d => { out += d; process.stderr.write(d); });
    p.on("close", code => res({ code, out }));
  });
}
const load = () => { try { return JSON.parse(readFileSync(STATE_F, "utf8")); } catch (e) { return {}; } };
const save = s => writeFileSync(STATE_F, JSON.stringify(s, null, 2), "utf8");
async function putSecrets(obj) {
  const f = join(HERE, ".secrets-temp.json");
  writeFileSync(f, JSON.stringify(obj), { encoding: "utf8", mode: 0o600 });
  try {
    rl.pause();
    const r = wr(["secret", "bulk", f], { stdio: ["inherit", "pipe", "pipe"] });
    if (r.status !== 0) { fail("Cloudflare a refusé les secrets :\n" + (r.stdout || "") + (r.stderr || "")); return false; }
    okMsg("secrets envoyés à Cloudflare : " + Object.keys(obj).join(", "));
    return true;
  } finally { try { unlinkSync(f); } catch (e) {} rl.resume(); }
}
async function check(url) {
  try { const j = await (await fetch(url + "/")).json(); return j; } catch (e) { return null; }
}

/* ---------- étapes ---------- */
async function stepCloudflare() {
  title("Étape 1 · Compte Cloudflare");
  say("  Le serveur du jeu tourne gratuitement chez Cloudflare (offre « Workers Free »).");
  const who = wr(["whoami"]);
  if (who.status === 0 && !/not authenticated/i.test(who.stdout + who.stderr)) {
    const m = (who.stdout || "").match(/associated with the email\s+(\S+)/i);
    okMsg("déjà connecté à Cloudflare" + (m ? " (" + m[1].replace(/\.$/, "") + ")" : ""));
    return;
  }
  step(1, "Si tu n'as pas encore de compte, crée-le (gratuit, aucune carte bancaire demandée) :");
  if (await yes("Ouvrir la page d'inscription Cloudflare ?", true)) openUrl("https://dash.cloudflare.com/sign-up");
  step(2, "Valide l'e-mail de confirmation reçu de Cloudflare.");
  step(3, "Dans le tableau de bord, ouvre une fois « Workers & Pages » (menu de gauche, « Compute »).");
  say("     Cloudflare te propose alors un sous-domaine gratuit « xxx.workers.dev » : garde celui proposé ou choisis-en un.");
  await pause();
  step(4, "Je lance la connexion : une page Cloudflare s'ouvre, clique sur « Allow » (Autoriser).");
  rl.pause();
  const r = spawnSync(process.execPath, [WRANGLER, "login"], { cwd: HERE, stdio: "inherit" });
  rl.resume();
  if (r.status !== 0) throw new Error("connexion à Cloudflare interrompue ; relance l'assistant");
  okMsg("connecté à Cloudflare");
}

async function stepDeploy(S) {
  title("Étape 2 · Mise en ligne du serveur");
  say("  J'envoie le code du serveur chez Cloudflare. Si Cloudflare te demande de choisir un sous-domaine workers.dev, accepte.");
  rl.pause();
  const { code, out } = await wrLive(["deploy"]);
  rl.resume();
  const m = out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
  if (code !== 0) {
    if (/workers\.dev subdomain/i.test(out)) warn("Il faut d'abord un sous-domaine workers.dev : tableau de bord → Workers & Pages → choisis-le, puis relance.");
    throw new Error("le déploiement a échoué (voir les messages ci-dessus)");
  }
  if (m) S.url = m[0].toLowerCase();
  while (!S.url) {
    const u = await ask("Je n'ai pas vu l'adresse du serveur. Colle-la (elle finit par .workers.dev) :");
    if (/^https:\/\/[^/]+\.workers\.dev\/?$/.test(u)) S.url = u.replace(/\/$/, "");
  }
  save(S);
  okMsg("serveur en ligne : " + S.url);
}

async function stepKeys(S, force) {
  title("Étape 3 · Clés du serveur");
  if (S.pubkey && !force) { okMsg("clés déjà en place (clé publique " + S.pubkey.slice(0, 12) + "…)"); return; }
  say("  Je fabrique ici, sur ton PC, le secret maître et la paire de clés de signature.");
  say("  Ils partent directement chez Cloudflare ; seule la clé publique est gardée (elle sera publiée sur le site).");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const sec = {
    MASTER: randomBytes(32).toString("base64url"),
    SIGN_KEY: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    PUBLIC_KEY: publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url")
  };
  if (!(await putSecrets(sec))) throw new Error("secrets non envoyés");
  S.pubkey = sec.PUBLIC_KEY; save(S);
  if (force) warn("nouvelle clé maître : tous les joueurs devront se reconnecter.");
}

const PROV = {
  github: {
    name: "GitHub",
    async guide(cb) {
      step(1, "Ouvre la création d'une « OAuth App » GitHub (connecte-toi avec le compte qui gère le projet).");
      if (await yes("Ouvrir la page GitHub ?", true)) openUrl("https://github.com/settings/applications/new");
      step(2, "Remplis le formulaire exactement ainsi :");
      value("Application name", "Chip Defender Arena");
      value("Homepage URL", SITE_URL);
      value("Application description", "Connexion au multijoueur de Chip Defender Arena (facultatif)");
      value("Authorization callback URL", cb);
      say("     Laisse « Enable Device Flow » décoché, puis clique sur « Register application ».");
      step(3, "Sur la page de l'application : copie le « Client ID ».");
      step(4, "Clique sur « Generate a new client secret » et copie le secret (il ne s'affiche qu'une fois).");
    }
  },
  discord: {
    name: "Discord",
    async guide(cb) {
      step(1, "Ouvre le portail développeur de Discord et clique sur « New Application ».");
      if (await yes("Ouvrir la page Discord ?", true)) openUrl("https://discord.com/developers/applications");
      value("Nom", "Chip Defender Arena");
      say("     Coche l'acceptation des conditions, puis « Create ». (Tu peux ajouter le logo dans « General Information ».)");
      step(2, "Menu de gauche : « OAuth2 ». Dans « Redirects », clique sur « Add Redirect » et colle :");
      value("Redirect", cb);
      say("     Puis « Save Changes » en bas de l'écran.");
      step(3, "Toujours dans « OAuth2 » : copie le « Client ID ».");
      step(4, "« Client Secret » → « Reset Secret » → confirme → copie le secret.");
    }
  },
  google: {
    name: "Google",
    async guide(cb) {
      step(1, "Crée un projet Google Cloud nommé « Chip Defender Arena » (gratuit).");
      if (await yes("Ouvrir la création de projet Google Cloud ?", true)) openUrl("https://console.cloud.google.com/projectcreate");
      say("     Clique sur « Créer », attends la notification, puis sélectionne ce projet en haut de l'écran.");
      await pause();
      step(2, "Ouvre « Google Auth Platform » et clique sur « Commencer » (Get started) :");
      if (await yes("Ouvrir Google Auth Platform ?", true)) openUrl("https://console.cloud.google.com/auth/overview");
      value("Nom de l'application", "Chip Defender Arena");
      value("Adresse e-mail d'assistance", "ton adresse");
      value("Cible (Audience)", "Externe (External)");
      value("Coordonnées", "ton adresse");
      say("     Accepte le règlement, puis « Créer ».");
      await pause();
      step(3, "Menu « Clients » → « Créer un client » :");
      if (await yes("Ouvrir la page des clients ?", true)) openUrl("https://console.cloud.google.com/auth/clients/create");
      value("Type d'application", "Application Web");
      value("Nom", "Chip Defender Arena");
      value("URI de redirection autorisés → Ajouter un URI", cb);
      say("     Clique sur « Créer » : une fenêtre affiche l'ID client et le code secret, copie-les.");
      step(4, "IMPORTANT : menu « Audience » → « Publier l'application » (sinon seuls les testeurs déclarés pourraient se connecter).");
      say("     Le jeu ne demande que le nom et la photo (« openid profile ») : Google n'exige pas de vérification pour ça.");
    }
  }
};

async function stepProvider(S, p) {
  const P = PROV[p], cb = S.url + "/callback/" + p;
  title("Connexion avec " + P.name);
  await P.guide(cb);
  const id = await ask(`Colle le Client ID ${P.name} (Entrée seule pour passer ${P.name}) :`);
  if (!id) { warn(P.name + " laissé de côté pour l'instant (relance l'assistant pour l'ajouter)."); return; }
  const secret = await askSecret(`Colle le Client Secret ${P.name} :`);
  if (!secret) { warn("pas de secret : " + P.name + " non configuré."); return; }
  const U = p.toUpperCase();
  if (await putSecrets({ [U + "_ID"]: id, [U + "_SECRET"]: secret })) { S.providers = { ...(S.providers || {}), [p]: true }; save(S); }
}

async function stepTurn(S) {
  title("Mode anonyme · relais TURN Cloudflare (facultatif)");
  say("  Le mode anonyme fait passer une partie par Cloudflare pour cacher l'adresse IP des joueurs.");
  say("  Gratuit jusqu'à 1 000 Go par mois, puis 0,05 $ par Go (Cloudflare demandera alors un moyen de paiement).");
  if (!(await yes("Configurer le mode anonyme maintenant ?", false))) { warn("mode anonyme non configuré (l'option sera grisée dans le jeu)."); return; }
  step(1, "Tableau de bord Cloudflare → « Realtime » (anciennement « Calls ») → « TURN Server » → « Create ».");
  if (await yes("Ouvrir la page Cloudflare ?", true)) openUrl("https://dash.cloudflare.com/?to=/:account/calls");
  value("Nom", "cda-turn");
  step(2, "Cloudflare affiche « Turn Token ID » et « API Token » : copie-les.");
  const id = await ask("Colle le Turn Token ID (Entrée seule pour annuler) :");
  if (!id) return;
  const tok = await askSecret("Colle l'API Token :");
  if (tok && await putSecrets({ TURN_KEY_ID: id, TURN_TOKEN: tok })) { S.turn = true; save(S); }
}

async function stepBans(S) {
  title("Bannir ou débannir un joueur");
  say("  Un joueur se désigne par fournisseur:identifiant, par exemple « github:1234567 » (affiché dans le jeu, fiche du joueur).");
  say("  Effet : il ne reçoit plus la clé de l'heure suivante, donc il sort du salon au plus tard dans l'heure.");
  const list = new Set(S.banned || []);
  say("  Bannis actuels : " + (list.size ? [...list].join(", ") : "aucun"));
  const a = await ask("Identifiant à bannir, ou « -identifiant » pour débannir (Entrée pour revenir) :");
  if (!a) return;
  if (a.startsWith("-")) list.delete(a.slice(1)); else if (/^[a-z]+:[\w.-]+$/.test(a)) list.add(a); else return warn("format attendu : github:1234567");
  if (await putSecrets({ BANNED: [...list].join(",") || "-" })) { S.banned = [...list]; save(S); }
}

async function stepSite(S) {
  title("Dernière étape · configuration publique du site");
  const info = await check(S.url);
  if (!info) { fail("le serveur ne répond pas sur " + S.url); return; }
  if (!info.ready) { fail("le serveur n'a pas ses clés : relance l'assistant et refais l'étape 3."); return; }
  okMsg("le serveur répond : connexion par " + (info.providers.join(", ") || "aucun fournisseur") + (info.turn ? ", mode anonyme prêt" : ""));
  const cfg = { server: S.url, relay: S.url.replace(/^https:/, "wss:") + "/relay", pubkey: info.pubkey, providers: info.providers, turn: info.turn };
  const f = join(SITE_DIR, "auth.json");
  writeFileSync(f, JSON.stringify(cfg, null, 1) + "\n", "utf8");
  okMsg("auth.json écrit dans le dépôt du site (rien de secret dedans)");
  if (!existsSync(join(SITE_DIR, ".git"))) { warn("pas de dépôt git autour : envoie-moi auth.json, je le publierai."); return; }
  if (!(await yes("Publier auth.json sur le site maintenant (git commit + push) ?", true))) return;
  const g = (...a) => spawnSync("git", a, { cwd: SITE_DIR, encoding: "utf8" });
  if (!(g("config", "user.email").stdout || "").trim()) { // Git ne sait pas encore qui publie sur ce PC
    say("  Git a besoin de ton nom et de ton e-mail pour signer la publication (réglé une fois, pour ce dépôt seulement).");
    const n = await ask("Ton nom :"), m = await ask("Ton e-mail (celui de ton compte GitHub) :");
    if (!n || !m) { warn("publication annulée"); return; }
    g("config", "user.name", n); g("config", "user.email", m);
  }
  g("pull", "--rebase", "--autostash");
  g("add", "auth.json");
  const c = g("commit", "-m", "Configuration publique du serveur de connexion (auth.json)");
  if (c.status !== 0 && !/nothing to commit|rien à valider/i.test(c.stdout + c.stderr)) { fail(c.stdout + c.stderr); return; }
  const p = g("push");
  if (p.status !== 0) { fail("push refusé :\n" + p.stderr); return; }
  okMsg("publié : le site saura où trouver le serveur dans une minute environ");
}

async function status(S) {
  title("État");
  value("Serveur", S.url || "pas encore déployé");
  if (S.url) {
    const i = await check(S.url);
    if (!i) fail("ne répond pas");
    else { value("Clés", i.ready ? "OK" : "manquantes"); value("Connexion par", i.providers.join(", ") || "aucun fournisseur"); value("Mode anonyme", i.turn ? "prêt" : "non configuré"); }
  }
  value("Bannis", (S.banned || []).join(", ") || "aucun");
}

/* ---------- programme ---------- */
async function full(S) {
  await stepCloudflare();
  await stepDeploy(S);
  await stepKeys(S, false);
  for (const p of Object.keys(PROV)) if (!(S.providers || {})[p] || await yes(`${PROV[p].name} est déjà configuré. Le refaire ?`, false)) await stepProvider(S, p);
  if (!S.turn) await stepTurn(S);
  await stepSite(S);
  title("Terminé");
  say("  Pour vérifier : ouvre " + C.b(S.url) + " → la liste « providers » doit citer tes fournisseurs.");
  say("  Relance cet assistant à tout moment pour changer un réglage, bannir un joueur ou mettre le serveur à jour.");
}

async function main() {
  say(C.b("\n  Chip Defender Arena · installation du serveur (Cloudflare)\n"));
  if (!existsSync(WRANGLER)) throw new Error("wrangler absent : lance d'abord « npm install » dans " + HERE);
  const S = load();
  if (!S.url) return full(S);
  for (;;) {
    say("\n  " + C.b("Que veux-tu faire ?") + C.d("  (serveur : " + S.url + ")"));
    say("   1. Tout reprendre pas à pas\n   2. GitHub   3. Discord   4. Google\n   5. Mode anonyme (TURN)\n   6. Bannir / débannir un joueur\n   7. Mettre le serveur à jour (redéployer)\n   8. Republier auth.json\n   9. État\n  10. Nouvelle clé maître (déconnecte tout le monde)\n   0. Quitter");
    const c = await ask("Ton choix :");
    try {
      if (c === "1") await full(S);
      else if (c === "2") await stepProvider(S, "github");
      else if (c === "3") await stepProvider(S, "discord");
      else if (c === "4") await stepProvider(S, "google");
      else if (c === "5") await stepTurn(S);
      else if (c === "6") await stepBans(S);
      else if (c === "7") { await stepCloudflare(); await stepDeploy(S); }
      else if (c === "8") await stepSite(S);
      else if (c === "9") await status(S);
      else if (c === "10") { if (await yes("Sûr ? Tous les joueurs devront se reconnecter.", false)) { await stepKeys(S, true); await stepSite(S); } }
      else if (c === "0" || c === "") return;
    } catch (e) { fail(e.message); }
  }
}
main().catch(e => { fail(e.message); process.exitCode = 1; }).finally(() => rl.close());
