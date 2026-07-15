/**
 * generate_icons.js
 * ------------------------------------------------------------------
 * One-off script (not part of the running app) that generates the PWA
 * icon PNGs using nothing but Node's built-in zlib module -- no
 * node-canvas, no sharp, no native image libraries. Those all require
 * a native compile step (cairo/libvips + node-gyp), which is exactly
 * the kind of dependency this project is trying to avoid for Termux/
 * mobile-IDE compatibility.
 *
 * Design direction: a circular badge in a lighter blue (consistent
 * with Session 3's --aisapp-accent: #4d8dff already shipped in
 * projects.css) with a thin orbital ring and two small dot accents --
 * this is deliberately in the spirit of a reference style the human
 * pointed to (a light-blue circular "connected" mark), rebuilt as an
 * original geometric composition rather than traced from that image:
 * this generator can't rasterize text/fonts at all, and cloning
 * someone else's specific generated artwork pixel-for-pixel isn't
 * something to do even if it were technically possible here.
 *
 * Run once with: node generate_icons.js
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function buildIconPNG(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const R = size * 0.47; // outer badge radius

  // Colors: lighter blue field (consistent with --aisapp-accent family),
  // a brighter rim highlight, and white-ish ring/dot accents.
  const bgOuter = [92, 150, 224]; // lighter, airier blue than the pure accent
  const bgInner = [58, 116, 199]; // slightly deeper toward the edge for subtle depth
  const ring = [223, 236, 252]; // near-white ring, soft rather than stark
  const dot = [255, 255, 255];

  function setPixel(x, y, rgb, alpha) {
    const idx = (y * size + x) * 4;
    pixels[idx] = rgb[0];
    pixels[idx + 1] = rgb[1];
    pixels[idx + 2] = rgb[2];
    pixels[idx + 3] = alpha;
  }

  function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= R) {
        // Simple radial-ish gradient: lighter near top-left, deeper
        // toward bottom-right, for a touch of dimensionality without
        // reaching for a literal drop-shadow/glow cliche.
        const t = Math.max(0, Math.min(1, (dx + dy) / (R * 2) + 0.5));
        const color = mix(bgOuter, bgInner, t);
        // Antialias the outer edge over ~1.5px so it doesn't look jagged.
        const edge = R - dist;
        const alpha = edge >= 1.5 ? 255 : Math.max(0, Math.round((edge / 1.5) * 255));
        setPixel(x, y, color, alpha);
      } else {
        setPixel(x, y, bgOuter, 0);
      }
    }
  }

  // Orbital ring: a thin arc-like ring inset from the badge edge,
  // suggesting connection/coordination between sessions -- open at
  // roughly a 40-degree gap (like a partial orbit, not a closed halo).
  const ringRadius = R * 0.72;
  const ringWidth = Math.max(2.5, size * 0.028);
  const gapStartDeg = 200;
  const gapEndDeg = 240;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (Math.abs(dist - ringRadius) <= ringWidth / 2) {
        let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        if (angle < 0) angle += 360;
        const inGap = angle >= gapStartDeg && angle <= gapEndDeg;
        if (!inGap) {
          const edge = ringWidth / 2 - Math.abs(dist - ringRadius);
          const alpha = edge >= 1 ? 235 : Math.max(0, Math.round(edge * 235));
          setPixel(x, y, ring, alpha);
        }
      }
    }
  }

  // Two small dot accents sitting at the ring's open ends -- echoes the
  // "orbit with endpoint dots" motif directly.
  function drawDot(angleDeg, r) {
    const rad = (angleDeg * Math.PI) / 180;
    const dcx = cx + ringRadius * Math.cos(rad);
    const dcy = cy + ringRadius * Math.sin(rad);
    for (let y = Math.floor(dcy - r - 1); y <= Math.ceil(dcy + r + 1); y++) {
      for (let x = Math.floor(dcx - r - 1); x <= Math.ceil(dcx + r + 1); x++) {
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const dist = Math.sqrt((x - dcx) ** 2 + (y - dcy) ** 2);
        if (dist <= r) {
          const edge = r - dist;
          const alpha = edge >= 1 ? 255 : Math.max(0, Math.round(edge * 255));
          setPixel(x, y, dot, alpha);
        }
      }
    }
  }
  const dotRadius = size * 0.032;
  drawDot(gapStartDeg, dotRadius);
  drawDot(gapEndDeg, dotRadius);

  // Build raw scanlines with filter-type-0 prefix per row, per PNG spec.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const idatData = zlib.deflateSync(raw, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, 'frontend', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [192, 512]) {
  const png = buildIconPNG(size);
  const outPath = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`wrote ${outPath} (${png.length} bytes)`);
}

