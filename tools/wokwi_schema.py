#!/usr/bin/env python3
"""Schéma des projets Wokwi (Tiny Tapeout) pour le scanner de poche de Chip Defender Arena.

À partir du diagram.json de Wokwi (le dessin du concepteur), produit ce que le jeu affiche à la place du code :
  - les éléments logiques du schéma (portes, multiplexeurs, bascules), leurs réseaux, les entrées / sorties de la puce
  - le schéma redessiné en SVG : symboles normalisés aux positions d'origine, fils routés à l'horizontale et à la
    verticale (routeur A* sur grille : les boîtiers sont évités, les croisements pénalisés, les bus regroupés),
    VCC et masse en symboles d'alimentation posés sur la broche
  - une lecture du circuit en quelques phrases (familles d'éléments, bus, profondeur logique)
Les éléments sans fil ou dont la sortie ne va nulle part sont retirés, comme Yosys le fait à la synthèse : ils n'ont
pas de cellule dans la tuile. Les composants de banc d'essai (interrupteurs, LEDs, afficheurs, boutons, horloge) sont
hors de la puce : seules les broches des blocs Tiny Tapeout (entrées, sorties, bidirectionnelles) sont dessinées.

Utilisé par code_tuiles.py (fiche <tuile>.code.json des projets Wokwi) ; seul :
  python wokwi_schema.py diagram.json sortie.svg [sortie.json]
"""
import json, math, re, sys, heapq
from collections import defaultdict, Counter

# ---------- composants Wokwi ----------
# éléments logiques : (famille, broches d'entrée, broches de sortie)
LOGIC = {
    "wokwi-gate-and-2": ("AND", ["A", "B"], ["OUT"]), "wokwi-gate-or-2": ("OR", ["A", "B"], ["OUT"]),
    "wokwi-gate-xor-2": ("XOR", ["A", "B"], ["OUT"]), "wokwi-gate-nand-2": ("NAND", ["A", "B"], ["OUT"]),
    "wokwi-gate-nor-2": ("NOR", ["A", "B"], ["OUT"]), "wokwi-gate-xnor-2": ("XNOR", ["A", "B"], ["OUT"]),
    "wokwi-gate-not": ("NOT", ["IN"], ["OUT"]), "wokwi-gate-buffer": ("BUF", ["IN"], ["OUT"]),
    "wokwi-mux-2": ("MUX2", ["A", "B", "SEL"], ["OUT"]),
    "wokwi-flip-flop-d": ("DFF", ["D", "CLK"], ["Q", "NOTQ"]),
    "wokwi-flip-flop-dr": ("DFF", ["D", "CLK", "S", "R"], ["Q", "NOTQ"]),
    "wokwi-flip-flop-dsr": ("DFF", ["D", "CLK", "S", "R"], ["Q", "NOTQ"]),
    "wokwi-flip-flop-t": ("TFF", ["T", "CLK"], ["Q", "NOTQ"]), "wokwi-flip-flop-jk": ("JKFF", ["J", "K", "CLK"], ["Q", "NOTQ"]),
    "wokwi-flip-flop-sr": ("SRFF", ["S", "R", "CLK"], ["Q", "NOTQ"]),
}
FR = {"AND": "porte ET", "OR": "porte OU", "XOR": "OU exclusif", "NAND": "porte NON-ET", "NOR": "porte NON-OU", "XNOR": "NON-OU exclusif",
      "NOT": "inverseur", "BUF": "tampon", "MUX2": "multiplexeur 2→1", "DFF": "bascule D", "TFF": "bascule T", "JKFF": "bascule JK", "SRFF": "bascule SR"}
EN = {"AND": "AND gate", "OR": "OR gate", "XOR": "XOR gate", "NAND": "NAND gate", "NOR": "NOR gate", "XNOR": "XNOR gate",
      "NOT": "inverter", "BUF": "buffer", "MUX2": "2:1 multiplexer", "DFF": "D flip-flop", "TFF": "T flip-flop", "JKFF": "JK flip-flop", "SRFF": "SR flip-flop"}
POWER = {"wokwi-vcc": "VCC", "wokwi-gnd": "GND"}
TT_IN, TT_OUT, TT_IO = "board-tt-block-input", "board-tt-block-output", "board-tt-block-bidirectional-io"
# broches des blocs Tiny Tapeout -> nom du port de la puce
def tt_port(part, pin):
    t = part["type"]
    if t == TT_IN:
        m = re.fullmatch(r"IN(\d)", pin)
        if m: return f"ui_in[{m.group(1)}]"
        if pin == "CLK": return "clk"
        if pin == "RST_N": return "rst_n"
    elif t == TT_OUT:
        m = re.fullmatch(r"OUT(\d)", pin)
        if m: return f"uo_out[{m.group(1)}]"
    elif t == TT_IO:
        b = str((part.get("attrs") or {}).get("verilogBit", "?"))
        if pin == "IN": return f"uio_in[{b}]"
        if pin == "OUT": return f"uio_out[{b}]"
        if pin == "OE": return f"uio_oe[{b}]"
    return None
# ports « anciens » (sans bloc Tiny Tapeout) : un composant de banc d'essai branché directement sur la logique
OLD_IN = {"wokwi-dip-switch-8", "wokwi-slide-switch", "wokwi-pushbutton", "wokwi-pushbutton-6mm", "wokwi-clock-generator"}
OLD_OUT = {"wokwi-led", "wokwi-led-bar-graph", "wokwi-7segment"}
PATH_RE = re.compile(r"([hv])(-?[\d.]+)")

