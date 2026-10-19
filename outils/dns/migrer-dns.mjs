#!/usr/bin/env node
/* Chip Defender Arena · migration de la zone DNS kercrafter.live d'OVH vers Cloudflare, sans coupure
   ==================================================================================================
   Principe : Cloudflare reçoit d'abord une copie EXACTE de la zone (en « DNS seul », comme chez OVH).
   L'assistant interroge directement les serveurs d'OVH et ceux de Cloudflare et ne propose de basculer
   que lorsque les deux répondent la même chose pour chaque entrée. Pendant la propagation, quel que soit
   le serveur interrogé, la réponse est donc identique : aucune coupure.
   Ensuite seulement : HTTPS, proxy Cloudflare devant le jeu et en-têtes de sécurité (avec retour arrière).

   Lancer : migrer-dns.bat (Windows) ou « node migrer-dns.mjs ». Rien de secret n'est écrit sur le disque :
   le jeton Cloudflare est demandé à chaque lancement. */
import { promises as dnsp } from "node:dns";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import * as readline from "node:readline";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_F = join(HERE, ".migration-dns.json");
const ZONE_F = join(HERE, "zone-ovh.txt");
const DOMAIN = (process.env.CDA_DOMAIN || "kercrafter.live").toLowerCase();
const GAME = "chip-defender-arena." + DOMAIN;
const CF = "https://api.cloudflare.com/client/v4";
const WIN = process.platform === "win32";
const TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "CAA", "SRV"];

/* ---------- affichage et saisie ---------- */
const tty = process.stdout.isTTY;
const C = { b: s => tty ? `\x1b[1m${s}\x1b[0m` : s, g: s => tty ? `\x1b[32m${s}\x1b[0m` : s, y: s => tty ? `\x1b[33m${s}\x1b[0m` : s, c: s => tty ? `\x1b[36m${s}\x1b[0m` : s, r: s => tty ? `\x1b[31m${s}\x1b[0m` : s, d: s => tty ? `\x1b[2m${s}\x1b[0m` : s };
const say = (...a) => console.log(...a);
const title = t => say("\n" + C.b(C.c("━━ " + t + " " + "━".repeat(Math.max(3, 64 - t.length)))));
const step = (n, t) => say(`  ${C.b(n + ".")} ${t}`);
const val = (l, v) => say(`     ${l} : ${C.b(C.y(v))}`);
const okM = t => say(C.g("  ✔ " + t)), warn = t => say(C.y("  ! " + t)), fail = t => say(C.r("  ✘ " + t));
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
const load = () => { try { return JSON.parse(readFileSync(STATE_F, "utf8")); } catch (e) { return {}; } };
const save = s => writeFileSync(STATE_F, JSON.stringify(s, null, 1), "utf8");

