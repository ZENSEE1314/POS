import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { seed } from '../src/seed.ts';
import { MAX_SYNC_OPS } from '../src/sync.ts';

const ENV = { PAY_MODE: 'mock', MOCK_PAY_SECRET: 's3cret', PLATFORM_ADMIN_KEY: 'admin-key' } as NodeJS.ProcessEnv;
let db: Db;
let server: Server;
let base: string;
const tok: Record<string, string> = {};

async function call(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const sync = (token: string, ops: unknown[]) => call('POST', '/api/sync', { ops }, token);
const open = (ref: string, tableId: number, repId: number, extra: object = {}, opId = randomUUID()) => ({ opId, type: 'bill.open', ref, ts: Date.now(), payload: { tableId, repId, ...extra } });
const line = (billRef: string, productId: number, qty: number, opId = randomUUID()) => ({ opId, type: 'bill.addLine', payload: { billRef, productId, qty } });
const pay = (billRef: string, amount: number, method = 'cash', expectedDue?: number, opId = randomUUID()) =>
  ({ opId, type: 'bill.pay', payload: { billRef, method, amount, ...(expectedDue === undefined ? {} : { expectedDue }) } });

const table = (id: number) => db.one('SELECT * FROM dining_tables WHERE id = ?', [id]);
const bill = (id: number) => db.one('SELECT * FROM bills WHERE id = ?', [id]);
const stock = async (productId: number) => (await db.one('SELECT stock FROM products WHERE id = ?', [productId])).stock;
const count = async (sql: string, params: unknown[] = []) => (await db.one(sql, params)).n as number;

// Seeded ids: 1 owner, 2 finance, store 1 staff 3 host, 4 waiter, 5 cashier, 6 manager, 7 sales rep; store 2 staff 8-12.
// Store 1 tables 1-14 (A1-A6 = 1-6 free of min spend, B1 = 7 min 2000.00); store 2 tables 15-28. Store 1 products 1-5 (3 = beer 28.00, 4 = fruit 188.00, 5 = mixer 68.00).
before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  await seed(db);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const staff: Record<string, [string, string]> = {
    s1host: ['flag.host', '1111'], s1waiter: ['flag.waiter', '2222'], s1cashier: ['flag.cashier', '3333'], s1manager: ['flag.manager', '4444'],
    s2cashier: ['lnge.cashier', '3333'],
  };
  for (const [k, [username, pin]] of Object.entries(staff)) tok[k] = (await call('POST', '/api/login', { company: 'doloruu', username, pin })).json.token;
});
after(async () => {
  server.close();
  await db.close();
});

test('happy path: open + lines + cash pay settles the bill, frees the table, moves stock, writes commission and flags offline', async () => {
  const ref = randomUUID();
  const before = await stock(3);
  const r = await sync(tok.s1cashier, [open(ref, 1, 7, { phone: '13800000001' }), line(ref, 3, 2), pay(ref, 5600, 'cash', 5600)]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.results.map((x: any) => x.status), ['ok', 'ok', 'ok']);
  const billId = r.json.results[0].billId;
  assert.equal(r.json.results[2].settled, true);
  assert.equal(r.json.results[2].paid, 5600);
  assert.equal((await bill(billId)).status, 'settled');
  assert.equal((await bill(billId)).offline, true);
  assert.equal((await table(1)).status, 'free');
  assert.equal(await stock(3), before - 2);
  const commission = await count('SELECT COUNT(*) AS n FROM commission_entries WHERE bill_id = ?', [billId]);
  assert.ok(commission >= 1);
  const pays = await db.all('SELECT * FROM payments WHERE bill_id = ?', [billId]);
  assert.deepEqual(pays.map((p: any) => [p.method, p.amount, p.offline]), [['cash', 5600, true]]);
  const trail = await db.all("SELECT action, detail FROM audit WHERE action LIKE 'sync.%' AND entity_id = ? ORDER BY id", [billId]);
  assert.deepEqual(trail.map((a: any) => a.action), ['sync.bill.open', 'sync.bill.addLine', 'sync.bill.pay']);
  assert.ok(trail.every((a: any) => JSON.parse(a.detail).offline === true));
  assert.equal(typeof JSON.parse(trail[0].detail).clientTs, 'number');
  assert.ok((await db.all("SELECT 1 FROM audit WHERE action IN ('table.open','pay.cash','bill.settle') AND entity_id = ?", [billId])).length >= 3, 'domain audit entries are still written');
});

