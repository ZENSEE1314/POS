import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { seed } from '../src/seed.ts';
import { receiptModel, shiftModel, stashModel, ticketModel, testModel, maskPhone, yuan } from '../public/print/templates.js';
import { modelToHtml } from '../public/print/html-fallback.js';

const ENV = { PAY_MODE: 'mock', MOCK_PAY_SECRET: 's3cret' } as NodeJS.ProcessEnv;
let db: Db;
let server: Server;
let base: string;
let token: string;

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  return json;
}

/** Every block as one string: "left | right" for rows, the text for paragraphs. */
const flat = (model: any): string[] => model.blocks.filter((b: any) => b.t === 'text' || b.t === 'row')
  .map((b: any) => (b.t === 'row' ? `${b.left} | ${b.right}` : b.text));
const rowFor = (model: any, needle: string) => flat(model).find((s) => s.includes(needle));
const yuanOf = (s: string) => Number(s.replace(/[^\d.-]/g, '')) * 100;

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  await seed(db);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  token = (await call('POST', '/api/login', { company: 'doloruu', username: 'flag.manager', pin: '4444' })).token;
});
after(async () => {
  server.close();
  await db.close();
});

const ctx = { company: 'Doloruu Group', store: 'Doloruu Flagship', table: 'B1', cashier: 'Manager FLAG', rep: 'Sales FLAG' };

async function partlyPaidBillWithTopUp() {
  const { billId } = await call('POST', '/api/bills', { tableId: 7, repId: 7 }); // B1: min spend 2000.00
  await call('POST', `/api/bills/${billId}/lines`, { productId: 5, qty: 2 }); // 2 x Mixer Pack 68.00
  const voided = (await call('POST', `/api/bills/${billId}/lines`, { productId: 3, qty: 5 })).lineId;
  await call('POST', `/api/bills/${billId}/lines/${voided}/void`, { reason: 'wrong item' });
  await call('POST', `/api/bills/${billId}/lines`, { productId: 4, qty: 1, gift: true, reason: 'birthday' });
  await call('POST', `/api/bills/${billId}/discount`, { amount: 1000, reason: 'regular' });
  await call('POST', `/api/bills/${billId}/pay`, { method: 'cash', amount: 100000 });
  return billId;
}

test('every amount on the receipt equals the bill totals', async () => {
  const { billId } = await call('POST', '/api/bills', { tableId: 8, repId: 7 });
  await call('POST', `/api/bills/${billId}/lines`, { productId: 5, qty: 2 });
  await call('POST', `/api/bills/${billId}/lines`, { productId: 1, qty: 2 }); // 2 x 1288.00: above the min spend
  await call('POST', `/api/bills/${billId}/discount`, { amount: 5000, reason: 'regular' });
  await call('POST', `/api/bills/${billId}/pay`, { method: 'cash' });
  const data = await call('GET', `/api/bills/${billId}`);
  const model = receiptModel(data, ctx, { lang: 'en' });
  assert.equal(yuanOf(rowFor(model, 'Subtotal')!.split('|')[1]), data.totals.subtotal);
  assert.equal(yuanOf(rowFor(model, 'Total')!.split('|')[1]), data.totals.total);
  assert.equal(yuanOf(rowFor(model, 'Discount')!.split('|')[1]), -data.totals.discount);
  assert.equal(yuanOf(rowFor(model, 'Paid')!.split('|')[1]), data.totals.paid);
  assert.equal(rowFor(model, 'Min spend top-up'), undefined);
});

test('printed item amounts add up to the subtotal; voided lines are left off; gifts print at zero and are marked', async () => {
  const billId = await partlyPaidBillWithTopUp();
  const data = await call('GET', `/api/bills/${billId}`);
  const model = receiptModel(data, ctx, { lang: 'en' });
  const lines = flat(model).filter((s) => /^\d+ × /.test(s));
  const sale = lines.filter((s) => !s.includes('[Gift'));
  assert.equal(sale.reduce((sum, s) => sum + yuanOf(s.split('|')[1]), 0), data.totals.subtotal);
  assert.equal(lines.some((s) => s.includes('Tsingtao')), false);
  const gift = lines.find((s) => s.includes('[Gift'))!;
  assert.match(gift, /Fruit Platter/);
  assert.equal(yuanOf(gift.split('|')[1]), 0);
});

test('the min-spend top-up, discount and total match the server arithmetic', async () => {
  const { billId } = await call('POST', '/api/bills', { tableId: 9, repId: 7 });
  await call('POST', `/api/bills/${billId}/lines`, { productId: 5, qty: 2 });
  await call('POST', `/api/bills/${billId}/discount`, { amount: 1000, reason: 'regular' });
  const data = await call('GET', `/api/bills/${billId}`);
  assert.ok(data.totals.minSpendTopUp > 0);
  const model = receiptModel(data, ctx, { lang: 'en' });
  assert.equal(yuanOf(rowFor(model, 'Min spend top-up')!.split('|')[1]), data.totals.minSpendTopUp);
  assert.equal(yuanOf(rowFor(model, 'Total')!.split('|')[1]), data.totals.total);
  assert.equal(yuanOf(rowFor(model, 'Due')!.split('|')[1]), data.totals.due);
  assert.ok(flat(model).some((s) => s.includes('Bill (unpaid)')));
});

