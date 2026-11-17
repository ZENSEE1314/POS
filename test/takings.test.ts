import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { seed, DEMO_PINS } from '../src/seed.ts';

const ENV = { PAY_MODE: 'mock', MOCK_PAY_SECRET: 's3cret' } as NodeJS.ProcessEnv;
let db: Db;
let server: Server;
let base: string;
const staff: Record<string, string> = {};
const tableId: Record<string, number> = {};
const id: Record<string, number> = {};
let product: { id: number; price: number };

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const login = async (username: string, pin: string) => (await call('POST', '/api/login', { company: 'doloruu', username, pin })).json.token;
const open = async (table: string) => (await call('POST', '/api/bills', { tableId: tableId[table], repId: id.rep }, staff.manager)).json.billId;
const comp = (billId: number, qty = 1) => call('POST', `/api/bills/${billId}/lines`, { productId: product.id, qty, gift: true, reason: 'regular guest' }, staff.waiter);

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  await seed(db);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  staff.manager = await login('flag.manager', DEMO_PINS.manager);
  staff.waiter = await login('flag.waiter', DEMO_PINS.waiter);
  staff.cashier = await login('flag.cashier', DEMO_PINS.cashier);
  for (const tb of (await call('GET', '/api/tables', undefined, staff.manager)).json) tableId[tb.name] = Number(tb.id);
  const people = (await call('GET', '/api/staff', undefined, staff.manager)).json;
  id.waiter = people.find((s: any) => s.username === 'flag.waiter').id;
  id.rep = people.find((s: any) => s.username === 'flag.rep').id;
  product = (await call('GET', '/api/products', undefined, staff.manager)).json.find((p: any) => p.price > 0 && p.unit !== 'kg');
});
after(async () => {
  server.close();
  await db.close();
});

// ---------- comps ----------

test('a waiter without a comp allowance cannot comp a drink', async () => {
  assert.equal((await comp(await open('A1'))).status, 403);
});

test('a waiter can comp drinks within their monthly allowance', async () => {
  await call('PUT', `/api/comps/${id.waiter}`, { allowance: product.price * 2 }, staff.manager);
  assert.equal((await comp(await open('A2'), 2)).status, 200);
});

test('a comp beyond what is left of the allowance is refused', async () => {
  assert.equal((await comp(await open('A3'))).status, 403);
});

test('the waiter sees how much allowance they used this month', async () => {
  const me = (await call('GET', '/api/comps/me', undefined, staff.waiter)).json;
  assert.deepEqual([me.used, me.left], [product.price * 2, 0]);
});

// ---------- tips ----------

test('a tip given to a waiter shows in the tips list with the table', async () => {
  await open('A4');
  await call('POST', '/api/tips', { employeeId: id.waiter, amount: 20000, method: 'wechat', tableId: tableId.A4 }, staff.cashier);
  const tips = (await call('GET', '/api/tips', undefined, staff.manager)).json;
  assert.ok(tips.some((x: any) => x.employeeId === id.waiter && x.amount === 20000 && x.tableName === 'A4'));
});

test('a tip of zero is a 422', async () => {
  assert.equal((await call('POST', '/api/tips', { employeeId: id.waiter, amount: 0 }, staff.cashier)).status, 422);
});

// ---------- deposits ----------

test('a deposit put toward a bill pays the bill', async () => {
  const billId = await open('VIP1');
  await call('POST', `/api/bills/${billId}/lines`, { productId: product.id, qty: 1 }, staff.waiter);
  const bill = (await call('GET', `/api/bills/${billId}`, undefined, staff.manager)).json;
  const dep = (await call('POST', '/api/deposits', { name: 'Mr Zhang', phone: '13900002222', amount: bill.totals.total + 50000, method: 'wechat', tableId: tableId.VIP1 }, staff.manager)).json.id;
  const r = (await call('POST', `/api/deposits/${dep}/apply`, {}, staff.cashier)).json;
  assert.deepEqual([r.applied, r.settled], [bill.totals.total, true]);
});

test('what is left of a deposit after the bill stays held for the guest', async () => {
  const held = (await call('GET', '/api/deposits', undefined, staff.manager)).json;
  assert.ok(held.some((d: any) => d.name === 'Mr Zhang' && d.amount === 50000 && d.status === 'held'));
});

test('handing a deposit back needs a reason', async () => {
  const dep = (await call('GET', '/api/deposits', undefined, staff.manager)).json.find((d: any) => d.name === 'Mr Zhang');
  assert.equal((await call('POST', `/api/deposits/${dep.id}/refund`, {}, staff.cashier)).status, 422);
});

test('a handed-back deposit leaves the held list', async () => {
  const dep = (await call('GET', '/api/deposits', undefined, staff.manager)).json.find((d: any) => d.name === 'Mr Zhang');
  await call('POST', `/api/deposits/${dep.id}/refund`, { reason: 'guest cancelled' }, staff.cashier);
  assert.ok(!(await call('GET', '/api/deposits', undefined, staff.manager)).json.some((d: any) => d.id === dep.id));
});

test('a deposit with no open bill on its table cannot be applied', async () => {
  const dep = (await call('POST', '/api/deposits', { name: 'Ms Lin', amount: 10000, method: 'cash', tableId: tableId.B6 }, staff.manager)).json.id;
  assert.equal((await call('POST', `/api/deposits/${dep}/apply`, {}, staff.cashier)).status, 409);
});

// ---------- workbench and performance ----------

test('the sales rep sees their settled sales for today on the workbench', async () => {
  const rep = await login('flag.rep', DEMO_PINS.rep);
  const today = (await call('GET', '/api/me/today', undefined, rep)).json;
  assert.ok(today.sales >= product.price && today.tables >= 1);
});

test('the waiter sees the tips they got today', async () => {
  assert.equal((await call('GET', '/api/me/today', undefined, staff.waiter)).json.tips, 20000);
});

test('performance ranks the sales rep by sales', async () => {
  const p = (await call('GET', '/api/performance', undefined, staff.manager)).json;
  assert.equal(p.staff[0].employeeId, id.rep);
});

test('performance adds up per department', async () => {
  const p = (await call('GET', '/api/performance', undefined, staff.manager)).json;
  assert.equal(p.departments.reduce((a: number, d: any) => a + d.sales, 0), p.total.sales);
});

test('a waiter cannot see everyone\'s performance', async () => {
  assert.equal((await call('GET', '/api/performance', undefined, staff.waiter)).status, 403);
});
