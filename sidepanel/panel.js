'use strict';

/*
 * Side panel: connects to the content scripts of the active tab (all frames),
 * picks the frame that is currently playing and renders VU + loudness meters.
 */

const BAR_MIN = -48;
const HIST_POINTS = 600; // 60 s of 100 ms short-term values
const HIST_MIN = -42;
const HIST_MAX = 0;
const VU_FULL = Math.pow(10, 3 / 20); // +3 VU = full deflection
const VU_MARKS = [-20, -10, -7, -5, -3, -2, -1, 0, 1, 2, 3];
const VU_MINOR = [-15, -9, -8, -6, -4, -2.5, -1.5, -0.5, 0.5, 1.5, 2.5];
const STALE_MS = 2500;
const PEAK_LED_DBTP = -1;
const PEAK_LED_HOLD_MS = 1000;
const DEFAULTS = { target: -14, vuRef: -18, autoReset: true, theme: 'auto' };

const settings = { ...DEFAULTS };
const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

let windowId = null;
let tabId = null;
let port = null;
let portError = false;
let reconnectTimer = 0;
const frames = new Map(); // fid -> { status, meter, meterAt, playingAt, lastBlk, top }
const histories = new Map(); // tabId -> [[S, M], ...]

const view = {
  chosen: null,
  needle: [0, 0],
  bars: { M: BAR_MIN, S: BAR_MIN, I: BAR_MIN, L: BAR_MIN, R: BAR_MIN },
  ledUntil: [0, 0],
  lastFrame: performance.now(),
  lastText: 0,
};

// ---------------------------------------------------------------- formatting

const minus = (s) => s.replace('-', '−');
const fmt = (v, digits = 1) => (v == null ? '—' : v <= -119 ? '−∞' : minus(v.toFixed(digits)));
const signed = (v) => (v == null ? '—' : (v > 0 ? '+' : '') + minus(v.toFixed(1)));
const fmtTime = (sec) => {
  const s = Math.floor(sec || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

function loudnessTone(v) {
  if (v == null) return '';
  const d = v - settings.target;
  if (d > 3) return 'over';
  if (d > 1) return 'warn';
  if (d >= -1) return 'ok';
  return '';
}

function peakTone(v) {
  if (v == null) return '';
  if (v > PEAK_LED_DBTP) return 'over';
  if (v > -3) return 'warn';
  return '';
}

// ---------------------------------------------------------------- connection

function history() {
  if (!histories.has(tabId)) histories.set(tabId, []);
  return histories.get(tabId);
}

function connect(id) {
  if (port) {
    const old = port;
    port = null;
    old.disconnect();
  }
  if (id !== tabId) frames.clear();
  tabId = id;
  portError = false;
  if (id == null) return;
  let p;
  try {
    p = chrome.tabs.connect(id, { name: 'lmeter' });
  } catch {
    portError = true;
    return;
  }
  port = p;
  p.onMessage.addListener(onMessage);
  p.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (port === p) {
      port = null;
      portError = true;
      frames.clear();
    }
  });
  p.postMessage({ type: 'config', autoReset: settings.autoReset });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(tabId), 400);
}

function onMessage(m) {
  if (!m || !m.fid) return;
  let f = frames.get(m.fid);
  if (!f) {
    f = { status: null, meter: null, meterAt: 0, playingAt: 0, lastBlk: -1, top: m.top };
    frames.set(m.fid, f);
  }
  const now = performance.now();
  if (m.type === 'status') {
    f.status = m;
    if (m.playing) f.playingAt = now;
  } else if (m.type === 'meter') {
    f.meter = m;
    f.meterAt = now;
    if (m.playing) f.playingAt = now;
    if (m.blk !== f.lastBlk) {
      f.lastBlk = m.blk;
      if (view.chosen === f) {
        const h = history();
        h.push([m.S, m.M]);
        if (h.length > HIST_POINTS) h.splice(0, h.length - HIST_POINTS);
      }
    }
  } else if (m.type === 'reset') {
    if (view.chosen === f || !view.chosen) history().length = 0;
    f.lastBlk = -1;
  }
}

function chooseFrame() {
  const now = performance.now();
  let best = null;
  let bestKey = -1;
  for (const f of frames.values()) {
    if (!f.meter || now - f.meterAt > STALE_MS) continue;
    const key = (f.meter.playing ? 1e12 : 0) + f.playingAt;
    if (key > bestKey) {
      best = f;
      bestKey = key;
    }
  }
  return best;
}

