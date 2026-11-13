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
let db: Db;
let server: Server;
let base: string;
const tok: Record<string, string> = {};

async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

// Seeded ids: 1 owner, 2 finance, store 1 staff 3-7, store 2 staff 8-12.
// Store 1 tables 1-14 (B1 = 7), store 2 tables 15-28 (A1 = 15, B1 = 21). Store 1 products 1-5, store 2 products 6-10.
before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  await seed(db);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const staff: Record<string, [string, string]> = {
    owner: ["owner", "6666"], finance: ["finance", "5555"],
    s1host: ["flag.host", "1111"], s1waiter: ["flag.waiter", "2222"], s1cashier: ["flag.cashier", "3333"], s1manager: ["flag.manager", "4444"],
    s2host: ["lnge.host", "1111"], s2waiter: ["lnge.waiter", "2222"], s2cashier: ["lnge.cashier", "3333"], s2manager: ["lnge.manager", "4444"], s2rep: ["lnge.rep", "7777"],
  };
  for (const [k, [username, pin]] of Object.entries(staff)) tok[k] = (await call("POST", "/api/login", { company: "doloruu", username, pin })).json.token;
});
after(async () => {
  server.close();
  await db.close();
});

test('store staff only see their own store tables', async () => {
  const s1 = (await call('GET', '/api/tables', undefined, tok.s1cashier)).json;
  const s2 = (await call('GET', '/api/tables', undefined, tok.s2cashier)).json;
  assert.deepEqual([s1.length, s2.length, Math.min(...s2.map((t: any) => t.id))], [14, 14, 15]);
});

test('a store-1 host cannot open a store-2 table', async () => {
  const r = await call('POST', '/api/bills', { tableId: 15, repId: 7 }, tok.s1host);
  assert.equal(r.status, 404);
});

test('a rep from another store cannot be attributed', async () => {
  const r = await call('POST', '/api/bills', { tableId: 15, repId: 7 }, tok.s2host);
  assert.equal(r.status, 422);
});

