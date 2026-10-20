/* ===== CDA codec : formats de carte CDA2, CDA3 et CDA4 =====
   Module partagé (aucune dépendance) : le jeu l'inclut au build (build.py), les outils Node le chargent avec require().
   La décompression gzip reste à l'appelant (DecompressionStream dans le navigateur, zlib dans Node) : ici, que des octets.

   CDA2 / CDA3 : un seul flux gzip pour toute la tuile (voir plus bas).
   CDA4 : la tuile est découpée en carrés de 80 µm (« blocs ») compressés séparément, lisibles un par un (requêtes HTTP Range) :
     "CDA4" · u32 longueur de l'en-tête · en-tête (JSON gzip) · bibliothèque des cellules (gzip) · blocs (gzip chacun)
     · aperçu vu de dessus (gzip, 1 octet par pixel RVB 3-3-2). Chaque bloc ne contient que ce qui est dans son carré (formes découpées au bord) :
     aucun recouvrement entre blocs, et un bloc se décode seul (plus la bibliothèque, chargée une fois).
   L'en-tête porte la description d'origine de la tuile (m : nom, types de cellules, étiquettes, sites...) et l'index des blocs :
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
const GLASS = new Set(["licon", "mcon", "via", "via2", "via3"]);
const TB = 16000;   // côté d'un bloc en pas de grille (80 µm à 5 nm) : multiple des carrés de rectUnion (8000), d'où des
                    // découpes identiques à celles d'une union de toute la tuile, et aucun recouvrement entre blocs
function Wr() { let a = new Uint8Array(1 << 16), n = 0; const need = k => { if (n + k > a.length) { const b = new Uint8Array(Math.max(a.length * 2, n + k)); b.set(a.subarray(0, n)); a = b; } };
  return { v(x) { need(10); x = Math.floor(x); while (x >= 128) { a[n++] = (x % 128) | 128; x = Math.floor(x / 128); } a[n++] = x; }, out: () => a.slice(0, n) }; }
const zz = v => v >= 0 ? v * 2 : -v * 2 - 1, unzz = v => (v % 2 ? -(v + 1) / 2 : v / 2);
function Rd(raw, p) { return { p, v() { let v = 0, s = 1, b; do { b = raw[this.p++]; v += (b & 127) * s; s *= 128; } while (b & 128); return v; } }; }
// rectangles triés (y0, x0) : écart y, x (zigzag, remis à zéro à chaque ligne), largeur, hauteur — en flux séparés
function putR(w, r) { const n = r.length / 4; let py = 0, px = 0; const S = [[], [], [], []];
  for (let i = 0; i < n; i++) { const x = r[i * 4], y = r[i * 4 + 1]; S[0].push(y - py); S[1].push(zz(i === 0 || y !== py ? x : x - px)); S[2].push(r[i * 4 + 2] - x); S[3].push(r[i * 4 + 3] - y); py = y; px = x; }
  for (const c of S) for (const v of c) w.v(v); }
function getR(rd, n) { const c = [0, 1, 2, 3].map(() => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = rd.v(); return a; }), r = new Int32Array(n * 4); let x = 0, y = 0;
  for (let i = 0; i < n; i++) { const dy = c[0][i]; y += dy; const z = unzz(c[1][i]); x = i === 0 || dy !== 0 ? z : x + z; r[i * 4] = x; r[i * 4 + 1] = y; r[i * 4 + 2] = x + c[2][i]; r[i * 4 + 3] = y + c[3][i]; } return r; }
const sortR = r => { const n = r.length / 4, o = Array.from({ length: n }, (_, i) => i); o.sort((a, b) => r[a * 4 + 1] - r[b * 4 + 1] || r[a * 4] - r[b * 4] || r[a * 4 + 3] - r[b * 4 + 3] || r[a * 4 + 2] - r[b * 4 + 2]); const s = new Int32Array(n * 4); o.forEach((j, i) => s.set(r.subarray(j * 4, j * 4 + 4), i * 4)); return s; };
// orientation GDS des instances (comme CDA3) : réflexion (y -> -y) puis k quarts de tour
function tf(x0, y0, x1, y1, o, out, k) { if (o & 4) { const t = y0; y0 = -y1; y1 = -t; } for (let q = o & 3; q > 0; q--) { const a = x0, b = x1; x0 = -y1; x1 = -y0; y0 = a; y1 = b; } out[k] = x0; out[k + 1] = y0; out[k + 2] = x1; out[k + 3] = y1; }
/* lecture structurée d'une carte CDA3 (routage, bibliothèque, instances) ou CDA2 (routage + cellules sans bibliothèque) */
function parseSrc(raw) {
  const ml = raw[4] | raw[5] << 8 | raw[6] << 16 | raw[7] << 24, meta = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + ml)));
  const rd = Rd(raw, 8 + ml);
  const seq = (n, k) => { const c = []; for (let s = 0; s < k; s++) { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = rd.v(); c.push(a); } return c; };
  const rects = n => { if (!n) return new Int32Array(0); const [dy, dx, w, h] = seq(n, 4), r = new Int32Array(n * 4); let x = 0, y = 0; for (let i = 0; i < n; i++) { y += dy[i]; const z = unzz(dx[i]); x = i === 0 || dy[i] !== 0 ? z : x + z; r[i * 4] = x; r[i * 4 + 1] = y; r[i * 4 + 2] = x + w[i]; r[i * 4 + 3] = y + h[i]; } return r; };
  if (is(raw, "CDA3")) {
    const names = meta.names, route = names.map(() => new Int32Array(0));
    for (const l of meta.layers) route[names.indexOf(l.name)] = rects(l.count);
    const lib = meta.lib.map(c => c.l.map(([li, n]) => [li, rects(n)]));
    const n = meta.inst.count, [idy, idx, ior, ity] = seq(n, 4), inst = new Int32Array(n * 4); let x = 0, y = 0;
    for (let i = 0; i < n; i++) { y += unzz(idy[i]); const z = unzz(idx[i]); x = i === 0 || idy[i] !== 0 ? z : x + z; inst[i * 4] = x; inst[i * 4 + 1] = y; inst[i * 4 + 2] = ior[i]; inst[i * 4 + 3] = ity[i]; }
    const m = Object.assign({}, meta); delete m.layers; delete m.lib; delete m.inst; delete m.names; delete m.fmt;
    return { m, names, route, lib, libMeta: meta.lib.map(c => ({ o: c.o, b: c.b })), inst, cells: null };
  }
  if (!is(raw, "CDA2")) throw new Error("format de carte inconnu");
  const names = meta.layers.map(l => l.name), route = meta.layers.map(l => rects(l.count));
  const nc = meta.cells.count, cells = new Int32Array(nc * 5);
  if (nc) { const [dy, dx, w, h, t] = seq(nc, 5); let x = 0, y = 0; for (let i = 0; i < nc; i++) { y += dy[i]; const z = (dx[i] % 2 ? -(dx[i] + 1) / 2 : dx[i] / 2); x = i === 0 || dy[i] !== 0 ? z : x + z; cells.set([x, y, x + w[i], y + h[i], t[i]], i * 5); } }
  const m = Object.assign({}, meta); delete m.layers; delete m.cells;
  return { m, names, route, lib: [], libMeta: [], inst: new Int32Array(0), cells };
}
// boîte d'une instance (cellule) dans la tuile
function instBox(S, i, out) { const t = S.inst[i * 4 + 3], c = S.libMeta[t], b = c.b; tf(b[0], b[1], b[2], b[3], S.inst[i * 4 + 2], out, 0); out[0] += S.inst[i * 4]; out[1] += S.inst[i * 4 + 1]; out[2] += S.inst[i * 4]; out[3] += S.inst[i * 4 + 1]; }
/* les formes finales d'un bloc : routage + géométrie des instances, découpées au carré du bloc, union exacte des murs,
   tri (y0, y1, x0) et fusion des voisines sur une même ligne (comme CDA3) ; identique à l'encodage et au décodage */
