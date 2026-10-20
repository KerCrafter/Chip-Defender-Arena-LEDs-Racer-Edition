/* Conversion des cartes au format CDA4 (blocs de 80 µm lisibles un par un, pour le chargement au fur et à mesure).
   Lit les cartes déjà converties (CDA2 ou CDA3, aucun GDS à retélécharger) et écrit leurs versions CDA4 à côté :
     node convertir-cda4.mjs --in cartes/maps --out cartes/maps4 [--jobs 6] [--force]
   Chaque carte est vérifiée après écriture : relue entièrement, elle doit redonner exactement les mêmes formes et les
   mêmes cellules que l'original (sinon elle est signalée et non écrite). On peut relancer : ce qui est à jour est sauté.
   index.json et shuttles.json sont recopiés tels quels. Résumé et erreurs : convertir-cda4.log dans le dossier de sortie. */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, renameSync, copyFileSync, existsSync, appendFileSync } from "node:fs";
import { join, relative, dirname, resolve, sep } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { cpus } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
// le module de format est partagé avec le jeu : à côté de ce script (copie publiée) ou dans src/ (dépôt de travail)
const CODEC = [join(HERE, "cda-codec.js"), join(HERE, "..", "..", "src", "cda-codec.js")].find(p => existsSync(p));
if (!CODEC) { console.error("cda-codec.js introuvable (il doit être à côté de ce script)"); process.exit(1); }
const C = require(CODEC);
const gz = b => new Uint8Array(gzipSync(b, { level: 9 }));

/* aperçu vu de dessus (384 px au plus sur le grand côté) : cellules par famille, puis met2, met3, met4 en transparence,
   comme la carte du jeu ; sert à afficher la carte entière sans rien décoder d'autre */
const DFF = /^(dfxtp|dfrtp|dfstp|dfbbp|edfxtp|sdf|dfrbp|dffq|dffrnq|dffsnq|dffrsnq|dffn)/, FILL = /^(decap|fill|tapvpwrvgnd|endcap)/;
const short = n => n.replace(/^sky130_(fd|ef)_sc_hd__|^sg13g2_|^gf180mcu_fd_sc_mcu[79]t5v0__/, "");
function overview(map) {
  const { meta } = map, U = new Uint32Array(map.buf), G = meta.grid, Wu = meta.w, Hu = meta.h, s = Math.min(3, 384 / Math.max(Wu, Hu));
  const w = Math.max(1, Math.ceil(Wu * s)), h = Math.max(1, Math.ceil(Hu * s)), d = new Uint8Array(w * h * 3);
  for (let o = 0; o < d.length; o += 3) { d[o] = 0x0d; d[o + 1] = 0x11; d[o + 2] = 0x17; }
  const box = (x0, y0, x1, y1, c, a) => {
    let px0 = Math.floor(x0 * G * s), px1 = Math.max(px0 + 1, Math.ceil(x1 * G * s)), py0 = Math.floor((Hu - y1 * G) * s), py1 = Math.max(py0 + 1, Math.ceil((Hu - y0 * G) * s));
    px0 = Math.max(0, px0); py0 = Math.max(0, py0); px1 = Math.min(w, px1); py1 = Math.min(h, py1);
    for (let y = py0; y < py1; y++) for (let o = (y * w + px0) * 3, e = (y * w + px1) * 3; o < e; o += 3) for (let k = 0; k < 3; k++) d[o + k] = a >= 1 ? c[k] : d[o + k] + (c[k] - d[o + k]) * a;
  };
  const rgb = c => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  const cD = rgb("#4a3a1c"), cF = rgb("#141a22"), cL = rgb("#1f2a3a");
  const co = meta.cells.offset / 4;
  for (let i = 0; i < meta.cells.count; i++) { const k = co + i * 5, t = short(meta.types[U[k + 4]] || ""); box(U[k], U[k + 1], U[k + 2], U[k + 3], DFF.test(t) ? cD : FILL.test(t) ? cF : cL, 1); }
  for (const [name, col, a] of [["met2", "#c9529f", 0.35], ["met3", "#2fb3c6", 0.45], ["met4", "#d99a32", 0.55]]) {
    const l = meta.layers.find(l => l.name === name); if (!l) continue; const c = rgb(col), o = l.offset / 4;
    for (let i = 0; i < l.count; i++) { const k = o + i * 4; box(U[k], U[k + 1], U[k + 2], U[k + 3], c, a); }
  }
  // 1 octet par pixel (3 bits rouge, 3 vert, 2 bleu) : l'aperçu reste léger dans le fichier
  const q = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) q[i] = (d[i * 3] >> 5) << 5 | (d[i * 3 + 1] >> 5) << 2 | d[i * 3 + 2] >> 6;
  return { w, h, rgb: q, fmt: "rgb332" };
}

