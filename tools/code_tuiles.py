#!/usr/bin/env python3
"""Fiches « code » des tuiles : relie chaque cellule logique de la puce à son module et à son code source.

  python code_tuiles.py [--shuttles all|ttsky25b,tt06] [--out cartes/maps4] [--work travail] [--only tt_um_kercrafter_leds_racer] [--force] [--jobs 4]

Pour chaque projet d'une navette Tiny Tapeout, à partir du dépôt de la navette (déjà cloné par cda_maps.py, sinon cloné ici) :
  <macro>.oas      le dessin : nom et position de chaque cellule (propriété 61)
  <macro>.v        la liste des connexions après placement : type et fils de chaque cellule ; les fils des bascules
                   portent le nom de la variable du code, avec tout le chemin des modules
  info.yaml        langage, module principal, fichiers sources (ou numéro Wokwi)
  commit_id.json   dépôt GitHub et commit fabriqué
et des sources du projet, prises au commit fabriqué (clone partiel, seuls les fichiers listés sont téléchargés).

Écrit <out>/<navette>/<tuile>.code.json :
  { v, macro, lang, repo, commit, url, top, files: {chemin: texte}, mods: [...], sigs: [...], cells: {x, y, m, s} }
  mods[i] = { p: chemin d'instances, t: type de module, n: nom affiché, i: [fichier, ligne] de l'instanciation,
              d: [fichier, ligne] de la définition, c: nombre de cellules }
  sigs[j] = { n: nom de la variable (avec [bit]), m: module, d: [fichier, ligne] de la déclaration }
  cells   = positions (unités de grille de la carte, coin bas-gauche) des cellules logiques et leur module (m) / signal (s, -1 sinon)
Bibliothèques SKY130, IHP (sg13g2) et GF180MCU. Seuls les projets en Verilog (une ou deux tuiles) sont traités pour l'instant ; Wokwi et analogique : voir les notes en fin de fichier.
Dépendances : Python 3.9+, git, et  pip install gdstk pyyaml
"""
import argparse, collections, json, os, re, subprocess, sys, urllib.request

GRID = 0.005   # µm par unité de grille, comme cda_maps.py
POWER = {"VGND", "VNB", "VPB", "VPWR", "VDD", "VSS"}
OUTPINS = {"X", "Y", "Q", "Q_N", "QN", "COUT", "SUM", "HI", "LO", "GCLK", "Z"}
SKIP = re.compile(r"(decap|fill|tap|conb|tie|antenna|endcap|diode)")
KW = {"if", "else", "for", "while", "case", "casez", "casex", "assign", "always", "always_ff", "always_comb", "always_latch", "initial",
      "module", "endmodule", "begin", "end", "function", "task", "return", "wire", "reg", "logic", "input", "output", "inout", "parameter",
      "localparam", "generate", "endgenerate", "genvar", "integer", "default", "posedge", "negedge", "or", "and", "not", "assert", "repeat"}

def log(*a): print(*a, flush=True)
# nom court d'une cellule, quelle que soit la bibliothèque : sky130_fd_sc_hd__nand2_1, sg13g2_nand2_1 (IHP),
# gf180mcu_fd_sc_mcu7t5v0__nand2_1 (GlobalFoundries) -> nand2_1
def cell_base(t): return re.sub(r"^(.*__|sg13g2_)", "", t)
GIT_ENV = dict(os.environ, GIT_TERMINAL_PROMPT="0", GCM_INTERACTIVE="never", GIT_ASKPASS="echo")   # jamais de fenêtre de connexion (dépôt supprimé ou privé)
def git(*args, cwd=None, binary=False, timeout=600):
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, env=GIT_ENV, timeout=timeout)
    if r.returncode: raise RuntimeError(r.stderr.decode(errors="replace").strip()[:300])
    return r.stdout if binary else r.stdout.decode(errors="replace")

# ---------- liste des connexions (Verilog après placement) ----------
def parse_gl(text):
    cells = {}
    for typ, name, body in re.findall(r"\n\s*([A-Za-z_]\w*)\s+(\\\S+\s|[A-Za-z_]\w*)\s*\((.*?)\);", text, re.S):
        if typ in ("module", "input", "output", "inout", "wire", "assign"): continue
        pins = {p: n.strip() for p, n in re.findall(r"\.(\w+)\(\s*([^()]*?)\s*\)", body) if p not in POWER}
        cells[name.strip()] = (typ, pins)
    return cells

