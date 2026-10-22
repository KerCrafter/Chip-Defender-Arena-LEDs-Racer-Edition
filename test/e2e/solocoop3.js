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
  const A = await user('Alice');
  await A.evaluate(() => __map.pick('a580', 'LEDs Racer'));
  // Alice lance une partie solo, se déplace, prend la sonde
  await A.evaluate(() => { document.getElementById('pMulti').hidden = true; UI.showMenu && UI.showMenu(); document.getElementById('go').click(); });
  await A.waitForFunction(() => UI.inGame && !__game.MP.on, null, { timeout: 60000 });
  await sleep(2000);
  const pos0 = await A.evaluate(() => { const g = __game; g.P.x += 7; g.P.z -= 5; __expl.wheel(1); __expl.wheel(1); return { x: g.P.x, z: g.P.z, tool: __expl.tool }; });
  console.log('solo', JSON.stringify(pos0));
  await A.evaluate(() => __expl.coop());
  await A.waitForFunction(() => __game.MP.on && __expl.shareUrl(), null, { timeout: 60000 }).catch(() => {});
  const st = await A.evaluate(() => ({ on: __game.MP.on, mode: __game.G && __game.G.mode, me: __game.me(), tool: __expl.tool, url: __expl.shareUrl(), sess: !!window.CDA_SESS }));
  console.log('coop', JSON.stringify(st));
  ok(st.on && st.mode === 'expl', 'la partie solo est devenue une exploration en coopération');
  ok(Math.abs(st.me.x - pos0.x) < 0.5 && Math.abs(st.me.z - pos0.z) < 0.5, 'Alice est restée au même endroit');
  ok(st.tool === pos0.tool, 'même outil en main : ' + st.tool);
  ok(/#s=/.test(st.url), 'lien d\'invitation : ' + st.url.slice(0, 80));
  // Carol n'a pas de compte : elle ouvre le lien, se connecte, et doit arriver dans la partie
  const ctx = await br.newContext({ viewport: { width: 1100, height: 700 } });
  await ctx.addInitScript(() => { if (location.protocol === 'about:') return; window.__noRender = true; try { localStorage.setItem('cda-lang', 'fr'); localStorage.setItem('cda-xr-help', '1'); localStorage.setItem('cda-opts', JSON.stringify({ q: 'low', intro: false })); } catch (e) {} });
  const C = await ctx.newPage(); C.on('pageerror', e => errs.push('Carol ' + e.message));
  await C.goto(st.url); await C.waitForFunction(() => window.UI && UI.ready, null, { timeout: 120000 }); await sleep(3000);
  const c0 = await C.evaluate(() => ({ landing: !document.getElementById('landing').hidden, multi: !document.getElementById('pMulti').hidden, inv: !!localStorage.getItem('cda-invite') }));
  ok(!c0.landing && c0.multi && c0.inv, 'Carol sans compte : pas de page d\'accueil, connexion proposée, invitation gardée ' + JSON.stringify(c0));
  await C.evaluate(() => localStorage.setItem('cda-ln', JSON.stringify({ n: 'testnonce42', t: Date.now() })));
  await C.goto(`${SRV}/login/dev?r=${encodeURIComponent(SITE)}&name=Carol&n=testnonce42`);
  await C.waitForFunction(() => window.UI && UI.ready, null, { timeout: 120000 });
  for (let i = 0; i < 40 && !(await C.evaluate(() => __game.MP.on).catch(() => false)); i++) { await A.evaluate(() => { if (__expl.entry().pop) __expl.entryAnswer(true); }); await sleep(1000); }
  await sleep(3000);
  const c1 = await C.evaluate(() => ({ on: __game.MP.on, gid: __game.MP.gid, mode: __game.G && __game.G.mode, alive: __game.MP.alive, dead: document.body.classList.contains('st-dead'), landing: !document.getElementById('landing').hidden }));
  console.log('Carol', JSON.stringify(c1));
  ok(c1.on && c1.mode === 'expl' && c1.gid === await A.evaluate(() => __game.MP.gid), 'après la connexion, Carol arrive dans la partie du lien');
  ok(c1.alive && !c1.dead, 'Carol est en jeu, pas « éliminée »');
  const pa = await A.evaluate(() => __game.me()), pc = await C.evaluate(() => __game.me());
  ok(Math.hypot(pa.x - pc.x, pa.z - pc.z) < 4, 'Carol apparaît à côté d\'Alice');
  console.log(errs.length ? 'ERREURS :\n' + errs.join('\n') : 'aucune erreur');
  await br.close();
})();