# ---------- géométrie (px Wokwi, sans rotation) : taille et position des broches ----------
G = 9.6
def _g2(sym): return {"w": 48, "h": 38.4, "sym": sym, "pins": {"A": (0, 9.6), "B": (0, 28.8), "OUT": (48, 19.2)}}
GEOM = {
    "wokwi-gate-and-2": _g2("AND"), "wokwi-gate-or-2": _g2("OR"), "wokwi-gate-xor-2": _g2("XOR"),
    "wokwi-gate-nand-2": _g2("NAND"), "wokwi-gate-nor-2": _g2("NOR"), "wokwi-gate-xnor-2": _g2("XNOR"),
    "wokwi-gate-not": {"w": 48, "h": 38.4, "sym": "NOT", "pins": {"IN": (0, 19.2), "OUT": (48, 19.2)}},
    "wokwi-gate-buffer": {"w": 48, "h": 38.4, "sym": "BUF", "pins": {"IN": (0, 19.2), "OUT": (48, 19.2)}},
    "wokwi-mux-2": {"w": 48, "h": 57.6, "sym": "MUX2", "pins": {"A": (0, 19.2), "B": (0, 38.4), "SEL": (24, 57.6), "OUT": (48, 28.8)}},
    "wokwi-flip-flop-d": {"w": 57.6, "h": 57.6, "sym": "DFF", "pins": {"D": (0, 19.2), "CLK": (0, 38.4), "Q": (57.6, 19.2), "NOTQ": (57.6, 38.4)}},
    "wokwi-flip-flop-dr": {"w": 57.6, "h": 76.8, "sym": "DFFR", "pins": {"S": (28.8, 0), "D": (0, 28.8), "CLK": (0, 48), "R": (28.8, 76.8), "Q": (57.6, 28.8), "NOTQ": (57.6, 48)}},
    "wokwi-flip-flop-dsr": {"w": 57.6, "h": 76.8, "sym": "DFFR", "pins": {"S": (28.8, 0), "D": (0, 28.8), "CLK": (0, 48), "R": (28.8, 76.8), "Q": (57.6, 28.8), "NOTQ": (57.6, 48)}},
    "wokwi-flip-flop-t": {"w": 57.6, "h": 57.6, "sym": "TFF", "pins": {"T": (0, 19.2), "CLK": (0, 38.4), "Q": (57.6, 19.2), "NOTQ": (57.6, 38.4)}},
    "wokwi-flip-flop-jk": {"w": 57.6, "h": 76.8, "sym": "JKFF", "pins": {"J": (0, 19.2), "CLK": (0, 38.4), "K": (0, 57.6), "Q": (57.6, 28.8), "NOTQ": (57.6, 48)}},
    "wokwi-flip-flop-sr": {"w": 57.6, "h": 76.8, "sym": "SRFF", "pins": {"S": (0, 19.2), "CLK": (0, 38.4), "R": (0, 57.6), "Q": (57.6, 28.8), "NOTQ": (57.6, 48)}},
    "wokwi-vcc": {"w": 19.2, "h": 28.8, "sym": "VCC", "pins": {"VCC": (9.6, 28.8)}},
    "wokwi-gnd": {"w": 19.2, "h": 28.8, "sym": "GND", "pins": {"GND": (9.6, 0)}},
    "wokwi-junction": {"w": 4.8, "h": 4.8, "sym": "JCT", "pins": {"J": (2.4, 2.4)}},
    "wokwi-text": {"w": 0, "h": 0, "sym": "TEXT", "pins": {}},
    TT_IN: {"w": 96, "h": 124.8, "sym": "TTIN", "pins": {**{f"IN{k}": (96, 14.4 + 9.6 * k) for k in range(8)}, "CLK": (96, 100.8), "RST_N": (96, 110.4),
                                                        **{f"EXTIN{k}": (0, 14.4 + 9.6 * k) for k in range(8)}, "EXTCLK": (0, 100.8), "EXTRST_N": (0, 110.4)}},
    TT_OUT: {"w": 96, "h": 96, "sym": "TTOUT", "pins": {**{f"OUT{k}": (0, 14.4 + 9.6 * k) for k in range(8)}, **{f"EXTOUT{k}": (96, 14.4 + 9.6 * k) for k in range(8)}}},
    TT_IO: {"w": 76.8, "h": 38.4, "sym": "TTIO", "pins": {"OUT": (0, 9.6), "OE": (0, 28.8), "IN": (0, 19.2), "UIO": (76.8, 19.2)}},
    # banc d'essai (hors de la puce) : seulement pour l'ancien style sans bloc Tiny Tapeout
    "wokwi-dip-switch-8": {"w": 82.87, "h": 55.355, "sym": "DIP", "pins": {**{f"{i}a": (8.1 + 9.6 * (i - 1), 51.3) for i in range(1, 9)}, **{f"{i}b": (8.1 + 9.6 * (i - 1), 3) for i in range(1, 9)}}},
    "wokwi-led-bar-graph": {"w": 38.2, "h": 96.4, "sym": "BAR", "pins": {**{f"A{i}": (4.8, 4.8 + 9.6 * (i - 1)) for i in range(1, 11)}, **{f"C{i}": (33.4, 4.8 + 9.6 * (i - 1)) for i in range(1, 11)}}},
    "wokwi-7segment": {"w": 76.8, "h": 105.6, "sym": "SEG", "pins": {"A": (0, 9.6), "B": (0, 19.2), "C": (0, 28.8), "D": (0, 38.4), "E": (0, 48), "F": (0, 57.6), "G": (0, 67.2), "DP": (0, 76.8), "COM.1": (38.4, 0), "COM.2": (38.4, 105.6)}},
    "wokwi-led": {"w": 19.2, "h": 38.4, "sym": "LED", "pins": {"A": (4.8, 38.4), "C": (14.4, 38.4)}},
    "wokwi-slide-switch": {"w": 48, "h": 28.8, "sym": "SW", "pins": {"1": (9.6, 28.8), "2": (24, 28.8), "3": (38.4, 28.8)}},
    "wokwi-pushbutton": {"w": 48, "h": 48, "sym": "BTN", "pins": {"1.l": (0, 9.6), "2.l": (0, 38.4), "1.r": (48, 9.6), "2.r": (48, 38.4)}},
    "wokwi-clock-generator": {"w": 57.6, "h": 38.4, "sym": "CLKGEN", "pins": {"CLK": (57.6, 19.2)}},
    "wokwi-resistor": {"w": 59.1, "h": 11.3, "sym": "RES", "pins": {"1": (0, 5.65), "2": (58.8, 5.65)}},
}

