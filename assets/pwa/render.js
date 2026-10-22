const { chromium } = require('/root/w/t/node_modules/playwright');
(async () => {
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-proxy-server'] });
  for (const [src, out, n] of [['icon.svg','icon-512.png',512],['icon.svg','icon-192.png',192],['icon-maskable.svg','icon-maskable-512.png',512],['icon.svg','apple-touch-icon.png',180]]) {
    const p = await br.newPage({ viewport: { width: n, height: n } });
    const svg = require('fs').readFileSync('/root/w/pwa/' + src, 'utf8').replace(/width="512" height="512"/, `width="${n}" height="${n}"`);
    await p.setContent(`<html><body style="margin:0">${svg}</body></html>`);
    await p.screenshot({ path: '/root/w/pwa/' + out, omitBackground: false });
    await p.close();
  }
  await br.close();
})();
