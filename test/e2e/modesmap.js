// multijoueur sécurisé : connexion (fournisseur d'essai), salon chiffré, partie publique, partie privée sur invitation
const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const { SITE, SRV, CHROME, SHOTS } = require('./harness');
const ok = (c, m) => { console.log((c ? 'OK   ' : 'ÉCHEC') + ' ' + m); if (!c) process.exitCode = 1; };
(async () => {
  const br = await chromium.launch({ executablePath: CHROME, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--no-proxy-server'] });
  const errs = [];
  async function user(name) {
    const ctx = await br.newContext({ viewport: { width: 1100, height: 700 } });
    await ctx.addInitScript(() => { if (location.protocol === 'about:') return; window.__noRender = true; localStorage.setItem('cda-land', '0'); localStorage.setItem('cda-lang', 'fr'); localStorage.setItem('cda-xr-help', '1'); localStorage.setItem('cda-opts', JSON.stringify({ q: 'low', intro: false })); });
    const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(name + ' ' + e.message)); p.on('console', m => { if (/Content Security Policy|Refused to/.test(m.text())) errs.push(name + ' CSP ' + m.text().slice(0, 220)); });
    p.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_|404|User-Initiated Abort/.test(m.text())) errs.push(name + ' console ' + m.text().slice(0, 200)); });
    // connexion par le fournisseur d'essai (DEV=1) : le serveur renvoie au jeu avec #cda=…
    await p.evaluate ? 0 : 0; await ctx.addInitScript(() => { if (location.protocol === 'about:') return; if (!localStorage.getItem('cda-auth')) localStorage.setItem('cda-ln', JSON.stringify({ n: 'testnonce42', t: Date.now() })); }); await p.goto(`${SRV}/login/dev?r=${encodeURIComponent(SITE)}&name=${name}&n=testnonce42`);
    await p.waitForFunction(() => window.UI && UI.ready, null, { timeout: 120000 });
    await p.evaluate(() => { const l = document.getElementById('landing'); if (l) l.hidden = true; if (document.getElementById('pMulti').hidden) { UI.showTitle(true); UI.showMenu(); document.getElementById('mMulti').click(); } });
    await p.waitForFunction(() => !document.getElementById('salon').hidden && __cda.SAL.open, null, { timeout: 30000 }).catch(() => {});
    p.tag = name; return p;
  }
  const pick = (p, t) => p.waitForFunction(t => { const b = document.querySelector('#sidePick:not([hidden]) .sp-card' + (t ? '[data-t="' + t + '"]' : '') + ':not([hidden]):not(:disabled)'); if (b) { b.click(); return true; } return false; }, t || null, { timeout: 60000 });
  const A = await user('Alice'); const Bo = await user('Bob');
  await A.evaluate(() => __map.pick('x/a3', 'Puce GF de test'));
  await A.evaluate(() => { document.getElementById('gNew').click(); document.querySelector('.mcard[data-mode="tdm"]').click(); }); await sleep(300);
  await A.evaluate(() => (async () => { for (let i = 0; i < 6 && !__game.MP.gid; i++) { const b = document.getElementById('suNext'); if (!b || b.hidden) break; b.click(); await new Promise(r => setTimeout(r, 200)); } })());
  await A.waitForFunction(() => __game.MP.gid && window.CDA_SESS && __map.key === 'x/a3', null, { timeout: 60000 });
  await Bo.evaluate(() => document.querySelector('.mcard[data-mode="tdm"]').click());
  await Bo.waitForFunction(() => document.querySelector('#salGames [data-ask]'), null, { timeout: 30000 });
  await Bo.evaluate(() => document.querySelector('#salGames [data-ask]').click());
  await Bo.waitForFunction(() => __game.MP.gid && __map.key === 'x/a3', null, { timeout: 60000 });
  await A.waitForFunction(() => __game.MP.raw && __game.MP.raw.peers().length >= 2, null, { timeout: 30000 });
  await pick(Bo); await sleep(800);
  await A.evaluate(() => { }); await sleep(800);
  await pick(A);
  await Bo.waitForFunction(() => __game.MP.on, null, { timeout: 60000 }); await A.waitForFunction(() => __game.MP.on, null, { timeout: 60000 });
  ok(true, 'partie lancée sur la puce GF chargée à la volée (' + await A.evaluate(() => document.getElementById('sDff').textContent) + ' bascules)');
  const inChip = (x, y) => x > 0 && x < 712 && y > 0 && y < 326;
  for (const m of ['bomb', 'ctf', 'dom', 'inf', 'race', 'tdm']) {
    await A.evaluate(m => { const s = document.getElementById('gmode'); s.value = m; s.dispatchEvent(new Event('change')); }, m);
    const got = await Bo.waitForFunction(m => __game.G && __game.G.mode === m && /live|freeze|wait/.test(__game.G.ph), m, { timeout: 40000 }).then(() => true, () => false);
    await sleep(2500);
    const info = await A.evaluate(m => {
      const g = __game, pos = []; const add = (k, x, y) => pos.push([k, Math.round(x), Math.round(y)]);
      if (m === 'dom') g.DOMS.forEach(d => add('dom', d.x, d.y));
      if (m === 'ctf') ['M', 'D'].forEach(t => add('pin' + t, g.PINS[t].x, g.PINS[t].y));
      if (m === 'race') g.TRACK.slice(0, 3).forEach(n => add('course', n.x, n.gy));
      if (m === 'bomb') g.arena().sites.forEach(s => add('site', s[0], s[1]));
      return { ph: g.G.ph, pos, me: g.me() };
    }, m);
    const okPos = info.pos.every(p => inChip(p[1], p[2])) && inChip(info.me.x, -info.me.z);
    ok(got && okPos, `mode ${m} : ${info.ph}, repères sur la puce GF ${JSON.stringify(info.pos)} · joueur (${Math.round(info.me.x)}, ${Math.round(-info.me.z)})`);
  }
  console.log(errs.length ? 'ERREURS :\n' + errs.join('\n') : 'aucune erreur');
  await br.close();
})();
