import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { seed } from '../src/seed.ts';

const ENV = { PAY_MODE: 'mock', MOCK_PAY_SECRET: 's3cret', DOUYIN_WEBHOOK_SECRET: 'dy-secret', PLATFORM_ADMIN_KEY: 'adm' } as NodeJS.ProcessEnv;
const ADMIN = { 'x-admin-key': 'adm' };
const HOUR = 3_600_000;
const MIN = 60_000;
let db: Db;
let server: Server;
let base: string;
const tok: Record<string, string> = {};

async function call(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}
const is4xx = (r: { status: number }) => r.status >= 400 && r.status < 500;

// Seeded ids: 1 owner, 2 finance, store 1 staff 3-7 (rep = 7), store 2 staff 8-12 (rep = 12).
// Store 1 tables 1-14, store 2 tables 15-28. Store 1 products 1-5 (3 = beer 2800), store 2 products 6-10.
before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  await seed(db);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const staff: Record<string, [string, string]> = {
    owner: ['owner', '6666'], finance: ['finance', '5555'],
    s1host: ['flag.host', '1111'], s1waiter: ['flag.waiter', '2222'], s1cashier: ['flag.cashier', '3333'], s1manager: ['flag.manager', '4444'],
    s2host: ['lnge.host', '1111'], s2waiter: ['lnge.waiter', '2222'], s2cashier: ['lnge.cashier', '3333'], s2manager: ['lnge.manager', '4444'],
  };
  for (const [k, [username, pin]] of Object.entries(staff)) tok[k] = (await call('POST', '/api/login', { company: 'doloruu', username, pin })).json.token;
});
after(async () => {
  server.close();
  await db.close();
});

let seq = 0;
const uniq = (p: string) => `${p}${Date.now().toString(36)}${++seq}`;
const phoneN = () => `139${String(10_000_000 + ++seq).slice(-8)}`;

async function newTable(minSpend = 0, tableFee = 0, token = tok.s1manager): Promise<number> {
  const r = await call('POST', '/api/tables', { name: uniq('T'), kind: 'booth', minSpend, tableFee }, token);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.tableId;
}
async function newProduct(price: number, stock: number, extra: Record<string, unknown> = {}, token = tok.s1manager): Promise<number> {
  const r = await call('POST', '/api/products', { name: uniq('P'), price, stock, ...extra }, token);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.productId;
}
async function openBill(tableId: number, extra: Record<string, unknown> = {}, token = tok.s1host, repId = 7): Promise<number> {
  const r = await call('POST', '/api/bills', { tableId, repId, ...extra }, token);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.billId;
}
const addSale = async (billId: number, productId: number, qty: number, token = tok.s1waiter) => {
  const r = await call('POST', `/api/bills/${billId}/lines`, { productId, qty }, token);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.lineId as number;
};
const payCash = (billId: number, amount?: number, token = tok.s1cashier) => call('POST', `/api/bills/${billId}/pay`, amount === undefined ? { method: 'cash' } : { method: 'cash', amount }, token);
const bill = async (id: number, token = tok.s1manager) => (await call('GET', `/api/bills/${id}`, undefined, token)).json;
const heal = async () => {
  const r = await call('POST', '/platform/selfheal', undefined, undefined, ADMIN);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json as { checked: number; healed: Array<{ kind: string; ids: number[] }>; alerts: Array<{ kind: string; ids: number[] }> };
};
const healedIds = (r: Awaited<ReturnType<typeof heal>>, kind: string) => r.healed.find((h) => h.kind === kind)?.ids ?? [];
const alertIds = (r: Awaited<ReturnType<typeof heal>>, kind: string) => r.alerts.find((h) => h.kind === kind)?.ids ?? [];
const insertPayment = (billId: number, amount: number, status: string, ageMs = 0, method = 'cash') =>
  db.run('INSERT INTO payments (bill_id, method, amount, status, out_trade_no, created_at, paid_at) VALUES (?,?,?,?,?,?,?)',
    [billId, method, amount, status, status === 'pending' ? uniq('NPX') : null, Date.now() - ageMs, status === 'paid' ? Date.now() - ageMs : null]);

// ============================================================================================
// STASH
// ============================================================================================

test('stash: ten 0.1-bottle retrievals are exact, the eleventh is refused and the item is closed', async () => {
  const phone = phoneN();
  const s = (await call('POST', '/api/stash', { phone, productId: 3, qtyMilli: 1000 }, tok.s1waiter)).json;
  assert.match(s.code, /^\d{8}$/);
  const bill1 = await openBill(await newTable());
  for (let i = 1; i <= 10; i++) {
    const r = await call('POST', `/api/stash/${s.id}/retrieve`, { qtyMilli: 100, billId: bill1 }, tok.s1waiter);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.leftMilli, 1000 - 100 * i);
  }
  assert.equal((await call('POST', `/api/stash/${s.id}/retrieve`, { qtyMilli: 100, billId: bill1 }, tok.s1waiter)).status, 409);
  assert.equal((await db.one('SELECT status, left_milli FROM stash WHERE id = ?', [s.id])).status, 'retrieved');
  assert.equal((await call('GET', `/api/stash?q=${phone}`, undefined, tok.s1waiter)).json.length, 0);
  const lines = (await bill(bill1)).lines.filter((l: any) => l.reason === `stash:${s.id}`);
  assert.equal(lines.length, 10);
  assert.ok(lines.every((l: any) => l.unit_price === 0 && l.kind === 'gift'));
});

test('stash: retrieving exactly the remainder closes it; over-retrieval is refused and changes nothing', async () => {
  const s = (await call('POST', '/api/stash', { phone: phoneN(), productId: 3, qtyMilli: 700 }, tok.s1waiter)).json;
  const b = await openBill(await newTable());
  assert.equal((await call('POST', `/api/stash/${s.id}/retrieve`, { qtyMilli: 701, billId: b }, tok.s1waiter)).status, 409);
  assert.equal((await db.one('SELECT left_milli FROM stash WHERE id = ?', [s.id])).left_milli, 700);
  assert.equal((await call('POST', `/api/stash/${s.id}/retrieve`, { qtyMilli: 300, billId: b }, tok.s1waiter)).json.leftMilli, 400);
  assert.equal((await call('POST', `/api/stash/${s.id}/retrieve`, { qtyMilli: 400, billId: b }, tok.s1waiter)).json.leftMilli, 0);
  assert.equal((await db.one('SELECT status FROM stash WHERE id = ?', [s.id])).status, 'retrieved');
});

test('stash: invalid retrieve quantities are 4xx and never 500', async () => {
  const s = (await call('POST', '/api/stash', { phone: phoneN(), productId: 3, qtyMilli: 1000 }, tok.s1waiter)).json;
  const b = await openBill(await newTable());
  for (const qtyMilli of [0, -100, 1.5, 'abc', null, undefined, 1e30]) {
    const r = await call('POST', `/api/stash/${s.id}/retrieve`, { qtyMilli, billId: b }, tok.s1waiter);
    assert.ok(is4xx(r), `qtyMilli=${String(qtyMilli)} -> ${r.status}`);
  }
  assert.ok(is4xx(await call('POST', `/api/stash/${s.id}/retrieve`, { qtyMilli: 100, billId: 'x' }, tok.s1waiter)));
  assert.ok(is4xx(await call('POST', `/api/stash/${s.id}/retrieve`, { qtyMilli: 100 }, tok.s1waiter)));
  assert.equal((await call('POST', '/api/stash/999999/retrieve', { qtyMilli: 100, billId: b }, tok.s1waiter)).status, 404);
  assert.equal((await db.one('SELECT left_milli FROM stash WHERE id = ?', [s.id])).left_milli, 1000);
});

test('stash: store-side validation rejects bad input with 4xx', async () => {
  const phone = phoneN();
  const bad: unknown[] = [
    { phone, productId: 3, qtyMilli: 0 }, { phone, productId: 3, qtyMilli: 10001 }, { phone, productId: 3, qtyMilli: 0.5 },
    { phone, productId: 3, qtyMilli: '1000' }, { phone, productId: 3 }, { productId: 3, qtyMilli: 1000 },
    { phone: '', productId: 3, qtyMilli: 1000 }, { phone: '   ', productId: 3, qtyMilli: 1000 }, { phone: { a: 1 }, productId: 3, qtyMilli: 1000 },
    { phone, qtyMilli: 1000 }, { phone, productId: 'abc', qtyMilli: 1000 }, { phone, productId: 6, qtyMilli: 1000 },
    { phone, productId: 3, qtyMilli: 1000, days: -5 }, { phone, productId: 3, qtyMilli: 1000, days: 'abc' },
    { phone, productId: 3, qtyMilli: 1000, days: 1e12 }, { phone, productId: 3, qtyMilli: 1000, days: 0 },
    { phone, productId: 3, qtyMilli: 1000, kind: 'stolen' },
  ];
  for (const body of bad) {
    const r = await call('POST', '/api/stash', body, tok.s1waiter);
    assert.ok(is4xx(r), `${JSON.stringify(body)} -> ${r.status}`);
  }
  assert.equal((await db.one('SELECT COUNT(*) AS n FROM stash WHERE phone = ?', [phone])).n, 0);
});

test('stash: a host may not store or retrieve wine', async () => {
  assert.equal((await call('POST', '/api/stash', { phone: phoneN(), productId: 3, qtyMilli: 100 }, tok.s1host)).status, 403);
});

test('stash: expired item cannot be retrieved, is hidden from lookup, and expireStash closes it', async () => {
  const phone = phoneN();
  const s = (await call('POST', '/api/stash', { phone, productId: 3, qtyMilli: 1000, days: 1 }, tok.s1waiter)).json;
  const b = await openBill(await newTable());
  await db.run('UPDATE stash SET expires_at = ? WHERE id = ?', [Date.now() - 1000, s.id]);
  const r = await call('POST', `/api/stash/${s.id}/retrieve`, { qtyMilli: 100, billId: b }, tok.s1waiter);
  assert.equal(r.status, 409);
  assert.match(r.json.error, /expired/);
  assert.equal((await call('GET', `/api/stash?q=${phone}`, undefined, tok.s1waiter)).json.length, 0);
  assert.equal((await call('POST', '/api/maintenance/expire-stash', {}, tok.s1waiter)).status, 403);
  assert.ok((await call('POST', '/api/maintenance/expire-stash', {}, tok.s1manager)).json.expired >= 1);
  assert.equal((await db.one('SELECT status FROM stash WHERE id = ?', [s.id])).status, 'expired');
  const again = await call('POST', `/api/stash/${s.id}/retrieve`, { qtyMilli: 100, billId: b }, tok.s1waiter);
  assert.equal(again.status, 409);
  assert.equal((await call('POST', `/api/stash/${s.id}/transfer`, { toStoreId: 2 }, tok.s1manager)).status, 404);
});