test('two hosts racing to open one table: exactly one wins', async () => {
  const [a, b] = await Promise.all([
    call('POST', '/api/bills', { tableId: 16, repId: 12 }, tok.s2host),
    call('POST', '/api/bills', { tableId: 16, repId: 12 }, tok.s2cashier),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
});

test('store staff cannot switch store, owner can', async () => {
  assert.equal((await call('POST', '/api/switch-store', { storeId: 2 }, tok.s1manager)).status, 403);
  assert.equal((await call('GET', '/api/me', undefined, tok.owner)).json.store.id, 1);
  const sw = await call('POST', '/api/switch-store', { storeId: 2 }, tok.owner);
  assert.equal(sw.json.actor.storeId, 2);
  const tables = (await call('GET', '/api/tables', undefined, tok.owner)).json;
  assert.equal(tables[0].id, 15);
  await call('POST', '/api/switch-store', { storeId: 1 }, tok.owner);
});

test('wallet topped up at store 1 is spent at store 2', async () => {
  const phone = '13500000009';
  await call('POST', '/api/members/topup', { phone, amount: 100000, bonus: 10000 }, tok.s1manager);
  const open = await call('POST', '/api/bills', { tableId: 17, repId: 12, phone }, tok.s2host);
  await call('POST', `/api/bills/${open.json.billId}/lines`, { productId: 8, qty: 10 }, tok.s2waiter); // 10 beers = 280.00
  const pay = await call('POST', `/api/bills/${open.json.billId}/pay`, { method: 'member' }, tok.s2cashier);
  assert.equal(pay.json.settled, true);
  const m = await call('GET', `/api/members/${phone}`, undefined, tok.s1manager);
  assert.equal(m.json.balance, 110000 - 28000);
});

test('douyin booking lands in the store mapped to its poi; unknown poi is refused', async () => {
  const post = async (poiId: string, bookingId: string) => {
    const raw = JSON.stringify({ eventId: bookingId, type: 'booking.created', data: { poiId, bookingId, phone: '13300000001', eta: Date.now() + 1000 } });
    const sig = createHmac('sha256', 'dy-secret').update(raw).digest('hex');
    const res = await fetch(`${base}/webhooks/douyin`, { method: 'POST', headers: { 'x-douyin-signature': sig }, body: raw });
    return { status: res.status, json: (await res.json()) as any };
  };
  const ok = await post('poi_lounge', 'dy-m1');
  assert.equal(ok.json.storeId, 2);
  assert.equal((await call('GET', '/api/bookings', undefined, tok.s1host)).json.some((b: any) => b.external_id === 'dy-m1'), false);
  assert.equal((await call('GET', '/api/bookings', undefined, tok.s2host)).json.some((b: any) => b.external_id === 'dy-m1'), true);
  assert.equal((await post('poi_nowhere', 'dy-m2')).status, 422);
});

test('stash lives in one store until transferred', async () => {
  const s = await call('POST', '/api/stash', { phone: '13400000002', productId: 1, qtyMilli: 1000 }, tok.s1waiter);
  assert.equal((await call('GET', '/api/stash?q=13400000002', undefined, tok.s2cashier)).json.length, 0);
  assert.equal((await call('POST', `/api/stash/${s.json.id}/transfer`, { toStoreId: 2 }, tok.s1manager)).status, 200);
  assert.equal((await call('GET', '/api/stash?q=13400000002', undefined, tok.s2cashier)).json.length, 1);
});

test('hq summary rolls up every store and is closed to store staff', async () => {
  assert.equal((await call('GET', '/api/hq/summary', undefined, tok.s1manager)).status, 403);
  const r = (await call('GET', '/api/hq/summary', undefined, tok.finance)).json;
  assert.equal(r.stores.length, 2);
  const store2 = r.stores.find((s: any) => s.storeId === 2);
  assert.equal(store2.revenue, 28000);
  assert.equal(r.totals.revenue, r.stores[0].revenue + r.stores[1].revenue);
});

test('owner creates a store, copies the catalog and adds staff who can log in', async () => {
  const made = await call('POST', '/api/hq/stores', { name: 'Pop-up', code: 'POP', douyinPoiId: 'poi_pop', copyCatalogFrom: 1 }, tok.owner);
  assert.equal(made.status, 200);
  const storeId = made.json.storeId;
  const staff = await call('POST', '/api/hq/staff', { name: 'Pop Cashier', username: 'pop.cashier', role: 'cashier', pin: '9090', storeId }, tok.owner);
  const login = await call('POST', '/api/login', { company: 'doloruu', username: 'pop.cashier', pin: '9090' });
  assert.equal(login.json.actor.storeId, storeId);
  const products = await call('GET', '/api/products', undefined, login.json.token);
  assert.equal(products.json.length, 5);
  assert.equal(products.json.every((p: any) => p.stock === 0), true);
});

test('catalog copy updates prices on stores that already have the product', async () => {
  await db.run("UPDATE products SET price = 99999 WHERE store_id = 1 AND name = 'Mixer Pack'");
  const r = await call('POST', '/api/hq/catalog/copy', { fromStoreId: 1, toStoreIds: [2] }, tok.owner);
  assert.equal(r.status, 200);
  const p = await db.one("SELECT price, COUNT(*) OVER () AS n FROM products WHERE store_id = 2 AND name = 'Mixer Pack'");
  assert.equal(p.price, 99999);
  assert.equal(p.n, 1);
});

test('non-owner cannot create stores or staff', async () => {
  assert.equal((await call('POST', '/api/hq/stores', { name: 'X', code: 'X' }, tok.finance)).status, 403);
  assert.equal((await call('POST', '/api/hq/staff', { name: 'X', username: 'xx', role: 'cashier', pin: '1234', storeId: 1 }, tok.s1manager)).status, 403);
});

test('commission is attributed to the store where the sale happened', async () => {
  const open = await call('POST', '/api/bills', { tableId: 18, repId: 12 }, tok.s2host);
  await call('POST', `/api/bills/${open.json.billId}/lines`, { productId: 6, qty: 1 }, tok.s2waiter);
  await call('POST', `/api/bills/${open.json.billId}/pay`, { method: 'cash' }, tok.s2cashier);
  const rows = (await call('GET', '/api/payroll?all=1', undefined, tok.finance)).json;
  const rep = rows.find((r: any) => r.employeeId === 12 && r.role === 'sales');
  // 8% of the 1288.00 spirits bill here, plus 5% of the 280.00 beer bill from the wallet test above
  assert.deepEqual([rep.storeId, rep.commission], [2, 10304 + 1400]);
});
