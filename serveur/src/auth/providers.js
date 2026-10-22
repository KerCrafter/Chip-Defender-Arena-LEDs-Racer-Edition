/* Chip Defender Arena · fournisseurs d'identité (adaptateurs)
   ==========================================================
   Chaque fournisseur est un adaptateur derrière le même contrat :
     { kind: "oauth", auth, token, scope, extra?, user(accessToken) -> { id, name, avatar } }
     { kind: "direct" }   pas de tiers : le nom tapé devient l'identité (tests du staging)
   Le reste du serveur ne connaît que ce contrat (route /login/<p>, /callback/<p>).

   Quels fournisseurs sont actifs (enabledProviders) :
     - OAuth : seulement si leurs secrets <P>_ID et <P>_SECRET sont posés ;
     - direct : seulement si AUTH_DIRECT=1 (staging) ou DEV=1 (poste local),
       ET jamais si SITE_ORIGINS contient le site de production (garde-fou : une erreur
       de configuration ne peut pas ouvrir la connexion sans compte en production). */

export const PROD_ORIGIN = "https://chip-defender-arena.kercrafter.live";

export const OAUTH = {
  github: {
    kind: "oauth",
    auth: "https://github.com/login/oauth/authorize", scope: "",
    token: "https://github.com/login/oauth/access_token",
    async user(at, f = fetch) {
      const u = await (await f("https://api.github.com/user", { headers: { authorization: "Bearer " + at, "user-agent": "chip-defender-arena", accept: "application/vnd.github+json" } })).json();
      if (!u || !u.id) throw new Error("profil GitHub illisible");
      return { id: String(u.id), name: u.login, avatar: u.avatar_url || "" };
    }
  },
  discord: {
    kind: "oauth",
    auth: "https://discord.com/oauth2/authorize", scope: "identify",
    token: "https://discord.com/api/oauth2/token",
    async user(at, f = fetch) {
      const u = await (await f("https://discord.com/api/users/@me", { headers: { authorization: "Bearer " + at } })).json();
      if (!u || !u.id) throw new Error("profil Discord illisible");
      return { id: String(u.id), name: u.global_name || u.username, avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : "" };
    }
  },
  google: {
    kind: "oauth",
    auth: "https://accounts.google.com/o/oauth2/v2/auth", scope: "openid profile", extra: { prompt: "select_account" },
    token: "https://oauth2.googleapis.com/token",
    async user(at, f = fetch) {
      const u = await (await f("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: "Bearer " + at } })).json();
      if (!u || !u.sub) throw new Error("profil Google illisible");
      return { id: String(u.sub), name: u.given_name || u.name || "joueur", avatar: u.picture || "" };
    }
  }
};

export const DIRECT = { kind: "direct" };

const up = p => p.toUpperCase();
const origins = env => String(env.SITE_ORIGINS || "").split(/[\s,]+/).filter(Boolean);

/** La connexion directe est-elle permise par cette configuration ? */
export function directAllowed(env) {
  if (!(env.AUTH_DIRECT === "1" || env.DEV === "1")) return false;
  return !origins(env).includes(PROD_ORIGIN);
}

/** Noms des fournisseurs actifs, dans l'ordre d'affichage. */
export function enabledProviders(env) {
  const on = Object.keys(OAUTH).filter(p => env[up(p) + "_ID"] && env[up(p) + "_SECRET"]);
  if (directAllowed(env)) on.push("direct");
  return on;
}

/** Adaptateur d'un fournisseur actif ("dev" reste un alias de "direct" pour les anciens tests), ou null. */
export function providerFor(env, name) {
  const p = name === "dev" ? "direct" : name;
  if (!enabledProviders(env).includes(p)) return null;
  return p === "direct" ? { name: p, ...DIRECT } : { name: p, ...OAUTH[p] };
}

export const cleanName = s => String(s || "joueur").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 24) || "joueur";

/** Identité de la connexion directe : le nom tapé, normalisé (même nom = même joueur). */
export function directIdentity(rawName) {
  const name = cleanName(rawName || "testeur");
  return { sub: "direct:" + name.toLowerCase(), n: name, a: "" };
}
