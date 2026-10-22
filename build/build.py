#!/usr/bin/env python3
"""Chip Defender Arena · construction du site (dist/)

  python3 build/build.py                 # environnement choisi automatiquement
  CDA_ENV=staging python3 build/build.py # forcé

Environnement :
  - CDA_ENV (production | staging) s'il est donné ;
  - sinon Cloudflare Pages : CF_PAGES_BRANCH == "production" -> production, toute autre branche -> staging ;
  - sinon (poste local) : staging.
La configuration de chaque environnement est dans config/<env>/ (auth.json, cartes.json, dons.json, site.json).

Variantes pour les tests locaux (jamais en ligne) :
  CDA_AUTH_JSON=<fichier>    auth.json de test (serveur local 127.0.0.1:8787)
  CDA_CARTES_JSON=<fichier>  cartes.json de test ({} : cartes à côté de la page)
  CDA_OUT=<dossier>          dossier de sortie (dist/ par défaut)

Étapes : modules src/ inclus dans game.html -> traduction anglaise (i18n/) -> en-tête (PWA, réseau, version)
-> bibliothèques hébergées -> CSP avec l'empreinte de chaque script intégré -> dist/.
"""
import base64, hashlib, json, os, re, shutil, subprocess, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R = lambda *p: os.path.join(ROOT, *p)


def pick_env():
    e = os.environ.get('CDA_ENV')
    if not e:
        b = os.environ.get('CF_PAGES_BRANCH')
        e = 'production' if b == 'production' else 'staging'
    assert e in ('production', 'staging'), e
    return e


ENV = pick_env()
CFG = R('config', ENV)
OUT = os.path.abspath(os.environ.get('CDA_OUT') or R('dist'))
SITE = json.load(open(os.path.join(CFG, 'site.json'), encoding='utf-8'))
assert SITE['env'] == ENV
AUTH_F = os.environ.get('CDA_AUTH_JSON') or os.path.join(CFG, 'auth.json')
CARTES_F = os.environ.get('CDA_CARTES_JSON') or os.path.join(CFG, 'cartes.json')
AUTHCFG = json.load(open(AUTH_F, encoding='utf-8'))

# garde-fous : la production ne publie jamais l'authentification directe (réservée aux tests du staging)
if ENV == 'production':
    assert 'direct' not in AUTHCFG['providers'] and 'dev' not in AUTHCFG['providers'], 'production : authentification directe interdite'
    assert AUTHCFG.get('pubkey') not in (None, '', 'auto'), 'production : la clé publique du serveur doit être épinglée'
    assert not os.environ.get('CDA_AUTH_JSON'), 'production : pas de configuration de test'


def include_modules(src):
    # <script>/*@include chemin*/</script> : modules partagés inclus dans la page
    return re.sub(r'/\*@include ([^*]+)\*/', lambda m: open(R(m.group(1).strip()), encoding='utf-8').read().replace('</script', '<\\/script'), src)


def translate(src, tmp):
    a, b = os.path.join(tmp, 'inc.html'), os.path.join(tmp, 'i18n.html')
    open(a, 'w', encoding='utf-8').write(src)
    subprocess.run(['node', R('i18n', 'apply.js'), a, R('i18n', 'en_js.json'), b], check=True)
    t = open(b, encoding='utf-8').read()
    H = json.dumps(json.load(open(R('i18n', 'en_html.json'), encoding='utf-8')), ensure_ascii=False).replace('</', '<\\/')
    assert t.count('/*I18N_HTML*/{}') == 1
    return t.replace('/*I18N_HTML*/{}', H)


