// Generates placeholder app/tray icons with zero dependencies (hand-rolled PNG + ICO
// encoders via zlib). Produces assets/icons/{icon.png, tray.png, icon.ico}. Replace with
// real brand art before a public release — this just unblocks the tray + build:win.
//   node scripts/gen-icons.js
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'assets', 'icons');
fs.mkdirSync(OUT, { recursive: true });

// ── CRC32 (PNG/zlib) ──────────────────────────────────────────────────────────
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return (buf) => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
})();

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(body), 0);
  return Buffer.concat([len, body, crc]);
}

// Draw an RGBA buffer: rounded teal square, soft white face, two eyes + smile dot.
function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.22;                         // corner radius
  const cx = size / 2, cy = size * 0.46;
  const faceR = size * 0.30;
  const eyeR = Math.max(1, size * 0.045);
  const eyeY = cy - size * 0.04;
  const eyeDX = size * 0.12;
  const set = (x, y, col) => { const i = (y * size + x) * 4; px[i] = col[0]; px[i+1] = col[1]; px[i+2] = col[2]; px[i+3] = col[3]; };
  const inRounded = (x, y) => {
    const minx = r, maxx = size - r, miny = r, maxy = size - r;
    const dx = x < minx ? minx - x : (x > maxx ? x - maxx : 0);
    const dy = y < miny ? miny - y : (y > maxy ? y - maxy : 0);
    return dx * dx + dy * dy <= r * r;
  };
  const BG_TOP = [56, 189, 178], BG_BOT = [37, 99, 122];   // teal → deep cyan
  const FACE = [245, 250, 252], EYE = [33, 49, 60];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inRounded(x, y)) { set(x, y, [0, 0, 0, 0]); continue; }
      const t = y / size;
      let col = [
        Math.round(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t),
        Math.round(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t),
        Math.round(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t),
        255,
      ];
      const df = Math.hypot(x - cx, y - cy);
      if (df <= faceR) col = FACE.concat(255);
      if (Math.hypot(x - (cx - eyeDX), y - eyeY) <= eyeR) col = EYE.concat(255);
      if (Math.hypot(x - (cx + eyeDX), y - eyeY) <= eyeR) col = EYE.concat(255);
      // smile: small arc of dots below the eyes
      const sy = cy + size * 0.12;
      if (Math.abs(Math.hypot(x - cx, y - (sy - size*0.06)) - size*0.12) < size*0.02 && y > sy - size*0.06) col = EYE.concat(255);
      set(x, y, col);
    }
  }
  return px;
}

function encodePNG(size) {
  const px = render(size);
  // raw scanlines, filter byte 0 per row
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── ICO (embeds PNG frames — supported on Windows Vista+) ────────────────────────
function encodeICO(sizes) {
  const pngs = sizes.map(encodePNG);
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4);
  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  sizes.forEach((s, i) => {
    const e = i * 16;
    entries[e] = s >= 256 ? 0 : s;       // width  (0 = 256)
    entries[e + 1] = s >= 256 ? 0 : s;   // height
    entries[e + 2] = 0; entries[e + 3] = 0;
    entries.writeUInt16LE(1, e + 4);     // color planes
    entries.writeUInt16LE(32, e + 6);    // bits per pixel
    entries.writeUInt32LE(pngs[i].length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  return Buffer.concat([header, entries, ...pngs]);
}

fs.writeFileSync(path.join(OUT, 'icon.png'), encodePNG(256));
fs.writeFileSync(path.join(OUT, 'tray.png'), encodePNG(32));
fs.writeFileSync(path.join(OUT, 'icon.ico'), encodeICO([16, 32, 48, 64, 128, 256]));
console.log('Wrote icon.png (256), tray.png (32), icon.ico (16-256) to', OUT);