function deriveStatus(chosen) {
  if (tabId == null) return { kind: 'idle', text: 'タブなし' };
  if (portError || !port) {
    return {
      kind: 'error',
      text: '利用できません',
      notice: 'このタブでは計測できません。chrome:// などの特殊ページでなければ、ページを再読み込みしてください（拡張機能の導入・更新前に開いたページには接続できません）。',
    };
  }
  const list = [...frames.values()];
  const withMedia = list.filter((f) => f.status && f.status.media > 0);
  if (chosen && chosen.meter.playing) return { kind: 'live', text: 'LIVE' };
  const err = withMedia.find((f) => f.status.state === 'error');
  if (err) return { kind: 'error', text: 'エラー', notice: err.status.error };
  if (withMedia.some((f) => f.status.state === 'gesture')) {
    return {
      kind: 'wait',
      text: 'クリック待ち',
      notice: 'ブラウザの自動再生制限のため、ページ内を一度クリック（または再生ボタンを押す）すると計測を開始します。',
    };
  }
  if (!withMedia.length && !chosen) return { kind: 'idle', text: 'メディアなし' };
  if (chosen) return { kind: 'wait', text: '一時停止中' };
  return { kind: 'wait', text: '再生待ち' };
}

// ---------------------------------------------------------------- theme

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
let C = {}; // canvas colours from the CSS theme tokens

function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  C = {
    bezel: v('--cv-bezel'),
    track: v('--cv-track'),
    groove: v('--cv-groove'),
    grid: v('--cv-grid'),
    axis: v('--cv-axis'),
    label: v('--cv-label'),
    histBg: v('--cv-hist-bg'),
    histM: v('--cv-hist-m'),
    histS: v('--cv-hist-s'),
    target: v('--cv-target'),
    over: v('--cv-over'),
    hold: v('--cv-hold'),
    lo: v('--meter-lo'),
    ok: v('--meter-ok'),
    warn: v('--meter-warn'),
    hot: v('--meter-over'),
  };
}

const isDark = () => (settings.theme === 'auto' ? darkQuery.matches : settings.theme === 'dark');

