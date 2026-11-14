import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { seed } from '../src/seed.ts';
// Browser modules: with no IndexedDB in Node the offline store falls back to memory.
import { emulate, afterNetwork } from '../public/offline/emulator.js';
import { listOps, clearAll } from '../public/offline/store.js';
import { app } from '../public/session.js';

const ENV = { PAY_MODE: 'mock', MOCK_PAY_SECRET: 's3cret' } as NodeJS.ProcessEnv;
const BEER = 3;
const FRUIT = 4;
const REP = 7;
let db: Db;
let server: Server;
let base: string;
const tok: Record<string, string> = {};
const actors: Record<string, any> = {};

async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Signs this "browser" in and loads the floor once while online, which fills the offline cache like the real app does. */
async function signInAndWarmCache(who: string): Promise<void> {
  await clearAll();
  Object.assign(app, { token: tok[who], actor: actors[who] });
  for (const path of ['/api/tables', '/api/products', '/api/reps', '/api/me']) {
    const data = (await call('GET', path, undefined, tok[who])).json;
    if (path === '/api/me') app.business = data.business;
    await afterNetwork('GET', path, data);
  }
}

async function replayQueue(who: string) {
  const sent = (await listOps()).filter((o: any) => o.status === 'pending').map((o: any) => ({ opId: o.opId, type: o.type, ...(o.ref ? { ref: o.ref } : {}), ts: o.ts, payload: o.payload }));
  const r = await call('POST', '/api/sync', { ops: sent }, tok[who]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { types: sent.map((o) => o.type), results: r.json.results as any[] };
}

const freeTable = async () => (await db.one("SELECT id FROM dining_tables WHERE store_id = 1 AND status = 'free' AND min_spend = 0 AND table_fee = 0 ORDER BY id LIMIT 1")).id as number;
const lineState = (lines: any[]) => lines.map((l) => [l.product_id, l.qty, l.status, l.reason ?? null]);
const sync = (who: string, ops: unknown[]) => call('POST', '/api/sync', { ops }, tok[who]);

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  await seed(db);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const [k, username, pin] of [['manager', 'flag.manager', '4444'], ['waiter', 'flag.waiter', '2222']]) {
    const r = (await call('POST', '/api/login', { company: 'doloruu', username, pin })).json;
    tok[k] = r.token;
    actors[k] = r.actor;
  }
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.close();
});

test('a void and a discount made offline replay to exactly what the till showed', async () => {
  await signInAndWarmCache('manager');
  const { billId } = await emulate('POST', '/api/bills', { tableId: await freeTable(), repId: REP });
  await emulate('POST', `/api/bills/${billId}/lines`, { productId: BEER, qty: 2 });
  const { lineId: fruitLine } = await emulate('POST', `/api/bills/${billId}/lines`, { productId: FRUIT, qty: 1 });
  await emulate('POST', `/api/bills/${billId}/lines/${fruitLine}/void`, { reason: 'wrong item' });
  await emulate('POST', `/api/bills/${billId}/discount`, { amount: 600, reason: 'regular guest' });
  const local = await emulate('GET', `/api/bills/${billId}`);
  assert.deepEqual([local.totals.subtotal, local.totals.discount, local.totals.due], [5600, 600, 5000]);
  await emulate('POST', `/api/bills/${billId}/pay`, { method: 'cash' });
  const paid = await emulate('GET', `/api/bills/${billId}`);

  const { types, results } = await replayQueue('manager');
  assert.deepEqual(types, ['bill.open', 'bill.addLine', 'bill.addLine', 'bill.void', 'bill.discount', 'bill.pay']);
  assert.deepEqual(results.map((r) => [r.status, r.priceDiffFen]), types.map(() => ['ok', undefined]));
  const server_ = (await call('GET', `/api/bills/${results[0].billId}`, undefined, tok.manager)).json;
  assert.deepEqual(lineState(server_.lines), lineState(paid.lines));
  assert.deepEqual(server_.totals, paid.totals);
  assert.equal(server_.bill.status, 'settled');
});

