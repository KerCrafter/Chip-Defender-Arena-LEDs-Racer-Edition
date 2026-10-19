/* Chip Defender Arena · serveur Cloudflare
   ==========================================
   Un seul Worker, gratuit, qui fait quatre choses :
   1. connexion GitHub / Discord / Google (OAuth), avec liste de bannis ;
   2. clé du salon K(h), qui change toutes les heures, et jeton d'identité signé (Ed25519) ;
   3. notre relais Nostr privé (/relay) : il n'accepte que les joueurs munis d'un jeton valide ;
   4. identifiants TURN Cloudflare pour le « mode anonyme » des parties.

   Rien n'est stocké sur les joueurs : tout est dans des jetons signés.
   Secrets (posés par setup.mjs avec « wrangler secret put ») :
     MASTER                 32 octets aléatoires (base64url) : K(h), jetons de session, état OAuth
     SIGN_KEY / PUBLIC_KEY  paire Ed25519 (PKCS8 base64 / brute base64url) : jetons d'identité
     GITHUB_ID / GITHUB_SECRET, DISCORD_ID / DISCORD_SECRET, GOOGLE_ID / GOOGLE_SECRET  (chacun facultatif)
     TURN_KEY_ID / TURN_TOKEN   (facultatif : mode anonyme)
     BANNED                 liste « github:123,discord:456 » (facultatif)
*/
export { Relay } from "./relay.js";

const HOUR = 3600, SESSION_DAYS = 7, ID_TTL = 65 * 60;
const enc = new TextEncoder(), dec = new TextDecoder();

/* ---------- petits outils ---------- */
export const b64u = {
  enc(bytes) { let s = ""; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
  dec(str) { const s = atob(String(str).replace(/-/g, "+").replace(/_/g, "/")); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
};
const now = () => Math.floor(Date.now() / 1000);
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

const keyCache = new Map();
async function hmacKey(env, purpose) {
  const k = "h:" + purpose;
  if (!keyCache.has(k)) {
    if (!env.MASTER) throw new Error("secret MASTER manquant");
    const base = await crypto.subtle.importKey("raw", b64u.dec(env.MASTER), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sub = await crypto.subtle.sign("HMAC", base, enc.encode("cda/" + purpose));
    keyCache.set(k, await crypto.subtle.importKey("raw", sub, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]));
  }
  return keyCache.get(k);
}
async function hmacSign(env, purpose, obj) {
  const p = b64u.enc(enc.encode(JSON.stringify(obj)));
  const s = await crypto.subtle.sign("HMAC", await hmacKey(env, purpose), enc.encode(p));
  return p + "." + b64u.enc(s);
}
async function hmacOpen(env, purpose, tok) {
  if (typeof tok !== "string" || tok.length > 4096) return null;
  const [p, s] = tok.split(".");
  if (!p || !s) return null;
  try {
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(env, purpose), b64u.dec(s), enc.encode(p)))) return null;
    const o = JSON.parse(dec.decode(b64u.dec(p)));
    return o && o.exp > now() ? o : null;
  } catch (e) { return null; }
}
/* clé du salon de l'heure h */
export async function lobbyKey(env, h) {
  const s = await crypto.subtle.sign("HMAC", await hmacKey(env, "salon"), enc.encode(String(h)));
  return b64u.enc(s).slice(0, 32);
}
/* jeton d'identité : signé Ed25519, vérifiable par tout le monde avec PUBLIC_KEY */
async function idSign(env, obj) {
  if (!keyCache.has("ed")) keyCache.set("ed", await crypto.subtle.importKey("pkcs8", b64u.dec(env.SIGN_KEY), { name: "Ed25519" }, false, ["sign"]));
  const p = b64u.enc(enc.encode(JSON.stringify(obj)));
  return p + "." + b64u.enc(await crypto.subtle.sign({ name: "Ed25519" }, keyCache.get("ed"), enc.encode(p)));
}
export async function idOpen(env, tok, grace = 0) {
  if (typeof tok !== "string" || tok.length > 4096) return null;
  const [p, s] = tok.split(".");
  if (!p || !s) return null;
  try {
    if (!keyCache.has("edp")) keyCache.set("edp", await crypto.subtle.importKey("raw", b64u.dec(env.PUBLIC_KEY), { name: "Ed25519" }, false, ["verify"]));
    if (!(await crypto.subtle.verify({ name: "Ed25519" }, keyCache.get("edp"), b64u.dec(s), enc.encode(p)))) return null;
    const o = JSON.parse(dec.decode(b64u.dec(p)));
    return o && o.t === "i" && o.exp + grace > now() ? o : null;
  } catch (e) { return null; }
}
export const banned = (env, sub) => String(env.BANNED || "").split(/[\s,;]+/).filter(Boolean).includes(sub);

