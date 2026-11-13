// Pure builders: bill / ticket / stash / shift data in, a "print model" out. A model is a list of blocks:
//   { t:'text', text, size?, bold?, align?, invert? }   one paragraph (wraps)
//   { t:'row', left, right, sub?, size?, bold? }         left wraps, right is right-aligned, sub = small second line
//   { t:'rule', style? }  { t:'gap', h? }
// Rendering (canvas raster or HTML) lives elsewhere; nothing here touches the DOM, so it is unit-tested in Node.
import { label, nameFor, subNameFor } from './labels.js';

const FEN_PER_YUAN = 100;
const MILLI_PER_BOTTLE = 1000;
const PHONE_KEEP_HEAD = 3;
const PHONE_KEEP_TAIL = 4;
export const DEFAULT_FOOTER = 'Thank you! 谢谢惠顾';

const pad = (n) => String(n).padStart(2, '0');

export function yuan(fen) {
  const n = Number(fen ?? 0);
  const abs = Math.abs(n) / FEN_PER_YUAN;
  const [whole, cents] = abs.toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}¥${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`;
}

export function fmtStamp(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const fmtDay = (ms) => fmtStamp(ms).slice(0, 10);
export const fmtClock = (ms) => fmtStamp(ms).slice(11);

export function maskPhone(phone) {
  const s = String(phone ?? '');
  if (s.length <= PHONE_KEEP_HEAD + PHONE_KEEP_TAIL) return s.length ? `${'*'.repeat(Math.max(0, s.length - 2))}${s.slice(-2)}` : '';
  return `${s.slice(0, PHONE_KEEP_HEAD)}${'*'.repeat(s.length - PHONE_KEEP_HEAD - PHONE_KEEP_TAIL)}${s.slice(-PHONE_KEEP_TAIL)}`;
}

export function fmtBottles(milli) {
  const v = Number(milli) / MILLI_PER_BOTTLE;
  return v.toFixed(Number(milli) % 100 === 0 ? 1 : 2);
}

const text = (t, opts = {}) => ({ t: 'text', text: t, ...opts });
const row = (left, right, opts = {}) => ({ t: 'row', left, right, ...opts });
const rule = (style = 'dash') => ({ t: 'rule', style });
const gap = (h = 1) => ({ t: 'gap', h });

/** "Label  value" row with a bilingual label. */
const kv = (key, value, lang, opts = {}) => row(label(key, lang), String(value), opts);

// ---- customer receipt ----------------------------------------------------------------------------

/**
 * data: { bill, lines, payments, totals } exactly as GET /api/bills/:id returns it.
 * ctx:  { company, store, table, cashier, rep?, footer?, productNames?: Map(productId -> name_en) }.
 * Every amount printed is taken from `totals` / the lines / the payments; nothing is recomputed here.
 */
export function receiptModel(data, ctx, { lang = 'both' } = {}) {
  const { bill, lines, payments, totals } = data;
  const settled = bill.status === 'settled';
  const blocks = [];
  if (ctx.company) blocks.push(text(ctx.company, { size: 2, bold: true, align: 'center' }));
  if (ctx.store) blocks.push(text(ctx.store, { bold: true, align: 'center' }));
  blocks.push(text(label(settled ? 'receipt' : 'preBill', lang), { align: 'center' }), gap(), rule());
  blocks.push(kv('bill', `#${bill.id}`, lang), kv('table', ctx.table ?? `#${bill.table_id}`, lang), kv('opened', fmtStamp(bill.opened_at), lang));
  if (settled && bill.closed_at) blocks.push(kv('closed', fmtStamp(bill.closed_at), lang));
  if (ctx.cashier) blocks.push(kv('cashier', ctx.cashier, lang));
  if (ctx.rep) blocks.push(kv('sales', ctx.rep, lang));
  blocks.push(rule());
  for (const l of lines.filter((x) => x.status === 'active')) {
    const en = ctx.productNames?.get(l.product_id);
    const gift = l.kind === 'gift';
    const name = `${l.qty} × ${nameFor(l.name, en, lang)}`;
    const sub = subNameFor(l.name, en, lang);
    blocks.push(row(gift ? `${name}  [${label('gift', lang)}]` : name, yuan(gift ? 0 : l.qty * l.unit_price), { sub: sub || undefined }));
  }
  blocks.push(rule());
  blocks.push(kv('subtotal', yuan(totals.subtotal), lang));
  if (totals.minSpendTopUp > 0) blocks.push(kv('topUp', yuan(totals.minSpendTopUp), lang));
  if (totals.tableFee > 0) blocks.push(kv('tableFee', yuan(totals.tableFee), lang));
  if (totals.discount > 0) blocks.push(kv('discount', `-${yuan(totals.discount)}`, lang));
  blocks.push(rule('solid'), kv('total', yuan(totals.total), lang, { size: 2, bold: true }), rule('solid'));
  const paidRows = payments.filter((p) => p.status === 'paid');
  if (paidRows.length) {
    blocks.push(text(label('payments', lang), { bold: true }));
    for (const p of paidRows) blocks.push(row(label(`pay.${p.method}`, lang), yuan(p.amount)));
    blocks.push(kv('paid', yuan(totals.paid), lang));
  }
  if (totals.due > 0) blocks.push(kv('due', yuan(totals.due), lang, { bold: true }));
  blocks.push(gap(), text(ctx.footer || DEFAULT_FOOTER, { align: 'center' }));
  return { title: `${label('receipt', 'en')} #${bill.id}`, blocks };
}