def pin_abs(part, pn):
    g = GEOM.get(part["type"])
    if not g or pn not in g["pins"]: return None
    px, py = g["pins"][pn]; cx, cy = g["w"] / 2, g["h"] / 2
    r = math.radians(part.get("rotate", 0)); dx, dy = px - cx, py - cy
    return (part["left"] + cx + dx * math.cos(r) - dy * math.sin(r), part["top"] + cy + dx * math.sin(r) + dy * math.cos(r))

def box(part):
    """boîte englobante (x, y, w, h) avec la rotation"""
    g = GEOM[part["type"]]; rot = part.get("rotate", 0) % 180
    bw, bh = (g["h"], g["w"]) if rot == 90 else (g["w"], g["h"])
    cx, cy = part["left"] + g["w"] / 2, part["top"] + g["h"] / 2
    return (cx - bw / 2, cy - bh / 2, bw, bh)

# ---------- réseaux ----------
class Nets:
    def __init__(self): self.p = {}
    def find(self, x):
        self.p.setdefault(x, x)
        while self.p[x] != x: self.p[x] = self.p[self.p[x]]; x = self.p[x]
        return x
    def union(self, a, b): self.p[self.find(a)] = self.find(b)

def analyse(d):
    """éléments logiques, réseaux nommés, ports ; d est le diagram.json (déjà élagué ou non)"""
    parts = {p["id"]: p for p in d["parts"]}
    nets = Nets()
    for c in d["connections"]:
        if c[0].split(":")[0] in parts and c[1].split(":")[0] in parts: nets.union(c[0], c[1])
    members = defaultdict(set)
    for pin in list(nets.p): members[nets.find(pin)].add(pin)
    has_tt = any(p["type"] in (TT_IN, TT_OUT, TT_IO) for p in d["parts"])
    def role(pin):
        """(genre, nom) d'une broche : 'src' (pilote), 'load' (charge), 'logic_in', 'logic_out', None (ignorée)"""
        pid, pn = pin.split(":", 1); p = parts[pid]; t = p["type"]
        if t in LOGIC:
            return ("logic_out", f"{pid}.{pn.lower()}") if pn in LOGIC[t][2] else ("logic_in", None)
        if t == "wokwi-vcc": return ("src", "1")
        if t == "wokwi-gnd": return ("src", "0")
        port = tt_port(p, pn)
        if port:
            return ("load", port) if port.startswith(("uo_out", "uio_out", "uio_oe")) else ("src", port)
        if not has_tt:
            if t in OLD_IN: return ("src", f"in[{pid}:{pn}]")
            if t in OLD_OUT: return ("load", f"out[{pid}:{pn}]")
        return (None, None)
    name, drivers, loads, alias, pin_set, pout_set = {}, {}, {}, {}, set(), set()
    for r, pins in members.items():
        srcs = [role(p) for p in sorted(pins)]
        n = next((nm for k, nm in srcs if k == "src" and nm in ("1", "0")), None) \
            or next((nm for k, nm in srcs if k == "src"), None) \
            or next((nm for k, nm in srcs if k == "logic_out"), None) \
            or next((nm for k, nm in srcs if k == "load"), None) or "n_" + re.sub(r"\W", "_", r)
        name[r] = n
        drivers[n] = sorted(p for p in pins if role(p)[0] in ("src", "logic_out"))
        loads[n] = sorted(p for p in pins if role(p)[0] in ("load", "logic_in"))
        al = sorted({nm for k, nm in srcs if k in ("src", "load") and nm not in ("1", "0") and nm != n})
        if al: alias[n] = al
        if any(k == "logic_in" or k == "load" for k, _ in srcs): pin_set |= {nm for k, nm in srcs if k == "src" and nm not in ("1", "0")}
        if any(k == "logic_out" or k == "src" for k, _ in srcs): pout_set |= {nm for k, nm in srcs if k == "load"}
    elems = []
    for p in d["parts"]:
        t = p["type"]
        if t not in LOGIC: continue
        kind, ins, outs = LOGIC[t]
        e = {"id": p["id"], "k": kind, "i": {}, "o": {}}
        for pn in ins:
            key = f"{p['id']}:{pn}"
            if key in nets.p: e["i"][pn] = name[nets.find(key)]
        for pn in outs:
            key = f"{p['id']}:{pn}"
            if key in nets.p: e["o"][pn] = name[nets.find(key)]
        elems.append(e)
    by_out = {n: e for e in elems for n in e["o"].values()}
    depth = {}
    def dep(e, stack=()):
        if e["id"] in depth: return depth[e["id"]]
        if e["k"].endswith("FF") or e["id"] in stack: depth[e["id"]] = 0 if e["k"].endswith("FF") else 1; return depth[e["id"]]
        best = max((dep(by_out[n], stack + (e["id"],)) for n in e["i"].values() if n in by_out), default=0)
        depth[e["id"]] = best + 1; return best + 1
    for e in elems: e["d"] = dep(e)
    ports_in, ports_out = sorted(pin_set), sorted(pout_set)
    # un élément est mort si aucune de ses sorties n'alimente une entrée logique ou un port de sortie
    dead = [e["id"] for e in elems if not any(loads.get(n) for n in e["o"].values())]
    return {"elems": elems, "name": name, "drivers": drivers, "loads": loads, "nets": nets, "parts": parts, "alias": alias,
            "in": ports_in, "out": ports_out, "dead": dead, "has_tt": has_tt}

