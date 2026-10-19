/* Relais Nostr privé du salon (Durable Object, une seule instance « salon »).
   - N'accepte que les connexions ouvertes avec un jeton d'identité valide (vérifié par le Worker).
   - Protocole NIP-01 : EVENT, REQ, CLOSE → OK, EVENT, EOSE, NOTICE, CLOSED.
   - Extension : ["CDA_AUTH", jeton] prolonge la connexion quand le jeu renouvelle son jeton (toutes les heures).
   - Les événements éphémères (kind 20000–29999 : signalisation Trystero) ne sont jamais gardés ;
     les autres (tchat chiffré, annonces) sont gardés 3 h, 500 au plus, pour que l'arrivant voie la conversation.
   Une seule instance éveillée tient dans l'offre gratuite (24 h × 128 Mo < 13 000 Go·s par jour). */
import { schnorr } from "@noble/curves/secp256k1.js";
import { idOpen, banned } from "./worker.js";

const MAX_SOCKS = 2000, MAX_PER_USER = 6, MAX_SUBS = 20, MAX_FILTERS = 10, MAX_MSG = 65536, MAX_CONTENT = 32768;
const RATE_WIN = 10, RATE_MAX = 60, KEEP_S = 3 * 3600, KEEP_N = 500, GRACE = 600;
// connexion ouverte sans jeton dans l'adresse : le premier message doit être ["CDA_AUTH", jeton] (10 s au plus) ;
// d'ici là, rien n'est relayé et les messages reçus attendent (50 au plus, 128 Ko)
const AUTH_WAIT_MS = 10000, MAX_PENDING = 300, PEND_N = 50, PEND_BYTES = 131072;
const hex = (s, n) => typeof s === "string" && s.length === n && /^[0-9a-f]+$/.test(s);
const nowS = () => Math.floor(Date.now() / 1000);
const enc = new TextEncoder();
const toHex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
const fromHex = h => { const u = new Uint8Array(h.length / 2); for (let i = 0; i < u.length; i++) u[i] = parseInt(h.substr(i * 2, 2), 16); return u; };

async function validEvent(ev) {
  if (!ev || typeof ev !== "object") return "événement illisible";
  if (!hex(ev.id, 64) || !hex(ev.pubkey, 64) || !hex(ev.sig, 128)) return "id, pubkey ou sig invalide";
  if (!Number.isInteger(ev.kind) || ev.kind < 0 || ev.kind > 65535) return "kind invalide";
  if (!Number.isInteger(ev.created_at) || Math.abs(ev.created_at - nowS()) > 86400) return "date invalide";
  if (typeof ev.content !== "string" || ev.content.length > MAX_CONTENT) return "contenu trop long";
  if (!Array.isArray(ev.tags) || ev.tags.length > 50 || !ev.tags.every(t => Array.isArray(t) && t.length <= 10 && t.every(x => typeof x === "string" && x.length <= 1024))) return "tags invalides";
  const ser = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
  const id = toHex(await crypto.subtle.digest("SHA-256", enc.encode(ser)));
  if (id !== ev.id) return "id ne correspond pas";
  try { if (!schnorr.verify(fromHex(ev.sig), fromHex(ev.id), fromHex(ev.pubkey))) return "signature invalide"; }
  catch (e) { return "signature invalide"; }
  return "";
}
function match(f, ev) {
  if (f.ids && !f.ids.includes(ev.id)) return false;
  if (f.authors && !f.authors.includes(ev.pubkey)) return false;
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f.since && ev.created_at < f.since) return false;
  if (f.until && ev.created_at > f.until) return false;
  for (const k in f) {
    if (k.length === 2 && k[0] === "#") {
      const want = f[k];
      if (!Array.isArray(want) || !ev.tags.some(t => t[0] === k[1] && want.includes(t[1]))) return false;
    }
  }
  return true;
}
function cleanFilter(f) {
  if (!f || typeof f !== "object" || Array.isArray(f)) return null;
  const o = {};
  for (const k of ["ids", "authors", "kinds"]) if (Array.isArray(f[k])) o[k] = f[k].slice(0, 200);
  for (const k of ["since", "until", "limit"]) if (Number.isInteger(f[k])) o[k] = f[k];
  for (const k in f) if (k.length === 2 && k[0] === "#" && Array.isArray(f[k])) o[k] = f[k].slice(0, 200).map(String);
  return o;
}