/* ---------- lecture de la zone OVH (mode textuel, format BIND) ---------- */
export function parseZone(text, origin = DOMAIN) {
  const out = []; let last = origin, ttl = 3600, paren = false;
  for (let raw of String(text).split(/\r?\n/)) {
    let line = raw.replace(/;(?=(?:[^"]*"[^"]*")*[^"]*$).*$/, "");   // commentaires hors guillemets
    if (paren) { if (line.includes(")")) paren = false; continue; }
    if (!line.trim()) continue;
    if (/^\$TTL\s+(\d+)/i.test(line.trim())) { ttl = +line.trim().split(/\s+/)[1]; continue; }
    if (/^\$ORIGIN/i.test(line.trim())) continue;
    const startsBlank = /^\s/.test(line);
    const tok = line.trim().match(/"(?:[^"\\]|\\.)*"|\S+/g) || [];
    let i = 0, owner = last;
    if (!startsBlank) { owner = tok[i++]; }
    let rttl = ttl;
    while (i < tok.length && (/^\d+$/.test(tok[i]) || /^(IN|CH|HS)$/i.test(tok[i]))) { if (/^\d+$/.test(tok[i])) rttl = +tok[i]; i++; }
    const type = (tok[i++] || "").toUpperCase();
    const rdata = tok.slice(i);
    if (line.includes("(") && !line.includes(")")) paren = true;
    if (!type) continue;
    owner = fqdn(owner, origin); last = owner;
    if (type === "SOA" || type === "NS" && owner === origin) continue;   // gérés par l'hébergeur DNS
    out.push({ name: owner, type, ttl: rttl, rdata });
  }
  return out;
}
export function fqdn(n, origin = DOMAIN) {
  n = String(n || "").toLowerCase();
  if (n === "@" || n === "") return origin;
  if (n.endsWith(".")) return n.slice(0, -1);
  return n === origin || n.endsWith("." + origin) ? n : n + "." + origin;
}
// entrée de zone → forme normalisée (pour comparer) et forme Cloudflare (pour créer)
export function normRec(r, origin = DOMAIN) {
  const d = r.rdata, host = x => fqdn(x, origin);
  switch (r.type) {
    case "A": case "AAAA": return { key: d[0] };
    case "CNAME": case "NS": return { key: host(d[0]) };
    case "MX": return { key: +d[0] + " " + host(d[1]) };
    case "TXT": return { key: d.map(x => x.replace(/^"|"$/g, "").replace(/\\"/g, '"')).join("") };
    case "CAA": return { key: `${+d[0]} ${d[1].toLowerCase()} ${d.slice(2).join(" ").replace(/^"|"$/g, "")}` };
    case "SRV": return { key: `${+d[0]} ${+d[1]} ${+d[2]} ${host(d[3])}` };
    default: return { key: d.join(" ") };
  }
}
export function toCloudflare(r, origin = DOMAIN) {
  const d = r.rdata, host = x => fqdn(x, origin), base = { type: r.type, name: r.name, ttl: 1, proxied: false };
  switch (r.type) {
    case "A": case "AAAA": return { ...base, content: d[0] };
    case "CNAME": return { ...base, content: host(d[0]) };
    case "NS": return { type: "NS", name: r.name, ttl: 1, content: host(d[0]) };   // sous-domaine délégué
    case "MX": return { type: "MX", name: r.name, ttl: 1, priority: +d[0], content: host(d[1]) };
    case "TXT": return { type: "TXT", name: r.name, ttl: 1, content: d.map(x => x.replace(/^"|"$/g, "").replace(/\\"/g, '"')).join("") };
    case "CAA": return { type: "CAA", name: r.name, ttl: 1, data: { flags: +d[0], tag: d[1].toLowerCase(), value: d.slice(2).join(" ").replace(/^"|"$/g, "") } };
    case "SRV": return { type: "SRV", name: r.name, ttl: 1, data: { priority: +d[0], weight: +d[1], port: +d[2], target: host(d[3]) } };
    default: return null;
  }
}
// entrée Cloudflare → clé normalisée
export function cfKey(x) {
  switch (x.type) {
    case "MX": return x.priority + " " + String(x.content).toLowerCase().replace(/\.$/, "");
    case "TXT": return String(x.content).replace(/^"|"$/g, "").replace(/" "/g, "");
    case "CNAME": case "NS": return String(x.content).toLowerCase().replace(/\.$/, "");
    case "CAA": return x.data ? `${x.data.flags} ${x.data.tag} ${x.data.value}` : x.content;
    case "SRV": return x.data ? `${x.data.priority} ${x.data.weight} ${x.data.port} ${String(x.data.target).toLowerCase().replace(/\.$/, "")}` : x.content;
    default: return String(x.content);
  }
}

/* ---------- interrogation directe d'un serveur DNS ---------- */
const resolverCache = new Map();
async function resolverFor(nsName) {
  if (resolverCache.has(nsName)) return resolverCache.get(nsName);
  const ips = await dnsp.resolve4(nsName).catch(() => []);
  if (!ips.length) throw new Error("serveur DNS introuvable : " + nsName);
  const r = new dnsp.Resolver({ timeout: 4000, tries: 2 }); r.setServers(ips.slice(0, 2));
  resolverCache.set(nsName, r); return r;
}
export async function askNs(nsName, name, type) {
  const r = await resolverFor(nsName);
  try {
    switch (type) {
      case "A": return (await r.resolve4(name)).sort();
      case "AAAA": return (await r.resolve6(name)).sort();
      case "CNAME": return (await r.resolveCname(name)).map(x => x.toLowerCase().replace(/\.$/, "")).sort();
      case "MX": return (await r.resolveMx(name)).map(x => x.priority + " " + x.exchange.toLowerCase().replace(/\.$/, "")).sort();
      case "TXT": return (await r.resolveTxt(name)).map(x => x.join("")).sort();
      case "CAA": return (await r.resolveCaa(name)).map(x => `${x.critical ? 128 : 0} ${Object.keys(x).find(k => k !== "critical")} ${x[Object.keys(x).find(k => k !== "critical")]}`).sort();
      case "SRV": return (await r.resolveSrv(name)).map(x => `${x.priority} ${x.weight} ${x.port} ${x.name.toLowerCase()}`).sort();
      case "NS": return (await r.resolveNs(name)).map(x => x.toLowerCase()).sort();
    }
  } catch (e) { if (["ENODATA", "ENOTFOUND", "ENOENT"].includes(e.code)) return []; throw e; }
  return [];
}
async function doh(name, type) {   // résolveur public (DNSSEC, propagation)
  const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: "application/dns-json" } });
  return r.ok ? r.json() : null;
}

/* ---------- API Cloudflare ---------- */
let TOKEN = "";
async function cf(method, path, body) {
  const r = await fetch(CF + path, { method, headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!j.success) { const e = new Error((j.errors || []).map(x => x.message + (x.code ? " (" + x.code + ")" : "")).join(" ; ") || "HTTP " + r.status); e.status = r.status; e.cfErrors = j.errors; throw e; }
  return j.result;
}
async function cfAllRecords(zid) { return cf("GET", `/zones/${zid}/dns_records?per_page=500`); }
async function needToken() {
  if (TOKEN) return;
  title("Jeton Cloudflare");
  say("  L'assistant a besoin d'un jeton limité à ta zone (tu pourras le supprimer à la fin).");
  step(1, "Cloudflare → ton profil → « API Tokens » → « Create Token » → « Create Custom Token ».");
  if (await yes("Ouvrir la page des jetons ?", true)) openUrl("https://dash.cloudflare.com/profile/api-tokens");
  val("Nom", "cda-migration-dns");
  val("Permissions", "Zone · Zone · Read   +   Zone · DNS · Edit");
  val("            ", "Zone · Zone Settings · Edit   +   Zone · Transform Rules · Edit");
  val("Zone Resources", `Include · Specific zone · ${DOMAIN}`);
  step(2, "« Continue to summary » → « Create Token » → copie le jeton.");
  for (;;) {
    TOKEN = await askSecret("Colle le jeton :");
    if (!TOKEN) throw new Error("jeton nécessaire");
    try { await cf("GET", "/user/tokens/verify"); okM("jeton valide"); return; } catch (e) { fail("jeton refusé : " + e.message); TOKEN = ""; }
  }
}
async function zoneOf(S) {
  const z = await cf("GET", `/zones?name=${DOMAIN}`);
  if (!z.length) return null;
  S.zone = { id: z[0].id, ns: z[0].name_servers || [], status: z[0].status }; save(S);
  return z[0];
}

/* ---------- étapes ---------- */
async function stepInventory(S) {
  title("Étape 1 · Inventaire de la zone chez OVH");
  const ns = await askNs((await dnsp.resolveNs(DOMAIN))[0], DOMAIN, "NS").catch(() => []);
  const cur = ns.length ? ns : (await dnsp.resolveNs(DOMAIN)).map(x => x.toLowerCase()).sort();
  S.ovhNs = cur.filter(x => !/cloudflare\.com$/.test(x)); save(S);
  val("Serveurs DNS actuels", cur.join(", "));
  if (cur.some(x => /cloudflare\.com$/.test(x))) { okM("la zone est déjà chez Cloudflare"); return; }
  say("\n  Pour ne rien oublier, recopie la zone complète depuis OVH :");
  step(1, "OVH Manager → Web Cloud → Noms de domaine → " + DOMAIN + " → onglet « Zone DNS ».");
  if (await yes("Ouvrir l'espace client OVH ?", true)) openUrl("https://www.ovh.com/manager/#/web/domain/" + DOMAIN + "/zone");
  step(2, "Clique sur « Modifier en mode textuel », sélectionne tout le texte (Ctrl+A) et copie-le (Ctrl+C).");
  step(3, "Colle-le dans le fichier zone-ovh.txt que j'ouvre dans le Bloc-notes, enregistre (Ctrl+S) et ferme.");
  if (!existsSync(ZONE_F)) writeFileSync(ZONE_F, "; colle ici la zone OVH (mode textuel), puis enregistre\n", "utf8");
  try { if (WIN) spawn("notepad", [ZONE_F], { detached: true, stdio: "ignore" }).unref(); else say(C.d("     fichier : " + ZONE_F)); } catch (e) {}
  await pause();
  const recs = parseZone(readFileSync(ZONE_F, "utf8"));
  if (!recs.length) { warn("zone-ovh.txt est vide : je relève seulement les entrées habituelles."); }
  // entrées courantes vérifiées en plus (au cas où le copier-coller serait incomplet)
  const probe = [];
  for (const name of [DOMAIN, "www." + DOMAIN, GAME, "_dmarc." + DOMAIN, "mail." + DOMAIN, "autodiscover." + DOMAIN])
    for (const type of TYPES) {
      if (recs.some(r => r.name === name && r.type === type)) continue;
      const v = await askNs(S.ovhNs[0], name, type).catch(() => []);
      if (!v.length || (type !== "CNAME" && (await askNs(S.ovhNs[0], name, "CNAME").catch(() => [])).length)) continue;
      probe.push({ name, type, values: v });
    }
  S.records = recs; S.extra = probe; save(S);
  say("");
  for (const r of recs) say(`     ${r.name.padEnd(36)} ${r.type.padEnd(5)} ${r.rdata.join(" ").slice(0, 60)}`);
  for (const p of probe) say(C.y(`     ${p.name.padEnd(36)} ${p.type.padEnd(5)} ${p.values.join(" | ").slice(0, 60)}  (trouvée en interrogeant OVH)`));
  okM(`${recs.length} entrée(s) lue(s) dans la zone OVH` + (probe.length ? `, ${probe.length} trouvée(s) en plus` : ""));
  if (probe.length) warn("Des entrées existent chez OVH mais pas dans ton copier-coller : vérifie zone-ovh.txt, ou je les recopierai telles que relevées.");
  // DNSSEC : s'il est actif, il faut le couper chez OVH AVANT la bascule
  const ds = await doh(DOMAIN, "DS").catch(() => null);
  S.dnssec = !!(ds && Array.isArray(ds.Answer) && ds.Answer.some(a => a.type === 43)); save(S);
  if (S.dnssec) {
    warn("DNSSEC est actif sur " + DOMAIN + ". Il faut le désactiver chez OVH avant de changer les serveurs DNS,");
    say("     puis attendre que la signature disparaisse (jusqu'à 24 h). L'assistant le vérifie à l'étape 4.");
    say("     OVH Manager → " + DOMAIN + " → onglet « Zone DNS » ou « DNSSEC » → Désactiver.");
  } else okM("DNSSEC inactif : rien à faire");
}

async function stepZone(S) {
  title("Étape 2 · Zone Cloudflare");
  await needToken();
  let z = await zoneOf(S).catch(e => { if (e.status === 403) throw new Error("le jeton n'a pas accès à " + DOMAIN + " (Zone Resources)"); throw e; });
  if (!z) {
    say("  La zone n'existe pas encore chez Cloudflare. Ajoute-la (offre gratuite) :");
    step(1, "Tableau de bord → « Add a domain » (Ajouter un domaine) → " + DOMAIN + " → « Quick scan for DNS records ».");
    if (await yes("Ouvrir Cloudflare ?", true)) openUrl("https://dash.cloudflare.com/?to=/:account/add-site");
    step(2, "Choisis l'offre « Free ». Ne change PAS encore les serveurs DNS chez OVH : l'assistant le dira au bon moment.");
    await pause("Appuie sur Entrée quand le domaine apparaît dans Cloudflare…");
    z = await zoneOf(S);
    if (!z) throw new Error("zone introuvable : vérifie l'orthographe, et que le jeton couvre bien " + DOMAIN);
  }
  okM(`zone ${DOMAIN} : ${z.status === "active" ? "active" : "en attente (normal avant la bascule)"}`);
  val("Serveurs Cloudflare attribués", (z.name_servers || []).join(", "));
}

// copie exacte en « DNS seul », puis comparaison serveur par serveur
async function stepCopy(S) {
  title("Étape 3 · Copie exacte des entrées chez Cloudflare");
  await needToken(); const z = await zoneOf(S); if (!z) throw new Error("fais d'abord l'étape 2");
  if (!S.records) throw new Error("fais d'abord l'étape 1");
  const want = new Map();
  for (const r of S.records) { const cfr = toCloudflare(r); if (!cfr) { warn(`type ${r.type} non géré, à recopier à la main : ${r.name}`); continue; } const k = r.name + "|" + r.type; if (!want.has(k)) want.set(k, []); want.get(k).push({ key: normRec(r).key, cfr }); }
  for (const p of S.extra || []) for (const v of p.values) {
    const k = p.name + "|" + p.type; if (!want.has(k)) want.set(k, []);
    if (want.get(k).some(x => x.key === v)) continue;
    const rd = p.type === "MX" ? v.split(" ") : p.type === "TXT" ? ['"' + v + '"'] : [v];
    want.get(k).push({ key: v, cfr: toCloudflare({ name: p.name, type: p.type, rdata: rd }) });
  }
  const have = await cfAllRecords(z.id);
  let created = 0, fixed = 0, removed = 0;
  for (const [k, list] of want) {
    const [name, type] = k.split("|");
    const cur = have.filter(x => x.name === name && x.type === type);
    for (const w of list) {
      const h = cur.find(x => cfKey(x) === w.key);
      if (!h) { await cf("POST", `/zones/${z.id}/dns_records`, w.cfr); created++; }
      else if (h.proxied) { await cf("PATCH", `/zones/${z.id}/dns_records/${h.id}`, { proxied: false }); fixed++; }   // identique à OVH : pas de proxy pendant la bascule
    }
    for (const h of cur) if (!list.some(w => w.key === cfKey(h))) {
      if (await yes(`Cloudflare a ajouté ${h.type} ${h.name} → ${cfKey(h)}, absent chez OVH. Le supprimer ?`, true)) { await cf("DELETE", `/zones/${z.id}/dns_records/${h.id}`); removed++; }
    }
  }
  // entrées ajoutées par l'analyse de Cloudflare sur des noms absents chez OVH
  for (const h of have) {
    if (h.type === "SOA" || (h.type === "NS" && h.name === DOMAIN) || want.has(h.name + "|" + h.type)) continue;
    if (await yes(`Entrée en trop chez Cloudflare : ${h.type} ${h.name} → ${cfKey(h)}. La supprimer ?`, true)) { await cf("DELETE", `/zones/${z.id}/dns_records/${h.id}`); removed++; }
  }
  okM(`${created} créée(s), ${fixed} passée(s) en « DNS seul », ${removed} supprimée(s)`);
  await stepCompare(S, want);
}
async function stepCompare(S, want) {
  title("Comparaison OVH ↔ Cloudflare, serveur par serveur");
  const z = S.zone; if (!z || !z.ns.length) throw new Error("zone Cloudflare inconnue");
  if (!want) { want = new Map(); for (const r of S.records || []) want.set(r.name + "|" + r.type, 1); for (const p of S.extra || []) want.set(p.name + "|" + p.type, 1); }
  let bad = 0;
  for (const k of want.keys()) {
    const [name, type] = k.split("|");
    if (type === "NS") { say(`  ${C.d("·")} ${name.padEnd(36)} NS    ${C.d("délégation recopiée, non comparable directement")}`); continue; }
    const a = await askNs(S.ovhNs[0], name, type).catch(e => ["erreur " + e.code]);
    const b = await askNs(z.ns[0], name, type).catch(e => ["erreur " + e.code]);
    const same = JSON.stringify(a) === JSON.stringify(b);
    if (!same) bad++;
    say(`  ${same ? C.g("=") : C.r("≠")} ${name.padEnd(36)} ${type.padEnd(5)} ${same ? C.d(a.join(" | ").slice(0, 50)) : `OVH : ${a.join(" | ").slice(0, 40)}  ·  Cloudflare : ${b.join(" | ").slice(0, 40)}`}`);
  }
  S.identical = bad === 0; save(S);
  if (bad) fail(`${bad} différence(s) : ne bascule pas encore (relance l'étape 3 après correction).`);
  else okM("les deux hébergeurs répondent exactement la même chose : la bascule se fera sans coupure");
  return !bad;
}

async function stepSwitch(S) {
  title("Étape 4 · Bascule des serveurs DNS chez OVH");
  await needToken(); const z = await zoneOf(S);
  if (z.status === "active") { okM("Cloudflare gère déjà la zone : bascule terminée"); return; }
  if (!(await stepCompare(S))) return;
  if (S.dnssec) {
    const ds = await doh(DOMAIN, "DS").catch(() => null);
    if (ds && Array.isArray(ds.Answer) && ds.Answer.some(a => a.type === 43)) { fail("DNSSEC est encore actif (signature DS visible) : désactive-le chez OVH puis réessaie plus tard."); return; }
    okM("DNSSEC désactivé et signature disparue");
  }
  step(1, "OVH Manager → " + DOMAIN + " → onglet « Serveurs DNS » → « Modifier les serveurs DNS ».");
  if (await yes("Ouvrir l'espace client OVH ?", true)) openUrl("https://www.ovh.com/manager/#/web/domain/" + DOMAIN + "/dns");
  step(2, "Remplace les serveurs OVH par ces deux serveurs Cloudflare (et seulement eux) :");
  for (const n of z.name_servers) val("Serveur DNS", n);
  step(3, "Valide. OVH applique le changement en quelques minutes ; l'Internet le découvre en quelques heures.");
  await pause();
  say("  Je surveille la propagation (Ctrl+C pour arrêter ; relance l'étape 4 plus tard, rien n'est perdu).");
  for (let i = 0; i < 360; i++) {
    let st = "";
    try { if (i % 10 === 0) await cf("PUT", `/zones/${z.id}/activation_check`).catch(() => {}); st = (await cf("GET", `/zones/${z.id}`)).status; } catch (e) {}
    const pub = await doh(DOMAIN, "NS").catch(() => null), pubNs = pub && pub.Answer ? pub.Answer.map(a => a.data.toLowerCase().replace(/\.$/, "")) : [];
    process.stdout.write(`\r  ${new Date().toLocaleTimeString()} · Cloudflare : ${st || "?"} · résolveur public : ${pubNs.join(", ") || "?"}        `);
    if (st === "active") { say(""); okM("Cloudflare gère maintenant la zone. Le site n'a pas bougé : mêmes réponses qu'avant."); S.active = true; save(S); return; }
    await sleep(60000);
  }
  say(""); warn("pas encore actif : relance l'étape 4 plus tard.");
}

async function siteCheck(expectCf) {
  try {
    const r = await fetch("https://" + GAME + "/?t=" + Date.now(), { redirect: "manual" });
    const t = r.status === 200 ? await r.text() : "";
    const viaCf = !!r.headers.get("cf-ray");
    return { ok: r.status === 200 && t.includes("window.CDA_BUILD"), status: r.status, viaCf, headers: r.headers };
  } catch (e) { return { ok: false, status: 0, err: e.message }; }
}
const HEADERS = {
  "Strict-Transport-Security": "max-age=86400",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; upgrade-insecure-requests"
};
async function stepProxy(S) {
  title("Étape 5 · HTTPS, proxy Cloudflare et en-têtes de sécurité");
  await needToken(); const z = await zoneOf(S);
  if (z.status !== "active") { fail("la zone n'est pas encore active chez Cloudflare (étape 4)"); return; }
  // 1. HTTPS de bout en bout (jamais « Flexible » : boucle de redirection avec GitHub Pages)
  await cf("PATCH", `/zones/${z.id}/settings/ssl`, { value: "full" }); okM("SSL/TLS : Full");
  await cf("PATCH", `/zones/${z.id}/settings/always_use_https`, { value: "on" }); okM("toujours HTTPS");
  await cf("PATCH", `/zones/${z.id}/settings/min_tls_version`, { value: "1.2" }); okM("TLS 1.2 minimum");
  // 2. en-têtes de sécurité (appliqués seulement au jeu ; le futur site KerCrafter Lab aura les siens)
  const phase = `/zones/${z.id}/rulesets/phases/http_response_headers_transform/entrypoint`;
  let rules = [];
  try { rules = ((await cf("GET", phase)).rules || []).map(({ id, version, last_updated, ref, ...r }) => r); } catch (e) { if (e.status !== 404) throw e; }
  const desc = "Chip Defender Arena · en-têtes de sécurité";
  rules = rules.filter(r => r.description !== desc);
  rules.push({ description: desc, expression: `(http.host eq "${GAME}")`, action: "rewrite", enabled: true,
    action_parameters: { headers: Object.fromEntries(Object.entries(HEADERS).map(([k, v]) => [k, { operation: "set", value: v }])) } });
  await cf("PUT", phase, { rules }); okM("en-têtes de sécurité prêts (ils s'appliquent dès que le proxy est actif)");
  // 3. proxy devant le jeu, avec vérification et retour arrière automatique
  const recs = (await cfAllRecords(z.id)).filter(x => x.name === GAME);
  if (!recs.length) throw new Error("entrée " + GAME + " introuvable");
  for (const h of recs) await cf("PATCH", `/zones/${z.id}/dns_records/${h.id}`, { proxied: true });
  say("  Proxy activé sur " + GAME + ", vérification du site (jusqu'à 2 min)…");
  let res = null;
  for (let i = 0; i < 12; i++) { await sleep(10000); res = await siteCheck(); process.stdout.write(`\r  essai ${i + 1} : HTTP ${res.status}${res.viaCf ? " via Cloudflare" : ""}      `); if (res.ok && res.viaCf) break; }
  say("");
  if (!(res && res.ok)) {
    fail("le site ne répond pas correctement derrière le proxy : retour au mode direct (DNS seul).");
    for (const h of recs) await cf("PATCH", `/zones/${z.id}/dns_records/${h.id}`, { proxied: false });
    warn("Le site sert à nouveau comme avant. Envoie-moi le message ci-dessus pour que je regarde.");
    return;
  }
  okM("le jeu répond derrière Cloudflare");
  const miss = Object.keys(HEADERS).filter(k => !res.headers.get(k));
  if (miss.length) warn("en-têtes pas encore visibles (cache) : " + miss.join(", ") + " — relance l'étape 6 dans quelques minutes"); else okM("tous les en-têtes de sécurité sont présents");
  S.proxied = true; save(S);
}
async function stepVerify(S) {
  title("Étape 6 · Vérification");
  const res = await siteCheck();
  val("Site", res.ok ? "OK (HTTP 200, jeu servi)" : "PROBLÈME (HTTP " + res.status + ")");
  val("Passe par Cloudflare", res.viaCf ? "oui" : "non");
  if (res.headers) for (const k of Object.keys(HEADERS)) say(`     ${res.headers.get(k) ? C.g("✔") : C.r("✘")} ${k}`);
  for (const f of ["auth.json", "version.json", "dons.json", "manifest.webmanifest"]) {
    const r = await fetch(`https://${GAME}/${f}?t=${Date.now()}`).catch(() => null);
    say(`     ${r && r.ok ? C.g("✔") : C.r("✘")} /${f}`);
  }
  const ns = (await doh(DOMAIN, "NS").catch(() => null)) || {};
  val("Serveurs DNS vus d'Internet", (ns.Answer || []).map(a => a.data).join(", ") || "?");
  say("  Côté GitHub (dépôt → Settings → Pages) : laisse « Enforce HTTPS » coché. Un avertissement sur le DNS peut");
  say("  apparaître avec le proxy : il est sans effet, GitHub sert le site d'après le nom demandé.");
}
async function stepRollback(S) {
  title("Retour arrière : jeu en accès direct (sans proxy)");
  await needToken(); const z = await zoneOf(S);
  for (const h of (await cfAllRecords(z.id)).filter(x => x.name === GAME)) await cf("PATCH", `/zones/${z.id}/dns_records/${h.id}`, { proxied: false });
  S.proxied = false; save(S);
  okM("proxy coupé : le jeu est servi directement par GitHub Pages (effet en quelques minutes)");
}

async function main() {
  say(C.b(`\n  Chip Defender Arena · migration de ${DOMAIN} vers Cloudflare, sans coupure\n`));
  const S = load();
  for (;;) {
    say("\n  " + C.b("Étapes") + C.d(`  (où tu en es : ${S.proxied ? "terminé" : S.active ? "zone active, reste l'étape 5" : S.identical ? "copie identique, prêt pour l'étape 4" : S.zone ? "zone créée" : S.records ? "inventaire fait" : "début"})`));
    say("   1. Inventaire de la zone OVH (et DNSSEC)\n   2. Zone Cloudflare\n   3. Copie exacte des entrées + comparaison\n   4. Bascule des serveurs DNS chez OVH (+ suivi)\n   5. HTTPS, proxy et en-têtes de sécurité\n   6. Vérification\n   9. Retour arrière (jeu sans proxy)\n   0. Quitter");
    const c = await ask("Ton choix :");
    try {
      if (c === "1") await stepInventory(S);
      else if (c === "2") await stepZone(S);
      else if (c === "3") await stepCopy(S);
      else if (c === "4") await stepSwitch(S);
      else if (c === "5") await stepProxy(S);
      else if (c === "6") await stepVerify(S);
      else if (c === "9") await stepRollback(S);
      else if (c === "0" || c === "") return;
    } catch (e) { fail(e.message); }
  }
}
if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])) main().catch(e => { fail(e.message); process.exitCode = 1; }).finally(() => rl && rl.close());
