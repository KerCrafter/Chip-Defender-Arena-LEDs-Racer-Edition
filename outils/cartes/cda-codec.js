/* ===== CDA codec : formats de carte CDA2, CDA3 et CDA4 =====
   Module partagé (aucune dépendance) : le jeu l'inclut au build (build.py), les outils Node le chargent avec require().
   La décompression gzip reste à l'appelant (DecompressionStream dans le navigateur, zlib dans Node) : ici, que des octets.

   CDA2 / CDA3 : un seul flux gzip pour toute la tuile (voir plus bas).
   CDA4 : la tuile est découpée en carrés (« blocs ») compressés séparément, lisibles un par un (requêtes HTTP Range) :
     "CDA4" · u32 longueur de l'en-tête · en-tête (JSON gzip) · blocs (gzip chacun) · aperçu vu de dessus (RVB gzip)
   L'en-tête porte tout ce qui n'est pas géométrique (nom, types de cellules, étiquettes, sites...) et l'index des blocs :
     tile : côté d'un bloc (unités de grille) · nx, ny · blocks : [début, longueur, formes, cellules, x0, y0, x1, y1]
     (début relatif à la fin de l'en-tête ; x0..y1 : boîte de tout ce que contient le bloc, débords compris).
   Une forme ou une cellule appartient au bloc qui contient son centre. Identifiant stable d'une forme : rang du bloc,
   puis rang dans le bloc (base[bloc] + i), le même sur toutes les pages sans rien décoder d'autre que l'en-tête.
   Contenu d'un bloc : nombre de formes de chaque couche (varint), puis par couche les flux CDA2 (écart y, x zigzag,
   largeur, hauteur) ; puis les cellules : nombre, écarts d'indice d'origine, puis les mêmes flux + type. */
(function (root) {
"use strict";
const MAGIC = s => [...s].map(c => c.charCodeAt(0));
const is = (raw, s) => MAGIC(s).every((c, i) => raw[i] === c);
/* ---- CDA2 : rectangles par couche, triés (y, x) ---- */
function unpack2(raw) {
  if (raw[0] !== 67 || raw[1] !== 68 || raw[2] !== 65 || raw[3] !== 50) throw new Error("format de carte inconnu");
  const ml = raw[4] | raw[5] << 8 | raw[6] << 16 | raw[7] << 24;
  const meta = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + ml)));
  let p = 8 + ml;
  const vint = (n, len) => { const a = new Int32Array(n); let q = p; for (let i = 0; i < n; i++) { let v = 0, s = 0, b; do { b = raw[q++]; v |= (b & 127) << s; s += 7; } while (b & 128); a[i] = v; } p += len; return a; };
  const total = meta.layers.reduce((s, l) => s + l.count, 0), out = new Uint32Array(total * 4 + meta.cells.count * 5);   // 32 bits : les grands projets dépassent 327 µm
  const rects = (n, ln, stride, off, typed) => {
    if (!n) { p += ln.reduce((a, b) => a + b, 0); return; }
    const dy = vint(n, ln[0]), dx = vint(n, ln[1]), w = vint(n, ln[2]), h = vint(n, ln[3]), t = typed ? vint(n, ln[4]) : null;
    let x = 0, y = 0;
    for (let i = 0; i < n; i++) {
      y += dy[i]; const z = (dx[i] >>> 1) ^ -(dx[i] & 1); x = i === 0 || dy[i] !== 0 ? z : x + z;
      const o = off + i * stride; out[o] = x; out[o + 1] = y; out[o + 2] = x + w[i]; out[o + 3] = y + h[i]; if (t) out[o + 4] = t[i];
    }
  };
  let o = 0;
  for (const l of meta.layers) { l.offset = o * 4; rects(l.count, l.len, 4, o, false); o += l.count * 4; }
  meta.cells.offset = o * 4; rects(meta.cells.count, meta.cells.len, 5, o, true);
  return { meta, buf: out.buffer };
}
/* Format CDA3 : chaque type de cellule standard est stocké une fois (bibliothèque), les instances le replacent
   (position + orientation GDS), le routage reste en rectangles. On reconstruit ici exactement la structure CDA2 :
   rectangles par couche triés (y, x), puis les cellules (boîte englobante + type). */
