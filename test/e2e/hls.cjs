// E2E: hls.js demo page (MSE playback of an .m3u8) with the extension loaded.
// Usage: PW_PATH=<path to playwright module> CHROME_BIN=<Chromium binary> node test/e2e/hls.cjs <extension dir>
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PW_PATH);

const EXT = process.argv[2];
const PAGE = 'https://hlsjs.video-dev.org/demo/';
const OUT = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lmeter-e2e-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(OUT, 'profile-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN,
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions', '--headless'],
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    viewport: { width: 1280, height: 900 },
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;

  const pg = await ctx.newPage();
  await pg.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('video', { timeout: 30000 });
  await sleep(3000);

  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel/panel.html`);
  const tabId = await panel.evaluate(async () => {
    const me = await chrome.tabs.getCurrent();
    const all = await chrome.tabs.query({ windowId: me.windowId });
    return all.find((t) => t.index === me.index - 1).id;
  });
  await panel.evaluate((id) => connect(id), tabId);
  await sleep(800);

  const read = () => panel.evaluate(() => ({
    status: document.querySelector('#status span').textContent,
    notice: document.getElementById('notice').hidden ? '' : document.getElementById('notice').textContent,
    S: document.querySelector('#roS b').textContent,
    M: document.getElementById('miM').textContent,
    TP: document.querySelector('#roTP b').textContent,
    vu: view.chosen && view.chosen.meter ? view.chosen.meter.vu.map((v) => +v.toFixed(1)) : null,
    fallback: /互換モード/.test(document.getElementById('foot').textContent),
  }));

  await pg.bringToFront();
  await pg.mouse.click(10, 10);
  const info = await pg.evaluate(async () => {
    const v = document.querySelector('video');
    v.muted = false;
    await v.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 4000));
    return { src: v.currentSrc.slice(0, 40), paused: v.paused, t: v.currentTime, attr: v.getAttribute('data-lmeter') };
  });
  console.log('video:', info);

  const rows = [];
  for (const c of [{ vol: 1, muted: false }, { vol: 0.05, muted: false }, { vol: 1, muted: true }]) {
    await pg.evaluate((c) => {
      const v = document.querySelector('video');
      v.volume = c.vol;
      v.muted = c.muted;
      v.currentTime = 20;
    }, c);
    await pg.waitForFunction(() => document.querySelector('video').currentTime >= 26, null, { timeout: 40000, polling: 20 });
    rows.push({ ...c, ...(await read()) });
  }
  console.table(rows);
  await panel.screenshot({ path: path.join(OUT, 'hls-panel.png') });
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
})().catch((e) => { console.error('E2E failed:', e); process.exit(1); });
