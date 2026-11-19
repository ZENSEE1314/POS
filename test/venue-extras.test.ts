import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { seed, DEMO_PINS } from '../src/seed.ts';

const ENV = { PAY_MODE: 'mock', MOCK_PAY_SECRET: 's3cret', PUBLIC_BASE_URL: 'http://venue.test' } as NodeJS.ProcessEnv;
const ADMIN_KEY = 'test-admin-key';
const DAY_MS = 86_400_000;
let db: Db;
let server: Server;
let base: string;
let manager: string;
let waiter: string;
let lounge: string;

async function call(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const login = async (username: string, pin: string) => (await call('POST', '/api/login', { company: 'doloruu', username, pin })).json.token;
const platform = (method: string, path: string, body?: unknown) => call(method, path, body, undefined, { 'x-admin-key': ADMIN_KEY });
const products = async (token = manager) => (await call('GET', '/api/products', undefined, token)).json.filter((p: any) => p.track_stock && p.unit !== 'kg');
const stockOf = async (id: number, token = manager) => Number((await call('GET', '/api/products', undefined, token)).json.find((p: any) => p.id === id).stock);

async function openBillWith(productId: number) {
  const tables = (await call('GET', '/api/tables', undefined, manager)).json;
  const reps = (await call('GET', '/api/reps', undefined, manager)).json;
  const table = tables.find((x: any) => x.status === 'free' && !x.min_spend && !x.locked_at);
  const billId = (await call('POST', '/api/bills', { tableId: table.id, repId: reps[0].id }, manager)).json.billId;
  await call('POST', `/api/bills/${billId}/lines`, { productId, qty: 2 }, manager);
  return billId;
}
const pendingIds = async () => (await call('GET', '/api/kds', undefined, waiter)).json.tickets.flatMap((tk: any) => tk.items.map((i: any) => i.id));

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  await seed(db);
  server = createApp(db, { ...ENV, PLATFORM_ADMIN_KEY: ADMIN_KEY });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  manager = await login('flag.manager', DEMO_PINS.manager);
  waiter = await login('flag.waiter', DEMO_PINS.waiter);
  lounge = await login('lnge.manager', DEMO_PINS.manager);
});
after(async () => {
  server.close();
  await db.close();
});

const loungeStoreId = async () => (await db.one("SELECT id FROM stores WHERE code = 'LNGE'")).id;

// ---------- bar display ----------

test('an ordered drink shows on the bar display', async () => {
  const [p] = await products();
  const billId = await openBillWith(p.id);
  const kds = (await call('GET', '/api/kds?station=all', undefined, waiter)).json;
  assert.ok(kds.tickets.some((tk: any) => tk.billId === billId));
});

test('a served item leaves the display', async () => {
  const [, p] = await products();
  await openBillWith(p.id);
  const [id] = await pendingIds();
  await call('POST', '/api/kds/served', { lineIds: [id] }, waiter);
  assert.equal((await pendingIds()).includes(id), false);
});

test('a served item can be put back on the display', async () => {
  const [id] = await pendingIds();
  await call('POST', '/api/kds/served', { lineIds: [id] }, waiter);
  await call('POST', '/api/kds/served', { lineIds: [id], served: false }, waiter);
  assert.equal((await pendingIds()).includes(id), true);
});

test('the display refuses an unknown station', async () => {
  assert.equal((await call('GET', '/api/kds?station=pool', undefined, waiter)).status, 422);
});

test('another store cannot mark this store\'s items served', async () => {
  const [id] = await pendingIds();
  assert.equal((await call('POST', '/api/kds/served', { lineIds: [id] }, lounge)).status, 404);
});

// ---------- stocktake ----------

test('closing a stocktake sets stock to what was counted', async () => {
  const [p] = await products();
  const { stocktakeId } = (await call('POST', '/api/stocktakes', { note: 'monthly' }, manager)).json;
  await call('PATCH', `/api/stocktakes/${stocktakeId}`, { counts: { [p.id]: 7 } }, manager);
  await call('POST', `/api/stocktakes/${stocktakeId}/close`, undefined, manager);
  assert.equal(await stockOf(p.id), 7);
});

test('stock that moves during a stocktake is kept when it closes', async () => {
  const [, , p] = await products();
  const { stocktakeId } = (await call('POST', '/api/stocktakes', {}, manager)).json;
  const expected = (await call('GET', `/api/stocktakes/${stocktakeId}`, undefined, manager)).json.lines.find((l: any) => l.productId === p.id).expected;
  await call('POST', '/api/stock-transfers', { toStoreId: Number(await loungeStoreId()), items: [{ productId: p.id, qty: 2 }] }, manager);
  await call('PATCH', `/api/stocktakes/${stocktakeId}`, { counts: { [p.id]: expected } }, manager);
  await call('POST', `/api/stocktakes/${stocktakeId}/close`, undefined, manager);
  assert.equal(await stockOf(p.id), expected - 2);
});