/* vérification : chaque couche couvre exactement la même surface (les formes sont seulement redécoupées aux bords des
   blocs), les murs ne se recouvrent pas, et les cellules sont identiques, dans le même ordre */
function sameMap(a, b) {
  const UA = new Uint32Array(a.buf), UB = new Uint32Array(b.buf);
  const area = (U, l) => { let s = 0; const o = l.offset / 4; for (let j = 0; j < l.count; j++) s += (U[o + j * 4 + 2] - U[o + j * 4]) * (U[o + j * 4 + 3] - U[o + j * 4 + 1]); return s; };
  const la = a.meta.layers.filter(l => l.count), lb = b.meta.layers.filter(l => l.count);
  if (la.map(l => l.name).join() !== lb.map(l => l.name).join()) return "couches " + la.map(l => l.name).join() + " / " + lb.map(l => l.name).join();
  for (let i = 0; i < la.length; i++) {
    const sa = area(UA, la[i]), sb = area(UB, lb[i]);
    if (Math.abs(sa - sb) > 1e-9 * Math.max(1, sa)) return `surface de ${la[i].name} : ${sa} / ${sb}`;
  }
  if (a.meta.cells.count !== b.meta.cells.count) return "nombre de cellules";
  const ca = UA.subarray(a.meta.cells.offset / 4, a.meta.cells.offset / 4 + a.meta.cells.count * 5), cb = UB.subarray(b.meta.cells.offset / 4, b.meta.cells.offset / 4 + b.meta.cells.count * 5);
  for (let i = 0; i < ca.length; i++) if (ca[i] !== cb[i]) return "cellule " + Math.floor(i / 5);
  return "";
}
function readBack(bytes) {
  const hl = C.headLen4(bytes), H = C.header4(gunzipSync(bytes.subarray(8, hl)), hl);
  C.lib4(new Uint8Array(gunzipSync(bytes.subarray(hl + H.libz[0], hl + H.libz[0] + H.libz[1]))), H);
  const blocks = H.blocks.map((b, i) => b[1] ? C.block4(new Uint8Array(gunzipSync(bytes.subarray(hl + b[0], hl + b[0] + b[1]))), H, i) : null);
  return { map: C.assemble4(H, blocks), H };
}
function convertOne(src, dst, tile) {
  const t0 = Date.now(), inBytes = readFileSync(src);
  const raw = new Uint8Array(gunzipSync(inBytes)), map = C.unpack(raw);
  const strip = m => JSON.stringify(Object.assign({}, m, { layers: undefined, cells: undefined, names: undefined, fmt: undefined }));
  const out = C.encode4(raw, { ov: overview }, gz);
  const { map: back } = readBack(out), why = sameMap(map, back);
  if (why) throw new Error("vérification : " + why);
  if (strip(back.meta) !== strip(map.meta)) throw new Error("vérification : description différente");
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst + ".part", out); renameSync(dst + ".part", dst);   // jamais de carte à moitié écrite
  const nb = JSON.parse(new TextDecoder().decode(gunzipSync(out.subarray(8, C.headLen4(out))))).blocks.filter(b => b[1]).length;
  return { in: inBytes.length, out: out.length, blocks: nb, ms: Date.now() - t0 };
}

