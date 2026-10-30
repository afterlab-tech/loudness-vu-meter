/*
 * Metering engine (isolated world, every frame).
 *
 * When the side panel connects, media elements in this frame are routed through
 * Web Audio:
 *
 *   <video> ─ MediaElementSource ─┬─ outGain (player's virtual volume) ─ destination
 *                                 └─ meterInput ─ meter (worklet / ScriptProcessor)
 *
 * The meter taps the signal before any volume, so player volume/mute never
 * change the readings (see page-hook.js for the volume virtualisation).
 */
(() => {
  'use strict';
  if (window.__lmeterEngine) return;
  window.__lmeterEngine = true;

  const FID = Math.random().toString(36).slice(2);
  const IS_TOP = window === window.top;
  const ATTR = 'data-lmeter';
  const ATTR_VOL = 'data-lmeter-vol';
  const ATTR_MUTED = 'data-lmeter-muted';
  const WORKLET_TIMEOUT_MS = 3000;

  // Native accessors (in the isolated world these are never the page-hook ones).
  const volumeDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  const mutedDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');
  const nativeVolume = (el) => volumeDesc.get.call(el);
  const nativeMuted = (el) => mutedDesc.get.call(el);
  const setNative = (el, volume, muted) => {
    if (nativeVolume(el) !== volume) volumeDesc.set.call(el, volume);
    if (nativeMuted(el) !== muted) mutedDesc.set.call(el, muted);
  };

  const ports = new Set();
  const tracks = new WeakMap(); // element -> { source, out }
  let activated = false;
  let ctx = null;
  let meterInput = null;
  let meterCommand = () => {};
  let meterKind = '';
  let active = null;
  let activeSrc = '';
  let state = 'idle'; // idle | starting | gesture | running | error
  let errorText = '';
  let autoReset = true;

  const send = (msg) => {
    msg.fid = FID;
    msg.top = IS_TOP;
    for (const p of ports) {
      try {
        p.postMessage(msg);
      } catch {
        ports.delete(p);
      }
    }
  };

  const mediaCount = () => document.querySelectorAll('video, audio').length;
  const isPlaying = (el) => !!el && !el.paused && !el.ended;

  function sendStatus() {
    send({
      type: 'status',
      state,
      error: errorText,
      media: mediaCount(),
      playing: isPlaying(active),
      meter: meterKind,
      title: document.title,
    });
  }

  function onReport(r) {
    if (!ports.size) return;
    r.type = 'meter';
    r.playing = isPlaying(active);
    send(r);
  }

  // ---- Web Audio setup ---------------------------------------------------

  const withTimeout = (promise, ms) =>
    Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

  async function createMeterNode() {
    try {
      await withTimeout(ctx.audioWorklet.addModule(chrome.runtime.getURL('src/dsp.js')), WORKLET_TIMEOUT_MS);
      await withTimeout(ctx.audioWorklet.addModule(chrome.runtime.getURL('src/worklet.js')), WORKLET_TIMEOUT_MS);
      const node = new AudioWorkletNode(ctx, 'lmeter-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });
      node.port.onmessage = (e) => onReport(e.data);
      meterCommand = (msg) => node.port.postMessage(msg);
      meterKind = 'worklet';
      return node;
    } catch (err) {
      // Page CSP can block worklet modules; fall back to the main thread.
      const sp = ctx.createScriptProcessor(2048, 2, 1);
      sp.channelCount = 2;
      sp.channelCountMode = 'explicit';
      sp.channelInterpretation = 'speakers';
      const dsp = new globalThis.LMeterDSP(ctx.sampleRate);
      dsp.onReport = onReport;
      sp.onaudioprocess = (e) => {
        const ib = e.inputBuffer;
        dsp.process([ib.getChannelData(0), ib.getChannelData(1)], ib.length);
      };
      meterCommand = (msg) => dsp.command(msg);
      meterKind = 'script-processor';
      return sp;
    }
  }

  async function setupContext() {
    if (ctx || state === 'starting') return;
    state = 'starting';
    sendStatus();
    try {
      ctx = new AudioContext({ latencyHint: 'playback' });
      meterInput = ctx.createGain();
      const meter = await createMeterNode();
      const sink = ctx.createGain();
      sink.gain.value = 0;
      meterInput.connect(meter);
      meter.connect(sink).connect(ctx.destination);
    } catch (err) {
      state = 'error';
      errorText = String(err && err.message ? err.message : err);
      sendStatus();
      return;
    }
    ctx.onstatechange = onContextState;
    waitForGesture();
    if (navigator.userActivation && navigator.userActivation.hasBeenActive) ctx.resume().catch(() => {});
    onContextState();
  }

  // Autoplay policy: the context only runs after the page has seen a user gesture.
  function waitForGesture() {
    const resume = () => {
      if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
    };
    for (const type of ['pointerdown', 'keydown', 'touchend']) {
      window.addEventListener(type, resume, { capture: true, passive: true });
    }
  }

  function onContextState() {
    if (!ctx) return;
    if (ctx.state === 'running') {
      if (state !== 'error') state = 'running';
      if (!active) active = findPlaying();
      if (active) connectActive();
    } else if (state !== 'error') {
      state = 'gesture';
    }
    sendStatus();
  }

  // ---- Media routing -----------------------------------------------------

  function findPlaying() {
    for (const el of document.querySelectorAll('video, audio')) if (isPlaying(el)) return el;
    return null;
  }

  function attach(el) {
    if (tracks.has(el)) return tracks.get(el);
    if (!ctx || ctx.state !== 'running' || !meterInput) return null;
    let source;
    try {
      source = ctx.createMediaElementSource(el);
    } catch (err) {
      state = 'error';
      errorText = 'このメディアは別のスクリプトが既に Web Audio に接続しているため計測できません';
      sendStatus();
      return null;
    }
    const volume = nativeVolume(el);
    const muted = nativeMuted(el);
    el.setAttribute(ATTR_VOL, String(volume));
    el.setAttribute(ATTR_MUTED, muted ? '1' : '0');
    el.setAttribute(ATTR, 'on');
    const out = ctx.createGain();
    out.gain.value = muted ? 0 : volume;
    source.connect(out).connect(ctx.destination);
    const track = { source, out };
    tracks.set(el, track);
    // The audible level now comes from `out`; pin the element itself to unity.
    setNative(el, 1, false);
    return track;
  }

  function connectActive() {
    const track = attach(active);
    if (!track) return;
    track.source.connect(meterInput);
    activeSrc = active.currentSrc;
    if (state === 'error' && errorText) {
      state = 'running';
      errorText = '';
    }
  }

  function setActive(el) {
    if (el === active) {
      if (!tracks.has(el)) connectActive();
      return;
    }
    const prev = active && tracks.get(active);
    if (prev) {
      try {
        prev.source.disconnect(meterInput);
      } catch {
        // was not connected to the meter
      }
    }
    active = el;
    connectActive();
  }

  function applyVolume(el) {
    const track = tracks.get(el);
    if (!track) return;
    // Something bypassed the page hook (another world/extension): adopt its value.
    if (nativeVolume(el) !== 1 || nativeMuted(el)) {
      el.setAttribute(ATTR_VOL, String(nativeVolume(el)));
      el.setAttribute(ATTR_MUTED, nativeMuted(el) ? '1' : '0');
      setNative(el, 1, false);
    }
    const volume = parseFloat(el.getAttribute(ATTR_VOL));
    const muted = el.getAttribute(ATTR_MUTED) === '1';
    const gain = muted ? 0 : Number.isFinite(volume) ? volume : 1;
    track.out.gain.setTargetAtTime(gain, ctx.currentTime, 0.01);
  }

  const isMedia = (t) => t instanceof HTMLMediaElement;

  function onPlaying(e) {
    if (!isMedia(e.target)) return;
    if (!ctx) {
      active = e.target;
      setupContext();
      return;
    }
    setActive(e.target);
    sendStatus();
  }

  function onLoadStart(e) {
    if (e.target !== active) return;
    const src = active.currentSrc;
    if (autoReset && src && activeSrc && src !== activeSrc) resetMeter();
    activeSrc = src;
  }

  function resetMeter() {
    meterCommand({ type: 'reset' });
    send({ type: 'reset' });
  }

  function activate() {
    if (activated) return;
    activated = true;
    document.addEventListener('play', onPlaying, true);
    document.addEventListener('playing', onPlaying, true);
    document.addEventListener('pause', sendStatus, true);
    document.addEventListener('loadstart', onLoadStart, true);
    document.addEventListener('volumechange', (e) => isMedia(e.target) && applyVolume(e.target), true);
    // Frames without media (ads, widgets) get no AudioContext until something plays.
    if (mediaCount() > 0) setupContext();
  }

  // ---- Side panel connection ----------------------------------------------

  function onCommand(msg) {
    if (!msg) return;
    if (msg.type === 'reset') resetMeter();
    else if (msg.type === 'config') autoReset = msg.autoReset !== false;
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'lmeter') return;
    ports.add(port);
    port.onMessage.addListener(onCommand);
    port.onDisconnect.addListener(() => ports.delete(port));
    activate();
    sendStatus();
  });

  // Let an already-open side panel know this frame exists (navigation, late iframes).
  chrome.runtime.sendMessage({ type: 'lmeter-hello' }).catch(() => {});
})();
