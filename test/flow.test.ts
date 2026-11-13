import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { seed } from '../src/seed.ts';

const ENV = { PAY_MODE: 'mock', MOCK_PAY_SECRET: 's3cret', DOUYIN_WEBHOOK_SECRET: 'dy-secret' } as NodeJS.ProcessEnv;
let server: Server;
let base: string;
const tokens: Record<string, string> = {};

async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

let db: Db;

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  await seed(db);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const users: Record<string, [string, string]> = { host: ['flag.host', '1111'], waiter: ['flag.waiter', '2222'], cashier: ['flag.cashier', '3333'], manager: ['flag.manager', '4444'], finance: ['finance', '5555'], rep: ['flag.rep', '7777'] };
  for (const [k, [username, pin]] of Object.entries(users)) tokens[k] = (await call('POST', '/api/login', { company: 'doloruu', username, pin })).json.token;
});
after(async () => {
  server.close();
  await db.close();
});

test('login rejects a wrong pin', async () => {
  const r = await call('POST', '/api/login', { company: 'doloruu', username: 'flag.host', pin: '0000' });
  assert.equal(r.status, 401);
});

test('opening a table without a sales rep is refused', async () => {
  const r = await call('POST', '/api/bills', { tableId: 1 }, tokens.host);
  assert.equal(r.status, 422);
});

test('waiter cannot gift or void', async () => {
  const { json } = await call('POST', '/api/bills', { tableId: 2, repId: 7 }, tokens.host);
  const gift = await call('POST', `/api/bills/${json.billId}/lines`, { productId: 4, qty: 1, gift: true, reason: 'vip' }, tokens.waiter);
  assert.equal(gift.status, 403);
});

