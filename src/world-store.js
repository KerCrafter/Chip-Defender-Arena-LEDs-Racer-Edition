/* Magasin du monde : les formes de la puce en mémoire, rangées par bloc (carrés de 80 µm du format CDA4).
   Responsabilité unique : savoir quelles formes existent et où. Il ne sait rien de l'affichage, du réseau ni du jeu.

   - Les formes vivent dans des tableaux communs (X0, X1, Y0, Y1, LAY, dmg, dead, stamp) : chaque bloc chargé y occupe
     une plage contiguë [base, base + n). Ajouter ou retirer un bloc ne touche que sa plage : rien n'est reconstruit.
   - Une plage libérée est rendue inerte (formes hors du monde, marquées détruites) puis réutilisée.
   - Chaque bloc a sa grille de recherche (cases de gs µm) : les requêtes « qu'y a-t-il dans ce rectangle ? »
     ne visitent que les blocs concernés.
   - Numéro fixe d'une forme sur toute la tuile : gid = bloc × 2^18 + rang dans le bloc (identique pour tous les
     joueurs qui ont chargé ce bloc avec la même découpe), indépendant de l'ordre de chargement.
   Utilisable dans la page (self.CDA_WORLD) comme dans Node (tests). */
(function (root) {
"use strict";
const GID_SHIFT = 18, GID_MUL = 1 << GID_SHIFT;
const FAR = -1e5;   // coordonnée d'une forme inerte : hors de toute requête

/* grille de recherche d'un bloc : compte puis remplit (CSR) ; x0..y1 en coordonnées de jeu, origine (ox, oy) du bloc */
function buildGrid(n, gs, ox, oy, w, h, x0, y0, x1, y1, keep) {
  const gw = Math.max(1, Math.ceil(w / gs)), gh = Math.max(1, Math.ceil(h / gs)), cnt = new Uint32Array(gw * gh + 1);
  const span = (i, f) => {
    const a = Math.max(0, Math.floor((x0[i] - ox) / gs)), b = Math.min(gw - 1, Math.floor((x1[i] - ox - 1e-6) / gs));
    const c = Math.max(0, Math.floor((y0[i] - oy) / gs)), d = Math.min(gh - 1, Math.floor((y1[i] - oy - 1e-6) / gs));
    for (let y = c; y <= d; y++) for (let x = a; x <= b; x++) f(y * gw + x);
  };
  for (let i = 0; i < n; i++) if (!keep || keep(i)) span(i, c => cnt[c + 1]++);
  for (let c = 0; c < gw * gh; c++) cnt[c + 1] += cnt[c];
  const fill = cnt.slice(0, gw * gh), idx = new Uint32Array(cnt[gw * gh]);
  for (let i = 0; i < n; i++) if (!keep || keep(i)) span(i, c => idx[fill[c]++] = i);
  return { gs, gw, gh, ox, oy, start: cnt, idx };
}

/* prépare un bloc pour le jeu (dans le fil de calcul des blocs, ou sur place pour une petite tuile) :
   layers : [[indice de couche, rectangles x0,y0,x1,y1 en unités de grille]], cfg : { g (µm par unité), oy (µm coupés en
   bas), thin[couche] (section des piliers, 0 = pleine), solid[couche], glass[couche], ch (côté des sous-blocs
   d'affichage, µm) } ; (ox, oy, w, h) : carré du bloc en coordonnées de jeu. Renvoie les formes en coordonnées de jeu,
   la grille de recherche (formes solides), et l'ordre des formes par sous-bloc d'affichage (ord, cs : début de chaque
   sous-bloc, deux par case : pleines puis piliers), plus le poids des parois (pour l'intégrité de la puce). */
function prepBlock(layers, cfg, ox, oy, w, h) {
  let n = 0;
  const G = cfg.g, OY = cfg.oy || 0;
  for (const [, a, cnt] of layers) { const m = cnt === undefined ? a.length / 4 : cnt; for (let i = 0; i < m; i++) if (a[i * 4 + 3] * G - OY > 0.01) n++; }
  const x0 = new Float32Array(n), x1 = new Float32Array(n), y0 = new Float32Array(n), y1 = new Float32Array(n), lay = new Uint8Array(n);
  let k = 0;
  for (const [li, a, cnt] of layers) {
    const m = cnt === undefined ? a.length / 4 : cnt, f = cfg.thin[li] || 0;
    for (let i = 0; i < m; i++) {
      const Y1 = a[i * 4 + 3] * G - OY; if (Y1 <= 0.01) continue;
      x0[k] = a[i * 4] * G; y0[k] = Math.max(0, a[i * 4 + 1] * G - OY); x1[k] = a[i * 4 + 2] * G; y1[k] = Y1;
      if (f) {   // contacts et vias : même position que sur la puce, section affinée
        const cx = (x0[k] + x1[k]) / 2, cy = (y0[k] + y1[k]) / 2, hw = (x1[k] - x0[k]) * f / 2, hh = (y1[k] - y0[k]) * f / 2;
        x0[k] = cx - hw; x1[k] = cx + hw; y0[k] = cy - hh; y1[k] = cy + hh;
      }
      lay[k] = li; k++;
    }
  }
  const grid = buildGrid(n, cfg.gs || 0.5, ox, oy, w, h, x0, y0, x1, y1, i => cfg.solid[lay[i]]);
  // sous-blocs d'affichage : comptage puis rangement
  const ch = cfg.ch, ncx = Math.max(1, Math.ceil(w / ch)), ncy = Math.max(1, Math.ceil(h / ch)), NK = ncx * ncy * 2;
  const key = new Uint32Array(n), cs = new Uint32Array(NK + 1);
  for (let i = 0; i < n; i++) {
    const cx = Math.max(0, Math.min(ncx - 1, Math.floor(((x0[i] + x1[i]) / 2 - ox) / ch))), cy = Math.max(0, Math.min(ncy - 1, Math.floor(((y0[i] + y1[i]) / 2 - oy) / ch)));
    key[i] = (cy * ncx + cx) * 2 + (cfg.glass[lay[i]] ? 1 : 0); cs[key[i] + 1]++;
  }
  for (let c = 0; c < NK; c++) cs[c + 1] += cs[c];
  const pos = cs.slice(0, NK), ord = new Uint32Array(n);
  for (let i = 0; i < n; i++) ord[pos[key[i]]++] = i;
  // parois : nombre et « tirs » nécessaires (même formule que le jeu : hitsOf)
  let solidN = 0, solidW = 0;
  for (let i = 0; i < n; i++) if (cfg.solid[lay[i]]) { solidN++; const area = (x1[i] - x0[i]) * (y1[i] - y0[i]); solidW += Math.max(4, Math.min(45, Math.round(4 * Math.pow(area / 0.03, 0.25)))); }
  return { n, x0, x1, y0, y1, lay, grid, ord, cs, ncx, ncy, ch, ox, oy, solidN, solidW };
}
const prepTransfer = d => [d.x0.buffer, d.x1.buffer, d.y0.buffer, d.y1.buffer, d.lay.buffer, d.grid.start.buffer, d.grid.idx.buffer, d.ord.buffer, d.cs.buffer];

function createStore(opt) {
  const S = {
    cap: 0, hi: 0, blocks: new Map(), byBase: [], free: [], version: 0,
    X0: null, X1: null, Y0: null, Y1: null, LAY: null, dmg: null, dead: null, stamp: null, st: 1,
    // géométrie des blocs (coordonnées de jeu) : bloc (tx, ty) = [tx*bs, (tx+1)*bs) × [ty*bs - oy, (ty+1)*bs - oy)
    bs: opt.bs, nx: opt.nx, ny: opt.ny, oy: opt.oy || 0, gs: opt.gs || 0.5,
    onGrow: opt.onGrow || null,
  };
  function alloc(n) {
    if (!n) return S.hi;
    // la plus petite plage libre qui suffit (moins de trous qu'en prenant la première)
    let best = -1;
    for (let k = 0; k < S.free.length; k++) if (S.free[k][1] >= n && (best < 0 || S.free[k][1] < S.free[best][1])) best = k;
    if (best >= 0) { const f = S.free[best], base = f[0]; if (f[1] === n) S.free.splice(best, 1); else { f[0] += n; f[1] -= n; } return base; }
    S.free.sort((a, b) => a[0] - b[0]);
    // pas de place : au bout du tableau (agrandi si besoin)
    let base = S.hi;
    const last = S.free.length && S.free[S.free.length - 1];
    if (last && last[0] + last[1] === S.hi) { base = last[0]; S.free.pop(); }
    if (base + n > S.cap) grow(Math.max(base + n, Math.ceil(S.cap * 1.5), 1024));
    S.hi = Math.max(S.hi, base + n);
    return base;
  }
  function release(base, n) {
    if (!n) return;
    S.X0.fill(FAR, base, base + n); S.X1.fill(FAR, base, base + n); S.Y0.fill(FAR, base, base + n); S.Y1.fill(FAR, base, base + n);
    S.LAY.fill(0, base, base + n); S.dmg.fill(0, base, base + n); S.dead.fill(1, base, base + n);
    S.free.push([base, n]);
    // fusion des plages voisines, et recul du bout utilisé
    S.free.sort((a, b) => a[0] - b[0]);
    for (let k = S.free.length - 1; k > 0; k--) { const a = S.free[k - 1], b = S.free[k]; if (a[0] + a[1] === b[0]) { a[1] += b[1]; S.free.splice(k, 1); } }
    const last = S.free[S.free.length - 1];
    if (last && last[0] + last[1] === S.hi) { S.hi = last[0]; S.free.pop(); }
  }
  function grow(cap) {
    const re = (A, T, v) => { const B = new T(cap); if (A) B.set(A.subarray(0, Math.min(A.length, cap))); if (v !== undefined) B.fill(v, A ? A.length : 0); return B; };
    S.X0 = re(S.X0, Float32Array, FAR); S.X1 = re(S.X1, Float32Array, FAR); S.Y0 = re(S.Y0, Float32Array, FAR); S.Y1 = re(S.Y1, Float32Array, FAR);
    S.LAY = re(S.LAY, Uint8Array); S.dmg = re(S.dmg, Float32Array); S.dead = re(S.dead, Uint8Array, 1); S.stamp = re(S.stamp, Uint32Array);
    S.cap = cap;
    if (S.onGrow) S.onGrow(S);
  }
  function blockRect(b) { const tx = b % S.nx, ty = Math.floor(b / S.nx); return [tx * S.bs, ty * S.bs - S.oy, (tx + 1) * S.bs, (ty + 1) * S.bs - S.oy]; }
  /* ajoute un bloc : d = { n, x0, x1, y0, y1 (Float32Array), lay (Uint8Array), grid (de buildGrid, indices locaux) } */
  function add(b, d) {
    if (S.blocks.has(b)) remove(b);
    const base = alloc(d.n);
    S.X0.set(d.x0, base); S.X1.set(d.x1, base); S.Y0.set(d.y0, base); S.Y1.set(d.y1, base); S.LAY.set(d.lay, base);
    S.dmg.fill(0, base, base + d.n); S.dead.fill(0, base, base + d.n);
    const B = { b, base, n: d.n, grid: d.grid, rect: d.rect || blockRect(b), prep: { ord: d.ord, cs: d.cs, ncx: d.ncx, ncy: d.ncy, ch: d.ch, ox: d.ox, oy: d.oy, solidN: d.solidN, solidW: d.solidW } };
    S.blocks.set(b, B); if (d.n) { S.byBase.push(B); S.byBase.sort((p, q) => p.base - q.base); } S.version++;
    return B;
  }
  function remove(b) {
    const B = S.blocks.get(b); if (!B) return null;
    S.blocks.delete(b); const k = S.byBase.indexOf(B); if (k >= 0) S.byBase.splice(k, 1);
    release(B.base, B.n); S.version++;
    return B;
  }
  function clear() { for (const b of [...S.blocks.keys()]) remove(b); S.free = []; S.hi = 0; }
  /* blocs qui touchent le rectangle [x0, x1] × [y0, y1] (coordonnées de jeu) */
  function blocksAt(x0, y0, x1, y1, f) {
    if (S.nx === 1 && S.ny === 1) { const B = S.blocks.get(0); if (B) f(B); return; }
    const a = Math.max(0, Math.floor(x0 / S.bs)), b = Math.min(S.nx - 1, Math.floor(x1 / S.bs));
    const c = Math.max(0, Math.floor((y0 + S.oy) / S.bs)), d = Math.min(S.ny - 1, Math.floor((y1 + S.oy) / S.bs));
    for (let ty = c; ty <= d; ty++) for (let tx = a; tx <= b; tx++) { const B = S.blocks.get(ty * S.nx + tx); if (B) f(B); }
  }
  /* chaque forme candidate (une seule fois) dont la case de grille touche le rectangle : f(indice global) ;
     f peut renvoyer true pour arrêter la recherche (renvoie alors true) */
  function each(x0, y0, x1, y1, f) {
    const st = ++S.st, stamp = S.stamp; let stop = false;
    blocksAt(x0, y0, x1, y1, B => {
      if (stop) return;
      const g = B.grid, base = B.base;
      const ax = Math.max(0, Math.floor((x0 - g.ox) / g.gs)), bx = Math.min(g.gw - 1, Math.floor((x1 - g.ox) / g.gs));
      const ay = Math.max(0, Math.floor((y0 - g.oy) / g.gs)), by = Math.min(g.gh - 1, Math.floor((y1 - g.oy) / g.gs));
      for (let y = ay; y <= by && !stop; y++) for (let x = ax; x <= bx && !stop; x++) {
        const c = y * g.gw + x;
        for (let k = g.start[c], e = g.start[c + 1]; k < e; k++) {
          const i = base + g.idx[k]; if (stamp[i] === st) continue; stamp[i] = st;
          if (f(i) === true) { stop = true; break; }
        }
      }
    });
    return stop;
  }
  /* formes de la case de grille qui contient le point (x, y) : f(indice) ; la première valeur renvoyée par f autre que
     undefined/false est le résultat (sinon -1). Requête la plus rapide : un seul bloc, une seule case */
  function at(x, y, f) {
    let B;
    if (S.nx === 1 && S.ny === 1) B = S.blocks.get(0);
    else { const tx = Math.floor(x / S.bs), ty = Math.floor((y + S.oy) / S.bs); if (tx < 0 || ty < 0 || tx >= S.nx || ty >= S.ny) return -1; B = S.blocks.get(ty * S.nx + tx); }
    if (!B) return -1;
    const g = B.grid, cx = Math.floor((x - g.ox) / g.gs), cy = Math.floor((y - g.oy) / g.gs);
    if (cx < 0 || cy < 0 || cx >= g.gw || cy >= g.gh) return -1;
    const c = cy * g.gw + cx, base = B.base;
    for (let k = g.start[c], e = g.start[c + 1]; k < e; k++) { const r = f(base + g.idx[k]); if (r !== undefined && r !== false) return r; }
    return -1;
  }
  // le bloc qui contient le point (x, y), s'il est chargé
  function blockAt(x, y) {
    if (S.nx === 1 && S.ny === 1) return S.blocks.get(0) || null;
    const tx = Math.floor(x / S.bs), ty = Math.floor((y + S.oy) / S.bs);
    return tx < 0 || ty < 0 || tx >= S.nx || ty >= S.ny ? null : S.blocks.get(ty * S.nx + tx) || null;
  }
  let live = 0;
  const count = () => { live = 0; for (const B of S.blocks.values()) live += B.n; return live; };
  // bloc d'une forme (recherche dichotomique sur les plages)
  function blockOf(i) {
    const L = S.byBase; let lo = 0, hi = L.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1, B = L[m]; if (i < B.base) hi = m - 1; else if (i >= B.base + B.n) lo = m + 1; else return B; }
    return null;
  }
  const gid = i => { const B = blockOf(i); return B ? B.b * GID_MUL + (i - B.base) : -1; };
  const pidx = g => { if (!(g >= 0)) return -1; const B = S.blocks.get(Math.floor(g / GID_MUL)), j = g % GID_MUL; return B && j < B.n ? B.base + j : -1; };
  Object.assign(S, { add, remove, clear, each, at, blockAt, blocksAt, blockOf, blockRect, gid, pidx, grow, count });
  grow(Math.max(1024, opt.cap || 0));
  return S;
}

const api = { createStore, buildGrid, prepBlock, prepTransfer, GID_MUL, FAR };
if (typeof module !== "undefined" && module.exports) module.exports = api; else root.CDA_WORLD = api;
})(typeof self !== "undefined" ? self : this);