test('replaying a batch is idempotent: same results, nothing duplicated', async () => {
  const ref = randomUUID();
  const batch = [open(ref, 2, 7), line(ref, 3, 1), pay(ref, 2800, 'cash', 2800)];
  const first = await sync(tok.s1cashier, batch);
  const bills = await count('SELECT COUNT(*) AS n FROM bills');
  const payments = await count('SELECT COUNT(*) AS n FROM payments');
  const lines = await count('SELECT COUNT(*) AS n FROM bill_lines');
  const stockNow = await stock(3);
  const second = await sync(tok.s1cashier, batch);
  assert.deepEqual(second.json.results.map((x: any) => x.status), ['ok', 'ok', 'ok']);
  assert.ok(second.json.results.every((x: any) => x.replayed === true));
  assert.equal(second.json.results[0].billId, first.json.results[0].billId);
  assert.deepEqual([await count('SELECT COUNT(*) AS n FROM bills'), await count('SELECT COUNT(*) AS n FROM payments'), await count('SELECT COUNT(*) AS n FROM bill_lines'), await stock(3)], [bills, payments, lines, stockNow]);
});

test('the same batch sent twice concurrently is applied exactly once', async () => {
  const ref = randomUUID();
  const batch = [open(ref, 3, 7), line(ref, 3, 1), pay(ref, 2800, 'cash', 2800)];
  const before = await count('SELECT COUNT(*) AS n FROM bills');
  const [a, b] = await Promise.all([sync(tok.s1cashier, batch), sync(tok.s1cashier, batch)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.deepEqual(a.json.results.map((x: any) => x.status), ['ok', 'ok', 'ok']);
  assert.deepEqual(b.json.results.map((x: any) => x.status), ['ok', 'ok', 'ok']);
  assert.equal(a.json.results[0].billId, b.json.results[0].billId);
  assert.equal(await count('SELECT COUNT(*) AS n FROM bills'), before + 1);
  assert.equal(await count('SELECT COUNT(*) AS n FROM payments WHERE bill_id = ?', [a.json.results[0].billId]), 1);
  assert.equal(await count('SELECT COUNT(*) AS n FROM bill_lines WHERE bill_id = ?', [a.json.results[0].billId]), 1);
});

test('one failed op does not abort the batch; dependents of a failed bill-open are skipped', async () => {
  const bad = randomUUID();
  const good = randomUUID();
  const r = await sync(tok.s1cashier, [open(bad, 4, 99999), line(bad, 3, 1), pay(bad, 2800), open(good, 5, 7), line(good, 3, 1)]);
  assert.deepEqual(r.json.results.map((x: any) => x.status), ['conflict', 'skipped', 'skipped', 'ok', 'ok']);
  assert.match(r.json.results[0].message, /sales rep not found/);
  assert.equal((await table(4)).status, 'free');
  assert.equal((await table(5)).status, 'occupied');
  assert.equal(await count('SELECT COUNT(*) AS n FROM sync_refs WHERE client_ref = ?', [bad]), 0);
  await call('POST', `/api/bills/${r.json.results[3].billId}/pay`, { method: 'cash' }, tok.s1cashier);
});

test('a table taken online meanwhile is a conflict and the offline lines are NOT attached to the other bill', async () => {
  const online = (await call('POST', '/api/bills', { tableId: 6, repId: 7 }, tok.s1host)).json.billId;
  const ref = randomUUID();
  const r = await sync(tok.s1cashier, [open(ref, 6, 7), line(ref, 3, 3), pay(ref, 8400)]);
  assert.deepEqual(r.json.results.map((x: any) => x.status), ['conflict', 'skipped', 'skipped']);
  assert.match(r.json.results[0].message, /already occupied/);
  assert.equal(await count('SELECT COUNT(*) AS n FROM bill_lines WHERE bill_id = ?', [online]), 0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM payments WHERE bill_id = ?', [online]), 0);
  await call('POST', `/api/bills/${online}/pay`, { method: 'cash' }, tok.s1cashier);
});

test('price changed while offline: the cashier collection is applied against the current price and flagged with priceDiffFen', async () => {
  await db.run('UPDATE products SET price = 3000 WHERE id = 3'); // the cashier collected 28.00 offline
  const dear = randomUUID();
  const up = await sync(tok.s1cashier, [open(dear, 1, 7), line(dear, 3, 1), pay(dear, 2800, 'cash', 2800)]);
  assert.deepEqual(up.json.results.map((x: any) => x.status), ['ok', 'ok', 'ok']);
  assert.equal(up.json.results[2].priceDiffFen, 200);
  assert.equal(up.json.results[2].paid, 2800);
  assert.equal(up.json.results[2].settled, false);
  assert.match(up.json.results[2].message, /prices changed/);
  assert.equal((await bill(up.json.results[0].billId)).status, 'open');
  await call('POST', `/api/bills/${up.json.results[0].billId}/pay`, { method: 'cash' }, tok.s1cashier);

  await db.run('UPDATE products SET price = 2000 WHERE id = 3');
  const cheap = randomUUID();
  const down = await sync(tok.s1cashier, [open(cheap, 1, 7), line(cheap, 3, 1), pay(cheap, 2800, 'cash', 2800)]);
  assert.equal(down.json.results[2].priceDiffFen, -800);
  assert.equal(down.json.results[2].paid, 2000);
  assert.equal(down.json.results[2].settled, true);

  await db.run('UPDATE products SET price = 2800 WHERE id = 3');
  const same = randomUUID();
  const none = await sync(tok.s1cashier, [open(same, 1, 7), line(same, 3, 1), pay(same, 2800, 'cash', 2800)]);
  assert.equal(none.json.results[2].priceDiffFen, undefined);
});

test('inactive product and inactive rep are conflicts, not crashes', async () => {
  await db.run('UPDATE products SET active = FALSE WHERE id = 5');
  const ref = randomUUID();
  const a = await sync(tok.s1cashier, [open(ref, 9, 7), line(ref, 5, 1)]);
  assert.deepEqual(a.json.results.map((x: any) => x.status), ['ok', 'conflict']);
  assert.match(a.json.results[1].message, /product not found/);
  await db.run('UPDATE products SET active = TRUE WHERE id = 5');
  await call('POST', `/api/bills/${a.json.results[0].billId}/pay`, { method: 'cash' }, tok.s1cashier);

  await db.run('UPDATE employees SET active = FALSE WHERE id = 7');
  const ref2 = randomUUID();
  const b = await sync(tok.s1cashier, [open(ref2, 10, 7), line(ref2, 3, 1)]);
  await db.run('UPDATE employees SET active = TRUE WHERE id = 7');
  assert.deepEqual(b.json.results.map((x: any) => x.status), ['conflict', 'skipped']);
  assert.match(b.json.results[0].message, /sales rep not found/);
  assert.equal((await table(10)).status, 'free');
});

test('malformed ops are rejected with 4xx and change nothing', async () => {
  const ref = randomUUID();
  const ok = open(ref, 11, 7);
  const cases: Array<[string, unknown]> = [
    ['ops not an array', { ops: 'x' }],
    ['no ops key', {}],
    ['unknown top-level key', { ops: [], extra: 1 }],
    ['bad opId', { ops: [{ ...ok, opId: 'not-a-uuid' }] }],
    ['unknown type', { ops: [{ ...ok, type: 'bill.void' }] }],
    ['missing ref', { ops: [{ ...ok, ref: undefined }] }],
    ['positive int as new ref', { ops: [{ ...ok, ref: '12' }] }],
    ['op not an object', { ops: [5] }],
    ['payload array', { ops: [{ ...ok, payload: [] }] }],
    ['tableId string', { ops: [open(ref, '11' as any, 7)] }],
    ['tableId float', { ops: [open(ref, 1.5, 7)] }],
    ['repId missing', { ops: [{ ...ok, payload: { tableId: 11 } }] }],
    ['unexpected payload field', { ops: [open(ref, 11, 7, { gift: true })] }],
    ['qty zero', { ops: [line(ref, 3, 0)] }],
    ['qty float', { ops: [line(ref, 3, 1.5)] }],
    ['qty too big', { ops: [line(ref, 3, 10000)] }],
    ['bad billRef', { ops: [line('abc', 3, 1)] }],
    ['billRef positive-looking uuid', { ops: [line('12; DROP', 3, 1)] }],
    ['method member', { ops: [pay(ref, 100, 'member')] }],
    ['method wechat', { ops: [pay(ref, 100, 'wechat')] }],
    ['negative amount', { ops: [pay(ref, -5)] }],
    ['amount string', { ops: [pay(ref, '5' as any)] }],
    ['amount huge', { ops: [pay(ref, 1e15)] }],
    ['ref on addLine', { ops: [{ ...line(ref, 3, 1), ref }] }],
    ['ts negative', { ops: [{ ...ok, ts: -1 }] }],
  ];
  const before = await count('SELECT COUNT(*) AS n FROM sync_ops');
  for (const [name, body] of cases) {
    const r = await call('POST', '/api/sync', body, tok.s1cashier);
    assert.ok(r.status >= 400 && r.status < 500, `${name}: expected 4xx, got ${r.status}`);
  }
  assert.equal((await call('POST', '/api/sync', '{not json', tok.s1cashier)).status, 400);
  assert.equal((await call('POST', '/api/sync', '[]', tok.s1cashier)).status, 400);
  assert.equal((await call('POST', '/api/sync', { ops: [] })).status, 401);
  assert.equal(await count('SELECT COUNT(*) AS n FROM sync_ops'), before);
});

test('an oversized batch is refused before anything runs; the cap itself is accepted', async () => {
  const tooMany = Array.from({ length: MAX_SYNC_OPS + 1 }, () => open(randomUUID(), 12, 7));
  const before = await count('SELECT COUNT(*) AS n FROM sync_ops');
  assert.equal((await sync(tok.s1cashier, tooMany)).status, 422);
  assert.equal(await count('SELECT COUNT(*) AS n FROM sync_ops'), before);
  const atCap = Array.from({ length: MAX_SYNC_OPS }, () => line(randomUUID(), 3, 1));
  const r = await sync(tok.s1cashier, atCap);
  assert.equal(r.status, 200);
  assert.ok(r.json.results.every((x: any) => x.status === 'skipped'));
  const huge = await call('POST', '/api/sync', { ops: [], pad: 'x'.repeat(300 * 1024) }, tok.s1cashier);
  assert.equal(huge.status, 413);
});

test('op ids and bill refs are scoped to the store: the same ids in two stores never collide', async () => {
  const opId = randomUUID();
  const ref = randomUUID();
  const s1 = await sync(tok.s1cashier, [open(ref, 12, 7, {}, opId)]);
  const s2 = await sync(tok.s2cashier, [open(ref, 15, 12, {}, opId)]);
  assert.equal(s1.json.results[0].status, 'ok');
  assert.equal(s2.json.results[0].status, 'ok');
  assert.notEqual(s1.json.results[0].billId, s2.json.results[0].billId);
  assert.equal(s2.json.results[0].replayed, undefined);
  assert.equal((await bill(s2.json.results[0].billId)).store_id, 2);
  // store 2 cannot reach store 1's bill through its ref or its real id
  const viaRef = await sync(tok.s2cashier, [line(ref, 8, 1)]);
  assert.equal(viaRef.json.results[0].status, 'ok'); // its own ref resolves to its own bill
  assert.equal((await db.one('SELECT b.store_id FROM bill_lines l JOIN bills b ON b.id = l.bill_id WHERE b.id = ?', [s2.json.results[0].billId])).store_id, 2);
  const otherRef = randomUUID();
  const lone = await sync(tok.s2cashier, [line(otherRef, 8, 1)]);
  assert.equal(lone.json.results[0].status, 'skipped');
  const byRealId = await sync(tok.s2cashier, [line(String(s1.json.results[0].billId), 8, 1), pay(String(s1.json.results[0].billId), 100)]);
  assert.deepEqual(byRealId.json.results.map((x: any) => x.status), ['error', 'error']);
  assert.match(byRealId.json.results[0].message, /bill not found/);
  assert.equal(await count('SELECT COUNT(*) AS n FROM bill_lines WHERE bill_id = ?', [s1.json.results[0].billId]), 0);
  // a table of another store is not found
  const wrongStore = await sync(tok.s1cashier, [open(randomUUID(), 16, 7)]);
  assert.equal(wrongStore.json.results[0].status, 'error');
  assert.equal((await table(16)).status, 'free');
  await call('POST', `/api/bills/${s1.json.results[0].billId}/pay`, { method: 'cash' }, tok.s1cashier);
  await call('POST', `/api/bills/${s2.json.results[0].billId}/pay`, { method: 'cash' }, tok.s2cashier);
});

test('another company with the same op id and ref is isolated too', async () => {
  const made = await call('POST', '/platform/companies', { name: 'Acme', code: 'acme', storeName: 'Acme Bar', ownerName: 'Ann', ownerUsername: 'ann', ownerPin: '987654' }, undefined, { 'x-admin-key': 'admin-key' });
  assert.equal(made.status, 200);
  const owner = (await call('POST', '/api/login', { company: 'acme', username: 'ann', pin: '987654' })).json;
  const t = await call('POST', '/api/tables', { name: 'T1', kind: 'bar' }, owner.token);
  assert.equal(t.status, 200);
  const opId = randomUUID();
  const ref = randomUUID();
  const mine = await sync(owner.token, [open(ref, t.json.tableId, owner.actor.id, {}, opId)]);
  assert.equal(mine.json.results[0].status, 'ok');
  const theirs = await sync(tok.s1cashier, [open(ref, 13, 7, {}, opId)]);
  assert.equal(theirs.json.results[0].status, 'ok');
  assert.notEqual(theirs.json.results[0].billId, mine.json.results[0].billId);
  assert.equal((await bill(theirs.json.results[0].billId)).store_id, 1);
  await call('POST', `/api/bills/${theirs.json.results[0].billId}/pay`, { method: 'cash', amount: 1 }, tok.s1cashier);
});

test('roles are enforced per op: a waiter can take orders offline but not payments; a host cannot add lines', async () => {
  const ref = randomUUID();
  const w = await sync(tok.s1waiter, [open(ref, 1, 7), line(ref, 3, 1), pay(ref, 2800)]);
  assert.deepEqual(w.json.results.map((x: any) => x.status), ['ok', 'ok', 'error']);
  assert.equal(w.json.results[2].code, 403);
  assert.match(w.json.results[2].message, /may not bill\.settle/);
  const billId = w.json.results[0].billId;
  assert.equal((await bill(billId)).status, 'open');
  assert.equal(await count('SELECT COUNT(*) AS n FROM payments WHERE bill_id = ?', [billId]), 0);
  const h = await sync(tok.s1host, [line(String(billId), 3, 1)]);
  assert.equal(h.json.results[0].status, 'error');
  assert.equal(h.json.results[0].code, 403);
  // the cashier can finish it using the real id
  const done = await sync(tok.s1cashier, [pay(String(billId), 2800, 'cash', 2800)]);
  assert.equal(done.json.results[0].settled, true);
});

test('credit and cash payments link to the cashier shift', async () => {
  const shift = await call('POST', '/api/shifts/open', { openingCash: 10000 }, tok.s1cashier);
  assert.equal(shift.status, 200);
  const a = randomUUID();
  const b = randomUUID();
  const r = await sync(tok.s1cashier, [open(a, 2, 7), line(a, 3, 1), pay(a, 2800, 'cash', 2800), open(b, 3, 7), line(b, 3, 2), pay(b, 5600, 'credit', 5600)]);
  assert.ok(r.json.results.every((x: any) => x.status === 'ok'), JSON.stringify(r.json));
  const rows = await db.all('SELECT method, shift_id, offline FROM payments WHERE bill_id IN (?, ?) ORDER BY id', [r.json.results[0].billId, r.json.results[3].billId]);
  assert.deepEqual(rows.map((p: any) => [p.method, p.shift_id, p.offline]), [['cash', shift.json.shiftId, true], ['credit', shift.json.shiftId, true]]);
  const cur = (await call('GET', '/api/shifts/current', undefined, tok.s1cashier)).json;
  assert.equal(cur.expectedCash, 10000 + 2800);
  assert.deepEqual(cur.byMethod.map((m: any) => m.method).sort(), ['cash', 'credit']);
  await call('POST', '/api/shifts/close', { countedCash: 12800 }, tok.s1cashier);
});

test('ops apply strictly in order: a pay before the lines settles the empty bill and the late line conflicts', async () => {
  const ref = randomUUID();
  const r = await sync(tok.s1cashier, [open(ref, 4, 7), pay(ref, 0), line(ref, 3, 1)]);
  assert.deepEqual(r.json.results.map((x: any) => x.status), ['ok', 'ok', 'conflict']);
  assert.equal(r.json.results[1].settled, true);
  assert.match(r.json.results[2].message, /settled/);
  const ref2 = randomUUID();
  const ordered = await sync(tok.s1cashier, [open(ref2, 4, 7), line(ref2, 3, 1), line(ref2, 4, 2), line(ref2, 5, 3)]);
  const productIds = (await db.all('SELECT product_id FROM bill_lines WHERE bill_id = ? ORDER BY id', [ordered.json.results[0].billId])).map((l: any) => l.product_id);
  assert.deepEqual(productIds, [3, 4, 5]);
  await call('POST', `/api/bills/${ordered.json.results[0].billId}/pay`, { method: 'cash' }, tok.s1cashier);
});

test('a bill opened online before the outage can be traded offline through its real id', async () => {
  const real = (await call('POST', '/api/bills', { tableId: 5, repId: 7 }, tok.s1host)).json.billId;
  const r = await sync(tok.s1cashier, [line(String(real), 3, 2), pay(String(real), 5600, 'cash', 5600)]);
  assert.deepEqual(r.json.results.map((x: any) => x.status), ['ok', 'ok']);
  assert.equal(r.json.results[1].settled, true);
  assert.equal((await bill(real)).status, 'settled');
  assert.equal((await table(5)).status, 'free');
});

test('a failed op is not remembered: it can be retried under the same id once the cause is fixed', async () => {
  const ref = randomUUID();
  const opId = randomUUID();
  await db.run('UPDATE dining_tables SET status = ? WHERE id = ?', ['occupied', 6]);
  const first = await sync(tok.s1cashier, [open(ref, 6, 7, {}, opId)]);
  assert.equal(first.json.results[0].status, 'conflict');
  await db.run('UPDATE dining_tables SET status = ? WHERE id = ?', ['free', 6]);
  const again = await sync(tok.s1cashier, [open(ref, 6, 7, {}, opId)]);
  assert.equal(again.json.results[0].status, 'ok');
  await call('POST', `/api/bills/${again.json.results[0].billId}/pay`, { method: 'cash' }, tok.s1cashier);
});

test('a bill ref cannot be reused by a second open', async () => {
  const ref = randomUUID();
  const a = await sync(tok.s1cashier, [open(ref, 1, 7)]);
  assert.equal(a.json.results[0].status, 'ok');
  await call('POST', `/api/bills/${a.json.results[0].billId}/pay`, { method: 'cash' }, tok.s1cashier);
  const b = await sync(tok.s1cashier, [open(ref, 2, 7)]);
  assert.equal(b.json.results[0].status, 'conflict');
  assert.equal((await table(2)).status, 'free');
});
