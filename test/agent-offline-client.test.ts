import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { seed } from '../src/seed.ts';
import { totals } from '../src/bills.ts';
// The browser modules are plain ES modules; with no IndexedDB in Node the store falls back to memory, which is what we want here.
import { computeTotals } from '../public/offline/totals.js';
import { emulate, afterNetwork, isEmulated } from '../public/offline/emulator.js';
import { listOps, clearAll } from '../public/offline/store.js';
import { app } from '../public/session.js';

const ENV = { PAY_MODE: 'mock', MOCK_PAY_SECRET: 's3cret' } as NodeJS.ProcessEnv;
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
  return { status: res.status, json: await res.json() };
}

/** Pretends this browser is signed in as `who` and has seen the floor while online (fills the offline cache like the real app does). */
async function signInAndWarmCache(who: string): Promise<void> {
  await clearAll();
  Object.assign(app, { token: tok[who], actor: actors[who] });
  for (const path of ['/api/tables', '/api/products', '/api/reps', '/api/me']) {
    const data = (await call('GET', path, undefined, tok[who])).json;
    if (path === '/api/me') app.business = data.business;
    await afterNetwork('GET', path, data);
  }
}

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  await seed(db);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  for (const [k, username, pin] of [['cashier', 'flag.cashier', '3333'], ['waiter', 'flag.waiter', '2222'], ['manager', 'flag.manager', '4444']]) {
    const r = (await call('POST', '/api/login', { company: 'doloruu', username, pin })).json;
    tok[k] = r.token;
    actors[k] = r.actor;
  }
});
after(async () => {
  server.close();
  await db.close();
});

// ---- the emulator's arithmetic is the server's arithmetic ----

interface Case { name: string; minSpend: number; fee: number; discount: number; lines: Array<[number, number, string, string]>; payments: Array<[number, string]> }
const CASES: Case[] = [
  { name: 'empty bill, nothing configured', minSpend: 0, fee: 0, discount: 0, lines: [], payments: [] },
  { name: 'spend below the minimum is topped up', minSpend: 200000, fee: 0, discount: 0, lines: [[2, 2800, 'sale', 'active']], payments: [] },
  { name: 'spend above the minimum is not topped up', minSpend: 5000, fee: 0, discount: 0, lines: [[3, 2800, 'sale', 'active']], payments: [] },
  { name: 'spend exactly on the minimum', minSpend: 5600, fee: 0, discount: 0, lines: [[2, 2800, 'sale', 'active']], payments: [] },
  { name: 'table fee is added after the top-up', minSpend: 200000, fee: 20000, discount: 0, lines: [[1, 128800, 'sale', 'active']], payments: [] },
  { name: 'discount reduces the total', minSpend: 0, fee: 0, discount: 1000, lines: [[2, 2800, 'sale', 'active']], payments: [] },
  { name: 'discount larger than the bill clamps at zero', minSpend: 0, fee: 0, discount: 99999, lines: [[1, 2800, 'sale', 'active']], payments: [] },
  { name: 'gift lines are free', minSpend: 0, fee: 0, discount: 0, lines: [[1, 2800, 'sale', 'active'], [5, 128800, 'gift', 'active']], payments: [] },
  { name: 'void lines are excluded', minSpend: 0, fee: 0, discount: 0, lines: [[1, 2800, 'sale', 'active'], [4, 6800, 'sale', 'void']], payments: [] },
  { name: 'void line brings back the min-spend top-up', minSpend: 10000, fee: 0, discount: 0, lines: [[1, 20000, 'sale', 'void']], payments: [] },
  { name: 'part payment leaves a due', minSpend: 0, fee: 500, discount: 0, lines: [[2, 2800, 'sale', 'active']], payments: [[3000, 'paid']] },
  { name: 'pending and failed payments do not count as paid', minSpend: 0, fee: 0, discount: 0, lines: [[1, 2800, 'sale', 'active']], payments: [[2800, 'pending'], [1000, 'failed']] },
  { name: 'fully paid has no due', minSpend: 0, fee: 0, discount: 0, lines: [[1, 2800, 'sale', 'active']], payments: [[1000, 'paid'], [1800, 'paid']] },
];

