import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { seed } from '../src/seed.ts';

const ENV = { PAY_MODE: 'mock', MOCK_PAY_SECRET: 's3cret', PLATFORM_ADMIN_KEY: 'admin-key' } as NodeJS.ProcessEnv;
let db: Db;
let server: Server;
let base: string;
const tok: Record<string, string> = {};

async function call(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

const goodPrinter = { name: 'Bar Epson', kind: 'bar', bridgeName: 'BAR_EPSON', paperMm: 80, copies: 1 };

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  await seed(db);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const staff: Record<string, [string, string]> = {
    owner: ['owner', '6666'], s1waiter: ['flag.waiter', '2222'], s1cashier: ['flag.cashier', '3333'], s1manager: ['flag.manager', '4444'], s2manager: ['lnge.manager', '4444'],
  };
  for (const [k, [username, pin]] of Object.entries(staff)) tok[k] = (await call('POST', '/api/login', { company: 'doloruu', username, pin })).json.token;
  // a second, unrelated company
  const made = await call('POST', '/platform/companies', { name: 'Other Co', code: 'otherco', storeName: 'Other Bar', ownerName: 'Olive', ownerUsername: 'olive', ownerPin: 'a-long-pin-9' }, undefined, { 'x-admin-key': 'admin-key' });
  assert.equal(made.status, 200);
  tok.other = (await call('POST', '/api/login', { company: 'otherco', username: 'olive', pin: 'a-long-pin-9' })).json.token;
});
after(async () => {
  server.close();
  await db.close();
});

test('manager creates a printer and any signed-in staff can read it', async () => {
  const made = await call('POST', '/api/printers', goodPrinter, tok.s1manager);
  assert.equal(made.status, 200);
  const list = (await call('GET', '/api/printers', undefined, tok.s1waiter)).json;
  assert.deepEqual(list.map((p: any) => [p.id, p.name, p.kind, p.bridgeName, p.paperMm, p.copies, p.enabled, p.lang]), [[made.json.printerId, 'Bar Epson', 'bar', 'BAR_EPSON', 80, 1, true, 'both']]);
});

test('waiter and cashier cannot write printers', async () => {
  for (const token of [tok.s1waiter, tok.s1cashier]) {
    assert.equal((await call('POST', '/api/printers', goodPrinter, token)).status, 403);
  }
  assert.equal((await call('PATCH', '/api/printers/1', { name: 'x' }, tok.s1waiter)).status, 403);
  assert.equal((await call('DELETE', '/api/printers/1', undefined, tok.s1cashier)).status, 403);
});

test('unauthenticated requests are refused', async () => {
  assert.equal((await call('GET', '/api/printers')).status, 401);
  assert.equal((await call('POST', '/api/printers', goodPrinter)).status, 401);
});

test('manager updates and deletes a printer', async () => {
  const id = (await call('POST', '/api/printers', { ...goodPrinter, name: 'Kitchen 58', kind: 'kitchen', bridgeName: 'KIT', paperMm: 58 }, tok.s1manager)).json.printerId;
  assert.equal((await call('PATCH', `/api/printers/${id}`, { copies: 2, enabled: false, lang: 'zh' }, tok.s1manager)).status, 200);
  const row = (await call('GET', '/api/printers', undefined, tok.s1manager)).json.find((p: any) => p.id === id);
  assert.deepEqual([row.copies, row.enabled, row.lang, row.paperMm], [2, false, 'zh', 58]);
  assert.equal((await call('DELETE', `/api/printers/${id}`, undefined, tok.s1manager)).status, 200);
  assert.equal((await call('DELETE', `/api/printers/${id}`, undefined, tok.s1manager)).status, 404);
});

test('printers are isolated per store and per company', async () => {
  const mine = (await call('GET', '/api/printers', undefined, tok.s1manager)).json[0];
  assert.deepEqual((await call('GET', '/api/printers', undefined, tok.s2manager)).json, []);
  assert.deepEqual((await call('GET', '/api/printers', undefined, tok.other)).json, []);
  for (const token of [tok.s2manager, tok.other]) {
    assert.equal((await call('PATCH', `/api/printers/${mine.id}`, { name: 'hijack' }, token)).status, 404);
    assert.equal((await call('DELETE', `/api/printers/${mine.id}`, undefined, token)).status, 404);
  }
  const still = (await call('GET', '/api/printers', undefined, tok.s1manager)).json.find((p: any) => p.id === mine.id);
  assert.equal(still.name, 'Bar Epson');
});

test('the owner sees the printers of whichever store they switch to', async () => {
  assert.equal((await call('GET', '/api/printers', undefined, tok.owner)).json.length, 1);
  await call('POST', '/api/switch-store', { storeId: 2 }, tok.owner);
  assert.equal((await call('GET', '/api/printers', undefined, tok.owner)).json.length, 0);
  await call('POST', '/api/switch-store', { storeId: 1 }, tok.owner);
});