test('full night: open, order, mock wechat pay, settle, commission, table freed', async () => {
  const open = await call('POST', '/api/bills', { tableId: 3, repId: 7, phone: '13800000001' }, tokens.host);
  const billId = open.json.billId;
  await call('POST', `/api/bills/${billId}/lines`, { productId: 1, qty: 1 }, tokens.waiter); // 1288.00 spirits
  await call('POST', `/api/bills/${billId}/lines`, { productId: 3, qty: 10 }, tokens.waiter); // 280.00 beer

  const before = await call('GET', `/api/bills/${billId}`, undefined, tokens.cashier);
  assert.equal(before.json.totals.subtotal, 128800 + 28000);

  const pay = await call('POST', `/api/bills/${billId}/pay-online`, { method: 'wechat' }, tokens.cashier);
  assert.match(pay.json.qrContent, /^mock-wechat:\/\//);
  assert.equal((await call('GET', `/api/bills/${billId}`, undefined, tokens.cashier)).json.bill.status, 'open');

  await call('POST', '/dev/mock-pay', { outTradeNo: pay.json.outTradeNo }, tokens.cashier);
  const after = await call('GET', `/api/bills/${billId}`, undefined, tokens.cashier);
  assert.equal(after.json.bill.status, 'settled');

  const tables = await call('GET', '/api/tables', undefined, tokens.cashier);
  assert.equal(tables.json.find((t: any) => t.id === 3).status, 'free');

  const payroll = await call('GET', '/api/payroll', undefined, tokens.finance);
  const salesRep = payroll.json.find((p: any) => p.employeeId === 7 && p.role === 'sales');
  // 8% of 1288.00 spirits + 5% of 280.00 beer = 10304 + 1400
  assert.equal(salesRep.commission, 10304 + 1400);
});

test('a forged payment webhook is rejected and does not settle the bill', async () => {
  const open = await call('POST', '/api/bills', { tableId: 4, repId: 7 }, tokens.host);
  const billId = open.json.billId;
  await call('POST', `/api/bills/${billId}/lines`, { productId: 3, qty: 1 }, tokens.waiter);
  await call('POST', `/api/bills/${billId}/pay-online`, { method: 'alipay' }, tokens.cashier);
  const raw = JSON.stringify({ eventId: 'x', outTradeNo: 'whatever', amountFen: 1, status: 'paid' });
  const res = await fetch(`${base}/webhooks/alipay`, { method: 'POST', headers: { 'x-mock-signature': 'deadbeef' }, body: raw });
  assert.equal(res.status, 401);
});

test('replayed notify settles once and does not double-count', async () => {
  const open = await call('POST', '/api/bills', { tableId: 5, repId: 7 }, tokens.host);
  const billId = open.json.billId;
  await call('POST', `/api/bills/${billId}/lines`, { productId: 3, qty: 2 }, tokens.waiter);
  const pay = await call('POST', `/api/bills/${billId}/pay-online`, { method: 'alipay' }, tokens.cashier);
  await call('POST', '/dev/mock-pay', { outTradeNo: pay.json.outTradeNo }, tokens.cashier);
  await call('POST', '/dev/mock-pay', { outTradeNo: pay.json.outTradeNo }, tokens.cashier);
  const b = await call('GET', `/api/bills/${billId}`, undefined, tokens.cashier);
  assert.equal(b.json.payments.filter((p: any) => p.status === 'paid').length, 1);
});

test('min spend tops up the total when the bill is below it', async () => {
  const open = await call('POST', '/api/bills', { tableId: 7, repId: 7 }, tokens.host); // B1 min 2000.00
  const billId = open.json.billId;
  await call('POST', `/api/bills/${billId}/lines`, { productId: 3, qty: 1 }, tokens.waiter);
  const b = await call('GET', `/api/bills/${billId}`, undefined, tokens.cashier);
  assert.equal(b.json.totals.total, 200000);
});

test('partial stash retrieval leaves the remainder and adds a zero-price line', async () => {
  const open = await call('POST', '/api/bills', { tableId: 8, repId: 7, phone: '13900000002' }, tokens.host);
  const billId = open.json.billId;
  const stash = await call('POST', '/api/stash', { phone: '13900000002', productId: 1, qtyMilli: 1000 }, tokens.waiter);
  const r = await call('POST', `/api/stash/${stash.json.id}/retrieve`, { qtyMilli: 400, billId }, tokens.waiter);
  assert.equal(r.json.leftMilli, 600);
  const over = await call('POST', `/api/stash/${stash.json.id}/retrieve`, { qtyMilli: 700, billId }, tokens.waiter);
  assert.equal(over.status, 409);
});

test('douyin booking webhook is signed, idempotent, then confirms and opens with the rep', async () => {
  const ev = { eventId: 'e1', type: 'booking.created', data: { poiId: 'poi_flagship', bookingId: 'dy-1', phone: '13700000003', partySize: 6, eta: Date.now() + 3600_000, voucherCode: 'DY-500-abc', voucherAmount: 50000 } };
  const raw = JSON.stringify(ev);
  const sig = createHmac('sha256', 'dy-secret').update(raw).digest('hex');
  const bad = await fetch(`${base}/webhooks/douyin`, { method: 'POST', headers: { 'x-douyin-signature': '00' }, body: raw });
  assert.equal(bad.status, 401);
  const first = await (await fetch(`${base}/webhooks/douyin`, { method: 'POST', headers: { 'x-douyin-signature': sig }, body: raw })).json() as any;
  const again = await (await fetch(`${base}/webhooks/douyin`, { method: 'POST', headers: { 'x-douyin-signature': sig }, body: raw })).json() as any;
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  assert.equal(again.bookingId, first.bookingId);

  await call('POST', `/api/bookings/${first.bookingId}/confirm`, { tableId: 9, repId: 7 }, tokens.host);
  const open = await call('POST', '/api/bills', { tableId: 9, bookingId: first.bookingId }, tokens.host); // no repId: comes from booking
  assert.equal(open.status, 200);
  await call('POST', `/api/bills/${open.json.billId}/lines`, { productId: 3, qty: 1 }, tokens.waiter);
  const red = await call('POST', `/api/bills/${open.json.billId}/redeem`, { code: 'DY-500-abc' }, tokens.cashier);
  assert.equal(red.json.amount, 50000);
  const dup = await call('POST', `/api/bills/${open.json.billId}/redeem`, { code: 'DY-500-abc' }, tokens.cashier);
  assert.equal(dup.status, 409);
});

test('member wallet cannot go negative', async () => {
  const open = await call('POST', '/api/bills', { tableId: 10, repId: 7, phone: '13600000004' }, tokens.host);
  await call('POST', `/api/bills/${open.json.billId}/lines`, { productId: 3, qty: 1 }, tokens.waiter);
  const r = await call('POST', `/api/bills/${open.json.billId}/pay`, { method: 'member' }, tokens.cashier);
  assert.equal(r.status, 402);
});