export class Relay {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.socks = new Map(); this.recent = null; this.saveT = 0; this.active = new Map(); }
  // un compte = une seule session (un onglet, un appareil) : on retient la clé Nostr de la session active de chaque compte
  liveFor(sub, pk) { for (const st of this.socks.values()) if (st.sub === sub && st.pk === pk) return true; return false; }

  async loadRecent() {
    if (!this.recent) this.recent = (await this.ctx.storage.get("recent")) || [];
    const lim = nowS() - KEEP_S;
    this.recent = this.recent.filter(e => e.created_at >= lim).slice(-KEEP_N);
    return this.recent;
  }
  saveSoon() {
    if (this.saveT) return;
    this.saveT = setTimeout(() => { this.saveT = 0; this.ctx.storage.put("recent", this.recent).catch(() => {}); }, 2000);
  }

  async fetch(req) {
    const pending = req.headers.get("x-cda-pending") === "1";
    const sub = pending ? null : req.headers.get("x-cda-sub") || "", exp = Math.max(+req.headers.get("x-cda-exp") || 0, nowS() + 3000); // ~50 min, prolongées par CDA_AUTH
    if (!pending && !sub) return new Response("interdit", { status: 403 });
    if (this.socks.size >= MAX_SOCKS) return new Response("relais plein", { status: 503 });
    if (pending) { let n = 0; for (const st of this.socks.values()) if (!st.sub) n++; if (n >= MAX_PENDING) return new Response("relais occupé", { status: 503 }); }
    else if (this.userSocks(sub) >= MAX_PER_USER) return new Response("trop de connexions", { status: 429 });
    const pair = new WebSocketPair(), ws = pair[1];
    ws.accept();
    const st = { sub, exp, subs: new Map(), rt: 0, rn: 0, pend: pending ? [] : null, pendB: 0 };
    if (pending) setTimeout(() => { if (!st.sub) { try { ws.close(4401, "authentification requise"); } catch (e) {} this.socks.delete(ws); } }, AUTH_WAIT_MS);
    this.socks.set(ws, st);
    ws.addEventListener("message", e => this.onMessage(ws, st, e.data).catch(err => this.send(ws, ["NOTICE", "erreur : " + (err && err.message)])));
    const bye = () => { this.socks.delete(ws); if (st.sub && st.pk && this.active.get(st.sub) === st.pk && !this.liveFor(st.sub, st.pk)) this.active.delete(st.sub); };
    ws.addEventListener("close", bye); ws.addEventListener("error", bye);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  userSocks(sub) { let n = 0; for (const st of this.socks.values()) if (st.sub === sub) n++; return n; }

  // première authentification d'une connexion ouverte sans jeton
  async authFirst(ws, st, data) {
    let m = null; try { m = JSON.parse(data); } catch (e) {}
    if (!Array.isArray(m) || m[0] !== "CDA_AUTH") {
      st.pendB += data.length;
      if (st.pend.length >= PEND_N || st.pendB > PEND_BYTES) { try { ws.close(4401, "authentification requise"); } catch (e) {} this.socks.delete(ws); return; }
      st.pend.push(data); return;
    }
    const id = await idOpen(this.env, m[1]);
    if (!id || banned(this.env, id.sub)) { this.send(ws, ["NOTICE", "CDA_AUTH refusé"]); try { ws.close(4403, "jeton refusé"); } catch (e) {} this.socks.delete(ws); return; }
    if (this.userSocks(id.sub) >= MAX_PER_USER + (m[2] && m[2].take ? 99 : 0)) { this.send(ws, ["NOTICE", "trop de connexions"]); try { ws.close(4429, "trop de connexions"); } catch (e) {} this.socks.delete(ws); return; }
    const act = this.active.get(id.sub), take = !!(m[2] && m[2].take);
    if (act && act !== id.pk && this.liveFor(id.sub, act)) {
      if (!take) { this.send(ws, ["NOTICE", "CDA_SESSION ailleurs"]); try { ws.close(4409, "session ouverte ailleurs"); } catch (e) {} this.socks.delete(ws); return; }
      for (const [w, o] of [...this.socks]) if (o.sub === id.sub && o.pk === act) { this.send(w, ["NOTICE", "CDA_SESSION remplacée"]); try { w.close(4409, "session reprise ailleurs"); } catch (e) {} this.socks.delete(w); }
    }
    this.active.set(id.sub, id.pk);
    st.sub = id.sub; st.pk = id.pk; st.exp = Math.max(id.exp, nowS() + 3000);
    this.send(ws, ["NOTICE", "CDA_AUTH ok"]);
    const q = st.pend; st.pend = null; st.pendB = 0;
    for (const d of q) await this.onMessage(ws, st, d);   // les messages arrivés avant l'authentification, dans l'ordre
  }

  send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch (e) { this.socks.delete(ws); } }

  async onMessage(ws, st, data) {
    if (typeof data !== "string" || data.length > MAX_MSG) return this.send(ws, ["NOTICE", "message refusé (taille)"]);
    if (!st.sub) return this.authFirst(ws, st, data);
    const t = nowS();
    if (t > st.exp + GRACE || banned(this.env, st.sub)) { this.send(ws, ["NOTICE", "jeton expiré : reconnecte-toi"]); try { ws.close(4001, "jeton expiré"); } catch (e) {} this.socks.delete(ws); return; }
    let m; try { m = JSON.parse(data); } catch (e) { return this.send(ws, ["NOTICE", "JSON invalide"]); }
    if (!Array.isArray(m)) return;
    const [type] = m;

    if (type === "EVENT") {
      const ev = m[1];
      if (t - st.rt >= RATE_WIN) { st.rt = t; st.rn = 0; }
      if (++st.rn > RATE_MAX) return this.send(ws, ["OK", ev && ev.id || "", false, "rate-limited: trop de messages"]);
      const bad = await validEvent(ev);
      if (bad) return this.send(ws, ["OK", ev && ev.id || "", false, "invalid: " + bad]);
      if (ev.kind < 20000 || ev.kind >= 30000) {
        const rec = await this.loadRecent();
        if (rec.some(e => e.id === ev.id)) return this.send(ws, ["OK", ev.id, true, "duplicate:"]);
        rec.push(ev); if (rec.length > KEEP_N) rec.splice(0, rec.length - KEEP_N);
        this.saveSoon();
      }
      this.send(ws, ["OK", ev.id, true, ""]);
      const out = [];
      for (const [w, s] of this.socks) for (const [sid, fs] of s.subs) if (fs.some(f => match(f, ev))) { out.push([w, sid]); }
      for (const [w, sid] of out) this.send(w, ["EVENT", sid, ev]);
      return;
    }

    if (type === "REQ") {
      const sid = m[1];
      if (typeof sid !== "string" || !sid || sid.length > 64) return this.send(ws, ["NOTICE", "identifiant d'abonnement invalide"]);
      const fs = m.slice(2, 2 + MAX_FILTERS).map(cleanFilter).filter(Boolean);
      if (!st.subs.has(sid) && st.subs.size >= MAX_SUBS) return this.send(ws, ["CLOSED", sid, "error: trop d'abonnements"]);
      st.subs.set(sid, fs);
      const rec = await this.loadRecent();
      for (const f of fs) {
        const lim = Math.min(Number.isInteger(f.limit) ? f.limit : 200, 200);
        if (lim <= 0) continue;
        const hits = rec.filter(e => match(f, e)).slice(-lim);
        for (const e of hits) this.send(ws, ["EVENT", sid, e]);
      }
      return this.send(ws, ["EOSE", sid]);
    }

    if (type === "CLOSE") { st.subs.delete(m[1]); return; }

    if (type === "CDA_AUTH") {
      const id = await idOpen(this.env, m[1]);
      if (!id || id.sub !== st.sub || (st.pk && id.pk !== st.pk)) return this.send(ws, ["NOTICE", "CDA_AUTH refusé"]);
      st.exp = id.exp;
      return this.send(ws, ["NOTICE", "CDA_AUTH ok"]);
    }

    if (type === "AUTH") return; // NIP-42 non utilisé : l'accès se fait par jeton à l'ouverture
    this.send(ws, ["NOTICE", "type inconnu : " + String(type).slice(0, 20)]);
  }
}
