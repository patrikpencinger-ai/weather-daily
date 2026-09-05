#!/usr/bin/env node
/*
 * make-icons.js — generates the PWA icon PNGs for weather-dashboard.html.
 *
 * Dependency-free: writes a minimal PNG encoder by hand (raw RGBA scanlines,
 * each prefixed with filter byte 0, deflated with Node's built-in zlib, then
 * wrapped in IHDR/IDAT/IEND chunks with hand-rolled CRC32). No npm packages.
 *
 * Draws a simple approximation of the app's favicon: a rounded dark-navy
 * square (#16243a) with a warm sun disc (#E0A53C) upper-left and a sky-blue
 * cloud silhouette (#2caaf0) lower-right, built from circles + a rounded
 * rect (see the inline SVG favicon in weather-dashboard.html <head> for the
 * original design this approximates).
 *
 * Usage:  node tools/make-icons.js
 * Writes: icons/icon-192.png, icons/icon-512.png (both maskable-safe —
 *         artwork kept inside the central 80% so an OS mask never crops it),
 *         icons/apple-touch-icon.png (180x180, full-bleed, iOS masks it).
 *
 * Not served to visitors: this file lives under tools/, which .assetsignore
 * excludes from the static site. Re-run it (and bump CACHE in sw.js) if the
 * artwork ever needs to change.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const NAVY = [0x16, 0x24, 0x3a];
const SUN = [0xe0, 0xa5, 0x3c];
const CLOUD = [0x2c, 0xaa, 0xf0];

/* ---------- tiny shape tests (all in a local 0..32 coordinate box) ---------- */
function inCircle(px, py, cx, cy, r) {
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}
function inRoundedRect(px, py, x, y, w, h, r) {
  if (px < x - 0 || px > x + w || py < y || py > y + h) {
    // fast reject outside the bounding box entirely (with no extra margin)
    if (px < x || px > x + w || py < y || py > y + h) return false;
  }
  // clamp to the "core" rect shrunk by r on each side, then it's a plain rect;
  // in the corner margins, fall back to a circle test against the corner center.
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}
function isCloud(lx, ly) {
  // union of a rounded base + three overlapping lobes, lower-right of the box
  return (
    inRoundedRect(lx, ly, 13, 18, 16, 7, 3.2) ||
    inCircle(lx, ly, 17, 18, 5) ||
    inCircle(lx, ly, 23, 15, 6) ||
    inCircle(lx, ly, 27.5, 19, 4)
  );
}
function isSun(lx, ly) {
  return inCircle(lx, ly, 12.5, 12.5, 6);
}
/*
 * Rasterize one icon into an RGBA buffer. Every pixel is fully opaque —
 * the background colour fills the entire canvas edge-to-edge (no rounding,
 * no transparency), so it's safe both as a maskable icon (an OS mask can
 * crop it to any shape without revealing a gap) and as a plain apple-touch
 * icon (iOS applies its own rounding on top).
 *
 * size: output PNG dimensions (square).
 * safeFrac: fraction of `size` that the 32x32 sun+cloud artwork is scaled
 *   to (1 = full bleed, matching the favicon; 0.8 = centered inside the
 *   maskable-safe 80% zone so a circular/squircle mask never clips it).
 */
function renderIcon(size, safeFrac) {
  const boxPx = size * safeFrac;
  const offset = (size - boxPx) / 2;
  const scale = boxPx / 32; // local coords are a 32x32 box, same as the SVG favicon

  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const lx = (px - offset) / scale;
      const ly = (py - offset) / scale;
      let r, g, b;
      if (isSun(lx, ly)) [r, g, b] = SUN;
      else if (isCloud(lx, ly)) [r, g, b] = CLOUD;
      else [r, g, b] = NAVY;
      const i = (py * size + px) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }
  return buf;
}

/* ---------- hand-rolled PNG encoder (zlib for deflate, CRC32 by hand) ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
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
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePNG(rgba, size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);   // width
  ihdrData.writeUInt32BE(size, 4);   // height
  ihdrData[8] = 8;                   // bit depth
  ihdrData[9] = 6;                   // colour type: RGBA
  ihdrData[10] = 0;                  // compression
  ihdrData[11] = 0;                  // filter
  ihdrData[12] = 0;                  // interlace
  const ihdr = chunk('IHDR', ihdrData);

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 = None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idatData = zlib.deflateSync(raw, { level: 9 });
  const idat = chunk('IDAT', idatData);
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

/* ---------- generate the three icons ---------- */
const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const specs = [
  { file: 'icon-192.png', size: 192, safeFrac: 0.8 },
  { file: 'icon-512.png', size: 512, safeFrac: 0.8 },
  { file: 'apple-touch-icon.png', size: 180, safeFrac: 1 },
];
for (const s of specs) {
  const rgba = renderIcon(s.size, s.safeFrac);
  const png = encodePNG(rgba, s.size);
  fs.writeFileSync(path.join(outDir, s.file), png);
  console.log('wrote', s.file, `(${s.size}x${s.size}, ${png.length} bytes)`);
}
