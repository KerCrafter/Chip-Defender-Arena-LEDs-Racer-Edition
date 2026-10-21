/* Simulateur logique de la puce, porte par porte (cellules standard SKY130), au rythme de l'horloge.
   Responsabilité unique : à partir de la liste des connexions exportée par tools/code_tuiles.py (« sim »), calculer la
   valeur de chaque fil, coup d'horloge après coup d'horloge. Il ne sait rien de l'affichage ni du jeu.
   Simulation logique (0/1, sans délais) : toutes les bascules prennent leur entrée D au même front d'horloge.
   La fonction de chaque cellule est déduite de son nom et de ses broches (conventions de la bibliothèque SKY130) :
     inv, buf, clkbuf, dlygate… ; and/nand/or/nor (broches *_N inversées) ; xor/xnor ; mux2/mux2i ; conb (constantes) ;
     familles a…/o… (a21oi, o211a, a2bb2o…) : groupes de broches A*, B*, C*, D* ; dfxtp/dfrtp/dfstp/dfrbp (bascules). */
(function (root) {
"use strict";
const OUT = new Set(["X", "Y", "Q", "Q_N", "HI", "LO", "COUT", "SUM", "GCLK"]);
const lit = (p, v) => p.endsWith("_N") ? !v : !!v;

// fonction d'une cellule combinatoire : (valeurs des entrées, dans l'ordre de ins) -> valeur de la sortie principale
function cellFunction(base, ins, outs) {
  const b = base.replace(/_\d+$/, ""), y = outs.includes("Y") && !outs.includes("X");
  const inv = v => y ? !v : v;
  if (/^(inv|clkinv|clkinvlp|bufinv|einvp|einvn)$/.test(b)) return v => !v[0];
  if (/^(buf|clkbuf|dlygate\w*|dlymetal\w*|clkdlybuf\w*|bufbuf|dlclkp|probe_\w+|lpflow_\w*buf\w*)$/.test(b)) return v => !!v[0];
  if (/^x(n?)or\d$/.test(b)) return v => { let p = false; for (const x of v) p = p !== !!x; return /^xnor/.test(b) ? !p : p; };
  if (/^mux2i?$/.test(b)) { const iA0 = ins.indexOf("A0"), iA1 = ins.indexOf("A1"), iS = ins.indexOf("S"); return v => { const r = v[iS] ? !!v[iA1] : !!v[iA0]; return b === "mux2i" ? !r : r; }; }
  if (/^mux4$/.test(b)) { const I = ["A0", "A1", "A2", "A3"].map(p => ins.indexOf(p)), s0 = ins.indexOf("S0"), s1 = ins.indexOf("S1"); return v => !!v[I[(v[s1] ? 2 : 0) + (v[s0] ? 1 : 0)]]; }
  if (/^maj3$/.test(b)) return v => (v[0] ? 1 : 0) + (v[1] ? 1 : 0) + (v[2] ? 1 : 0) >= 2;
  const m = b.match(/^(n?and|n?or)\d+[b]*$/);
  if (m) {
    const isAnd = m[1].endsWith("and");
    return v => { let r = isAnd; for (let k = 0; k < ins.length; k++) { const x = lit(ins[k], v[k]); r = isAnd ? r && x : r || x; } return inv(r); };
  }
  const f = b.match(/^([ao])\d/);
  if (f) {   // a… : ET dans chaque groupe, OU entre groupes ; o… : l'inverse
    const andIn = f[1] === "a", groups = {};
    ins.forEach((p, k) => { const g = p[0]; (groups[g] = groups[g] || []).push(k); });
    const G = Object.values(groups);
    return v => {
      let outer = !andIn;
      for (const g of G) {
        let inner = andIn;
        for (const k of g) { const x = lit(ins[k], v[k]); inner = andIn ? inner && x : inner || x; }
        outer = andIn ? outer || inner : outer && inner;
      }
      return inv(outer);
    };
  }
  return null;
}

function createSim(S) {
  const T = S.types.map(t => {
    const pins = t.p, ins = pins.filter(p => !OUT.has(p)), outs = pins.filter(p => OUT.has(p)), b = t.t.replace(/_\d+$/, "");
    const ff = /^(df|edf|sdf)/.test(b);
    return { b, pins, ins, outs, ff, fn: ff || b === "conb" ? null : cellFunction(t.t, ins, outs), inIdx: ins.map(p => pins.indexOf(p)), outIdx: outs.map(p => pins.indexOf(p)) };
  });
  const nets = new Uint8Array(S.nets + 2), name2net = new Map();
  for (const k in S.names) name2net.set(S.names[k], +k);
  const driver = new Int32Array(S.nets).fill(-1), comb = [], ffs = [], unknown = new Set();
  S.cells.forEach((c, i) => {
    const t = T[c[0]];
    t.outIdx.forEach(o => { const n = c[1 + o]; if (n >= 0) driver[n] = i; });
    if (t.ff) ffs.push(i); else if (t.b === "conb") { const hi = t.pins.indexOf("HI"), lo = t.pins.indexOf("LO"); if (hi >= 0 && c[1 + hi] >= 0) nets[c[1 + hi]] = 1; if (lo >= 0 && c[1 + lo] >= 0) nets[c[1 + lo]] = 0; }
    else if (t.fn) comb.push(i); else unknown.add(t.b);
  });
  // ordre d'évaluation : chaque porte après celles qui la nourrissent (les bascules et les entrées sont des sources)
  const order = [], state = new Uint8Array(S.cells.length);   // 0 : à faire, 1 : en cours, 2 : faite
  const isComb = new Uint8Array(S.cells.length); comb.forEach(i => isComb[i] = 1);
  const visit = i0 => {
    const st = [[i0, 0]];
    while (st.length) {
      const top = st[st.length - 1], i = top[0], c = S.cells[i], t = T[c[0]];
      if (top[1] === 0) { if (state[i]) { st.pop(); continue; } state[i] = 1; }
      if (top[1] < t.inIdx.length) {
        const n = c[1 + t.inIdx[top[1]++]], d = n >= 0 ? driver[n] : -1;
        if (d >= 0 && isComb[d] && !state[d]) st.push([d, 0]);
        continue;
      }
      state[i] = 2; order.push(i); st.pop();
    }
  };
  comb.forEach(visit);
  /* programme compilé : une suite d'instructions [op, a, b, c] sur deux registres (g : groupe, o : sortie) ;
     bien plus rapide que d'appeler une fonction par porte (pas de génération de code : compatible avec la CSP) */
  const ZERO = S.nets, ONE = S.nets + 1;
  nets[ONE] = 1;
  const net = n => n >= 0 ? n : n === -2 ? ONE : ZERO;
  const P = [];
  const emit = (op, a, b, c) => P.push(op, a, b || 0, c || 0);
  for (const i of order) {
    const c = S.cells[i], t = T[c[0]], b = t.b, o = c[1 + t.outIdx[0]];
    if (o === undefined || o < 0) continue;
    const ins = t.ins, inN = t.inIdx.map(k => net(c[1 + k])), invN = ins.map(p => p.endsWith("_N") ? 1 : 0);
    const y = t.outs.includes("Y") && !t.outs.includes("X") ? 1 : 0;
    if (/^(inv|clkinv|clkinvlp|bufinv|einvp|einvn)$/.test(b)) { emit(0, inN[0], 1); emit(3); emit(6, o, 0); continue; }
    if (/^(buf|clkbuf|dlygate\w*|dlymetal\w*|clkdlybuf\w*|bufbuf|dlclkp|probe_\w+|lpflow_\w*buf\w*)$/.test(b)) { emit(0, inN[0], 0); emit(3); emit(6, o, 0); continue; }
    if (/^x(n?)or\d$/.test(b)) { emit(0, inN[0], 0); for (let k = 1; k < inN.length; k++) emit(7, inN[k], 0); emit(3); emit(6, o, /^xnor/.test(b) ? 1 : 0); continue; }
    if (/^mux2i?$/.test(b)) { emit(8, net(c[1 + t.pins.indexOf("S")]), net(c[1 + t.pins.indexOf("A1")]), net(c[1 + t.pins.indexOf("A0")])); emit(6, o, b === "mux2i" ? 1 : 0); continue; }
    const m = b.match(/^(n?and|n?or)\d+[b]*$/), f = b.match(/^([ao])\d/);
    if (m) {
      const isAnd = m[1].endsWith("and");
      emit(0, inN[0], invN[0]); for (let k = 1; k < inN.length; k++) emit(isAnd ? 1 : 2, inN[k], invN[k]);
      emit(3); emit(6, o, y); continue;
    }
    if (f) {
      const andIn = f[1] === "a", groups = {};
      ins.forEach((p, k) => { (groups[p[0]] = groups[p[0]] || []).push(k); });
      Object.values(groups).forEach((g, gi) => {
        emit(0, inN[g[0]], invN[g[0]]); for (let k = 1; k < g.length; k++) emit(andIn ? 1 : 2, inN[g[k]], invN[g[k]]);
        emit(gi === 0 ? 3 : andIn ? 5 : 4);
      });
      emit(6, o, y); continue;
    }
    // autre (rare) : fonction générique
    P.push(9, i, 0, 0);
  }
  const prog = Int32Array.from(P), vin = [];
  function evalComb() {
    const n = nets, p = prog, L = p.length;
    let g = 0, o = 0;
    for (let k = 0; k < L; k += 4) {
      switch (p[k]) {
        case 0: g = n[p[k + 1]] ^ p[k + 2]; break;
        case 1: g &= n[p[k + 1]] ^ p[k + 2]; break;
        case 2: g |= n[p[k + 1]] ^ p[k + 2]; break;
        case 3: o = g; break;
        case 4: o &= g; break;
        case 5: o |= g; break;
        case 6: n[p[k + 1]] = o ^ p[k + 2]; break;
        case 7: g ^= n[p[k + 1]] ^ p[k + 2]; break;
        case 8: o = n[p[k + 1]] ? n[p[k + 2]] : n[p[k + 3]]; break;
        case 9: {
          const i = p[k + 1], c = S.cells[i], t = T[c[0]];
          vin.length = t.inIdx.length;
          for (let q = 0; q < t.inIdx.length; q++) vin[q] = n[net(c[1 + t.inIdx[q]])];
          const out = c[1 + t.outIdx[0]]; if (out >= 0) n[out] = t.fn(vin) ? 1 : 0;
          break;
        }
      }
    }
  }
  const pin = (i, p) => { const c = S.cells[i], t = T[c[0]], k = t.pins.indexOf(p); return k >= 0 ? c[1 + k] : -1; };
  const ffD = ffs.map(i => pin(i, "D")), ffQ = ffs.map(i => pin(i, "Q")), ffQN = ffs.map(i => pin(i, "Q_N")),
    ffR = ffs.map(i => pin(i, "RESET_B")), ffS = ffs.map(i => pin(i, "SET_B")), ffDE = ffs.map(i => pin(i, "DE"));
  const nxt = new Uint8Array(ffs.length);
  let cycle = 0;
  const api = {
    cycle: () => cycle, nets, name2net, unknown: [...unknown], ffs, ffQ, driver,
    set(name, v) { const n = name2net.get(name); if (n !== undefined) nets[n] = v ? 1 : 0; },
    get(name) { const n = name2net.get(name); return n === undefined ? 0 : nets[n]; },
    val: n => n >= 0 ? nets[n] : 0,
    settle: evalComb,
    step(k = 1) {   // k coups d'horloge
      // la logique est déjà à jour (settle après chaque changement d'entrée) : on capture, on bascule, on recalcule
      for (let s = 0; s < k; s++) {
        for (let j = 0; j < ffs.length; j++) {
          let v = ffD[j] >= 0 ? nets[ffD[j]] : 0;
          if (ffDE[j] >= 0 && !nets[ffDE[j]]) v = ffQ[j] >= 0 ? nets[ffQ[j]] : 0;
          if (ffR[j] >= 0 && !nets[ffR[j]]) v = 0;
          if (ffS[j] >= 0 && !nets[ffS[j]]) v = 1;
          nxt[j] = v;
        }
        for (let j = 0; j < ffs.length; j++) { if (ffQ[j] >= 0) nets[ffQ[j]] = nxt[j]; if (ffQN[j] >= 0) nets[ffQN[j]] = 1 - nxt[j]; }
        cycle++;
        evalComb();
      }
    },
    clear() { for (const q of ffQ) if (q >= 0) nets[q] = 0; cycle = 0; evalComb(); },
    outPin: i => { const c = S.cells[i], t = T[c[0]]; return t.outIdx.length ? c[1 + t.outIdx[0]] : -1; },
    cellNets: i => S.cells[i].slice(1),
    isFF: i => T[S.cells[i][0]].ff,
  };
  return api;
}

const api = { createSim, cellFunction };
if (typeof module !== "undefined" && module.exports) module.exports = api; else root.CDA_SIM = api;
})(typeof self !== "undefined" ? self : this);
