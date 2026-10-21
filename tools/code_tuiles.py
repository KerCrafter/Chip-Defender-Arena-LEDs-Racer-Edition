#!/usr/bin/env python3
"""Fiches « code » des tuiles : relie chaque cellule logique de la puce à son module et à son code source.

  python code_tuiles.py --shuttles ttsky25b --out cartes/maps4 [--work cartes/_work] [--only tt_um_kercrafter_leds_racer] [--force]

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
Seuls les projets en Verilog (une tuile) sont traités pour l'instant ; Wokwi et analogique : voir les notes en fin de fichier.
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
def git(*args, cwd=None, binary=False):
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True)
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
                insts[inst] = (typ, line_at(m.end() + im.start(2)))
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
        typ, ln = hit
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
    sigs, sid = [], {}
    for c, (path, s) in sig.items():
        key = (path, s)
        if key in sid: continue
        m = mods[mid[path]] if path in mid else None
        d = decl_line(mods_src, m["t"] if m and m["t"] else (top_mod if not path else ""), s) if mods_src else None
        sigs.append({"n": s, "m": mid.get(path, -1), **({"d": d} if d else {})}); sid[key] = len(sigs) - 1
    X, Y, Mi, Si, cnt = [], [], [], [], collections.Counter()
    for c, p in own.items():
        if c not in pos: continue
        x, y = pos[c]; X.append(x); Y.append(y); Mi.append(mid[p]); Si.append(sid.get(sig[c], -1) if c in sig else -1); cnt[mid[p]] += 1
    for k, m in enumerate(mods): m["c"] = cnt[k]
    # on ne garde que les fichiers cités (affichage des extraits)
    used = {m[k][0] for m in mods for k in ("i", "d") if k in m} | {s["d"][0] for s in sigs if "d" in s}
    return {"v": 1, "macro": macro, "lang": P.get("language", ""), "repo": commit.get("repo", ""), "commit": commit.get("commit", ""), "top": top_mod,
            "files": {f: t for f, t in files.items() if f in used}, "urls": {f: u for f, u in urls.items() if f in used}, "mods": mods, "sigs": sigs, "cells": {"x": X, "y": Y, "m": Mi, "s": Si}}

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

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shuttles", default="ttsky25b"); ap.add_argument("--out", default="cartes/maps4"); ap.add_argument("--work", default="cartes/_work")
    ap.add_argument("--only", default=""); ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    import yaml
    only = set(x for x in a.only.split(",") if x)
    for sid in a.shuttles.split(","):
        idx = fetch_json(f"https://index.tinytapeout.com/{sid}.json")
        repo = idx["repo"].rstrip("/"); work = os.path.join(a.work, sid)
        if not os.path.isdir(os.path.join(work, ".git")): git("clone", "-q", "--filter=blob:none", "--no-checkout", repo + ".git", work)
        files = git("ls-tree", "-r", "--name-only", "HEAD", cwd=work).split("\n")
        outdir = os.path.join(a.out, sid); os.makedirs(outdir, exist_ok=True)
        done = skipped = 0
        for p in idx["projects"]:
            macro, key = p["macro"], f"a{int(p['address'])}"
            if only and macro not in only: continue
            out = os.path.join(outdir, key + ".code.json")
            if os.path.exists(out) and not a.force: skipped += 1; continue
            if (p.get("tiles") or "1x1") not in ("1x1", "1x2"): continue   # grandes tuiles découpées : plus tard
            base = next((f.rsplit("/", 1)[0] for f in files if f.endswith(f"/{macro}.v")), None)
            lay = next((f for f in files if base and f.startswith(base + "/") and f.endswith((f"{macro}.oas", f"{macro}.gds"))), None)
            if not base or not lay: continue
            try:
                info = yaml.safe_load(git("cat-file", "-p", f"HEAD:{base}/info.yaml", cwd=work)) or {}
                P = info.get("project", {})
                if P.get("wokwi_id") or str(P.get("language", "")).lower() in ("wokwi", "analog") or P.get("analog_pins"): continue   # outils à venir
                commit = json.loads(git("cat-file", "-p", f"HEAD:{base}/commit_id.json", cwd=work))
                gl = git("cat-file", "-p", f"HEAD:{base}/{macro}.v", cwd=work)
                tmp = os.path.join(work, os.path.basename(lay)); open(tmp, "wb").write(git("cat-file", "-p", f"HEAD:{lay}", cwd=work, binary=True))
                get = repo_files(commit["repo"], commit["commit"], a.work) if commit.get("repo") else (lambda q: None)
                res = analyze(tmp, gl, info, commit, get, macro); os.remove(tmp)
                open(out + ".part", "w", encoding="utf-8").write(json.dumps(res, ensure_ascii=False, separators=(",", ":"))); os.replace(out + ".part", out)
                done += 1; log(f"   {key} {macro} : {len(res['mods'])} modules, {len(res['cells']['x'])} cellules, {len(res['sigs'])} variables")
            except Exception as e:
                log(f"   {key} {macro} : ERREUR {e}")
        log(f"{sid} : {done} fiches écrites, {skipped} déjà faites")

if __name__ == "__main__":
    main()

# Notes — projets Wokwi : info.yaml donne wokwi_id ; le schéma (diagram.json, sur wokwi.com) nomme chaque porte (and1, xor2…)
# et la liste des connexions garde ces noms : on reliera chaque cellule à la porte du schéma (lien vers le projet Wokwi).
# Projets analogiques : pas de cellules standard ; on reconnaîtra les composants par leurs couches (transistors : poly sur
# diffusion, condensateurs MIM : couche capm, résistances : couches de marquage) et on lira les étiquettes du dessin.