test('stash: cannot be retrieved onto a closed bill, another store bill, or by another store', async () => {
  const s = (await call('POST', '/api/stash', { phone: phoneN(), productId: 3, qtyMilli: 1000 }, tok.s1waiter)).json;
  const closed = await openBill(await newTable());
  await addSale(closed, 3, 1);
  assert.equal((await payCash(closed)).json.settled, true);
  assert.equal((await call('POST', `/api/stash/${s.id}/retrieve`, { qtyMilli: 100, billId: closed }, tok.s1waiter)).status, 404);
  const otherStoreBill = await openBill(24, {}, tok.s2host, 12);
  assert.equal((await call('POST', `/api/stash/${s.id}/retrieve`, { qtyMilli: 100, billId: otherStoreBill }, tok.s1waiter)).status, 404);
  assert.equal((await call('POST', `/api/stash/${s.id}/retrieve`, { qtyMilli: 100, billId: otherStoreBill }, tok.s2waiter)).status, 404);
  assert.equal((await db.one('SELECT left_milli FROM stash WHERE id = ?', [s.id])).left_milli, 1000);
});

test('stash: 300 stash codes are unique', async () => {
  const phone = phoneN();
  const codes = new Set<string>();
  for (let i = 0; i < 300; i++) {
    const r = await call('POST', '/api/stash', { phone, productId: 3, qtyMilli: 1 }, tok.s1waiter);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    codes.add(r.json.code);
  }
  assert.equal(codes.size, 300);
});

test('stash: transfer rules (role, destination, foreign tenant, retrieved item) and stock isolation across stores', async () => {
  const phone = phoneN();
  const s = (await call('POST', '/api/stash', { phone, productId: 3, qtyMilli: 1000 }, tok.s1waiter)).json;
  assert.equal((await call('POST', `/api/stash/${s.id}/transfer`, { toStoreId: 2 }, tok.s1waiter)).status, 403);
  assert.equal((await call('POST', `/api/stash/${s.id}/transfer`, { toStoreId: 99999 }, tok.s1manager)).status, 404);
  assert.ok(is4xx(await call('POST', `/api/stash/${s.id}/transfer`, { toStoreId: 'abc' }, tok.s1manager)));
  assert.ok(is4xx(await call('POST', `/api/stash/${s.id}/transfer`, {}, tok.s1manager)));
  const foreign = (await call('POST', '/platform/companies', { name: 'Foreign', code: uniq('frn'), storeName: 'F1', ownerName: 'F', ownerUsername: 'fboss', ownerPin: '123456' }, undefined, ADMIN)).json;
  assert.equal((await call('POST', `/api/stash/${s.id}/transfer`, { toStoreId: foreign.storeId }, tok.s1manager)).status, 404);
  assert.equal((await call('POST', `/api/stash/${s.id}/transfer`, { toStoreId: 2 }, tok.s2manager)).status, 404);
  assert.equal((await call('POST', `/api/stash/${s.id}/transfer`, { toStoreId: 2 }, tok.s1manager)).status, 200);
  assert.equal((await call('GET', `/api/stash?q=${phone}`, undefined, tok.s1waiter)).json.length, 0);
  assert.equal((await call('GET', `/api/stash?q=${phone}`, undefined, tok.s2waiter)).json.length, 1);

  // Retrieve at store 2: the store-1 product must not lose stock when the store-2 bill settles.
  const stockBefore = (await db.one('SELECT stock FROM products WHERE id = 3')).stock;
  const movesBefore = (await db.one('SELECT COUNT(*) AS n FROM stock_movements WHERE product_id = 3')).n;
  const b2 = await openBill(25, {}, tok.s2host, 12);
  assert.equal((await call('POST', `/api/stash/${s.id}/retrieve`, { qtyMilli: 100, billId: b2 }, tok.s2waiter)).status, 200);
  await call('POST', `/api/bills/${b2}/lines`, { productId: 8, qty: 1 }, tok.s2waiter);
  assert.equal((await call('POST', `/api/bills/${b2}/pay`, { method: 'cash' }, tok.s2cashier)).json.settled, true);
  assert.equal((await db.one('SELECT stock FROM products WHERE id = 3')).stock, stockBefore);
  assert.equal((await db.one('SELECT COUNT(*) AS n FROM stock_movements WHERE product_id = 3')).n, movesBefore);

  // a fully retrieved item can no longer be transferred
  assert.equal((await call('POST', `/api/stash/${s.id}/retrieve`, { qtyMilli: 900, billId: b2 }, tok.s2waiter)).status, 404); // bill is settled
  const b3 = await openBill(26, {}, tok.s2host, 12);
  assert.equal((await call('POST', `/api/stash/${s.id}/retrieve`, { qtyMilli: 900, billId: b3 }, tok.s2waiter)).status, 200);
  assert.equal((await call('POST', `/api/stash/${s.id}/transfer`, { toStoreId: 1 }, tok.s2manager)).status, 404);
});

// ============================================================================================
// BOOKINGS
// ============================================================================================

const dyEvent = (bookingId: string, over: Record<string, unknown> = {}, poiId = 'poi_flagship') => ({
  eventId: bookingId, type: 'booking.created',
  data: { poiId, bookingId, phone: phoneN(), name: 'Zed', partySize: 4, eta: Date.now() + HOUR, ...over },
});
async function dyPost(payload: unknown, opts: { raw?: string; sig?: string | null; secret?: string } = {}): Promise<{ status: number; json: any }> {
  const raw = opts.raw ?? JSON.stringify(payload);
  const sig = opts.sig === undefined ? createHmac('sha256', opts.secret ?? 'dy-secret').update(raw).digest('hex') : opts.sig;
  const res = await fetch(`${base}/webhooks/douyin`, { method: 'POST', headers: sig === null ? {} : { 'x-douyin-signature': sig }, body: raw });
  return { status: res.status, json: await res.json() };
}
const bookingCount = async () => (await db.one('SELECT COUNT(*) AS n FROM bookings')).n;

test('douyin: valid event creates a submitted booking, replays are idempotent (also across a different poi)', async () => {
  const ev = dyEvent('dy-idem-1');
  const first = await dyPost(ev);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.duplicate, false);
  const n = await bookingCount();
  const again = await dyPost(ev);
  assert.deepEqual([again.json.duplicate, again.json.bookingId], [true, first.json.bookingId]);
  const otherPoi = await dyPost(dyEvent('dy-idem-1', {}, 'poi_lounge'));
  assert.deepEqual([otherPoi.json.duplicate, otherPoi.json.bookingId], [true, first.json.bookingId]);
  assert.equal(await bookingCount(), n);
  const [a, b] = await Promise.all([dyPost(dyEvent('dy-idem-race')), dyPost(dyEvent('dy-idem-race'))]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal(a.json.bookingId, b.json.bookingId);
  assert.equal((await db.one("SELECT COUNT(*) AS n FROM bookings WHERE external_id = 'dy-idem-race'")).n, 1);
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = ?', [first.json.bookingId])).status, 'submitted');
});

test('douyin: bad, missing or wrong-secret signature is 401 and creates nothing', async () => {
  const n = await bookingCount();
  const ev = dyEvent('dy-sig-1');
  assert.equal((await dyPost(ev, { sig: null })).status, 401);
  assert.equal((await dyPost(ev, { sig: 'deadbeef' })).status, 401);
  assert.equal((await dyPost(ev, { sig: 'zz-not-hex' })).status, 401);
  assert.equal((await dyPost(ev, { sig: '' })).status, 401);
  assert.equal((await dyPost(ev, { secret: 'wrong' })).status, 401);
  const raw = JSON.stringify(ev);
  assert.equal((await dyPost(ev, { raw: raw + ' ', sig: createHmac('sha256', 'dy-secret').update(raw).digest('hex') })).status, 401);
  assert.equal(await bookingCount(), n);
});

test('douyin: unknown poi is 422; invalid JSON with a good signature is 400; oversized body is 413', async () => {
  assert.equal((await dyPost(dyEvent('dy-poi-1', {}, 'poi_nowhere'))).status, 422);
  assert.equal((await dyPost(null, { raw: '{not json' })).status, 400);
  assert.equal((await dyPost(dyEvent('dy-big', { name: 'x'.repeat(300_000) }))).status, 413);
});

test('douyin: malformed payloads are 4xx (never 500) and create nothing', async () => {
  const n = await bookingCount();
  const poi = 'poi_flagship';
  const good = { poiId: poi, bookingId: 'dy-mal', phone: '13900000000', eta: Date.now() + HOUR };
  const without = (k: string) => { const d: any = { ...good }; delete d[k]; return { eventId: 'x', type: 'booking.created', data: d }; };
  const withData = (over: Record<string, unknown>) => ({ eventId: 'x', type: 'booking.created', data: { ...good, ...over } });
  const payloads: unknown[] = [
    {}, null, [], 'text', 42, { eventId: 'x' }, { data: null }, { data: 'str' }, { data: [] }, { data: {} },
    without('poiId'), without('bookingId'), without('phone'), without('eta'),
    withData({ eta: 'abc' }), withData({ eta: '2026-12-01T10:00:00Z' }), withData({ eta: 1e30 }), withData({ eta: -1 }), withData({ eta: 1.5 }), withData({ eta: null }),
    withData({ partySize: -1 }), withData({ partySize: 0 }), withData({ partySize: 1.5 }), withData({ partySize: 'x' }), withData({ partySize: 100000 }),
    withData({ phone: '' }), withData({ phone: { a: 1 } }), withData({ phone: ['x'] }), withData({ bookingId: '' }), withData({ bookingId: { a: 1 } }), withData({ poiId: { a: 1 } }),
    withData({ voucherAmount: 'x' }), withData({ voucherAmount: 1e30 }), withData({ name: { a: 1 } }),
  ];
  for (const p of payloads) {
    const r = await dyPost(p);
    assert.ok(is4xx(r), `${JSON.stringify(p)} -> ${r.status} ${JSON.stringify(r.json)}`);
  }
  assert.equal(await bookingCount(), n);
});

test('douyin: numeric-string eta is accepted and stored as a number', async () => {
  const eta = Date.now() + 2 * HOUR;
  const r = await dyPost(dyEvent('dy-eta-str', { eta: String(eta) }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await db.one('SELECT eta FROM bookings WHERE id = ?', [r.json.bookingId])).eta, eta);
});

test('douyin: confirm needs a table and rep of the booking store, works once, and cancel/no-show close it', async () => {
  const b = (await dyPost(dyEvent('dy-conf-1'))).json.bookingId;
  assert.equal((await call('POST', `/api/bookings/${b}/confirm`, { tableId: 15, repId: 7 }, tok.s1host)).status, 404); // store 2 table
  for (const body of [{ tableId: 1, repId: 12 }, { tableId: 1, repId: 99999 }, { tableId: 1 }, { repId: 7 }, {}, { tableId: 'x', repId: 7 }, { tableId: 1, repId: 'x' }, { tableId: 1, repId: 1.5 }]) {
    const r = await call('POST', `/api/bookings/${b}/confirm`, body, tok.s1host);
    assert.ok(is4xx(r), `${JSON.stringify(body)} -> ${r.status}`);
  }
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = ?', [b])).status, 'submitted');
  assert.equal((await call('POST', `/api/bookings/${b}/confirm`, { tableId: 1, repId: 7 }, tok.s2host)).status, 404); // other store staff
  assert.equal((await call('POST', `/api/bookings/${b}/confirm`, { tableId: 1, repId: 7 }, tok.s1waiter)).status, 403);
  assert.equal((await call('POST', `/api/bookings/${b}/confirm`, { tableId: 1, repId: 7 }, tok.s1host)).status, 200);
  assert.equal((await call('POST', `/api/bookings/${b}/confirm`, { tableId: 1, repId: 7 }, tok.s1host)).status, 409);
  assert.equal((await call('POST', `/api/bookings/${b}/cancel`, {}, tok.s1host)).status, 200);
  assert.equal((await call('POST', `/api/bookings/${b}/cancel`, {}, tok.s1host)).status, 404);
  assert.equal((await call('POST', `/api/bookings/${b}/confirm`, { tableId: 1, repId: 7 }, tok.s1host)).status, 409);
});

