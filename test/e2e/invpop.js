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
  // Bob joue en solo
  await Bo.evaluate(() => { document.getElementById('pMulti').hidden = true; UI.showMenu && UI.showMenu(); document.getElementById('go').click(); });
  await Bo.waitForFunction(() => UI.inGame && !__game.MP.on, null, { timeout: 60000 });
  await sleep(2500);
  const solo = await Bo.evaluate(() => ({ tool: __expl.tool, xray: document.getElementById('xray') ? !document.getElementById('xray').hidden : null }));
  ok(solo.tool === 'scan', 'solo : un outil en main d\'office (' + solo.tool + ')');
  await Bo.keyboard.press('e'); await sleep(400);
  ok(await Bo.evaluate(() => __expl.tool) === 'scan', 'E ne range plus l\'outil');
  // Alice ouvre une exploration et invite Bob
  await A.evaluate(() => __map.pick('a580', 'LEDs Racer'));
  await A.evaluate(() => { document.getElementById('gNew').click(); document.querySelector('.mcard[data-mode="expl"]').click(); }); await sleep(300);
  await A.evaluate(() => (async () => { for (let i = 0; i < 6 && !__game.MP.gid; i++) { const b = document.getElementById('suNext'); if (!b || b.hidden) break; b.click(); await new Promise(r => setTimeout(r, 200)); } })());
  await A.waitForFunction(() => __game.MP.gid && __game.MP.on, null, { timeout: 60000 });
  await A.evaluate(() => { UI.openMenu(); document.getElementById('mMulti').click(); }); await sleep(1500);
  await A.waitForFunction(() => document.querySelector('#gmInvL [data-invite]'), null, { timeout: 30000 }).catch(() => {});
  await A.evaluate(() => { const b = document.querySelector('#gmInvL [data-invite]'); if (b) b.click(); });
  await Bo.waitForFunction(() => !document.getElementById('invPop').hidden, null, { timeout: 20000 }).catch(() => {});
  const pop = await Bo.evaluate(() => ({ vis: !document.getElementById('invPop').hidden, txt: document.getElementById('invPop').innerText.replace(/\n/g, ' | '), z: getComputedStyle(document.getElementById('invPop')).zIndex }));
  ok(pop.vis, 'Bob, en solo, voit la fenêtre d\'invitation : ' + pop.txt);
  await Bo.keyboard.press('Enter');
  await Bo.waitForFunction(() => __game.MP.on && __game.G && __game.G.mode === 'expl', null, { timeout: 60000 }).catch(() => {});
  await sleep(2500);
  const b2 = await Bo.evaluate(() => ({ on: __game.MP.on, mode: __game.G && __game.G.mode, tool: __expl.tool, xrayOverlay: !document.getElementById('bXray').hidden }));
  ok(b2.on && b2.mode === 'expl', 'Entrée : Bob rejoint l\'exploration d\'Alice');
  ok(b2.tool === 'scan', 'outil en main en coopération');
  const xr = await Bo.evaluate(() => __expl.dbg().xray); ok(xr === false, 'vias visibles en coopération (rayon X : ' + xr + ')');
  console.log('rayon X chez Bob', xr, JSON.stringify(b2));
  console.log(errs.length ? 'ERREURS :\n' + errs.join('\n') : 'aucune erreur');
  await br.close();
})();