def prune(d):
    """retire les composants sans fil et la logique dont la sortie ne va nulle part, jusqu'à stabilité ; renvoie les ids retirés"""
    removed = []
    while True:
        a = analyse(d)
        linked = {pin.split(":")[0] for c in d["connections"] for pin in c[:2]}
        dead = set(a["dead"]) | {p["id"] for p in d["parts"] if p["id"] not in linked and p["type"] != "wokwi-text"}
        if not dead: return removed
        removed += sorted(dead)
        d["parts"] = [p for p in d["parts"] if p["id"] not in dead]
        d["connections"] = [c for c in d["connections"] if c[0].split(":")[0] not in dead and c[1].split(":")[0] not in dead]

def reading(a, counts, removed, lang="fr"):
    elems = a["elems"]; fr = lang == "fr"
    L = FR if fr else EN
    ph = []
    n = len(elems)
    ph.append((f"{n} éléments logiques : " if fr else f"{n} logic elements: ") + ", ".join(f"{v} × {L[k]}" for k, v in counts.most_common()) + ".")
    ph.append(f"{len(a['in'])} entrée(s) de la puce utilisée(s), {len(a['out'])} sortie(s) pilotée(s)." if fr else f"{len(a['in'])} chip input(s) used, {len(a['out'])} output(s) driven.")
    nff = sum(v for k, v in counts.items() if k.endswith("FF"))
    if nff: ph.append((f"Circuit séquentiel : {nff} bascule(s) mémorisent un état." if fr else f"Sequential circuit: {nff} flip-flop(s) hold a state."))
    else: ph.append("Circuit purement combinatoire : aucune bascule, la sortie ne dépend que des entrées." if fr else "Purely combinational circuit: no flip-flop, outputs depend only on inputs.")
    mx = max((e["d"] for e in elems), default=0)
    if mx: ph.append(f"Profondeur logique maximale : {mx} porte(s) entre une entrée et une sortie." if fr else f"Maximum logic depth: {mx} gate(s) between an input and an output.")
    sel = Counter(e["i"].get("SEL") for e in elems if e["k"] == "MUX2")
    for s, c in sel.items():
        if s and c >= 2: ph.append(f"{c} multiplexeurs partagent la sélection {s} : un bus {c} bits commuté par ce signal." if fr else f"{c} multiplexers share select {s}: a {c}-bit bus switched by that signal.")
    clk = Counter(e["i"].get("CLK") for e in elems if e["k"].endswith("FF"))
    for s, c in clk.items():
        if s and s != "clk" and c >= 1: ph.append(f"{c} bascule(s) cadencée(s) par {s} plutôt que par l'horloge de la puce." if fr else f"{c} flip-flop(s) clocked by {s} rather than the chip clock.")
    chain = sum(1 for e in elems if e["k"].endswith("FF") and e["i"].get("D", "") and e["i"]["D"].endswith(".q") and e["i"]["D"].split(".")[0] in {x["id"] for x in elems if x["k"].endswith("FF")})
    if chain >= 2: ph.append(f"{chain} bascules en chaîne (Q → D) : un registre à décalage ou un compteur." if fr else f"{chain} chained flip-flops (Q → D): a shift register or a counter.")
    if removed: ph.append(("Retirés car absents de la puce (sans fil, ou sortie dans le vide) : " if fr else "Removed, absent from the chip (unwired, or output going nowhere): ") + ", ".join(removed) + ".")
    return ph

