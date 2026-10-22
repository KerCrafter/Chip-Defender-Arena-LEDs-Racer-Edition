const fs = require("fs"), acorn = require("acorn");
const src = fs.readFileSync("../game.html", "utf8"), dict = JSON.parse(fs.readFileSync("en_js.json", "utf8"));
const out = new Set();
src.replace(/<script>([\s\S]*?)<\/script>/g, (all, code) => {
  if (code.trim() === "/*CHIPDATA*/") return;
  const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "script", allowAwaitOutsideFunction: true });
  (function walk(n, inside) {
    if (!n || typeof n.type !== "string") return;
    let tr = inside;
    if ((n.type === "Literal" && typeof n.value === "string") || n.type === "TemplateLiteral") {
      const t = code.slice(n.start, n.end);
      if (dict[t] !== undefined) tr = true;
      else if (!inside) { const plain = t.replace(/\$\{[^}]*\}/g, ""); if (/[a-zà-ÿ]{2,}/i.test(plain) && !/^["'`][\w#.,%-]*["'`]$/.test(t) && !/px|rgba|#include|=>|function|\bvar\b|gl_|vec\d|uniform/.test(t) && t.length < 200) out.add(t); }
    }
    for (const k in n) { const v = n[k]; if (Array.isArray(v)) v.forEach(c => walk(c, tr)); else if (v && typeof v.type === "string") walk(v, tr); }
  })(ast, false);
});
console.log([...out].join("\n"));