test('booking: a cancelled or no-show booking cannot open a table', async () => {
  const table = await newTable();
  for (const noShow of [false, true]) {
    const id = (await call('POST', '/api/bookings', { phone: phoneN(), eta: Date.now() + HOUR, repId: 7 }, tok.s1host)).json.bookingId;
    assert.equal((await call('POST', `/api/bookings/${id}/cancel`, { noShow }, tok.s1host)).status, 200);
    assert.equal((await db.one('SELECT status FROM bookings WHERE id = ?', [id])).status, noShow ? 'no_show' : 'cancelled');
    const r = await call('POST', '/api/bills', { tableId: table, bookingId: id }, tok.s1host);
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal((await db.one('SELECT status FROM dining_tables WHERE id = ?', [table])).status, 'free');
  }
});

test('booking: manual create validates its input and its table/rep references', async () => {
  const eta = Date.now() + HOUR;
  const bad: unknown[] = [
    {}, { phone: '' }, { phone: phoneN() }, { phone: phoneN(), eta: 'abc' }, { phone: phoneN(), eta: 1e30 }, { phone: phoneN(), eta: -5 }, { phone: phoneN(), eta: null },
    { phone: phoneN(), eta, partySize: 0 }, { phone: phoneN(), eta, partySize: -2 }, { phone: phoneN(), eta, partySize: 1.5 }, { phone: phoneN(), eta, partySize: 'x' },
    { phone: phoneN(), eta, tableId: 15 }, { phone: phoneN(), eta, tableId: 99999 }, { phone: phoneN(), eta, repId: 12 }, { phone: phoneN(), eta, repId: 99999 },
    { phone: { a: 1 }, eta },
  ];
  for (const body of bad) {
    const r = await call('POST', '/api/bookings', body, tok.s1host);
    assert.ok(is4xx(r), `${JSON.stringify(body)} -> ${r.status}`);
  }
  assert.equal((await call('POST', '/api/bookings', { phone: phoneN(), eta }, tok.s1waiter)).status, 403);
  const ok = await call('POST', '/api/bookings', { phone: phoneN(), eta, partySize: 6, tableId: 2, repId: 7 }, tok.s1host);
  assert.equal(ok.status, 200);
  const listed = (await call('GET', '/api/bookings', undefined, tok.s1host)).json.find((x: any) => x.id === ok.json.bookingId);
  assert.deepEqual([listed.status, listed.party_size, listed.source], ['confirmed', 6, 'manual']);
});

test('booking: bill carries the booking rep and phone, booking is checked_in, then redeemed on settlement', async () => {
  const phone = phoneN();
  const id = (await call('POST', '/api/bookings', { phone, eta: Date.now() + HOUR, repId: 7 }, tok.s1host)).json.bookingId;
  const table = await newTable();
  const billId = (await call('POST', '/api/bills', { tableId: table, bookingId: id }, tok.s1host)).json.billId;
  const row = await db.one('SELECT b.rep_id, b.booking_id, m.phone FROM bills b JOIN members m ON m.id = b.member_id WHERE b.id = ?', [billId]);
  assert.deepEqual([row.rep_id, row.booking_id, row.phone], [7, id, phone]);
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = ?', [id])).status, 'checked_in');
  assert.equal((await call('POST', `/api/bookings/${id}/cancel`, {}, tok.s1host)).status, 404);
  assert.equal((await call('POST', '/api/bills', { tableId: await newTable(), bookingId: id }, tok.s1host)).status, 409);
  await addSale(billId, 3, 1);
  assert.equal((await payCash(billId)).json.settled, true);
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = ?', [id])).status, 'redeemed');
  assert.equal((await call('GET', '/api/bookings', undefined, tok.s1host)).json.some((x: any) => x.id === id), false);
});

test('booking: a douyin booking can be seated straight from submitted and a store-2 booking cannot be used in store 1', async () => {
  const b2 = (await dyPost(dyEvent('dy-seat-2', {}, 'poi_lounge'))).json.bookingId;
  assert.equal((await call('POST', '/api/bills', { tableId: await newTable(), bookingId: b2 }, tok.s1host)).status, 404);
  const b1 = (await dyPost(dyEvent('dy-seat-1'))).json.bookingId;
  const r = await call('POST', '/api/bills', { tableId: await newTable(), bookingId: b1, repId: 7 }, tok.s1host);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = ?', [b1])).status, 'checked_in');
});

// ============================================================================================
// MEMBERS / WALLET
// ============================================================================================

const ledgerSum = async (phone: string) => (await db.one(
  'SELECT COALESCE(SUM(l.delta),0) AS s, m.balance FROM members m LEFT JOIN wallet_ledger l ON l.member_id = m.id WHERE m.phone = ? GROUP BY m.balance', [phone]));

test('wallet: top-up validation rejects float, negative, zero, non-numeric, huge and missing values', async () => {
  const phone = phoneN();
  const bad: unknown[] = [
    { phone, amount: 10.5 }, { phone, amount: -100 }, { phone, amount: 0 }, { phone, amount: 'abc' }, { phone, amount: null }, { phone },
    { phone, amount: true }, { phone, amount: [] }, { phone, amount: 1e20 }, { phone, amount: 100, bonus: -1 }, { phone, amount: 100, bonus: 0.5 },
    { phone, amount: 100, bonus: 'x' }, { phone, amount: 100, bonus: 1e20 }, { amount: 100 }, { phone: '', amount: 100 }, { phone: '   ', amount: 100 }, { phone: { a: 1 }, amount: 100 },
  ];
  for (const body of bad) {
    const r = await call('POST', '/api/members/topup', body, tok.s1manager);
    assert.ok(is4xx(r), `${JSON.stringify(body)} -> ${r.status}`);
  }
  assert.equal((await db.one('SELECT COUNT(*) AS n FROM members WHERE phone = ?', [phone])).n, 0);
  for (const t of [tok.s1waiter, tok.s1cashier, tok.s1host]) assert.equal((await call('POST', '/api/members/topup', { phone, amount: 100 }, t)).status, 403);
});

test('wallet: ledger always sums to balance across top-ups, bonus, spend and a refused overspend', async () => {
  const phone = phoneN();
  assert.equal((await call('POST', '/api/members/topup', { phone, amount: 50000, bonus: 5000 }, tok.s1manager)).json.balance, 55000);
  assert.equal((await call('POST', '/api/members/topup', { phone, amount: '2000' }, tok.s2manager)).json.balance, 57000);
  const b = await openBill(await newTable(), { phone });
  await addSale(b, 3, 5); // 140.00
  assert.equal((await payCash(b, 1000)).json.settled, false);
  const over = await call('POST', `/api/bills/${b}/pay`, { method: 'member', amount: 13000 }, tok.s1cashier);
  assert.equal(over.json.settled, true);
  assert.equal((await call('GET', `/api/members/${phone}`, undefined, tok.s2waiter)).json.balance, 57000 - 13000);
  const poor = phoneN();
  await call('POST', '/api/members/topup', { phone: poor, amount: 100 }, tok.s1manager);
  const b2 = await openBill(await newTable(), { phone: poor });
  await addSale(b2, 3, 1);
  assert.equal((await call('POST', `/api/bills/${b2}/pay`, { method: 'member' }, tok.s1cashier)).status, 402);
  for (const p of [phone, poor]) {
    const l = await ledgerSum(p);
    assert.equal(l.s, l.balance, `ledger != balance for ${p}`);
  }
  assert.equal((await call('GET', '/api/members/00000', undefined, tok.s1manager)).status, 404);
});

test('wallet: the same phone typed with spaces, dashes or +86 lands on one wallet, in top-up, bills, stash and lookups', async () => {
  const n = String(13000000000 + (++seq));
  const variants = [n, ` ${n.slice(0, 3)} ${n.slice(3, 7)} ${n.slice(7)} `, `+86${n}`, `+86 ${n.slice(0, 3)}-${n.slice(3, 7)}-${n.slice(7)}`, `${n.slice(0, 3)}-${n.slice(3, 7)}-${n.slice(7)}`];
  for (const phone of variants) assert.equal((await call('POST', '/api/members/topup', { phone, amount: 1000 }, tok.s1manager)).status, 200);
  assert.equal((await db.one('SELECT COUNT(*) AS n FROM members WHERE phone LIKE ?', [`%${n.slice(3)}%`])).n, 1);
  assert.equal((await call('GET', `/api/members/${n}`, undefined, tok.s1manager)).json.balance, 5000);
  assert.equal((await call('GET', `/api/members/${encodeURIComponent(variants[3])}`, undefined, tok.s1manager)).json.balance, 5000);
  assert.ok(is4xx(await call('GET', '/api/members/%E0%A4%A', undefined, tok.s1manager)));
  const b = await openBill(await newTable(), { phone: variants[1] });
  assert.equal((await db.one('SELECT m.phone FROM bills b JOIN members m ON m.id = b.member_id WHERE b.id = ?', [b])).phone, n);
  await call('POST', '/api/stash', { phone: variants[2], productId: 3, qtyMilli: 100 }, tok.s1waiter);
  assert.equal((await call('GET', `/api/stash?q=${encodeURIComponent(variants[4])}`, undefined, tok.s1waiter)).json.length, 1);
  assert.equal((await call('GET', `/api/stash?q=${n}`, undefined, tok.s1waiter)).json.length, 1);
});

test('wallet: member search is tenant-wide and survives LIKE wildcards', async () => {
  const phone = phoneN();
  await call('POST', '/api/members/topup', { phone, amount: 100 }, tok.s1manager);
  assert.equal((await call('GET', `/api/members?q=${phone.slice(-6)}`, undefined, tok.s2manager)).json.some((m: any) => m.phone === phone), true);
  const r = await call('GET', `/api/members?q=${encodeURIComponent('%')}`, undefined, tok.s1manager);
  assert.equal(r.status, 200);
});

// ============================================================================================
// PRODUCTS / TABLES / RULES
// ============================================================================================

test('products: create validates name, price, stock; duplicates are 409; price 0 is allowed', async () => {
  const name = uniq('Dup');
  assert.equal((await call('POST', '/api/products', { name, price: 1000 }, tok.s1manager)).status, 200);
  assert.equal((await call('POST', '/api/products', { name, price: 1000 }, tok.s1manager)).status, 409);
  assert.equal((await call('POST', '/api/products', { name: `  ${name}  `, price: 1000 }, tok.s1manager)).status, 409);
  const bad: unknown[] = [
    { name: uniq('x') }, { name: uniq('x'), price: -1 }, { name: uniq('x'), price: 1.5 }, { name: uniq('x'), price: 'abc' }, { name: uniq('x'), price: null },
    { name: uniq('x'), price: 1e20 }, { name: uniq('x'), price: 100, stock: -1 }, { name: uniq('x'), price: 100, stock: 1.5 }, { name: uniq('x'), price: 100, stock: 1e20 },
    { price: 100 }, { name: '   ', price: 100 }, { name: { a: 1 }, price: 100 },
  ];
  for (const body of bad) {
    const r = await call('POST', '/api/products', body, tok.s1manager);
    assert.ok(is4xx(r), `${JSON.stringify(body)} -> ${r.status}`);
  }
  assert.equal((await call('POST', '/api/products', { name: uniq('free'), price: 0 }, tok.s1manager)).status, 200);
  assert.equal((await call('POST', '/api/products', { name: uniq('x'), price: 100 }, tok.s1waiter)).status, 403);
  // same name is fine in another store
  assert.equal((await call('POST', '/api/products', { name, price: 1000 }, tok.s2manager)).status, 200);
});