/* union d'un ensemble de rectangles [x0,y0,x1,y1]*n en rectangles disjoints : carrés de 40 µm (8000 pas de 5 nm),
   puis balayage par tranches horizontales ; une bande qui garde les mêmes bords d'une tranche à l'autre reste
   un seul rectangle (même découpe que slab_rects du convertisseur) */
function rectUnion(r, n) {
  const T = 8000;
  // 1. découpe par carrés de 40 µm (tri par carré, sans objets intermédiaires)
  let total = 0; const cnt = new Map();
  for (let i = 0; i < n; i++) {
    const x0 = r[i * 4], y0 = r[i * 4 + 1], x1 = r[i * 4 + 2], y1 = r[i * 4 + 3];
    if (x1 <= x0 || y1 <= y0) continue;
    for (let tx = Math.floor(x0 / T); tx * T < x1; tx++) for (let ty = Math.floor(y0 / T); ty * T < y1; ty++) { const k = tx * 65536 + ty; cnt.set(k, (cnt.get(k) || 0) + 1); total++; }
  }
  const keys = [...cnt.keys()], start = new Map(); let o = 0;
  for (const k of keys) { start.set(k, o); o += cnt.get(k); }
  const P = new Int32Array(total * 4), fill = new Map(start);
  for (let i = 0; i < n; i++) {
    const x0 = r[i * 4], y0 = r[i * 4 + 1], x1 = r[i * 4 + 2], y1 = r[i * 4 + 3];
    if (x1 <= x0 || y1 <= y0) continue;
    for (let tx = Math.floor(x0 / T); tx * T < x1; tx++) for (let ty = Math.floor(y0 / T); ty * T < y1; ty++) {
      const k = tx * 65536 + ty, j = fill.get(k) * 4; fill.set(k, fill.get(k) + 1);
      P[j] = Math.max(x0, tx * T); P[j + 1] = Math.max(y0, ty * T); P[j + 2] = Math.min(x1, tx * T + T); P[j + 3] = Math.min(y1, ty * T + T);
    }
  }
  // 2. dans chaque carré : balayage par tranches ; les intervalles fusionnés d'une tranche sont comparés à ceux de la
  //    précédente (listes triées) : un intervalle identique prolonge son rectangle, sinon il se ferme / s'ouvre
  const out = new Int32Array(total * 8 + 64); let q = 0;
  const push = (a, b, c, d) => { if (q + 4 > out.length) throw new Error("rectUnion"); out[q++] = a; out[q++] = b; out[q++] = c; out[q++] = d; };
  let ord = new Uint32Array(64), ys = new Int32Array(128), act = new Uint32Array(64), ix = new Int32Array(128), mg = new Int32Array(128), pv = new Int32Array(128), py = new Int32Array(64), ny = new Int32Array(64);
  for (const k of keys) {
    const s0 = start.get(k), m = cnt.get(k);
    if (m === 1) { push(P[s0 * 4], P[s0 * 4 + 1], P[s0 * 4 + 2], P[s0 * 4 + 3]); continue; }
    if (ord.length < m) { ord = new Uint32Array(m * 2); ys = new Int32Array(m * 4); act = new Uint32Array(m * 2); ix = new Int32Array(m * 4); mg = new Int32Array(m * 4); pv = new Int32Array(m * 4); py = new Int32Array(m * 2); ny = new Int32Array(m * 2); }
    for (let j = 0; j < m; j++) { ord[j] = s0 + j; ys[j * 2] = P[(s0 + j) * 4 + 1]; ys[j * 2 + 1] = P[(s0 + j) * 4 + 3]; }
    const O = ord.subarray(0, m); O.sort((a, b) => P[a * 4 + 1] - P[b * 4 + 1]);
    const Y = ys.subarray(0, m * 2); Y.sort();
    let nY = 0; for (let j = 0; j < m * 2; j++) if (!j || Y[j] !== Y[j - 1]) Y[nY++] = Y[j];
    let p = 0, na = 0, npv = 0;   // npv : nombre d'intervalles ouverts (pv : x0,x1 ; py : y de début)
    for (let t = 0; t + 1 < nY; t++) {
      const ya = Y[t];
      let w = 0; for (let j = 0; j < na; j++) if (P[act[j] * 4 + 3] > ya) act[w++] = act[j]; na = w;
      // les rectangles actifs restent triés par x0 : chaque nouveau est inséré à sa place (recherche dichotomique)
      while (p < m && P[O[p] * 4 + 1] <= ya) {
        const id = O[p++], x = P[id * 4]; let lo = 0, hi = na;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (P[act[mid] * 4] <= x) lo = mid + 1; else hi = mid; }
        act.copyWithin(lo + 1, lo, na); act[lo] = id; na++;
      }
      let nm = 0; for (let j = 0; j < na; j++) { const a0 = P[act[j] * 4], a1 = P[act[j] * 4 + 2]; if (nm && a0 <= mg[nm * 2 - 1]) { if (a1 > mg[nm * 2 - 1]) mg[nm * 2 - 1] = a1; } else { mg[nm * 2] = a0; mg[nm * 2 + 1] = a1; nm++; } }
      // comparaison avec la tranche précédente
      let i1 = 0, i2 = 0;
      while (i1 < npv || i2 < nm) {
        const pa = i1 < npv ? pv[i1 * 2] : Infinity, pb = i1 < npv ? pv[i1 * 2 + 1] : 0, ca = i2 < nm ? mg[i2 * 2] : Infinity, cb = i2 < nm ? mg[i2 * 2 + 1] : 0;
        if (pa === ca && pb === cb) { ny[i2] = py[i1]; i1++; i2++; }
        else if (pa < ca || (pa === ca && pb < cb)) { push(pa, py[i1], pb, ya); i1++; }
        else { ny[i2] = ya; i2++; }
      }
      for (let j = 0; j < nm * 2; j++) pv[j] = mg[j]; for (let j = 0; j < nm; j++) py[j] = ny[j]; npv = nm;
    }
    const yl = Y[nY - 1]; for (let j = 0; j < npv; j++) push(pv[j * 2], py[j], pv[j * 2 + 1], yl);
  }
  return out.slice(0, q);
}
function unpack3(raw) {
  const ml = raw[4] | raw[5] << 8 | raw[6] << 16 | raw[7] << 24;
  const meta = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + ml)));
  let p = 8 + ml;
  const vint = (n, len) => { const a = new Int32Array(n); let q = p; for (let i = 0; i < n; i++) { let v = 0, s = 0, b; do { b = raw[q++]; v += (b & 127) * 2 ** s; s += 7; } while (b & 128); a[i] = v; } p += len; return a; };
  const unzz = v => (v >>> 1) ^ -(v & 1);
  // rectangles (même codage que CDA2) -> [x0, y0, x1, y1] * n
  const rects = (n, ln) => {
    const r = new Int32Array(n * 4); if (!n) { p += ln.reduce((a, b) => a + b, 0); return r; }
    const dy = vint(n, ln[0]), dx = vint(n, ln[1]), w = vint(n, ln[2]), h = vint(n, ln[3]);
    let x = 0, y = 0;
    for (let i = 0; i < n; i++) { y += dy[i]; const z = unzz(dx[i]); x = i === 0 || dy[i] !== 0 ? z : x + z; r[i * 4] = x; r[i * 4 + 1] = y; r[i * 4 + 2] = x + w[i]; r[i * 4 + 3] = y + h[i]; }
    return r;
  };
  const NL = meta.names.length, route = new Array(NL).fill(null);
  for (const l of meta.layers) route[meta.names.indexOf(l.name)] = rects(l.count, l.len);
  const lib = meta.lib.map(c => { const L = []; for (const [li, n, ln] of c.l) L.push([li, rects(n, ln)]); return L; });
  const I = meta.inst, n = I.count;
  const idy = vint(n, I.len[0]), idx = vint(n, I.len[1]), ior = vint(n, I.len[2]), ity = vint(n, I.len[3]);
  // orientation GDS : réflexion (y -> -y) puis k quarts de tour (x, y) -> (-y, x)
  const tf = (x0, y0, x1, y1, o, out, k) => {
    if (o & 4) { const t = y0; y0 = -y1; y1 = -t; }
    for (let q = o & 3; q > 0; q--) { const a = x0, b = x1; x0 = -y1; x1 = -y0; y0 = a; y1 = b; }
    out[k] = x0; out[k + 1] = y0; out[k + 2] = x1; out[k + 3] = y1;
  };
  const cnt = new Int32Array(NL); route.forEach((r, i) => cnt[i] += r ? r.length / 4 : 0);
  for (let i = 0; i < n; i++) for (const [li, r] of lib[ity[i]]) cnt[li] += r.length / 4;
  const L = Array.from({ length: NL }, (_, i) => ({ r: new Int32Array(cnt[i] * 4), k: 0 }));
  route.forEach((r, i) => { if (r) { L[i].r.set(r); L[i].k = r.length; } });
  const cells = new Int32Array(n * 5), tmp = new Int32Array(4);
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) {
    y += unzz(idy[i]); const z = unzz(idx[i]); x = i === 0 || idy[i] !== 0 ? z : x + z;
    const o = ior[i], t = ity[i], c = meta.lib[t], [lx, ly] = c.o;
    for (const [li, r] of lib[t]) {
      const D = L[li];
      for (let j = 0; j < r.length; j += 4) { tf(r[j] + lx, r[j + 1] + ly, r[j + 2] + lx, r[j + 3] + ly, o, D.r, D.k); D.r[D.k] += x; D.r[D.k + 1] += y; D.r[D.k + 2] += x; D.r[D.k + 3] += y; D.k += 4; }
    }
    const b = c.b; tf(b[0], b[1], b[2], b[3], o, tmp, 0);
    cells[i * 5] = Math.max(0, tmp[0] + x); cells[i * 5 + 1] = Math.max(0, tmp[1] + y); cells[i * 5 + 2] = Math.max(0, tmp[2] + x); cells[i * 5 + 3] = Math.max(0, tmp[3] + y); cells[i * 5 + 4] = t;
  }
  // assemblage au format CDA2 : couches non vides, rectangles triés par y0 ; les rectangles de même hauteur qui se
  // touchent ou se recouvrent sur une même ligne (rails partagés entre cellules voisines, doublons) sont fusionnés
  const layers = [], GLASSL = new Set(["licon", "mcon", "via", "via2", "via3"]);
  for (let i = 0; i < NL; i++) {
    if (!cnt[i]) continue;
    // murs : union exacte des formes (cellules + routage), comme le convertisseur CDA2 ; sinon deux murs superposés
    // scintillent (teintes différentes au même endroit) et un morceau détruit laisserait son « jumeau » en place
    if (!GLASSL.has(meta.names[i])) { const u = rectUnion(L[i].r, cnt[i]); L[i].r = u; cnt[i] = u.length / 4; }
    const r = L[i].r, m = cnt[i], ord = new Uint32Array(m);
    // tri par y0 (comptage, linéaire), puis chaque ligne par (y1, x0) : rapide même sur les très grandes tuiles
    let my = 0; for (let j = 0; j < m; j++) { const y = Math.max(0, r[j * 4 + 1]); if (y > my) my = y; }
    const st = new Uint32Array(my + 2);
    for (let j = 0; j < m; j++) st[Math.max(0, r[j * 4 + 1]) + 1]++;
    for (let y = 1; y < st.length; y++) st[y] += st[y - 1];
    const pos = st.slice();
    for (let j = 0; j < m; j++) ord[pos[Math.max(0, r[j * 4 + 1])]++] = j;
    const cmp = (a, b) => r[a * 4 + 3] - r[b * 4 + 3] || r[a * 4] - r[b * 4];
    for (let y = 0; y <= my; y++) if (st[y + 1] - st[y] > 1) ord.subarray(st[y], st[y + 1]).sort(cmp);
    const v = new Int32Array(m * 4); let k = -4;
    for (let j = 0; j < m; j++) {
      const s = ord[j] * 4, x0 = r[s], y0 = r[s + 1], x1 = r[s + 2], y1 = r[s + 3];
      if (k >= 0 && v[k + 1] === y0 && v[k + 3] === y1 && x0 <= v[k + 2]) { if (x1 > v[k + 2]) v[k + 2] = x1; continue; }
      k += 4; v[k] = x0; v[k + 1] = y0; v[k + 2] = x1; v[k + 3] = y1;
    }
    layers.push({ name: meta.names[i], count: (k + 4) / 4, src: v });
  }
  const total = layers.reduce((a, l) => a + l.count, 0), out = new Uint32Array(total * 4 + n * 5);
  let o = 0;
  for (const l of layers) {
    const v = l.src, m = l.count;
    l.offset = o * 4;   // en octets, comme en CDA2 (o compte les entiers de 32 bits)
    for (let j = 0; j < m * 4; j++) out[o + j] = Math.max(0, v[j]);
    o += m * 4; delete l.src;
  }
  out.set(cells, o);
  meta.layers = layers; meta.cells = { count: n, offset: o * 4 };
  delete meta.lib; delete meta.inst;
  return { meta, buf: out.buffer };
}