def page_body(tmp):
    t = translate(include_modules(open(R('game.html'), encoding='utf-8').read()), tmp)
    t = t.replace('/*CHIPDATA*/', '')   # LEDs Racer se télécharge comme les autres tuiles
    full = open(R('data', 'maps-index.json'), encoding='utf-8').read().strip().replace('</', '<\\/')
    assert t.count('/*MAPINDEX*/') == 1
    t = t.replace('/*MAPINDEX*/', 'window.CDA_INDEX={"ext":"bin","base":"maps/ttsky25b/","id":"ttsky25b","name":"Tiny Tapeout SKY 25b","official":true,' + full[1:] + ';')
    im = json.load(open(R('assets', 'landing', 'limg.json'), encoding='utf-8'))
    fav = im.pop('_fav')
    assert t.count('/*LANDING_IMG*/{}') == 1
    t = t.replace('/*LANDING_IMG*/{}', json.dumps(im))
    THREE_CDN = '<script src="https://cdn.jsdelivr.net/npm/three@0.149.0/build/three.min.js"></script>'
    assert t.count(THREE_CDN) == 1
    t = t.replace(THREE_CDN, '<script src="./lib/three-0.149.0.min.js"></script>')
    return t, fav


DESC = "Chip Defender Arena · LEDs Racer Edition : un FPS multijoueur gratuit dans le layout réel d'une puce Tiny Tapeout (SKY130). Six modes, des véhicules, dans le navigateur."


def head(fav, build, maps_base, mapdir):
    env_js = json.dumps({"env": ENV, "badge": SITE.get('badge') or ""})
    robots = '<meta name="robots" content="noindex,nofollow">\n' if SITE.get('noindex') else ''
    # bandeau d'environnement (staging) : posé dès que la page est prête, indépendamment du jeu (style #envBadge dans game.html)
    badge = ('<script>addEventListener("DOMContentLoaded", () => { const b = document.createElement("div"); b.id = "envBadge"; b.textContent = '
             + json.dumps(SITE['badge'] + ' · ' + build[:7]) + '; document.body.appendChild(b); });</script>\n') if SITE.get('badge') else ''
    return f'''<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<script>window.CDA_MAPS={json.dumps(maps_base)};window.CDA_MAPDIR={json.dumps(mapdir)};</script>
<script>if (window.top !== window.self) {{ document.documentElement.style.display = "none"; try {{ window.top.location = window.self.location.href; }} catch (e) {{}} }}</script>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
{robots}<meta name="description" content="{DESC}">
<meta name="theme-color" content="#006bdf">
<meta property="og:type" content="website">
<meta property="og:title" content="Chip Defender Arena · LEDs Racer Edition">
<meta property="og:description" content="{DESC}">
<meta property="og:url" content="{SITE['url']}">
<link rel="icon" type="image/png" href="{fav}">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Chip Defender">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<script>if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {{}}));</script>
<script>window.CDA_LIB_NT = "./lib/nostr-tools-2.17.0-v.min.js";</script>
<script>window.CDA_BUILD="{build}";window.CDA_ENV={env_js};</script>
{badge}<script id="net-config">
/*NET_CFG:BEGIN*/
window.NET_CFG = {{
  strategy: "nostr",                       // "nostr" | "mqtt" | "torrent" | "supabase" | "ws-relay"
  appId: "kercrafter-chip-defender-arena", // identifiant unique du jeu sur le réseau de mise en relation
  lib: "./lib/trystero-{{s}}-0.25.4.min.js", // bibliothèque réseau hébergée sur le site (seule « nostr » y est copiée)
  relayUrls: [],                           // relais à utiliser (obligatoire pour "ws-relay")
  supabaseUrl: "",                         // "supabase" : URL du projet
  supabaseKey: "",                         // "supabase" : clé publique (anon / publishable)
  turn: [],                                // serveurs TURN facultatifs, ex. {{ urls: "turn:…", username: "…", credential: "…" }}
  password: ""                             // facultatif : chiffre la mise en relation
}};
/*NET_CFG:END*/
</script>
'''