test('products: PATCH rename onto an existing name is 409, invalid values 4xx, other store 404', async () => {
  const a = uniq('A');
  const b = uniq('B');
  const pa = (await call('POST', '/api/products', { name: a, price: 100 }, tok.s1manager)).json.productId;
  await call('POST', '/api/products', { name: b, price: 100 }, tok.s1manager);
  assert.equal((await call('PATCH', `/api/products/${pa}`, { name: b }, tok.s1manager)).status, 409);
  assert.equal((await call('PATCH', `/api/products/${pa}`, { name: a, price: 250 }, tok.s1manager)).status, 200);
  for (const body of [{ price: -1 }, { price: 1.5 }, { price: 'x' }, { price: 1e20 }, { name: '' }, { name: '  ' }]) {
    const r = await call('PATCH', `/api/products/${pa}`, body, tok.s1manager);
    assert.ok(is4xx(r), `${JSON.stringify(body)} -> ${r.status}`);
  }
  assert.equal((await db.one('SELECT price FROM products WHERE id = ?', [pa])).price, 250);
  assert.equal((await call('PATCH', '/api/products/99999', { price: 1 }, tok.s1manager)).status, 404);
  assert.equal((await call('PATCH', '/api/products/6', { price: 1 }, tok.s1manager)).status, 404);
  assert.equal((await call('PATCH', `/api/products/${pa}`, { price: 1 }, tok.s2manager)).status, 404);
  assert.equal((await call('PATCH', `/api/products/${pa}`, { price: 1 }, tok.s1cashier)).status, 403);
});

test('products: deactivating a product with an open bill keeps the bill payable and hides it from new orders', async () => {
  const p = await newProduct(5000, 10);
  const b = await openBill(await newTable());
  await addSale(b, p, 2);
  assert.equal((await call('PATCH', `/api/products/${p}`, { active: false }, tok.s1manager)).status, 200);
  assert.equal((await call('POST', `/api/bills/${b}/lines`, { productId: p, qty: 1 }, tok.s1waiter)).status, 404);
  assert.equal((await call('GET', '/api/products', undefined, tok.s1waiter)).json.some((x: any) => x.id === p), false);
  assert.equal((await call('GET', '/api/products?all=1', undefined, tok.s1waiter)).json.some((x: any) => x.id === p), true);
  assert.equal((await bill(b)).totals.total, 10000);
  assert.equal((await payCash(b)).json.settled, true);
  assert.equal((await db.one('SELECT stock FROM products WHERE id = ?', [p])).stock, 8);
});

test('stock: adjustment needs a reason and a non-zero integer delta, is logged, and is store-scoped', async () => {
  const p = await newProduct(1000, 5);
  const bad: unknown[] = [{ delta: 5 }, { delta: 5, reason: '' }, { delta: 5, reason: '   ' }, { delta: 0, reason: 'x' }, { delta: 1.5, reason: 'x' }, { delta: 'abc', reason: 'x' }, { reason: 'x' }, { delta: 1e20, reason: 'x' }, { delta: -1e20, reason: 'x' }];
  for (const body of bad) {
    const r = await call('POST', `/api/products/${p}/stock`, body, tok.s1manager);
    assert.ok(is4xx(r), `${JSON.stringify(body)} -> ${r.status}`);
  }
  assert.equal((await db.one('SELECT COUNT(*) AS n FROM stock_movements WHERE product_id = ?', [p])).n, 0);
  assert.equal((await call('POST', `/api/products/${p}/stock`, { delta: 7, reason: 'delivery' }, tok.s1manager)).json.stock, 12);
  assert.equal((await call('POST', `/api/products/${p}/stock`, { delta: -2, reason: 'breakage' }, tok.s1manager)).json.stock, 10);
  const moves = await db.all('SELECT delta, reason, store_id FROM stock_movements WHERE product_id = ? ORDER BY id', [p]);
  assert.deepEqual(moves.map((m: any) => [m.delta, m.reason, m.store_id]), [[7, 'delivery', 1], [-2, 'breakage', 1]]);
  assert.equal((await call('POST', `/api/products/${p}/stock`, { delta: 1, reason: 'x' }, tok.s2manager)).status, 404);
  assert.equal((await call('POST', `/api/products/${p}/stock`, { delta: 1, reason: 'x' }, tok.s1waiter)).status, 403);
  assert.equal((await call('POST', '/api/products/99999/stock', { delta: 1, reason: 'x' }, tok.s1manager)).status, 404);
});

test('tables: create/rename validation, collisions are 409, occupied tables cannot be deactivated', async () => {
  const n1 = uniq('Tn');
  const n2 = uniq('Tn');
  const t1 = (await call('POST', '/api/tables', { name: n1, kind: 'bar' }, tok.s1manager)).json.tableId;
  const t2 = (await call('POST', '/api/tables', { name: n2, kind: 'bar' }, tok.s1manager)).json.tableId;
  assert.equal((await call('POST', '/api/tables', { name: n1, kind: 'bar' }, tok.s1manager)).status, 409);
  assert.equal((await call('PATCH', `/api/tables/${t2}`, { name: n1 }, tok.s1manager)).status, 409);
  assert.equal((await call('PATCH', `/api/tables/${t2}`, { name: n2, zone: 'Z' }, tok.s1manager)).status, 200);
  const bad: unknown[] = [{ name: uniq('x'), kind: 'sofa' }, { name: '' }, { name: uniq('x'), capacity: 0 }, { name: uniq('x'), capacity: 1.5 }, { name: uniq('x'), minSpend: -1 }, { name: uniq('x'), tableFee: 'x' }, { name: uniq('x'), minSpend: 1e20 }];
  for (const body of bad) {
    const r = await call('POST', '/api/tables', body, tok.s1manager);
    assert.ok(is4xx(r), `${JSON.stringify(body)} -> ${r.status}`);
  }
  for (const body of [{ capacity: 0 }, { minSpend: -1 }, { tableFee: 1.5 }, { name: '  ' }]) assert.ok(is4xx(await call('PATCH', `/api/tables/${t2}`, body, tok.s1manager)));
  const b = await openBill(t1);
  assert.equal((await call('PATCH', `/api/tables/${t1}`, { active: false }, tok.s1manager)).status, 409);
  assert.equal((await call('PATCH', `/api/tables/${t2}`, { active: false }, tok.s1manager)).status, 200);
  assert.equal((await call('POST', '/api/bills', { tableId: t2, repId: 7 }, tok.s1host)).status, 404);
  assert.equal((await call('GET', '/api/tables', undefined, tok.s1host)).json.some((t: any) => t.id === t2), false);
  assert.equal((await call('GET', '/api/tables?all=1', undefined, tok.s1host)).json.some((t: any) => t.id === t2), true);
  assert.equal((await call('PATCH', '/api/tables/15', { name: 'hack' }, tok.s1manager)).status, 404);
  assert.equal((await call('PATCH', `/api/tables/${t2}`, { name: 'q' }, tok.s1waiter)).status, 403);
  assert.ok(b > 0);
});

test('tables: changing min-spend and table fee does not touch an already open bill', async () => {
  const t = await newTable(10000, 500);
  const b = await openBill(t);
  await addSale(b, 3, 1); // 28.00 < 100.00 min
  assert.deepEqual([(await bill(b)).totals.total], [10500]);
  assert.equal((await call('PATCH', `/api/tables/${t}`, { minSpend: 90000, tableFee: 9000 }, tok.s1manager)).status, 200);
  const tot = (await bill(b)).totals;
  assert.deepEqual([tot.minSpendTopUp, tot.tableFee, tot.total], [7200, 500, 10500]);
  assert.equal((await payCash(b)).json.paid, 10500);
  const b2 = await openBill(t);
  assert.equal((await bill(b2)).totals.total, 99000);
});

test('commission rules: validation, store scoping and delete', async () => {
  const good = await call('POST', '/api/commission-rules', { role: 'sales', category: 'beer', bps: 300 }, tok.s1manager);
  assert.equal(good.status, 200);
  const bad: unknown[] = [
    { role: 'host', bps: 100 }, { bps: 100 }, { role: 'sales', bps: 10001 }, { role: 'sales', bps: -1 }, { role: 'sales', bps: 1.5 }, { role: 'sales', bps: 'x' },
    { role: 'sales', bps: 100, fixed: -5 }, { role: 'sales', bps: 100, fixed: 1.5 }, { role: 'sales', bps: 100, fixed: 1e20 },
    { role: 'sales', bps: 100, productId: 6 }, { role: 'sales', bps: 100, productId: 99999 }, { role: 'sales', bps: 100, productId: 'abc' }, { role: 'sales', bps: 100, category: { a: 1 } },
  ];
  for (const body of bad) {
    const r = await call('POST', '/api/commission-rules', body, tok.s1manager);
    assert.ok(is4xx(r), `${JSON.stringify(body)} -> ${r.status}`);
  }
  assert.equal((await call('POST', '/api/commission-rules', { role: 'sales', bps: 10000 }, tok.s1manager)).status, 200);
  assert.equal((await call('POST', '/api/commission-rules', { role: 'waiter', bps: 0, fixed: 100, productId: 1 }, tok.s1manager)).status, 200);
  assert.equal((await call('POST', '/api/commission-rules', { role: 'sales', bps: 1 }, tok.s1waiter)).status, 403);
  assert.equal((await call('GET', '/api/commission-rules', undefined, tok.s2waiter)).json.some((r: any) => r.id === good.json.ruleId), false);
  assert.equal((await call('DELETE', `/api/commission-rules/${good.json.ruleId}`, undefined, tok.s2manager)).status, 404);
  assert.equal((await call('DELETE', `/api/commission-rules/${good.json.ruleId}`, undefined, tok.s1waiter)).status, 403);
  assert.equal((await call('DELETE', `/api/commission-rules/${good.json.ruleId}`, undefined, tok.s1manager)).status, 200);
  assert.equal((await call('DELETE', `/api/commission-rules/${good.json.ruleId}`, undefined, tok.s1manager)).status, 404);
  assert.ok(is4xx(await call('DELETE', '/api/commission-rules/abc', undefined, tok.s1manager)));
});

// ============================================================================================
// STAFF
// ============================================================================================

