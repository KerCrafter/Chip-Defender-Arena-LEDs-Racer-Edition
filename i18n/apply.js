// Remplace chaque littéral traduit par (EN ? anglais : français) dans les scripts inline
const fs = require("fs"), acorn = require("acorn");
const [, , inp, dictF, outp] = process.argv;
const src = fs.readFileSync(inp, "utf8"), dict = JSON.parse(fs.readFileSync(dictF, "utf8"));
const used = new Set();
const res = src.replace(/<script>([\s\S]*?)<\/script>/g, (all, code) => {
  if (code.trim() === "/*CHIPDATA*/") return all;
  const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "script", allowAwaitOutsideFunction: true });
  const hits = [];
  (function walk(n, parent, key) {
    if (!n || typeof n.type !== "string") return;
    if ((n.type === "Literal" && typeof n.value === "string") || n.type === "TemplateLiteral") {
      const t = code.slice(n.start, n.end);
      const isKey = parent && parent.type === "Property" && key === "key" && !parent.computed;
      if (!isKey && dict[t] !== undefined) { hits.push([n.start, n.end, t]); return; }
    }
    for (const k in n) { const v = n[k]; if (Array.isArray(v)) v.forEach(c => walk(c, n, k)); else if (v && typeof v.type === "string") walk(v, n, k); }
  })(ast, null, null);
  hits.sort((a, b) => b[0] - a[0]);
  let c = code;
  for (const [s, e, t] of hits) { used.add(t); c = c.slice(0, s) + `(EN ? ${dict[t]} : ${t})` + c.slice(e); }
  return "<script>" + c + "</script>";
});
fs.writeFileSync(outp, res);
const miss = Object.keys(dict).filter(k => !used.has(k));
console.log("traduits", used.size, "/", Object.keys(dict).length, miss.length ? "\nNON TROUVÉS :\n" + miss.join("\n") : "");
