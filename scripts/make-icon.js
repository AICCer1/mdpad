'use strict';

// Generates build/icon.png (256x256) and build/icon.ico from raw pixel math.
// Kept dependency-free so packaging never depends on an image toolchain.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 256;

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function makePixels() {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  const radius = 56;
  const put = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    const i = (y * SIZE + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  };

  // Rounded-square background with a vertical gradient.
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const dx = Math.max(radius - x, x - (SIZE - radius), 0);
      const dy = Math.max(radius - y, y - (SIZE - radius), 0);
      const inside = dx * dx + dy * dy <= radius * radius;
      if (!inside) continue;
      const t = y / SIZE;
      put(x, y, Math.round(20 + 10 * t), Math.round(70 + 30 * t), Math.round(190 - 40 * t), 255);
    }
  }

  // Glyph: "M" with a baseline, drawn as thick strokes.
  const stroke = (x0, y0, x1, y1, thickness, color) => {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const cx = Math.round(x0 + (x1 - x0) * t);
      const cy = Math.round(y0 + (y1 - y0) * t);
      for (let oy = -thickness; oy <= thickness; oy += 1) {
        for (let ox = -thickness; ox <= thickness; ox += 1) {
          if (ox * ox + oy * oy <= thickness * thickness) put(cx + ox, cy + oy, ...color);
        }
      }
    }
  };
  const white = [255, 255, 255, 255];
  stroke(70, 186, 70, 74, 9, white);
  stroke(70, 74, 128, 140, 9, white);
  stroke(128, 140, 186, 74, 9, white);
  stroke(186, 74, 186, 186, 9, white);
  stroke(70, 196, 186, 196, 7, [255, 255, 255, 210]);
  return px;
}

function png(px) {
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (SIZE * 4 + 1)] = 0;
    px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ico(pngBuffer) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry[0] = 0; // 256
  entry[1] = 0;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, pngBuffer]);
}

const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });
const pngBuffer = png(makePixels());
fs.writeFileSync(path.join(buildDir, 'icon.png'), pngBuffer);
fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico(pngBuffer));
console.log(`icon: build/icon.png ${pngBuffer.length} bytes, build/icon.ico ${pngBuffer.length + 22} bytes`);
