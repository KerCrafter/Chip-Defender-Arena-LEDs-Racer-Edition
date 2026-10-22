// essai de bout en bout contre « wrangler dev » (DEV=1)
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import WebSocket from "ws";
const B = process.argv[2] || "http://127.0.0.1:8787", R = "http://localhost:5173/jeu";
const ok = (c, m) => { console.log((c ? "OK   " : "ÉCHEC") + " " + m); if (!c) process.exitCode = 1; };
const hex = u => Buffer.from(u).toString("hex");
async function login(name) {
  const r = await fetch(`${B}/login/dev?r=${encodeURIComponent(R)}&name=${name}&n=testnonce42`, { redirect: "manual" });
  return new URL(r.headers.get("location")).hash.slice(1).replace(/&n=.*$/, "");
}
async function session(frag, sk) {
  const tok = frag.replace(/^cda=/, "").replace(/&n=.*$/, "");
  const r = await fetch(B + "/session", { method: "POST", headers: { authorization: "Bearer " + tok, origin: "http://localhost:5173", "content-type": "application/json" }, body: JSON.stringify({ pk: getPublicKey(sk) }) });
  return { status: r.status, cors: r.headers.get("access-control-allow-origin"), j: await r.json() };
}
function sock(token, legacy) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(B.replace("http", "ws") + "/relay" + (legacy ? "?t=" + encodeURIComponent(token) : ""));
    if (!legacy && token) ws.on("open", () => ws.send(JSON.stringify(["CDA_AUTH", token])));
    const inbox = []; let waiters = [];
    ws.on("message", d => { const m = JSON.parse(d); inbox.push(m); waiters = waiters.filter(w => !(w.f(m) && (w.r(m), true))); });
    ws.on("open", () => res({ ws, inbox, send: m => ws.send(JSON.stringify(m)), wait: (f, ms = 3000) => new Promise((r, j) => { const hit = inbox.find(f); if (hit) return r(hit); waiters.push({ f, r }); setTimeout(() => j(new Error("délai dépassé")), ms); }) }));
    ws.on("unexpected-response", (q, r) => rej(new Error("HTTP " + r.statusCode)));
    ws.on("error", rej);
  });
}

const a = await login("alice"), b = await login("bob"), bad = await login("mechant");
ok(a.startsWith("cda="), "connexion dev d'Alice → session dans le fragment");
ok(bad === "cda_err=banni", "joueur banni refusé à la connexion");
const r0 = await fetch(`${B}/login/dev?r=${encodeURIComponent("https://evil.example/")}`, { redirect: "manual" });
ok(r0.status === 400, "adresse de retour étrangère refusée");

const skA = generateSecretKey(), skB = generateSecretKey();
const sA = await session(a, skA), sB = await session(b, skB);
ok(sA.status === 200 && sA.j.key && sA.j.token && sA.j.user.name === "alice", "session : clé de l'heure + jeton d'identité");
ok(sA.cors === "http://localhost:5173", "CORS pour le site autorisé");
ok(sA.j.key === sB.j.key && sA.j.h === Math.floor(Date.now() / 3600e3), "même clé K(h) pour tous les joueurs");
const s401 = await fetch(B + "/session", { method: "POST", headers: { authorization: "Bearer xxx.yyy" }, body: "{}" });
ok(s401.status === 401, "session falsifiée refusée");

// le jeton d'identité se vérifie avec la clé publique
const info = await (await fetch(B + "/")).json();
const [p, sg] = sA.j.token.split(".");
const pub = await crypto.subtle.importKey("raw", Buffer.from(info.pubkey, "base64url"), { name: "Ed25519" }, false, ["verify"]);
ok(await crypto.subtle.verify({ name: "Ed25519" }, pub, Buffer.from(sg, "base64url"), new TextEncoder().encode(p)), "jeton vérifié avec la clé publique (comme le fera le navigateur)");
const tamper = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url")), n: "admin" })).toString("base64url");
ok(!(await crypto.subtle.verify({ name: "Ed25519" }, pub, Buffer.from(sg, "base64url"), new TextEncoder().encode(tamper))), "jeton modifié détecté");

