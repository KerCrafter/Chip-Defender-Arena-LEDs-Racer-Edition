// Réglages communs des tests de bout en bout (navigateur réel + serveur local)
// Tout se règle par variables d'environnement ; les valeurs par défaut suivent test/e2e/README.md.
const fs = require('fs'), path = require('path');
const SITE = process.env.CDA_SITE || 'http://127.0.0.1:8765/index.html';   // site construit par prepare.sh
const SRV = process.env.CDA_SRV || 'http://127.0.0.1:8787';                // wrangler dev --env staging
// Chromium : CHROME, sinon celui de Playwright (PLAYWRIGHT_BROWSERS_PATH), sinon celui que Playwright choisit
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && fs.existsSync(base)) for (const d of fs.readdirSync(base).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()) {
    const p = path.join(base, d, 'chrome-linux', 'chrome'); if (fs.existsSync(p)) return p;
  }
  return undefined;
}
const SHOTS = process.env.CDA_SHOTS || path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
module.exports = { SITE, SRV, CHROME: findChrome(), SHOTS };
