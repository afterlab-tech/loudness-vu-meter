/*
 * LMeter DSP — ITU-R BS.1770-4 / EBU R128 loudness, true peak and VU ballistics.
 *
 * Shared by the AudioWorklet (worklet.js), the ScriptProcessor fallback in the
 * content script, and the Node tests. Exposes globalThis.LMeterDSP.
 */
(function (root) {
  'use strict';

  const LOUDNESS_OFFSET = -0.691;
  const ABSOLUTE_GATE = -70;
  // Relative gates expressed as energy ratios: -10 LU (integrated), -20 LU (LRA).
  const RELATIVE_GATE_RATIO = Math.pow(10, -10 / 10);
  const LRA_GATE_RATIO = Math.pow(10, -20 / 10);
  const DB_FLOOR = -120;
  const REPORT_HZ = 50;

  // VU needle: 2nd-order system, ~1.5% overshoot, reaches 99% of a steady
  // reading in 300 ms (IEC 60268-17). Tuned in test/dsp.test.mjs.
  const VU_ZETA = 0.8;
  const VU_OMEGA = 12.4;

  // LRA short-term histogram: 0.1 LU bins from -70 to +10 LUFS.
  const LRA_MIN = -70;
  const LRA_BINS = 800;

  // BS.1770-4 Annex 2 — 48-tap, 4-phase interpolation filter for 4x true peak.
  const TP_PHASES_4X = [
    [0.0017089843750, 0.0109863281250, -0.0196533203125, 0.0332031250000, -0.0594482421875, 0.1373291015625,
      0.9721679687500, -0.1022949218750, 0.0476074218750, -0.0266113281250, 0.0148925781250, -0.0083007812500],
    [-0.0291748046875, 0.0292968750000, -0.0517578125000, 0.0891113281250, -0.1665039062500, 0.4650878906250,
      0.7797851562500, -0.2003173828125, 0.1015625000000, -0.0582275390625, 0.0330810546875, -0.0189208984375],
    [-0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625000000, -0.2003173828125, 0.7797851562500,
      0.4650878906250, -0.1665039062500, 0.0891113281250, -0.0517578125000, 0.0292968750000, -0.0291748046875],
    [-0.0083007812500, 0.0148925781250, -0.0266113281250, 0.0476074218750, -0.1022949218750, 0.9721679687500,
      0.1373291015625, -0.0594482421875, 0.0332031250000, -0.0196533203125, 0.0109863281250, 0.0017089843750],
  ];

  const energyToLufs = (e) => (e > 0 ? LOUDNESS_OFFSET + 10 * Math.log10(e) : -Infinity);
  const ampToDb = (a) => (a > 0 ? Math.max(DB_FLOOR, 20 * Math.log10(a)) : DB_FLOOR);
  const orNull = (v) => (Number.isFinite(v) ? Math.max(DB_FLOOR, v) : null);

  // K-weighting (pre-filter shelf + RLB high-pass), recomputed for any sample rate.
  function kWeighting(fs) {
    let f0 = 1681.974450955533;
    const G = 3.999843853973347;
    let Q = 0.7071752369554196;
    let K = Math.tan((Math.PI * f0) / fs);
    const Vh = Math.pow(10, G / 20);
    const Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q + K * K;
    const shelf = {
      b0: (Vh + (Vb * K) / Q + K * K) / a0,
      b1: (2 * (K * K - Vh)) / a0,
      b2: (Vh - (Vb * K) / Q + K * K) / a0,
      a1: (2 * (K * K - 1)) / a0,
      a2: (1 - K / Q + K * K) / a0,
    };
    f0 = 38.13547087602444;
    Q = 0.5003270373238773;
    K = Math.tan((Math.PI * f0) / fs);
    a0 = 1 + K / Q + K * K;
    const highpass = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
    return { shelf, highpass };
  }

  function kaiserSincPhases(factor, taps) {
    const n = factor * taps;
    const beta = 6;
    const bessel0 = (x) => {
      let sum = 1;
      let term = 1;
      for (let k = 1; k < 30; k++) {
        term *= (x / (2 * k)) * (x / (2 * k));
        sum += term;
      }
      return sum;
    };
    // Integer centre so phase 0 lands on the original samples.
    const center = n / 2;
    const fc = 0.5 / factor;
    const h = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = i - center;
      const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
      const r = Math.min(1, Math.abs(x) / center);
      h[i] = (sinc * bessel0(beta * Math.sqrt(1 - r * r))) / bessel0(beta);
      sum += h[i];
    }
    const phases = [];
    for (let p = 0; p < factor; p++) {
      const ph = [];
      for (let j = 0; j < taps; j++) ph.push((h[p + j * factor] * factor) / sum);
      phases.push(ph);
    }
    return phases;
  }

  // Polyphase oversampling peak detector for one channel.
  class TruePeak {
    constructor(fs) {
      this.factor = fs < 192000 ? 4 : 2;
      this.taps = 12;
      const phases = fs < 96000 ? TP_PHASES_4X : kaiserSincPhases(this.factor, this.taps);
      this.coef = phases.map((p) => Float64Array.from(p));
      // Doubled history so the newest `taps` samples are always contiguous.
      this.hist = new Float64Array(this.taps * 2);
      this.pos = 0;
    }

    push(x) {
      const ax = x < 0 ? -x : x;
      const taps = this.taps;
      this.pos = this.pos === 0 ? taps - 1 : this.pos - 1;
      const hist = this.hist;
      const pos = this.pos;
      hist[pos] = x;
      hist[pos + taps] = x;
      let peak = ax;
      for (let p = 0; p < this.factor; p++) {
        const c = this.coef[p];
        let y = 0;
        for (let j = 0; j < taps; j++) y += c[j] * hist[pos + j];
        if (y < 0) y = -y;
        if (y > peak) peak = y;
      }
      return peak;
    }
  }

  class LMeterDSP {
    constructor(sampleRate) {
      this.fs = sampleRate;
      const { shelf, highpass } = kWeighting(sampleRate);
      this.shelf = shelf;
      this.hp = highpass;
      // Filter state: [shelf z1, shelf z2, hp z1, hp z2] per channel.
      this.kState = [new Float64Array(4), new Float64Array(4)];
      this.tp = [new TruePeak(sampleRate), new TruePeak(sampleRate)];
      this.vuY = new Float64Array(2);
      this.vuV = new Float64Array(2);
      this.vuDt = 1 / sampleRate;

      this.subLen = Math.round(sampleRate / 10);
      this.repLen = Math.round(sampleRate / REPORT_HZ);
      this.subCount = 0;
      this.repCount = 0;
      this.sumSq = new Float64Array(2);
      this.peakInt = new Float64Array(2);
      this.tpInt = new Float64Array(2);
      this.onReport = null;
      this.reset();
    }

    reset() {
      this.ring = new Float64Array(30);
      this.ringPos = 0;
      this.subTotal = 0;
      this.blocks = new Float64Array(4096);
      this.blockCount = 0;
      this.gateSum = 0;
      this.lraHist = new Uint32Array(LRA_BINS);
      this.lraSum = 0;
      this.lraCount = 0;
      this.M = -Infinity;
      this.S = -Infinity;
      this.I = -Infinity;
      this.LRA = null;
      this.maxM = -Infinity;
      this.maxS = -Infinity;
      this.tpMax = [0, 0];
      this.pkMax = [0, 0];
      this.blk = 0;
      this.sumSq.fill(0);
      this.subCount = 0;
    }

    command(msg) {
      if (msg && msg.type === 'reset') this.reset();
    }

    process(channels, n) {
      const L = channels[0];
      const R = channels[1] || L;
      const sh = this.shelf;
      const hp = this.hp;
      const sl = this.kState[0];
      const sr = this.kState[1];
      const tpL = this.tp[0];
      const tpR = this.tp[1];
      const w2 = VU_OMEGA * VU_OMEGA;
      const damp = 2 * VU_ZETA * VU_OMEGA;
      const dt = this.vuDt;
      let yL = this.vuY[0], vL = this.vuV[0], yR = this.vuY[1], vR = this.vuV[1];
      for (let i = 0; i < n; i++) {
        const xl = L[i];
        const xr = R[i];

        // K-weighting, transposed direct form II, per channel.
        let a = sh.b0 * xl + sl[0];
        sl[0] = sh.b1 * xl - sh.a1 * a + sl[1];
        sl[1] = sh.b2 * xl - sh.a2 * a;
        const kl = hp.b0 * a + sl[2];
        sl[2] = hp.b1 * a - hp.a1 * kl + sl[3];
        sl[3] = hp.b2 * a - hp.a2 * kl;
        a = sh.b0 * xr + sr[0];
        sr[0] = sh.b1 * xr - sh.a1 * a + sr[1];
        sr[1] = sh.b2 * xr - sh.a2 * a;
        const kr = hp.b0 * a + sr[2];
        sr[2] = hp.b1 * a - hp.a1 * kr + sr[3];
        sr[3] = hp.b2 * a - hp.a2 * kr;
        this.sumSq[0] += kl * kl;
        this.sumSq[1] += kr * kr;

        const al = xl < 0 ? -xl : xl;
        const ar = xr < 0 ? -xr : xr;
        if (al > this.peakInt[0]) this.peakInt[0] = al;
        if (ar > this.peakInt[1]) this.peakInt[1] = ar;
        const tl = tpL.push(xl);
        const tr = tpR.push(xr);
        if (tl > this.tpInt[0]) this.tpInt[0] = tl;
        if (tr > this.tpInt[1]) this.tpInt[1] = tr;

        // VU needles driven by the full-wave rectified signal.
        vL += (w2 * (al - yL) - damp * vL) * dt;
        yL += vL * dt;
        vR += (w2 * (ar - yR) - damp * vR) * dt;
        yR += vR * dt;

        if (++this.subCount === this.subLen) {
          this.subCount = 0;
          const e = (this.sumSq[0] + this.sumSq[1]) / this.subLen;
          this.sumSq[0] = 0;
          this.sumSq[1] = 0;
          this._pushSubblock(e);
        }
        if (++this.repCount === this.repLen) {
          this.vuY[0] = yL;
          this.vuY[1] = yR;
          this._report();
        }
      }
      this.vuY[0] = yL; this.vuV[0] = vL;
      this.vuY[1] = yR; this.vuV[1] = vR;
    }

    _pushSubblock(e) {
      const ring = this.ring;
      ring[this.ringPos] = e;
      this.ringPos = (this.ringPos + 1) % 30;
      this.subTotal++;

      let m = 0;
      for (let i = 1; i <= 4; i++) m += ring[(this.ringPos - i + 30) % 30];
      m /= 4;
      let s = 0;
      for (let i = 0; i < 30; i++) s += ring[i];
      s /= 30;
      this.M = energyToLufs(m);
      this.S = energyToLufs(s);

      if (this.subTotal >= 4) {
        if (this.M > this.maxM) this.maxM = this.M;
        if (this.M > ABSOLUTE_GATE) this._addGatingBlock(m);
      }
      if (this.subTotal >= 30) {
        if (this.S > this.maxS) this.maxS = this.S;
        if (this.S > ABSOLUTE_GATE) this._addShortTerm(s, this.S);
      }
      this.blk++;
    }

    _addGatingBlock(e) {
      if (this.blockCount === this.blocks.length) {
        const grown = new Float64Array(this.blocks.length * 2);
        grown.set(this.blocks);
        this.blocks = grown;
      }
      this.blocks[this.blockCount++] = e;
      this.gateSum += e;
      const rel = (this.gateSum / this.blockCount) * RELATIVE_GATE_RATIO;
      let sum = 0;
      let count = 0;
      const blocks = this.blocks;
      for (let i = 0; i < this.blockCount; i++) {
        if (blocks[i] > rel) {
          sum += blocks[i];
          count++;
        }
      }
      this.I = count ? energyToLufs(sum / count) : -Infinity;
    }

    _addShortTerm(e, lufs) {
      const bin = Math.min(LRA_BINS - 1, Math.max(0, Math.floor((lufs - LRA_MIN) * 10)));
      this.lraHist[bin]++;
      this.lraSum += e;
      this.lraCount++;
      const thr = energyToLufs((this.lraSum / this.lraCount) * LRA_GATE_RATIO);
      // A bin is in when its centre is above the gate.
      const start = Math.max(0, Math.ceil((thr - LRA_MIN) * 10 - 0.5));
      let total = 0;
      for (let i = start; i < LRA_BINS; i++) total += this.lraHist[i];
      if (total < 2) {
        this.LRA = 0;
        return;
      }
      const lowIdx = Math.round((total - 1) * 0.1);
      const highIdx = Math.round((total - 1) * 0.95);
      let cum = 0;
      let low = null;
      let high = null;
      for (let i = start; i < LRA_BINS && high === null; i++) {
        cum += this.lraHist[i];
        if (low === null && cum > lowIdx) low = i;
        if (cum > highIdx) high = i;
      }
      this.LRA = (high - low) / 10;
    }

    _report() {
      this.repCount = 0;
      const half = Math.PI / 2;
      for (let c = 0; c < 2; c++) {
        if (this.tpInt[c] > this.tpMax[c]) this.tpMax[c] = this.tpInt[c];
        if (this.peakInt[c] > this.pkMax[c]) this.pkMax[c] = this.peakInt[c];
      }
      const r = {
        // VU as dBFS of the equivalent sine peak: a sine of peak A reads 20log10(A).
        vu: [ampToDb(this.vuY[0] * half), ampToDb(this.vuY[1] * half)],
        pk: [ampToDb(this.peakInt[0]), ampToDb(this.peakInt[1])],
        tp: [ampToDb(this.tpInt[0]), ampToDb(this.tpInt[1])],
        tpMax: [ampToDb(this.tpMax[0]), ampToDb(this.tpMax[1])],
        pkMax: [ampToDb(this.pkMax[0]), ampToDb(this.pkMax[1])],
        M: orNull(this.M),
        S: orNull(this.S),
        I: orNull(this.I),
        LRA: this.LRA,
        maxM: orNull(this.maxM),
        maxS: orNull(this.maxS),
        blk: this.blk,
        time: this.subTotal / 10,
      };
      this.peakInt[0] = 0;
      this.tpInt[0] = 0;
      this.peakInt[1] = 0;
      this.tpInt[1] = 0;
      if (this.onReport) this.onReport(r);
    }
  }

  root.LMeterDSP = LMeterDSP;
})(typeof globalThis !== 'undefined' ? globalThis : this);