def net_module(net):
    """« \\a.b.c.sig[3] » -> (« a.b.c », « sig[3] ») ; un fil sans chemin appartient au module principal"""
    n = net.lstrip("\\").strip()
    if n.startswith(("_", "net", "clknet", "clk", "rst")) and "." not in n: return None
    if "." not in n: return ("", n)
    path, sig = n.rsplit(".", 1)
    return (path, sig)

def ownership(cells):
    """module de chaque cellule : celui de son fil de sortie s'il est nommé, sinon celui des cellules qu'elle alimente
       (cône d'entrée des bascules), puis, pour le reste, celui des cellules qui l'alimentent"""
    drv, readers = {}, collections.defaultdict(list)
    for c, (t, pins) in cells.items():
        for p, n in pins.items():
            if not n or n.startswith("1'b"): continue
            if p in OUTPINS: drv[n] = c
            else: readers[n].append(c)
    own, sig = {}, {}
    for c, (t, pins) in cells.items():
        if SKIP.search(t): continue
        for p, n in pins.items():
            if p in OUTPINS and n.startswith("\\"):
                nm = net_module(n)
                if nm: own[c] = nm[0]; sig[c] = nm; break
    # remontée des cônes d'entrée (une porte appartient au module qu'elle sert)
    q = collections.deque(own)
    while q:
        c = q.popleft()
        for p, n in cells[c][1].items():
            if p in OUTPINS: continue
            d = drv.get(n)
            if d and d not in own and not SKIP.search(cells[d][0]): own[d] = own[c]; q.append(d)
    # reste (sorties vers les broches, etc.) : vers l'aval
    q = collections.deque(own)
    while q:
        c = q.popleft()
        for p, n in cells[c][1].items():
            if p not in OUTPINS: continue
            for r in readers.get(n, []):
                if r not in own and not SKIP.search(cells[r][0]): own[r] = own[c]; q.append(r)
    for c, (t, pins) in cells.items():
        if c in own or SKIP.search(t): continue
        if re.match(r"(clkbuf|clkinv|clkdlybuf)", t.split("__")[-1]) or any(n.startswith("clknet") for p, n in pins.items() if p in OUTPINS): own[c] = "#horloge"
        elif re.match(r"(input|output)\d+$", c): own[c] = "#es"
        else: own[c] = "#autre"
    return own, sig

# ---------- sources Verilog : modules, instanciations, déclarations ----------
def strip_comments(t):
    t = re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), t, flags=re.S)
    return re.sub(r"//[^\n]*", lambda m: " " * len(m.group(0)), t)

def index_sources(files):
    """modules[type] = { f, l (ligne de « module »), body: (début, fin), insts: {nom: (type, ligne)} }"""
    mods = {}
    for f, txt in files.items():
        s = strip_comments(txt)
        line_at = lambda pos: s.count("\n", 0, pos) + 1
        for m in re.finditer(r"\bmodule\s+(\w+)", s):
            end = s.find("endmodule", m.end()); end = len(s) if end < 0 else end
            body = s[m.end():end]
            # en-tête (ports) : jusqu'au premier « ; » après la liste des ports
            insts = {}
            for im in re.finditer(r"(?:^|[;\n])\s*(\w+)\s*(?:#\s*\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)\s*)?(\w+)\s*(?:\[[^\]]*\]\s*)?\(", body):
                typ, inst = im.group(1), im.group(2)
                if typ in KW or inst in KW: continue
                insts[inst] = (typ, line_at(m.end() + im.start(2)), m.end() + im.end())
            mods[m.group(1)] = {"f": f, "l": line_at(m.start()), "body": (m.end(), end), "insts": insts, "s": s}
    return mods

def resolve_path(mods, top, path):
    """« a.b.c » -> liste de (type, fichier, ligne d'instanciation) ; None si un maillon manque"""
    out, cur = [], top
    if not path: return out
    for part in path.split("."):
        name = re.sub(r"\[\d+\]$", "", part)   # bloc « generate » : nom sans l'indice
        M = mods.get(cur)
        if not M: return None
        hit = M["insts"].get(part) or M["insts"].get(name)
        if not hit:   # bloc generate nommé : on cherche l'instance plus loin dans le chemin
            out.append(("", M["f"], M["l"])); continue
        typ, ln = hit[0], hit[1]
        out.append((typ, M["f"], ln)); cur = typ
    return out

