"""Format de carte CDA3 (prototype) : géométrie hiérarchique.
   Chaque type de cellule standard est stocké une seule fois ; les instances (position + orientation) le replacent.
   Le routage (formes posées directement dans la tuile) reste en rectangles par couche comme en CDA2.
   Le jeu reconstruit exactement la même structure qu'une carte CDA2 (rectangles par couche, triés, + cellules)."""
import gzip, json, math, struct, time, collections
import numpy as np, gdstk
import cda_maps as C

GRID = C.GRID

def zz(a):
    a = np.asarray(a, np.int64); return (a << 1) ^ (a >> 63)

def enc_inst(inst):
    """instances triées (y, x) : écart y, écart x (zigzag, remis à zéro à chaque nouvelle ligne), orientation, type"""
    if len(inst) == 0: return b"", [0, 0, 0, 0]
    o = np.lexsort((inst[:, 0], inst[:, 1])); r = inst[o]
    dy = np.diff(r[:, 1], prepend=0); dx = np.diff(r[:, 0], prepend=0)
    nl = np.r_[True, dy[1:] != 0]; dx[nl] = r[nl, 0]
    st = [C.uv(np, zz(dy)), C.uv(np, zz(dx)), C.uv(np, r[:, 2]), C.uv(np, r[:, 3])]
    return b"".join(st), [len(s) for s in st]

def orient_of(ref):
    k = int(round((ref.rotation or 0) / (math.pi / 2))) % 4
    return k + (4 if ref.x_reflection else 0)

def convert3(job):
    path, macro, addr, tiles, title, author, key, out, pdk = job
    t0 = time.time()
    if path.endswith(".gz"):
        import tempfile, os
        with gzip.open(path) as f, tempfile.NamedTemporaryFile(suffix=".gds", delete=False) as g: g.write(f.read()); tmp = g.name
        lib = gdstk.read_gds(tmp); os.remove(tmp)
    else:
        lib = gdstk.read_oas(path) if path.endswith(".oas") else gdstk.read_gds(path)
    tops = [c for c in lib.top_level() if c.name == macro] or lib.top_level()
    top = max(tops, key=lambda c: len(c.references) + len(c.polygons))
    (bx0, by0), (bx1, by1) = top.bounding_box()
    ox, oy = round(bx0 / GRID), round(by0 / GRID)
    LAY = {"ihp": C.LAYERS_IHP, "gf180": C.LAYERS_GF}.get(pdk, C.LAYERS)
    names = []
    for _, n in LAY:
        if n not in names: names.append(n)
    # 1. routage : formes de la tuile elle-même (sans les cellules)
    by = collections.defaultdict(list)
    for p in top.get_polygons(depth=0): by[(p.layer, p.datatype)].append(p.points)
    payload, lay, n_route = bytearray(), [], 0
    for ld, name in LAY:
        r = C.layer_rects(np, gdstk, name, by.get(ld, []))
        if len(r): r[:, [0, 2]] -= ox; r[:, [1, 3]] -= oy
        b, ln = C.enc(np, r); lay.append({"name": name, "count": int(len(r)), "len": ln}); payload += b; n_route += len(r)
    del by
    # 2. bibliothèque : chaque type de cellule, une fois, en coordonnées locales
    types, tindex, inst = [], {}, []
    for ref in top.references:
        cell = ref.cell
        if cell.name not in tindex: tindex[cell.name] = len(types); types.append(cell)
        offs = ref.repetition.offsets if ref.repetition.size > 1 else [(0, 0)]
        for dx, dy in offs:
            inst.append((round((ref.origin[0] + dx) / GRID) - ox, round((ref.origin[1] + dy) / GRID) - oy, orient_of(ref), tindex[cell.name]))
    libmeta, libbytes, n_lib = [], bytearray(), 0
    for cell in types:
        by = collections.defaultdict(list)
        for p in cell.get_polygons(): by[(p.layer, p.datatype)].append(p.points)
        (cx0, cy0), (cx1, cy1) = cell.bounding_box() or ((0, 0), (0, 0))
        lx, ly = round(cx0 / GRID), round(cy0 / GRID)   # rectangles décalés pour rester positifs
        L = []
        for ld, name in LAY:
            r = C.layer_rects(np, gdstk, name, by.get(ld, []))
            if not len(r): continue
            r[:, [0, 2]] -= lx; r[:, [1, 3]] -= ly
            b, ln = C.enc(np, r); libbytes += b; n_lib += len(r)
            L.append([names.index(name), int(len(r)), ln])
        libmeta.append({"n": cell.name, "o": [lx, ly], "b": [lx, ly, round(cx1 / GRID), round(cy1 / GRID)], "l": L})
    inst = np.array(inst, np.int64).reshape(-1, 4)
    ib, iln = enc_inst(inst)
    # informations de jeu (sites, nombre de cellules logiques) : comme en CDA2, à partir des boîtes des instances
    def bbox_of(x, y, o, t):
        b = libmeta[t]["b"]; pts = [(b[0], b[1]), (b[2], b[1]), (b[0], b[3]), (b[2], b[3])]
        P = [transform(px, py, o) for px, py in pts]
        return min(p[0] for p in P) + x, min(p[1] for p in P) + y, max(p[0] for p in P) + x, max(p[1] for p in P) + y
    cells = np.array([(*bbox_of(*row), row[3]) for row in inst.tolist()], np.int64).reshape(-1, 5)
    tnames = [c.name for c in types]
    W, H = round(bx1 - bx0, 3), round(by1 - by0, 3)
    logic = sum(1 for t in cells[:, 4].tolist() if not C.short(tnames[t]).startswith(("decap", "fill", "tap", "conb", "tie", "antenna", "endcap")))
    labels, seen = [], set()
    for l in top.labels:
        if l.text in seen: continue
        seen.add(l.text); labels.append({"text": l.text, "x": round(l.origin[0] - bx0, 3), "y": round(l.origin[1] - by0, 3), "layer": l.layer})
    meta = {"fmt": 3, "name": macro, "pdk": pdk, "grid": GRID, "w": W, "h": H, "names": names, "layers": lay, "lib": libmeta, "inst": {"count": int(len(inst)), "len": iln},
            "types": tnames, "labels": labels,
            "cda": {"key": key, "title": title, "author": author, "addr": int(addr), "tiles": tiles, "slice": [0, 0, 1, 1], "sites": C.pick_sites(np, cells.tolist(), tnames, W, H), "oy": 0},
            "stats": {"rects": int(n_route + sum(sum(x[1] for x in libmeta[t]["l"]) for t in inst[:, 3].tolist())), "logic": logic}}
    mj = json.dumps(meta, ensure_ascii=False, separators=(",", ":")).encode()
    gz = gzip.compress(b"CDA3" + struct.pack("<I", len(mj)) + mj + bytes(payload) + bytes(libbytes) + ib, 9)
    import os
    tmpo = out + ".part"; open(tmpo, "wb").write(gz); os.replace(tmpo, out)   # jamais de carte à moitié écrite
    return {"ok": True, "bytes": len(gz), "route": n_route, "lib": n_lib, "inst": int(len(inst)), "t": round(time.time() - t0, 1)}

def transform(x, y, o):
    """orientation GDS : réflexion en x (y -> -y) puis rotation de k quarts de tour"""
    if o & 4: y = -y
    k = o & 3
    for _ in range(k): x, y = -y, x
    return x, y