/* ---------- fournisseurs OAuth ---------- */
const PROVIDERS = {
  github: {
    auth: "https://github.com/login/oauth/authorize", scope: "",
    token: "https://github.com/login/oauth/access_token",
    async user(at) {
      const u = await (await fetch("https://api.github.com/user", { headers: { authorization: "Bearer " + at, "user-agent": "chip-defender-arena", accept: "application/vnd.github+json" } })).json();
      if (!u || !u.id) throw new Error("profil GitHub illisible");
      return { id: String(u.id), name: u.login, avatar: u.avatar_url || "" };
    }
  },
  discord: {
    auth: "https://discord.com/oauth2/authorize", scope: "identify",
    token: "https://discord.com/api/oauth2/token",
    async user(at) {
      const u = await (await fetch("https://discord.com/api/users/@me", { headers: { authorization: "Bearer " + at } })).json();
      if (!u || !u.id) throw new Error("profil Discord illisible");
      return { id: String(u.id), name: u.global_name || u.username, avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : "" };
    }
  },
  google: {
    auth: "https://accounts.google.com/o/oauth2/v2/auth", scope: "openid profile", extra: { prompt: "select_account" },
    token: "https://oauth2.googleapis.com/token",
    async user(at) {
      const u = await (await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: "Bearer " + at } })).json();
      if (!u || !u.sub) throw new Error("profil Google illisible");
      return { id: String(u.sub), name: u.given_name || u.name || "joueur", avatar: u.picture || "" };
    }
  }
};
const up = p => p.toUpperCase();
const enabled = env => Object.keys(PROVIDERS).filter(p => env[up(p) + "_ID"] && env[up(p) + "_SECRET"]).concat(env.DEV === "1" ? ["dev"] : []);
const cleanName = s => String(s || "joueur").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 24) || "joueur";