def decl_line(mods, mtype, sig):
    M = mods.get(mtype)
    if not M: return None
    name = re.sub(r"\[\d+\]$", "", sig).lstrip("\\")
    s, (a, b) = M["s"], M["body"]
    body = s[a:b]
    # la déclaration la plus proche du nom (une liste de ports est séparée par des virgules : on ne la traverse pas)
    m = re.search(r"\b(?:reg|wire|logic|output|input|inout|integer|bit)\b[^;,]*?\b" + re.escape(name) + r"\b", body)
    if not m: m = re.search(r"\b(?:reg|wire|logic|output|input|inout|integer|bit)\b[^;]*?\b" + re.escape(name) + r"\b", body)
    if not m: m = re.search(r"\b" + re.escape(name) + r"\b", body)
    if not m: return None
    return [M["f"], s.count("\n", 0, a + m.start()) + 1]

# ---------- où le code écrit une variable ----------
def _base(name): return re.sub(r"(\[[^\]]*\])+$", "", name.lstrip("\\").strip())

def writes_in(M, name):
    """lignes où la variable est affectée dans le corps du module (<=, =, assign), et l'en-tête du bloc always"""
    s, (a, b) = M["s"], M["body"]
    body, n = s[a:b], re.escape(_base(name))
    pat = re.compile(r"(?:^|\bbegin\b|\belse\b|[:;)])[ \t]*(?:assign\s+)?" + n + r"\s*(?:\[[^\]]*\]\s*)*(?:<=|=(?!=))", re.M)
    lines, first = [], None
    for m in pat.finditer(body):
        ls = body.rfind("\n", 0, m.start()) + 1; le = body.find("\n", m.end()); le = len(body) if le < 0 else le
        if re.match(r"\s*(reg|wire|logic|parameter|localparam|integer|input|output)\b", body[ls:le]): continue
        ln = s.count("\n", 0, a + m.start()) + 1 + (1 if body[m.start()] == "\n" else 0)
        if ln not in lines: lines.append(ln)
        if first is None: first = m.start()
    blk = None
    if first is not None:
        am = None
        for am in re.finditer(r"\b(always(?:_ff|_comb|_latch)?\b|assign\b)", body[:first + 1]): pass
        if am: blk = s.count("\n", 0, a + am.start()) + 1
    return lines, blk

def port_conn(M, inst_pos, port):
    """dans une instanciation (position juste après « nom ( »), l'expression branchée sur .port(…)"""
    s, depth, i = M["s"], 1, inst_pos
    while i < len(s) and depth:
        if s[i] == "(": depth += 1
        elif s[i] == ")": depth -= 1
        i += 1
    m = re.search(r"\.\s*" + re.escape(port) + r"\s*\(\s*([^()]*?)\s*\)", s[inst_pos:i])
    return m.group(1) if m else None

def find_writes(mods_src, top_mod, path, name, depth=0):
    """(chemin du module, fichier, [lignes], ligne du bloc) où la variable est vraiment écrite : dans son module, ou, si c'est
       un port, en remontant vers le module parent (entrée) ou en descendant vers l'instance qui la produit (sortie)"""
    if depth > 5: return None
    chain = resolve_path(mods_src, top_mod, path) if path else []
    if chain is None: return None
    mtype = (chain[-1][0] if chain else top_mod) or None
    M = mods_src.get(mtype) if mtype else None
    if not M: return None
    w, blk = writes_in(M, name)
    if w: return (path, M["f"], w, blk)
    base = _base(name)
    # sortie d'une instance de ce module : on descend
    for inst, (typ, ln, pos) in M["insts"].items():
        if typ not in mods_src: continue
        for pm in re.finditer(r"\.\s*(\w+)\s*\(\s*" + re.escape(base) + r"\b[^()]*\)", M["s"][pos:pos + 4000].split(");")[0]):
            r = find_writes(mods_src, top_mod, (path + "." if path else "") + inst, pm.group(1), depth + 1)
            if r: return r
    # entrée du module : on remonte chez le parent
    if path:
        parent, inst = path.rsplit(".", 1) if "." in path else ("", path)
        pch = resolve_path(mods_src, top_mod, parent) if parent else []
        ptype = (pch[-1][0] if pch else top_mod) if pch is not None else None
        PM = mods_src.get(ptype) if ptype else None
        hit = PM and (PM["insts"].get(inst) or PM["insts"].get(re.sub(r"\[\d+\]$", "", inst)))
        if hit:
            e = port_conn(PM, hit[2], base)
            idm = e and re.match(r"\s*([A-Za-z_]\w*)", e)
            if idm: return find_writes(mods_src, top_mod, parent, idm.group(1), depth + 1)
    return None

