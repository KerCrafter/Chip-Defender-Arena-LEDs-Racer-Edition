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
  const A = await user('Alice'); const Bo = await user('Bob'); const Ca = await user('Carol');
  await A.evaluate(() => __map.pick('a580', 'LEDs Racer'));
  await A.evaluate(() => { document.getElementById('pMulti').hidden = true; UI.showMenu && UI.showMenu(); document.getElementById('go').click(); });
  await A.waitForFunction(() => UI.inGame, null, { timeout: 60000 }); await sleep(1500);
  await A.evaluate(() => __expl.coop());
  await A.waitForFunction(() => __game.MP.on && __expl.shareUrl(), null, { timeout: 60000 });
  const url = await A.evaluate(() => __expl.shareUrl()), gid = await A.evaluate(() => __game.MP.gid);
  console.log('entrée Alice', JSON.stringify(await A.evaluate(() => __expl.entry())));
  // Bob arrive par le lien : il attend l'accord
  await Bo.goto('about:blank'); await Bo.goto(url); await Bo.waitForFunction(() => window.UI && UI.ready, null, { timeout: 120000 });
  await sleep(9000);
  const b0 = await Bo.evaluate(() => ({ on: __game.MP.on, gid: __game.MP.gid }));


  const a0 = await A.evaluate(() => __expl.entry());
  ok(!b0.on && b0.gid === gid, 'Bob, arrivé par le lien, attend l\'accord : ' + JSON.stringify(b0));
  ok(a0.pop && a0.q.includes('Bob'), 'Alice voit la demande de Bob : ' + JSON.stringify(a0));
  await A.evaluate(() => __expl.entryAnswer(true));
  await Bo.waitForFunction(() => __game.MP.on, null, { timeout: 30000 }).catch(() => {});
  ok(await Bo.evaluate(() => __game.MP.on), 'accepté : Bob entre dans la partie');
  // Bob quitte puis revient par le même lien : il entre directement
  await Bo.evaluate(() => { UI.openMenu(); document.getElementById('gLeave').click(); }); await sleep(2000);
  await Bo.goto('about:blank'); await Bo.goto(url); await Bo.waitForFunction(() => window.UI && UI.ready, null, { timeout: 120000 });
  await Bo.waitForFunction(() => __game.MP.on, null, { timeout: 45000 }).catch(() => {});
  ok(await Bo.evaluate(() => __game.MP.on), 'Bob revient par le lien sans redemander');
  ok(!(await A.evaluate(() => __expl.entry().pop)), 'pas de nouvelle demande chez Alice');
  // Carol arrive par le lien, Alice refuse
  await Ca.goto('about:blank'); await Ca.goto(url); await Ca.waitForFunction(() => window.UI && UI.ready, null, { timeout: 120000 });
  await A.waitForFunction(() => __expl.entry().q.includes('Carol'), null, { timeout: 30000 }).catch(() => {});
  await A.evaluate(() => __expl.entryAnswer(false));
  await sleep(5000);
  const c1 = await Ca.evaluate(() => ({ on: __game.MP.on, gid: __game.MP.gid }));
  ok(!c1.on && !c1.gid, 'refusée : Carol ne rentre pas ' + JSON.stringify(c1));
  console.log(errs.length ? 'ERREURS :\n' + errs.join('\n') : 'aucune erreur');
  await br.close();
})();
