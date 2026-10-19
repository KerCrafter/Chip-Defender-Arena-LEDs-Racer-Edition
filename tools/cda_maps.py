#!/usr/bin/env python3
"""Chip Defender Arena · générateur de cartes Tiny Tapeout
===========================================================
Télécharge les layouts (GDS/OASIS) des projets Tiny Tapeout et les convertit en cartes du jeu
(format CDA2, chargées à la demande par le site), avec l'index qu'affiche l'écran du MUX.

    python3 cda_maps.py                       # toutes les navettes SKY130 connues
    python3 cda_maps.py --shuttles tt06,tt07  # seulement celles-ci
    python3 cda_maps.py --out ../site --jobs 4

Sortie (dans --out, par défaut le dossier courant) :
    maps/shuttles.json            liste des navettes disponibles
    maps/<navette>/index.json     plan de la puce + projets (écran du MUX)
    maps/<navette>/a<adresse>.bin une carte par projet

Le travail est repris là où il s'est arrêté : relancer la commande ne refait que ce qui manque.
Dépendances : Python 3.9+, git, et  pip install gdstk numpy pyyaml
"""
import argparse, collections, gzip, json, os, re, struct, subprocess, sys, tempfile, time, urllib.request
from multiprocessing import Pool

SKY130 = ["tt03p5", "tt04", "tt05", "tt06", "tt07", "tt08", "tt09", "ttsky25a", "ttsky25b"]
GRID = 0.005
LAYERS = [((64, 20), "nwell"), ((65, 20), "diff"), ((65, 44), "tap"), ((66, 20), "poly"), ((66, 44), "licon"), ((67, 20), "li1"),
          ((67, 44), "mcon"), ((68, 20), "met1"), ((68, 44), "via"), ((69, 20), "met2"), ((69, 44), "via2"), ((70, 20), "met3"),
          ((70, 44), "via3"), ((71, 20), "met4")]

def log(*a): print(time.strftime("%H:%M:%S"), *a, flush=True)

# ---------- géométrie : polygones -> rectangles ----------
def slab_rects(np, pts):
    pts = np.asarray(pts); x0 = pts[:, 0]; y0 = pts[:, 1]; x1 = np.roll(x0, -1); y1 = np.roll(y0, -1)
    ys = np.unique(np.round(y0 / GRID).astype(np.int64))
    if len(ys) < 2: return []
    out = []; open_ = {}; lo = np.minimum(y0, y1); hi = np.maximum(y0, y1)
    for i in range(len(ys) - 1):
        ya, yb = ys[i], ys[i + 1]; ym = (ya + yb) * 0.5 * GRID
        m = (lo < ym) & (hi > ym)
        if not m.any(): cur = set()
        else:
            ex0 = x0[m]; ey0 = y0[m]; ex1 = x1[m]; ey1 = y1[m]
            xs = np.sort(np.round((ex0 + (ym - ey0) * (ex1 - ex0) / (ey1 - ey0)) / GRID).astype(np.int64))
            iv = []
            for k in range(0, len(xs) - 1, 2):
                a, b = xs[k], xs[k + 1]
                if b <= a: continue
                if iv and a <= iv[-1][1]: iv[-1][1] = max(iv[-1][1], b)
                else: iv.append([a, b])
            cur = set((a, b) for a, b in iv)
        for key in list(open_.keys()):
            if key not in cur: out.append((key[0], open_[key], key[1], ya)); del open_[key]
        for key in cur:
            if key not in open_: open_[key] = ya
    for key, ys0 in open_.items(): out.append((key[0], ys0, key[1], ys[-1]))
    return out

def layer_rects(np, gdstk, name, polys):
    if not polys: return np.zeros((0, 4), np.int64)
    if name in ("licon", "mcon", "via", "via2", "via3"):
        rects = set()
        for p in polys:
            a = np.round(np.asarray(p) / GRID).astype(np.int64)
            rects.add((a[:, 0].min(), a[:, 1].min(), a[:, 0].max(), a[:, 1].max()))
        arr = np.array(sorted(rects), np.int64) if rects else np.zeros((0, 4), np.int64)
    else:
        merged = gdstk.boolean([gdstk.Polygon(p) for p in polys], [], "or", precision=1e-3)
        rects = []
        for mp in merged: rects.extend(slab_rects(np, mp.points))
        arr = np.array(rects, np.int64) if rects else np.zeros((0, 4), np.int64)
    if len(arr): arr = arr[(arr[:, 2] > arr[:, 0]) & (arr[:, 3] > arr[:, 1])]
    return arr

