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

const freeTables = async (n: number) => (await db.all("SELECT id FROM dining_tables WHERE store_id = 1 AND status = 'free' AND min_spend = 0 AND table_fee = 0 ORDER BY id LIMIT ?", [n])).map((r) => r.id as number);
const lineState = (lines: any[]) => lines.map((l) => [l.product_id, l.qty, l.kind, l.status, l.reason ?? null]);
const sync = (who: string, ops: unknown[]) => call('POST', '/api/sync', { ops }, tok[who]);
const tableOf = async (billId: number) => (await db.one('SELECT table_id FROM bills WHERE id = ?', [billId])).table_id;

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

test('a gift and a table move made offline replay to exactly what the till showed', async () => {
  const [from, to] = await freeTables(2);
  await signInAndWarmCache('manager');
  const { billId } = await emulate('POST', '/api/bills', { tableId: from, repId: REP });
  await emulate('POST', `/api/bills/${billId}/lines`, { productId: BEER, qty: 2 });
  await emulate('POST', `/api/bills/${billId}/lines`, { productId: FRUIT, qty: 1, gift: true, reason: 'birthday' });
  await emulate('POST', `/api/bills/${billId}/transfer`, { toTableId: to });
  const local = await emulate('GET', `/api/bills/${billId}`);
  assert.deepEqual([local.bill.table_id, local.totals.subtotal], [to, 5600]);
  await emulate('POST', `/api/bills/${billId}/pay`, { method: 'cash' });

  const { types, results } = await replayQueue('manager');
  assert.deepEqual(types, ['bill.open', 'bill.addLine', 'bill.addLine', 'bill.transfer', 'bill.pay']);
  assert.deepEqual(results.map((r) => [r.status, r.priceDiffFen]), types.map(() => ['ok', undefined]));
  const server_ = (await call('GET', `/api/bills/${results[0].billId}`, undefined, tok.manager)).json;
  assert.deepEqual([lineState(server_.lines), server_.totals, server_.bill.table_id, server_.bill.status], [lineState(local.lines), { ...local.totals, paid: 5600, due: 0 }, to, 'settled']);
});

test('the board shows the old table free and the new one taken while offline', async () => {
  const [from, to] = await freeTables(2);
  await signInAndWarmCache('manager');
  const { billId } = await emulate('POST', '/api/bills', { tableId: from, repId: REP });
  await emulate('POST', `/api/bills/${billId}/transfer`, { toTableId: to });
  const tables = await emulate('GET', '/api/tables');
  const state = (id: number) => { const x = tables.find((tb: any) => tb.id === id); return [x.status, x.bill_id]; };
  assert.deepEqual([state(from), state(to)], [['free', null], ['occupied', billId]]);
});

test('a bill opened before the outage can be moved offline', async () => {
  const [from, to] = await freeTables(2);
  const billId = (await call('POST', '/api/bills', { tableId: from, repId: REP }, tok.manager)).json.billId;
  await signInAndWarmCache('manager');
  await afterNetwork('GET', `/api/bills/${billId}`, (await call('GET', `/api/bills/${billId}`, undefined, tok.manager)).json);
  await emulate('POST', `/api/bills/${billId}/transfer`, { toTableId: to });
  const { results } = await replayQueue('manager');
  assert.deepEqual([results.map((r) => r.status), await tableOf(billId)], [['ok'], to]);
});

test('offline gifts and moves follow the server rules', async () => {
  const [from, other] = await freeTables(2);
  await signInAndWarmCache('manager');
  const { billId } = await emulate('POST', '/api/bills', { tableId: from, repId: REP });
  const taken = await emulate('POST', '/api/bills', { tableId: other, repId: REP });
  await assert.rejects(emulate('POST', `/api/bills/${billId}/lines`, { productId: BEER, qty: 1, gift: true }), { status: 422 });
  await assert.rejects(emulate('POST', `/api/bills/${billId}/transfer`, { toTableId: other }), { status: 409 });
  await assert.rejects(emulate('POST', `/api/bills/${billId}/transfer`, { toTableId: from }), { status: 409 });
  await assert.rejects(emulate('POST', `/api/bills/${billId}/transfer`, { toTableId: 999_999 }), { status: 404 });
  assert.equal((await emulate('GET', `/api/bills/${taken.billId}`)).bill.table_id, other);

  await signInAndWarmCache('waiter');
  const mine = await emulate('POST', '/api/bills', { tableId: (await freeTables(1))[0], repId: REP });
  await assert.rejects(emulate('POST', `/api/bills/${mine.billId}/lines`, { productId: BEER, qty: 1, gift: true, reason: 'x' }), { status: 403 });
});

test('a move to a table taken on the server meanwhile comes back as a conflict and leaves the bill where it was', async () => {
  const [from, to] = await freeTables(2);
  await signInAndWarmCache('manager');
  const { billId } = await emulate('POST', '/api/bills', { tableId: from, repId: REP });
  await emulate('POST', `/api/bills/${billId}/transfer`, { toTableId: to });
  await call('POST', '/api/bills', { tableId: to, repId: REP }, tok.manager);
  const { results } = await replayQueue('manager');
  assert.deepEqual([results.map((r) => r.status), await tableOf(results[0].billId)], [['ok', 'conflict'], from]);
});

test('the server refuses malformed gift and move ops', async () => {
  const giftNoReason = { opId: randomUUID(), type: 'bill.addLine', payload: { billRef: '1', productId: BEER, qty: 1, gift: true } };
  const reasonNoGift = { opId: randomUUID(), type: 'bill.addLine', payload: { billRef: '1', productId: BEER, qty: 1, reason: 'x' } };
  const badTable = { opId: randomUUID(), type: 'bill.transfer', payload: { billRef: '1', toTableId: 'T2' } };
  const statuses = [];
  for (const op of [giftNoReason, reasonNoGift, badTable]) statuses.push((await sync('manager', [op])).status);
  assert.deepEqual(statuses, [422, 422, 422]);
});
