// Turn the brand logo (assets/icons/logo-src.png, a paw on a white background) into clean app
// icons: flood-fill the white background to TRANSPARENT (so the rounded corners read correctly
// on a taskbar/tray), crop to a tight square, and emit icon.png (512), tray.png (32), and a
// multi-size PNG-embedded icon.ico. No third-party deps — uses Electron's nativeImage.
//   npx electron scripts/make-icons.js
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'assets', 'icons');
const SRC = path.join(DIR, 'logo-src.png');

function buildIco(sizes, pngs) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  const entries = []; let offset = 6 + sizes.length * 16;
  for (let i = 0; i < sizes.length; i++) {
    const s = sizes[i], e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s;   // 0 means 256
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12);
    offset += pngs[i].length; entries.push(e);
  }
  return Buffer.concat([head, ...entries, ...pngs]);
}

app.whenReady().then(() => {
  try {
    const img = nativeImage.createFromPath(SRC);
    const { width: W, height: H } = img.getSize();
    if (!W || !H) throw new Error('could not read ' + SRC);
    const bmp = Buffer.from(img.toBitmap());   // BGRA, length W*H*4

    // The logo already has a TRANSPARENT background (only faint alpha 1–2 noise in the margins).
    // Clean sub-threshold pixels to fully transparent, then crop tight to the real artwork by alpha.
    const TH = 24;
    for (let i = 0; i < W * H; i++) if (bmp[i * 4 + 3] < TH) { bmp[i * 4] = 0; bmp[i * 4 + 1] = 0; bmp[i * 4 + 2] = 0; bmp[i * 4 + 3] = 0; }
    let minX = W, minY = H, maxX = 0, maxY = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (bmp[(y * W + x) * 4 + 3] >= TH) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    const side = Math.max(maxX - minX + 1, maxY - minY + 1);
    const cx = Math.round((minX + maxX) / 2), cy = Math.round((minY + maxY) / 2);
    let sx = cx - (side >> 1), sy = cy - (side >> 1);
    sx = Math.max(0, Math.min(sx, W - side)); sy = Math.max(0, Math.min(sy, H - side));

    const base = nativeImage.createFromBitmap(bmp, { width: W, height: H })
      .crop({ x: sx, y: sy, width: side, height: side });
    const png = (sz) => base.resize({ width: sz, height: sz, quality: 'best' }).toPNG();

    fs.writeFileSync(path.join(DIR, 'icon.png'), png(512));
    fs.writeFileSync(path.join(DIR, 'tray.png'), png(32));
    const sizes = [256, 128, 64, 48, 32, 16];
    fs.writeFileSync(path.join(DIR, 'icon.ico'), buildIco(sizes, sizes.map(png)));
    console.log('icons written: icon.png(512), tray.png(32), icon.ico(' + sizes.join(',') + ')  | crop', side + 'x' + side);
  } catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; }
  app.quit();
});