def comb_context(cells, sig):
    """pour chaque cellule : la variable qu'elle aide à calculer (la bascule ou le fil nommé le plus proche en aval) et les
       variables qu'elle lit (fils nommés les plus proches en amont)"""
    drv, readers = {}, collections.defaultdict(list)
    for c, (t, pins) in cells.items():
        for p, n in pins.items():
            if not n or n.startswith("1'b"): continue
            if p in OUTPINS: drv[n] = c
            else: readers[n].append(c)
    isff = lambda c: bool(re.search(r"__(df|dl|sdf|edf)", cells[c][0]))
    tgt, reads = {}, {}
    for c, (t, pins) in cells.items():
        if SKIP.search(t): continue
        if c not in sig or isff(c):
            # aval : première bascule (entrée D) ou premier fil nommé
            seen, fr, found = {c}, [n for p, n in pins.items() if p in OUTPINS], None
            for _ in range(10):
                nx = []
                for n in fr:
                    for r in readers.get(n, []):
                        if r in seen: continue
                        seen.add(r)
                        if r in sig: found = r; break
                        if not isff(r): nx += [m for p, m in cells[r][1].items() if p in OUTPINS]
                    if found: break
                if found or not nx or len(seen) > 300: break
                fr = nx
            if found and not isff(c): tgt[c] = sig[found]
        # amont : variables lues
        names, seen, fr = [], {c}, [n for p, n in pins.items() if p not in OUTPINS and p not in ("CLK",)]
        for _ in range(6):
            nx = []
            for n in fr:
                if n.startswith("\\"):
                    nm = net_module(n)
                    if nm and nm[1] not in names: names.append(nm[1])
                    continue
                d = drv.get(n)
                if not d or d in seen: continue
                seen.add(d)
                if d in sig:
                    if sig[d][1] not in names: names.append(sig[d][1])
                elif not isff(d): nx += [m for p, m in cells[d][1].items() if p not in OUTPINS]
            if not nx or len(names) >= 8 or len(seen) > 300: break
            fr = nx
        if names: reads[c] = names[:8]
    return tgt, reads

def simulation_netlist(gl_text, cells, code_idx):
    alias = {}
    for a, b in re.findall(r"\n\s*assign\s+(\S+(?:\s*\[\d+\])?)\s*=\s*(\S+?)\s*;", gl_text):
        alias[b.strip()] = a.replace(" ", "").strip()
    net_id, names = {}, {}
    def nid(n):
        n = n.strip()
        if n in alias: n = alias[n]
        if n not in net_id:
            net_id[n] = len(net_id)
            if not re.match(r"^(_\d+_|net\d+|clknet_\w+)$", n): names[net_id[n]] = n.lstrip("\\").strip()
        return net_id[n]
    types, tix, out, ci = [], {}, [], []
    for c, (t, pins) in cells.items():
        base = cell_base(t)
        if re.match(r"(decap|fill|tapvpwrvgnd|antenna|diode|endcap)", base): continue
        key = (base, tuple(sorted(pins)))
        if key not in tix: tix[key] = len(types); types.append({"t": base, "p": sorted(pins)})
        T = types[tix[key]]
        out.append([tix[key]] + [nid(pins[p]) if pins[p] and not pins[p].startswith("1'b") else (-2 if pins[p] == "1'b1" else -1) for p in T["p"]])
        ci.append(code_idx.get(c, -1))
    for port in ("clk", "rst_n", "ena") + tuple(f"{b}[{i}]" for b in ("ui_in", "uio_in", "uo_out", "uio_out", "uio_oe") for i in range(8)): nid(port)
    return {"types": types, "cells": out, "code": ci, "nets": len(net_id), "names": {str(k): v for k, v in names.items()}}

