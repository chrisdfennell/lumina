// Generates app + tray icons as real PNGs using only Node's zlib.
// Run: node scripts/gen-icons.js
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'assets');
fs.mkdirSync(OUT, { recursive: true });

// --- CRC32 ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // rest 0 (compression/filter/interlace)
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// --- drawing ---
function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.22; // rounded corner radius
  // gradient endpoints (purple -> blue)
  const top = [124, 58, 237];
  const bot = [37, 99, 235];
  // play-triangle geometry
  const cx = size * 0.5;
  const cy = size * 0.5;
  const tw = size * 0.26; // half-width-ish
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // rounded-rect mask via distance to the inset rectangle
      const clampedX = Math.min(Math.max(x, radius), size - radius);
      const clampedY = Math.min(Math.max(y, radius), size - radius);
      const ddx = x - clampedX, ddy = y - clampedY;
      const dist = Math.sqrt(ddx * ddx + ddy * ddy);
      if (dist > radius) { rgba[i + 3] = 0; continue; }
      // soft 1px edge
      const edgeAlpha = dist > radius - 1 ? Math.round((radius - dist) * 255) : 255;

      const t = y / size;
      let r = lerp(top[0], bot[0], t);
      let g = lerp(top[1], bot[1], t);
      let b = lerp(top[2], bot[2], t);

      // white play triangle pointing right
      const inTriX = x > cx - tw * 0.7 && x < cx + tw;
      if (inTriX) {
        const localX = (x - (cx - tw * 0.7)) / (tw * 1.7); // 0..1 across triangle
        const halfH = tw * 0.95 * (1 - localX);
        if (Math.abs(y - cy) < halfH) {
          r = 255; g = 255; b = 255;
        }
      }
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = edgeAlpha;
    }
  }
  return encodePNG(size, size, rgba);
}

fs.writeFileSync(path.join(OUT, 'icon.png'), draw(256));
fs.writeFileSync(path.join(OUT, 'tray.png'), draw(32));
fs.writeFileSync(path.join(OUT, 'logo.png'), draw(128));
console.log('Icons written to', OUT);
