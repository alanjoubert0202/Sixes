#!/usr/bin/env node
/**
 * Generates the PWA icon set.
 *
 * The project ships no image assets — the game balls are canvas primitives and
 * the icons are drawn here, pixel by pixel, and encoded as PNG with the built
 * in zlib. Output lands in `public/icons/` (gitignored) before every build.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const PITCH_TOP = [10, 48, 46];
const PITCH_BOTTOM = [2, 16, 15];
const GOLD = [243, 194, 75];

/** The six balls, in the order the game uses them. */
const BALLS = [
  { base: [176, 92, 44], light: [217, 139, 78] }, // rugby
  { base: [238, 238, 228], light: [255, 255, 255] }, // soccer
  { base: [158, 30, 28], light: [212, 69, 63] }, // cricket
  { base: [194, 219, 63], light: [234, 247, 122] }, // tennis
  { base: [240, 240, 232], light: [255, 255, 255] }, // golf
  { base: [212, 113, 31], light: [245, 162, 78] }, // basketball
];

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** `rgba` is a Uint8ClampedArray of size * size * 4. */
function encodePng(rgba, size) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/**
 * Draws the mark: six balls in a ring, inside a thin gold circle, on the pitch
 * teal. Rendered at 3x and box-filtered down, which is cheaper to write than
 * per-shape antialiasing and looks better at favicon sizes.
 */
function drawIcon(size, { bleed }) {
  const ss = 3;
  const big = size * ss;
  const hi = new Float32Array(big * big * 4);

  const cx = big / 2;
  const cy = big / 2;
  // Maskable icons must survive a circular crop, so shrink the art inside a
  // 40% safe radius; ordinary icons can use more of the canvas.
  const artScale = bleed ? 0.62 : 0.84;
  const ringRadius = big * 0.3 * artScale;
  const ballRadius = big * 0.135 * artScale;
  const goldRadius = big * 0.44 * artScale;
  const goldWidth = big * 0.018 * artScale;

  const centres = [];
  for (let i = 0; i < 6; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 3;
    centres.push([cx + Math.cos(angle) * ringRadius, cy + Math.sin(angle) * ringRadius, BALLS[i]]);
  }

  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const i = (y * big + x) * 4;

      // Background: vertical pitch gradient with a soft centre glow.
      const t = y / big;
      let colour = mix(PITCH_TOP, PITCH_BOTTOM, t * t * 0.85 + t * 0.15);
      const dc = Math.hypot(x - cx, y - cy) / big;
      colour = mix(colour, [16, 66, 63], Math.max(0, 0.5 - dc) * 0.5);
      let alpha = 1;

      // Gold ring.
      const dRing = Math.abs(Math.hypot(x - cx, y - cy) - goldRadius);
      if (dRing < goldWidth) colour = mix(colour, GOLD, 0.85);

      // Balls, painted in draw order so the overlaps look stacked.
      for (const [bx, by, ball] of centres) {
        const d = Math.hypot(x - bx, y - by);
        if (d > ballRadius) continue;
        const shade = Math.min(1, Math.max(0, 1 - d / ballRadius));
        const lit = Math.hypot(x - (bx - ballRadius * 0.32), y - (by - ballRadius * 0.36)) / (ballRadius * 1.4);
        let ballColour = mix(ball.base, ball.light, Math.max(0, 1 - lit));
        ballColour = mix([0, 0, 0], ballColour, 0.55 + shade * 0.45);
        colour = ballColour;
      }

      hi[i] = colour[0];
      hi[i + 1] = colour[1];
      hi[i + 2] = colour[2];
      hi[i + 3] = alpha * 255;
    }
  }

  // Box downsample.
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const j = ((y * ss + sy) * big + (x * ss + sx)) * 4;
          r += hi[j];
          g += hi[j + 1];
          b += hi[j + 2];
          a += hi[j + 3];
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      out[i] = r / n;
      out[i + 1] = g / n;
      out[i + 2] = b / n;
      out[i + 3] = a / n;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

const TARGETS = [
  { file: 'favicon.png', size: 64, bleed: false },
  { file: 'icon-192.png', size: 192, bleed: false },
  { file: 'icon-512.png', size: 512, bleed: false },
  { file: 'icon-maskable-512.png', size: 512, bleed: true },
  { file: 'apple-touch-icon.png', size: 180, bleed: false },
];

mkdirSync(OUT, { recursive: true });
for (const target of TARGETS) {
  const pixels = drawIcon(target.size, { bleed: target.bleed });
  writeFileSync(join(OUT, target.file), encodePng(pixels, target.size));
  console.log(`icons: ${target.file} (${target.size}x${target.size})`);
}