function finish(NL, names, per, sq) {
  return per.map((list, li) => {
    let n = 0; for (const r of list) n += r.length / 4; if (!n) return new Int32Array(0);
    const c = new Int32Array(n * 4); let k = 0;
    for (const r of list) for (let j = 0; j < r.length; j += 4) {
      const x0 = Math.max(sq[0], r[j]), y0 = Math.max(sq[1], r[j + 1]), x1 = Math.min(sq[2], r[j + 2]), y1 = Math.min(sq[3], r[j + 3]);
      if (x1 > x0 && y1 > y0) { c[k++] = x0; c[k++] = y0; c[k++] = x1; c[k++] = y1; }
    }
    let r = c.subarray(0, k); if (!GLASS.has(names[li]) && k) r = rectUnion(r, k / 4);
    const m = r.length / 4, ord = Array.from({ length: m }, (_, i) => i);
    ord.sort((a, b) => r[a * 4 + 1] - r[b * 4 + 1] || r[a * 4 + 3] - r[b * 4 + 3] || r[a * 4] - r[b * 4] || r[a * 4 + 2] - r[b * 4 + 2]);
    const v = new Int32Array(m * 4); let q = -4;
    for (const j of ord) { const x0 = r[j * 4], y0 = r[j * 4 + 1], x1 = r[j * 4 + 2], y1 = r[j * 4 + 3];
      if (q >= 0 && v[q + 1] === y0 && v[q + 3] === y1 && x0 <= v[q + 2]) { if (x1 > v[q + 2]) v[q + 2] = x1; continue; }
      q += 4; v[q] = x0; v[q + 1] = y0; v[q + 2] = x1; v[q + 3] = y1; }
    return v.slice(0, q + 4);
  });
}
/* encode4(octets décompressés d'une carte CDA2/CDA3, { ov }, gzip) -> Uint8Array
   bloc : [routage découpé par couche] [instances qui touchent le bloc : indice, x, y, orientation, type, « à moi »]
          [cellules sans bibliothèque (CDA2) : indice + boîte + type]
   ov(carte décompressée) : aperçu facultatif { w, h, rgb } */