# ---------- un projet ----------
def analyze(layout_path, gl_text, info, commit, get_src, macro):
    import gdstk
    lib = gdstk.read_oas(layout_path) if layout_path.endswith(".oas") else gdstk.read_gds(layout_path)
    tops = [c for c in lib.top_level() if c.name == macro] or lib.top_level()
    top = max(tops, key=lambda c: len(c.references) + len(c.polygons))
    (bx0, by0), _ = top.bounding_box()
    ox, oy = round(bx0 / GRID), round(by0 / GRID)
    pos = {}
    for r in top.references:
        nm = r.get_gds_property(61)
        if isinstance(nm, bytes): nm = nm.decode(errors="replace")
        nm = (nm or "").strip().strip("\x00").strip()   # IHP : le nom finit par un octet nul
        if not nm: continue
        (ax, ay), _ = r.bounding_box()
        pos[nm.strip()] = (max(0, round(ax / GRID) - ox), max(0, round(ay / GRID) - oy))
    cells = parse_gl(gl_text)
    own, sig = ownership(cells)
    P = info.get("project", info)
    top_mod = P.get("top_module") or macro
    srcs = [s for s in (P.get("source_files") or []) if isinstance(s, str)]
    files, urls = {}, {}
    for s in srcs:
        r = get_src("src/" + s)
        if r is not None: files["src/" + s], urls["src/" + s] = r
    mods_src = index_sources({f: t for f, t in files.items() if f.endswith((".v", ".sv", ".vh", ".svh"))})
    # modules rencontrés
    paths = sorted(set(own.values()))
    mods, mid = [], {}
    for p in paths:
        if p.startswith("#"):
            nm = {"#horloge": "Arbre d'horloge", "#es": "Entrées / sorties", "#autre": "Logique de liaison"}[p]
            mods.append({"p": p, "t": "", "n": nm}); mid[p] = len(mods) - 1; continue
        chain = resolve_path(mods_src, top_mod, p) if mods_src else None
        last = p.split(".")[-1] if p else top_mod
        m = {"p": p or top_mod, "n": last, "t": ""}
        if chain:
            typ, f, ln = chain[-1] if chain else (top_mod, None, None)
            if typ: m["t"] = typ
            if f: m["i"] = [f, ln]
            D = mods_src.get(m["t"] or (top_mod if not p else ""))
            if D: m["d"] = [D["f"], D["l"]]
        elif not p and top_mod in mods_src: m["t"] = top_mod; m["d"] = [mods_src[top_mod]["f"], mods_src[top_mod]["l"]]
        mods.append(m); mid[p] = len(mods) - 1
    # variables mémorisées (bascules) : déclaration dans le module
    tgt, reads = comb_context(cells, sig)
    sigs, sid = [], {}
    def sig_id(key):
        if key in sid: return sid[key]
        path, s = key
        m = mods[mid[path]] if path in mid else None
        e = {"n": s, "m": mid.get(path, -1)}
        if mods_src:
            d = decl_line(mods_src, m["t"] if m and m["t"] else (top_mod if not path else ""), s)
            if d: e["d"] = d
            fw = find_writes(mods_src, top_mod, path, s)
            if fw:
                wp, f, w, blk = fw
                e["w"] = [[f, l] for l in w[:8]]
                if blk: e["b"] = [f, blk]
                if wp != path: e["wp"] = wp or top_mod
        sigs.append(e); sid[key] = len(sigs) - 1
        return sid[key]
    rd, rdi = [], {}
    X, Y, Mi, Si, Ti, Ri, cnt = [], [], [], [], [], [], collections.Counter()
    for c, p in own.items():
        if c not in pos: continue
        x, y = pos[c]; X.append(x); Y.append(y); Mi.append(mid[p]); cnt[mid[p]] += 1
        Si.append(sig_id(sig[c]) if c in sig else -1)
        Ti.append(sig_id(tgt[c]) if c in tgt else -1)
        r = tuple(reads.get(c, ()))
        if r and r not in rdi: rdi[r] = len(rd); rd.append(list(r))
        Ri.append(rdi[r] if r else -1)
    for k, m in enumerate(mods): m["c"] = cnt[k]
    # liste des connexions pour la simulation en jeu (banc de test, oscilloscope) : toutes les cellules actives, y compris
    # les constantes (conb) ; fils numérotés, noms gardés pour les fils nommés et les broches
    sim = simulation_netlist(gl_text, cells, {c: k for k, c in enumerate(c for c in own if c in pos)})

    used = {m[k][0] for m in mods for k in ("i", "d") if k in m} | {s["d"][0] for s in sigs if "d" in s} | {w[0] for s in sigs for w in s.get("w", [])}
    return {"v": 2, "macro": macro, "lang": P.get("language", ""), "repo": commit.get("repo", ""), "commit": commit.get("commit", ""), "top": top_mod,
            "files": {f: t for f, t in files.items() if f in used}, "urls": {f: u for f, u in urls.items() if f in used}, "mods": mods, "sigs": sigs, "rd": rd, "sim": sim, "pinout": {k: v for k, v in (info.get("pinout") or {}).items() if v}, "cells": {"x": X, "y": Y, "m": Mi, "s": Si, "t": Ti, "r": Ri}}