def uv(np, a):
    out = bytearray()
    for v in np.asarray(a, np.int64).tolist():
        while True:
            b = v & 127; v >>= 7
            if v: out.append(b | 128)
            else: out.append(b); break
    return bytes(out)

def enc(np, r, extra=None):
    """rectangles triés (y0, x0) -> flux d'entiers variables : écart y, écart x (zigzag), largeur, hauteur (+ type)"""
    if len(r) == 0: return b"", [0, 0, 0, 0] + ([0] if extra is not None else [])
    o = np.lexsort((r[:, 0], r[:, 1])); r = r[o]
    dy = np.diff(r[:, 1], prepend=0); dx = np.diff(r[:, 0], prepend=0)
    nl = np.r_[False, dy[1:] != 0]; dx[nl] = r[nl, 0]
    zz = (dx << 1) ^ (dx >> 63)
    st = [uv(np, dy), uv(np, zz), uv(np, r[:, 2] - r[:, 0]), uv(np, r[:, 3] - r[:, 1])]
    if extra is not None: st.append(uv(np, np.asarray(extra)[o]))
    return b"".join(st), [len(s) for s in st]

def short(t): return t.split("__", 1)[-1]
def drive(t):
    s = t.rsplit("_", 1)
    return int(s[1]) if len(s) > 1 and s[1].isdigit() else 0

def pick_sites(np, cells, types, W, H):
    cand = []
    for (x0, y0, x1, y1, ti) in cells:
        t = short(types[ti])
        if t.startswith(("decap", "fill", "tap", "conb", "diode")): continue
        x, y = (x0 + x1) / 2 * GRID, (y0 + y1) / 2 * GRID
        if not (0.28 * H < y < 0.8 * H and 0.09 * W < x < 0.91 * W): continue
        cand.append((drive(t) + (0.5 if t.startswith("clk") else 0), t, x, y))
    cand.sort(key=lambda c: -c[0])
    nm = lambda t: "Racine d'horloge" if t.startswith(("clkbuf", "clkinv")) else "Pilote de puissance" if t.startswith(("bufinv", "buf_")) else "Inverseur de puissance" if t.startswith("inv") else "Cellule de puissance" if drive(t) >= 4 else "Porte logique"
    if cand:
        A = cand[0]
        B = next((c for c in cand[1:] if abs(c[2] - A[2]) > 0.25 * W), None) or next((c for c in cand[1:] if np.hypot(c[2] - A[2], c[3] - A[3]) > 0.2 * max(W, H)), None)
        if B:
            s = [{"id": "A", "name": nm(A[1]), "sub": A[1], "x": round(A[2], 2), "y": round(A[3], 2)}, {"id": "B", "name": nm(B[1]), "sub": B[1], "x": round(B[2], 2), "y": round(B[3], 2)}]
            if s[0]["name"] == s[1]["name"] == "Racine d'horloge": s[1]["name"] = "Tampon d'horloge"
            return s
    return [{"id": "A", "name": "Zone A", "sub": "", "x": round(0.3 * W, 2), "y": round(0.52 * H, 2)}, {"id": "B", "name": "Zone B", "sub": "", "x": round(0.7 * W, 2), "y": round(0.6 * H, 2)}]