test('a line of a bill opened before the outage can be voided offline by its real id', async () => {
  const tableId = await freeTable();
  const billId = (await call('POST', '/api/bills', { tableId, repId: REP }, tok.manager)).json.billId;
  const lineId = (await call('POST', `/api/bills/${billId}/lines`, { productId: BEER, qty: 1 }, tok.manager)).json.lineId;
  await signInAndWarmCache('manager');
  await afterNetwork('GET', `/api/bills/${billId}`, (await call('GET', `/api/bills/${billId}`, undefined, tok.manager)).json);
  await emulate('POST', `/api/bills/${billId}/lines/${lineId}/void`, { reason: 'sent back' });
  const { results } = await replayQueue('manager');
  assert.deepEqual(results.map((r) => r.status), ['ok']);
  assert.equal((await db.one('SELECT status FROM bill_lines WHERE id = ?', [lineId])).status, 'void');
});

test('a void that lands exactly on what was paid completes the bill, offline and on the server', async () => {
  await signInAndWarmCache('manager');
  const { billId } = await emulate('POST', '/api/bills', { tableId: await freeTable(), repId: REP });
  await emulate('POST', `/api/bills/${billId}/lines`, { productId: BEER, qty: 1 });
  const { lineId } = await emulate('POST', `/api/bills/${billId}/lines`, { productId: FRUIT, qty: 1 });
  await emulate('POST', `/api/bills/${billId}/pay`, { method: 'cash', amount: 2800 });
  await emulate('POST', `/api/bills/${billId}/lines/${lineId}/void`, { reason: 'out of stock' });
  assert.equal((await emulate('GET', `/api/bills/${billId}`)).bill.status, 'settled');
  const { results } = await replayQueue('manager');
  assert.ok(results.every((r) => r.status === 'ok'));
  assert.equal((await db.one('SELECT status FROM bills WHERE id = ?', [results[0].billId])).status, 'settled');
});

test('offline voids and discounts follow the server rules', async () => {
  await signInAndWarmCache('manager');
  const { billId } = await emulate('POST', '/api/bills', { tableId: await freeTable(), repId: REP });
  const { lineId } = await emulate('POST', `/api/bills/${billId}/lines`, { productId: BEER, qty: 2 });
  await assert.rejects(emulate('POST', `/api/bills/${billId}/lines/${lineId}/void`, {}), { status: 422 });
  await assert.rejects(emulate('POST', `/api/bills/${billId}/discount`, { amount: -1, reason: 'x' }), { status: 422 });
  await emulate('POST', `/api/bills/${billId}/pay`, { method: 'cash', amount: 5000 });
  await assert.rejects(emulate('POST', `/api/bills/${billId}/discount`, { amount: 1000, reason: 'too late' }), { status: 409 });
  await assert.rejects(emulate('POST', `/api/bills/${billId}/lines/-99/void`, { reason: 'x' }), { status: 404 });
  assert.equal((await emulate('GET', `/api/bills/${billId}`)).totals.discount, 0, 'a refused discount changes nothing');

  await signInAndWarmCache('waiter');
  const mine = await emulate('POST', '/api/bills', { tableId: await freeTable(), repId: REP });
  const line = await emulate('POST', `/api/bills/${mine.billId}/lines`, { productId: BEER, qty: 1 });
  await assert.rejects(emulate('POST', `/api/bills/${mine.billId}/lines/${line.lineId}/void`, { reason: 'x' }), { status: 403 });
  await assert.rejects(emulate('POST', `/api/bills/${mine.billId}/discount`, { amount: 100, reason: 'x' }), { status: 403 });
});

test('a void whose item never reached the server is skipped, not applied to another line', async () => {
  const tableId = await freeTable();
  const billId = (await call('POST', '/api/bills', { tableId, repId: REP }, tok.manager)).json.billId;
  const lineRef = randomUUID();
  const r = await sync('manager', [
    { opId: randomUUID(), type: 'bill.addLine', payload: { billRef: String(billId), productId: 999_999, qty: 1, lineRef } },
    { opId: randomUUID(), type: 'bill.void', payload: { billRef: String(billId), lineRef, reason: 'x' } },
  ]);
  assert.deepEqual(r.json.results.map((x: any) => x.status), ['conflict', 'skipped']);
});

test('the server refuses malformed void and discount ops', async () => {
  const both = { opId: randomUUID(), type: 'bill.void', payload: { billRef: '1', lineRef: randomUUID(), lineId: 5, reason: 'x' } };
  const noReason = { opId: randomUUID(), type: 'bill.discount', payload: { billRef: '1', amount: 100, reason: ' ' } };
  assert.equal((await sync('manager', [both])).status, 422);
  assert.equal((await sync('manager', [noReason])).status, 422);
});