# ---------- routeur orthogonal ----------
STEP = 4.8; BEND = 4; CROSS = 6; OVERLAP = 40; NEAR = 1; SOFT = 8
DIRS = ((1, 0), (-1, 0), (0, 1), (0, -1))
class Router:
    def __init__(self, x0, y0, x1, y1):
        self.x0, self.y0 = x0, y0; self.w = int((x1 - x0) / STEP) + 2; self.h = int((y1 - y0) / STEP) + 2
        self.block, self.near, self.soft, self.occ, self.pins, self.corridor = set(), set(), set(), {}, {}, set()
    def cell(self, x, y): return (int(round((x - self.x0) / STEP)), int(round((y - self.y0) / STEP)))
    def xy(self, c): return (self.x0 + c[0] * STEP, self.y0 + c[1] * STEP)
    def add_box(self, x, y, w, h, margin=STEP, soft=False):
        ca, cb = self.cell(x + 0.1, y + 0.1), self.cell(x + w - 0.1, y + h - 0.1)
        for i in range(ca[0], cb[0] + 1):
            for j in range(ca[1], cb[1] + 1): (self.soft if soft else self.block).add((i, j))
        if soft: return
        ma, mb = self.cell(x - margin, y - margin), self.cell(x + w + margin, y + h + margin)
        for i in range(ma[0], mb[0] + 1):
            for j in range(ma[1], mb[1] + 1): self.near.add((i, j))
    def add_pin(self, x, y, net):
        c = self.cell(x, y); self.block.discard(c); self.pins[c] = net
        best = None   # broche à l'intérieur d'un boîtier : couloir droit vers l'extérieur le plus proche
        for dx, dy in DIRS:
            n, k = (c[0] + dx, c[1] + dy), 1
            while n in self.block and k < 40: n = (n[0] + dx, n[1] + dy); k += 1
            if n not in self.block and (best is None or k < best[0]): best = (k, dx, dy)
        if best and best[0] > 1:
            k, dx, dy = best; n = c
            for _ in range(k): n = (n[0] + dx, n[1] + dy); self.block.discard(n); self.corridor.add(n)
    def route(self, p0, p1, net):
        s, g = self.cell(*p0), self.cell(*p1); self.block.discard(s); self.block.discard(g)
        best, came, pq, found = {}, {}, [(0, 0, s, None, None)], None
        while pq:
            f, cost, c, d, prev = heapq.heappop(pq)
            key = (c, d)
            if key in best: continue
            best[key] = cost; came[key] = prev
            if c == g: found = key; break
            if len(best) > 400000: return None
            for nd in DIRS:
                n = (c[0] + nd[0], c[1] + nd[1])
                if not (0 <= n[0] < self.w and 0 <= n[1] < self.h): continue
                if n in self.block and n != g: continue
                if n in self.pins and self.pins[n] != net and n != g: continue
                if n in self.corridor and n not in (g, s) and not (n[0] == g[0] or n[1] == g[1] or n[0] == s[0] or n[1] == s[1]): continue
                step = 1 + (BEND if d is not None and nd != d else 0) + (NEAR if n in self.near else 0) + (SOFT if n in self.soft else 0)
                axis = 0 if nd[0] else 1
                for onet, oaxis in self.occ.get(n, ()):
                    if onet == net: step -= 0.9 if oaxis == axis else 0
                    elif oaxis == axis: step += OVERLAP
                    else: step += CROSS
                nc = cost + max(step, 0.1)
                heapq.heappush(pq, (nc + abs(n[0] - g[0]) + abs(n[1] - g[1]), nc, n, nd, key))
        if found is None: return None
        cells, k = [], found
        while k is not None: cells.append(k[0]); k = came[k]
        cells.reverse()
        for a, b in zip(cells, cells[1:]):
            axis = 0 if a[1] == b[1] else 1
            self.occ.setdefault(a, set()).add((net, axis)); self.occ.setdefault(b, set()).add((net, axis))
        pts = [cells[0]] + [b for a, b, c in zip(cells, cells[1:], cells[2:]) if (b[0] - a[0], b[1] - a[1]) != (c[0] - b[0], c[1] - b[1])] + [cells[-1]]
        return [self.xy(c) for c in pts]

