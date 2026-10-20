/* Fil de calcul des blocs (Web Worker) : lit une tuile CDA4 et prépare ses blocs pour le jeu, hors de l'écran.
   Assemblé avec cda-codec.js et world-store.js (self.CDA_CODEC, self.CDA_WORLD) dans un même script.
   Messages :
     { t: "open", key, u8, cfg }            -> {}          (la tuile entière, en octets ; cfg : voir prepBlock)
     { t: "block", key, b, clip }           -> bloc prêt   (clip : rectangle en unités de grille, ou null)
   Chaque réponse porte l'id de la demande ; les tableaux du bloc sont transférés (aucune copie). */
(function () {
const C = self.CDA_CODEC, Wd = self.CDA_WORLD;
const gz = async b => new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
let U8 = null, HD = null, KEY = null, CFG = null;
async function block(b, clip) {
  const e = HD.blocks[b], g = CFG.g, bs = HD.tile * g;
  const tx = b % HD.nx, ty = Math.floor(b / HD.nx), ox = tx * bs, oy = ty * bs - (CFG.oy || 0);
  let layers = [];
  if (e && e[1]) {
    const bl = C.block4(await gz(U8.subarray(HD.dataStart + e[0], HD.dataStart + e[0] + e[1])), HD, b);
    layers = bl.L.map((r, li) => {
      if (clip) { const o = new Int32Array(r.length); let k = 0; for (let j = 0; j < r.length; j += 4) if (r[j + 2] > clip[0] && r[j] < clip[2] && r[j + 3] > clip[1] && r[j + 1] < clip[3]) { o[k++] = r[j]; o[k++] = r[j + 1]; o[k++] = r[j + 2]; o[k++] = r[j + 3]; } r = o.subarray(0, k); }
      return [li, r];
    }).filter(x => x[1].length);
  }
  return Wd.prepBlock(layers, CFG, ox, oy, bs, bs);
}
self.onmessage = async ev => {
  const m = ev.data;
  try {
    if (m.t === "open") {
      U8 = m.u8; KEY = m.key; CFG = m.cfg;
      const hl = C.headLen4(U8); HD = C.header4(await gz(U8.subarray(8, hl)), hl);
      C.lib4(await gz(U8.subarray(hl + HD.libz[0], hl + HD.libz[0] + HD.libz[1])), HD);
      self.postMessage({ id: m.id, ok: true });
    } else if (m.t === "block") {
      if (m.key !== KEY) throw new Error("autre tuile");
      const d = await block(m.b, m.clip);
      self.postMessage({ id: m.id, ok: true, d }, Wd.prepTransfer(d));
    }
  } catch (err) { self.postMessage({ id: m.id, ok: false, err: String(err && err.message || err) }); }
};
})();
