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
  const st = p => p.evaluate(() => ({ salon: !document.getElementById('salon').hidden, auth: !document.getElementById('lvAuth').hidden, status: document.getElementById('mpStatus').textContent, name: document.getElementById('salName').textContent, gid: __game.MP.gid, sess: window.CDA_SESS && { r: CDA_SESS.r, own: CDA_SESS.own, pv: CDA_SESS.pv, anon: CDA_SESS.anon }, mem: __game.MP.raw ? __game.MP.raw.peers().length : 0 }));

  // 0. sans compte : écran de connexion
  {
    const ctx = await br.newContext();
    await ctx.addInitScript(() => { if (location.protocol === 'about:') return; window.__noRender = true; localStorage.setItem('cda-land', '0'); localStorage.setItem('cda-opts', JSON.stringify({ q: 'low', intro: false })); });
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push('anon ' + e.message));
    await p.goto(SITE); await p.waitForFunction(() => window.UI && UI.ready, null, { timeout: 120000 });
    await p.evaluate(() => { document.getElementById('landing').hidden = true; UI.showTitle(true); UI.showMenu(); document.getElementById('mMulti').click(); });
    await sleep(2500);
    const s = await p.evaluate(() => ({ auth: !document.getElementById('lvAuth').hidden, btns: [...document.querySelectorAll('#lvAuth [data-login]')].filter(b => !b.hidden).map(b => b.dataset.login), raw: !!__game.MP.raw, row: !document.getElementById('roomRow').hidden, direct: !document.getElementById('authDirect').hidden, badge: (document.getElementById('envBadge') || {}).textContent || '' }));
    ok(/^STAGING · [0-9a-f]{7}$/.test(s.badge), 'bandeau d\'environnement : ' + s.badge);
    ok(s.auth && !s.raw && !s.row && s.direct && !s.btns.length, 'sans compte : écran de connexion, aucune salle ouverte ' + JSON.stringify(s));
    await p.screenshot({ path: SHOTS + '/sec_login.png' });
    // vrai parcours : connexion directe (staging) → serveur → retour au jeu, panneau en ligne rouvert
    await p.fill('#authDirectName', 'Testeuse'); await p.evaluate(() => document.querySelector('#authDirect button').click());
    await p.waitForURL(u => /index\.html$/.test(u.toString()), { timeout: 30000 }); await p.waitForFunction(() => window.UI && UI.ready, null, { timeout: 120000 });
    await p.waitForFunction(() => !document.getElementById('pMulti').hidden && !document.getElementById('salon').hidden, null, { timeout: 30000 }).then(() => p.evaluate(() => __cda.AUTH && __cda.AUTH.user).then(u => ok(u && u.id === 'direct:testeuse' && u.name === 'Testeuse', 'après connexion directe : retour au salon, identité ' + JSON.stringify(u && { id: u.id, name: u.name }))), () => ok(false, 'pas de retour au salon'));
    await ctx.close();
  }

  const pick = (p, t) => p.waitForFunction(t => { const b = document.querySelector('#sidePick:not([hidden]) .sp-card' + (t ? '[data-t="' + t + '"]' : '') + ':not([hidden]):not(:disabled)'); if (b) { b.click(); return true; } return false; }, t || null, { timeout: 60000 });
  const A = await user('Alice');
  let a = await st(A);
  ok(a.salon && a.name === 'Alice', 'Alice connectée, salon affiché ' + JSON.stringify(a));
  await A.waitForFunction(() => /Salon ·/.test(document.getElementById('mpStatus').textContent), null, { timeout: 15000 }).catch(() => {});
  await A.fill('#salIn', 'Bonjour le salon !'); await A.press('#salIn', 'Enter');
  await sleep(800);
  const Bo = await user('Bob');
  await Bo.waitForFunction(() => /Bonjour le salon/.test(document.getElementById('salLog').textContent), null, { timeout: 15000 }).then(() => ok(true, 'Bob voit le message d\'Alice (historique chiffré)'), () => ok(false, 'Bob ne voit pas le message'));
  await A.waitForFunction(() => /Bob/.test(document.getElementById('salOn').textContent), null, { timeout: 30000 }).then(() => ok(true, 'Alice voit Bob en ligne'), () => ok(false, 'Bob absent de la liste en ligne'));
  await Bo.fill('#salIn', 'Salut Alice'); await Bo.press('#salIn', 'Enter');
  await A.waitForFunction(() => /Salut Alice/.test(document.getElementById('salLog').textContent), null, { timeout: 10000 }).then(() => ok(true, 'Alice reçoit la réponse de Bob'), () => ok(false, 'réponse non reçue'));
  await sleep(2500); await A.screenshot({ path: SHOTS + '/sec_salon.png' });

  // 1. partie publique
  await A.evaluate(() => { document.getElementById('gNew').click(); document.querySelector('.mcard[data-mode="tdm"]').click(); }); await sleep(300);
  await A.evaluate(() => (async () => { for (let i = 0; i < 6 && !__game.MP.gid; i++) { const b = document.getElementById('suNext'); if (!b || b.hidden) break; b.click(); await new Promise(r => setTimeout(r, 200)); } })());
  await A.waitForFunction(() => __game.MP.gid && window.CDA_SESS, null, { timeout: 30000 });
  a = await st(A); ok(a.sess && a.sess.own && !a.sess.pv, 'Alice a créé une partie publique dans sa propre salle ' + JSON.stringify(a));
  await Bo.evaluate(() => document.querySelector('.mcard[data-mode="tdm"]').click());
  await Bo.waitForFunction(() => document.querySelector('#salGames [data-ask]'), null, { timeout: 30000 }).then(() => ok(true, 'Bob voit la partie d\'Alice dans la liste'), () => ok(false, 'partie absente de la liste'));
  await Bo.evaluate(() => document.querySelector('#salGames [data-ask]').click());
  await Bo.waitForFunction(() => __game.MP.gid, null, { timeout: 40000 }).then(() => ok(true, 'Bob a reçu la clé et rejoint la partie'), () => ok(false, 'Bob n\'a pas rejoint'));
  let b = await st(Bo); a = await st(A);
  ok(b.gid === a.gid && b.sess && b.sess.r === a.sess.r, 'même partie, même salle ' + JSON.stringify({ a: a.gid, b: b.gid }));
  await A.waitForFunction(() => __game.MP.raw && __game.MP.raw.peers().length >= 2, null, { timeout: 30000 }).then(() => ok(true, 'Alice voit Bob dans la salle de la partie (WebRTC direct)'), () => ok(false, 'pas de lien WebRTC'));
  await pick(Bo); await sleep(800);
  await A.evaluate(() => { }); await sleep(800);
  await pick(A);
  await Bo.waitForFunction(() => __game.MP.on, null, { timeout: 30000 }).then(() => ok(true, 'la partie démarre chez Bob'), () => ok(false, 'pas de démarrage'));
  // renouvellement du jeton pendant la partie : salon et salle de partie restent ouverts
  await A.evaluate(() => __cda.renew()); await Bo.evaluate(() => __cda.renew()); await sleep(1500);
  const rs = await Bo.evaluate(() => ({ open: __cda.SAL.open, on: __game.MP.on, peers: __game.MP.raw && __game.MP.raw.peers().length }));
  ok(rs.open && rs.on && rs.peers >= 2, 'jeton renouvelé en pleine partie, rien n\'est coupé ' + JSON.stringify(rs));
  await sleep(1500);
  // 2. Alice quitte : Bob est renvoyé, les sessions sont fermées
  await A.evaluate(() => { __game.UI && __game.UI.openMenu && __game.UI.openMenu(); document.getElementById('gLeave').click(); });
  await Bo.waitForFunction(() => !__game.MP.on && !__game.MP.gid, null, { timeout: 30000 }).then(() => ok(true, 'Bob renvoyé au salon quand l\'hôte part'), () => ok(false, 'Bob toujours en partie'));
  await sleep(1200); a = await st(A); b = await st(Bo);
  ok(!a.sess && !b.sess, 'les deux sont sortis de la salle de partie ' + JSON.stringify({ a: a.sess, b: b.sess }));

  // 3. partie privée : invisible dans la liste, invitation depuis le salon
  const C = await user('Carol');
  await A.evaluate(() => { document.getElementById('lBack') && document.getElementById('lBack').click(); }); await sleep(200);
  await A.evaluate(() => { document.getElementById('gNew').click(); document.querySelector('.mcard[data-mode="ctf"]').click(); }); await sleep(200);
  await A.evaluate(() => { document.querySelector('[data-pv="1"]').click(); return (async () => { for (let i = 0; i < 6 && !__game.MP.gid; i++) { const b = document.getElementById('suNext'); if (!b || b.hidden) break; b.click(); await new Promise(r => setTimeout(r, 200)); } })(); });
  await A.waitForFunction(() => __game.MP.gid && window.CDA_SESS && CDA_SESS.pv, null, { timeout: 30000 });
  await C.evaluate(() => document.querySelector('.mcard[data-mode="ctf"]').click());
  await sleep(25000);
  ok(await C.evaluate(() => !document.querySelector('#salGames [data-ask]') && !document.querySelector('#salGames [data-ask]')), 'la partie privée n\'apparaît nulle part');
  await A.waitForFunction(() => document.querySelector('#gmInvL [data-invite]'), null, { timeout: 20000 });
  const n = await A.evaluate(() => { const b = [...document.querySelectorAll('#gmInvL [data-invite]')].find(x => /Carol/.test(x.textContent)); if (b) b.click(); return !!b; });
  ok(n, 'Alice invite Carol depuis le salon de sa partie');
  await C.waitForFunction(() => document.querySelector('#salInv [data-inv]'), null, { timeout: 15000 }).then(() => ok(true, 'Carol reçoit l\'invitation'), () => ok(false, 'invitation non reçue'));
  await C.evaluate(() => document.querySelector('.lv-h #lBack') && document.getElementById('lBack').click());
  await C.evaluate(() => document.querySelector('#salInv [data-inv]').click());
  await C.waitForFunction(() => __game.MP.gid, null, { timeout: 40000 }).then(() => ok(true, 'Carol entre dans la partie privée'), () => ok(false, 'Carol n\'entre pas'));
  // lien d'invitation : contient la clé dans le fragment
  const link = await A.evaluate(() => { let u = ''; const w = navigator.clipboard; return (window.CDA_SESS && location.origin + location.pathname + '#s=' + [CDA_SESS.r, CDA_SESS.key, __game.MP.gid, CDA_SESS.anon ? 1 : 0].join('.')); });
  ok(/#s=[a-z0-9]+\.[A-Za-z0-9_-]+\.[a-z0-9]+\.[01]$/.test(link), 'lien d\'invitation avec la clé après # : ' + link.replace(/\.[A-Za-z0-9_-]{20,}\./, '.<clé>.'));
  await C.screenshot({ path: SHOTS + '/sec_carol.png' });
  // 4. Bob ouvre le lien d'invitation
  await Bo.goto(link); await Bo.waitForFunction(() => window.UI && UI.ready, null, { timeout: 120000 });
  await Bo.waitForFunction(() => __game.MP.gid, null, { timeout: 40000 }).then(() => ok(true, 'Bob entre par le lien d\'invitation'), () => ok(false, 'lien sans effet'));
  await A.waitForFunction(() => __game.MP.raw && __game.MP.raw.peers().length >= 3, null, { timeout: 30000 }).then(() => ok(true, '3 joueurs dans la partie privée'), () => ok(false, 'pas 3 joueurs'));
  await A.screenshot({ path: SHOTS + '/sec_game.png' });
  await A.evaluate(() => { const e = document.getElementById('gmInv'); e && e.scrollIntoView(); }); await A.screenshot({ path: SHOTS + '/sec_game2.png' });
  await Bo.evaluate(() => document.getElementById('gLeave').click()); await sleep(800); await Bo.screenshot({ path: SHOTS + '/sec_bob_salon.png' });
  // 5. déconnexion
  await C.evaluate(() => { document.getElementById('gLeave').click(); }); await sleep(500);
  await C.evaluate(() => document.getElementById('salOut').click()); await sleep(500);
  const c = await st(C);
  ok(c.auth && !c.sess, 'Carol déconnectée : retour à l\'écran de connexion ' + JSON.stringify(c));
  console.log(errs.length ? 'ERREURS :\n' + errs.join('\n') : 'aucune erreur');
  await br.close();
})().catch(e => { console.error(e); process.exit(1); });