for (const c of CASES) {
  test(`emulator totals match the server for: ${c.name}`, async () => {
    const tableId = (await db.one("SELECT id FROM dining_tables WHERE store_id = 1 AND status = 'free' ORDER BY id LIMIT 1")).id;
    const billId = await db.insert(
      "INSERT INTO bills (store_id, table_id, rep_id, min_spend, table_fee, discount, opened_at) VALUES (1,?,7,?,?,?,?)", [tableId, c.minSpend, c.fee, c.discount, Date.now()]);
    for (const [qty, price, kind, status] of c.lines) {
      await db.run('INSERT INTO bill_lines (bill_id, product_id, name, qty, unit_price, kind, status, created_at) VALUES (?,3,?,?,?,?,?,?)', [billId, 'Beer', qty, price, kind, status, Date.now()]);
    }
    for (const [amount, status] of c.payments) {
      await db.run("INSERT INTO payments (bill_id, method, amount, status, created_at) VALUES (?,'cash',?,?,?)", [billId, amount, status, Date.now()]);
    }
    const bill = await db.one('SELECT * FROM bills WHERE id = ?', [billId]);
    const lines = await db.all('SELECT * FROM bill_lines WHERE bill_id = ?', [billId]);
    const payments = await db.all('SELECT * FROM payments WHERE bill_id = ?', [billId]);
    assert.deepEqual(computeTotals(bill, lines, payments), await totals(db, billId));
    await db.run("UPDATE bills SET status = 'void' WHERE id = ?", [billId]);
  });
}

// ---- the emulator, driven like the floor drives it, then replayed against the real server ----

