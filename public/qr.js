// Minimal QR Code generator: byte mode, ECC L/M, versions 1-10. Returns an SVG string.
// Follows ISO/IEC 18004 (same construction as the public-domain reference encoders).

const MAX_VERSION = 10;
const ECC_PER_BLOCK = { L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18], M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26] };
const BLOCKS = { L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4], M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5] };
const FORMAT_BITS = { L: 1, M: 0 };
const PAD_BYTES = [0xec, 0x11];
const QUIET_ZONE = 4;

const bit = (v, i) => ((v >>> i) & 1) === 1;

function rawModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

function dataCapacity(ver, ecc) {
  return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ecc][ver - 1] * BLOCKS[ecc][ver - 1];
}

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

function toUtf8(text) {
  return Array.from(new TextEncoder().encode(text));
}

function buildDataCodewords(bytes, ver, ecc) {
  const bits = [];
  const push = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, ver < 10 ? 8 : 16);
  bytes.forEach((b) => push(b, 8));
  const capBits = dataCapacity(ver, ecc) * 8;
  push(0, Math.min(4, capBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0; out.length < capBits / 8; pad ^= 1) out.push(PAD_BYTES[pad]);
  return out;
}

function addEccAndInterleave(data, ver, ecc) {
  const numBlocks = BLOCKS[ecc][ver - 1];
  const eccLen = ECC_PER_BLOCK[ecc][ver - 1];
  const raw = Math.floor(rawModules(ver) / 8);
  const shortBlocks = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
    k += dat.length;
    const e = rsRemainder(dat, divisor);
    if (i < shortBlocks) dat.push(0);
    blocks.push(dat.concat(e));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((blk, j) => { if (i !== shortLen - eccLen || j >= shortBlocks) out.push(blk[i]); });
  }
  return out;
}

class Matrix {
  constructor(ver) {
    this.ver = ver;
    this.size = ver * 4 + 17;
    this.mod = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.fn = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.drawFunctionPatterns();
  }

  setFn(x, y, dark) {
    this.mod[y][x] = dark;
    this.fn[y][x] = true;
  }

  drawFunctionPatterns() {
    const { size, ver } = this;
    for (let i = 0; i < size; i++) {
      this.setFn(6, i, i % 2 === 0);
      this.setFn(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(size - 4, 3);
    this.drawFinder(3, size - 4);
    const pos = this.alignmentPositions();
    pos.forEach((cy, i) => pos.forEach((cx, j) => {
      const overlapsFinder = (i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0);
      if (!overlapsFinder) this.drawAlignment(cx, cy);
    }));
    this.drawFormat(0);
    if (ver >= 7) this.drawVersion();
  }

  drawFinder(x, y) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.setFn(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }

  drawAlignment(x, y) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) this.setFn(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  alignmentPositions() {
    if (this.ver === 1) return [];
    const n = Math.floor(this.ver / 7) + 2;
    const step = Math.floor((this.ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
    const out = [6];
    for (let p = this.size - 7; out.length < n; p -= step) out.splice(1, 0, p);
    return out;
  }

  drawFormat(mask, ecc = 'L') {
    const { size } = this;
    const data = (FORMAT_BITS[ecc] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) this.setFn(8, i, bit(bits, i));
    this.setFn(8, 7, bit(bits, 6));
    this.setFn(8, 8, bit(bits, 7));
    this.setFn(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFn(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.setFn(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.setFn(8, size - 15 + i, bit(bits, i));
    this.setFn(8, size - 8, true);
  }

  drawVersion() {
    let rem = this.ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFn(a, b, bit(bits, i));
      this.setFn(b, a, bit(bits, i));
    }
  }

  placeCodewords(codewords) {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!this.fn[y][x] && i < codewords.length * 8) {
            this.mod[y][x] = bit(codewords[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  applyMask(mask) {
    const test = [
      (x, y) => (x + y) % 2 === 0,
      (x, y) => y % 2 === 0,
      (x) => x % 3 === 0,
      (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
      (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
      (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
    ][mask];
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) if (!this.fn[y][x] && test(x, y)) this.mod[y][x] = !this.mod[y][x];
    }
  }

  penalty() {
    const { size, mod } = this;
    const rows = mod.map((r) => r.map(Number).join(''));
    const cols = mod[0].map((_, x) => mod.map((r) => Number(r[x])).join(''));
    let score = 0;
    for (const line of [...rows, ...cols]) {
      for (const run of line.match(/0+|1+/g)) if (run.length >= 5) score += run.length - 2;
      score += 40 * ((line.match(/(?=10111010000|00001011101)/g) || []).length);
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        if (mod[y][x] === mod[y][x + 1] && mod[y][x] === mod[y + 1][x] && mod[y][x] === mod[y + 1][x + 1]) score += 3;
      }
    }
    const dark = mod.flat().filter(Boolean).length;
    const total = size * size;
    return score + Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  }
}

function pickVersion(byteLen, ecc) {
  for (let ver = 1; ver <= MAX_VERSION; ver++) {
    if (4 + (ver < 10 ? 8 : 16) + byteLen * 8 <= dataCapacity(ver, ecc) * 8) return ver;
  }
  return null;
}

function encode(text) {
  const bytes = toUtf8(text);
  for (const ecc of ['M', 'L']) {
    const ver = pickVersion(bytes.length, ecc);
    if (!ver) continue;
    const m = new Matrix(ver);
    m.placeCodewords(addEccAndInterleave(buildDataCodewords(bytes, ver, ecc), ver, ecc));
    let best = 0;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      m.applyMask(mask);
      m.drawFormat(mask, ecc);
      const score = m.penalty();
      if (score < bestScore) { best = mask; bestScore = score; }
      m.applyMask(mask);
    }
    m.applyMask(best);
    m.drawFormat(best, ecc);
    return m;
  }
  return null;
}

/** Returns an SVG string for `text`, or null when it does not fit in version 10. `label` becomes the accessible name. */
export function qrSvg(text, label) {
  const m = encode(text);
  if (!m) return null;
  const dim = m.size + QUIET_ZONE * 2;
  let path = '';
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) if (m.mod[y][x]) path += `M${x + QUIET_ZONE},${y + QUIET_ZONE}h1v1h-1z`;
  }
  const safeLabel = String(label).replace(/[&<>"]/g, '');
  return `<svg class="qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" role="img" aria-label="${safeLabel}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="var(--color-qr-bg)"/><path d="${path}" fill="var(--color-qr-fg)"/></svg>`;
}