def convert(job):
    """un projet : layout -> carte CDA2 (exécuté dans un processus à part)"""
    import numpy as np, gdstk
    path, macro, addr, tiles, title, author, key, out = job
    t0 = time.time()
    try:
        if path.endswith(".gz"):
            with gzip.open(path) as f, tempfile.NamedTemporaryFile(suffix=".gds", delete=False) as g: g.write(f.read()); tmp = g.name
            lib = gdstk.read_gds(tmp); os.remove(tmp)
        else:
            lib = gdstk.read_oas(path) if path.endswith(".oas") else gdstk.read_gds(path)
        tops = [c for c in lib.top_level() if c.name == macro] or lib.top_level()
        top = max(tops, key=lambda c: len(c.references) + len(c.polygons))
        (bx0, by0), (bx1, by1) = top.bounding_box()
        by_layer = collections.defaultdict(list)
        for p in top.get_polygons(): by_layer[(p.layer, p.datatype)].append(p.points)
        ox, oy = round(bx0 / GRID), round(by0 / GRID)   # origine ramenée à (0, 0)
        payload, lay, n_tot = bytearray(), [], 0
        for ld, name in LAYERS:
            r = layer_rects(np, gdstk, name, by_layer.get(ld, []))
            if len(r) == 0: continue
            r[:, [0, 2]] -= ox; r[:, [1, 3]] -= oy
            b, ln = enc(np, r); lay.append({"name": name, "count": int(len(r)), "len": ln}); payload += b; n_tot += len(r)
        del by_layer
        types, tindex, cells = [], {}, []
        for ref in top.references:
            nm = ref.cell.name
            if nm not in tindex: tindex[nm] = len(types); types.append(nm)
            (ax, ay), (cx, cy) = ref.bounding_box()
            cells.append((round(ax / GRID) - ox, round(ay / GRID) - oy, round(cx / GRID) - ox, round(cy / GRID) - oy, tindex[nm]))
        cells = np.array(cells, np.int64).reshape(-1, 5); cells[:, :4] = np.maximum(cells[:, :4], 0)
        cb, cln = enc(np, cells[:, :4], cells[:, 4])
        labels, seen = [], set()
        for l in top.labels:
            if l.text in seen: continue
            seen.add(l.text); labels.append({"text": l.text, "x": round(l.origin[0] - bx0, 3), "y": round(l.origin[1] - by0, 3), "layer": l.layer})
        W, H = round(bx1 - bx0, 3), round(by1 - by0, 3)
        logic = sum(1 for t in cells[:, 4].tolist() if not short(types[t]).startswith(("decap", "fill", "tap", "conb")))
        meta = {"name": macro, "grid": GRID, "w": W, "h": H, "layers": lay, "cells": {"count": int(len(cells)), "len": cln}, "types": types, "labels": labels,
                "cda": {"key": key, "title": title, "author": author, "addr": int(addr), "tiles": tiles, "slice": [0, 0, 1, 1], "sites": pick_sites(np, cells.tolist(), types, W, H), "oy": 0},
                "stats": {"rects": n_tot, "logic": logic}}
        mj = json.dumps(meta, ensure_ascii=False, separators=(",", ":")).encode()
        gz = gzip.compress(b"CDA2" + struct.pack("<I", len(mj)) + mj + bytes(payload) + cb, 9)
        tmpo = out + ".part"; open(tmpo, "wb").write(gz); os.replace(tmpo, out)
        return {"macro": macro, "ok": True, "bytes": len(gz), "rects": n_tot, "logic": logic, "t": round(time.time() - t0, 1)}
    except Exception as e:
        return {"macro": macro, "ok": False, "err": repr(e)[:300]}

# ---------- navette : index, dépôt, plan ----------
def fetch_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "cda-maps"}), timeout=60) as r: return json.load(r)

def git(*a, cwd=None, binary=False):
    r = subprocess.run(["git", *a], cwd=cwd, capture_output=True)
    if r.returncode: raise RuntimeError("git " + " ".join(a) + " : " + r.stderr.decode(errors="ignore")[-300:])
    return r.stdout if binary else r.stdout.decode()

