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
  await A.evaluate(() => __map.pick('a580', 'LEDs Racer'));
  await A.evaluate(() => { document.getElementById('gNew').click(); document.querySelector('.mcard[data-mode="expl"]').click(); }); await sleep(300);
  await A.evaluate(() => (async () => { for (let i = 0; i < 6 && !__game.MP.gid; i++) { const b = document.getElementById('suNext'); if (!b || b.hidden) break; b.click(); await new Promise(r => setTimeout(r, 200)); } })());
  await A.waitForFunction(() => __game.MP.gid && window.CDA_SESS, null, { timeout: 60000 });
  await Bo.evaluate(() => document.querySelector('.mcard[data-mode="expl"]') && 0);
  await Bo.waitForFunction(() => document.querySelector('#salGames [data-ask]'), null, { timeout: 30000 });
  await Bo.evaluate(() => document.querySelector('#salGames [data-ask]').click());
  await Bo.waitForFunction(() => __game.MP.gid, null, { timeout: 60000 });
  await A.waitForFunction(() => __game.MP.raw && __game.MP.raw.peers().length >= 2, null, { timeout: 30000 });
  // exploration : pas de choix de camp ; la partie démarre (bouton « Lancer » de l'hôte si besoin)
  for (const p of [A, Bo]) await p.evaluate(() => { const b = document.querySelector('#sidePick:not([hidden]) .sp-card:not([hidden]):not(:disabled)'); if (b) b.click(); });
  await sleep(1500);
  const st = await A.evaluate(() => ({ on: __game.MP.on, gid: __game.MP.gid, side: !!document.querySelector('#sidePick:not([hidden])'), txt: (document.getElementById('lvGame') || {}).innerText }));
  console.log('A état', JSON.stringify(st).slice(0, 400));
  await A.waitForFunction(() => __game.MP.on, null, { timeout: 60000 }).catch(() => {});
  await Bo.waitForFunction(() => __game.MP.on, null, { timeout: 60000 }).catch(() => {});
  ok(await A.evaluate(() => __game.MP.on) && await Bo.evaluate(() => __game.MP.on), 'partie d\'exploration lancée pour les deux');
  await A.waitForFunction(() => __game.G && __game.G.mode === 'expl' && __game.G.ph === 'live', null, { timeout: 40000 }).catch(() => {});
  ok(await A.evaluate(() => __game.G.mode === 'expl' && __game.G.ph === 'live'), 'mode expl, phase ' + await A.evaluate(() => __game.G.ph));
  await sleep(3000);
  const tools = [await A.evaluate(() => __expl.tool), await Bo.evaluate(() => __expl.tool)];
  ok(tools[0] === 'scan' && tools[1] === 'scan', 'scanner en main pour les deux : ' + tools);
  ok(await A.evaluate(() => !!(__game.G.sim && __game.G.sim.f)), 'état de la simulation publié par l\'hôte');
  const aHost = await A.evaluate(() => !!__game.MP.host);
  const H = aHost ? A : Bo, C = aHost ? Bo : A; console.log('hôte :', aHost ? 'Alice' : 'Bob');
  ok(await H.evaluate(() => !!(__game.G.sim && __game.G.sim.f)), 'état de la simulation publié par l\'hôte');
  await C.evaluate(() => { __expl.bench('hz', 0); }); await sleep(600);
  await C.evaluate(() => { __expl.bench('run'); }); await sleep(600);
  await C.evaluate(() => { __expl.bench('ui', 2); });
  await sleep(4000);
  console.log('dbg H', JSON.stringify(await H.evaluate(() => __expl.dbg())), 'C', JSON.stringify(await C.evaluate(() => __expl.dbg())));
  const a1 = await H.evaluate(() => __expl.sim()), b1 = await C.evaluate(() => __expl.sim());
  ok(a1.run && a1.hz === 0 && (a1.ui & 4), `l'hôte applique les actions de l'invité : marche ${a1.run}, vitesse ${a1.hz}, entrées ${a1.ui}, coup ${a1.c}`);
  ok(b1.run && b1.ui === a1.ui && b1.c > 1000, `l'invité suit : coup ${b1.c} (hôte ${a1.c}), entrées ${b1.ui}`);
  await H.evaluate(() => __expl.bench('run')); await sleep(2500);
  const a2 = await H.evaluate(() => __expl.sim()), b2 = await C.evaluate(() => __expl.sim());
  ok(!a2.run && a2.c === b2.c && a2.ff === b2.ff, `arrêt : mêmes coups (${a2.c} / ${b2.c}) et mêmes bascules : ${a2.ff === b2.ff}`);
  for (const [P, Q, n] of [[C, H, 'invité → hôte'], [H, C, 'hôte → invité']]) {
    const r = await P.evaluate(() => { __expl.wheel(1); const c = __expl.find(/countdown\[1\]/); const sh = __expl.probeShapeNear(c); return [c, sh, __expl.probe(sh).slice(0, 80)]; });
    await sleep(2500);
    ok(await Q.evaluate(() => __expl.others()) > 0, `sonde ${n} : ${JSON.stringify(r)} → ${await Q.evaluate(() => __expl.others())} formes`);
  }
  await H.evaluate(() => { const c = __expl.find(/green_debouncer\.cnt\[3\]/); __expl.probe(__expl.probeShapeNear(c)); });
  await sleep(3000);
  const nPow = await C.evaluate(() => __expl.others());
  ok(nPow >= 3000, 'réseau d\'alimentation sondé par l\'hôte, visible chez l\'invité : ' + nPow + ' formes');
  // discussion en cours de partie
  await A.evaluate(() => { document.getElementById('bChat').click(); document.getElementById('gChatIn').value = 'Regarde le compteur !'; document.getElementById('gChatF').requestSubmit(); });
  await sleep(2500);
  const seen = await Bo.evaluate(() => document.getElementById('gChatL').innerText);
  ok(/Regarde le compteur/.test(seen), 'message d\'Alice affiché en bas à gauche chez Bob : ' + seen.replace(/\n/g, ' | '));
  // réglages : banc réservé à l'hôte, vol interdit
  await H.evaluate(() => { const g = id => document.getElementById(id); g('geb').value = '1'; g('gef').value = '0'; __game.MP.cfg = Object.assign({}, __game.MP.cfg, { eb: 1, ef: 0, at: Date.now() }); });
  await sleep(2500);
  const before = await H.evaluate(() => __expl.sim().ui);
  await C.evaluate(() => __expl.bench('ui', 1)); await sleep(2000);
  const after = await H.evaluate(() => __expl.sim().ui);
  ok(before === after, `banc réservé à l'hôte : l'invité ne change rien (${before} → ${after})`);
  const fly = await C.evaluate(() => { document.getElementById('bFly').click(); return [__game.me().fly, document.getElementById('bFly').hidden]; });
  ok(!fly[0] && fly[1], 'vol interdit chez l\'invité : ' + JSON.stringify(fly));
  ok(await A.evaluate(() => __game.MP.bots ? __game.MP.bots.length : 0) === 0, 'pas de bots');
  console.log(errs.length ? 'ERREURS :\n' + errs.join('\n') : 'aucune erreur');
  await br.close();
})();