test('staff: create validation (username, role, pin, store) with 4xx and duplicate username 409', async () => {
  const mk = (over: Record<string, unknown>) => call('POST', '/api/hq/staff', { name: 'Tmp', username: uniq('tmp'), role: 'cashier', pin: '1234', storeId: 1, ...over }, tok.owner);
  const dup = uniq('dup');
  assert.equal((await mk({ username: dup })).status, 200);
  assert.equal((await mk({ username: dup })).status, 409);
  assert.equal((await mk({ username: dup.toUpperCase() })).status, 409);
  assert.equal((await mk({ username: 'owner' })).status, 409);
  assert.equal((await mk({ username: dup, storeId: 2 })).status, 409);
  for (const over of [
    { role: 'god' }, { role: undefined }, { username: 'a' }, { username: 'bad name' }, { username: undefined }, { pin: '12' }, { pin: undefined }, { pin: 123456 }, { pin: '' },
    { storeId: undefined }, { storeId: 99999 }, { storeId: 'abc' }, { name: '' }, { name: undefined }, { name: { a: 1 } },
  ]) {
    const r = await mk(over);
    assert.ok(is4xx(r), `${JSON.stringify(over)} -> ${r.status} ${JSON.stringify(r.json)}`);
  }
  assert.equal((await mk({ username: uniq('fin'), role: 'finance', storeId: undefined })).status, 200);
  assert.equal((await mk({ username: uniq('mgr'), role: 'manager', pin: '4444' })).status, 200);
});

test('staff: cannot deactivate yourself; deactivating another kills their session and login', async () => {
  assert.equal((await call('PATCH', '/api/staff/1', { active: false }, tok.owner)).status, 409);
  const id = (await call('POST', '/api/hq/staff', { name: 'Leaver', username: 'leaver', role: 'cashier', pin: '8080', storeId: 1 }, tok.owner)).json.employeeId;
  const t = (await call('POST', '/api/login', { company: 'doloruu', username: 'leaver', pin: '8080' })).json.token;
  assert.equal((await call('GET', '/api/me', undefined, t)).status, 200);
  assert.equal((await call('PATCH', `/api/staff/${id}`, { active: false }, tok.owner)).status, 200);
  assert.equal((await call('GET', '/api/me', undefined, t)).status, 401);
  assert.equal((await call('POST', '/api/login', { company: 'doloruu', username: 'leaver', pin: '8080' })).status, 401);
  assert.equal((await call('PATCH', `/api/staff/${id}`, { active: true }, tok.owner)).status, 200);
  assert.equal((await call('POST', '/api/login', { company: 'doloruu', username: 'leaver', pin: '8080' })).status, 200);
});

test('staff: PIN reset invalidates every session of that person; short or empty PIN is refused', async () => {
  const id = (await call('POST', '/api/hq/staff', { name: 'Resetter', username: 'resetter', role: 'waiter', pin: '1212', storeId: 1 }, tok.owner)).json.employeeId;
  const t1 = (await call('POST', '/api/login', { company: 'doloruu', username: 'resetter', pin: '1212' })).json.token;
  const t2 = (await call('POST', '/api/login', { company: 'doloruu', username: 'resetter', pin: '1212' })).json.token;
  for (const pin of ['12', '', null, '   ']) {
    const r = await call('PATCH', `/api/staff/${id}`, { pin }, tok.owner);
    assert.ok(is4xx(r), `pin=${JSON.stringify(pin)} -> ${r.status}`);
  }
  assert.equal((await call('GET', '/api/me', undefined, t1)).status, 200);
  assert.equal((await call('PATCH', `/api/staff/${id}`, { pin: '3434' }, tok.owner)).status, 200);
  assert.equal((await call('GET', '/api/me', undefined, t1)).status, 401);
  assert.equal((await call('GET', '/api/me', undefined, t2)).status, 401);
  assert.equal((await call('POST', '/api/login', { company: 'doloruu', username: 'resetter', pin: '1212' })).status, 401);
  assert.equal((await call('POST', '/api/login', { company: 'doloruu', username: 'resetter', pin: '3434' })).status, 200);
});

test('staff: roles must be known and cannot cross the store/tenant-wide boundary; managers cannot edit staff', async () => {
  const id = (await call('POST', '/api/hq/staff', { name: 'Roley', username: 'roley', role: 'waiter', pin: '5656', storeId: 1 }, tok.owner)).json.employeeId;
  assert.equal((await call('PATCH', `/api/staff/${id}`, { role: 'owner' }, tok.owner)).status, 422);
  assert.equal((await call('PATCH', `/api/staff/${id}`, { role: 'finance' }, tok.owner)).status, 422);
  assert.equal((await call('PATCH', `/api/staff/${id}`, { role: 'god' }, tok.owner)).status, 422);
  assert.equal((await call('PATCH', `/api/staff/${id}`, { role: '' }, tok.owner)).status, 200); // empty means "unchanged"
  assert.equal((await call('PATCH', `/api/staff/${id}`, { role: 'cashier', name: 'Roley 2' }, tok.owner)).status, 200);
  assert.deepEqual(await db.one('SELECT role, name FROM employees WHERE id = ?', [id]), { role: 'cashier', name: 'Roley 2' });
  assert.equal((await call('PATCH', '/api/staff/1', { role: 'waiter' }, tok.finance)).status, 403);
  assert.equal((await call('PATCH', `/api/staff/${id}`, { name: 'x' }, tok.s1manager)).status, 403);
  assert.equal((await call('PATCH', '/api/staff/99999', { name: 'x' }, tok.owner)).status, 404);
  assert.ok(is4xx(await call('PATCH', '/api/staff/abc', { name: 'x' }, tok.owner)));
  const staffAsManager = (await call('GET', '/api/staff', undefined, tok.s1manager)).json;
  assert.equal(staffAsManager.every((s: any) => s.storeId === 1 || s.storeId === null), true);
  assert.equal((await call('GET', '/api/staff', undefined, tok.s1waiter)).status, 403);
  const staffAsOwner = (await call('GET', '/api/staff', undefined, tok.owner)).json;
  assert.equal(staffAsOwner.some((s: any) => s.storeId === 2), true);
  assert.equal(staffAsOwner.every((s: any) => s.pin_hash === undefined), true);
});

test('staff: another tenant cannot be touched', async () => {
  const foreign = (await call('POST', '/platform/companies', { name: 'Other', code: uniq('oth'), storeName: 'O1', ownerName: 'O', ownerUsername: 'oboss', ownerPin: '123456' }, undefined, ADMIN)).json;
  assert.equal((await call('PATCH', `/api/staff/${foreign.ownerId}`, { active: false }, tok.owner)).status, 404);
  assert.equal((await call('POST', '/api/hq/staff', { name: 'X', username: uniq('xx'), role: 'cashier', pin: '1234', storeId: foreign.storeId }, tok.owner)).status, 404);
  assert.equal((await call('POST', '/api/hq/catalog/copy', { fromStoreId: 1, toStoreIds: [foreign.storeId] }, tok.owner)).status, 404);
  assert.equal((await call('POST', '/api/hq/catalog/copy', { fromStoreId: foreign.storeId, toStoreIds: [1] }, tok.owner)).status, 404);
  assert.equal((await call('POST', '/api/hq/stores', { name: 'Steal', code: uniq('S'), copyCatalogFrom: foreign.storeId }, tok.owner)).status, 404);
  assert.equal((await db.one("SELECT COUNT(*) AS n FROM stores WHERE name = 'Steal'")).n, 0);
});

// ============================================================================================
// HQ / MULTI-STORE
// ============================================================================================

test('hq: store creation rejects duplicate code and duplicate douyin poi, and rolls back on a bad catalog source', async () => {
  const code = uniq('ST');
  assert.equal((await call('POST', '/api/hq/stores', { name: 'S-A', code, douyinPoiId: uniq('poi') }, tok.owner)).status, 200);
  assert.equal((await call('POST', '/api/hq/stores', { name: 'S-B', code }, tok.owner)).status, 409);
  const poi = uniq('poi');
  assert.equal((await call('POST', '/api/hq/stores', { name: 'S-C', code: uniq('ST'), douyinPoiId: poi }, tok.owner)).status, 200);
  assert.equal((await call('POST', '/api/hq/stores', { name: 'S-D', code: uniq('ST'), douyinPoiId: poi }, tok.owner)).status, 409);
  assert.equal((await call('POST', '/api/hq/stores', { name: 'S-D', code: uniq('ST'), douyinPoiId: 'poi_flagship' }, tok.owner)).status, 409);
  // two stores with no poi (empty string / absent) must both be allowed
  assert.equal((await call('POST', '/api/hq/stores', { name: 'S-E', code: uniq('ST'), douyinPoiId: '' }, tok.owner)).status, 200);
  assert.equal((await call('POST', '/api/hq/stores', { name: 'S-F', code: uniq('ST'), douyinPoiId: '' }, tok.owner)).status, 200);
  assert.equal((await call('POST', '/api/hq/stores', { name: 'S-G', code: uniq('ST') }, tok.owner)).status, 200);
  for (const body of [{}, { name: 'x' }, { code: 'x' }, { name: '  ', code: 'x' }, { name: { a: 1 }, code: 'x' }, { name: 'x', code: uniq('ST'), copyCatalogFrom: 99999 }, { name: 'x', code: uniq('ST'), copyCatalogFrom: 'abc' }]) {
    const r = await call('POST', '/api/hq/stores', body, tok.owner);
    assert.ok(is4xx(r), `${JSON.stringify(body)} -> ${r.status}`);
  }
  assert.equal((await db.one("SELECT COUNT(*) AS n FROM stores WHERE name = 'x'")).n, 0);
  assert.equal((await call('GET', '/api/hq/stores', undefined, tok.finance)).status, 200);
  assert.equal((await call('GET', '/api/hq/stores', undefined, tok.s1manager)).status, 403);
});

test('hq: catalog copy is idempotent, keeps target stock and rules per-store, skips inactive products, validates input', async () => {
  const made = (await call('POST', '/api/hq/stores', { name: 'Copy Target', code: uniq('CT') }, tok.owner)).json.storeId;
  const p = await newProduct(7777, 3, { category: 'special' });
  const dead = await newProduct(1111, 3);
  await call('PATCH', `/api/products/${dead}`, { active: false }, tok.s1manager);
  const r1 = await call('POST', '/api/hq/catalog/copy', { fromStoreId: 1, toStoreIds: [made] }, tok.owner);
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  const snapshot = async () => (await db.all('SELECT name, category, price, stock, track_stock, active FROM products WHERE store_id = ? ORDER BY name', [made]));
  const first = await snapshot();
  assert.equal(first.some((x: any) => x.price === 7777), true);
  assert.equal(first.some((x: any) => x.price === 1111), false);
  assert.equal(first.every((x: any) => x.stock === 0), true);
  const rulesFirst = await db.all('SELECT role, category, bps, fixed FROM commission_rules WHERE store_id = ? ORDER BY id', [made]);
  assert.equal(rulesFirst.length >= 3, true);
  await db.run("UPDATE products SET stock = 42 WHERE store_id = ? AND price = 7777", [made]);
  const r2 = await call('POST', '/api/hq/catalog/copy', { fromStoreId: 1, toStoreIds: [made] }, tok.owner);
  assert.deepEqual(r2.json, r1.json);
  const second = await snapshot();
  assert.equal(second.length, first.length);
  assert.equal(second.find((x: any) => x.price === 7777).stock, 42);
  assert.deepEqual(await db.all('SELECT role, category, bps, fixed FROM commission_rules WHERE store_id = ? ORDER BY id', [made]), rulesFirst);
  // copying onto the source itself, an empty target list, and repeated ids are harmless
  assert.equal((await call('POST', '/api/hq/catalog/copy', { fromStoreId: 1, toStoreIds: [1] }, tok.owner)).status, 200);
  assert.equal((await call('POST', '/api/hq/catalog/copy', { fromStoreId: 1, toStoreIds: [made, made] }, tok.owner)).status, 200);
  assert.equal((await snapshot()).length, first.length);
  assert.equal((await call('POST', '/api/hq/catalog/copy', { fromStoreId: 1, toStoreIds: [] }, tok.owner)).status, 200);
  for (const body of [{}, { fromStoreId: 1 }, { fromStoreId: 1, toStoreIds: 'x' }, { fromStoreId: 1, toStoreIds: 2 }, { fromStoreId: 1, toStoreIds: ['abc'] }, { toStoreIds: [2] }, { fromStoreId: 'x', toStoreIds: [2] }, { fromStoreId: 1, toStoreIds: [99999] }, { fromStoreId: 99999, toStoreIds: [2] }]) {
    const r = await call('POST', '/api/hq/catalog/copy', body, tok.owner);
    assert.ok(is4xx(r), `${JSON.stringify(body)} -> ${r.status}`);
  }
  assert.equal((await call('POST', '/api/hq/catalog/copy', { fromStoreId: 1, toStoreIds: [2] }, tok.finance)).status, 403);
  assert.equal((await call('POST', '/api/hq/catalog/copy', { fromStoreId: 1, toStoreIds: [2] }, tok.s1manager)).status, 403);
  assert.ok(p > 0);
});

