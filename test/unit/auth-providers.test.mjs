// Adaptateurs d'identité du serveur (serveur/src/auth/providers.js) : qui est actif, et le garde-fou de production
import { test } from "node:test";
import assert from "node:assert/strict";
import { enabledProviders, providerFor, directAllowed, directIdentity, PROD_ORIGIN } from "../../serveur/src/auth/providers.js";

const STAGING = { SITE_ORIGINS: "https://staging.chip-defender-arena.kercrafter.live", AUTH_DIRECT: "1" };
const PROD = { SITE_ORIGINS: PROD_ORIGIN + ",https://kercrafter.github.io", GITHUB_ID: "x", GITHUB_SECRET: "y", GOOGLE_ID: "g" };

test("production : seuls les fournisseurs OAuth complets sont actifs", () => {
  assert.deepEqual(enabledProviders(PROD), ["github"]);   // Google sans secret : inactif
  assert.equal(providerFor(PROD, "direct"), null);
  assert.equal(providerFor(PROD, "dev"), null);
});

test("garde-fou : la connexion directe est refusée dès que la production est autorisée, même avec AUTH_DIRECT=1 ou DEV=1", () => {
  assert.equal(directAllowed({ ...PROD, AUTH_DIRECT: "1" }), false);
  assert.equal(directAllowed({ ...PROD, DEV: "1" }), false);
  assert.ok(!enabledProviders({ ...PROD, AUTH_DIRECT: "1" }).includes("direct"));
});

test("staging : connexion directe seulement", () => {
  assert.deepEqual(enabledProviders(STAGING), ["direct"]);
  assert.equal(providerFor(STAGING, "direct").kind, "direct");
  assert.equal(providerFor(STAGING, "dev").name, "direct");   // alias des anciens tests
  assert.equal(providerFor(STAGING, "github"), null);
});

test("sans AUTH_DIRECT ni DEV : pas de connexion directe", () => {
  assert.equal(directAllowed({ SITE_ORIGINS: STAGING.SITE_ORIGINS }), false);
});

test("identité directe : nom nettoyé, même nom = même joueur", () => {
  assert.deepEqual(directIdentity("  Alice "), { sub: "direct:alice", n: "Alice", a: "" });
  assert.equal(directIdentity("<b>x</b>").n, "bx/b");
  assert.equal(directIdentity("").n, "testeur");
  assert.equal(directIdentity("A".repeat(40)).n.length, 24);
});