test('only one stocktake can be open per store', async () => {
  const { stocktakeId } = (await call('POST', '/api/stocktakes', {}, manager)).json;
  const second = await call('POST', '/api/stocktakes', {}, manager);
  await call('POST', `/api/stocktakes/${stocktakeId}/cancel`, undefined, manager);
  assert.equal(second.status, 409);
});

test('a count must be a whole number', async () => {
  const [p] = await products();
  const { stocktakeId } = (await call('POST', '/api/stocktakes', {}, manager)).json;
  const r = await call('PATCH', `/api/stocktakes/${stocktakeId}`, { counts: { [p.id]: -1 } }, manager);
  await call('POST', `/api/stocktakes/${stocktakeId}/cancel`, undefined, manager);
  assert.equal(r.status, 422);
});

test('waiters cannot start a stocktake', async () => {
  assert.equal((await call('POST', '/api/stocktakes', {}, waiter)).status, 403);
});

// ---------- transfers ----------

test('a transfer takes stock off the sending store', async () => {
  const [p] = await products();
  const before = await stockOf(p.id);
  await call('POST', '/api/stock-transfers', { toStoreId: Number(await loungeStoreId()), items: [{ productId: p.id, qty: 1 }] }, manager);
  assert.equal(await stockOf(p.id), before - 1);
});

test('receiving a transfer adds the stock to the receiving store', async () => {
  const [p] = await products();
  const target = (await products(lounge)).find((x: any) => x.name === p.name);
  const before = await stockOf(target.id, lounge);
  const { transferId } = (await call('POST', '/api/stock-transfers', { toStoreId: Number(await loungeStoreId()), items: [{ productId: p.id, qty: 2 }] }, manager)).json;
  await call('POST', `/api/stock-transfers/${transferId}/receive`, undefined, lounge);
  assert.equal(await stockOf(target.id, lounge), before + 2);
});

test('cancelling a transfer returns the stock', async () => {
  const [p] = await products();
  const before = await stockOf(p.id);
  const { transferId } = (await call('POST', '/api/stock-transfers', { toStoreId: Number(await loungeStoreId()), items: [{ productId: p.id, qty: 1 }] }, manager)).json;
  await call('POST', `/api/stock-transfers/${transferId}/cancel`, undefined, manager);
  assert.equal(await stockOf(p.id), before);
});

test('the sending store cannot receive its own transfer', async () => {
  const [p] = await products();
  const { transferId } = (await call('POST', '/api/stock-transfers', { toStoreId: Number(await loungeStoreId()), items: [{ productId: p.id, qty: 1 }] }, manager)).json;
  assert.equal((await call('POST', `/api/stock-transfers/${transferId}/receive`, undefined, manager)).status, 404);
});

test('a transfer cannot send more than is in stock', async () => {
  const [p] = await products();
  const r = await call('POST', '/api/stock-transfers', { toStoreId: Number(await loungeStoreId()), items: [{ productId: p.id, qty: 1_000_000 }] }, manager);
  assert.equal(r.status, 409);
});

test('a manager can list the company stores to send stock to', async () => {
  assert.deepEqual((await call('GET', '/api/stores', undefined, manager)).json.map((x: any) => x.code), ['FLAG', 'LNGE']);
});

// ---------- forfeited bottles ----------

