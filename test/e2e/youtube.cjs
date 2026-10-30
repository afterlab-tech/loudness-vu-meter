// E2E: load the unpacked extension into Playwright Chromium, play YouTube, read the panel.
// Usage: PW_PATH=<path to playwright module> CHROME_BIN=<Chromium binary> node test/e2e/youtube.cjs <extension dir>
// Screenshots go to a temp dir printed at the end.
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PW_PATH);

const EXT = process.argv[2];
const VIDEO = process.argv[3] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const OUT = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lmeter-e2e-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(OUT, 'profile-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN,
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions', '--headless'],
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=user-gesture-required'],
    viewport: { width: 1280, height: 800 },
    locale: 'ja-JP',
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  console.log('extension id', extId);

  const yt = await ctx.newPage();
  const logs = [];
  yt.on('console', (m) => { if (/lmeter|AudioWorklet|createMediaElementSource/i.test(m.text()) || (m.type() === 'error' && /chrome-extension/.test(m.text()))) logs.push(m.text()); });
  await yt.goto(VIDEO, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  const hooked = await yt.evaluate(() => !!HTMLMediaElement.prototype.__lmeterHooked);
  console.log('page-hook installed:', hooked);

  // Open the side panel UI as a tab and point it at the YouTube tab.
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel/panel.html`);
  await panel.setViewportSize({ width: 380, height: 1000 });
  const ytTabId = await panel.evaluate(async () => { const me = await chrome.tabs.getCurrent(); const all = await chrome.tabs.query({ windowId: me.windowId }); return all.find((t) => t.index === me.index - 1).id; });
  await panel.evaluate((id) => connect(id), ytTabId);
  await sleep(800);

  const read = () => panel.evaluate(() => {
    const t = (id) => document.getElementById(id).querySelector('b')?.textContent ?? document.getElementById(id).textContent;
    const ch = view.chosen && view.chosen.meter;
    return {
      status: document.querySelector('#status span').textContent,
      notice: document.getElementById('notice').hidden ? '' : document.getElementById('notice').textContent,
      S: t('roS'), I: t('roI'), TP: t('roTP'), M: t('miM'), LRA: t('miLRA'), time: t('miTime'),
      vu: ch ? ch.vu.map((v) => +v.toFixed(1)) : null,
      foot: document.getElementById('foot').textContent,
    };
  });
  console.log('before play:', await read());

  // User gesture on the page, then play.
  await yt.bringToFront();
  await yt.mouse.click(400, 300);
  await sleep(1500);
  await yt.evaluate(() => { const v = document.querySelector('video'); if (v && v.paused) v.play().catch(() => {}); });
  await sleep(3000);
  const adShowing = await yt.evaluate(() => !!document.querySelector('.ad-showing'));
  console.log('ad showing:', adShowing);
  if (adShowing) await sleep(20000);

  const vstate = () => yt.evaluate(() => {
    const v = document.querySelector('video');
    const p = document.getElementById('movie_player');
    return {
      paused: v.paused, t: +v.currentTime.toFixed(1), attr: v.getAttribute('data-lmeter'),
      elVolume: v.volume, elMuted: v.muted, playerVolume: p && p.getVolume ? p.getVolume() : null,
      playerMuted: p && p.isMuted ? p.isMuted() : null,
    };
  });

  // Wait out any pre-roll ad.
  for (let i = 0; i < 60 && (await yt.evaluate(() => !!document.querySelector('.ad-showing'))); i++) {
    await yt.evaluate(() => document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button')?.click());
    await sleep(1000);
  }
  console.log('state:', await vstate());

  // Same 7 s passage under different player volume settings: readings must match.
  const conds = [
    { name: 'vol100', vol: 100, mute: false },
    { name: 'vol10', vol: 10, mute: false },
    { name: 'muted', vol: 100, mute: true },
    { name: 'vol100-again', vol: 100, mute: false },
  ];
  const results = [];
  for (const c of conds) {
    await yt.evaluate((c) => {
      const p = document.getElementById('movie_player');
      p.setVolume(c.vol);
      if (c.mute) p.mute(); else p.unMute();
      p.seekTo(30, true);
      p.playVideo();
    }, c);
    await yt.waitForFunction(() => document.querySelector('video').currentTime >= 37, null, { timeout: 30000, polling: 20 });
    const r = await read();
    const st = await vstate();
    results.push({ cond: c.name, at: st.t, S: r.S, M: r.M, vu: r.vu, getterVol: +st.elVolume.toFixed(3), getterMuted: st.elMuted, status: r.status });
    if (c.name === 'muted') await panel.screenshot({ path: path.join(OUT, 'yt-panel-muted.png') });
  }
  console.table(results);

  // SPA navigation to another video: integrated should auto-reset.
  const before = await read();
  await yt.evaluate(() => { const p = document.getElementById('movie_player'); p.loadVideoById('jNQXAC9IVRw'); });
  await sleep(8000);
  for (let i = 0; i < 40 && (await yt.evaluate(() => !!document.querySelector('.ad-showing'))); i++) await sleep(1000);
  await sleep(3000);
  const after = await read();
  console.log('switch video: time before', before.time, 'I', before.I, '-> after', after.time, 'I', after.I, after.status);
  await panel.screenshot({ path: path.join(OUT, 'yt-panel-after-switch.png') });

  console.log('console:', logs.slice(0, 10));
  console.log('screenshots:', OUT);
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
})().catch((e) => { console.error('E2E failed:', e); process.exit(1); });
