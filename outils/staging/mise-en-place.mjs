#!/usr/bin/env node
/* Chip Defender Arena · mise en place du staging et de la promotion (étapes 2 à 5 de docs/STAGING.md)
   ====================================================================================================
   Lancer : mise-en-place-staging.bat (Windows) ou « node outils/staging/mise-en-place.mjs ».
   Chaque étape vérifie d'abord si elle est déjà faite : relancer le script ne refait rien d'inutile.

   2. clé de publication : paire SSH fabriquée dans un dossier temporaire ; la partie publique devient une
      « deploy key » (écriture) du dépôt public, la partie privée le secret PUBLIC_DEPLOY_KEY du dépôt privé ;
      les deux fichiers sont effacés aussitôt ;
   3. première promotion : lance « Promouvoir en production » (crée la branche production) et attend la fin ;
   4. projet Cloudflare Pages « chip-defender-arena » branché sur le dépôt privé (build npm run build -> dist,
      production = branche production, aperçus = branche staging seulement) ;
   5. domaine staging.chip-defender-arena.kercrafter.live -> aperçu de la branche staging (CNAME proxifié),
      premières constructions, puis vérification du site.

   GitHub : par l'outil « gh » (connexion par le navigateur, gérée par gh).
   Cloudflare : un jeton demandé à chaque lancement, jamais écrit sur le disque. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import * as readline from "node:readline";

const DEV = "KerCrafter/chip-defender-arena-dev";
const PUB = "KerCrafter/Chip-Defender-Arena-LEDs-Racer-Edition";
const KEY_TITLE = "promotion cda";
const PROJECT = "chip-defender-arena";
const ZONE = "kercrafter.live";
const STAGING_HOST = "staging.chip-defender-arena." + ZONE;
const STAGING_ALIAS = "staging." + PROJECT + ".pages.dev";
const AUTH_STAGING = "https://auth-staging." + ZONE + "/";
const CF = "https://api.cloudflare.com/client/v4";
const WIN = process.platform === "win32";

/* ---------- affichage et saisie ---------- */
const tty = process.stdout.isTTY;
const C = { b: s => tty ? `\x1b[1m${s}\x1b[0m` : s, g: s => tty ? `\x1b[32m${s}\x1b[0m` : s, y: s => tty ? `\x1b[33m${s}\x1b[0m` : s, c: s => tty ? `\x1b[36m${s}\x1b[0m` : s, r: s => tty ? `\x1b[31m${s}\x1b[0m` : s, d: s => tty ? `\x1b[2m${s}\x1b[0m` : s };
const say = (...a) => console.log(...a);
const title = t => say("\n" + C.b(C.c("━━ " + t + " " + "━".repeat(Math.max(3, 64 - t.length)))));
const val = (l, v) => say(`     ${l} : ${C.b(C.y(v))}`);
const okM = t => say(C.g("  ✔ " + t)), warn = t => say(C.y("  ! " + t)), info = t => say("  " + t);
const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
let muted = false;
if (rl) rl._writeToOutput = s => { if (!muted || /[\r\n]/.test(s)) process.stdout.write(muted ? s.replace(/[^\r\n]/g, "") : s); };
const ask = q => rl ? new Promise(r => rl.question(C.b("  ? ") + q + " ", a => r(a.trim()))) : Promise.resolve("");
async function askSecret(q) { const p = ask(q + C.d(" (le texte collé ne s'affiche pas)")); muted = true; const a = await p; muted = false; say(a ? C.d("     reçu") : C.d("     rien saisi")); return a; }
async function yes(q, def = true) { const a = (await ask(q + (def ? " [O/n]" : " [o/N]"))).toLowerCase(); return a ? /^[oy]/.test(a) : def; }
const pause = (q = "Appuie sur Entrée quand c'est fait…") => ask(q);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function openUrl(u) {
  try { if (WIN) spawn("cmd", ["/c", "start", "", u], { detached: true, stdio: "ignore" }).unref(); else spawn(process.platform === "darwin" ? "open" : "xdg-open", [u], { detached: true, stdio: "ignore" }).unref(); } catch (e) {}
  say(C.d("     (ouvert dans ton navigateur : " + u + ")"));
}

/* ---------- GitHub (gh) ---------- */
const GH = process.env.GH_EXE || "gh";
function gh(args, opts = {}) {
  rl && rl.pause();
  const r = spawnSync(GH, args, { encoding: "utf8", ...opts });
  rl && rl.resume();
  if (r.error) throw new Error("outil gh introuvable (" + r.error.message + ") : lance mise-en-place-staging.bat, qui l'installe");
  return r;
}
const ghOk = (args, opts) => { const r = gh(args, opts); if (r.status !== 0) throw new Error("gh " + args.slice(0, 3).join(" ") + " : " + (r.stderr || r.stdout).trim()); return r.stdout; };
const ghJson = args => JSON.parse(ghOk(args) || "null");