def chip_plan(repo_dir, projects):
    """plan officiel (docs/images/chip_map.svg) si la navette en a un, sinon une grille rangée par adresse"""
    try: svg = git("show", "HEAD:docs/images/chip_map.svg", cwd=repo_dir)
    except Exception: svg = None
    if svg:
        R = lambda d: [round(float(d[k]), 1) for k in ("x", "y", "width", "height")]
        plan = {"official": True, "spine": [], "mux": [], "amux": [], "free": [], "ctrl": None, "chip": None}; tiles = {}
        for attrs in re.findall(r"<rect\s+([^>]*)>", svg):
            d = dict(re.findall(r'([\w-]+)="([^"]*)"', attrs)); cl = d.get("class", "")
            if cl == "" and plan["chip"] is None and "width" in d: plan["chip"] = [round(float(d["width"]), 1), round(float(d["height"]), 1)]
            elif cl == "spine": plan["spine"].append(R(d))
            elif cl == "mux": plan["mux"].append(R(d))
            elif cl == "analog-mux": plan["amux"].append(R(d))
            elif cl == "ctrl": plan["ctrl"] = R(d)
            elif cl == "tile": plan["free"].append(R(d))
            elif "project" in cl and "data-addr" in d: tiles[int(d["data-addr"])] = (R(d), "analog" in cl)
        if tiles and plan["chip"]: return plan, tiles
    # grille de secours : 16 colonnes de tuiles, de part et d'autre d'une épine centrale
    TW, TH, GX, GY = 161, 111.52, 12.88, 60
    plan = {"official": False, "spine": [], "mux": [], "amux": [], "free": [], "ctrl": None, "chip": None}; tiles = {}
    x = y = 0; rowh = 0; cols = 16; col = 0; maxx = 0
    for p in sorted(projects, key=lambda p: p["address"]):
        tc, tr = [int(v) for v in str(p.get("tiles") or "1x1").lower().split("x")]
        if col + tc > cols: col = 0; y += rowh + GY; rowh = 0
        w, h = tc * TW + (tc - 1) * GX, tr * TH + (tr - 1) * 2.72
        px = 100 + col * (TW + GX) + (300 if col >= cols // 2 else 0)
        tiles[int(p["address"])] = ([round(px, 1), round(100 + y, 1), round(w, 1), round(h, 1)], bool(p.get("analog_pins")))
        col += tc; rowh = max(rowh, h); maxx = max(maxx, px + w)
    H = 100 + y + rowh + 100
    cx = 100 + cols // 2 * (TW + GX) + 150 - 50
    plan["spine"] = [[round(cx, 1), 50, 100, round(H - 100, 1)]]; plan["ctrl"] = [round(cx - 40, 1), round(H / 2 - 55, 1), 180, 110]
    plan["chip"] = [round(maxx + 100, 1), round(H, 1)]
    return plan, tiles

def run_shuttle(sid, args):
    log(f"== {sid}")
    try: idx = json.load(open(os.path.join(args.index_dir, sid + ".json"))) if args.index_dir else fetch_json(f"https://index.tinytapeout.com/{sid}.json")
    except Exception as e: log(f"   index introuvable ({e}) : navette ignorée"); return None
    repo = idx["repo"].rstrip("/"); projects = idx["projects"]
    work = os.path.join(args.work, sid); os.makedirs(args.work, exist_ok=True)
    if not os.path.isdir(os.path.join(work, ".git")):
        log(f"   clonage de {repo} (sans les fichiers, ils viennent à la demande)")
        git("clone", "-q", "--filter=blob:none", "--no-checkout", repo + ".git", work)
    else:
        try: git("fetch", "-q", "origin", cwd=work); git("reset", "-q", "--soft", "origin/HEAD", cwd=work)
        except Exception: pass
    files = git("ls-tree", "-r", "--name-only", "HEAD", cwd=work).split("\n")
    lay = {}
    for f in files:
        m = re.match(r"(?:.*/)?([^/]+)\.(oas|gds|gds\.gz)$", f)
        if not m: continue
        b = m.group(1)
        if b not in lay or lay[b].endswith(".gz") or (f.endswith(".oas") and not lay[b].endswith(".oas")): lay[b] = f
    outdir = os.path.join(args.out, "maps", sid); os.makedirs(outdir, exist_ok=True)
    srcdir = os.path.join(work, "_layouts"); os.makedirs(srcdir, exist_ok=True)
    plan, tiles = chip_plan(work, projects)
    jobs, P = [], []
    for p in projects:
        macro, addr = p["macro"], int(p["address"]); key = f"a{addr}"; out = os.path.join(outdir, key + ".bin")
        P.append((p, key, out))
        if os.path.exists(out) or macro not in lay: continue
        src = os.path.join(srcdir, os.path.basename(lay[macro]))
        if not os.path.exists(src):
            try: open(src, "wb").write(git("cat-file", "-p", "HEAD:" + lay[macro], cwd=work, binary=True))
            except Exception as e: log(f"   {macro} : téléchargement impossible ({e})"); continue
        jobs.append((src, macro, addr, p.get("tiles") or "1x1", (p.get("title") or macro).strip(), (p.get("author") or "").strip(), key, out))
    log(f"   {len(projects)} projets, {len(lay)} layouts trouvés, {len(jobs)} à convertir")
    stats_f = os.path.join(work, "stats.json")
    stats = json.load(open(stats_f)) if os.path.exists(stats_f) else {}
    if jobs:
        with Pool(args.jobs) as pool:
            for k, r in enumerate(pool.imap_unordered(convert, jobs), 1):
                if r["ok"]: stats[r["macro"]] = [r["bytes"], r["rects"], r["logic"]]; json.dump(stats, open(stats_f, "w"))
                log(f"   [{k}/{len(jobs)}] {r['macro']} " + (f"{r['rects']} rectangles, {r['bytes'] // 1024} Ko, {r['t']} s" if r["ok"] else "ERREUR " + r["err"]))
                if not args.keep_layouts and r["ok"]:
                    j = next(j for j in jobs if j[1] == r["macro"])
                    try: os.remove(j[0])
                    except OSError: pass
    # index de l'écran du MUX
    out_p, maps = [], {}
    for p, key, out in P:
        a = int(p["address"]); r = tiles.get(a)
        if not r: continue
        ok = os.path.exists(out); st = stats.get(p["macro"])
        if ok and not st:   # carte déjà là (autre machine, ancienne version) : ses chiffres sont dans son en-tête
            try:
                with gzip.open(out) as f: h = f.read(8); meta = json.loads(f.read(struct.unpack("<I", h[4:8])[0]))
                st = [os.path.getsize(out), meta.get("stats", {}).get("rects", 0), meta.get("stats", {}).get("logic", 0)]
            except Exception: st = [os.path.getsize(out), 0, 0]
        if ok: maps[key] = 1
        tc, tr = [int(v) for v in str(p.get("tiles") or "1x1").lower().split("x")]
        out_p.append({"a": a, "m": p["macro"], "t": (p.get("title") or p["macro"]).strip(), "au": (p.get("author") or "").strip(), "ti": p.get("tiles") or "1x1",
                      "an": 1 if r[1] else 0, "r": r[0], "s": [1, 1], "k": [key] if ok else [], "d": [st] if ok and st else []})
    out_p.sort(key=lambda q: q["a"])
    index = {"v": 1, "id": sid, "name": idx.get("name", sid), "official": plan["official"], "chip": plan["chip"], "spine": plan["spine"], "mux": plan["mux"], "amux": plan["amux"], "ctrl": plan["ctrl"] or [0, 0, 0, 0], "free": plan["free"], "p": out_p, "maps": maps}
    json.dump(index, open(os.path.join(outdir, "index.json"), "w"), ensure_ascii=False, separators=(",", ":"))
    log(f"   index : {len(maps)} cartes sur {len(projects)} projets")
    return {"id": sid, "name": idx.get("name", sid), "projects": len(projects), "maps": len(maps)}

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--shuttles", default=",".join(SKY130), help="navettes, séparées par des virgules (défaut : toutes les SKY130)")
    ap.add_argument("--out", default=".", help="dossier du site (les cartes vont dans <out>/maps/)")
    ap.add_argument("--work", default="cda_work", help="dossier de travail (dépôts clonés, layouts)")
    ap.add_argument("--jobs", type=int, default=max(1, min(4, (os.cpu_count() or 2) - 1)), help="conversions en parallèle (chacune peut prendre plusieurs Go de mémoire sur les grands projets)")
    ap.add_argument("--index-dir", default="", help="(test) lire <navette>.json dans ce dossier au lieu de index.tinytapeout.com")
    ap.add_argument("--keep-layouts", action="store_true", help="garder les fichiers GDS/OASIS téléchargés")
    args = ap.parse_args()
    try: import gdstk, numpy  # noqa
    except ImportError: sys.exit("Il manque des modules : pip install gdstk numpy pyyaml")
    res = []
    for sid in [s.strip() for s in args.shuttles.split(",") if s.strip()]:
        r = run_shuttle(sid, args)
        if r: res.append(r)
    os.makedirs(os.path.join(args.out, "maps"), exist_ok=True)
    lst = os.path.join(args.out, "maps", "shuttles.json")
    old = json.load(open(lst)) if os.path.exists(lst) else []
    merged = {s["id"]: s for s in old}; merged.update({s["id"]: s for s in res})
    order = {s: i for i, s in enumerate(SKY130)}
    json.dump(sorted(merged.values(), key=lambda s: order.get(s["id"], 99)), open(lst, "w"), ensure_ascii=False, indent=1)
    log("terminé :", ", ".join(f"{s['id']} {s['maps']}/{s['projects']}" for s in res))

if __name__ == "__main__":
    main()
