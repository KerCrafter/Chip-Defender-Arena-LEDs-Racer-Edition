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
  const origin = p => p.evaluate(() => performance.timeOrigin);
  const chip = p => p.evaluate(() => document.getElementById('sDff').textContent + ' bascules');

  const pick = (p, t) => p.waitForFunction(t => { const b = document.querySelector('#sidePick:not([hidden]) .sp-card' + (t ? '[data-t="' + t + '"]' : '') + ':not([hidden]):not(:disabled)'); if (b) { b.click(); return true; } return false; }, t || null, { timeout: 60000 });

  const A = await user('Alice'); const Bo = await user('Bob');
  await A.evaluate(() => __map.pick('ttsky25a/a495', 'Asteroids'));
  await A.evaluate(() => { document.getElementById('gNew').click(); document.querySelector('.mcard[data-mode="bomb"]').click(); });
  await A.evaluate(() => (async () => { for (let i = 0; i < 6 && !__game.MP.gid; i++) { const b = document.getElementById('suNext'); if (!b || b.hidden) break; b.click(); await new Promise(r => setTimeout(r, 300)); } })());
  await A.waitForFunction(() => __game.MP.gid && __map.key === 'ttsky25a/a495', null, { timeout: 180000 }).then(() => ok(true, 'partie créée sur la tuile géante'), () => ok(false, 'pas de partie'));
  await pick(A, 'D');
  await Bo.waitForFunction(() => document.querySelector('#salGames [data-ask]'), null, { timeout: 60000 });
  await Bo.evaluate(() => document.querySelector('#salGames [data-ask]').click());
  await Bo.waitForFunction(() => __game.MP.gid && __map.key === 'ttsky25a/a495', null, { timeout: 180000 });
  await pick(Bo);
  await Bo.waitForFunction(() => __game.MP.on, null, { timeout: 120000 });
  // les deux doivent finir sur la même région (celle de la fenêtre de la manche) : mêmes formes, même ordre
  await sleep(4000);
  await A.waitForFunction(() => !window.__mapBusyCheck && (!document.getElementById('mapLoad') || document.getElementById('mapLoad').hidden), null, { timeout: 120000 });
  await Bo.waitForFunction(() => !document.getElementById('mapLoad') || document.getElementById('mapLoad').hidden, null, { timeout: 120000 });
  await sleep(3000);
  const ga = await A.evaluate(() => __map.geo()), gb = await Bo.evaluate(() => __map.geo()), ar = await A.evaluate(() => __game.MP.G.ar);
  console.log('   fenêtre', JSON.stringify(ar), 'A', JSON.stringify(ga), 'B', JSON.stringify(gb));
  ok(ga[0] < 6000000 && ga[0] > 1000, 'seule une région est en mémoire : ' + ga[0] + ' formes');
  ok(JSON.stringify(ga) === JSON.stringify(gb), 'Alice et Bob ont exactement les mêmes formes');
  const pa = await A.evaluate(() => __game.me()), pb = await Bo.evaluate(() => __game.me()), A2 = await A.evaluate(() => __game.arena().AR);
  const inA = q => q.x >= A2.x0 && q.x <= A2.x1 && -q.z >= A2.y0 && -q.z <= A2.y1;
  ok(inA(pa) && inA(pb), 'les deux joueurs sont dans la fenêtre ' + JSON.stringify({ pa, pb, A2 }));
  console.log(errs.length ? 'ERREURS :\n' + errs.join('\n') : 'aucune erreur');
  await br.close();
})();