function encode4(raw, opt, gzip) {
  const S = parseSrc(raw), NL = S.names.length, m = S.m, G = m.grid;
  const Wg = Math.ceil(m.w / G) + 1, Hg = Math.ceil(m.h / G) + 1, nx = Math.max(1, Math.ceil(Wg / TB)), ny = Math.max(1, Math.ceil(Hg / TB)), NB = nx * ny;
  const B = Array.from({ length: NB }, () => ({ R: Array.from({ length: NL }, () => []), I: [], C: [] }));
  const span = (x0, y0, x1, y1, f) => { const a = Math.max(0, Math.floor(x0 / TB)), b = Math.min(nx - 1, Math.floor((x1 - 1) / TB)), c = Math.max(0, Math.floor(y0 / TB)), d = Math.min(ny - 1, Math.floor((y1 - 1) / TB)); for (let ty = c; ty <= d; ty++) for (let tx = a; tx <= b; tx++) f(ty * nx + tx); };
  const own = (x0, y0, x1, y1) => Math.min(ny - 1, Math.max(0, Math.floor((y0 + y1) / 2 / TB))) * nx + Math.min(nx - 1, Math.max(0, Math.floor((x0 + x1) / 2 / TB)));
  S.route.forEach((r, li) => { for (let j = 0; j < r.length; j += 4) { if (r[j + 2] <= r[j] || r[j + 3] <= r[j + 1]) continue; span(r[j], r[j + 1], r[j + 2], r[j + 3], t => B[t].R[li].push(r[j], r[j + 1], r[j + 2], r[j + 3])); } });
  // instances : leur géométrie va dans chaque bloc qu'elle touche ; la cellule appartient au bloc de son centre
  const box = new Int32Array(4), libBox = S.lib.map(L => { let a = [Infinity, Infinity, -Infinity, -Infinity]; for (const [, r] of L) for (let j = 0; j < r.length; j += 4) { a[0] = Math.min(a[0], r[j]); a[1] = Math.min(a[1], r[j + 1]); a[2] = Math.max(a[2], r[j + 2]); a[3] = Math.max(a[3], r[j + 3]); } return a; });
  const NI = S.inst.length / 4;
  for (let i = 0; i < NI; i++) {
    instBox(S, i, box); const mine = own(Math.max(0, box[0]), Math.max(0, box[1]), Math.max(0, box[2]), Math.max(0, box[3]));
    const t = S.inst[i * 4 + 3], lb = libBox[t], c = S.libMeta[t], g = new Int32Array(4);
    if (lb[0] < Infinity) { tf(lb[0] + c.o[0], lb[1] + c.o[1], lb[2] + c.o[0], lb[3] + c.o[1], S.inst[i * 4 + 2], g, 0); g[0] += S.inst[i * 4]; g[1] += S.inst[i * 4 + 1]; g[2] += S.inst[i * 4]; g[3] += S.inst[i * 4 + 1]; }
    const seen = new Set([mine]); B[mine].I.push(i, 1);
    if (lb[0] < Infinity) span(g[0], g[1], g[2], g[3], tb => { if (!seen.has(tb)) { seen.add(tb); B[tb].I.push(i, 0); } });
  }
  if (S.cells) for (let i = 0; i < S.cells.length / 5; i++) { const k = i * 5; B[own(S.cells[k], S.cells[k + 1], S.cells[k + 2], S.cells[k + 3])].C.push(i); }
  // l'en-tête porte la bibliothèque (petite) : les blocs n'ont que des références
  const libW = Wr(); S.lib.forEach(L => { libW.v(L.length); for (const [li, r] of L) { libW.v(li); libW.v(r.length / 4); putR(libW, sortR(r)); } });
  const libZ = gzip(libW.out());
  const parts = [libZ], index = []; let off = libZ.length;
  const H0 = { names: S.names, lib: S.libMeta };
  for (let b = 0; b < NB; b++) {
    const bl = B[b], w = Wr();
    for (let li = 0; li < NL; li++) w.v(bl.R[li].length / 4);
    for (let li = 0; li < NL; li++) if (bl.R[li].length) putR(w, sortR(Int32Array.from(bl.R[li])));
    const ni = bl.I.length / 2; w.v(ni);
    { let prev = -1; for (let k = 0; k < ni; k++) { const i = bl.I[k * 2]; w.v(i - prev - 1); prev = i; } }   // indices croissants
    for (let k = 0; k < ni; k++) { const i = bl.I[k * 2]; w.v(zz(S.inst[i * 4])); }
    for (let k = 0; k < ni; k++) { const i = bl.I[k * 2]; w.v(zz(S.inst[i * 4 + 1])); }
    for (let k = 0; k < ni; k++) { const i = bl.I[k * 2]; w.v(S.inst[i * 4 + 2] * 2 + bl.I[k * 2 + 1]); }   // orientation et « cellule à moi »
    for (let k = 0; k < ni; k++) w.v(S.inst[bl.I[k * 2] * 4 + 3]);
    const nc = bl.C.length; w.v(nc);
    if (nc) { let prev = -1; for (const i of bl.C) { w.v(i - prev - 1); prev = i; } for (const i of bl.C) for (let q = 0; q < 5; q++) w.v(zz(S.cells[i * 5 + q])); }
    const rawB = w.out(), empty = !NL || (bl.R.every(r => !r.length) && !ni && !nc);
    const z = empty ? new Uint8Array(0) : gzip(rawB);
    // compte final des formes du bloc (identifiant stable = base du bloc + rang) : on décode exactement comme le jeu
    let nr = 0, own_ = 0;
    if (!empty) { const d = decodeBlock(rawB, { names: S.names, lib: S.libMeta, libR: S.lib.map(L => L.map(([li, r]) => [li, sortR(r)])) }, b, nx); nr = d.L.reduce((s, r) => s + r.length / 4, 0); own_ = d.idx.length; }
    const tx = b % nx, ty = Math.floor(b / nx);
    index.push([off, z.length, nr, own_, tx * TB, ty * TB, (tx + 1) * TB, (ty + 1) * TB]);
    parts.push(z); off += z.length;
  }
  let ovInfo = null;
  if (opt && opt.ov) { const o = opt.ov(unpack(raw)); if (o) { const z = gzip(o.rgb); ovInfo = { w: o.w, h: o.h, fmt: o.fmt || "rgb", off, len: z.length }; parts.push(z); off += z.length; } }
  const ncells = S.cells ? S.cells.length / 5 : NI;
  const H = { fmt: 4, m, names: S.names, lib: S.libMeta, libz: [0, libZ.length], ncells, tile: TB, nx, ny, blocks: index, ov: ovInfo };
  const hz = gzip(new TextEncoder().encode(JSON.stringify(H)));
  const out = new Uint8Array(8 + hz.length + off);
  out.set(MAGIC("CDA4"), 0); new DataView(out.buffer).setUint32(4, hz.length, true); out.set(hz, 8);
  let p = 8 + hz.length; for (const z of parts) { out.set(z, p); p += z.length; }
  return out;
}
/* lecture : en-tête, puis bibliothèque (une fois), puis les blocs voulus */
const isCda4 = bytes => is(bytes, "CDA4");
function headLen4(bytes) { return 8 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true); }
function header4(hdrJsonBytes, hlen) {
  const H = JSON.parse(new TextDecoder().decode(hdrJsonBytes));
  H.dataStart = hlen; H.base = []; let s = 0; for (const b of H.blocks) { H.base.push(s); s += b[2]; } H.nrects = s;
  return H;
}
function lib4(rawLib, H) { const rd = Rd(rawLib, 0); H.libR = H.lib.map(() => { const n = rd.v(), L = []; for (let k = 0; k < n; k++) { const li = rd.v(), c = rd.v(); L.push([li, getR(rd, c)]); } return L; }); return H; }
function decodeBlock(raw, H, b, nx, cellsOnly) {
  const rd = Rd(raw, 0), NL = H.names.length, cnt = []; for (let li = 0; li < NL; li++) cnt.push(rd.v());
  const per = Array.from({ length: NL }, () => []);
  for (let li = 0; li < NL; li++) if (cnt[li]) per[li].push(getR(rd, cnt[li]));
  const ni = rd.v(), ii = new Float64Array(ni), xs = new Float64Array(ni), ys = new Float64Array(ni), os = new Float64Array(ni), ts = new Float64Array(ni);
  { let prev = -1; for (let k = 0; k < ni; k++) { prev += rd.v() + 1; ii[k] = prev; } }
  for (let k = 0; k < ni; k++) xs[k] = unzz(rd.v()); for (let k = 0; k < ni; k++) ys[k] = unzz(rd.v());
  for (let k = 0; k < ni; k++) os[k] = rd.v(); for (let k = 0; k < ni; k++) ts[k] = rd.v();
  const idx = [], cells = [], tmp = new Int32Array(4);
  for (let k = 0; k < ni; k++) {
    const t = ts[k], o = os[k] >> 1, c = H.lib[t], [lx, ly] = c.o, x = xs[k], y = ys[k];
    if (!cellsOnly) for (const [li, r] of H.libR[t]) { const g = new Int32Array(r.length); for (let j = 0; j < r.length; j += 4) { tf(r[j] + lx, r[j + 1] + ly, r[j + 2] + lx, r[j + 3] + ly, o, g, j); g[j] += x; g[j + 1] += y; g[j + 2] += x; g[j + 3] += y; } per[li].push(g); }
    if (os[k] & 1) { const bb = c.b; tf(bb[0], bb[1], bb[2], bb[3], o, tmp, 0); idx.push(ii[k]); cells.push(Math.max(0, tmp[0] + x), Math.max(0, tmp[1] + y), Math.max(0, tmp[2] + x), Math.max(0, tmp[3] + y), t); }
  }
  const nc = rd.v();
  if (nc) { const ci = []; let prev = -1; for (let k = 0; k < nc; k++) { prev += rd.v() + 1; ci.push(prev); } for (let k = 0; k < nc; k++) { idx.push(ci[k]); for (let q = 0; q < 5; q++) cells.push(unzz(rd.v())); } }
  const tx = b % nx, ty = Math.floor(b / nx), sq = [tx * TB, ty * TB, (tx + 1) * TB, (ty + 1) * TB];
  return { L: cellsOnly ? per.map(() => new Int32Array(0)) : finish(NL, H.names, per, sq), idx, cells: Float64Array.from(cells) };
}
// un bloc décompressé -> { L: formes finales de chaque couche (Int32Array [x0,y0,x1,y1]*n), idx: indices des cellules, cells }
function block4(raw, H, b, cellsOnly) { return decodeBlock(raw, H, b, H.nx, !!cellsOnly); }   // cellsOnly : seulement les cellules (rapide)
/* toute la tuile, au format décompressé historique {meta, buf} (couches triées (y0, y1, x0) comme CDA2/CDA3) */
function assemble4(H, blocks) {
  const NL = H.names.length, per = Array.from({ length: NL }, () => []);
  blocks.forEach(b => { if (b) b.L.forEach((r, li) => { if (r.length) per[li].push(r); }); });
  const meta = Object.assign({}, H.m);
  const total = per.reduce((a, l) => a + l.reduce((s, r) => s + r.length / 4, 0), 0), out = new Uint32Array(total * 4 + H.ncells * 5), layers = [];
  let o = 0;
  for (let li = 0; li < NL; li++) {
    const n = per[li].reduce((s, r) => s + r.length / 4, 0); if (!n) continue;
    const all = new Int32Array(n * 4); let k = 0; for (const r of per[li]) { all.set(r, k); k += r.length; }
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
// blocs à charger pour couvrir une zone (unités de grille)
/* une région d'une tuile CDA4 : les blocs choisis en entier (formes coupées au rectangle clip, en grille), les autres
   pour leurs cellules seulement (cellsB : déjà décodées, ou null) ; gunzip : fonction asynchrone de décompression */
async function region4Build(u8, H, sel, clip, cellsB, gunzip) {
  const hl = H.dataStart, want = new Set(sel);
  const blocks = await Promise.all(H.blocks.map(async (b, i) => {
    if (!b[1]) return null;
    if (want.has(i)) {
      const bl = block4(await gunzip(u8.subarray(hl + b[0], hl + b[0] + b[1])), H, i);
      // on ne garde que les formes qui touchent la région (les blocs de 80 µm débordent de la fenêtre)
      if (clip) bl.L = bl.L.map(r => { const o = new Int32Array(r.length); let k = 0; for (let j = 0; j < r.length; j += 4) if (r[j + 2] > clip[0] && r[j] < clip[2] && r[j + 3] > clip[1] && r[j + 1] < clip[3]) { o[k++] = r[j]; o[k++] = r[j + 1]; o[k++] = r[j + 2]; o[k++] = r[j + 3]; } return o.subarray(0, k); });
      return bl;
    }
    return cellsB ? cellsB[i] : block4(await gunzip(u8.subarray(hl + b[0], hl + b[0] + b[1])), H, i, true);
  }));
  return assemble4(H, blocks);
}
function blocksIn4(H, x0, y0, x1, y1) { const out = []; H.blocks.forEach((b, i) => { if (b[1] && b[4] < x1 && b[6] > x0 && b[5] < y1 && b[7] > y0) out.push(i); }); return out; }

const api = { unpack, unpack2, unpack3, rectUnion, encode4, isCda4, headLen4, header4, lib4, block4, assemble4, blocksIn4, region4Build, parseSrc };
if (typeof module !== "undefined" && module.exports) module.exports = api; else root.CDA_CODEC = api;
})(typeof self !== "undefined" ? self : this);