function applyTheme() {
  if (settings.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
  readPalette();
}

// ---------------------------------------------------------------- canvas utils

function prep(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (cv.width !== pw || cv.height !== ph) {
    cv.width = pw;
    cv.height = ph;
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// ---------------------------------------------------------------- VU meter

const vuToPos = (vu) => Math.pow(10, vu / 20) / VU_FULL;

function drawVuMeter(g, x, y, w, h, pos, label, ledOn) {
  g.fillStyle = C.bezel;
  roundRect(g, x, y, w, h, 8);
  g.fill();

  const fx = x + 4;
  const fy = y + 4;
  const fw = w - 8;
  const fh = h - 8;
  const s = fw / 160;
  const face = g.createLinearGradient(0, fy, 0, fy + fh);
  face.addColorStop(0, '#fcf0cf');
  face.addColorStop(0.55, '#f0dca9');
  face.addColorStop(1, '#d8bf86');
  roundRect(g, fx, fy, fw, fh, 5);
  g.fillStyle = face;
  g.fill();

  g.save();
  roundRect(g, fx, fy, fw, fh, 5);
  g.clip();

  const cx = fx + fw / 2;
  const cy = fy + fh * 1.16;
  const rArc = fh * 0.82;
  const a0 = -0.7;
  const a1 = 0.7;
  const ang = (p) => a0 + (a1 - a0) * p;
  const pt = (a, r) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  const p0 = vuToPos(0);

  // Scale arc with the red zone from 0 VU to +3.
  g.lineCap = 'butt';
  g.strokeStyle = '#2b2416';
  g.lineWidth = Math.max(1, 1.1 * s);
  g.beginPath();
  g.arc(cx, cy, rArc, -Math.PI / 2 + ang(0), -Math.PI / 2 + ang(p0));
  g.stroke();
  g.strokeStyle = '#c42a1f';
  g.lineWidth = Math.max(2, 4 * s);
  g.beginPath();
  g.arc(cx, cy, rArc + 2 * s, -Math.PI / 2 + ang(p0), -Math.PI / 2 + ang(1));
  g.stroke();

  const tick = (p, len, color, width) => {
    const a = ang(p);
    const [x1, y1] = pt(a, rArc);
    const [x2, y2] = pt(a, rArc + len);
    g.strokeStyle = color;
    g.lineWidth = width;
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
  };

  for (const m of VU_MINOR) tick(vuToPos(m), 5 * s, m >= 0 ? '#c42a1f' : '#3a3122', Math.max(0.8, 0.8 * s));

  const fontSize = Math.max(10, 10.5 * s);
  g.font = `600 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const m of VU_MARKS) {
    const p = vuToPos(m);
    const red = m > 0;
    tick(p, 9 * s, red ? '#c42a1f' : '#221c12', Math.max(1, 1.3 * s));
    const [lx, ly] = pt(ang(p), rArc + 15 * s);
    g.fillStyle = red ? '#c42a1f' : '#221c12';
    g.fillText(red ? `+${m}` : String(Math.abs(m)), lx, ly);
  }

  // Modulation % scale under the arc (100% = 0 VU).
  g.font = `600 ${Math.max(8, 7.5 * s)}px ui-sans-serif, system-ui, sans-serif`;
  for (let pct = 0; pct <= 100; pct += 20) {
    const a = ang((pct / 100) * p0);
    const [x1, y1] = pt(a, rArc - 2 * s);
    const [x2, y2] = pt(a, rArc - 6 * s);
    g.strokeStyle = '#4d4230';
    g.lineWidth = Math.max(0.8, 0.8 * s);
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
    if (pct % 50 === 0) {
      const [lx, ly] = pt(a, rArc - 12 * s);
      g.fillStyle = '#54482f';
      g.fillText(String(pct), lx, ly);
    }
  }

  g.fillStyle = '#3a3020';
  g.font = `700 ${Math.max(11, 17 * s)}px Georgia, "Times New Roman", serif`;
  g.fillText('VU', cx, fy + fh * 0.62);

  g.textAlign = 'left';
  g.font = `700 ${Math.max(10.5, 11 * s)}px ui-sans-serif, system-ui, sans-serif`;
  g.fillStyle = '#4d4230';
  g.fillText(label, fx + 7 * s, fy + fh - 9 * s);

  // Peak LED.
  const lx = fx + fw - 11 * s;
  const ly = fy + 11 * s;
  const lr = Math.max(2.5, 3.6 * s);
  if (ledOn) {
    const glow = g.createRadialGradient(lx, ly, 0, lx, ly, lr * 3.2);
    glow.addColorStop(0, 'rgba(255,60,40,0.85)');
    glow.addColorStop(1, 'rgba(255,60,40,0)');
    g.fillStyle = glow;
    g.beginPath();
    g.arc(lx, ly, lr * 3.2, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = ledOn ? '#ff3b2a' : '#8d6b55';
  g.beginPath();
  g.arc(lx, ly, lr, 0, Math.PI * 2);
  g.fill();
  g.textAlign = 'right';
  g.font = `700 ${Math.max(8, 7.5 * s)}px ui-sans-serif, system-ui, sans-serif`;
  g.fillStyle = '#54482f';
  g.fillText('PEAK', lx - lr - 3 * s, ly);

  // Needle.
  const na = ang(clamp(pos, -0.03, 1.06));
  const [tx, ty] = pt(na, rArc + 13 * s);
  g.strokeStyle = 'rgba(0,0,0,0.18)';
  g.lineWidth = Math.max(1.2, 1.6 * s);
  g.beginPath();
  g.moveTo(cx + 2 * s, cy);
  g.lineTo(tx + 2 * s, ty + 1.5 * s);
  g.stroke();
  g.strokeStyle = '#17130d';
  g.lineWidth = Math.max(1, 1.3 * s);
  g.beginPath();
  g.moveTo(cx, cy);
  g.lineTo(tx, ty);
  g.stroke();

  // Pivot hood.
  const hood = g.createLinearGradient(0, cy - fh * 0.42, 0, fy + fh);
  hood.addColorStop(0, '#2c3038');
  hood.addColorStop(1, '#121418');
  g.fillStyle = hood;
  g.beginPath();
  g.arc(cx, cy, fh * 0.42, 0, Math.PI * 2);
  g.fill();

  // Glass highlight.
  const glass = g.createLinearGradient(0, fy, 0, fy + fh * 0.5);
  glass.addColorStop(0, 'rgba(255,255,255,0.28)');
  glass.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = glass;
  g.fillRect(fx, fy, fw, fh * 0.5);
  g.restore();
}

function drawVu(now) {
  const cv = $('vu');
  const gap = 8;
  const mw = (cv.clientWidth - gap) / 2;
  const want = `${Math.round(clamp(mw / 1.4, 90, 240))}px`;
  if (cv.style.height !== want) cv.style.height = want;
  const { g, h } = prep(cv);
  drawVuMeter(g, 0, 0, mw, h, view.needle[0], 'L', now < view.ledUntil[0]);
  drawVuMeter(g, mw + gap, 0, mw, h, view.needle[1], 'R', now < view.ledUntil[1]);
}

// ---------------------------------------------------------------- bars

function drawBars(meter) {
  const { g, w, h } = prep($('bars'));
  const top = 6;
  const bottom = h - 22;
  const axisW = 28;
  const y = (db) => top + ((bottom - top) * (0 - clamp(db, BAR_MIN, 0))) / -BAR_MIN;

  g.font = '600 10.5px ui-monospace, Menlo, monospace';
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  for (let db = 0; db >= BAR_MIN; db -= 6) {
    const yy = Math.round(y(db)) + 0.5;
    g.fillStyle = C.axis;
    g.fillText(db === 0 ? '0' : minus(String(db)), axisW - 4, yy);
    g.strokeStyle = C.grid;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(axisW, yy);
    g.lineTo(w, yy);
    g.stroke();
  }

  const area = w - axisW - 4;
  const unit = area / 6.4;
  const barW = Math.min(30, unit * 0.66);
  const cols = [
    { key: 'M', label: 'M', group: 'lufs', c: 0.5 },
    { key: 'S', label: 'S', group: 'lufs', c: 1.5 },
    { key: 'I', label: 'I', group: 'lufs', c: 2.5 },
    { key: 'L', label: 'TP L', group: 'tp', c: 3.9 },
    { key: 'R', label: 'TP R', group: 'tp', c: 4.9 },
  ];
  const cxOf = (c) => axisW + 4 + unit * (c + 0.45);

  const t = settings.target;
  const gradFor = (group) => {
    const gr = g.createLinearGradient(0, bottom, 0, top);
    const stop = (db) => clamp((db - BAR_MIN) / -BAR_MIN, 0, 1);
    if (group === 'lufs') {
      gr.addColorStop(0, C.lo);
      gr.addColorStop(stop(t - 1), C.ok);
      gr.addColorStop(stop(t + 1), C.warn);
      gr.addColorStop(stop(t + 3), C.hot);
      gr.addColorStop(1, C.hot);
    } else {
      gr.addColorStop(0, C.lo);
      gr.addColorStop(stop(-9), C.ok);
      gr.addColorStop(stop(-3), C.warn);
      gr.addColorStop(stop(-1), C.hot);
      gr.addColorStop(1, C.hot);
    }
    return gr;
  };
  const grads = { lufs: gradFor('lufs'), tp: gradFor('tp') };
  const holds = meter
    ? { M: meter.maxM, S: meter.maxS, I: null, L: meter.tpMax[0], R: meter.tpMax[1] }
    : {};

  g.textAlign = 'center';
  for (const col of cols) {
    const x = Math.round(cxOf(col.c) - barW / 2);
    g.fillStyle = C.track;
    g.fillRect(x, top, barW, bottom - top);
    const v = view.bars[col.key];
    if (v > BAR_MIN) {
      const yy = y(v);
      g.fillStyle = grads[col.group];
      g.fillRect(x, yy, barW, bottom - yy);
    }
    // LED segment grooves.
    g.fillStyle = C.groove;
    for (let yy = bottom - 3; yy > top; yy -= 3) g.fillRect(x, yy, barW, 1);

    const hold = holds[col.key];
    if (hold != null && hold > BAR_MIN) {
      g.fillStyle = C.hold;
      g.fillRect(x, Math.round(y(hold)) - 1, barW, 2);
    }
    g.fillStyle = C.label;
    g.font = '700 11.5px ui-sans-serif, system-ui, sans-serif';
    g.fillText(col.label, x + barW / 2, bottom + 12);
  }

  const line = (db, x1, x2, color, text) => {
    const yy = Math.round(y(db)) + 0.5;
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.setLineDash([3, 2]);
    g.beginPath();
    g.moveTo(x1, yy);
    g.lineTo(x2, yy);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = color;
    g.font = '700 10px ui-monospace, Menlo, monospace';
    g.textAlign = 'left';
    g.fillText(text, x2 + 3, yy);
    g.textAlign = 'center';
  };
  line(t, cxOf(0.5) - barW / 2 - 3, cxOf(2.5) + barW / 2 + 3, C.target, minus(String(t)));
  line(-1, cxOf(3.9) - barW / 2 - 3, cxOf(4.9) + barW / 2 + 3, C.over, '−1');
}

// ---------------------------------------------------------------- history

function drawHistory() {
  const { g, w, h } = prep($('hist'));
  const top = 4;
  const bottom = h - 4;
  const left = 28;
  const y = (v) => top + ((bottom - top) * (HIST_MAX - clamp(v, HIST_MIN, HIST_MAX))) / (HIST_MAX - HIST_MIN);

  g.fillStyle = C.histBg;
  g.fillRect(left, top, w - left, bottom - top);
  g.font = '600 10.5px ui-monospace, Menlo, monospace';
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  for (let v = -6; v > HIST_MIN; v -= 6) {
    const yy = Math.round(y(v)) + 0.5;
    g.strokeStyle = C.grid;
    g.beginPath();
    g.moveTo(left, yy);
    g.lineTo(w, yy);
    g.stroke();
    if (v % 12 === 0 && Math.abs(v - settings.target) > 3) {
      g.fillStyle = C.axis;
      g.fillText(minus(String(v)), left - 4, yy);
    }
  }

  const pts = history();
  const dx = (w - left) / (HIST_POINTS - 1);
  const xOf = (i) => w - (pts.length - 1 - i) * dx;

  if (pts.length > 1) {
    // Momentary as a faint area.
    g.beginPath();
    g.moveTo(xOf(0), bottom);
    pts.forEach((p, i) => g.lineTo(xOf(i), y(p[1] == null ? HIST_MIN : p[1])));
    g.lineTo(xOf(pts.length - 1), bottom);
    g.closePath();
    g.fillStyle = C.histM;
    g.fill();

    g.beginPath();
    let pen = false;
    pts.forEach((p, i) => {
      if (p[0] == null) {
        pen = false;
        return;
      }
      if (pen) g.lineTo(xOf(i), y(p[0]));
      else g.moveTo(xOf(i), y(p[0]));
      pen = true;
    });
    g.strokeStyle = C.histS;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.stroke();
  }

  const ty = Math.round(y(settings.target)) + 0.5;
  g.strokeStyle = C.target;
  g.lineWidth = 1;
  g.setLineDash([4, 3]);
  g.beginPath();
  g.moveTo(left, ty);
  g.lineTo(w, ty);
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = C.target;
  g.textAlign = 'right';
  g.fillText(minus(String(settings.target)), left - 4, ty);
}

// ---------------------------------------------------------------- text

function setReadout(id, value, tone, text) {
  const el = $(id);
  el.querySelector('b').textContent = text ?? fmt(value);
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

function updateText(meter, status) {
  const st = $('status');
  st.dataset.kind = status.kind;
  st.querySelector('span').textContent = status.text;
  const notice = $('notice');
  notice.hidden = !status.notice;
  if (status.notice) notice.textContent = status.notice;

  const top = [...frames.values()].find((f) => f.top && f.status);
  const title = (view.chosen && view.chosen.status && view.chosen.status.title) || (top && top.status.title) || '—';
  $('source').textContent = title;
  $('source').title = title;

  const fallback = [...frames.values()].some((f) => f.status && f.status.meter === 'script-processor');
  $('foot').textContent = fallback
    ? 'プレーヤーの音量・ミュートは計測値に影響しません。（このページでは互換モードで計測中）'
    : 'プレーヤーの音量・ミュートは計測値に影響しません。';

  if (!meter) return;
  setReadout('roS', meter.S, loudnessTone(meter.S));
  setReadout('roI', meter.I, loudnessTone(meter.I));
  const tpMax = Math.max(meter.tpMax[0], meter.tpMax[1]);
  setReadout('roTP', tpMax, peakTone(tpMax));
  $('miM').textContent = fmt(meter.M);
  $('miLRA').textContent = meter.LRA == null ? '—' : `${meter.LRA.toFixed(1)}`;
  $('miMaxS').textContent = fmt(meter.maxS);
  $('miDelta').textContent = meter.I == null ? '—' : signed(meter.I - settings.target);
  $('miTime').textContent = fmtTime(meter.time);
}

// ---------------------------------------------------------------- frame loop

function frame(now) {
  const dt = Math.min(0.1, (now - view.lastFrame) / 1000);
  view.lastFrame = now;
  const chosen = chooseFrame();
  view.chosen = chosen;
  const meter = chosen ? chosen.meter : null;
  const live = !!(meter && meter.playing);

  for (let c = 0; c < 2; c++) {
    const target = live ? vuToPos(meter.vu[c] - settings.vuRef) : 0;
    view.needle[c] += (target - view.needle[c]) * Math.min(1, dt * (live ? 30 : 6));
    if (live && meter.tp[c] > PEAK_LED_DBTP) view.ledUntil[c] = now + PEAK_LED_HOLD_MS;
  }

  const ease = (cur, target, rate) => cur + (target - cur) * Math.min(1, dt * rate);
  const b = view.bars;
  const val = (v) => (v == null ? BAR_MIN - 1 : v);
  if (meter) {
    b.M = ease(b.M, val(meter.M), 14);
    b.S = ease(b.S, val(meter.S), 14);
    b.I = ease(b.I, val(meter.I), 14);
    // Peak bars: instant attack, 24 dB/s fall.
    b.L = Math.max(live ? meter.tp[0] : BAR_MIN - 1, b.L - 24 * dt);
    b.R = Math.max(live ? meter.tp[1] : BAR_MIN - 1, b.R - 24 * dt);
  } else {
    for (const k of Object.keys(b)) b[k] = Math.max(BAR_MIN - 1, b[k] - 24 * dt);
  }

  drawVu(now);
  drawBars(meter);
  drawHistory();
  if (now - view.lastText > 100) {
    view.lastText = now;
    updateText(meter, deriveStatus(chosen));
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- settings UI

function renderSettings() {
  for (const btn of $('target').querySelectorAll('button')) {
    btn.setAttribute('aria-checked', String(Number(btn.dataset.v) === settings.target));
  }
  for (const btn of $('theme').querySelectorAll('button')) {
    btn.setAttribute('aria-checked', String(btn.dataset.v === settings.theme));
  }
  $('vuRef').value = String(settings.vuRef);
  $('vuRefLabel').textContent = `0 VU = ${minus(String(settings.vuRef))} dBFS`;
  $('autoReset').checked = settings.autoReset;
}

function save() {
  chrome.storage.local.set({ ...settings }).catch(() => {});
  applyTheme();
  renderSettings();
}

function bindUi() {
  $('target').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    settings.target = Number(btn.dataset.v);
    save();
  });
  $('theme').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    settings.theme = btn.dataset.v;
    save();
  });
  $('themeBtn').addEventListener('click', () => {
    settings.theme = isDark() ? 'light' : 'dark';
    save();
  });
  darkQuery.addEventListener('change', () => settings.theme === 'auto' && applyTheme());
  $('vuRef').addEventListener('change', (e) => {
    settings.vuRef = Number(e.target.value);
    save();
  });
  $('autoReset').addEventListener('change', (e) => {
    settings.autoReset = e.target.checked;
    save();
    if (port) port.postMessage({ type: 'config', autoReset: settings.autoReset });
  });
  $('reset').addEventListener('click', () => {
    if (port) port.postMessage({ type: 'reset' });
    history().length = 0;
  });
}

async function init() {
  try {
    Object.assign(settings, await chrome.storage.local.get(DEFAULTS));
  } catch {
    // defaults
  }
  applyTheme();
  renderSettings();
  bindUi();

  const win = await chrome.windows.getCurrent();
  windowId = win.id;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  connect(tab ? tab.id : null);

  chrome.tabs.onActivated.addListener((info) => {
    if (info.windowId === windowId) connect(info.tabId);
  });
  chrome.tabs.onUpdated.addListener((id, info) => {
    if (id === tabId && info.status === 'complete') scheduleReconnect();
  });
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg && msg.type === 'lmeter-hello' && sender.tab && sender.tab.id === tabId) scheduleReconnect();
  });

  requestAnimationFrame(frame);
}

init();