# ---------- navettes ----------
def fetch_json(url):
    with urllib.request.urlopen(url, timeout=60) as r: return json.loads(r.read())

def gh_https(url):
    url = url.strip()
    m = re.match(r"git@github\.com:(.+?)(?:\.git)?$", url)
    return ("https://github.com/" + m.group(1)) if m else re.sub(r"\.git$", "", url)

def repo_files(repo, commit, work):
    """lecteur des fichiers d'un dépôt GitHub au commit fabriqué (clone partiel, fichiers téléchargés à la demande) ;
       suit les sous-modules git. Renvoie get(chemin) -> (texte, lien GitHub) ou None"""
    repo = gh_https(repo)
    d = os.path.join(work, "_src", re.sub(r"\W+", "_", repo.split("github.com/")[-1]))
    if not os.path.isdir(os.path.join(d, ".git")):
        os.makedirs(os.path.dirname(d), exist_ok=True)
        git("clone", "-q", "--filter=blob:none", "--no-checkout", repo + ".git", d)
    try: git("cat-file", "-e", commit, cwd=d)
    except Exception: git("fetch", "-q", "origin", commit, cwd=d)
    subs, sub_get = [], {}
    try:
        gm = git("cat-file", "-p", f"{commit}:.gitmodules", cwd=d)
        for path, url in re.findall(r"path\s*=\s*(\S+)\s*\n\s*url\s*=\s*(\S+)", gm): subs.append((path.strip("/"), url))
    except Exception: pass
    def get(p):
        try: return git("cat-file", "-p", f"{commit}:{p}", cwd=d), f"{repo}/blob/{commit}/{p}"
        except Exception: pass
        for sp, url in subs:
            if not p.startswith(sp + "/"): continue
            try:
                if sp not in sub_get:
                    sha = git("ls-tree", commit, sp, cwd=d).split()[2]
                    sub_get[sp] = repo_files(url, sha, work)
                return sub_get[sp](p[len(sp) + 1:])
            except Exception: return None
        return None
    return get

