import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeRaster, packBitmap, paperDots, toBase64, toBitmap } from '../public/print/escpos.js';
import { layoutModel, wrapText } from '../public/print/raster.js';

const bitmapOf = (rows: string[]) => ({
  width: rows[0].length, height: rows.length,
  pixels: Uint8Array.from(rows.flatMap((r) => [...r].map((c) => (c === '#' ? 1 : 0)))),
});

test('paper widths map to the printable dot widths', () => {
  assert.deepEqual([paperDots(58), paperDots(80)], [384, 576]);
});

test('an unsupported paper width is refused', () => {
  assert.throws(() => paperDots(70));
});

test('pixels pack MSB-first, eight to a byte', () => {
  const { bytesPerRow, data } = packBitmap(bitmapOf(['########........', '#.#.#.#..#.#.#.#']));
  assert.equal(bytesPerRow, 2);
  assert.deepEqual([...data], [0xff, 0x00, 0xaa, 0x55]);
});

test('a width that is not a multiple of 8 is padded with paper on the right', () => {
  const { bytesPerRow, data } = packBitmap(bitmapOf(['##########']));
  assert.equal(bytesPerRow, 2);
  assert.deepEqual([...data], [0xff, 0xc0]);
});

test('a tiny bitmap encodes to the exact ESC/POS byte sequence', () => {
  const out = encodeRaster(bitmapOf(['########', '#......#']));
  assert.deepEqual([...out], [
    0x1b, 0x40, // ESC @
    0x1d, 0x76, 0x30, 0x00, 0x01, 0x00, 0x02, 0x00, // GS v 0, 1 byte wide, 2 rows
    0xff, 0x81, // the two rows
    0x1b, 0x64, 0x03, // feed 3 lines
    0x1d, 0x56, 0x42, 0x00, // GS V 66 0 partial cut
  ]);
});

test('feed and cut can be switched off', () => {
  const out = encodeRaster(bitmapOf(['#.......']), { feedLines: 0, cut: false });
  assert.deepEqual([...out], [0x1b, 0x40, 0x1d, 0x76, 0x30, 0x00, 0x01, 0x00, 0x01, 0x00, 0x80]);
});

/** Walks the GS v 0 blocks of a job and reports their row counts, checking each data length. */
function bandRows(job: Uint8Array): number[] {
  const rows: number[] = [];
  let at = 2;
  while (job[at] === 0x1d && job[at + 1] === 0x76) {
    const bytesPerRow = job[at + 4] + job[at + 5] * 256;
    const height = job[at + 6] + job[at + 7] * 256;
    rows.push(height);
    at += 8 + bytesPerRow * height;
  }
  assert.deepEqual([...job.subarray(at)], [0x1b, 0x64, 0x03, 0x1d, 0x56, 0x42, 0x00]);
  return rows;
}

test('tall bitmaps are chunked into bands of at most 255 rows', () => {
  const width = paperDots(80);
  const height = 600;
  const out = encodeRaster({ width, height, pixels: new Uint8Array(width * height) });
  assert.deepEqual(bandRows(out), [255, 255, 90]);
});

test('a bitmap of exactly 255 rows is a single band', () => {
  const out = encodeRaster({ width: 384, height: 255, pixels: new Uint8Array(384 * 255) });
  assert.deepEqual(bandRows(out), [255]);
});

test('the band header carries the row width in two bytes', () => {
  const out = encodeRaster({ width: 2048, height: 1, pixels: new Uint8Array(2048) });
  assert.deepEqual([...out.subarray(4, 10)], [0x30, 0x00, 0x00, 0x01, 0x01, 0x00]);
});

test('dark pixels become black, light and transparent ones paper', () => {
  const rgba = Uint8ClampedArray.from([0, 0, 0, 255, 255, 255, 255, 255, 200, 200, 200, 255, 0, 0, 0, 0, 90, 90, 90, 255]);
  assert.deepEqual([...toBitmap(rgba, 5, 1).pixels], [1, 0, 0, 0, 1]);
});

test('dithering turns mid-grey into a roughly half-black pattern', () => {
  const size = 32;
  const rgba = new Uint8ClampedArray(size * size * 4).fill(128);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const black = toBitmap(rgba, size, size, { mode: 'dither' }).pixels.reduce((a, b) => a + b, 0);
  assert.ok(black > size * size * 0.4 && black < size * size * 0.6, `black pixels: ${black}`);
});

test('base64 survives byte arrays larger than the chunk size', () => {
  const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => i % 251);
  assert.deepEqual([...Buffer.from(toBase64(bytes), 'base64')], [...bytes]);
});

// ---- layout (pure: a fake measuring function stands in for the canvas) ----------------------------

/** CJK characters are one em wide, everything else about half an em. */
const fakeMeasure = (px: number) => (s: string) => [...s].reduce((w, ch) => w + (/[⺀-鿿¥×]/.test(ch) ? px : px * 0.5), 0);
const measureFor = (px: number) => fakeMeasure(px);

test('Chinese text wraps between characters when no space is available', () => {
  const lines = wrapText(fakeMeasure(20), '轩尼诗威士忌轩尼诗威士忌轩尼诗', 100);
  assert.deepEqual(lines, ['轩尼诗威士', '忌轩尼诗威', '士忌轩尼诗']);
});

test('English text wraps at spaces', () => {
  assert.deepEqual(wrapText(fakeMeasure(20), 'Johnnie Walker Black', 100), ['Johnnie', 'Walker', 'Black']);
});

test('a newline always starts a new line', () => {
  assert.deepEqual(wrapText(fakeMeasure(20), 'a\nb', 500), ['a', 'b']);
});

test('layout is as wide as the paper and every wrapped line fits inside it', () => {
  const model = { blocks: [
    { t: 'text', text: '夜场收银 NightPOS 夜场收银 NightPOS 夜场收银 NightPOS', size: 2, bold: true, align: 'center' },
    { t: 'row', left: '2 × 轩尼诗 VSOP 700ml 洋酒套餐加长名称加长名称', right: '¥2,576.00' },
    { t: 'rule' },
  ] };
  for (const paperMm of [58, 80]) {
    const { width, height, ops } = layoutModel(model, paperMm, measureFor);
    assert.equal(width, paperDots(paperMm));
    assert.ok(height > 0);
    for (const op of ops.filter((o: any) => o.k === 'text')) {
      assert.ok(fakeMeasure(op.px)(op.text) <= width, `${op.text} too wide`);
    }
  }
});

test('the right-hand amount of a row is aligned to the right margin', () => {
  const { width, ops } = layoutModel({ blocks: [{ t: 'row', left: 'Beer', right: '¥28.00' }] }, 80, measureFor);
  const right = ops.find((o: any) => o.text === '¥28.00');
  assert.deepEqual([right.align, right.x], ['right', width - 6]);
});

test('a row whose value is too long for the label stacks instead of overlapping', () => {
  const { ops } = layoutModel({ blocks: [{ t: 'row', left: 'Item 酒品', right: 'Hennessy VSOP 700ml special edition bottle' }] }, 58, measureFor);
  const left = ops.find((o: any) => o.text === 'Item 酒品');
  const right = ops.find((o: any) => o.align === 'right');
  assert.ok(right.y > left.y);
});

test('more content makes the slip taller', () => {
  const short = layoutModel({ blocks: [{ t: 'text', text: 'a' }] }, 80, measureFor).height;
  const tall = layoutModel({ blocks: [{ t: 'text', text: 'a' }, { t: 'gap' }, { t: 'text', text: 'b' }] }, 80, measureFor).height;
  assert.ok(tall > short);
});
