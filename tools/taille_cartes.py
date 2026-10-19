"""Taille des cartes et du site (GitHub Pages limite un site à 1 Go).
   python taille_cartes.py <dossier du site> [--garde-fou]  → code 1 si le site dépasse 950 Mo avec --garde-fou"""
import os, sys
site = sys.argv[1] if len(sys.argv) > 1 else "."
maps = os.path.join(site, "maps")
def size(p): return sum(os.path.getsize(os.path.join(r, f)) for r, ds, fs in os.walk(p) for f in fs if ".git" not in r.split(os.sep))
if os.path.isdir(maps):
    for d in sorted(os.listdir(maps)):
        p = os.path.join(maps, d)
        if os.path.isdir(p): print(f"   {d:<10} {size(p) / 1e6:6.0f} Mo")
t = size(site)
print(f"   site entier {t / 1e6:5.0f} Mo (limite GitHub Pages : 1000 Mo)")
sys.exit(1 if "--garde-fou" in sys.argv and t > 950e6 else 0)
