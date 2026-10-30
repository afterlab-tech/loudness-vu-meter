"""Draws the toolbar icons (three meter bars on a dark tile) without external libraries.

Run from the project root:  python3 tools/make-icons.py
"""
import pathlib, struct, zlib

BG = (20, 23, 28)
BARS = [((62, 224, 143), 0.45), ((255, 191, 60), 0.68), ((255, 77, 79), 0.9)]
SS = 4  # supersampling for smooth edges


def inside_round_rect(x, y, x0, y0, x1, y1, r):
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def pixel(u, v):
    """u, v in [0, 1). Returns RGBA."""
    if not inside_round_rect(u, v, 0, 0, 1, 1, 0.22):
        return (0, 0, 0, 0)
    pad, gap = 0.2, 0.07
    w = (1 - 2 * pad - 2 * gap) / 3
    bottom = 1 - pad
    for i, (color, height) in enumerate(BARS):
        x0 = pad + i * (w + gap)
        y0 = bottom - (1 - 2 * pad) * height
        if inside_round_rect(u, v, x0, y0, x0 + w, bottom, w * 0.25):
            return color + (255,)
    return BG + (255,)


def render(size):
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    r, g, b, a = pixel((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size)
                    acc[0] += r * a
                    acc[1] += g * a
                    acc[2] += b * a
                    acc[3] += a
            a = acc[3]
            row += bytes([acc[0] // a, acc[1] // a, acc[2] // a, a // (SS * SS)] if a else [0, 0, 0, 0])
        rows.append(bytes(row))
    raw = b''.join(rows)

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


out = pathlib.Path(__file__).resolve().parents[1] / 'icons'
for size in (16, 32, 48, 128):
    (out / f'icon{size}.png').write_bytes(render(size))
print('ok')
