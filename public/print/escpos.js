// Pure ESC/POS raster encoding: no DOM, no canvas, so it runs (and is tested) in Node as well as in the browser.
const PAPER_DOTS = { 58: 384, 80: 576 };
const BAND_ROWS = 255;
const DEFAULT_FEED_LINES = 3;
const DEFAULT_THRESHOLD = 160;
const BITS_PER_BYTE = 8;
const WHITE = 255;

const ESC_INIT = [0x1b, 0x40];
const GS_RASTER = [0x1d, 0x76, 0x30, 0x00]; // GS v 0, normal density
const ESC_FEED = [0x1b, 0x64]; // ESC d n
const GS_PARTIAL_CUT = [0x1d, 0x56, 0x42, 0x00]; // GS V 66 0: feed to cutter, partial cut

export const paperDots = (paperMm) => {
  const dots = PAPER_DOTS[paperMm];
  if (!dots) throw new Error(`unsupported paper width ${paperMm}mm`);
  return dots;
};

/**
 * RGBA pixels -> 1-bit bitmap (1 = black). 'threshold' keeps text crisp; 'dither' (Floyd-Steinberg) is for images.
 * Transparent pixels count as paper.
 */
export function toBitmap(rgba, width, height, { mode = 'threshold', level = DEFAULT_THRESHOLD } = {}) {
  const luma = new Float32Array(width * height);
  for (let i = 0; i < luma.length; i++) {
    const o = i * 4;
    const alpha = rgba[o + 3] / 255;
    const y = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
    luma[i] = y * alpha + WHITE * (1 - alpha);
  }
  const pixels = new Uint8Array(width * height);
  if (mode === 'dither') {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const old = luma[i];
        const next = old < WHITE / 2 ? 0 : WHITE;
        pixels[i] = next === 0 ? 1 : 0;
        const err = old - next;
        if (x + 1 < width) luma[i + 1] += (err * 7) / 16;
        if (y + 1 < height) {
          if (x > 0) luma[i + width - 1] += (err * 3) / 16;
          luma[i + width] += (err * 5) / 16;
          if (x + 1 < width) luma[i + width + 1] += err / 16;
        }
      }
    }
    return { width, height, pixels };
  }
  for (let i = 0; i < pixels.length; i++) pixels[i] = luma[i] < level ? 1 : 0;
  return { width, height, pixels };
}

/** Packs rows MSB-first, 8 pixels per byte; the right edge is padded with paper so width need not be a multiple of 8. */
export function packBitmap({ width, height, pixels }) {
  const bytesPerRow = Math.ceil(width / BITS_PER_BYTE);
  const data = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[y * width + x]) data[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { bytesPerRow, data };
}

/**
 * ESC @, then the bitmap as GS v 0 bands of at most `bandRows` rows (some printers choke on tall single blocks),
 * then a paper feed and a partial cut.
 */
export function encodeRaster(bitmap, { feedLines = DEFAULT_FEED_LINES, cut = true, bandRows = BAND_ROWS } = {}) {
  const { bytesPerRow, data } = packBitmap(bitmap);
  const parts = [Uint8Array.from(ESC_INIT)];
  for (let y = 0; y < bitmap.height; y += bandRows) {
    const rows = Math.min(bandRows, bitmap.height - y);
    parts.push(Uint8Array.from([...GS_RASTER, bytesPerRow & 0xff, bytesPerRow >> 8, rows & 0xff, rows >> 8]));
    parts.push(data.subarray(y * bytesPerRow, (y + rows) * bytesPerRow));
  }
  if (feedLines > 0) parts.push(Uint8Array.from([...ESC_FEED, feedLines]));
  if (cut) parts.push(Uint8Array.from(GS_PARTIAL_CUT));
  return concatBytes(parts);
}

export function concatBytes(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const BASE64_CHUNK = 0x8000;

export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  return btoa(binary);
}