test('hq: summary equals the sum of the settled bills it covers, per store and in total', async () => {
  const from = Date.now() - 1;
  const phone = phoneN();
  await call('POST', '/api/members/topup', { phone, amount: 50000 }, tok.s1manager);
  // store 1: cash bill 140.00, credit bill 28.00, mixed member + cash bill, plus one bill left open
  const b1 = await openBill(await newTable());
  await addSale(b1, 3, 5);
  await payCash(b1);
  const b2 = await openBill(await newTable());
  await addSale(b2, 3, 1);
  await call('POST', `/api/bills/${b2}/pay`, { method: 'credit' }, tok.s1cashier);
  const b3 = await openBill(await newTable(), { phone });
  await addSale(b3, 3, 10);
  await call('POST', `/api/bills/${b3}/pay`, { method: 'member', amount: 10000 }, tok.s1cashier);
  await payCash(b3);
  const open = await openBill(await newTable());
  await addSale(open, 3, 1);
  // store 2: one cash bill with a discount
  const b4 = await openBill(19, {}, tok.s2host, 12);
  await call('POST', `/api/bills/${b4}/lines`, { productId: 8, qty: 4 }, tok.s2waiter);
  await call('POST', `/api/bills/${b4}/discount`, { amount: 1200, reason: 'vip' }, tok.s2manager);
  await call('POST', `/api/bills/${b4}/pay`, { method: 'cash' }, tok.s2cashier);
  const to = Date.now() + 1;

  const sum = (await call('GET', `/api/hq/summary?from=${from}&to=${to}`, undefined, tok.finance)).json;
  const s1 = sum.stores.find((s: any) => s.storeId === 1);
  const s2 = sum.stores.find((s: any) => s.storeId === 2);
  assert.deepEqual([s1.bills, s1.revenue, s1.credit], [3, 14000 + 2800 + 28000, 2800]);
  assert.deepEqual([s2.bills, s2.revenue, s2.credit], [1, 4 * 2800 - 1200, 0]);
  assert.equal(sum.totals.bills, 4);
  assert.equal(sum.totals.revenue, s1.revenue + s2.revenue);
  assert.equal(sum.totals.credit, 2800);
  assert.equal(s1.openBills, (await db.one("SELECT COUNT(*) AS n FROM bills WHERE store_id = 1 AND status = 'open'")).n);
  assert.equal(sum.totals.openBills, s1.openBills + s2.openBills + sum.stores.filter((s: any) => s.storeId > 2).reduce((a: number, s: any) => a + s.openBills, 0));
  const commission = (await db.one('SELECT COALESCE(SUM(amount),0) AS s FROM commission_entries WHERE store_id = 1 AND ts >= ? AND ts < ?', [from, to])).s;
  assert.equal(s1.commission, commission);
  assert.equal(s1.stashItems, (await db.one("SELECT COUNT(*) AS n FROM stash WHERE store_id = 1 AND status = 'stored'")).n);
  // revenue equals the bill totals shown by the bill endpoint
  const billTotals = (await Promise.all([b1, b2, b3].map((id) => bill(id)))).reduce((a: number, x: any) => a + x.totals.total, 0);
  assert.equal(s1.revenue, billTotals);

  const empty = (await call('GET', `/api/hq/summary?from=${to + 10_000}&to=${to + 20_000}`, undefined, tok.owner)).json;
  assert.deepEqual([empty.totals.bills, empty.totals.revenue, empty.totals.commission], [0, 0, 0]);
  const inverted = await call('GET', `/api/hq/summary?from=${to}&to=${from}`, undefined, tok.owner);
  assert.deepEqual([inverted.status, inverted.json.totals.bills], [200, 0]);
  for (const q of ['from=abc', 'to=abc', 'from=1e99', 'from=-1']) assert.ok(!(await call('GET', `/api/hq/summary?${q}`, undefined, tok.owner)).status.toString().startsWith('5'), q);
});

test('switch-store: moves only that session, new bills land in the chosen store, bad targets are 4xx, re-login resets', async () => {
  const login = async () => (await call('POST', '/api/login', { company: 'doloruu', username: 'owner', pin: '6666' })).json.token as string;
  const a = await login();
  const b = await login();
  const foreign = (await call('POST', '/platform/companies', { name: 'Sw', code: uniq('sw'), storeName: 'S', ownerName: 'S', ownerUsername: 'swboss', ownerPin: '123456' }, undefined, ADMIN)).json;
  for (const body of [{ storeId: 99999 }, { storeId: foreign.storeId }, { storeId: 'abc' }, {}, { storeId: -1 }, { storeId: null }]) {
    const r = await call('POST', '/api/switch-store', body, a);
    assert.ok(is4xx(r), `${JSON.stringify(body)} -> ${r.status}`);
  }
  assert.equal((await call('GET', '/api/me', undefined, a)).json.store.id, 1);
  assert.equal((await call('POST', '/api/switch-store', { storeId: 2 }, a)).json.actor.storeId, 2);
  assert.equal((await call('GET', '/api/me', undefined, a)).json.store.id, 2);
  assert.equal((await call('GET', '/api/me', undefined, b)).json.store.id, 1);
  const billId = (await call('POST', '/api/bills', { tableId: 28, repId: 12 }, a)).json.billId;
  assert.equal((await db.one('SELECT store_id FROM bills WHERE id = ?', [billId])).store_id, 2);
  assert.equal((await call('POST', '/api/bills', { tableId: 28, repId: 12 }, b)).status, 404);
  assert.equal((await call('GET', `/api/bills/${billId}`, undefined, b)).status, 404);
  const fresh = await login();
  assert.equal((await call('GET', '/api/me', undefined, fresh)).json.store.id, 1);
  const fin = (await call('POST', '/api/login', { company: 'doloruu', username: 'finance', pin: '5555', storeId: 2 })).json;
  assert.equal(fin.actor.storeId, 2);
  assert.equal((await call('POST', '/api/switch-store', { storeId: 1 }, fin.token)).status, 200);
  assert.equal((await call('POST', '/api/login', { company: 'doloruu', username: 'finance', pin: '5555', storeId: foreign.storeId })).status, 403);
});

// ============================================================================================
// SELF-HEAL AND MONITORING
// ============================================================================================

test('platform: selfheal and ops need the admin key', async () => {
  assert.equal((await call('POST', '/platform/selfheal')).status, 403);
  assert.equal((await call('POST', '/platform/selfheal', undefined, undefined, { 'x-admin-key': 'wrong' })).status, 403);
  assert.equal((await call('POST', '/platform/selfheal', undefined, tok.owner)).status, 403);
  assert.equal((await call('GET', '/platform/ops')).status, 403);
  assert.equal((await call('GET', '/platform/ops', undefined, undefined, { 'x-admin-key': '' })).status, 403);
  const r = await heal();
  assert.ok(r.checked >= 7);
  assert.ok(Array.isArray(r.healed) && Array.isArray(r.alerts));
});

test('selfheal: table flagged occupied with no open bill is freed, a free table with an open bill is re-occupied, then it is idempotent', async () => {
  await heal();
  const ghost = await newTable();
  await db.run("UPDATE dining_tables SET status = 'occupied' WHERE id = ?", [ghost]);
  const busy = await newTable();
  const b = await openBill(busy);
  await db.run("UPDATE dining_tables SET status = 'free' WHERE id = ?", [busy]);
  const r = await heal();
  assert.deepEqual(healedIds(r, 'table_ghost_occupied'), [ghost]);
  assert.deepEqual(healedIds(r, 'table_ghost_free'), [busy]);
  assert.equal((await db.one('SELECT status FROM dining_tables WHERE id = ?', [ghost])).status, 'free');
  assert.equal((await db.one('SELECT status FROM dining_tables WHERE id = ?', [busy])).status, 'occupied');
  assert.equal((await db.one('SELECT status FROM bills WHERE id = ?', [b])).status, 'open');
  const kinds = (await db.all("SELECT kind, level, message, detail FROM ops_events WHERE kind LIKE 'heal.table_ghost%'")).map((e: any) => e.kind);
  assert.ok(kinds.includes('heal.table_ghost_occupied') && kinds.includes('heal.table_ghost_free'));
  const ev = (await db.all("SELECT * FROM ops_events WHERE kind = 'heal.table_ghost_occupied' ORDER BY id DESC LIMIT 1"))[0];
  assert.equal(ev.level, 'warn');
  assert.ok(ev.message.length > 10);
  assert.deepEqual(JSON.parse(ev.detail).ids, [ghost]);
  const state = async () => JSON.stringify([await db.all('SELECT id, status FROM dining_tables ORDER BY id'), await db.all('SELECT id, status, closed_at FROM bills ORDER BY id'), await db.all('SELECT id, status FROM payments ORDER BY id'), await db.all('SELECT id, stock FROM products ORDER BY id')]);
  const s1 = await state();
  const events1 = (await db.one('SELECT COUNT(*) AS n FROM ops_events WHERE level = \'warn\'')).n;
  const r2 = await heal();
  assert.deepEqual(r2.healed, []);
  assert.equal(await state(), s1);
  assert.equal((await db.one('SELECT COUNT(*) AS n FROM ops_events WHERE level = \'warn\'')).n, events1);
});

test('selfheal: a healthy system produces no repairs and writes no warn/error rows', async () => {
  await heal();
  const n = (await db.one("SELECT COUNT(*) AS n FROM ops_events WHERE level IN ('warn','error') AND kind LIKE 'heal.%'")).n;
  const r = await heal();
  assert.deepEqual(r.healed, []);
  assert.equal((await db.one("SELECT COUNT(*) AS n FROM ops_events WHERE level IN ('warn','error') AND kind LIKE 'heal.%'")).n, n);
});