def one_project(job):
    """une fiche ; renvoie (clé, macro, texte du journal, statut) — exécuté dans un processus à part"""
    sid, work, src_work, p, base, lay, out = job
    macro, key = p["macro"], f"a{int(p['address'])}"
    try:
        import yaml
        info = yaml.safe_load(git("cat-file", "-p", f"HEAD:{base}/info.yaml", cwd=work)) or {}
        P = info.get("project", {})
        if P.get("wokwi_id") or str(P.get("language", "")).lower() in ("wokwi", "analog") or P.get("analog_pins"): return key, macro, "Wokwi ou analogique : outils à venir", "skip"
        commit = json.loads(git("cat-file", "-p", f"HEAD:{base}/commit_id.json", cwd=work))
        gl = git("cat-file", "-p", f"HEAD:{base}/{macro}.v", cwd=work)
        tmp = os.path.join(work, f"_{key}_" + os.path.basename(lay)); open(tmp, "wb").write(git("cat-file", "-p", f"HEAD:{lay}", cwd=work, binary=True))
        try:
            get = repo_files(commit["repo"], commit["commit"], src_work) if commit.get("repo") else (lambda q: None)
        except Exception as e:
            get = lambda q: None   # sources introuvables (dépôt supprimé…) : la fiche garde les modules et la simulation
        try: res = analyze(tmp, gl, info, commit, get, macro)
        finally:
            try: os.remove(tmp)
            except OSError: pass
        open(out + ".part", "w", encoding="utf-8").write(json.dumps(res, ensure_ascii=False, separators=(",", ":"))); os.replace(out + ".part", out)
        return key, macro, f"{len(res['mods'])} modules, {len(res['cells']['x'])} cellules, {len(res['sigs'])} variables" + ("" if res["files"] else " (sans le code source)"), "ok"
    except Exception as e:
        return key, macro, f"ERREUR {str(e)[:200]}", "err"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shuttles", default="all", help="navettes séparées par des virgules, ou all (celles de <out>/shuttles.json)")
    ap.add_argument("--out", default="cartes/maps4"); ap.add_argument("--work", default="travail", help="dépôts des navettes (ceux de cda_maps.py sont réutilisés)")
    ap.add_argument("--only", default=""); ap.add_argument("--force", action="store_true"); ap.add_argument("--jobs", type=int, default=max(1, min(6, (os.cpu_count() or 2) - 1)))
    ap.add_argument("--index-dir", default="", help="(test) lire <navette>.json dans ce dossier au lieu de index.tinytapeout.com")
    a = ap.parse_args()
    only = set(x for x in a.only.split(",") if x)
    if a.shuttles == "all":
        sids = [x["id"] for x in json.load(open(os.path.join(a.out, "shuttles.json"), encoding="utf-8"))]
    else: sids = [x for x in a.shuttles.split(",") if x]
    src_work = os.path.join(a.work, "_src")
    tot = collections.Counter()
    from multiprocessing import Pool
    for sid in sids:
        log(f"== {sid}")
        try: idx = json.load(open(os.path.join(a.index_dir, sid + ".json"), encoding="utf-8")) if a.index_dir else fetch_json(f"https://index.tinytapeout.com/{sid}.json")
        except Exception as e: log(f"   index introuvable ({e}) : navette ignorée"); continue
        repo = idx["repo"].rstrip("/"); work = os.path.join(a.work, sid)
        try:
            if not os.path.isdir(os.path.join(work, ".git")):
                os.makedirs(a.work, exist_ok=True); log(f"   clonage de {repo} (sans les fichiers, ils viennent à la demande)")
                git("clone", "-q", "--filter=blob:none", "--no-checkout", repo + ".git", work)
            files = git("ls-tree", "-r", "--name-only", "HEAD", cwd=work).split("\n")
        except Exception as e: log(f"   dépôt de la navette inaccessible ({e}) : navette ignorée"); continue
        outdir = os.path.join(a.out, sid); os.makedirs(outdir, exist_ok=True)
        jobs, n = [], collections.Counter()
        vfiles = {}   # macro -> dossier du projet (celui de projects/ d'abord)
        for f in sorted((f for f in files if f.endswith(".v")), key=lambda f: not f.startswith("projects/")):
            vfiles.setdefault(f.rsplit("/", 1)[-1][:-2], f.rsplit("/", 1)[0])
        for p in idx["projects"]:
            macro, key = p["macro"], f"a{int(p['address'])}"
            if only and macro not in only: continue
            out = os.path.join(outdir, key + ".code.json")
            if os.path.exists(out) and not a.force: n["déjà faites"] += 1; continue
            if (p.get("tiles") or "1x1") not in ("1x1", "1x2"): n["grandes tuiles (plus tard)"] += 1; continue
            base = vfiles.get(macro)
            lay = next((f for f in files if base and f.startswith(base + "/") and f.endswith((f"{macro}.oas", f"{macro}.gds"))), None)
            if not base or not lay: n["sans liste des connexions"] += 1; continue
            jobs.append((sid, work, src_work, p, base, lay, out))
        log(f"   {len(idx['projects'])} projets, {len(jobs)} fiches à faire" + "".join(f", {v} {k}" for k, v in n.items()))
        if jobs:
            with Pool(a.jobs) as pool:
                for k, (key, macro, msg, st) in enumerate(pool.imap_unordered(one_project, jobs), 1):
                    n[{"ok": "fiches écrites", "skip": "Wokwi / analogiques (plus tard)", "err": "erreurs"}[st]] += 1
                    log(f"   [{k}/{len(jobs)}] {key} {macro} : {msg}")
        log(f"   {sid} : " + ", ".join(f"{v} {k}" for k, v in n.items()))
        tot.update(n)
    log("\nTotal : " + ", ".join(f"{v} {k}" for k, v in tot.items()))

if __name__ == "__main__":
    main()

# Notes — projets Wokwi : info.yaml donne wokwi_id ; le schéma (diagram.json, sur wokwi.com) nomme chaque porte (and1, xor2…)
# et la liste des connexions garde ces noms : on reliera chaque cellule à la porte du schéma (lien vers le projet Wokwi).
# Projets analogiques : pas de cellules standard ; on reconnaîtra les composants par leurs couches (transistors : poly sur
# diffusion, condensateurs MIM : couche capm, résistances : couches de marquage) et on lira les étiquettes du dessin.