test('offline flow on a min-spend table, replayed through /api/sync, ends exactly as the emulator predicted', async () => {
  await signInAndWarmCache('cashier');
  const tablesBefore: any[] = await emulate('GET', '/api/tables');
  const target = tablesBefore.find((x) => x.min_spend === 200000 && x.status === 'free');
  assert.ok(target);

  const { billId } = await emulate('POST', '/api/bills', { tableId: target.id, repId: 7, phone: '13800001111' });
  assert.ok(billId < 0);
  const board: any[] = await emulate('GET', '/api/tables');
  assert.equal(board.find((x) => x.id === target.id).bill_id, billId, 'the table shows occupied by the temp bill');
  assert.equal(board.find((x) => x.id === target.id).status, 'occupied');

  await emulate('POST', `/api/bills/${billId}/lines`, { productId: 3, qty: 2 });
  await emulate('POST', `/api/bills/${billId}/lines`, { productId: 4, qty: 1 });
  const mid = await emulate('GET', `/api/bills/${billId}`);
  assert.equal(mid.totals.subtotal, 2 * 2800 + 18800);
  assert.equal(mid.totals.total, 200000);
  assert.equal(mid.bill.member_phone, '13800001111');

  const part = await emulate('POST', `/api/bills/${billId}/pay`, { method: 'cash', amount: 50000 });
  assert.deepEqual(part, { settled: false, paid: 50000 });
  const rest = await emulate('POST', `/api/bills/${billId}/pay`, { method: 'credit' });
  assert.deepEqual(rest, { settled: true, paid: 150000 });
  const done = await emulate('GET', `/api/bills/${billId}`);
  assert.equal(done.bill.status, 'settled');
  assert.equal(done.totals.due, 0);
  assert.equal((await emulate('GET', '/api/tables')).find((x: any) => x.id === target.id).status, 'free', 'a bill paid offline frees its table locally');
  await assert.rejects(emulate('POST', `/api/bills/${billId}/lines`, { productId: 3, qty: 1 }), { status: 409 });

  const queued = (await listOps()).filter((o: any) => o.status === 'pending');
  assert.deepEqual(queued.map((o: any) => o.type), ['bill.open', 'bill.addLine', 'bill.addLine', 'bill.pay', 'bill.pay']);
  const sent = queued.map((o: any) => ({ opId: o.opId, type: o.type, ...(o.ref ? { ref: o.ref } : {}), ts: o.ts, payload: o.payload }));
  const r = await call('POST', '/api/sync', { ops: sent }, tok.cashier);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.results.map((x: any) => x.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.ok(r.json.results.every((x: any) => x.priceDiffFen === undefined), 'no price drift, so no warning');

  const server_ = (await call('GET', `/api/bills/${r.json.results[0].billId}`, undefined, tok.cashier)).json;
  assert.equal(server_.bill.status, 'settled');
  assert.deepEqual(server_.totals, done.totals);
  assert.equal(server_.lines.length, 2);
  assert.deepEqual(server_.payments.map((p: any) => [p.method, p.amount]), [['cash', 50000], ['credit', 150000]]);
});

test('a table opened online before the outage can be traded offline and replayed by real id', async () => {
  await signInAndWarmCache('cashier');
  const online = (await call('POST', '/api/bills', { tableId: 1, repId: 7 }, tok.cashier)).json.billId;
  await afterNetwork('GET', `/api/bills/${online}`, (await call('GET', `/api/bills/${online}`, undefined, tok.cashier)).json);
  await afterNetwork('GET', '/api/tables', (await call('GET', '/api/tables', undefined, tok.cashier)).json);

  await emulate('POST', `/api/bills/${online}/lines`, { productId: 3, qty: 3 });
  const view = await emulate('GET', `/api/bills/${online}`);
  assert.equal(view.totals.total, 8400);
  assert.deepEqual(await emulate('POST', `/api/bills/${online}/pay`, { method: 'cash', amount: 8400 }), { settled: true, paid: 8400 });
  assert.equal((await emulate('GET', '/api/tables')).find((x: any) => x.id === 1).status, 'free');

  const queued = (await listOps()).filter((o: any) => o.status === 'pending');
  assert.deepEqual(queued.map((o: any) => o.payload.billRef), [String(online), String(online)]);
  const r = await call('POST', '/api/sync', { ops: queued.map((o: any) => ({ opId: o.opId, type: o.type, ts: o.ts, payload: o.payload })) }, tok.cashier);
  assert.deepEqual(r.json.results.map((x: any) => x.status), ['ok', 'ok']);
  assert.equal((await call('GET', `/api/bills/${online}`, undefined, tok.cashier)).json.bill.status, 'settled');
});

test('what cannot work offline says "Needs connection" instead of inventing an answer', async () => {
  await signInAndWarmCache('manager');
  const [bill] = await Promise.all([emulate('POST', '/api/bills', { tableId: 2, repId: 7 })]);
  const id = bill.billId;
  await assert.rejects(emulate('POST', `/api/bills/${id}/pay`, { method: 'member' }), { message: 'Needs connection' });
  await assert.rejects(emulate('POST', '/api/stash/1/retrieve', { billId: id, qtyMilli: 100 }), { message: 'Needs connection' });
  await assert.rejects(emulate('POST', `/api/bills/${id}/pay-online`, { method: 'wechat' }), { message: 'Needs connection' });
  await assert.rejects(emulate('POST', '/api/members/topup', { phone: '1', amount: 1 }), { message: 'Needs connection' });
  await assert.rejects(emulate('GET', '/api/reports/daily?from=0'), { message: 'Needs connection' });
  await assert.rejects(emulate('GET', '/api/tables?all=1'), { message: 'Needs connection' });
  assert.equal(isEmulated('POST', '/api/login'), false);
  assert.equal(isEmulated('GET', '/api/bills/5'), true);
});

test('offline validation and permissions mirror the server', async () => {
  await signInAndWarmCache('waiter');
  const { billId } = await emulate('POST', '/api/bills', { tableId: 3, repId: 7 });
  await assert.rejects(emulate('POST', `/api/bills/${billId}/pay`, { method: 'cash' }), { status: 403, message: 'role waiter may not bill.settle' });
  await assert.rejects(emulate('POST', `/api/bills/${billId}/lines`, { productId: 3, qty: 0 }), { status: 422 });
  await assert.rejects(emulate('POST', `/api/bills/${billId}/lines`, { productId: 999, qty: 1 }), { status: 404, message: 'product not found' });
  await assert.rejects(emulate('POST', '/api/bills', { tableId: 3, repId: 7 }), { status: 409, message: 'table already occupied' });
  await assert.rejects(emulate('POST', '/api/bills', { tableId: 4 }), { status: 422 });
  await assert.rejects(emulate('POST', '/api/bills', { tableId: 4, repId: 99999 }), { status: 422, message: 'sales rep not found in this store' });
  await assert.rejects(emulate('GET', '/api/bills/-777'), { status: 404 });
});

test('caches are keyed by store: another store never sees this store\'s tables', async () => {
  await signInAndWarmCache('cashier');
  assert.ok((await emulate('GET', '/api/tables')).length > 0);
  app.actor = { ...actors.cashier, storeId: 2 };
  await assert.rejects(emulate('GET', '/api/tables'), { message: 'Needs connection' });
  await assert.rejects(emulate('GET', '/api/products'), { message: 'Needs connection' });
  app.actor = actors.cashier;
});

test('clearing the device wipes cached data and the queue', async () => {
  await signInAndWarmCache('cashier');
  await emulate('POST', '/api/bills', { tableId: 5, repId: 7 });
  assert.ok((await listOps()).length > 0);
  await clearAll();
  assert.equal((await listOps()).length, 0);
  await assert.rejects(emulate('GET', '/api/tables'), { message: 'Needs connection' });
});