# ---------- rendu SVG ----------
def sym_svg(g):
    s, w, h = g["sym"], g["w"], g["h"]
    if s in ("AND", "NAND"): return '<path class="body" d="M6,3 H26 A16.2,16.2 0 0 1 26,35.4 H6 Z"/><path class="xl" d="M0,9.6H6 M0,28.8H6 M42.4,19.2H48"/>'
    if s in ("OR", "NOR", "XOR", "XNOR"):
        b = '<path class="body" d="M6,3 Q18,19.2 6,35.4 Q28,35.4 43,19.2 Q28,3 6,3 Z"/><path class="xl" d="M0,9.6H9 M0,28.8H9 M43,19.2H48"/>'
        return b + ('<path class="xl" d="M2,3 Q14,19.2 2,35.4"/>' if s in ("XOR", "XNOR") else "")
    if s in ("NOT", "BUF"): return '<path class="body" d="M6,4 L38,19.2 L6,34.4 Z"/><path class="xl" d="M0,19.2H6 M38,19.2H48"/>'
    if s == "MUX2": return '<path class="body" d="M8,6 L40,17 L40,40.6 L8,51.6 Z"/><path class="xl" d="M0,19.2H8 M0,38.4H8 M40,28.8H48 M24,46V57.6"/><text class="lbl" x="15" y="23">0</text><text class="lbl" x="15" y="42">1</text>'
    if s in ("DFF", "TFF"):
        a = "D" if s == "DFF" else "T"
        return f'<rect class="body" x="8" y="6" width="{w-16}" height="{h-12}"/><path class="xl" d="M0,19.2H8 M0,38.4H8 M{w-8},19.2H{w} M{w-8},38.4H{w} M8,33 L14,38.4 L8,43.8"/><text class="lbl" x="18" y="23">{a}</text><text class="lbl" x="{w-18}" y="23">Q</text><text class="lbl" x="{w-18}" y="42" text-decoration="overline">Q</text>'
    if s == "DFFR":
        return f'<rect class="body" x="8" y="8" width="{w-16}" height="{h-16}"/><path class="xl" d="M0,28.8H8 M0,48H8 M{w-8},28.8H{w} M{w-8},48H{w} M8,42.6 L14,48 L8,53.4 M28.8,0V8 M28.8,{h-8}V{h}"/><text class="lbl" x="18" y="32.5">D</text><text class="lbl" x="{w-18}" y="32.5">Q</text><text class="lbl" x="{w-18}" y="51.5" text-decoration="overline">Q</text><text class="lbl" x="28.8" y="17">S</text><text class="lbl" x="28.8" y="{h-11}">R</text>'
    if s in ("JKFF", "SRFF"):
        a, b = ("J", "K") if s == "JKFF" else ("S", "R")
        return f'<rect class="body" x="8" y="6" width="{w-16}" height="{h-12}"/><path class="xl" d="M0,19.2H8 M0,38.4H8 M0,57.6H8 M{w-8},28.8H{w} M{w-8},48H{w} M8,33 L14,38.4 L8,43.8"/><text class="lbl" x="18" y="23">{a}</text><text class="lbl" x="18" y="61">{b}</text><text class="lbl" x="{w-18}" y="32.5">Q</text><text class="lbl" x="{w-18}" y="51.5" text-decoration="overline">Q</text>'
    if s == "JCT": return '<circle class="dot" cx="2.4" cy="2.4" r="2.6"/>'
    if s == "TTIN":
        return f'<rect class="port" x="0" y="0" width="{w}" height="{h}" rx="3"/><text class="ptitle" x="{w/2}" y="9">ENTRÉES</text>' + "".join(
            f'<path class="xl" d="M{w-8},{y}H{w}"/><text class="pl" x="{w-11}" y="{y+3.2}" text-anchor="end">{n}</text>' for n, y in [(f"ui_in[{k}]", 14.4 + 9.6 * k) for k in range(8)] + [("clk", 100.8), ("rst_n", 110.4)])
    if s == "TTOUT":
        return f'<rect class="port" x="0" y="0" width="{w}" height="{h}" rx="3"/><text class="ptitle" x="{w/2}" y="9">SORTIES</text>' + "".join(
            f'<path class="xl" d="M0,{y}H8"/><text class="pl" x="11" y="{y+3.2}">uo_out[{k}]</text>' for k, y in [(k, 14.4 + 9.6 * k) for k in range(8)])
    if s == "TTIO": return f'<rect class="port" x="8" y="0" width="{w-8}" height="{h}" rx="3"/><path class="xl" d="M0,9.6H8 M0,19.2H8 M0,28.8H8"/><text class="pl" x="11" y="12.8">out</text><text class="pl" x="11" y="22.4">in</text><text class="pl" x="11" y="32">oe</text>'
    if s == "DIP": return f'<rect class="part" x="0" y="6" width="{w}" height="{h-12}" rx="2"/>' + "".join(f'<rect class="sw" x="{4.5+9.6*i}" y="16" width="7" height="24" rx="1"/>' for i in range(8))
    if s == "BAR": return f'<rect class="part" x="0" y="0" width="{w}" height="{h}" rx="1"/>' + "".join(f'<rect class="led" x="11" y="{2+9.6*i}" width="15" height="6"/>' for i in range(10))
    if s == "SEG": return f'<rect class="part" x="0" y="0" width="{w}" height="{h}" rx="2"/><text class="lbl" x="{w/2}" y="{h/2+4}">8</text>'
    if s == "LED": return '<circle class="led" cx="9.6" cy="12" r="8"/><path class="xl" d="M4.8,20V38.4 M14.4,20V38.4"/>'
    if s == "SW": return f'<rect class="part" x="0" y="0" width="{w}" height="{h-9.6}" rx="2"/><path class="xl" d="M9.6,19.2V28.8 M24,19.2V28.8 M38.4,19.2V28.8"/>'
    if s == "BTN": return f'<rect class="part" x="8" y="4" width="{w-16}" height="{h-8}" rx="4"/><circle class="sw" cx="24" cy="24" r="10"/>'
    if s == "CLKGEN": return f'<rect class="body" x="0" y="4" width="{w-8}" height="30"/><path class="xl" d="M8,27 H16 V12 H24 V27 H32 V12 H40 V27 M{w-8},19.2H{w}"/>'
    if s == "RES": return f'<rect class="body" x="10" y="2" width="{w-20}" height="{h-4}" rx="1.5"/><path class="xl" d="M0,5.65H10 M{w-10},5.65H{w}"/>'
    return f'<rect class="body" x="0" y="0" width="{w}" height="{h}"/>'

WIRE_COLORS = {"green": "#3fbf5f", "red": "#e05a5a", "black": "#8a97a6", "blue": "#4f8fe6", "yellow": "#e0c36a", "orange": "#e8903a",
               "white": "#e8eef4", "purple": "#b57aff", "gray": "#9aa5b1", "grey": "#9aa5b1", "limegreen": "#8be36a", "gold": "#d9b24a",
               "cyan": "#5ad6e6", "magenta": "#e05ab8", "brown": "#a8744a", "violet": "#b57aff", "pink": "#e58ab8"}
CSS = """<style>
.body{fill:#17222f;stroke:#9fb3c8;stroke-width:2;stroke-linejoin:round}.part{fill:#263241;stroke:#9fb3c8;stroke-width:1.2}
.port{fill:#101a26;stroke:#5f7a94;stroke-width:1.5;stroke-dasharray:4 3}.ptitle{font:600 8px ui-monospace,monospace;fill:#7f93a8;text-anchor:middle;letter-spacing:.1em}
.pl{font:9px ui-monospace,monospace;fill:#e0c36a}.sw{fill:#0e141b;stroke:#55687c;stroke-width:.8}.led{fill:#8be36a;opacity:.85}
.xl{fill:none;stroke:#9fb3c8;stroke-width:2;stroke-linecap:round}.bubble{fill:#17222f;stroke:#9fb3c8;stroke-width:2}
.wire{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}.pw{stroke-width:1.8}
.lbl{font:10px ui-monospace,monospace;fill:#9fb3c8;text-anchor:middle}.name{font:7.5px ui-monospace,monospace;fill:#7f97b0;text-anchor:middle;pointer-events:none}
.note{font:italic 10px ui-sans-serif,system-ui,sans-serif;fill:#8fa3b8}.dot{fill:#9fb3c8}
.g{cursor:pointer}.g.hot .body,.g.hot .xl,.g.hot .bubble{stroke:#ffd166;stroke-width:3;filter:drop-shadow(0 0 6px #ffd166)}
.g.fam .body,.g.fam .xl{stroke:#ffd166}
.wire.hot{stroke:#ffd166;stroke-width:3.5}.wire.dim,.p.dim{opacity:.22}
.wire.v1{stroke:#7dff9a}.wire.v0{stroke:#ff5a5a;opacity:.7}
</style>"""

