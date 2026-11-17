import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { seed, DEMO_PINS } from '../src/seed.ts';

const ENV = { PAY_MODE: 'mock', MOCK_PAY_SECRET: 's3cret' } as NodeJS.ProcessEnv;
const HOUR = 3_600_000;
let db: Db;
let server: Server;
let base: string;
const staff: Record<string, string> = {};
const tableId: Record<string, number> = {};
let repId: number;

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const login = async (username: string, pin: string) => (await call('POST', '/api/login', { company: 'doloruu', username, pin })).json.token;
const desk = async () => (await call('GET', '/api/host-desk', undefined, staff.host)).json;
const tableOn = async (name: string) => (await desk()).tables.find((x: any) => x.name === name);

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  await seed(db);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  staff.host = await login('flag.host', DEMO_PINS.host);
  staff.waiter = await login('flag.waiter', DEMO_PINS.waiter);
  staff.manager = await login('flag.manager', DEMO_PINS.manager);
  for (const tb of (await call('GET', '/api/tables', undefined, staff.manager)).json) tableId[tb.name] = Number(tb.id);
  repId = (await call('GET', '/api/reps', undefined, staff.manager)).json.find((r: any) => r.name === 'Sales FLAG').id;
  const products = (await call('GET', '/api/products', undefined, staff.manager)).json;
  const billId = (await call('POST', '/api/bills', { tableId: tableId.B1, repId, phone: '13512345678' }, staff.host)).json.billId;
  await call('POST', `/api/bills/${billId}/lines`, { productId: products[0].id, qty: 1 }, staff.waiter);
});
after(async () => {
  server.close();
  await db.close();
});

test('an open table shows its sales rep', async () => {
  assert.equal((await tableOn('B1')).bill.repName, 'Sales FLAG');
});

test('an open table shows how much is still short of the minimum spend', async () => {
  const b1 = await tableOn('B1');
  assert.equal(b1.bill.shortfall, b1.minSpend - b1.bill.spent);
});

test('the guest phone on the host desk is masked', async () => {
  assert.equal((await tableOn('B1')).bill.guestPhone, '135****5678');
});

test('a free table with a booking tonight shows as booked', async () => {
  const { bookingId } = (await call('POST', '/api/bookings', { phone: '13600001111', name: 'Mr Zhang', partySize: 4, eta: Date.now() + 2 * HOUR, repId }, staff.host)).json;
  await db.run('UPDATE bookings SET table_id = ? WHERE id = ?', [tableId.B2, bookingId]);
  assert.equal((await tableOn('B2')).state, 'booked');
});

test('a held table cannot be opened', async () => {
  await call('POST', `/api/tables/${tableId.B3}/lock`, { locked: true, note: 'Mr Li 10pm' }, staff.host);
  assert.equal((await call('POST', '/api/bills', { tableId: tableId.B3, repId }, staff.host)).status, 409);
});

test('a held table shows who it is held for', async () => {
  assert.deepEqual([(await tableOn('B3')).state, (await tableOn('B3')).lock.note], ['locked', 'Mr Li 10pm']);
});

test('a released table can be opened again', async () => {
  await call('POST', `/api/tables/${tableId.B4}/lock`, { locked: true }, staff.host);
  await call('POST', `/api/tables/${tableId.B4}/lock`, { locked: false }, staff.host);
  assert.equal((await call('POST', '/api/bills', { tableId: tableId.B4, repId }, staff.host)).status, 200);
});

test('the guest booked for a held table can be seated there', async () => {
  const { bookingId } = (await call('POST', '/api/bookings', { phone: '13600002222', name: 'Ms Wu', partySize: 2, eta: Date.now() + HOUR, repId }, staff.host)).json;
  await db.run('UPDATE bookings SET table_id = ?, status = ? WHERE id = ?', [tableId.B5, 'confirmed', bookingId]);
  await call('POST', `/api/tables/${tableId.B5}/lock`, { locked: true, note: 'Ms Wu' }, staff.host);
  assert.equal((await call('POST', '/api/bills', { tableId: tableId.B5, bookingId }, staff.host)).status, 200);
});

test('a table in use cannot be held', async () => {
  assert.equal((await call('POST', `/api/tables/${tableId.B1}/lock`, { locked: true }, staff.host)).status, 409);
});

test('a waiter cannot hold a table', async () => {
  assert.equal((await call('POST', `/api/tables/${tableId.A6}/lock`, { locked: true }, staff.waiter)).status, 403);
});
