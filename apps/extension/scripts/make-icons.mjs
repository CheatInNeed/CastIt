// Draws Castit's icon (a blue rounded square with a white screen and cast waves) and writes PNGs:
//   apps/extension/icons/icon-{16,32,48,128}.png   (toolbar, extensions page, store)
// No image tools needed: shapes are rasterised with 4×4 supersampling and encoded with zlib.
// Run: node apps/extension/scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

const BLUE = [37, 99, 235];
const WHITE = [255, 255, 255];

/** Coverage of the shape at (x, y) in unit coordinates: 'bg' | 'fg' | null. */
function shape(x, y) {
  // Rounded-square background.
  const r = 0.22;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return null;

  const t = 0.075; // stroke
  const [left, right, top, bottom] = [0.2, 0.82, 0.24, 0.72];
  const onH = (yy, x0, x1) => Math.abs(y - yy) <= t / 2 && x >= x0 - t / 2 && x <= x1 + t / 2;
  const onV = (xx, y0, y1) => Math.abs(x - xx) <= t / 2 && y >= y0 - t / 2 && y <= y1 + t / 2;
  // Screen outline, open at the lower-left corner where the waves sit.
  if (onH(top, left, right) || onV(right, top, bottom) || onH(bottom, 0.46, right) || onV(left, top, 0.46)) return 'fg';

  // Cast waves: a dot and two arcs in the upper-right quadrant of the lower-left corner.
  const wx = left;
  const wy = 0.8;
  if (x >= wx - 0.01 && y <= wy + 0.01) {
    const d = Math.hypot(x - wx, y - wy);
    if (d <= 0.075) return 'fg';
    if (Math.abs(d - 0.18) <= t / 2) return 'fg';
    if (Math.abs(d - 0.3) <= t / 2) return 'fg';
  }
  return 'bg';
}

function render(size) {
  const n = 4; // supersampling
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxx = 0; pxx < size; pxx++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const s = shape((pxx + (sx + 0.5) / n) / size, (py + (sy + 0.5) / n) / size);
          if (s === 'bg') bg++;
          else if (s === 'fg') fg++;
        }
      }
      const cover = (bg + fg) / (n * n);
      const mix = bg + fg ? fg / (bg + fg) : 0;
      const i = (py * size + pxx) * 4;
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(BLUE[c] * (1 - mix) + WHITE[c] * mix);
      px[i + 3] = Math.round(cover * 255);
    }
  }
  return px;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const root = new URL('../../../', import.meta.url);
mkdirSync(new URL('apps/extension/icons/', root), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(new URL(`apps/extension/icons/icon-${size}.png`, root), png(size, render(size)));
}
console.log('icons written');