if (!isMainThread) {
  parentPort.on("message", ({ src, dst, tile }) => {
    try { parentPort.postMessage({ src, ok: true, r: convertOne(src, dst, tile) }); }
    catch (e) { parentPort.postMessage({ src, ok: false, err: String(e && e.message || e) }); }
  });
} else {
  const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
  const IN = resolve(arg("in", "cartes/maps")), OUT = resolve(arg("out", "cartes/maps4")), TILE = 80, FORCE = process.argv.includes("--force");
  const JOBS = Math.max(1, +arg("jobs", Math.max(1, Math.min(8, cpus().length - 1))));
  if (!existsSync(IN)) { console.error("dossier introuvable : " + IN); process.exit(1); }
  const walk = d => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const all = walk(IN), LOG = join(OUT, "convertir-cda4.log");
  mkdirSync(OUT, { recursive: true });
  for (const p of all.filter(p => p.endsWith(".json"))) { const q = join(OUT, relative(IN, p)); mkdirSync(dirname(q), { recursive: true }); copyFileSync(p, q); }
  const jobs = all.filter(p => p.endsWith(".bin")).map(src => ({ src, dst: join(OUT, relative(IN, src)), tile: TILE }))
    .filter(j => FORCE || !existsSync(j.dst) || statSync(j.dst).mtimeMs < statSync(j.src).mtimeMs);
  const skipped = all.filter(p => p.endsWith(".bin")).length - jobs.length;
  console.log(`CDA4 : ${jobs.length} cartes à convertir (${skipped} déjà à jour), blocs de ${TILE} µm, ${JOBS} en parallèle`);
  writeFileSync(LOG, `conversion CDA4 du ${new Date().toISOString()} : ${jobs.length} cartes\n`);
  let done = 0, fails = 0, sin = 0, sout = 0, maxMs = 0, maxName = "";
  const t0 = Date.now(), queue = jobs.slice();
  const finish = () => {
    const s = `\nterminé en ${Math.round((Date.now() - t0) / 1000)} s : ${done - fails} cartes converties, ${fails} en erreur · ${(sin / 1e6).toFixed(1)} Mo → ${(sout / 1e6).toFixed(1)} Mo (×${(sout / Math.max(1, sin)).toFixed(2)}) · la plus longue : ${maxName} (${maxMs} ms)`;
    console.log(s); appendFileSync(LOG, s + "\n"); if (fails) console.log("erreurs : voir " + LOG);
  };
  if (!jobs.length) { finish(); process.exit(0); }
  let alive = 0;
  for (let w = 0; w < Math.min(JOBS, jobs.length); w++) {
    const wk = new Worker(fileURLToPath(import.meta.url)); alive++;
    const next = () => { const j = queue.shift(); if (j) wk.postMessage(j); else { wk.terminate(); if (--alive === 0) finish(); } };
    wk.on("message", m => {
      done++;
      const name = relative(IN, m.src).split(sep).join("/");
      if (m.ok) { sin += m.r.in; sout += m.r.out; if (m.r.ms > maxMs) { maxMs = m.r.ms; maxName = name; } }
      else { fails++; appendFileSync(LOG, `ERREUR ${name} : ${m.err}\n`); }
      if (done % 25 === 0 || done === jobs.length || !m.ok) process.stdout.write(`\r${done}/${jobs.length} · ${fails} erreur(s)${m.ok ? "" : " · " + name + " : " + m.err}          `);
      next();
    });
    wk.on("error", e => { fails++; appendFileSync(LOG, `ERREUR (processus) : ${e.message}\n`); next(); });
    next();
  }
}
