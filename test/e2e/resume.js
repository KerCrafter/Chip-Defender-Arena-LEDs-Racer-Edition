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
  await A.waitForFunction(() => __game.MP.gid && __game.MP.on, null, { timeout: 60000 });
  const gid = await A.evaluate(() => __game.MP.gid);
  await Bo.waitForFunction(() => document.querySelector('#salGames [data-ask]'), null, { timeout: 30000 }).catch(() => {});
  // Bob rejoint par le lien d'invitation
  await A.evaluate(() => __expl.coop()); await sleep(800);
  const url = await A.evaluate(() => __expl.shareUrl());
  await Bo.goto('about:blank'); await Bo.goto(url); await Bo.waitForFunction(() => window.UI && UI.ready, null, { timeout: 120000 });
  await Bo.waitForFunction(() => __game.MP.on, null, { timeout: 60000 });
  await sleep(3000);
  const hA = await A.evaluate(() => location.hash), hB = await Bo.evaluate(() => location.hash);
  ok(/^#s=/.test(hA) && url.endsWith(hA) && hB === hA, 'la barre d\'adresse porte le lien d\'invitation chez Alice et Bob : ' + hA.slice(0, 30));
  // Alice (créatrice) recharge la page (comme une mise à jour)
  const pa0 = await A.evaluate(() => { const g = __game; g.P.x += 3; return g.me(); });
  await sleep(2500);
  await A.reload(); await sleep(6000);
  const bw = await Bo.evaluate(() => ({ on: __game.MP.on, wait: !document.getElementById('netWait').hidden, txt: document.getElementById('netWait').innerText.replace(/\n/g, ' | ') }));
  ok(bw.on && /Alice a perdu la connexion/.test(bw.txt), 'Bob reste dans la partie pendant l\'absence de la créatrice : ' + JSON.stringify(bw));
  await A.waitForFunction(() => window.UI && UI.ready, null, { timeout: 120000 });
  await A.waitForFunction(() => __game.MP.on, null, { timeout: 60000 }).catch(() => {});
  await sleep(3000);
  const a1 = await A.evaluate(() => ({ on: __game.MP.on, gid: __game.MP.gid, own: __game.MP.gdOwn, mode: __game.G && __game.G.mode, me: __game.me() }));
  console.log('Alice après rechargement', JSON.stringify(a1));
  ok(a1.on && a1.gid === gid && a1.own && a1.mode === 'expl', 'Alice revient toute seule dans sa partie, toujours créatrice, même code');
  ok(Math.hypot(a1.me.x - pa0.x, a1.me.z - pa0.z) < 0.6, 'Alice reprend sa place');
  await sleep(2500);
  const b2 = await Bo.evaluate(() => ({ on: __game.MP.on, gid: __game.MP.gid, wait: !document.getElementById('netWait').hidden }));
  console.log('b2', JSON.stringify(b2), await Bo.evaluate(() => JSON.stringify({ cnt: __game.MP.raw && __game.MP.raw.count(), peers: __game.MP.raw && __game.MP.raw.peers().map(p => [p.peer.slice(0,4), p.sameTab, p.presence && p.presence.gid, p.presence && p.presence.gd && p.presence.gd.st]), nw: __expl.dbg ? 0 : 0 }))); ok(b2.on && b2.gid === gid && !b2.wait, 'Bob toujours dans la même partie, bandeau d\'attente retiré');
  // Bob recharge à son tour
  const pb0 = await Bo.evaluate(() => __game.me());
  await Bo.reload(); await Bo.waitForFunction(() => window.UI && UI.ready, null, { timeout: 120000 });
  await Bo.waitForFunction(() => __game.MP.on, null, { timeout: 60000 }).catch(() => {});
  await sleep(3000);
  const b3 = await Bo.evaluate(() => ({ on: __game.MP.on, gid: __game.MP.gid, me: __game.me() }));
  ok(b3.on && b3.gid === gid, 'Bob revient tout seul dans la partie après rechargement');
  ok(Math.hypot(b3.me.x - pb0.x, b3.me.z - pb0.z) < 0.6, 'Bob reprend sa place');
  // le lien d'invitation d'origine marche encore
  const Ca = await user('Carol');
  await Ca.goto('about:blank'); await Ca.goto(url); await Ca.waitForFunction(() => window.UI && UI.ready, null, { timeout: 120000 });
  await Ca.waitForFunction(() => __game.MP.on, null, { timeout: 60000 }).catch(() => {});
  ok(await Ca.evaluate(() => __game.MP.on && __game.MP.gid) === gid, 'le lien d\'invitation reste bon après le retour de la créatrice');
  // reconnexion à la salle (sortie de veille)
  await Bo.evaluate(() => __expl.rejoin()); await sleep(6000);
  const b4 = await Bo.evaluate(() => ({ on: __game.MP.on, gid: __game.MP.gid, peers: __game.MP.raw ? __game.MP.raw.count() : -1 }));
  ok(b4.on && b4.gid === gid && b4.peers >= 2, 'reconnexion à la salle sans quitter la partie : ' + JSON.stringify(b4));
  // veille du téléphone : Bob perd toutes ses liaisons (comme au réveil) ; il ne doit pas accuser l'hôte, et se reconnecte
  await Bo.evaluate(() => { window.__nwLog = []; const el = document.getElementById('netWait'); new MutationObserver(() => window.__nwLog.push(el.hidden ? '' : el.innerText.replace(/\n/g, ' | '))).observe(el, { attributes: true, childList: true, subtree: true, characterData: true }); __game.MP.raw.leave(); __expl.wake(); });
  await sleep(12000);
  const b5 = await Bo.evaluate(() => ({ on: __game.MP.on, gid: __game.MP.gid, peers: __game.MP.raw ? __game.MP.raw.count() : -1, log: [...new Set(window.__nwLog)].filter(Boolean) }));
  console.log('veille', JSON.stringify(b5));
  ok(b5.on && b5.gid === gid && b5.peers >= 1, 'après une coupure, Bob se reconnecte et reste dans la partie');
  ok(!b5.log.some(t => /perdu la connexion|lost the connection/.test(t) && /Alice/.test(t)), 'Bob ne croit pas que l\'hôte est parti');
  const seenB = await A.evaluate(() => (__game.MP.peers || []).filter(p => p.presence && /Bob/.test(p.presence.nick || '')).length);
  ok(seenB >= 1, 'Alice revoit Bob');
  await Ca.evaluate(() => { __game.UI && __game.UI.openMenu && __game.UI.openMenu(); document.getElementById('gLeave').click(); }); await sleep(2500);
  ok(await Ca.evaluate(() => location.hash) === '', 'en quittant la partie, l\'adresse redevient normale');
  console.log(errs.length ? 'ERREURS :\n' + errs.join('\n') : 'aucune erreur');
  await br.close();
})();
