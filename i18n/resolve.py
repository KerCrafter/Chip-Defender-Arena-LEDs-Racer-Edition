import json, importlib.util
def load(n):
    sp = importlib.util.spec_from_file_location(n, n + '.py'); m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m); return m
cand = json.load(open('cand.json'))['js']; js = load('en_idx'); hh = load('en_html'); html = json.load(open('html.json'))
out = {}
for i, en in js.IDX.items(): out[cand[i]['src']] = en
out.update(js.EXTRA)
logo = cand[1]['src']; assert logo.startswith('`<svg class="cda-logo"')
out[logo] = logo.replace('Chip Defender Arena, édition LEDs Racer', 'Chip Defender Arena, LEDs Racer edition').replace('ÉDITION LEDs RACER', 'LEDs RACER EDITION')
json.dump(out, open('en_js.json', 'w'), ensure_ascii=False, indent=0)
H = {'html': {}, 'attr': {}}
for i, en in hh.IDX.items():
    j = i + 3 if i >= 131 else i
    H['html'][html['html'][j]] = en
for i, en in hh.ATTR.items(): H['attr'][html['attr'][i]] = en
json.dump(H, open('en_html.json', 'w'), ensure_ascii=False, indent=0)
print(len(out), len(H['html']), len(H['attr']))
