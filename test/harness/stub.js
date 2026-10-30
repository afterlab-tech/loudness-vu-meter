// Minimal chrome.* stand-ins so the content script and side panel can run in one ordinary page.
(() => {
  const contentConnect = [];
  window.__gains = [];
  const origCreateGain = AudioContext.prototype.createGain;
  AudioContext.prototype.createGain = function () {
    const g = origCreateGain.call(this);
    window.__gains.push(g);
    return g;
  };

  function pair() {
    const a = { msg: [], dis: [] };
    const b = { msg: [], dis: [] };
    const end = (self, other) => ({
      name: 'lmeter',
      postMessage(m) {
        const copy = JSON.parse(JSON.stringify(m)); // chrome messaging is JSON
        setTimeout(() => other.msg.forEach((f) => f(copy)), 0);
      },
      onMessage: { addListener: (f) => self.msg.push(f) },
      onDisconnect: { addListener: (f) => self.dis.push(f) },
      disconnect: () => other.dis.forEach((f) => f()),
    });
    return [end(a, b), end(b, a)];
  }

  window.chrome = {
    runtime: {
      getURL: (p) => '/' + p,
      onConnect: { addListener: (f) => contentConnect.push(f) },
      sendMessage: () => Promise.resolve(),
    },
  };

  window.LMETER_PANEL_CHROME = {
    tabs: {
      connect() {
        const [panelEnd, contentEnd] = pair();
        contentConnect.forEach((f) => f(contentEnd));
        return panelEnd;
      },
      query: async () => [{ id: 1 }],
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    windows: { getCurrent: async () => ({ id: 1 }) },
    storage: { local: { get: async (d) => d, set: async () => {} } },
    runtime: { onMessage: { addListener() {} }, lastError: undefined },
  };
})();