/* raw : contenu décompressé d'une carte CDA2 ou CDA3 */
function unpack(raw) {
  if (is(raw, "CDA3")) return unpack3(raw);
  if (is(raw, "CDA2")) return unpack2(raw);
  throw new Error("format de carte inconnu");
}

/* ---------------- CDA4 ---------------- */
function W() { let a = new Uint8Array(1 << 16), n = 0; const need = k => { if (n + k > a.length) { const b = new Uint8Array(Math.max(a.length * 2, n + k)); b.set(a.subarray(0, n)); a = b; } };
  return { v(x) { need(10); x = Math.floor(x); while (x >= 128) { a[n++] = (x % 128) | 128; x = Math.floor(x / 128); } a[n++] = x; }, bytes(b) { need(b.length); a.set(b, n); n += b.length; }, out: () => a.slice(0, n), get n() { return n; } }; }
const zz = v => v >= 0 ? v * 2 : -v * 2 - 1, unzz = v => (v % 2 ? -(v + 1) / 2 : v / 2);
function R(raw, p) { return { p, v() { let v = 0, s = 1, b; do { b = raw[this.p++]; v += (b & 127) * s; s *= 128; } while (b & 128); return v; } }; }
// flux CDA2 pour une liste [x0,y0,x1,y1(,t)] déjà triée par (y0, x0)
function putRects(w, r, n, stride, typed) {
  let py = 0, px = 0;
  const dy = [], dx = [], ww = [], hh = [], tt = [];
  for (let i = 0; i < n; i++) { const o = i * stride, x = r[o], y = r[o + 1]; dy.push(y - py); dx.push(zz(i === 0 || y !== py ? x : x - px)); ww.push(r[o + 2] - x); hh.push(r[o + 3] - y); if (typed) tt.push(r[o + 4]); py = y; px = x; }
  for (const s of typed ? [dy, dx, ww, hh, tt] : [dy, dx, ww, hh]) for (const v of s) w.v(v);
}
function getRects(rd, n, stride, typed, out, off) {
  const S = (typed ? 5 : 4), cols = []; for (let k = 0; k < S; k++) { const c = new Float64Array(n); for (let i = 0; i < n; i++) c[i] = rd.v(); cols.push(c); }
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) { const dy = cols[0][i]; y += dy; const z = unzz(cols[1][i]); x = i === 0 || dy !== 0 ? z : x + z; const o = off + i * stride; out[o] = x; out[o + 1] = y; out[o + 2] = x + cols[2][i]; out[o + 3] = y + cols[3][i]; if (typed) out[o + 4] = cols[4][i]; }
}
const sortYX = (r, n, stride) => { const ord = Array.from({ length: n }, (_, i) => i); ord.sort((a, b) => r[a * stride + 1] - r[b * stride + 1] || r[a * stride] - r[b * stride] || r[a * stride + 3] - r[b * stride + 3] || r[a * stride + 2] - r[b * stride + 2]); return ord; };
/* encode4(carte décompressée {meta, buf}, { tileUm, ovMax, ov }, gzip) -> Uint8Array
   ov(meta, buf) : aperçu facultatif { w, h, rgb } (calculé par l'appelant) */
