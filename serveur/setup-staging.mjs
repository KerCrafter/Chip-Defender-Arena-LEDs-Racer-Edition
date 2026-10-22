#!/usr/bin/env node
/* Chip Defender Arena · serveur de STAGING (cda-serveur-staging)
   ==============================================================
   Lance-le avec « setup-staging.bat » (Windows) ou « node setup-staging.mjs » depuis serveur/.
   1. vérifie la connexion à Cloudflare (wrangler login si besoin) ;
   2. met en ligne le Worker de staging (wrangler deploy --env staging) ;
   3. la première fois : fabrique ses propres clés (MASTER, SIGN_KEY, PUBLIC_KEY), différentes de la production,
      et les envoie directement chez Cloudflare (wrangler secret bulk --env staging) ; rien de secret ne reste sur le disque ;
   4. autorise le staging à lire les cartes R2 (règle CORS du bucket cda-maps, outils/cartes/origines-cartes.json) ;
   5. vérifie que le serveur répond avec la connexion directe et sans aucun fournisseur OAuth.
   Le site de staging lit la clé publique à la racine de ce serveur (auth.json : "pubkey": "auto").
   Relancer ce script redéploie le code du serveur ; « node setup-staging.mjs --cles » refait les clés. */
import { spawnSync } from "node:child_process";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WRANGLER = join(HERE, "node_modules", "wrangler", "bin", "wrangler.js");
const STATE_F = join(HERE, ".cda-setup-staging.json");   // rien de secret ici (clé publique et adresse)
const URLS = ["https://auth-staging.kercrafter.live", "https://cda-serveur-staging.kercrafterlab.workers.dev"];
const say = (...a) => console.log(...a);
const wr = (args, opts = {}) => spawnSync(process.execPath, [WRANGLER, ...args], { cwd: HERE, encoding: "utf8", ...opts });
const load = () => { try { return JSON.parse(readFileSync(STATE_F, "utf8")); } catch (e) { return {}; } };
const save = s => writeFileSync(STATE_F, JSON.stringify(s, null, 2), "utf8");

async function main() {
  if (!existsSync(WRANGLER)) throw new Error("wrangler absent : lance d'abord « npm install » dans " + HERE);
  const S = load();
  say("== 1. Compte Cloudflare");
  const who = wr(["whoami"]);
  if (who.status !== 0 || /not authenticated/i.test(who.stdout + who.stderr)) {
    say("   connexion : une page Cloudflare s'ouvre, clique sur « Allow »");
    if (wr(["login"], { stdio: "inherit" }).status !== 0) throw new Error("connexion à Cloudflare interrompue");
  }
  say("   ok");

  say("== 2. Mise en ligne de cda-serveur-staging");
  const d = wr(["deploy", "--env", "staging"], { stdio: ["inherit", "pipe", "pipe"] });
  process.stdout.write(d.stdout || ""); process.stderr.write(d.stderr || "");
  if (d.status !== 0) throw new Error("déploiement refusé (voir ci-dessus)");

  say("== 3. Clés du staging");
  if (S.pubkey && !process.argv.includes("--cles")) say("   déjà en place (clé publique " + S.pubkey.slice(0, 12) + "…)");
  else {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const sec = {
      MASTER: randomBytes(32).toString("base64url"),
      SIGN_KEY: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      PUBLIC_KEY: publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url")
    };
    const f = join(HERE, ".secrets-temp.json");
    writeFileSync(f, JSON.stringify(sec), { encoding: "utf8", mode: 0o600 });
    try {
      const r = wr(["secret", "bulk", f, "--env", "staging"], { stdio: ["inherit", "pipe", "pipe"] });
      if (r.status !== 0) throw new Error("Cloudflare a refusé les secrets :\n" + (r.stdout || "") + (r.stderr || ""));
    } finally { try { unlinkSync(f); } catch (e) {} }
    S.pubkey = sec.PUBLIC_KEY; save(S);
    say("   secrets envoyés à Cloudflare : MASTER, SIGN_KEY, PUBLIC_KEY");
  }

  say("== 4. Cartes R2 : le staging a le droit de les lire (CORS)");
  {
    const O = JSON.parse(readFileSync(join(HERE, "..", "outils", "cartes", "origines-cartes.json"), "utf8"));
    const f = join(HERE, ".cors-r2.json");
    writeFileSync(f, JSON.stringify({ rules: [{ allowed: { origins: O.origins, methods: ["GET", "HEAD"] }, maxAgeSeconds: 86400 }] }));
    try {
      const r = wr(["r2", "bucket", "cors", "set", "cda-maps", "--file", f, "--force"]);
      say(r.status === 0 ? "   ok : " + O.origins.join(", ") : "   ! règles CORS refusées (les cartes ne se chargeront pas sur le staging) :\n" + (r.stdout || "") + (r.stderr || ""));
    } finally { try { unlinkSync(f); } catch (e) {} }
  }

  say("== 5. Vérification");
  for (let i = 0; i < 12; i++) {
    for (const u of URLS) {
      try {
        const j = await (await fetch(u + "/", { cache: "no-store" })).json();
        if (j && j.ready) {
          const okP = JSON.stringify(j.providers) === JSON.stringify(["direct"]);
          say(`   ${u} répond · fournisseurs ${JSON.stringify(j.providers)}${okP ? "" : "  <- attendu : [\"direct\"] seulement"} · clé ${String(j.pubkey).slice(0, 12)}…`);
          say("\nStaging prêt. Le site https://staging.chip-defender-arena.kercrafter.live s'y connecte tout seul.");
          return;
        }
      } catch (e) {}
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  say("   le serveur ne répond pas encore (propagation du domaine) : réessaie dans quelques minutes, ou ouvre " + URLS[1]);
}
main().catch(e => { console.error("\nERREUR : " + (e && e.message || e)); process.exit(1); });
