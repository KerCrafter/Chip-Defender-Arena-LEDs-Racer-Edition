// Extrait les textes à traduire : littéraux JS (scripts inline) et blocs HTML.
// Sortie : candidates.json { js: [{src, ctx}], html: [innerHTML], attr: [value] }
const fs = require("fs");
const acorn = require("acorn");
const src = fs.readFileSync(process.argv[2], "utf8");
const FR0 = /[àâçéèêëîïôûùüÿœÀÂÇÉÈÊËÎÏÔÛÙÜŒ]|\b(le|la|les|des|du|un|une|de|et|ou|tu|ta|ton|tes|vous|pour|avec|sans|sur|dans|est|sont|à|au|aux|en|ne|pas|plus|par|qui|que|se|sa|son|ses|lui|leur|il|elle|on|nous|ce|cet|cette|ces|mon|ma|mes|joueur|joueurs|manche|puce|couche|couches|bascule|bascules|carte|courir|tirer|sauter|vol|aucun|aucune|personne|réglé|seuil|signal|broche|Microbes|Défenseurs)\b/i;
const FR = { test: t => /^["`][A-ZÀ-Ü][a-zà-ÿ]{3,}[ !…:.]*["`]$/.test(t.trim()) || /^["`][a-zà-ÿ]{3,} ?[!…]["`]$/.test(t.trim()) };
const out = { js: [], html: [], attr: [] };
const seenJs = new Set();

// ---- scripts inline ----
const re = /<script>([\s\S]*?)<\/script>/g; let m;
while ((m = re.exec(src))) {
  const code = m[1]; if (code.includes("/*CHIPDATA*/") && code.length < 30) continue;
  let ast;
  try { ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "script", allowAwaitOutsideFunction: true, ranges: true }); }
  catch (e) { console.error("parse", e.message); process.exit(1); }
  const nodes = [];
  (function walk(n, parent, key) {
    if (!n || typeof n.type !== "string") return;
    if ((n.type === "Literal" && typeof n.value === "string") || n.type === "TemplateLiteral") {
      const isKey = parent && (parent.type === "Property" && key === "key" && !parent.computed);
      if (!isKey) nodes.push(n);
    }
    for (const k in n) { if (k === "loc" || k === "range") continue; const v = n[k];
      if (Array.isArray(v)) v.forEach(c => walk(c, n, k)); else if (v && typeof v.type === "string") walk(v, n, k); }
  })(ast, null, null);
  // garder les plus externes qui contiennent du français
  const fr = nodes.filter(n => { const t = code.slice(n.start, n.end); return /[A-Za-zÀ-ÿ]{2}/.test(t) && FR.test(t.replace(/\$\{[^}]*\}/g, " ")); });
  const outer = fr.filter(n => !fr.some(o => o !== n && o.start <= n.start && o.end >= n.end));
  for (const n of outer) {
    const t = code.slice(n.start, n.end);
    if (seenJs.has(t)) continue; seenJs.add(t);
    const ls = code.lastIndexOf("\n", n.start), le = code.indexOf("\n", n.end);
    out.js.push({ src: t, ctx: code.slice(ls + 1, le).trim().slice(0, 200) });
  }
}
// ---- HTML : blocs avec du texte direct ----
const body = src.slice(0, src.indexOf("<script>"));
const { JSDOM } = (() => { try { return require("jsdom"); } catch (e) { return {}; } })();
fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
console.log("js", out.js.length);
