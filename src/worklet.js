/* AudioWorklet processor; dsp.js is added to the same worklet scope first. */
class LMeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.dsp = new globalThis.LMeterDSP(sampleRate);
    this.dsp.onReport = (r) => this.port.postMessage(r);
    this.port.onmessage = (e) => this.dsp.command(e.data);
    this.silence = new Float32Array(128);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      const n = outputs[0] && outputs[0][0] ? outputs[0][0].length : 128;
      if (this.silence.length !== n) this.silence = new Float32Array(n);
      this.dsp.process([this.silence, this.silence], n);
    } else {
      this.dsp.process(input, input[0].length);
    }
    return true;
  }
}

registerProcessor('lmeter-processor', LMeterProcessor);
