// Print model -> canvas -> 1-bit bitmap -> ESC/POS. Text is rasterised by the browser, so Chinese (and anything else the
// system fonts can draw) prints correctly without GB18030 code-page tables. layoutModel() is pure (it takes a measuring
// function), drawOps() and modelToEscPos() need a canvas.
import { paperDots, toBitmap, encodeRaster } from './escpos.js';

export const FONT_STACK = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC", "WenQuanYi Micro Hei", "SimHei", sans-serif';
const BASE_PX = { 58: 22, 80: 25 };
const SIZE_SCALE = { 1: 1, 2: 1.5, 3: 2.2 };
const SUB_SCALE = 0.8;
const MARGIN_X = 6;
const MARGIN_Y = 8;
const LINE_HEIGHT = 1.3;
const GAP_UNIT = 0.6;
const RULE_HEIGHT = 12;
const MIN_LEFT_SHARE = 0.34;
const COLUMN_GAP = 0.6;
const THRESHOLD_LEVEL = 175;

/** Greedy wrap that breaks at spaces when it can and between any two characters otherwise (Chinese has no spaces). */
export function wrapText(measure, text, maxWidth) {
  const out = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    let line = '';
    let lastSpace = -1;
    for (const ch of Array.from(paragraph)) {
      const next = line + ch;
      if (line === '' || measure(next) <= maxWidth) {
        line = next;
        if (ch === ' ') lastSpace = line.length - 1;
        continue;
      }
      if (ch !== ' ' && lastSpace > 0) {
        out.push(line.slice(0, lastSpace).trimEnd());
        line = line.slice(lastSpace + 1) + ch;
      } else {
        out.push(line.trimEnd());
        line = ch === ' ' ? '' : ch;
      }
      lastSpace = line.lastIndexOf(' ');
    }
    out.push(line.trimEnd());
  }
  return out;
}

/**
 * measureFor(px, bold) -> (text) => width in dots. Returns { width, height, ops } where ops are draw instructions:
 * { k:'rect', x, y, w, h } (black), { k:'rule', y, style }, { k:'text', x, y, text, px, bold, align, white }.
 */
export function layoutModel(model, paperMm, measureFor) {
  const width = paperDots(paperMm);
  const inner = width - 2 * MARGIN_X;
  const base = BASE_PX[paperMm];
  const ops = [];
  let y = MARGIN_Y;
  const pxOf = (size = 1) => Math.round(base * (SIZE_SCALE[size] ?? 1));

  for (const b of model.blocks) {
    if (b.t === 'gap') {
      y += Math.round(base * GAP_UNIT * (b.h ?? 1));
    } else if (b.t === 'rule') {
      ops.push({ k: 'rule', y: y + RULE_HEIGHT / 2, style: b.style ?? 'dash' });
      y += RULE_HEIGHT;
    } else if (b.t === 'text') {
      const px = pxOf(b.size);
      const lineH = Math.round(px * LINE_HEIGHT);
      const lines = wrapText(measureFor(px, b.bold), b.text, inner - (b.invert ? 2 * MARGIN_X : 0));
      if (b.invert) ops.push({ k: 'rect', x: 0, y, w: width, h: lines.length * lineH + 8 });
      const top = b.invert ? y + 4 : y;
      lines.forEach((text, i) => {
        const align = b.align ?? 'left';
        const x = align === 'center' ? width / 2 : align === 'right' ? width - MARGIN_X : MARGIN_X;
        ops.push({ k: 'text', x, y: top + i * lineH + lineH / 2, text, px, bold: b.bold, align, white: Boolean(b.invert) });
      });
      y += lines.length * lineH + (b.invert ? 8 : 0);
    } else if (b.t === 'row') {
      const px = pxOf(b.size);
      const lineH = Math.round(px * LINE_HEIGHT);
      const measure = measureFor(px, b.bold);
      const rightW = b.right ? measure(b.right) : 0;
      const leftMax = inner - rightW - (rightW ? px * COLUMN_GAP : 0);
      const stacked = rightW > 0 && leftMax < inner * MIN_LEFT_SHARE;
      if (stacked) {
        const leftLines = wrapText(measure, b.left, inner);
        leftLines.forEach((text, i) => ops.push({ k: 'text', x: MARGIN_X, y: y + i * lineH + lineH / 2, text, px, bold: b.bold, align: 'left' }));
        y += leftLines.length * lineH;
        const rightLines = wrapText(measure, b.right, inner);
        rightLines.forEach((text, i) => ops.push({ k: 'text', x: width - MARGIN_X, y: y + i * lineH + lineH / 2, text, px, bold: true, align: 'right' }));
        y += rightLines.length * lineH;
      } else {
        const leftLines = wrapText(measure, b.left, leftMax);
        leftLines.forEach((text, i) => ops.push({ k: 'text', x: MARGIN_X, y: y + i * lineH + lineH / 2, text, px, bold: b.bold, align: 'left' }));
        if (b.right) ops.push({ k: 'text', x: width - MARGIN_X, y: y + lineH / 2, text: b.right, px, bold: b.bold, align: 'right' });
        y += leftLines.length * lineH;
      }
      if (b.sub) {
        const subPx = Math.round(px * SUB_SCALE);
        const subH = Math.round(subPx * LINE_HEIGHT);
        for (const text of wrapText(measureFor(subPx, false), b.sub, inner - MARGIN_X * 2)) {
          ops.push({ k: 'text', x: MARGIN_X * 3, y: y + subH / 2, text, px: subPx, bold: false, align: 'left' });
          y += subH;
        }
      }
    }
  }
  return { width, height: y + MARGIN_Y, ops };
}

const fontOf = (px, bold) => `${bold ? 700 : 400} ${px}px ${FONT_STACK}`;

function createCanvas(width, height) {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return new OffscreenCanvas(width, height);
}

function measureForContext(ctx) {
  return (px, bold) => {
    ctx.font = fontOf(px, bold);
    return (text) => ctx.measureText(text).width;
  };
}

/** Draws the model on a fresh white canvas. Returned for rendering, previews and tests in a browser. */
export function renderModelToCanvas(model, paperMm) {
  const scratch = createCanvas(1, 1).getContext('2d');
  const { width, height, ops } = layoutModel(model, paperMm, measureForContext(scratch));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'middle';
  for (const op of ops) {
    if (op.k === 'rect') {
      ctx.fillStyle = '#000';
      ctx.fillRect(op.x, op.y, op.w, op.h);
    } else if (op.k === 'rule') {
      ctx.strokeStyle = '#000';
      ctx.lineWidth = op.style === 'solid' ? 3 : 2;
      ctx.setLineDash(op.style === 'dash' ? [8, 5] : []);
      ctx.beginPath();
      ctx.moveTo(MARGIN_X, op.y);
      ctx.lineTo(width - MARGIN_X, op.y);
      ctx.stroke();
    } else {
      ctx.font = fontOf(op.px, op.bold);
      ctx.textAlign = op.align;
      ctx.fillStyle = op.white ? '#fff' : '#000';
      ctx.fillText(op.text, op.x, op.y);
    }
  }
  return canvas;
}

/** The bytes to send to the bridge for one copy of the model. */
export function modelToEscPos(model, paperMm, encodeOptions = {}) {
  const canvas = renderModelToCanvas(model, paperMm);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return encodeRaster(toBitmap(data, canvas.width, canvas.height, { mode: 'threshold', level: THRESHOLD_LEVEL }), encodeOptions);
}
