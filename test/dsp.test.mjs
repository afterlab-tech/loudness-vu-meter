// Run: node --test test/*.test.mjs
// Verifies src/dsp.js against EBU Tech 3341 / 3342 style signals, true peak and VU ballistics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = { globalThis: {} };
ctx.globalThis = ctx;
vm.runInNewContext(readFileSync(new URL('../src/dsp.js', import.meta.url), 'utf8'), ctx);
const { LMeterDSP } = ctx;

const FS = 48000;
const CHUNK = 128;

// Feed segments of [dBFS peak, seconds, freq?, phase?] as a stereo sine; return the last report.
function run(segments, { fs = FS, collect = false } = {}) {
  const dsp = new LMeterDSP(fs);
  let last = null;
  const reports = [];
  dsp.onReport = (r) => {
    last = r;
    if (collect) reports.push(r);
  };
  let n = 0;
  const buf = new Float32Array(CHUNK);
  for (const seg of segments) {
    const [db, sec, freq = 1000, phase = 0] = seg;
    const amp = db === null ? 0 : Math.pow(10, db / 20);
    const total = Math.round(sec * fs);
    for (let done = 0; done < total; done += CHUNK) {
      const len = Math.min(CHUNK, total - done);
      for (let i = 0; i < len; i++, n++) buf[i] = amp * Math.sin((2 * Math.PI * freq * n) / fs + phase);
      const view = buf.subarray(0, len);
      dsp.process([view, view], len);
    }
  }
  return collect ? reports : last;
}

const near = (actual, expected, tol, label) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual?.toFixed?.(3)} != ${expected} ±${tol}`);

test('Tech 3341 case 1: -23 dBFS stereo sine reads -23 LUFS (M, S, I)', () => {
  const r = run([[-23, 20]]);
  near(r.M, -23, 0.1, 'M');
  near(r.S, -23, 0.1, 'S');
  near(r.I, -23, 0.1, 'I');
});

test('Tech 3341 case 2: -33 dBFS reads -33 LUFS', () => {
  const r = run([[-33, 20]]);
  near(r.I, -33, 0.1, 'I');
});

test('Tech 3341 case 3: relative gate (-36/-23/-36)', () => {
  const r = run([[-36, 10], [-23, 60], [-36, 10]]);
  near(r.I, -23, 0.1, 'I');
});

test('Tech 3341 case 4: absolute + relative gate (-72/-36/-23/-36/-72)', () => {
  const r = run([[-72, 10], [-36, 10], [-23, 60], [-36, 10], [-72, 10]]);
  near(r.I, -23, 0.1, 'I');
});

test('Tech 3341 case 5: -26/-20/-26 integrates to -23', () => {
  const r = run([[-26, 20], [-20, 20.1], [-26, 20]]);
  near(r.I, -23, 0.1, 'I');
});

test('44.1 kHz sample rate gives the same loudness', () => {
  const r = run([[-23, 20]], { fs: 44100 });
  near(r.I, -23, 0.1, 'I');
});

test('Tech 3342 LRA case 1: -20 then -30 dBFS → 10 LU', () => {
  const r = run([[-20, 20], [-30, 20]]);
  near(r.LRA, 10, 1, 'LRA');
});

test('Tech 3342 LRA case 2: -20 then -15 dBFS → 5 LU', () => {
  const r = run([[-20, 20], [-15, 20]]);
  near(r.LRA, 5, 1, 'LRA');
});

test('Silence is gated out of integrated loudness', () => {
  const r = run([[null, 5]]);
  assert.equal(r.I, null);
  assert.equal(r.M, null);
});

test('True peak finds the inter-sample peak of fs/4 sine at 45°', () => {
  // Samples land at ±A/√2, so sample peak is -9.03 dBFS while the true peak is -6.02 dBTP.
  const r = run([[-6.0206, 2, FS / 4, Math.PI / 4]]);
  near(r.pkMax[0], -9.03, 0.05, 'sample peak');
  near(r.tpMax[0], -6.02, 0.3, 'true peak');
});

test('True peak of a 1 kHz sine equals its peak', () => {
  const r = run([[-3, 2]]);
  near(r.tpMax[0], -3, 0.1, 'true peak');
});

test('True peak at 96 kHz (designed 4x filter)', () => {
  const r = run([[-6.0206, 2, 96000 / 4, Math.PI / 4]], { fs: 96000 });
  near(r.tpMax[0], -6.02, 0.2, 'true peak');
});

test('True peak at 96 kHz: 1 kHz sine is not overestimated', () => {
  const r = run([[-3, 2]], { fs: 96000 });
  near(r.tpMax[0], -3, 0.1, 'true peak');
});

test('VU: steady -18 dBFS sine reads -18 (0 VU at -18 ref)', () => {
  const r = run([[-18, 3]]);
  near(r.vu[0], -18, 0.1, 'VU');
});

test('VU ballistics: 99% at ~300 ms, overshoot ≤ 1.5%', () => {
  const reports = run([[-18, 2]], { collect: true });
  const target = Math.pow(10, -18 / 20);
  const lin = reports.map((r) => Math.pow(10, r.vu[0] / 20) / target);
  const period = 1 / 50;
  const firstAt99 = lin.findIndex((v) => v >= 0.99) * period;
  const overshoot = Math.max(...lin) - 1;
  assert.ok(firstAt99 >= 0.26 && firstAt99 <= 0.34, `99% reached at ${firstAt99.toFixed(3)} s`);
  assert.ok(overshoot >= 0.005 && overshoot <= 0.02, `overshoot ${(overshoot * 100).toFixed(2)}%`);
});

test('reset() clears integrated measurement', () => {
  const dsp = new LMeterDSP(FS);
  let last;
  dsp.onReport = (r) => (last = r);
  const buf = new Float32Array(CHUNK).map((_, i) => 0.1 * Math.sin((2 * Math.PI * 1000 * i) / FS));
  for (let i = 0; i < 200; i++) dsp.process([buf, buf], CHUNK);
  assert.ok(last.I !== null);
  dsp.command({ type: 'reset' });
  for (let i = 0; i < 10; i++) dsp.process([buf, buf], CHUNK);
  assert.equal(last.I, null);
  assert.equal(last.time, 0);
});