def render_svg(d, a):
    parts = a["parts"]; nets = a["nets"]; name = a["name"]
    INSIDE = set(LOGIC) | {TT_IN, TT_OUT, TT_IO, "wokwi-junction", "wokwi-text"}
    drawn = [p for p in d["parts"] if p["type"] in GEOM and p["type"] not in POWER and (not a["has_tt"] or p["type"] in INSIDE)]
    if not drawn: return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>'
    xs, ys = [], []
    for p in drawn:
        if p["type"] == "wokwi-text": xs += [p["left"], p["left"] + 7 * len(str((p.get("attrs") or {}).get("text", "")))]; ys += [p["top"], p["top"] + 14]; continue
        x, y, w, h = box(p); xs += [x, x + w]; ys += [y, y + h]
    x0, y0, x1, y1 = min(xs) - 40, min(ys) - 40, max(xs) + 40, max(ys) + 40
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0:.0f} {y0:.0f} {x1-x0:.0f} {y1-y0:.0f}">', CSS]
    rt = Router(x0, y0, x1, y1)
    for p in drawn:
        if p["type"] == "wokwi-text": continue
        x, y, w, h = box(p); rt.add_box(x, y, w, h)
        if p["type"] not in LOGIC and GEOM[p["type"]]["sym"] not in ("JCT", "TTIN", "TTOUT"): rt.add_box(x + w / 2 - 22, y + h + 4, 44, 10, soft=True)   # étiquette
    def outward(part, pn):
        g = GEOM[part["type"]]; pos = pin_abs(part, pn); x, y, w, h = box(part)
        dx, dy = pos[0] - (x + w / 2), pos[1] - (y + h / 2)
        if g["sym"] in ("DIP", "BAR", "SEG", "TTIN", "TTOUT"):
            return min([(w / 2 - abs(dx), (1 if dx > 0 else -1, 0)), (h / 2 - abs(dy), (0, 1 if dy > 0 else -1))])[1]
        return (1 if dx > 0 else -1, 0) if abs(dx) >= abs(dy) else (0, 1 if dy > 0 else -1)
    marks, conns = [], []
    for c in d["connections"]:
        (a_id, a_pn), (b_id, b_pn) = c[0].split(":", 1), c[1].split(":", 1)
        if a_id not in parts or b_id not in parts: continue
        ta, tb = parts[a_id]["type"], parts[b_id]["type"]
        if ta not in GEOM or tb not in GEOM: continue
        # fils hors de la puce (côté EXT des blocs Tiny Tapeout, banc d'essai) : non dessinés
        if a["has_tt"] and (ta not in LOGIC and ta not in POWER and ta not in (TT_IN, TT_OUT, TT_IO, "wokwi-junction")): continue
        if a["has_tt"] and (tb not in LOGIC and tb not in POWER and tb not in (TT_IN, TT_OUT, TT_IO, "wokwi-junction")): continue
        if (ta == TT_IN and a_pn.startswith("EXT")) or (tb == TT_IN and b_pn.startswith("EXT")): continue
        if (ta == TT_OUT and a_pn.startswith("EXT")) or (tb == TT_OUT and b_pn.startswith("EXT")): continue
        if (ta == TT_IO and a_pn == "UIO") or (tb == TT_IO and b_pn == "UIO"): continue
        nm = name.get(nets.find(c[0]), "")
        if ta in POWER or tb in POWER:
            if ta in POWER and tb in POWER: continue
            pid, pn, kind = (b_id, b_pn, POWER[ta]) if ta in POWER else (a_id, a_pn, POWER[tb])
            pos = pin_abs(parts[pid], pn)
            if pos: marks.append((pos[0], pos[1], *outward(parts[pid], pn), kind, nm))
            continue
        p0, p1 = pin_abs(parts[a_id], a_pn), pin_abs(parts[b_id], b_pn)
        if p0 is None or p1 is None: continue
        root = nets.find(c[0]); rt.add_pin(*p0, root); rt.add_pin(*p1, root)
        conns.append((abs(p0[0] - p1[0]) + abs(p0[1] - p1[1]), c, p0, p1, root, nm))
    for x, y, dx, dy, kind, nm in marks:
        stub = 14
        if kind == "GND" and dy == 0 and any(k2 == "VCC" and dx2 == dx and abs(x2 - x) < 2 and 0 < y2 - y < 30 for x2, y2, dx2, dy2, k2, _ in marks): stub = 31
        ex, ey = x + dx * stub, y + dy * stub
        dd = f"M{x:.1f},{y:.1f} L{ex:.1f},{ey:.1f}"
        if kind == "VCC":
            dd += f" M{ex:.1f},{ey:.1f} V{ey-12:.1f} M{ex-6:.1f},{ey-12:.1f} H{ex+6:.1f} M{ex:.1f},{ey-12:.1f} L{ex-4:.1f},{ey-5:.1f} M{ex:.1f},{ey-12:.1f} L{ex+4:.1f},{ey-5:.1f}"
            rt.add_box(ex - 7, ey - 13, 14, 14, margin=2.4)
        else:
            dd += f" M{ex:.1f},{ey:.1f} V{ey+8:.1f} M{ex-8:.1f},{ey+8:.1f} H{ex+8:.1f} M{ex-5:.1f},{ey+12:.1f} H{ex+5:.1f} M{ex-2:.1f},{ey+16:.1f} H{ex+2:.1f}"
            rt.add_box(ex - 9, ey, 18, 17, margin=2.4)
        out.append(f'<path class="wire pw" data-net="{nm}" stroke="{"#e05a5a" if kind == "VCC" else "#8a97a6"}" d="{dd}"/>')
    conns.sort(key=lambda t: t[0])
    junctions = []
    for _, c, p0, p1, root, nm in conns:
        col = WIRE_COLORS.get(c[2], c[2] if str(c[2]).startswith("#") else "#3fbf5f")
        before = {cell for cell, o in rt.occ.items() if any(n == root for n, _ in o)}
        pts = rt.route(p0, p1, root)
        if pts is None: dd = f"M{p0[0]:.1f},{p0[1]:.1f} L{p1[0]:.1f},{p1[1]:.1f}"
        else:
            dd = f"M{p0[0]:.1f},{p0[1]:.1f} " + " ".join(f"L{x:.1f},{y:.1f}" for x, y in pts) + f" L{p1[0]:.1f},{p1[1]:.1f}"
            inner = [cl for cl in [rt.cell(x, y) for x, y in pts][1:-1] if cl in before]
            for cl in inner[:1] + inner[-1:]: junctions.append(rt.xy(cl))
        out.append(f'<path class="wire" data-net="{nm}" stroke="{col}" d="{dd}"/>')
    for jx, jy in junctions: out.append(f'<circle class="dot" cx="{jx:.1f}" cy="{jy:.1f}" r="2.6"/>')
    for p in drawn:
        g = GEOM[p["type"]]
        if p["type"] == "wokwi-text":
            txt = str((p.get("attrs") or {}).get("text", "")).replace("&", "&amp;").replace("<", "&lt;")
            out.append(f'<text class="note" x="{p["left"]:.1f}" y="{p["top"] + 10:.1f}">{txt}</text>'); continue
        rot = p.get("rotate", 0)
        tr = f'translate({p["left"]:.1f},{p["top"]:.1f})' + (f' rotate({rot},{g["w"]/2:.1f},{g["h"]/2:.1f})' if rot else "")
        if p["type"] in LOGIC: out.append(f'<g class="g p" data-id="{p["id"]}" data-k="{LOGIC[p["type"]][0]}" transform="{tr}">')
        else: out.append(f'<g class="p" data-id="{p["id"]}" transform="{tr}">')
        out.append(sym_svg(g))
        if g["sym"] in ("NAND", "NOR", "XNOR", "NOT"): out.append('<circle class="bubble" cx="45" cy="19.2" r="3"/>')
        out.append("</g>")
        x, y, w, h = box(p)
        if p["type"] in LOGIC:   # nom dans le symbole (les portes sont souvent empilées au pas de 38,4 px : pas de place dessous)
            cx, cy = x + w / 2 + (-3 if g["sym"] in ("AND", "NAND", "NOT", "BUF") else -1), y + h / 2
            if g["sym"] in ("DFF", "TFF", "DFFR", "JKFF", "SRFF"): cy = y + h - 12
            elif g["sym"] == "MUX2": cx, cy = x + 26, y + 32
            out.append(f'<text class="name" x="{cx:.1f}" y="{cy + 3:.1f}">{p["id"]}</text>')
        elif p["type"] == TT_IO: out.append(f'<text class="name" x="{x + w/2:.1f}" y="{y + h + 11:.1f}">uio[{(p.get("attrs") or {}).get("verilogBit", "?")}]</text>')
        elif g["sym"] not in ("JCT", "TTIN", "TTOUT"): out.append(f'<text class="name" x="{x + w/2:.1f}" y="{y + h + 11:.1f}">{p["id"]}</text>')
    out.append("</svg>")
    return "\n".join(out)

# ---------- fiche complète pour le jeu ----------
def build(diagram, lang="fr"):
    """diagram : dict (diagram.json). Renvoie (dict « wokwi » de la fiche, analyse) ; le diagramme est élagué sur place."""
    removed = prune(diagram)
    a = analyse(diagram)
    counts = Counter(e["k"] for e in a["elems"])
    svg = render_svg(diagram, a)
    W = {"author": diagram.get("author", ""), "elems": a["elems"], "in": a["in"], "out": a["out"], "alias": a["alias"], "counts": dict(counts),
         "removed": removed, "reading": reading(a, counts, removed, "fr"), "reading_en": reading(a, counts, removed, "en"),
         "svg": svg, "fr": {k: FR[k] for k in counts}, "en": {k: EN[k] for k in counts}}
    return W, a

if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    d = json.load(open(src, encoding="utf-8"))
    W, a = build(d)
    open(dst, "w", encoding="utf-8").write(W["svg"])
    if len(sys.argv) > 3: json.dump({k: v for k, v in W.items() if k != "svg"}, open(sys.argv[3], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{len(a['elems'])} éléments, {len(a['name'])} réseaux ; retirés : {', '.join(W['removed']) or 'aucun'}")
    for ph in W["reading"]: print(" -", ph)
