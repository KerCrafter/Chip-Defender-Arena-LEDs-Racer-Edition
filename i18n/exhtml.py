import json, re, sys
from bs4 import BeautifulSoup, NavigableString, Comment
src = open(sys.argv[1], encoding='utf-8').read()
body = src[:src.index('<script>')]
soup = BeautifulSoup(body, 'html.parser')
units, attrs = [], []
def has_direct(el):
    return any(isinstance(c, NavigableString) and not isinstance(c, Comment) and re.search(r'[A-Za-zÀ-ÿ]{2}', c) for c in el.children)
def walk(el):
    for c in el.children:
        if getattr(c, 'name', None) is None or c.name in ('style', 'script', 'svg'): continue
        if has_direct(c):
            h = c.decode_contents().strip()
            if h not in units: units.append(h)
        else: walk(c)
        for a in ('title', 'placeholder', 'aria-label'):
            v = c.get(a)
            if v and re.search(r'[A-Za-zÀ-ÿ]{2}', v) and v not in attrs: attrs.append(v)
walk(soup)
json.dump({'html': units, 'attr': attrs}, open(sys.argv[2], 'w'), ensure_ascii=False, indent=1)
print(len(units), len(attrs))
