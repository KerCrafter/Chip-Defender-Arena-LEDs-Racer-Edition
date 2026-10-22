// Domaine : simulateur porte par porte (src/gate-sim.js) — logique pure, sans navigateur
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { createSim, cellFunction, classify } = createRequire(import.meta.url)("../../src/gate-sim.js");

const truth = (fn, n) => Array.from({ length: 1 << n }, (_, k) => fn(Array.from({ length: n }, (_, b) => (k >> b) & 1)) ? 1 : 0);

test("classify : familles des trois bibliothèques", () => {
  assert.equal(classify("inv", ["A"], ["Y"]).k, "inv");
  assert.equal(classify("nand2", ["A", "B"], ["Y"]).k, "gate");
  assert.equal(classify("xnor2", ["A", "B"], ["Y"]).n, true);
  assert.equal(classify("a21oi", ["A1", "A2", "B1"], ["Y"]).k, "grp");
  assert.equal(classify("aoi21", ["A1", "A2", "B"], ["ZN"]).y, true);   // GF180 : sortie ZN inversée
  assert.deepEqual(classify("mux2", ["I0", "I1", "S"], ["Z"]), { k: "mux", a0: "I0", a1: "I1", s: "S", n: false });
  assert.equal(classify("quelquechose", ["A"], ["X"]), null);
});

test("cellFunction : tables de vérité", () => {
  assert.deepEqual(truth(cellFunction("nand2_1", ["A", "B"], ["Y"]), 2), [1, 1, 1, 0]);
  assert.deepEqual(truth(cellFunction("nor2_1", ["A", "B"], ["Y"]), 2), [1, 0, 0, 0]);
  assert.deepEqual(truth(cellFunction("xor2_1", ["A", "B"], ["X"]), 2), [0, 1, 1, 0]);
  assert.deepEqual(truth(cellFunction("and2b_1", ["A_N", "B"], ["X"]), 2), [0, 0, 1, 0]);   // A inversée
  // a21oi : !((A1 & A2) | B1)
  assert.deepEqual(truth(cellFunction("a21oi_1", ["A1", "A2", "B1"], ["Y"]), 3), [1, 1, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual(truth(cellFunction("maj3_1", ["A", "B", "C"], ["X"]), 3), [0, 0, 0, 1, 0, 1, 1, 1]);
});

// compteur 1 bit : bascule D dont l'entrée est l'inverse de sa sortie
const toggle = () => createSim({
  types: [{ t: "dfrtp_1", p: ["CLK", "D", "RESET_B", "Q"] }, { t: "inv_1", p: ["A", "Y"] }],
  nets: 4, names: { 0: "clk", 1: "d", 2: "rst_n", 3: "q" },
  cells: [[0, 0, 1, 2, 3], [1, 3, 1]]
});

test("createSim : une bascule bascule à chaque coup d'horloge", () => {
  const s = toggle();
  s.set("rst_n", 1); s.settle();
  const seen = [];
  for (let k = 0; k < 4; k++) { s.step(); seen.push(s.get("q")); }
  assert.deepEqual(seen, [1, 0, 1, 0]);
  assert.equal(s.cycle(), 4);
});

test("createSim : la remise à zéro active basse l'emporte", () => {
  const s = toggle();
  s.set("rst_n", 0); s.settle(); s.step(3);
  assert.equal(s.get("q"), 0);
});

test("getFF / setFF : l'état des bascules se transporte d'une simulation à l'autre (banc partagé en coop)", () => {
  const a = toggle(), b = toggle();
  a.set("rst_n", 1); a.settle(); a.step();
  b.set("rst_n", 1); b.setFF(a.getFF()); b.setCycle(a.cycle());
  assert.equal(b.get("q"), 1); assert.equal(b.get("d"), 0);
  a.step(); b.step();
  assert.equal(a.get("q"), b.get("q")); assert.equal(a.cycle(), b.cycle());
});
