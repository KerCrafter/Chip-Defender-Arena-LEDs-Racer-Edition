#!/usr/bin/env node
/* Chip Defender Arena · publication des cartes sur Cloudflare R2 (maps-cda.kercrafter.live)
   =====================================================================================
   GitHub Pages limite un site à 1 Go : les cartes (SKY130 + IHP) vont dans un « bucket » R2,
   servi par Cloudflare sur https://maps-cda.kercrafter.live/maps/... (même arborescence que le site).

   Utilise la connexion Cloudflare de wrangler déjà faite par installer-serveur.bat : aucun secret en plus.
   Première fois : création du bucket, règles CORS (seul le site du jeu peut lire les cartes depuis la page),
   domaine maps-cda.kercrafter.live. Ensuite : n'envoie que les fichiers nouveaux ou modifiés.

   node publier-r2.mjs --maps <dossier maps> --state <fichier d'état> [--jobs 8] [--prefix maps]
   --prefix maps4 : publie les cartes CDA4 (convertir-cda4.mjs) sous https://maps-cda.kercrafter.live/maps4/... */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { join, dirname, relative, sep, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import * as readline from "node:readline";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const MAPS = resolve(arg("maps", join(HERE, "..", "..", "maps")));   // absolu : wrangler tourne depuis le dossier du serveur
const STATE_F = resolve(arg("state", join(HERE, ".publier-r2.json")));
const ERRLOG = join(dirname(STATE_F), "publier-r2-erreurs.log");
const JOBS = Math.max(1, Math.min(16, +arg("jobs", 8)));
const PREFIX = String(arg("prefix", "maps")).replace(/[^a-z0-9_-]/gi, "") || "maps";   // dossier dans le bucket : maps (CDA3) ou maps4 (CDA4)
const BUCKET = "cda-maps", DOMAIN = "maps-cda.kercrafter.live", ZONE = "kercrafter.live";
const ORIGINS = ["https://chip-defender-arena.kercrafter.live", "https://kercrafter.github.io"];
const SERVEUR = join(HERE, "..", "..", "serveur");
const WRANGLER = join(SERVEUR, "node_modules", "wrangler", "bin", "wrangler.js");
const WIN = process.platform === "win32";

const tty = process.stdout.isTTY;
const C = { b: s => tty ? `\x1b[1m${s}\x1b[0m` : s, g: s => tty ? `\x1b[32m${s}\x1b[0m` : s, y: s => tty ? `\x1b[33m${s}\x1b[0m` : s, r: s => tty ? `\x1b[31m${s}\x1b[0m` : s, c: s => tty ? `\x1b[36m${s}\x1b[0m` : s, d: s => tty ? `\x1b[2m${s}\x1b[0m` : s };
const say = (...a) => console.log(...a), ok = t => say(C.g("  ✔ " + t)), warn = t => say(C.y("  ! " + t)), fail = t => say(C.r("  ✘ " + t));
const title = t => say("\n" + C.b(C.c("━━ " + t)));
const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
const ask = q => rl ? new Promise(r => rl.question(C.b("  ? ") + q + " ", a => r(a.trim()))) : Promise.resolve("");
const load = () => { try { return JSON.parse(readFileSync(STATE_F, "utf8")); } catch (e) { return {}; } };
const save = S => writeFileSync(STATE_F, JSON.stringify(S), "utf8");
function openUrl(u) { try { if (WIN) spawn("cmd", ["/c", "start", "", u], { detached: true, stdio: "ignore" }).unref(); } catch (e) {} say(C.d("     " + u)); }

/* ---------- wrangler ---------- */
const wr = (args, opts = {}) => spawnSync(process.execPath, [WRANGLER, ...args], { cwd: SERVEUR, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, ...opts });
const out = r => (r.stdout || "") + (r.stderr || "");
function wrAsync(args) {
  return new Promise(res => {
    const p = spawn(process.execPath, [WRANGLER, ...args], { cwd: SERVEUR, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
    let o = ""; p.stdout.on("data", d => o += d); p.stderr.on("data", d => o += d);
    p.on("close", code => res({ code, out: o }));
  });
}

/* Connexion Cloudflare de wrangler : jeton valable 1 h, renouvelé par le premier wrangler qui le trouve expiré.
   Huit envois en parallèle le renouvelleraient en même temps (le jeton de renouvellement ne sert qu'une fois)
   et se déconnecteraient mutuellement : on le renouvelle donc ici, seul, avant qu'il expire. */
const CFG = process.env.APPDATA ? join(process.env.APPDATA, "xdg.config", ".wrangler", "config", "default.toml") : join(process.env.HOME || "", ".config", ".wrangler", "config", "default.toml");
function tokenLeft() { try { const m = readFileSync(CFG, "utf8").match(/expiration_time\s*=\s*"([^"]+)"/); return m ? Date.parse(m[1]) - Date.now() : Infinity; } catch (e) { return Infinity; } }
const NOT_LOGGED = /not (logged in|authenticated)|You are not|login|Authentication error|code: 10000|invalid_grant/i;
function ensureLogin() {
  let w = wr(["whoami"]);
  if (w.status !== 0 || NOT_LOGGED.test(out(w)) && !/You are logged in/i.test(out(w))) {
    say("\n  Connexion à Cloudflare (une page s'ouvre dans le navigateur, accepte l'accès)…");
    rl && rl.pause(); spawnSync(process.execPath, [WRANGLER, "login"], { cwd: SERVEUR, stdio: "inherit" }); rl && rl.resume();
    w = wr(["whoami"]);
    if (!/You are logged in/i.test(out(w))) throw new Error("connexion à Cloudflare impossible");
  }
}
async function setup(S) {
  title("Préparation (une seule fois)");
  if (!existsSync(WRANGLER)) throw new Error("wrangler introuvable : lance d'abord installer-serveur.bat (il l'installe)");
  ensureLogin();
  ok("connecté à Cloudflare");
  // 1. bucket
  if (!S.bucket) {
    const r = wr(["r2", "bucket", "create", BUCKET]);
    if (r.status !== 0 && !/already exists|already own/i.test(out(r))) { say(out(r)); throw new Error("création du bucket impossible (R2 doit être activé : tableau de bord → R2 → « Purchase R2 Plan », offre gratuite)"); }
    S.bucket = true; save(S);
  }
  ok("bucket « " + BUCKET + " »");
  // 2. CORS : seules les pages du jeu peuvent lire les cartes
  if (!S.cors) {
    const f = join(HERE, ".cors-r2.json");
    writeFileSync(f, JSON.stringify({ rules: [{ allowed: { origins: ORIGINS, methods: ["GET", "HEAD"] }, maxAgeSeconds: 86400 }] }));
    const r = wr(["r2", "bucket", "cors", "set", BUCKET, "--file", f, "--force"]);
    if (r.status !== 0) { say(out(r)); throw new Error("règles CORS refusées"); }
    S.cors = true; save(S);
  }
  ok("règles CORS (lecture par " + ORIGINS[0] + ")");
  // 3. domaine public
  if (!S.domain) {
    if (!S.zoneId) {
      say("  Il me faut l'identifiant de la zone " + ZONE + " (ce n'est pas un secret) :");
      say("     Cloudflare → " + ZONE + " → page « Overview » → colonne de droite, rubrique « API » → « Zone ID » → copier.");
      openUrl("https://dash.cloudflare.com/?to=/:account/" + ZONE);
      for (;;) { const z = (await ask("Colle le Zone ID :")).replace(/\s/g, ""); if (/^[a-f0-9]{32}$/.test(z)) { S.zoneId = z; save(S); break; } warn("un Zone ID fait 32 caractères (chiffres et lettres a à f)"); }
    }
    const r = wr(["r2", "bucket", "domain", "add", BUCKET, "--domain", DOMAIN, "--zone-id", S.zoneId, "--min-tls", "1.2", "--force"]);
    if (r.status !== 0 && !/already|exists/i.test(out(r))) { say(out(r)); throw new Error("domaine " + DOMAIN + " refusé (une entrée DNS « maps » existe peut-être déjà : supprime-la dans Cloudflare → DNS, puis relance)"); }
    S.domain = true; save(S);
  }
  ok("domaine https://" + DOMAIN);
  S.setup = true; save(S);
}

/* ---------- envoi ---------- */
function walk(d, acc = []) { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p, acc); else if (/\.(bin|json)$/.test(n)) acc.push(p); } return acc; }
const md5 = p => createHash("md5").update(readFileSync(p)).digest("hex");
async function upload(S) {
  title("Envoi des cartes");
  if (!existsSync(MAPS)) throw new Error("dossier des cartes introuvable : " + MAPS);
  S.files = S.files || {};
  const files = walk(MAPS).map(p => ({ p, key: PREFIX + "/" + relative(MAPS, p).split(sep).join("/") }));
  // les cartes d'abord, puis les index (un index ne doit jamais citer une carte pas encore en ligne)
  const rank = k => k.endsWith(".bin") ? 0 : k.endsWith("/index.json") ? 1 : 2;
  files.sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
  say("  Calcul des empreintes de " + files.length + " fichiers…");
  const todo = [];
  for (const f of files) { f.h = md5(f.p) + ":" + statSync(f.p).size; if (S.files[f.key] !== f.h) todo.push(f); }
  if (!todo.length) { ok("tout est déjà en ligne"); return 0; }
  const mo = todo.reduce((a, f) => a + statSync(f.p).size, 0) / 1e6;
  say(`  ${todo.length} fichier(s) à envoyer (${mo.toFixed(0)} Mo), ${JOBS} à la fois. Tu peux fermer et relancer : ce qui est envoyé n'est pas renvoyé.`);
  ensureLogin();
  let done = 0, errs = 0, lastSave = Date.now(), busy = 0, gate = null, stop = false;
  let pauseUntil = 0;
  // une seule reconnexion pour tous les envois qui échouent en même temps
  let relog = null;
  const relogin = () => relog || (relog = (async () => {
    while (gate) await gate;
    let open; gate = new Promise(r => open = r);
    while (busy > 0) await new Promise(r => setTimeout(r, 200));
    try { ensureLogin(); } finally { const g = open; gate = null; g(); setTimeout(() => relog = null, 1000); }
  })());
  // renouvellement du jeton : on attend que les envois en cours finissent, un seul wrangler le renouvelle
  async function checkToken() {
    while (gate) await gate;
    if (tokenLeft() > 5 * 60e3) return;
    let open; gate = new Promise(r => open = r);
    while (busy > 0) await new Promise(r => setTimeout(r, 200));
    try { ensureLogin(); } finally { const g = open; gate = null; g(); }
  }
  const t0 = Date.now();
  // par étapes : toutes les cartes, puis les index, puis la liste des navettes
  for (const r of [0, 1, 2]) {
    const q = todo.filter(f => rank(f.key) === r);
    const worker = async () => {
      for (let f; !stop && (f = q.shift());) {
        await checkToken();
        busy++;
        const json = f.key.endsWith(".json");
        let res;
        for (let tr = 0, lim = 0; tr < 3 && !stop; tr++) {
          // limite de débit de Cloudflare (429) : tout le monde fait une pause, puis on réessaie ce fichier
          while (Date.now() < pauseUntil) await new Promise(r => setTimeout(r, 1000));
          res = await wrAsync(["r2", "object", "put", BUCKET + "/" + f.key, "--file", f.p, "--remote",
            "--content-type", json ? "application/json; charset=utf-8" : "application/octet-stream",
            "--cache-control", json ? "public, max-age=300" : "public, max-age=86400"]);
          if (res.code === 0) break;
          if (/429|Too Many Requests|rate limit/i.test(res.out) && lim++ < 20) {
            if (Date.now() >= pauseUntil) { pauseUntil = Date.now() + 75e3; if (tty) process.stdout.write("\n"); warn("Cloudflare limite le débit : pause de 75 s, puis reprise automatique…"); }
            tr--; continue;
          }
          if (NOT_LOGGED.test(res.out) && !stop) { busy--; await relogin(); busy++; }
        }
        busy--;
        done++;
        if (res.code === 0) { S.files[f.key] = f.h; if (Date.now() - lastSave > 5000) { save(S); lastSave = Date.now(); } }
        else {
          errs++;
          try { appendFileSync(ERRLOG, `\n===== ${new Date().toISOString()} ${f.key}\n${res.out}\n`); } catch (e) {}
          const why = res.out.split("\n").map(l => l.trim()).filter(l => l && !/Logs were written|fallback value|Writing logs|^─+$|^⛅|wrangler \d/.test(l)).slice(-3).join(" ");
          fail(f.key + " : " + (why || "erreur inconnue"));
          if (errs >= 10 && errs >= done / 2) { stop = true; fail("trop d'erreurs : arrêt. Le détail est dans publier-r2-erreurs.log, dis-le à Claude."); }
        }
        if (tty) { const s = (Date.now() - t0) / 1000, eta = s / done * (todo.length - done); process.stdout.write(`\r  ${done}/${todo.length} · ${Math.floor(eta / 60)} min restantes        `); }
      }
    };
    await Promise.all(Array.from({ length: JOBS }, worker));
  }
  save(S); if (tty) say("");
  if (errs) fail(errs + " fichier(s) non envoyé(s) : relance le script, il ne renverra que ceux-là"); else ok("cartes envoyées");
  return errs;
}

async function verify() {
  title("Vérification");
  try {
    const r = await fetch(`https://${DOMAIN}/${PREFIX}/shuttles.json?t=${Date.now()}`, { headers: { origin: ORIGINS[0] } });
    const j = r.ok ? await r.json() : null;
    if (!j) { fail(`https://${DOMAIN}/${PREFIX}/shuttles.json répond ${r.status} (le domaine peut mettre quelques minutes à être prêt)`); return; }
    ok(`${j.length} navettes, ${j.reduce((a, s) => a + (+s.maps || 0), 0)} cartes en ligne sur https://${DOMAIN}`);
    if (r.headers.get("access-control-allow-origin")) ok("le site du jeu a le droit de les lire (CORS)"); else warn("en-tête CORS absent pour l'instant (quelques minutes de propagation)");
  } catch (e) {
    const c = String(e.cause && (e.cause.code || e.cause.message) || e.message);
    fail("vérification impossible : " + c);
  }
}

async function main() {
  say(C.b("\n  Chip Defender Arena · cartes sur Cloudflare R2 (" + DOMAIN + ")\n"));
  const S = load();
  if (!S.setup) await setup(S);
  const errs = await upload(S);
  await verify();
  if (!errs) say("\n  C'est en ligne : les joueurs voient les nouvelles cartes en rechargeant le jeu (cache de 5 min pour les index).");
  process.exitCode = errs ? 1 : 0;
}
main().catch(e => { fail(e.message); process.exitCode = 1; }).finally(() => rl && rl.close());
