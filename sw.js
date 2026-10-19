/* Chip Defender Arena · service worker (application installable, jeu solo hors ligne)
   - la page du jeu : réseau d'abord (toujours la dernière version en ligne), copie gardée pour le hors-ligne ;
   - version.json et auth.json : toujours le réseau (mise à jour en douceur, configuration du serveur) ;
   - cartes, icônes : copie locale tout de suite, rafraîchie en fond ;
   - bibliothèques (lib/, noms versionnés ; et l'ancien CDN) : copie locale d'abord.
   Le multijoueur (serveur de connexion, relais, WebRTC) n'est jamais intercepté. */
const CACHE = "cda-v1";
const CORE = ["./", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).catch(() => {}).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
const pageKey = u => new Request(u.origin + u.pathname.replace(/index\.html$/, ""));
async function netFirst(req, u) {
  const c = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && res.type === "basic") c.put(pageKey(u), res.clone());
    return res;
  } catch (e) {
    return (await c.match(pageKey(u))) || (await c.match("./")) || Response.error();
  }
}
async function staleRevalidate(req, ev) {
  const c = await caches.open(CACHE), hit = await c.match(req);
  const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
  if (hit) { ev.waitUntil(net); return hit; }
  return (await net) || Response.error();
}
async function cacheFirst(req) {
  const c = await caches.open(CACHE), hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") c.put(req, res.clone());
  return res;
}
self.addEventListener("fetch", e => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  if (u.origin === self.location.origin) {
    if (/\/(version|auth|dons)\.json$/.test(u.pathname) || u.pathname.endsWith("/sw.js")) return;
    if (/\/lib\//.test(u.pathname)) return e.respondWith(cacheFirst(r));   // bibliothèques : noms versionnés, donc immuables
    if (r.mode === "navigate" || u.pathname.endsWith("/") || u.pathname.endsWith(".html")) return e.respondWith(netFirst(r, u));
    if (/\/(maps|icons)\//.test(u.pathname) || u.pathname.endsWith(".webmanifest")) return e.respondWith(staleRevalidate(r, e));
    return;
  }
  if (u.hostname === "cdn.jsdelivr.net") e.respondWith(cacheFirst(r));
});