def csp(page, maps_origin):
    srv = AUTHCFG['server'].rstrip('/'); wss = AUTHCFG['relay'].split('/relay')[0]
    # les adresses du serveur de l'environnement restent autorisées : changer d'adresse (auth.json) sans republier la page
    extra = [] if os.environ.get('CDA_AUTH_JSON') else [f"{s}://{h}" for h in SITE.get('csp_servers', []) for s in ("https", "wss")]
    hashes = sorted({"'sha256-" + base64.b64encode(hashlib.sha256(m.group(1).encode('utf-8')).digest()).decode() + "'"
                     for m in re.finditer(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', page, flags=re.S)})
    pol = "; ".join([
        "default-src 'self'",
        "script-src 'self' " + " ".join(hashes),
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' data: https://fonts.gstatic.com",
        "img-src 'self' data: blob: https:",
        "media-src 'self' data: blob:",
        "connect-src 'self' " + " ".join(dict.fromkeys([srv, wss] + extra + ([maps_origin] if maps_origin else []))),
        "worker-src 'self' blob:", "manifest-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"])
    return page.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="' + pol + '">', 1), len(hashes)


def copy_assets():
    A = R('assets', 'pwa')
    for f in ['sw.js', 'manifest.webmanifest']: shutil.copy2(os.path.join(A, f), os.path.join(OUT, f))
    for src, dst in [(os.path.join(A, 'icons'), 'icons'), (os.path.join(A, 'lib'), 'lib'), (R('assets', 'sons'), 'sons'),
                     (R('assets', 'img', 'armes'), 'img/armes'), (R('assets', 'code'), 'code')]:
        shutil.copytree(src, os.path.join(OUT, dst), dirs_exist_ok=True)
    # configuration publique lue par la page au démarrage (jamais de secret ici)
    shutil.copy2(AUTH_F, os.path.join(OUT, 'auth.json'))
    shutil.copy2(os.path.join(CFG, 'dons.json'), os.path.join(OUT, 'dons.json'))
    hdr = ["/*", "  X-Frame-Options: DENY", "  X-Content-Type-Options: nosniff", "  Referrer-Policy: no-referrer"]
    if SITE.get('noindex'): hdr.append("  X-Robots-Tag: noindex, nofollow")
    hdr += ["/sw.js", "  Cache-Control: no-cache", "/version.json", "  Cache-Control: no-cache", "/auth.json", "  Cache-Control: no-cache", "/index.html", "  Cache-Control: no-cache", "/", "  Cache-Control: no-cache"]
    open(os.path.join(OUT, '_headers'), 'w').write("\n".join(hdr) + "\n")
    if SITE.get('noindex'): open(os.path.join(OUT, 'robots.txt'), 'w').write("User-agent: *\nDisallow: /\n")


def main():
    if os.path.isdir(OUT): shutil.rmtree(OUT)
    os.makedirs(OUT)
    with tempfile.TemporaryDirectory() as tmp:
        t, fav = page_body(tmp)
    build = hashlib.sha1((ENV + t).encode('utf-8')).hexdigest()[:12]
    proto = int(re.search(r'const CDA_PROTO = (\d+);', t).group(1))
    maps_base = (json.load(open(CARTES_F)).get('base') or '') if os.path.exists(CARTES_F) else ''
    assert maps_base == '' or re.match(r'^(https://[a-z0-9.-]+|http://127\.0\.0\.1:\d+)/$', maps_base), maps_base
    mapdir = os.environ.get('CDA_MAPDIR', 'maps4/')
    assert mapdir in ('maps/', 'maps4/'), mapdir
    page = head(fav, build, maps_base, mapdir) + t + '\n</html>\n'
    page, n = csp(page, maps_base.rstrip('/'))
    open(os.path.join(OUT, 'index.html'), 'w', encoding='utf-8').write(page)
    json.dump({"v": build, "proto": proto, "env": ENV, "t": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}, open(os.path.join(OUT, 'version.json'), 'w'))
    copy_assets()
    print(f'[{ENV}] version {build} · protocole {proto} · CSP {n} scripts · index.html {os.path.getsize(os.path.join(OUT, "index.html")) // 1024} Ko -> {OUT}')


if __name__ == '__main__':
    main()
