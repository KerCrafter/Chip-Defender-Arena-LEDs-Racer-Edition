// Configuration des environnements (config/<env>/) et cohérence des copies de modules
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const R = p => fileURLToPath(new URL("../../" + p, import.meta.url));
const J = p => JSON.parse(readFileSync(R(p), "utf8"));

for (const env of ["production", "staging"]) {
  test(`config/${env} : fichiers publics complets et sans secret`, () => {
    const a = J(`config/${env}/auth.json`), s = J(`config/${env}/site.json`);
    assert.equal(s.env, env);
    for (const k of ["server", "relay", "pubkey", "providers"]) assert.ok(a[k], k);
    assert.match(a.server, /^https:\/\//); assert.match(a.relay, /^wss:\/\/.+\/relay$/);
    const txt = JSON.stringify(a).toLowerCase();
    for (const bad of ["secret", "master", "sign_key", "token"]) assert.ok(!txt.includes(bad), bad);
  });
}

test("production : OAuth seulement, clé épinglée, indexable", () => {
  const a = J("config/production/auth.json"), s = J("config/production/site.json");
  assert.ok(!a.providers.includes("direct") && !a.providers.includes("dev"));
  assert.match(a.pubkey, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(s.noindex, false);
  assert.equal(s.url, "https://chip-defender-arena.kercrafter.live/");
});

test("staging : connexion directe seulement, serveur distinct de la production, non indexé", () => {
  const a = J("config/staging/auth.json"), p = J("config/production/auth.json"), s = J("config/staging/site.json");
  assert.deepEqual(a.providers, ["direct"]);
  assert.notEqual(a.server, p.server);
  assert.equal(s.noindex, true);
});

test("outils/cartes/cda-codec.js est une copie exacte de src/cda-codec.js", () => {
  assert.equal(readFileSync(R("outils/cartes/cda-codec.js"), "utf8"), readFileSync(R("src/cda-codec.js"), "utf8"));
});