test('payments are listed by method with their amounts', async () => {
  const { billId } = await call('POST', '/api/bills', { tableId: 10, repId: 7 });
  await call('POST', `/api/bills/${billId}/lines`, { productId: 1, qty: 2 });
  await call('POST', `/api/bills/${billId}/pay`, { method: 'cash', amount: 100000 });
  await call('POST', `/api/bills/${billId}/pay`, { method: 'credit' });
  const data = await call('GET', `/api/bills/${billId}`);
  const model = receiptModel(data, ctx, { lang: 'en' });
  assert.equal(yuanOf(rowFor(model, 'Cash |')!.split('|')[1]), 100000);
  assert.equal(yuanOf(rowFor(model, 'On account')!.split('|')[1]), data.totals.total - 100000);
});

test('language setting controls which labels appear', async () => {
  const { billId } = await call('POST', '/api/bills', { tableId: 11, repId: 7 });
  await call('POST', `/api/bills/${billId}/lines`, { productId: 3, qty: 1 });
  const data = await call('GET', `/api/bills/${billId}`);
  const text = (lang: string) => flat(receiptModel(data, ctx, { lang })).join('\n');
  assert.match(text('both'), /Total 合计/);
  assert.match(text('zh'), /合计/);
  assert.doesNotMatch(text('zh'), /Total/);
  assert.match(text('en'), /Total/);
  assert.doesNotMatch(text('en'), /合计/);
});

test('English product names print on their own line only in bilingual mode', () => {
  const data = {
    bill: { id: 1, table_id: 1, status: 'settled', opened_at: 1, closed_at: 2 },
    lines: [{ product_id: 9, name: '轩尼诗', qty: 1, unit_price: 100, kind: 'sale', status: 'active' }],
    payments: [], totals: { subtotal: 100, minSpendTopUp: 0, tableFee: 0, discount: 0, total: 100, paid: 100, due: 0 },
  };
  const names = new Map([[9, 'Hennessy']]);
  const subs = (lang: string) => receiptModel(data, { ...ctx, productNames: names }, { lang }).blocks.filter((b: any) => b.sub).map((b: any) => b.sub);
  assert.deepEqual([subs('both'), subs('zh'), subs('en')], [['Hennessy'], [], []]);
});

test('kitchen ticket lists only the lines it is given, with the table, waiter and item count', () => {
  const model = ticketModel({ station: 'bar', table: 'A1', billId: 12, waiter: 'Waiter FLAG', ts: new Date(2026, 0, 2, 21, 5).getTime(),
    lines: [{ name: 'Tsingtao Beer', nameEn: 'Tsingtao Beer', qty: 3 }, { name: '果盘', qty: 1, gift: true }] }, { lang: 'both' });
  const text = flat(model);
  assert.ok(text.some((s) => s.includes('BAR 吧台')));
  assert.ok(text.includes('A1'));
  assert.ok(text.some((s) => s.startsWith('3 × Tsingtao Beer')));
  assert.ok(text.some((s) => s.startsWith('1 × 果盘') && s.includes('Gift')));
  assert.ok(text.some((s) => s.startsWith('4 ')));
  assert.ok(text.some((s) => s.includes('21:05')));
});

test('phone numbers are masked on the stash slip and the code is grouped', () => {
  assert.equal(maskPhone('13800001234'), '138****1234');
  const model = stashModel({ store: 'Flagship', code: '12345678', phone: '13800001234', name: 'Hennessy VSOP', qtyMilli: 1000, leftMilli: 600,
    kind: 'purchased', expiresAt: new Date(2026, 5, 30).getTime(), createdAt: new Date(2026, 2, 1).getTime() }, { lang: 'en' });
  const text = flat(model).join('\n');
  assert.doesNotMatch(text, /13800001234/);
  assert.match(text, /138\*\*\*\*1234/);
  assert.match(text, /1234 5678/);
  assert.match(text, /0\.6 \/ 1\.0 btl/);
  assert.match(text, /2026-06-30/);
});

test('the shift report carries the cash reconciliation and each tender', () => {
  const model = shiftModel({ store: 'Flagship', cashier: 'Cashier FLAG', openedAt: new Date(2026, 0, 2, 18, 0).getTime(), closedAt: new Date(2026, 0, 3, 2, 0).getTime(),
    openingCash: 50000, expectedCash: 250000, countedCash: 249000, variance: -1000, byMethod: [{ method: 'cash', amount: 200000, n: 5 }, { method: 'wechat', amount: 90000, n: 2 }] }, { lang: 'en' });
  const text = flat(model);
  assert.ok(text.some((s) => s.includes('Variance') && s.includes('-¥10.00')));
  assert.ok(text.some((s) => s.includes('Cash ×5') && s.includes('¥2,000.00')));
  assert.ok(text.some((s) => s.includes('WeChat Pay ×2')));
  assert.ok(text.some((s) => s.includes('Counted cash') && s.includes('¥2,490.00')));
});

test('money is formatted in yuan with thousands separators', () => {
  assert.deepEqual([yuan(0), yuan(5), yuan(128800), yuan(-1000), yuan(100000000)], ['¥0.00', '¥0.05', '¥1,288.00', '-¥10.00', '¥1,000,000.00']);
});

test('the browser-print fallback escapes every dynamic string', () => {
  const html = modelToHtml({ blocks: [{ t: 'text', text: '<img src=x onerror=alert(1)>' }, { t: 'row', left: '"><script>x</script>', right: '&' }] }, 80);
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /rcpt--80/);
});

test('the test page names the printer and includes Chinese sample text', () => {
  const text = flat(testModel({ printerName: 'Bar Epson', kind: 'bar', paperMm: 80, ts: 0 }, { lang: 'both' })).join('\n');
  assert.match(text, /Bar Epson/);
  assert.match(text, /中文测试/);
});