test('printer validation rejects bad input with 422, never 500', async () => {
  const bad: Array<Record<string, unknown>> = [
    {}, { ...goodPrinter, name: '' }, { ...goodPrinter, name: '   ' }, { ...goodPrinter, name: 'x'.repeat(61) }, { ...goodPrinter, name: 12 },
    { ...goodPrinter, kind: 'fax' }, { ...goodPrinter, kind: undefined },
    { ...goodPrinter, paperMm: 70 }, { ...goodPrinter, paperMm: '80' },
    { ...goodPrinter, copies: 0 }, { ...goodPrinter, copies: 6 }, { ...goodPrinter, copies: 1.5 }, { ...goodPrinter, copies: '2' },
    { ...goodPrinter, enabled: 'yes' }, { ...goodPrinter, lang: 'fr' },
    { ...goodPrinter, bridgeName: '' }, { ...goodPrinter, bridgeName: '192.168.1.50:9100' + '/x' }, { ...goodPrinter, bridgeName: '\\\\host\\share' },
    { ...goodPrinter, bridgeName: 'a'.repeat(65) }, { ...goodPrinter, bridgeName: '-leading' }, { ...goodPrinter, bridgeName: 7 }, { ...goodPrinter, bridgeName: 'with;semicolon' },
  ];
  for (const body of bad) {
    const r = await call('POST', '/api/printers', { name: 'Valid', ...body }, tok.s1manager);
    assert.equal(r.status, 422, JSON.stringify(body));
  }
});

test('printer name must be unique within a store, case-insensitively', async () => {
  assert.equal((await call('POST', '/api/printers', { ...goodPrinter, name: 'bar epson' }, tok.s1manager)).status, 409);
  const id = (await call('POST', '/api/printers', { ...goodPrinter, name: 'Second', bridgeName: 'SECOND' }, tok.s1manager)).json.printerId;
  assert.equal((await call('PATCH', `/api/printers/${id}`, { name: 'BAR EPSON' }, tok.s1manager)).status, 409);
  assert.equal((await call('PATCH', `/api/printers/${id}`, { name: 'Second renamed' }, tok.s1manager)).status, 200);
  await call('DELETE', `/api/printers/${id}`, undefined, tok.s1manager);
});

test('printer ids in the path are validated', async () => {
  for (const id of ['abc', '1.5', '99999999999999999999', '1e3', '%20']) {
    const r = await call('PATCH', `/api/printers/${id}`, { name: 'x' }, tok.s1manager);
    assert.ok([404, 422].includes(r.status), `${id} -> ${r.status}`);
  }
  assert.equal((await call('PATCH', '/api/printers/-5', { name: 'x' }, tok.s1manager)).status, 404);
  assert.equal((await call('PATCH', '/api/printers/987654', { name: 'x' }, tok.s1manager)).status, 404);
  assert.equal((await call('DELETE', '/api/printers/987654', undefined, tok.s1manager)).status, 404);
});

test('a store cannot hold more than 20 printers', async () => {
  const have = (await call('GET', '/api/printers', undefined, tok.s2manager)).json.length;
  for (let i = have; i < 20; i++) assert.equal((await call('POST', '/api/printers', { ...goodPrinter, name: `P${i}`, bridgeName: `P${i}` }, tok.s2manager)).status, 200);
  assert.equal((await call('POST', '/api/printers', { ...goodPrinter, name: 'one too many' }, tok.s2manager)).status, 409);
});

test('product station: validated on create and update, listed with products', async () => {
  const id = (await call('POST', '/api/products', { name: 'Cocktail', price: 5800, station: 'bar' }, tok.s1manager)).json.productId;
  const row = (await call('GET', '/api/products', undefined, tok.s1waiter)).json.find((p: any) => p.id === id);
  assert.equal(row.station, 'bar');
  assert.equal((await call('PATCH', `/api/products/${id}`, { station: 'kitchen' }, tok.s1manager)).status, 200);
  assert.equal((await call('GET', '/api/products', undefined, tok.s1waiter)).json.find((p: any) => p.id === id).station, 'kitchen');
  assert.equal((await call('PATCH', `/api/products/${id}`, { price: 6000 }, tok.s1manager)).status, 200);
  assert.equal((await call('GET', '/api/products', undefined, tok.s1waiter)).json.find((p: any) => p.id === id).station, 'kitchen');
  for (const station of ['grill', 7, null, {}]) {
    assert.equal((await call('PATCH', `/api/products/${id}`, { station }, tok.s1manager)).status, 422, JSON.stringify(station));
  }
  assert.equal((await call('POST', '/api/products', { name: 'Bad', price: 1, station: 'oven' }, tok.s1manager)).status, 422);
});

test('products default to no station', async () => {
  const seeded = (await call('GET', '/api/products', undefined, tok.s1waiter)).json.find((p: any) => p.name === 'Fruit Platter');
  assert.equal(seeded.station, '');
});

test('copying the catalog also copies the station', async () => {
  const id = (await call('POST', '/api/products', { name: 'Hot Wings', price: 4800, station: 'kitchen' }, tok.s1manager)).json.productId;
  assert.ok(id);
  assert.equal((await call('POST', '/api/hq/catalog/copy', { fromStoreId: 1, toStoreIds: [2] }, tok.owner)).status, 200);
  const copied = await db.one("SELECT station FROM products WHERE store_id = 2 AND name = 'Hot Wings'");
  assert.equal(copied.station, 'kitchen');
  await call('PATCH', `/api/products/${id}`, { station: 'bar' }, tok.s1manager);
  await call('POST', '/api/hq/catalog/copy', { fromStoreId: 1, toStoreIds: [2] }, tok.owner);
  assert.equal((await db.one("SELECT station FROM products WHERE store_id = 2 AND name = 'Hot Wings'")).station, 'bar');
});

test('the page may talk to a local print bridge but nothing else', async () => {
  const res = await fetch(`${base}/`);
  const csp = res.headers.get('content-security-policy') ?? '';
  assert.match(csp, /connect-src 'self' http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\*;/);
  assert.match(csp, /script-src 'self';/);
});