function origins(env) { return String(env.SITE_ORIGINS || "").split(/[\s,]+/).filter(Boolean); }
function originOk(env, o) {
  if (!o) return false;
  if (origins(env).includes(o)) return true;
  return env.DEV === "1" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
}
function returnOk(env, r) { try { const u = new URL(r); return originOk(env, u.origin) ? u : null; } catch (e) { return null; } }
function cors(env, req) {
  const o = req.headers.get("origin");
  return originOk(env, o) ? { "access-control-allow-origin": o, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-max-age": "86400", vary: "origin" } : {};
}
function back(r, frag, n) { const u = new URL(r); u.hash = frag + (n ? "&n=" + n : ""); return Response.redirect(u.toString(), 302); }
// nonce tiré par la page du jeu : il revient avec la session, et la page refuse une session qu'elle n'a pas demandée
const nonceOf = v => /^[a-z0-9]{8,40}$/.test(v || "") ? v : "";

async function session(env, user) {
  return hmacSign(env, "session", { t: "s", sub: user.sub, n: user.n, a: user.a, iat: now(), exp: now() + SESSION_DAYS * 86400 });
}

/* ---------- routes ---------- */
async function route(req, env, ctx) {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, "") || "/";
  const C = cors(env, req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: C });

  if (path === "/") return json({ ok: true, service: "chip-defender-arena", providers: enabled(env), pubkey: env.PUBLIC_KEY || "", turn: !!(env.TURN_KEY_ID && env.TURN_TOKEN), relay: "/relay", ready: !!(env.MASTER && env.SIGN_KEY && env.PUBLIC_KEY) }, 200, C);

  /* 1. départ vers GitHub / Discord / Google */
  let m = path.match(/^\/login\/([a-z]+)$/);
  if (m) {
    const p = m[1], r = returnOk(env, url.searchParams.get("r") || ""), n = nonceOf(url.searchParams.get("n"));
    if (!r) return json({ error: "adresse de retour refusée" }, 400);
    if (!enabled(env).includes(p)) return back(r, "cda_err=fournisseur");
    if (p === "dev") { // essai local uniquement (DEV=1)
      const name = cleanName(url.searchParams.get("name") || "testeur");
      const sub = "dev:" + name.toLowerCase();
      if (banned(env, sub)) return back(r, "cda_err=banni");
      return back(r, "cda=" + await session(env, { sub, n: name, a: "" }), n);
    }
    const P = PROVIDERS[p];
    const state = await hmacSign(env, "state", { p, r: r.toString(), n, exp: now() + 600, k: b64u.enc(crypto.getRandomValues(new Uint8Array(9))) });
    const q = new URLSearchParams({ client_id: env[up(p) + "_ID"], redirect_uri: url.origin + "/callback/" + p, response_type: "code", state, ...(P.scope ? { scope: P.scope } : {}), ...(P.extra || {}) });
    return Response.redirect(P.auth + "?" + q, 302);
  }

  /* 2. retour du fournisseur */
  m = path.match(/^\/callback\/([a-z]+)$/);
  if (m) {
    const p = m[1], st = await hmacOpen(env, "state", url.searchParams.get("state"));
    if (!st || st.p !== p || !PROVIDERS[p]) return json({ error: "état de connexion invalide ou expiré, recommence depuis le jeu" }, 400);
    if (!url.searchParams.get("code")) return back(st.r, "cda_err=annule");
    try {
      const P = PROVIDERS[p];
      const tr = await fetch(P.token, {
        method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: env[up(p) + "_ID"], client_secret: env[up(p) + "_SECRET"], code: url.searchParams.get("code"), redirect_uri: url.origin + "/callback/" + p, grant_type: "authorization_code" })
      });
      const tj = await tr.json();
      if (!tj.access_token) throw new Error("pas de jeton d'accès : " + (tj.error_description || tj.error || tr.status));
      const u = await P.user(tj.access_token), sub = p + ":" + u.id;
      if (banned(env, sub)) return back(st.r, "cda_err=banni");
      return back(st.r, "cda=" + await session(env, { sub, n: cleanName(u.name), a: String(u.avatar || "").slice(0, 300) }), nonceOf(st.n));
    } catch (e) {
      console.log("callback", p, e && e.message);
      return back(st.r, "cda_err=fournisseur");
    }
  }

  /* 3. clé de l'heure + jeton d'identité (appelé à la connexion, puis toutes les ~50 min et à h:55) */
  if (path === "/session" && req.method === "POST") {
    const s = await hmacOpen(env, "session", (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));
    if (!s || s.t !== "s") return json({ error: "session expirée" }, 401, C);
    if (banned(env, s.sub)) return json({ error: "banni" }, 403, C);
    let body = {}; try { body = await req.json(); } catch (e) {}
    const pk = String(body.pk || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pk)) return json({ error: "clé Nostr (pk) attendue" }, 400, C);
    const t = now(), h = Math.floor(t / HOUR), min = Math.floor((t % HOUR) / 60);
    const [prov] = s.sub.split(":");
    return json({
      user: { id: s.sub, name: s.n, prov, avatar: s.a || "" },
      h, key: await lobbyKey(env, h), next: min >= 55 ? { h: h + 1, key: await lobbyKey(env, h + 1) } : null,
      token: await idSign(env, { t: "i", sub: s.sub, n: s.n, prov, a: s.a || "", pk, iat: t, exp: t + ID_TTL }),
      refresh: await session(env, { sub: s.sub, n: s.n, a: s.a }), // la semaine repart de zéro à chaque visite
      renewIn: Math.max(60, Math.min(50 * 60, (55 - min) * 60 - (t % 60)))
    }, 200, C);
  }

  /* 4. TURN pour le mode anonyme */
  if (path === "/turn") {
    const id = await idOpen(env, (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));
    if (!id || banned(env, id.sub)) return json({ error: "jeton invalide" }, 401, C);
    if (!(env.TURN_KEY_ID && env.TURN_TOKEN)) return json({ error: "TURN non configuré" }, 404, C);
    let r = null;
    try {
      r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: "POST", headers: { authorization: "Bearer " + env.TURN_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ ttl: 6 * HOUR })
      });
    } catch (e) {}
    if (!r || !r.ok) return json({ error: "TURN indisponible" }, 502, C);
    const j = await r.json();
    // le port 53 traîne dans les navigateurs : on l'écarte
    const ice = (j.iceServers || []).map(s => ({ ...s, urls: [].concat(s.urls).filter(u => !/:53(\?|$)/.test(u)) })).filter(s => s.urls.length);
    return json({ iceServers: ice, ttl: 6 * HOUR }, 200, C);
  }

  /* 5. relais Nostr privé : le jeton n'est plus dans l'adresse, il arrive dans le premier message (CDA_AUTH) */
  if (path === "/relay") {
    if (req.headers.get("upgrade") !== "websocket") return json({ relay: "wss://" + url.host + "/relay", info: "relais Nostr réservé aux joueurs connectés : premier message [\"CDA_AUTH\", jeton]" }, 200, C);
    const h = new Headers(req.headers); for (const k of ["x-cda-sub", "x-cda-exp", "x-cda-pending"]) h.delete(k);
    const fwd = new Request(req, { headers: h });
    const t = url.searchParams.get("t");
    if (t) {   // ancienne forme (pages ouvertes avant la mise à jour) : jeton encore valide, sans délai de grâce
      const id = await idOpen(env, t);
      if (!id) return new Response("jeton absent ou expiré", { status: 401 });
      if (banned(env, id.sub)) return new Response("banni", { status: 403 });
      fwd.headers.set("x-cda-sub", id.sub); fwd.headers.set("x-cda-exp", String(id.exp));
    } else fwd.headers.set("x-cda-pending", "1");
    return env.RELAY.get(env.RELAY.idFromName("salon")).fetch(fwd);
  }

  return json({ error: "introuvable" }, 404, C);
}

export default {
  async fetch(req, env, ctx) {
    try { return await route(req, env, ctx); }
    catch (e) { console.log("erreur", e && e.stack); return json({ error: "erreur serveur" }, 500, cors(env, req)); }
  }
};