// relais
let refused = ""; try { await sock("faux", true); } catch (e) { refused = e.message; }
ok(refused === "HTTP 401", "relais : ancienne forme (?t=) avec faux jeton refusée");
const rn = await fetch(`${B}/login/dev?r=${encodeURIComponent(R)}&name=nonce&n=abcdef1234`, { redirect: "manual" });
ok(new URL(rn.headers.get("location")).hash.endsWith("&n=abcdef1234"), "connexion : le nonce de la page revient avec la session");
// connexion sans authentification : rien n'est relayé, puis fermeture
const anon = await sock(null);
anon.send(["REQ", "x", { kinds: [42] }]);
const fake = await sock("xxx.yyy");
ok(!!(await fake.wait(m => m[0] === "NOTICE" && m[1] === "CDA_AUTH refusé").catch(() => null)), "relais : CDA_AUTH avec faux jeton refusé");
const A = await sock(sA.j.token), Bs = await sock(sB.j.token);
Bs.send(["REQ", "salon", { kinds: [42], "#t": ["salon-" + sA.j.h] }]);
await Bs.wait(m => m[0] === "EOSE" && m[1] === "salon");
const ev = finalizeEvent({ kind: 42, created_at: Math.floor(Date.now() / 1000), tags: [["t", "salon-" + sA.j.h]], content: "message chiffré (test)" }, skA);
A.send(["EVENT", ev]);
ok((await A.wait(m => m[0] === "OK" && m[1] === ev.id))[2] === true, "relais : message signé accepté");
ok((await Bs.wait(m => m[0] === "EVENT" && m[2].id === ev.id))[1] === "salon", "relais : Bob reçoit le message d'Alice");
const forged = { ...ev, content: "modifié" };
A.send(["EVENT", forged]);
ok((await A.wait(m => m[0] === "OK" && m[1] === forged.id && m !== null && m[2] === false, 3000).catch(() => A.inbox.find(m => m[0] === "OK" && m[2] === false)))[2] === false, "relais : message altéré rejeté");
// historique pour un arrivant
const skC = generateSecretKey(), sC = await session(await login("carol"), skC), Cs = await sock(sC.j.token);
Cs.send(["REQ", "h", { kinds: [42], limit: 50 }]);
ok(!!(await Cs.wait(m => m[0] === "EVENT" && m[2].id === ev.id)), "relais : l'arrivant voit les derniers messages");
// signalisation éphémère (Trystero) : relayée, pas gardée
Bs.send(["REQ", "sig", { kinds: [25000] }]);
await Bs.wait(m => m[0] === "EOSE" && m[1] === "sig");
const eph = finalizeEvent({ kind: 25000, created_at: Math.floor(Date.now() / 1000), tags: [["x", "abc"]], content: "offre" }, generateSecretKey());
A.send(["EVENT", eph]);
ok(!!(await Bs.wait(m => m[0] === "EVENT" && m[2].id === eph.id)), "relais : signalisation éphémère transmise");
Cs.send(["REQ", "h2", { kinds: [25000] }]);
await Cs.wait(m => m[0] === "EOSE" && m[1] === "h2");
ok(!Cs.inbox.some(m => m[0] === "EVENT" && m[1] === "h2"), "relais : signalisation non conservée");
// renouvellement du jeton sur une connexion ouverte
const sA2 = await session(a, skA);
A.send(["CDA_AUTH", sA2.j.token]);
ok(!!(await A.wait(m => m[0] === "NOTICE" && m[1] === "CDA_AUTH ok")), "relais : jeton renouvelé sans reconnexion");
A.send(["CDA_AUTH", sB.j.token]);
ok(!!(await A.wait(m => m[0] === "NOTICE" && m[1] === "CDA_AUTH refusé")), "relais : jeton d'un autre joueur refusé");
// TURN : jeton exigé
ok((await fetch(B + "/turn")).status === 401, "TURN : refusé sans jeton");
ok(!anon.inbox.some(m => m[0] === "EVENT" || m[0] === "EOSE"), "relais : une connexion non authentifiée ne reçoit rien");
// une seule session par compte : Alice ouvre un second onglet (autre clé Nostr)
const skA2 = generateSecretKey(), sAbis = await session(a, skA2);
const A2 = await sock(sAbis.j.token);
ok(!!(await A2.wait(m => m[0] === "NOTICE" && m[1] === "CDA_SESSION ailleurs").catch(() => null)), "un compte : le second onglet est refusé (déjà en jeu ailleurs)");
const A3 = await new Promise((res, rej) => { const w = new WebSocket(B.replace("http", "ws") + "/relay"); const inbox = []; w.on("message", d => inbox.push(JSON.parse(d))); w.on("open", () => { w.send(JSON.stringify(["CDA_AUTH", sAbis.j.token, { take: true }])); res({ ws: w, inbox }); }); w.on("error", rej); });
await new Promise(r => setTimeout(r, 800));
ok(A3.inbox.some(m => m[1] === "CDA_AUTH ok"), "un compte : « Jouer ici » reprend la session");
ok(A.inbox.some(m => m[0] === "NOTICE" && m[1] === "CDA_SESSION remplacée"), "un compte : l'ancien onglet est prévenu et déconnecté");
A3.ws.close();
await new Promise(r => setTimeout(r, 10500));
ok(anon.ws.readyState === 3 || anon.ws.readyState === 2, "relais : connexion non authentifiée fermée au bout de 10 s");
const L = await sock(sA2.j.token, true);
L.send(["REQ", "l", { kinds: [42], limit: 1 }]);
ok(!!(await L.wait(m => m[0] === "EOSE")), "relais : l'ancienne forme (?t=jeton valide) marche encore pendant la transition");
for (const s of [A, Bs, Cs, L]) s.ws.close();
console.log("terminé");