// ---- kitchen / bar ticket --------------------------------------------------------------------------

/** t: { station: 'bar'|'kitchen', table, billId, waiter, ts, lines: [{ name, nameEn?, qty, gift? }] } - only the NEW lines. */
export function ticketModel(t, { lang = 'both' } = {}) {
  const blocks = [text(label(t.station, lang), { size: 2, bold: true, align: 'center', invert: true }), gap()];
  blocks.push(text(`${label('ticketTable', lang)}`, { align: 'center' }), text(String(t.table), { size: 3, bold: true, align: 'center' }), gap());
  blocks.push(kv('waiter', t.waiter ?? '', lang), kv('time', fmtClock(t.ts), lang), kv('bill', `#${t.billId}`, lang), rule());
  let count = 0;
  for (const l of t.lines) {
    count += l.qty;
    const gift = l.gift ? `  [${label('gift', lang)}]` : '';
    blocks.push(text(`${l.qty} × ${nameFor(l.name, l.nameEn, lang)}${gift}`, { size: 2, bold: true }));
    const sub = subNameFor(l.name, l.nameEn, lang);
    if (sub) blocks.push(text(sub));
    blocks.push(gap());
  }
  blocks.push(rule(), text(`${count} ${label('items', lang)}`, { align: 'center' }));
  return { title: `${label(t.station, 'en')} ${t.table}`, blocks };
}

// ---- stash slip --------------------------------------------------------------------------------------

/** s: { store?, code, phone, name, nameEn?, qtyMilli, leftMilli, kind, expiresAt, createdAt } (a row of GET /api/stash). */
export function stashModel(s, { lang = 'both' } = {}) {
  const unit = label('bottlesUnit', lang === 'both' ? 'zh' : lang);
  const code = String(s.code).replace(/(\d{4})(?=\d)/g, '$1 ');
  const blocks = [text(label('stash', lang), { size: 2, bold: true, align: 'center' })];
  if (s.store) blocks.push(text(s.store, { align: 'center' }));
  blocks.push(gap(), text(label('stashCode', lang), { align: 'center' }), text(code, { size: 3, bold: true, align: 'center' }), gap(), rule());
  blocks.push(kv('phone', maskPhone(s.phone), lang));
  blocks.push(row(label('product', lang), nameFor(s.name, s.nameEn, lang), { bold: true }));
  blocks.push(kv('bottlesLeft', `${fmtBottles(s.leftMilli)} / ${fmtBottles(s.qtyMilli)} ${unit}`, lang, { bold: true }));
  blocks.push(kv('kind', label(`kind.${s.kind}`, lang), lang));
  if (s.createdAt) blocks.push(kv('stored', fmtDay(s.createdAt), lang));
  blocks.push(kv('expires', fmtDay(s.expiresAt), lang, { bold: true }), rule(), gap(), text(label('keepSlip', lang), { align: 'center' }));
  return { title: `${label('stash', 'en')} ${s.code}`, blocks };
}

// ---- shift close report ---------------------------------------------------------------------------------

/** r: { store, cashier, openedAt, closedAt, openingCash, expectedCash, countedCash, variance, byMethod: [{ method, amount, n }] } */
export function shiftModel(r, { lang = 'both' } = {}) {
  const blocks = [text(label('shiftReport', lang), { size: 2, bold: true, align: 'center' })];
  if (r.store) blocks.push(text(r.store, { align: 'center' }));
  blocks.push(gap(), rule(), kv('cashier', r.cashier ?? '', lang), kv('shiftOpened', fmtStamp(r.openedAt), lang), kv('shiftClosed', fmtStamp(r.closedAt), lang), rule());
  blocks.push(kv('openingCash', yuan(r.openingCash), lang));
  blocks.push(text(label('byMethod', lang), { bold: true }));
  for (const m of r.byMethod) blocks.push(row(`${label(`pay.${m.method}`, lang)}${m.n ? ` ×${m.n}` : ''}`, yuan(m.amount)));
  blocks.push(rule(), kv('expectedCash', yuan(r.expectedCash), lang), kv('countedCash', yuan(r.countedCash), lang));
  blocks.push(kv('variance', yuan(r.variance), lang, { size: 2, bold: true }), rule('solid'), gap(2), text('____________________', { align: 'center' }), text(label('cashier', lang), { align: 'center' }));
  return { title: `${label('shiftReport', 'en')}`, blocks };
}

// ---- test page ---------------------------------------------------------------------------------------------

export function testModel({ printerName, kind, paperMm, ts = Date.now() }, { lang = 'both' } = {}) {
  return {
    title: label('testTitle', 'en'),
    blocks: [
      text(label('testTitle', lang), { size: 2, bold: true, align: 'center' }), gap(), rule(),
      kv('testPrinter', printerName, lang), kv('kind', kind, lang), kv('testPaper', `${paperMm}mm`, lang), kv('time', fmtStamp(ts), lang), rule(),
      text(label('testSample', lang), { bold: true }),
      text('The quick brown fox jumps over the lazy dog 0123456789'),
      text('中文测试：夜场收银 威士忌 啤酒 果盘，合计 ¥1,288.00'),
      row('2 × Hennessy VSOP 轩尼诗', yuan(257600)), gap(), text(DEFAULT_FOOTER, { align: 'center' }),
    ],
  };
}