async function githubLogin() {
  title("Connexion à GitHub");
  // la connexion elle-même est faite par mise-en-place-staging.bat (gh a besoin du clavier, que ce script garde)
  if (gh(["auth", "status", "-h", "github.com"]).status === 0) { okM("connecté (gh)"); return; }
  throw new Error("pas connecté à GitHub : lance « gh auth login -w -s repo,workflow » ou relance mise-en-place-staging.bat");
}

function findSshKeygen() {
  const c = ["ssh-keygen", "C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe", "C:\\Program Files\\Git\\usr\\bin\\ssh-keygen.exe"];
  for (const p of c) { const r = spawnSync(p, ["-?"], { encoding: "utf8" }); if (!r.error) return p; }
  throw new Error("ssh-keygen introuvable (fourni par Windows ou par Git)");
}

/* ---------- étape 2 ---------- */
async function stepKey() {
  title("Étape 2 · Clé de publication vers le dépôt public");
  const keys = ghJson(["api", `repos/${PUB}/keys`]) || [];
  const mine = keys.filter(k => k.title === KEY_TITLE);
  const secret = ghOk(["secret", "list", "-R", DEV]).split(/\r?\n/).some(l => l.startsWith("PUBLIC_DEPLOY_KEY"));
  if (mine.length === 1 && !mine[0].read_only && secret) { okM("déjà en place (deploy key « " + KEY_TITLE + " » + secret PUBLIC_DEPLOY_KEY)"); return; }
  for (const k of mine) ghOk(["api", "-X", "DELETE", `repos/${PUB}/keys/${k.id}`]);   // ancienne clé sans son secret : remplacée
  const dir = mkdtempSync(join(tmpdir(), "cda-cle-"));
  try {
    const f = join(dir, "cle");
    const r = spawnSync(findSshKeygen(), ["-q", "-t", "ed25519", "-N", "", "-C", KEY_TITLE, "-f", f], { encoding: "utf8" });
    if (r.status !== 0 || !existsSync(f)) throw new Error("ssh-keygen : " + (r.stderr || r.stdout));
    ghOk(["repo", "deploy-key", "add", f + ".pub", "-R", PUB, "--allow-write", "--title", KEY_TITLE]);
    okM("clé publique ajoutée au dépôt public (écriture)");
    ghOk(["secret", "set", "PUBLIC_DEPLOY_KEY", "-R", DEV], { input: readFileSync(f, "utf8") });
    okM("clé privée enregistrée dans le secret PUBLIC_DEPLOY_KEY du dépôt privé");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  okM("fichiers de la clé effacés du PC");
}

/* ---------- étape 3 ---------- */
async function stepPromote() {
  title("Étape 3 · Première promotion (branche production)");
  if (gh(["api", `repos/${DEV}/branches/production`]).status === 0) { okM("la branche production existe déjà"); return; }
  const ci = ghJson(["run", "list", "-R", DEV, "--workflow", "ci.yml", "--branch", "staging", "-L", "1", "--json", "conclusion,headSha,status"]);
  if (!ci || !ci.length || ci[0].conclusion !== "success") throw new Error("la CI du dernier commit de staging n'est pas verte : promotion impossible pour l'instant");
  const before = (ghJson(["run", "list", "-R", DEV, "--workflow", "promote.yml", "-L", "1", "--json", "databaseId"]) || [])[0];
  ghOk(["workflow", "run", "promote.yml", "-R", DEV, "-f", "confirm=PROD", "-f", "ref="]);
  info("promotion lancée, j'attends qu'elle démarre…");
  let run = null;
  for (let i = 0; i < 30 && !run; i++) {
    await sleep(3000);
    const r = (ghJson(["run", "list", "-R", DEV, "--workflow", "promote.yml", "-L", "1", "--json", "databaseId"]) || [])[0];
    if (r && (!before || r.databaseId !== before.databaseId)) run = r;
  }
  if (!run) throw new Error("la promotion ne démarre pas : regarde l'onglet Actions du dépôt privé");
  const w = gh(["run", "watch", String(run.databaseId), "-R", DEV, "--exit-status"], { stdio: "inherit" });
  if (w.status !== 0) throw new Error("la promotion a échoué : onglet Actions du dépôt privé");
  okM("branche production créée (et copiée sur le dépôt public si la clé est en place)");
}

/* ---------- Cloudflare ---------- */
let TOKEN = "";
async function cf(method, path, body, form) {
  const r = await fetch(CF + path, { method, headers: { authorization: "Bearer " + TOKEN, ...(body ? { "content-type": "application/json" } : {}) }, body: form || (body ? JSON.stringify(body) : undefined) });
  let j = null; try { j = await r.json(); } catch (e) {}
  if (!j || !j.success) { const e = new Error(((j && j.errors) || []).map(x => x.message + (x.code ? " (" + x.code + ")" : "")).join(" ; ") || "HTTP " + r.status); e.status = r.status; e.cfErrors = (j && j.errors) || []; throw e; }
  return j.result;
}
async function needToken() {
  if (TOKEN) return;
  title("Jeton Cloudflare");
  info("Il me faut un jeton Cloudflare (gardé en mémoire le temps du script, jamais écrit ; tu pourras le supprimer à la fin).");
  info("Cloudflare → ton profil → « API Tokens » → « Create Token » → « Create Custom Token » :");
  if (await yes("Ouvrir la page des jetons ?", true)) openUrl("https://dash.cloudflare.com/profile/api-tokens");
  val("Nom", "cda-staging");
  val("Permissions", "Account · Cloudflare Pages · Edit");
  val("           ", "Zone · DNS · Edit   +   Zone · Zone · Read");
  val("Account Resources", "Include · ton compte");
  val("Zone Resources", "Include · Specific zone · " + ZONE);
  info("« Continue to summary » → « Create Token » → copie le jeton.");
  for (;;) {
    TOKEN = await askSecret("Colle le jeton :");
    if (!TOKEN) throw new Error("jeton nécessaire");
    try { await cf("GET", "/user/tokens/verify"); okM("jeton valide"); return; } catch (e) { warn("jeton refusé : " + e.message); TOKEN = ""; }
  }
}
async function account() {
  const a = await cf("GET", "/accounts?per_page=50");
  if (!a.length) throw new Error("aucun compte visible avec ce jeton (Account Resources ?)");
  if (a.length === 1) return a[0].id;
  a.forEach((x, i) => say(`     ${i + 1}. ${x.name}`));
  const n = +(await ask("Quel compte ?")) || 1;
  return a[Math.min(a.length, n) - 1].id;
}

/* ---------- étape 4 ---------- */
const PROJECT_CFG = {
  name: PROJECT, production_branch: "production",
  build_config: { build_command: "npm run build", destination_dir: "dist", root_dir: "" },
  source: { type: "github", config: {
    owner: DEV.split("/")[0], repo_name: DEV.split("/")[1], production_branch: "production",
    pr_comments_enabled: false, deployments_enabled: true, production_deployments_enabled: true,
    preview_deployment_setting: "custom", preview_branch_includes: ["staging"], preview_branch_excludes: []
  } },
  deployment_configs: {
    production: { env_vars: { NODE_VERSION: { type: "plain_text", value: "22" } } },
    preview: { env_vars: { NODE_VERSION: { type: "plain_text", value: "22" } } }
  }
};
async function stepPages(acc) {
  title("Étape 4 · Projet Cloudflare Pages « " + PROJECT + " »");
  let p = null;
  try { p = await cf("GET", `/accounts/${acc}/pages/projects/${PROJECT}`); } catch (e) { if (e.status !== 404) throw e; }
  if (p) {
    const src = p.source && p.source.config;
    if (!src || src.repo_name !== PROJECT_CFG.source.config.repo_name) throw new Error(`un projet « ${PROJECT} » existe déjà, branché sur ${src ? src.owner + "/" + src.repo_name : "aucun dépôt"} : supprime-le dans le tableau de bord ou change de nom`);
    await cf("PATCH", `/accounts/${acc}/pages/projects/${PROJECT}`, { production_branch: "production", build_config: PROJECT_CFG.build_config, source: PROJECT_CFG.source, deployment_configs: PROJECT_CFG.deployment_configs });
    okM("projet déjà créé ; réglages vérifiés (build, branches)");
    return;
  }
  for (;;) {
    try { await cf("POST", `/accounts/${acc}/pages/projects`, PROJECT_CFG); okM("projet créé, branché sur " + DEV); return; }
    catch (e) {
      if (!/git|github|installation|repository|repo/i.test(e.message)) throw e;
      warn("Cloudflare n'a pas encore accès au dépôt privé sur GitHub (" + e.message + ").");
      info("Sur la page qui s'ouvre : installe / configure l'application « Cloudflare Workers and Pages » sur KerCrafter,");
      info("et ajoute le dépôt « chip-defender-arena-dev » dans « Repository access ».");
      openUrl("https://github.com/apps/cloudflare-workers-and-pages/installations/new");
      await pause();
    }
  }
}

/* ---------- étape 5 ---------- */
async function stepDomain(acc) {
  title("Étape 5 · Domaine " + STAGING_HOST);
  const doms = await cf("GET", `/accounts/${acc}/pages/projects/${PROJECT}/domains`);
  if (!doms.some(d => d.name === STAGING_HOST)) { await cf("POST", `/accounts/${acc}/pages/projects/${PROJECT}/domains`, { name: STAGING_HOST }); okM("domaine ajouté au projet"); await sleep(3000); }
  else okM("domaine déjà rattaché au projet");
  const z = await cf("GET", `/zones?name=${ZONE}`);
  if (!z.length) throw new Error("zone " + ZONE + " invisible avec ce jeton (Zone Resources ?)");
  const zid = z[0].id;
  const recs = await cf("GET", `/zones/${zid}/dns_records?name=${STAGING_HOST}&per_page=50`);
  const other = recs.filter(r => r.type !== "CNAME");
  if (other.length) throw new Error("des enregistrements " + other.map(r => r.type).join(", ") + " existent déjà pour " + STAGING_HOST + " : à supprimer dans le DNS");
  const rec = { type: "CNAME", name: STAGING_HOST, content: STAGING_ALIAS, proxied: true, ttl: 1, comment: "staging Chip Defender Arena (aperçu de la branche staging)" };
  const cn = recs.find(r => r.type === "CNAME");
  if (cn && cn.content === STAGING_ALIAS && cn.proxied) okM("CNAME déjà correct → " + STAGING_ALIAS);
  else if (cn) { await cf("PUT", `/zones/${zid}/dns_records/${cn.id}`, rec); okM("CNAME corrigé → " + STAGING_ALIAS + " (sinon le domaine montrerait la production)"); }
  else { await cf("POST", `/zones/${zid}/dns_records`, rec); okM("CNAME créé → " + STAGING_ALIAS); }
}

/* ---------- constructions et vérification ---------- */
async function build(acc, branch) {
  const fd = new FormData(); fd.append("branch", branch);
  const d = await cf("POST", `/accounts/${acc}/pages/projects/${PROJECT}/deployments`, null, fd);
  info(`construction de « ${branch} » lancée…`);
  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    const s = await cf("GET", `/accounts/${acc}/pages/projects/${PROJECT}/deployments/${d.id}`);
    const st = s.latest_stage || {};
    if (st.status === "success" && st.name === "deploy") { okM(`« ${branch} » construite et publiée (${s.url})`); return true; }
    if (st.status === "failure" || st.status === "canceled") { warn(`la construction de « ${branch} » a échoué (étape ${st.name}) : journal dans le tableau de bord Pages`); return false; }
  }
  warn(`« ${branch} » toujours en cours : suis-la dans le tableau de bord Pages`); return false;
}
async function verify() {
  title("Vérification");
  for (let i = 0; i < 40; i++) {
    try {
      const v = await (await fetch(`https://${STAGING_HOST}/version.json?t=${Date.now()}`, { cache: "no-store" })).json();
      if (v && v.env === "staging") { okM(`https://${STAGING_HOST} répond : staging, version ${v.v}`); break; }
      if (v && v.env) { warn(`le domaine montre « ${v.env} » : le CNAME n'est pas encore pris en compte, réessaie dans quelques minutes`); break; }
    } catch (e) {}
    if (i === 0) info("le certificat HTTPS du domaine peut prendre quelques minutes…");
    await sleep(15000);
    if (i === 39) warn(`https://${STAGING_HOST} ne répond pas encore : réessaie plus tard (relancer le script ne refait que la vérification)`);
  }
  try {
    const a = await (await fetch(AUTH_STAGING, { cache: "no-store" })).json();
    if (a && a.ready && JSON.stringify(a.providers) === '["direct"]') okM("serveur de staging prêt (connexion directe seulement)");
    else warn("serveur de staging : réponse inattendue " + JSON.stringify(a && { ready: a.ready, providers: a.providers }) + " → relance installer-staging.bat");
  } catch (e) { warn("serveur de staging injoignable (" + AUTH_STAGING + ") → relance installer-staging.bat"); }
}

async function main() {
  say(C.b("\n  Chip Defender Arena · mise en place du staging et de la promotion\n"));
  await githubLogin();
  await stepKey();
  await stepPromote();
  await needToken();
  const acc = await account();
  await stepPages(acc);
  await stepDomain(acc);
  title("Premières constructions");
  await build(acc, "staging");
  await build(acc, "production");
  await verify();
  title("Terminé");
  info("Le jeton Cloudflare « cda-staging » peut être supprimé (profil → API Tokens).");
  info("Ensuite : chaque envoi sur staging est publié tout seul ; « Promouvoir en production » dans l'onglet Actions du dépôt privé.");
  info("La production reste servie par GitHub Pages tant que la bascule (docs/STAGING.md, étape 5) n'est pas faite.");
}
main().catch(e => { say(C.r("\n  ✘ " + (e && e.message || e))); say("  Corrige puis relance : les étapes déjà faites seront sautées."); process.exitCode = 1; }).finally(() => rl && rl.close());