function encode4(map, opt, gzip) {
  const meta = map.meta, U = new Uint32Array(map.buf), G = meta.grid, TG = Math.max(1, Math.round((opt.tileUm || 64) / G));
  const Wg = Math.ceil(meta.w / G) + 1, Hg = Math.ceil(meta.h / G) + 1, nx = Math.max(1, Math.ceil(Wg / TG)), ny = Math.max(1, Math.ceil(Hg / TG)), NB = nx * ny;
  const tileOf = (x0, y0, x1, y1) => { const tx = Math.min(nx - 1, Math.max(0, Math.floor((x0 + x1) / 2 / TG))), ty = Math.min(ny - 1, Math.max(0, Math.floor((y0 + y1) / 2 / TG))); return ty * nx + tx; };
  const names = meta.layers.map(l => l.name), NL = names.length;
  const B = Array.from({ length: NB }, () => ({ L: Array.from({ length: NL }, () => []), C: [], box: [Infinity, Infinity, -Infinity, -Infinity] }));
  const grow = (b, x0, y0, x1, y1) => { if (x0 < b.box[0]) b.box[0] = x0; if (y0 < b.box[1]) b.box[1] = y0; if (x1 > b.box[2]) b.box[2] = x1; if (y1 > b.box[3]) b.box[3] = y1; };
  meta.layers.forEach((l, li) => { const o = l.offset / 4; for (let i = 0; i < l.count; i++) { const k = o + i * 4, x0 = U[k], y0 = U[k + 1], x1 = U[k + 2], y1 = U[k + 3], b = B[tileOf(x0, y0, x1, y1)]; b.L[li].push(x0, y0, x1, y1); grow(b, x0, y0, x1, y1); } });
  { const o = meta.cells.offset / 4; for (let i = 0; i < meta.cells.count; i++) { const k = o + i * 5, x0 = U[k], y0 = U[k + 1], x1 = U[k + 2], y1 = U[k + 3], b = B[tileOf(x0, y0, x1, y1)]; b.C.push(i, x0, y0, x1, y1, U[k + 4]); grow(b, x0, y0, x1, y1); } }
  const parts = [], index = []; let off = 0;
  for (const b of B) {
    const w = W(); let nr = 0;
    for (let li = 0; li < NL; li++) w.v(b.L[li].length / 4);
    for (let li = 0; li < NL; li++) {
      const r = b.L[li], n = r.length / 4; if (!n) continue; nr += n;
      const ord = sortYX(r, n, 4), s = new Float64Array(n * 4); ord.forEach((j, i) => { s[i * 4] = r[j * 4]; s[i * 4 + 1] = r[j * 4 + 1]; s[i * 4 + 2] = r[j * 4 + 2]; s[i * 4 + 3] = r[j * 4 + 3]; });
      putRects(w, s, n, 4, false);
    }
    const nc = b.C.length / 6; w.v(nc);
    if (nc) {
      let prev = -1; for (let i = 0; i < nc; i++) { w.v(b.C[i * 6] - prev - 1); prev = b.C[i * 6]; }   // indices d'origine, croissants
      const c = new Float64Array(nc * 5); for (let i = 0; i < nc; i++) for (let k = 0; k < 5; k++) c[i * 5 + k] = b.C[i * 6 + 1 + k];
      // les flux supposent un tri (y0, x0) : on encode dans cet ordre et on garde la permutation vers l'ordre d'origine
      const ord = sortYX(c, nc, 5), s = new Float64Array(nc * 5); ord.forEach((j, i) => { for (let k = 0; k < 5; k++) s[i * 5 + k] = c[j * 5 + k]; });
      for (const j of ord) w.v(j);
      putRects(w, s, nc, 5, true);
    }
    const z = nr || nc ? gzip(w.out()) : new Uint8Array(0);
    parts.push(z);
    index.push(nr || nc ? [off, z.length, nr, nc, b.box[0], b.box[1], b.box[2], b.box[3]] : [off, 0, 0, 0, 0, 0, 0, 0]);
    off += z.length;
  }
  let ovInfo = null;
  if (opt.ov) { const o = opt.ov(map); if (o) { const z = gzip(o.rgb); ovInfo = { w: o.w, h: o.h, off, len: z.length }; parts.push(z); off += z.length; } }
  const H = Object.assign({}, meta); delete H.layers; delete H.cells;
  Object.assign(H, { fmt: 4, names, counts: meta.layers.map(l => l.count), ncells: meta.cells.count, tile: TG, nx, ny, blocks: index, ov: ovInfo });
  const hz = gzip(new TextEncoder().encode(JSON.stringify(H)));
  const out = new Uint8Array(8 + hz.length + off);
  out.set(MAGIC("CDA4"), 0); new DataView(out.buffer).setUint32(4, hz.length, true); out.set(hz, 8);
  let p = 8 + hz.length; for (const z of parts) { out.set(z, p); p += z.length; }
  return out;
}
/* lecture : l'en-tête d'abord (bytes : au moins les 8 + longueur premiers octets) */
const isCda4 = bytes => is(bytes, "CDA4");
function headLen4(bytes) { return 8 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true); }
function header4(hdrJsonBytes, hlen) {   // hdrJsonBytes : JSON décompressé ; hlen : headLen4(...)
  const H = JSON.parse(new TextDecoder().decode(hdrJsonBytes));
  H.dataStart = hlen; H.base = []; let s = 0; for (const b of H.blocks) { H.base.push(s); s += b[2]; } H.nrects = s;
  return H;
}
// un bloc décompressé -> { L: [Float64Array formes de chaque couche, [x0,y0,x1,y1]*n], cells: [{ i, r: [x0,y0,x1,y1,t] }] }
function block4(raw, H) {
  const rd = R(raw, 0), NL = H.names.length, cnt = []; for (let li = 0; li < NL; li++) cnt.push(rd.v());
  const L = cnt.map(n => { const r = new Float64Array(n * 4); if (n) getRects(rd, n, 4, false, r, 0); return r; });
  const nc = rd.v(), idx = [], cells = new Float64Array(nc * 5);
  if (nc) { let prev = -1; for (let i = 0; i < nc; i++) { prev += rd.v() + 1; idx.push(prev); } const ord = []; for (let i = 0; i < nc; i++) ord.push(rd.v()); const s = new Float64Array(nc * 5); getRects(rd, nc, 5, true, s, 0); ord.forEach((j, i) => { for (let k = 0; k < 5; k++) cells[j * 5 + k] = s[i * 5 + k]; }); }
  return { L, cells, idx };
}
/* toute la tuile, au format décompressé historique {meta, buf} (couches triées par y0 comme CDA2/CDA3) */
function assemble4(H, blocks) {
  const NL = H.names.length, per = Array.from({ length: NL }, () => []);
  blocks.forEach(b => { if (b) b.L.forEach((r, li) => { if (r.length) per[li].push(r); }); });
  const meta = Object.assign({}, H); for (const k of ["fmt", "names", "counts", "ncells", "tile", "nx", "ny", "blocks", "ov", "dataStart", "base", "nrects"]) delete meta[k];
  const layers = [], total = per.reduce((a, l) => a + l.reduce((s, r) => s + r.length / 4, 0), 0), out = new Uint32Array(total * 4 + H.ncells * 5);
  let o = 0;
  for (let li = 0; li < NL; li++) {
    const n = per[li].reduce((s, r) => s + r.length / 4, 0); if (!n) continue;
    const all = new Float64Array(n * 4); let k = 0; for (const r of per[li]) { all.set(r, k); k += r.length; }
    // même ordre que le décodeur CDA3 : y0 (tri par comptage, linéaire), puis dans chaque ligne y1, x0, x1
    let my = 0; for (let j = 0; j < n; j++) { const y = all[j * 4 + 1]; if (y > my) my = y; }
    const st = new Uint32Array(my + 2); for (let j = 0; j < n; j++) st[all[j * 4 + 1] + 1]++;
    for (let y = 1; y < st.length; y++) st[y] += st[y - 1];
    const pos = st.slice(), ord = new Uint32Array(n); for (let j = 0; j < n; j++) ord[pos[all[j * 4 + 1]]++] = j;
    const cmp = (a, b) => all[a * 4 + 3] - all[b * 4 + 3] || all[a * 4] - all[b * 4] || all[a * 4 + 2] - all[b * 4 + 2];
    for (let y = 0; y <= my; y++) if (st[y + 1] - st[y] > 1) ord.subarray(st[y], st[y + 1]).sort(cmp);
    layers.push({ name: H.names[li], count: n, offset: o * 4 });
    for (const j of ord) { out[o++] = all[j * 4]; out[o++] = all[j * 4 + 1]; out[o++] = all[j * 4 + 2]; out[o++] = all[j * 4 + 3]; }
  }
  const co = o; blocks.forEach(b => { if (b) b.idx.forEach((gi, i) => { for (let k = 0; k < 5; k++) out[co + gi * 5 + k] = b.cells[i * 5 + k]; }); });
  meta.layers = layers; meta.cells = { count: H.ncells, offset: co * 4 };
  return { meta, buf: out.buffer };
}
// blocs à charger pour couvrir une zone (unités de grille) : ceux dont le contenu touche la zone
function blocksIn4(H, x0, y0, x1, y1) { const out = []; H.blocks.forEach((b, i) => { if (b[1] && b[4] < x1 && b[6] > x0 && b[5] < y1 && b[7] > y0) out.push(i); }); return out; }

const api = { unpack, unpack2, unpack3, rectUnion, encode4, isCda4, headLen4, header4, block4, assemble4, blocksIn4 };
if (typeof module !== "undefined" && module.exports) module.exports = api; else root.CDA_CODEC = api;
})(typeof self !== "undefined" ? self : this);
