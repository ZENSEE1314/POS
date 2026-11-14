import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
// Browser modules: with no IndexedDB in Node the offline store falls back to memory.
import { emulate, afterNetwork } from '../public/offline/emulator.js';
import { listOps, clearAll } from '../public/offline/store.js';
import { app } from '../public/session.js';

const ADMIN_KEY = 'platform-test-key';
const ENV = { PAY_MODE: 'mock', MOCK_PAY_SECRET: 's3cret', PLATFORM_ADMIN_KEY: ADMIN_KEY } as NodeJS.ProcessEnv;
const PIN = '246810';
const DAY = 86_400_000;
let db: Db;
let server: Server;
let base: string;
const tok: Record<string, string> = {};
const actors: Record<string, any> = {};
const ids: Record<string, number> = {};

async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function company(code: string, businessType: string): Promise<void> {
  const made = await call('POST', '/platform/companies', { name: code, code, storeName: 'Main', ownerName: 'Boss', ownerUsername: 'boss', ownerPin: PIN, businessType });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const r = (await call('POST', '/api/login', { company: code, username: 'boss', pin: PIN })).json;
  tok[code] = r.token;
  actors[code] = r.actor;
}

/** Signs this "browser" in and loads the screens once while online, which fills the offline cache like the real app does. */
async function signInAndWarmCache(who: string): Promise<void> {
  await clearAll();
  const me = (await call('GET', '/api/me', undefined, tok[who])).json;
  Object.assign(app, { token: tok[who], actor: actors[who], business: me.business });
  for (const path of ['/api/tables', '/api/products', '/api/reps', '/api/me', '/api/counter-sales']) {
    await afterNetwork('GET', path, (await call('GET', path, undefined, tok[who])).json);
  }
}

async function replayQueue(who: string) {
  const sent = (await listOps()).filter((o: any) => o.status === 'pending').map((o: any) => ({ opId: o.opId, type: o.type, ...(o.ref ? { ref: o.ref } : {}), ts: o.ts, payload: o.payload }));
  const r = await call('POST', '/api/sync', { ops: sent }, tok[who]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { types: sent.map((o) => o.type), results: r.json.results as any[] };
}

const product = async (token: string, body: Record<string, unknown>) => (await call('POST', '/api/products', body, token)).json.productId as number;
const stockOf = async (id: number) => (await db.one('SELECT stock FROM products WHERE id = ?', [id])).stock;
const strip = (lines: any[]) => lines.map((l) => [l.name, l.qty, l.weight_g ?? null, l.unit_price, l.price_note ?? null]);

function scaleLabel(plu: string, value: number): string {
  const body = `2${plu}${String(value).padStart(5, '0')}`;
  const sum = [...body].reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0);
  return body + String((10 - (sum % 10)) % 10);
}

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await company('grocer', 'retail');
  await company('noodles', 'restaurant');
  await company('pub', 'bar');
  ids.apple = await product(tok.grocer, { name: 'Apple', price: 1200, unit: 'kg', stock: 10_000, barcode: '000123' });
  ids.milk = await product(tok.grocer, { name: 'Milk', price: 650, stock: 20, barcode: '6901234567892', memberPrice: 590 });
  ids.bread = await product(tok.grocer, { name: 'Bread', price: 800, stock: 10, barcode: '6900000000017' });
  ids.noodle = await product(tok.noodles, { name: 'Noodles', price: 2800 });
  const table = await call('POST', '/api/tables', { name: 'T1' }, tok.noodles);
  assert.equal(table.status, 200, JSON.stringify(table.json));
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.close();
});

test('a counter sale rung up offline (scans, weighed item, scale label, member) replays to exactly what the till showed', async () => {
  await signInAndWarmCache('grocer');
  const appleBefore = await stockOf(ids.apple);
  const milkBefore = await stockOf(ids.milk);

  const { billId } = await emulate('POST', '/api/counter-sales', {});
  assert.ok(billId < 0, 'an offline sale gets a temp id');
  assert.deepEqual((await emulate('POST', `/api/bills/${billId}/scan`, { code: '6901234567892', qty: 2 })).productId, ids.milk);
  const weigh = await emulate('POST', `/api/bills/${billId}/scan`, { code: '000123' });
  assert.equal(weigh.needsWeight, true, 'an item sold by weight asks for its weight');
  await emulate('POST', `/api/bills/${billId}/lines`, { productId: ids.apple, qty: 1, weightG: 500 });
  await emulate('POST', `/api/bills/${billId}/scan`, { code: scaleLabel('000123', 1500) });
  await emulate('POST', `/api/bills/${billId}/member`, { phone: '138 0000 7777' });

  const local = await emulate('GET', `/api/bills/${billId}`);
  assert.deepEqual(strip(local.lines), [['Milk', 2, null, 590, 'member'], ['Apple', 1, 500, 600, null], ['Apple', 1, 1250, 1500, 'label']]);
  assert.equal(local.totals.due, 2 * 590 + 600 + 1500);
  const listed = (await emulate('GET', '/api/counter-sales')).find((b: any) => b.id === billId);
  assert.deepEqual([listed.lines, listed.total, listed.memberPhone], [3, 3280, '13800007777']);

  assert.deepEqual(await emulate('POST', `/api/bills/${billId}/pay`, { method: 'cash' }), { settled: true, paid: 3280 });
  const paid = await emulate('GET', `/api/bills/${billId}`);
  assert.ok(!(await emulate('GET', '/api/counter-sales')).some((b: any) => b.id === billId), 'a sale paid offline leaves the open list');

  const { types, results } = await replayQueue('grocer');
  assert.deepEqual(types, ['counter.open', 'bill.addLine', 'bill.addLine', 'bill.scan', 'bill.member', 'bill.pay']);
  assert.deepEqual(results.map((r) => [r.status, r.priceDiffFen]), types.map(() => ['ok', undefined]));
  const server_ = (await call('GET', `/api/bills/${results[0].billId}`, undefined, tok.grocer)).json;
  assert.deepEqual([server_.bill.status, server_.bill.channel, server_.bill.offline], ['settled', 'counter', true]);
  assert.deepEqual(strip(server_.lines), strip(local.lines));
  assert.deepEqual(server_.totals, paid.totals);
  assert.deepEqual([await stockOf(ids.milk), await stockOf(ids.apple)], [milkBefore - 2, appleBefore - 500 - 1250]);
});