test('selfheal: a fully-paid open bill is settled with stock, commission, table and booking handled; second run is a no-op', async () => {
  await heal();
  const p = await newProduct(2800, 10);
  const table = await newTable();
  const phone = phoneN();
  const booking = (await call('POST', '/api/bookings', { phone, eta: Date.now() + HOUR, repId: 7 }, tok.s1host)).json.bookingId;
  const b = await openBill(table, { bookingId: booking });
  await addSale(b, p, 3); // 84.00
  await insertPayment(b, 8400, 'paid');
  const r = await heal();
  assert.ok(healedIds(r, 'paid_bill_settled').includes(b));
  const row = await db.one('SELECT status, closed_at FROM bills WHERE id = ?', [b]);
  assert.equal(row.status, 'settled');
  assert.ok(row.closed_at > 0);
  assert.equal((await db.one('SELECT status FROM dining_tables WHERE id = ?', [table])).status, 'free');
  assert.equal((await db.one('SELECT stock FROM products WHERE id = ?', [p])).stock, 7);
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = ?', [booking])).status, 'redeemed');
  const comm = await db.all('SELECT employee_id, role, amount FROM commission_entries WHERE bill_id = ? ORDER BY role', [b]);
  assert.deepEqual(comm.map((c: any) => [c.employee_id, c.role, c.amount]), [[7, 'sales', 420], [4, 'waiter', 168]]);
  const ev = (await db.all("SELECT * FROM ops_events WHERE kind = 'heal.paid_bill_settled' ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual([ev.level, JSON.parse(ev.detail).ids.includes(b)], ['warn', true]);
  const r2 = await heal();
  assert.deepEqual(healedIds(r2, 'paid_bill_settled'), []);
  assert.equal((await db.one('SELECT stock FROM products WHERE id = ?', [p])).stock, 7);
  assert.equal((await db.one('SELECT COUNT(*) AS n FROM commission_entries WHERE bill_id = ?', [b])).n, 2);
});

test('selfheal: its settle condition matches totals() for min-spend, table fee and discount', async () => {
  await heal();
  type Case = { name: string; min: number; fee: number; sale: number; discount: number; paid: number; settles: boolean };
  const cases: Case[] = [
    { name: 'min spend not reached by payment', min: 10000, fee: 0, sale: 2800, discount: 0, paid: 2800, settles: false },
    { name: 'min spend exactly paid', min: 10000, fee: 0, sale: 2800, discount: 0, paid: 10000, settles: true },
    { name: 'min spend one fen short', min: 10000, fee: 0, sale: 2800, discount: 0, paid: 9999, settles: false },
    { name: 'sale above min spend', min: 1000, fee: 0, sale: 2800, discount: 0, paid: 2800, settles: true },
    { name: 'table fee is on top of min spend', min: 10000, fee: 2000, sale: 2800, discount: 0, paid: 10000, settles: false },
    { name: 'table fee on top, fully paid', min: 10000, fee: 2000, sale: 2800, discount: 0, paid: 12000, settles: true },
    { name: 'discount applies after min spend', min: 10000, fee: 0, sale: 2800, discount: 3000, paid: 7000, settles: true },
    { name: 'discount one fen short', min: 10000, fee: 0, sale: 2800, discount: 3000, paid: 6999, settles: false },
    { name: 'overpaid', min: 0, fee: 0, sale: 2800, discount: 0, paid: 5000, settles: true },
    { name: 'discount larger than total, nothing paid', min: 0, fee: 0, sale: 2800, discount: 99999, paid: 0, settles: false },
    { name: 'discount larger than total, a little paid', min: 0, fee: 0, sale: 2800, discount: 99999, paid: 1, settles: true },
  ];
  for (const c of cases) {
    const t = await newTable(c.min, c.fee);
    const b = await openBill(t);
    await addSale(b, 3, c.sale / 2800);
    if (c.discount) await db.run('UPDATE bills SET discount = ? WHERE id = ?', [c.discount, b]);
    if (c.paid) await insertPayment(b, c.paid, 'paid');
    const tot = (await bill(b)).totals;
    await heal();
    const status = (await db.one('SELECT status FROM bills WHERE id = ?', [b])).status;
    assert.equal(status === 'settled', c.settles, `${c.name}: totals ${JSON.stringify(tot)}`);
    assert.equal(tot.due === 0 && c.paid > 0, c.settles, `${c.name}: totals() disagrees with the expectation`);
  }
});

test('selfheal: voided and gift lines do not count towards the settle threshold', async () => {
  await heal();
  const b = await openBill(await newTable());
  const keep = await addSale(b, 3, 1);
  const voided = await addSale(b, 1, 1); // 1288.00, voided below
  assert.equal((await call('POST', `/api/bills/${b}/lines/${voided}/void`, { reason: 'mistake' }, tok.s1manager)).status, 200);
  assert.equal((await call('POST', `/api/bills/${b}/lines`, { productId: 1, qty: 1, gift: true, reason: 'vip' }, tok.s1manager)).status, 200);
  await insertPayment(b, 2800, 'paid');
  await heal();
  assert.equal((await db.one('SELECT status FROM bills WHERE id = ?', [b])).status, 'settled');
  assert.ok(keep > 0);
});

test('selfheal: never settles a bill with zero paid or with a still-pending online payment', async () => {
  await heal();
  const free = await openBill(await newTable()); // total 0, nothing paid
  const waiting = await openBill(await newTable());
  await addSale(waiting, 3, 2); // 56.00
  await insertPayment(waiting, 2800, 'paid');
  await insertPayment(waiting, 2800, 'pending', 2 * MIN, 'wechat');
  const zero = await openBill(await newTable());
  await addSale(zero, 3, 1);
  const r = await heal();
  for (const id of [free, waiting, zero]) {
    assert.equal((await db.one('SELECT status FROM bills WHERE id = ?', [id])).status, 'open');
    assert.equal(healedIds(r, 'paid_bill_settled').includes(id), false);
  }
  // overpaid by pending alone must not settle either; once the paid part covers it, it does
  await insertPayment(zero, 2800, 'failed');
  await insertPayment(zero, 2800, 'refunded');
  await heal();
  assert.equal((await db.one('SELECT status FROM bills WHERE id = ?', [zero])).status, 'open');
  await db.run("UPDATE payments SET status = 'paid' WHERE bill_id = ? AND status = 'pending'", [waiting]);
  assert.ok(healedIds(await heal(), 'paid_bill_settled').includes(waiting));
});

test('selfheal: pending payments older than 15 minutes expire (and then the bill is no longer blocked); fresh ones stay', async () => {
  await heal();
  const b = await openBill(await newTable());
  await addSale(b, 3, 1);
  await insertPayment(b, 2800, 'paid');
  const stale = await insertPayment(b, 2800, 'pending', 16 * MIN, 'alipay');
  const fresh = await insertPayment(b, 100, 'pending', 14 * MIN, 'wechat');
  assert.ok(stale === 1 && fresh === 1);
  const rows = await db.all("SELECT id, created_at FROM payments WHERE bill_id = ? AND status = 'pending' ORDER BY created_at", [b]);
  const r = await heal();
  assert.deepEqual(healedIds(r, 'pending_payment_expired'), [rows[0].id]);
  assert.equal((await db.one('SELECT status FROM payments WHERE id = ?', [rows[0].id])).status, 'expired');
  assert.equal((await db.one('SELECT status FROM payments WHERE id = ?', [rows[1].id])).status, 'pending');
  assert.equal((await db.one('SELECT status FROM bills WHERE id = ?', [b])).status, 'open'); // still waiting on the fresh one
  await db.run("UPDATE payments SET created_at = ? WHERE id = ?", [Date.now() - 20 * MIN, rows[1].id]);
  const r2 = await heal();
  assert.deepEqual(healedIds(r2, 'pending_payment_expired'), [rows[1].id]);
  assert.ok(healedIds(r2, 'paid_bill_settled').includes(b));
  const ev = (await db.all("SELECT * FROM ops_events WHERE kind = 'heal.pending_payment_expired' ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual([ev.level, JSON.parse(ev.detail).ids], ['warn', [rows[1].id]]);
  assert.deepEqual(healedIds(await heal(), 'pending_payment_expired'), []);
});

test('selfheal: a late webhook for an expired payment still settles correctly (no double settle)', async () => {
  await heal();
  const b = await openBill(await newTable());
  await addSale(b, 3, 1);
  const online = await call('POST', `/api/bills/${b}/pay-online`, { method: 'wechat' }, tok.s1cashier);
  assert.equal(online.status, 200, JSON.stringify(online.json));
  await db.run('UPDATE payments SET created_at = ? WHERE id = ?', [Date.now() - 30 * MIN, online.json.paymentId]);
  assert.ok(healedIds(await heal(), 'pending_payment_expired').includes(online.json.paymentId));
  const pay = await call('POST', '/dev/mock-pay', { outTradeNo: online.json.outTradeNo }, tok.s1cashier);
  assert.equal(pay.status, 200, JSON.stringify(pay.json));
  const row = await db.one('SELECT status FROM bills WHERE id = ?', [b]);
  assert.equal(row.status, 'settled');
  assert.equal((await db.one('SELECT COUNT(*) AS n FROM commission_entries WHERE bill_id = ?', [b])).n >= 1, true);
});

test('selfheal: a settled but underpaid bill is alerted (not changed), alerts are logged as errors, repairs stay idempotent', async () => {
  await heal();
  const b = await openBill(await newTable());
  await addSale(b, 3, 2);
  assert.equal((await payCash(b)).json.settled, true);
  const exact = await openBill(await newTable(), {});
  await addSale(exact, 3, 1);
  await payCash(exact);
  const over = await openBill(await newTable());
  await addSale(over, 3, 1);
  await payCash(over);
  await db.run('UPDATE payments SET amount = amount + 500 WHERE bill_id = ?', [over]);
  await db.run('UPDATE payments SET amount = amount - 1 WHERE bill_id = ?', [b]);
  const r = await heal();
  assert.deepEqual(alertIds(r, 'settled_underpaid').filter((id) => [b, exact, over].includes(id)), [b]);
  assert.equal((await db.one('SELECT status FROM bills WHERE id = ?', [b])).status, 'settled');
  const ev = (await db.all("SELECT * FROM ops_events WHERE kind = 'alert.settled_underpaid' ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual([ev.level, JSON.parse(ev.detail).ids.includes(b)], ['error', true]);
  assert.ok(ev.message.length > 10);
  const listed = (await call('GET', '/platform/ops?level=error', undefined, undefined, ADMIN)).json;
  assert.ok(listed.some((e: any) => e.kind === 'alert.settled_underpaid'));
  assert.ok(listed.every((e: any) => e.level === 'error'));
  const r2 = await heal();
  assert.deepEqual(r2.healed, []);
  await db.run('UPDATE payments SET amount = amount + 1 WHERE bill_id = ?', [b]);
  assert.equal(alertIds(await heal(), 'settled_underpaid').includes(b), false);
});

test('selfheal: negative stock is alerted for active tracked products only; selling past zero creates it', async () => {
  await heal();
  const p = await newProduct(1000, 1);
  const untracked = await newProduct(1000, 0, { trackStock: false });
  const retired = await newProduct(1000, 0);
  await db.run('UPDATE products SET stock = -3, active = FALSE WHERE id = ?', [retired]);
  const b = await openBill(await newTable());
  await addSale(b, p, 3);
  await addSale(b, untracked, 1);
  assert.equal((await payCash(b)).json.settled, true);
  assert.equal((await db.one('SELECT stock FROM products WHERE id = ?', [p])).stock, -2);
  assert.equal((await db.one('SELECT stock FROM products WHERE id = ?', [untracked])).stock, 0);
  const r = await heal();
  const ids = alertIds(r, 'negative_stock');
  assert.equal(ids.includes(p), true);
  assert.equal(ids.includes(untracked), false);
  assert.equal(ids.includes(retired), false);
  const ev = (await db.all("SELECT * FROM ops_events WHERE kind = 'alert.negative_stock' ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual([ev.level, JSON.parse(ev.detail).ids.includes(p)], ['error', true]);
  assert.equal((await db.one("SELECT COUNT(*) AS n FROM stock_movements WHERE product_id = ? AND reason LIKE 'sale bill%'", [p])).n, 1);
  await call('POST', `/api/products/${p}/stock`, { delta: 10, reason: 'stocktake' }, tok.s1manager);
  assert.equal(alertIds(await heal(), 'negative_stock').includes(p), false);
});

test('selfheal: expired stash is closed, expired sessions are purged, live ones kept', async () => {
  const s = (await call('POST', '/api/stash', { phone: phoneN(), productId: 3, qtyMilli: 500 }, tok.s1waiter)).json;
  const keep = (await call('POST', '/api/stash', { phone: phoneN(), productId: 3, qtyMilli: 500 }, tok.s1waiter)).json;
  await db.run('UPDATE stash SET expires_at = ? WHERE id = ?', [Date.now() - 5, s.id]);
  await db.run("INSERT INTO sessions (token, employee_id, store_id, expires_at) VALUES ('old-token', 3, 1, ?)", [Date.now() - 1000]);
  await heal();
  assert.equal((await db.one('SELECT status FROM stash WHERE id = ?', [s.id])).status, 'expired');
  assert.equal((await db.one('SELECT status FROM stash WHERE id = ?', [keep.id])).status, 'stored');
  assert.equal(await db.one("SELECT 1 AS x FROM sessions WHERE token = 'old-token'"), undefined);
  assert.equal((await call('GET', '/api/me', undefined, tok.s1host)).status, 200);
});

test('ops: /platform/ops filters by level, orders newest first, honours limit and survives bad parameters', async () => {
  await db.run("INSERT INTO ops_events (ts, level, kind, message, detail) VALUES (?, 'warn', 'test.warn', 'w', '{}'), (?, 'error', 'test.error', 'e', '{}')", [Date.now(), Date.now()]);
  const warn = (await call('GET', '/platform/ops?level=warn', undefined, undefined, ADMIN)).json;
  assert.ok(warn.length > 0 && warn.every((e: any) => e.level === 'warn'));
  const all = (await call('GET', '/platform/ops?limit=3', undefined, undefined, ADMIN)).json;
  assert.equal(all.length, 3);
  assert.ok(all[0].id > all[1].id && all[1].id > all[2].id);
  for (const q of ['limit=abc', 'limit=-5', 'limit=0', 'limit=1e99', 'level=nonsense', 'level=']) {
    const r = await call('GET', `/platform/ops?${q}`, undefined, undefined, ADMIN);
    assert.ok(r.status < 500, `${q} -> ${r.status}`);
  }
  assert.equal((await call('GET', '/platform/ops?level=nonsense', undefined, undefined, ADMIN)).json.length, 0);
  assert.equal((await call('GET', '/platform/metrics', undefined, undefined, ADMIN)).status, 200);
});

test('ops: the ops_events table is capped (oldest rows are dropped)', async () => {
  await db.run("INSERT INTO ops_events (ts, level, kind, message, detail) SELECT ?, 'warn', 'bulk', 'bulk', '{}' FROM generate_series(1, 5600)", [Date.now()]);
  const p = await newProduct(1000, 0);
  await db.run('UPDATE products SET stock = -9 WHERE id = ?', [p]);
  await heal(); // writes at least one more event and triggers the trim
  assert.ok((await db.one('SELECT COUNT(*) AS n FROM ops_events')).n <= 5001);
  await db.run('UPDATE products SET stock = 0 WHERE id = ?', [p]);
});

test('stash: retrieving fractions of a bottle never changes shelf stock; only the sold lines do', async () => {
  const p = await newProduct(5000, 20);
  const s = (await call('POST', '/api/stash', { phone: phoneN(), productId: p, qtyMilli: 1000 }, tok.s1waiter)).json;
  const b = await openBill(await newTable());
  for (let i = 0; i < 4; i++) assert.equal((await call('POST', `/api/stash/${s.id}/retrieve`, { qtyMilli: 100, billId: b }, tok.s1waiter)).status, 200);
  await addSale(b, p, 2);
  assert.equal((await payCash(b)).json.settled, true);
  assert.equal((await db.one('SELECT stock FROM products WHERE id = ?', [p])).stock, 18);
  assert.equal((await db.one('SELECT COUNT(*) AS n FROM stock_movements WHERE product_id = ?', [p])).n, 1);
});

test('selfheal: standing alerts are reported every run but logged once, changed alerts are logged again', async () => {
  await heal();
  const p = await newProduct(1000, 0);
  await db.run('UPDATE products SET stock = -4 WHERE id = ?', [p]);
  const count = async () => (await db.one("SELECT COUNT(*) AS n FROM ops_events WHERE kind = 'alert.negative_stock'")).n;
  const n0 = await count();
  assert.ok(alertIds(await heal(), 'negative_stock').includes(p));
  assert.equal(await count(), n0 + 1);
  assert.ok(alertIds(await heal(), 'negative_stock').includes(p));
  assert.ok(alertIds(await heal(), 'negative_stock').includes(p));
  assert.equal(await count(), n0 + 1);
  const q = await newProduct(1000, 0);
  await db.run('UPDATE products SET stock = -1 WHERE id = ?', [q]);
  assert.ok(alertIds(await heal(), 'negative_stock').includes(q));
  assert.equal(await count(), n0 + 2);
  await db.run('UPDATE products SET stock = 0 WHERE id IN (?, ?)', [p, q]);
});

test('selfheal: one bill that cannot be settled does not stop the other repairs or checks', async () => {
  await heal();
  const bad = await openBill(await newTable());
  await addSale(bad, 3, 1);
  await insertPayment(bad, 2800, 'paid');
  const good = await openBill(await newTable());
  await addSale(good, 3, 1);
  await insertPayment(good, 2800, 'paid');
  const ghost = await newTable();
  await db.run("UPDATE dining_tables SET status = 'occupied' WHERE id = ?", [ghost]);
  await db.script(`
    CREATE OR REPLACE FUNCTION np_boom() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER np_boom_trg BEFORE UPDATE ON bills FOR EACH ROW WHEN (NEW.id = ${bad} AND NEW.status = 'settled') EXECUTE FUNCTION np_boom();`);
  try {
    const r = await heal();
    assert.deepEqual(healedIds(r, 'paid_bill_settled'), [good]);
    assert.deepEqual(healedIds(r, 'table_ghost_occupied').includes(ghost), true);
    assert.equal((await db.one('SELECT status FROM bills WHERE id = ?', [bad])).status, 'open');
    const ev = (await db.all("SELECT * FROM ops_events WHERE kind = 'heal.settle_failed' ORDER BY id DESC LIMIT 1"))[0];
    assert.deepEqual([ev.level, JSON.parse(ev.detail).id], ['error', bad]);
  } finally {
    await db.script('DROP TRIGGER np_boom_trg ON bills; DROP FUNCTION np_boom();');
  }
  assert.ok(healedIds(await heal(), 'paid_bill_settled').includes(bad));
});

// ============================================================================================
// GENERIC: nothing in this area may answer 500
// ============================================================================================

test('fuzz: garbage bodies and parameters on every admin/stash/booking/hq route never produce a 500', async () => {
  const t = (await call('POST', '/api/login', { company: 'doloruu', username: 'owner', pin: '6666' })).json.token as string;
  const garbage: unknown[] = [{}, { x: 1 }, { phone: null, amount: null, qtyMilli: null }, { name: 1, price: 'a', code: [], storeId: {}, toStoreIds: 'x' }, { tableId: 1e30, repId: -1, productId: 'q', billId: [] },
    { delta: 'NaN', reason: 5 }, { eta: {}, partySize: [] }, { role: 5, bps: 'x', fixed: {} }, { active: 'maybe', pin: {} }, { fromStoreId: {}, toStoreIds: [{}] }];
  const routes: Array<[string, string]> = [
    ['POST', '/api/tables'], ['PATCH', '/api/tables/1'], ['POST', '/api/products'], ['PATCH', '/api/products/1'], ['POST', '/api/products/1/stock'],
    ['POST', '/api/commission-rules'], ['POST', '/api/bills'], ['POST', '/api/bookings'], ['POST', '/api/bookings/1/confirm'], ['POST', '/api/bookings/1/cancel'],
    ['POST', '/api/stash'], ['POST', '/api/stash/1/retrieve'], ['POST', '/api/stash/1/transfer'], ['POST', '/api/members/topup'], ['PATCH', '/api/staff/3'],
    ['POST', '/api/hq/stores'], ['POST', '/api/hq/staff'], ['POST', '/api/hq/catalog/copy'], ['POST', '/api/shifts/open'], ['POST', '/api/shifts/close'],
    ['POST', '/api/receivables/1/collect'], ['POST', '/api/bills/1/pay'], ['POST', '/api/bills/1/lines'], ['POST', '/api/bills/1/discount'], ['POST', '/api/bills/1/transfer'],
  ];
  for (const [method, path] of routes) {
    for (const body of garbage) {
      const r = await call(method, path, body, t);
      assert.ok(r.status < 500, `${method} ${path} ${JSON.stringify(body)} -> ${r.status} ${JSON.stringify(r.json)}`);
    }
  }
  const gets = ['/api/stash?q=%', '/api/stash', '/api/members?q=', '/api/members/%20', '/api/hq/summary?from=x', '/api/payroll?from=x', '/api/reports/daily?to=abc', '/api/bookings', '/api/tables?all=zzz', '/api/audit?all=1', '/api/members/' + 'x'.repeat(5000)];
  for (const path of gets) {
    const r = await call('GET', path, undefined, t);
    assert.ok(r.status < 500, `GET ${path} -> ${r.status}`);
  }
  const errors = await db.all("SELECT message, detail FROM ops_events WHERE kind = 'http.500'");
  assert.deepEqual(errors, []);
});

test('selfheal: webhook events older than 90 days are pruned, recent ones kept', async () => {
  const day = 24 * 60 * 60 * 1000;
  await db.run("INSERT INTO webhook_events (id, provider, ts) VALUES ('wechat:old-evt', 'wechat', ?), ('wechat:new-evt', 'wechat', ?)", [Date.now() - 91 * day, Date.now() - 89 * day]);
  await heal();
  const left = (await db.all("SELECT id FROM webhook_events WHERE id IN ('wechat:old-evt', 'wechat:new-evt')")).map((r: any) => r.id);
  assert.deepEqual(left, ['wechat:new-evt']);
});

test('migrations create the hot-path indexes', async () => {
  const names = (await db.all("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")).map((r: any) => r.indexname);
  const wanted = ['audit_ts', 'wallet_ledger_member', 'commission_entries_store_ts', 'stock_movements_store_product_ts', 'payments_provider_ref', 'webhook_events_ts', 'sessions_employee'];
  assert.deepEqual(wanted.filter((n) => !names.includes(n)), []);
});
