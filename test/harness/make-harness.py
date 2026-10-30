"""Builds the browser harness: a stereo test tone and a panel page wired to the chrome stub.

Run from the project root:  python3 test/harness/make-harness.py
Then serve the project root (python3 -m http.server 8765) and open /test/harness/index.html
"""
import math, struct, wave, pathlib

root = pathlib.Path(__file__).resolve().parents[2]
here = root / 'test' / 'harness'

# 1 kHz stereo sine at -18 dBFS, 48 kHz, 20 s: expect -18 LUFS, 0 VU (ref -18), -18 dBTP.
fs, secs, amp = 48000, 20, 10 ** (-18 / 20)
with wave.open(str(here / 'tone.wav'), 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(fs)
    frames = bytearray()
    for n in range(fs * secs):
        v = int(round(amp * math.sin(2 * math.pi * 1000 * n / fs) * 32767))
        frames += struct.pack('<hh', v, v)
    w.writeframes(bytes(frames))

panel = (root / 'sidepanel' / 'panel.html').read_text(encoding='utf-8')
panel = panel.replace('href="panel.css"', 'href="../../sidepanel/panel.css"')
panel = panel.replace('<script src="panel.js"></script>',
                      '<script>window.chrome = parent.LMETER_PANEL_CHROME;</script>\n  <script src="../../sidepanel/panel.js"></script>')
(here / 'panel-frame.html').write_text(panel, encoding='utf-8')
print('ok')