async function expiredBottle(productId: number) {
  const storeId = (await db.one("SELECT id FROM stores WHERE code = 'FLAG'")).id;
  return db.insert(`INSERT INTO stash (store_id, phone, product_id, name, qty_milli, left_milli, expires_at, code, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, [storeId, '13800000000', productId, 'Bottle', 1000, 1000, Date.now() - DAY_MS, `X${Math.random()}`, Date.now() - 100 * DAY_MS]);
}

test('expired bottles are listed for forfeiting', async () => {
  const [p] = await products();
  const id = await expiredBottle(p.id);
  assert.ok((await call('GET', '/api/stash/expired', undefined, manager)).json.some((s: any) => s.id === id));
});

test('a forfeited full bottle can go back into stock', async () => {
  const [p] = await products();
  const id = await expiredBottle(p.id);
  const before = await stockOf(p.id);
  await call('POST', '/api/stash/forfeit', { ids: [id], toStock: true }, manager);
  assert.equal(await stockOf(p.id), before + 1);
});

test('a bottle that has not expired cannot be forfeited', async () => {
  const [p] = await products();
  const id = await expiredBottle(p.id);
  await db.run('UPDATE stash SET expires_at = ? WHERE id = ?', [Date.now() + DAY_MS, id]);
  assert.equal((await call('POST', '/api/stash/forfeit', { ids: [id] }, manager)).status, 409);
});

// ---------- queue ----------

test('queue numbers count up through the night', async () => {
  const a = (await call('POST', '/api/queue', { partySize: 2 }, waiter)).json.number;
  const b = (await call('POST', '/api/queue', { partySize: 4 }, waiter)).json.number;
  assert.equal(b, a + 1);
});

test('a guest can take a queue number from the customer app', async () => {
  const r = await call('POST', '/api/guest/queue/doloruu', { partySize: 3, phone: '13900000000', storeCode: 'FLAG' });
  assert.equal((await call('GET', `/api/guest/queue-ticket/${r.json.code}`)).json.status, 'waiting');
});

test('a guest sees how many parties are ahead', async () => {
  await call('POST', '/api/queue', { partySize: 2 }, waiter);
  const { code } = (await call('POST', '/api/guest/queue/doloruu', { partySize: 2, phone: '13900000001', storeCode: 'FLAG' })).json;
  assert.ok((await call('GET', `/api/guest/queue-ticket/${code}`)).json.ahead >= 1);
});

test('calling a number shows it to waiting guests', async () => {
  const t1 = (await call('POST', '/api/queue', { partySize: 2 }, waiter)).json;
  const { code } = (await call('POST', '/api/guest/queue/doloruu', { partySize: 2, phone: '13900000002', storeCode: 'FLAG' })).json;
  await call('POST', `/api/queue/${t1.id}/call`, undefined, waiter);
  assert.equal((await call('GET', `/api/guest/queue-ticket/${code}`)).json.nowCalling, t1.number);
});

test('a seated party leaves the waiting list', async () => {
  const tk = (await call('POST', '/api/queue', { partySize: 2 }, waiter)).json;
  await call('POST', `/api/queue/${tk.id}/seat`, undefined, waiter);
  assert.equal((await call('GET', '/api/queue', undefined, waiter)).json.waiting.some((x: any) => x.id === tk.id), false);
});

test('a guest queue number needs a phone', async () => {
  assert.equal((await call('POST', '/api/guest/queue/doloruu', { partySize: 2 })).status, 422);
});

test('a guest can cancel their queue number', async () => {
  const { code } = (await call('POST', '/api/guest/queue/doloruu', { partySize: 2, phone: '13900000003' })).json;
  await call('POST', `/api/guest/queue-ticket/${code}/cancel`);
  assert.equal((await call('GET', `/api/guest/queue-ticket/${code}`)).json.status, 'cancelled');
});

// ---------- training ----------

test('staff see a lesson a manager wrote', async () => {
  const { lessonId } = (await call('POST', '/api/lessons', { title: 'Opening checklist', body: 'Ice, lemons, music', required: true }, manager)).json;
  assert.ok((await call('GET', '/api/lessons', undefined, waiter)).json.some((l: any) => l.id === lessonId));
});

test('reading a required lesson takes the reader off the not-read list', async () => {
  const { lessonId } = (await call('POST', '/api/lessons', { title: 'Fire exits', required: true }, manager)).json;
  await call('POST', `/api/lessons/${lessonId}/read`, undefined, waiter);
  const progress = (await call('GET', '/api/training-progress', undefined, manager)).json.find((l: any) => l.id === lessonId);
  assert.equal(progress.notRead.includes('Waiter FLAG'), false);
});

test('waiters cannot write lessons', async () => {
  assert.equal((await call('POST', '/api/lessons', { title: 'x' }, waiter)).status, 403);
});

test('a lesson video must be an https link', async () => {
  assert.equal((await call('POST', '/api/lessons', { title: 'x', videoUrl: 'javascript:alert(1)' }, manager)).status, 422);
});

// ---------- singers ----------

test('the customer app shows the singer on stage now', async () => {
  const { performerId } = (await call('POST', '/api/performers', { name: 'Lily', kind: 'singer' }, manager)).json;
  await call('POST', '/api/performer-sets', { performerId, startsAt: Date.now() - 60_000, endsAt: Date.now() + 3_600_000 }, manager);
  const list = (await call('GET', '/api/guest/performers/doloruu')).json;
  assert.equal(list.find((p: any) => p.name === 'Lily').onNow, true);
});

test('a set must end after it starts', async () => {
  const { performerId } = (await call('POST', '/api/performers', { name: 'Max' }, manager)).json;
  assert.equal((await call('POST', '/api/performer-sets', { performerId, startsAt: Date.now(), endsAt: Date.now() - 1 }, manager)).status, 422);
});

// ---------- resellers ----------

const newCompany = (code: string, partnerCode?: string) => platform('POST', '/platform/companies', {
  name: `Co ${code}`, code, storeName: 'Main', ownerName: 'Boss', ownerUsername: 'boss', ownerPin: '12345678', partnerCode,
});

test('a company signed up with a partner code is credited to that reseller', async () => {
  const { id, code } = (await platform('POST', '/platform/resellers', { name: 'Shenzhen Partner', commissionBps: 2000 })).json;
  await newCompany('partnerco1', code);
  assert.deepEqual((await platform('GET', `/platform/resellers/${id}/companies`)).json.map((c: any) => c.code), ['partnerco1']);
});

test('an unknown partner code is refused', async () => {
  assert.equal((await newCompany('partnerco2', 'NOPE1234')).status, 422);
});

test('two resellers cannot share a code', async () => {
  await platform('POST', '/platform/resellers', { name: 'A', code: 'SAME1' });
  assert.equal((await platform('POST', '/platform/resellers', { name: 'B', code: 'SAME1' })).status, 409);
});

test('reseller admin needs the platform key', async () => {
  assert.equal((await call('GET', '/platform/resellers')).status, 403);
});
