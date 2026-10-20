/* Fiches et images des tuiles, tirées des cartes CDA4 (aucune reconversion) :
     node fiches-tuiles.mjs --maps cartes/maps4 [--force]
   Pour chaque puce (dossier) :
     <tuile>.png   aperçu vu de dessus (celui du fichier CDA4, 384 px au plus) : microscope, fond du menu, carte hors partie
     meta.json     { "<tuile>": { w, h, g, n, c, dff, lc } } : dimensions (µm), pas de grille, nombre de formes et de cellules,
                   bascules, cellules logiques (lg), centre de la logique (µm) — tout ce que l'interface doit savoir d'une tuile sans la charger
   On peut relancer : une tuile dont l'image est plus récente que la carte est reprise de l'ancien meta.json. */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync, renameSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { gunzipSync, deflateSync } from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const CODEC = [join(HERE, "cda-codec.js"), join(HERE, "..", "..", "src", "cda-codec.js")].find(p => existsSync(p));
if (!CODEC) { console.error("cda-codec.js introuvable (il doit être à côté de ce script)"); process.exit(1); }
const C = require(CODEC);
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const MAPS = resolve(arg("maps", "cartes/maps4")), FORCE = process.argv.includes("--force");

// mêmes familles de cellules que le jeu
const short = n => n.replace(/^sky130_(fd|ef)_sc_hd__|^sg13g2_|^gf180mcu_fd_sc_mcu[79]t5v0__/, "");
const DFF = /^(dfxtp|dfrtp|dfstp|dfbbp|edfxtp|sdf|dfrbp|dffq|dffrnq|dffsnq|dffrsnq|dffn)/, SKIP = /^(decap|fill|tap|conb|tie|antenna|endcap)/, FILLER = /^(decap|fill|tapvpwrvgnd|endcap)/;

/* PNG RVB minimal (filtre 0, deflate) */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "ascii"), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); }
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function sheet(file) {
  const bytes = new Uint8Array(readFileSync(file));
  if (!C.isCda4(bytes)) throw new Error("pas une carte CDA4");
  const hl = C.headLen4(bytes), H = C.header4(gunzipSync(bytes.subarray(8, hl)), hl), m = H.m, G = m.grid;
  // cellules de toute la tuile (rapide : sans la géométrie)
  let dff = 0, lg = 0, sx = 0, sy = 0, n = 0;
  H.blocks.forEach((b, i) => {
    if (!b[1]) return;
    const d = C.block4(new Uint8Array(gunzipSync(bytes.subarray(hl + b[0], hl + b[0] + b[1]))), H, i, true);
    for (let j = 0; j < d.idx.length; j++) {
      const c = d.cells.subarray(j * 5, j * 5 + 5), t = short(m.types[c[4]] || "");
      if (DFF.test(t)) dff++;
      if (!FILLER.test(t)) lg++;
      if (!SKIP.test(t)) { sx += (c[0] + c[2]) * G; sy += (c[1] + c[3]) * G; n += 2; }
    }
  });
  const r1 = v => Math.round(v * 10) / 10;
  const info = { w: r1(m.w), h: r1(m.h), g: G, n: H.nrects, c: H.ncells, dff, lg, lc: n ? [r1(sx / n), r1(sy / n)] : [r1(m.w / 2), r1(m.h / 2)] };
  // aperçu : 1 octet par pixel (RVB 3-3-2) dans le fichier, en PNG ici
  let img = null;
  if (H.ov && H.ov.len) {
    const q = gunzipSync(bytes.subarray(hl + H.ov.off, hl + H.ov.off + H.ov.len)), rgb = new Uint8Array(H.ov.w * H.ov.h * 3);
    if ((H.ov.fmt || "rgb") === "rgb332") for (let i = 0; i < q.length; i++) { const v = q[i]; rgb[i * 3] = Math.round((v >> 5) * 255 / 7); rgb[i * 3 + 1] = Math.round((v >> 2 & 7) * 255 / 7); rgb[i * 3 + 2] = Math.round((v & 3) * 255 / 3); }
    else rgb.set(q.subarray(0, rgb.length));
    img = png(H.ov.w, H.ov.h, rgb); info.iw = H.ov.w; info.ih = H.ov.h;
  }
  return { info, img };
}

if (!existsSync(MAPS)) { console.error("dossier introuvable : " + MAPS); process.exit(1); }
const t0 = Date.now(); let nT = 0, nNew = 0, nErr = 0, bytes = 0;
const dirs = readdirSync(MAPS).filter(d => statSync(join(MAPS, d)).isDirectory()).sort();
for (const d of dirs) {
  const dir = join(MAPS, d), metaF = join(dir, "meta.json");
  let old = {}; try { old = JSON.parse(readFileSync(metaF, "utf8")); } catch (e) {}
  const out = {};
  const tiles = readdirSync(dir).filter(f => f.endsWith(".bin")).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
  for (const f of tiles) {
    const k = f.slice(0, -4), bin = join(dir, f), pngF = join(dir, k + ".png"); nT++;
    if (!FORCE && old[k] && existsSync(pngF) && statSync(pngF).mtimeMs >= statSync(bin).mtimeMs) { out[k] = old[k]; continue; }
    try {
      const { info, img } = sheet(bin);
      if (img) { writeFileSync(pngF + ".part", img); renameSync(pngF + ".part", pngF); bytes += img.length; }
      out[k] = info; nNew++;
    } catch (e) { nErr++; console.log(`\n  ERREUR ${d}/${k} : ${e.message}`); }
    if (nT % 50 === 0) process.stdout.write(`\r${nT} tuiles · ${nNew} nouvelles fiches · ${nErr} erreur(s)          `);
  }
  writeFileSync(metaF + ".part", JSON.stringify(out)); renameSync(metaF + ".part", metaF);
}
console.log(`\nterminé en ${Math.round((Date.now() - t0) / 1000)} s : ${nT} tuiles, ${nNew} fiches (re)faites, ${nErr} erreur(s) · images : ${(bytes / 1e6).toFixed(1)} Mo`);
console.log("Ensuite : publier-cartes-cda4-r2.bat (n'envoie que les nouveaux fichiers : images .png et meta.json)");