test('a counter sale opened online before the outage is carried on offline by its real id', async () => {
  const online = (await call('POST', '/api/counter-sales', {}, tok.grocer)).json.billId;
  await signInAndWarmCache('grocer');
  await afterNetwork('GET', `/api/bills/${online}`, (await call('GET', `/api/bills/${online}`, undefined, tok.grocer)).json);
  await emulate('POST', `/api/bills/${online}/scan`, { code: '6900000000017' });
  assert.equal((await emulate('GET', '/api/counter-sales')).find((b: any) => b.id === online).total, 800);
  await emulate('POST', `/api/bills/${online}/pay`, { method: 'cash' });
  const { results } = await replayQueue('grocer');
  assert.deepEqual(results.map((r) => [r.status, r.billId]), [['ok', online], ['ok', online]]);
});

test('a promotion the till could not see offline is flagged on the payment', async () => {
  const now = Date.now();
  const promo = await call('POST', '/api/promotions', { name: 'Bread day', productId: ids.bread, kind: 'price', value: 500, startsAt: now - DAY, endsAt: now + DAY }, tok.grocer);
  assert.equal(promo.status, 200, JSON.stringify(promo.json));
  await signInAndWarmCache('grocer');
  const { billId } = await emulate('POST', '/api/counter-sales', {});
  await emulate('POST', `/api/bills/${billId}/scan`, { code: '6900000000017' });
  await emulate('POST', `/api/bills/${billId}/pay`, { method: 'cash' });
  const { results } = await replayQueue('grocer');
  assert.equal(results.at(-1).status, 'ok');
  assert.equal(results.at(-1).priceDiffFen, -300, 'the shop collected 3.00 more than the promotion price');
});

test('offline counter sales follow the module switches and the server rules', async () => {
  await signInAndWarmCache('noodles');
  await assert.rejects(emulate('POST', `/api/bills/-1/scan`, { code: '6900000000017' }), { status: 404 });
  await signInAndWarmCache('grocer');
  const { billId } = await emulate('POST', '/api/counter-sales', {});
  await assert.rejects(emulate('POST', `/api/bills/${billId}/lines`, { productId: ids.apple, qty: 2 }), { status: 422 });
  await assert.rejects(emulate('POST', `/api/bills/${billId}/scan`, { code: '9999999999999' }), { status: 404 });
  await emulate('POST', `/api/bills/${billId}/member`, { phone: '13800008888' });
  await assert.rejects(emulate('POST', `/api/bills/${billId}/member`, { phone: '13800009999' }), { status: 409 });
});

test('the server refuses offline counter ops it cannot apply', async () => {
  const counterOpen = { opId: randomUUID(), type: 'counter.open', ref: randomUUID(), payload: {} };
  const r = await call('POST', '/api/sync', { ops: [counterOpen] }, tok.pub);
  assert.deepEqual([r.json.results[0].status, r.json.results[0].code], ['error', 404], 'no counter module, no counter sale');
  const badScan = { opId: randomUUID(), type: 'bill.scan', payload: { billRef: '1', code: 'x'.repeat(40), qty: 1 } };
  assert.equal((await call('POST', '/api/sync', { ops: [badScan] }, tok.grocer)).status, 422);
});

test('without the reps module a table opened offline belongs to whoever opened it', async () => {
  await signInAndWarmCache('noodles');
  const table = (await emulate('GET', '/api/tables'))[0];
  const { billId } = await emulate('POST', '/api/bills', { tableId: table.id });
  await emulate('POST', `/api/bills/${billId}/lines`, { productId: ids.noodle, qty: 1 });
  const { results } = await replayQueue('noodles');
  assert.deepEqual(results.map((r) => r.status), ['ok', 'ok']);
  assert.equal((await db.one('SELECT rep_id FROM bills WHERE id = ?', [results[0].billId])).rep_id, actors.noodles.id);
});
