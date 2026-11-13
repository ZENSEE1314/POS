import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { seed } from '../src/seed.ts';
import { totals } from '../src/bills.ts';
import { selfHeal } from '../src/ops.ts';

const MOCK_SECRET = 's3cret';
const ENV = { PAY_MODE: 'mock', MOCK_PAY_SECRET: MOCK_SECRET } as NodeJS.ProcessEnv;
const MS_PER_MINUTE = 60_000;

// Seeded ids: store 1 staff host 3, waiter 4, cashier 5, manager 6, rep 7. Store 1 products 1-5.
const REP = 7;
const MANAGER_ID = 6;
const WAITER_ID = 4;
const HENNESSY = 1;
const BEER = 3;
const FRUIT = 4;
const MIXER = 5;
const HENNESSY_PRICE = 128800;
const BEER_PRICE = 2800;
const FRUIT_PRICE = 18800;
const MIXER_PRICE = 6800;

let db: Db;
let server: Server;
let base: string;
let suiteStart: number;
let tableSeq = 0;
const tok: Record<string, string> = {};
const serverErrors: string[] = [];

async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status >= 500) serverErrors.push(`${method} ${path} -> ${res.status}`);
  return { status: res.status, json: await res.json() };
}

const sign = (raw: string) => createHmac('sha256', MOCK_SECRET).update(raw).digest('hex');

async function notify(provider: 'wechat' | 'alipay', evt: Record<string, unknown>, signature?: string): Promise<{ status: number; text: string }> {
  const raw = JSON.stringify(evt);
  const res = await fetch(`${base}/webhooks/${provider}`, { method: 'POST', headers: { 'x-mock-signature': signature ?? sign(raw) }, body: raw });
  if (res.status >= 500) serverErrors.push(`webhook ${provider} -> ${res.status}`);
  return { status: res.status, text: await res.text() };
}

let eventSeq = 0;
const paidEvent = (outTradeNo: string, amountFen: number) => ({ eventId: `evt-${++eventSeq}`, outTradeNo, amountFen, status: 'paid' });

async function newTable(minSpend = 0, tableFee = 0): Promise<number> {
  const r = await call('POST', '/api/tables', { name: `T${++tableSeq}`, kind: 'bar', minSpend, tableFee }, tok.manager);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.tableId;
}

async function openBill(extra: Record<string, unknown> = {}, tableId?: number): Promise<number> {
  const r = await call('POST', '/api/bills', { tableId: tableId ?? (await newTable()), repId: REP, ...extra }, tok.host);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.billId;
}

async function addLine(billId: number, productId: number, qty = 1, token = tok.waiter): Promise<number> {
  const r = await call('POST', `/api/bills/${billId}/lines`, { productId, qty }, token);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.lineId;
}

const getBill = async (billId: number) => (await call('GET', `/api/bills/${billId}`, undefined, tok.cashier)).json;
const pay = (billId: number, body: Record<string, unknown>, token = tok.cashier) => call('POST', `/api/bills/${billId}/pay`, body, token);
const stockOf = async (productId: number): Promise<number> => (await db.one('SELECT stock FROM products WHERE id = ?', [productId]))!.stock;
const tableStatus = async (tableId: number): Promise<string> => (await db.one('SELECT status FROM dining_tables WHERE id = ?', [tableId]))!.status;
const commissionOf = (billId: number) => db.all('SELECT employee_id, role, amount FROM commission_entries WHERE bill_id = ? ORDER BY role, employee_id', [billId]);
const paidPayments = (billId: number) => db.all("SELECT * FROM payments WHERE bill_id = ? AND status = 'paid' ORDER BY id", [billId]);

async function billOnNewTable(lines: Array<[number, number]>, minSpend = 0, tableFee = 0, extra: Record<string, unknown> = {}): Promise<number> {
  const billId = await openBill(extra, await newTable(minSpend, tableFee));
  for (const [productId, qty] of lines) await addLine(billId, productId, qty);
  return billId;
}

async function topUp(phone: string, amount: number): Promise<void> {
  const r = await call('POST', '/api/members/topup', { phone, amount }, tok.manager);
  assert.equal(r.status, 200, JSON.stringify(r.json));
}

before(async () => {
  suiteStart = Date.now();
  db = await openDb(process.env.TEST_DATABASE_URL);
  await seed(db);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const staff: Record<string, [string, string]> = {
    owner: ['owner', '6666'], finance: ['finance', '5555'],
    host: ['flag.host', '1111'], waiter: ['flag.waiter', '2222'], cashier: ['flag.cashier', '3333'], manager: ['flag.manager', '4444'],
    s2cashier: ['lnge.cashier', '3333'],
  };
  for (const [k, [username, pin]] of Object.entries(staff)) tok[k] = (await call('POST', '/api/login', { company: 'doloruu', username, pin })).json.token;
});
after(async () => {
  server.close();
  await db.close();
});

// ---- bill arithmetic ----------------------------------------------------------------------------

test('multi-line order totals add up exactly', async () => {
  const billId = await billOnNewTable([[HENNESSY, 1], [BEER, 3], [MIXER, 2]]);
  const t = (await getBill(billId)).totals;
  assert.deepEqual([t.subtotal, t.total, t.due], [HENNESSY_PRICE + 3 * BEER_PRICE + 2 * MIXER_PRICE, 150800, 150800]);
});

test('min spend tops the total up to the minimum', async () => {
  const billId = await billOnNewTable([[BEER, 1]], 200000);
  const t = (await getBill(billId)).totals;
  assert.deepEqual([t.subtotal, t.minSpendTopUp, t.total], [BEER_PRICE, 200000 - BEER_PRICE, 200000]);
});

test('no top-up once the order exceeds the minimum spend', async () => {
  const billId = await billOnNewTable([[HENNESSY, 2]], 200000);
  const t = (await getBill(billId)).totals;
  assert.deepEqual([t.minSpendTopUp, t.total], [0, 2 * HENNESSY_PRICE]);
});

test('table fee is charged on top of the min spend top-up', async () => {
  const billId = await billOnNewTable([], 800000, 20000);
  const t = (await getBill(billId)).totals;
  assert.deepEqual([t.minSpendTopUp, t.tableFee, t.total], [800000, 20000, 820000]);
});

test('table fee is charged on top of an order above min spend', async () => {
  const billId = await billOnNewTable([[HENNESSY, 7]], 800000, 20000);
  const t = (await getBill(billId)).totals;
  assert.equal(t.total, 7 * HENNESSY_PRICE + 20000);
});

test('a gifted line does not count towards the min spend', async () => {
  const billId = await billOnNewTable([], 200000);
  const r = await call('POST', `/api/bills/${billId}/lines`, { productId: HENNESSY, qty: 1, gift: true, reason: 'birthday' }, tok.manager);
  assert.equal(r.status, 200);
  const t = (await getBill(billId)).totals;
  assert.deepEqual([t.subtotal, t.total], [0, 200000]);
});

test('discount is subtracted from the min-spend-adjusted total', async () => {
  const billId = await billOnNewTable([[BEER, 1]], 200000);
  await call('POST', `/api/bills/${billId}/discount`, { amount: 10000, reason: 'regular' }, tok.manager);
  assert.equal((await getBill(billId)).totals.total, 190000);
});

test('a discount larger than the bill never makes the total negative', async () => {
  const billId = await billOnNewTable([[BEER, 1]]);
  await call('POST', `/api/bills/${billId}/discount`, { amount: 999999, reason: 'oops' }, tok.manager);
  const t = (await getBill(billId)).totals;
  assert.deepEqual([t.total, t.due], [0, 0]);
});

test('discount rejects negative, fractional, missing reason and non-managers', async () => {
  const billId = await billOnNewTable([[BEER, 1]]);
  const url = `/api/bills/${billId}/discount`;
  const statuses = [
    (await call('POST', url, { amount: -1, reason: 'x' }, tok.manager)).status,
    (await call('POST', url, { amount: 1.5, reason: 'x' }, tok.manager)).status,
    (await call('POST', url, { amount: 100 }, tok.manager)).status,
    (await call('POST', url, { amount: 100, reason: 'x' }, tok.cashier)).status,
  ];
  assert.deepEqual(statuses, [422, 422, 422, 403]);
});

test('a voided line leaves the total and cannot be voided twice', async () => {
  const billId = await openBill();
  await addLine(billId, BEER, 1);
  const fruit = await addLine(billId, FRUIT, 1);
  const first = await call('POST', `/api/bills/${billId}/lines/${fruit}/void`, { reason: 'wrong item' }, tok.manager);
  const second = await call('POST', `/api/bills/${billId}/lines/${fruit}/void`, { reason: 'again' }, tok.manager);
  assert.deepEqual([first.status, second.status, (await getBill(billId)).totals.total], [200, 404, BEER_PRICE]);
});

test('void needs a reason and a manager', async () => {
  const billId = await openBill();
  const line = await addLine(billId, BEER, 1);
  const noReason = await call('POST', `/api/bills/${billId}/lines/${line}/void`, {}, tok.manager);
  const waiter = await call('POST', `/api/bills/${billId}/lines/${line}/void`, { reason: 'x' }, tok.waiter);
  assert.deepEqual([noReason.status, waiter.status], [422, 403]);
});

test('line quantity must be a sane positive integer', async () => {
  const billId = await openBill();
  const send = (qty: unknown) => call('POST', `/api/bills/${billId}/lines`, { productId: BEER, qty }, tok.waiter);
  const statuses = [(await send(0)).status, (await send(-1)).status, (await send(1.5)).status, (await send('2')).status, (await send(99999999999)).status];
  assert.deepEqual(statuses, [422, 422, 422, 422, 422]);
});

// ---- mutation after money has moved ---------------------------------------------------------------

test('voiding a line cannot push the total below what is already paid', async () => {
  const billId = await openBill();
  await addLine(billId, BEER, 1);
  const fruit = await addLine(billId, FRUIT, 1);
  await pay(billId, { method: 'cash', amount: 20000 });
  const r = await call('POST', `/api/bills/${billId}/lines/${fruit}/void`, { reason: 'mistake' }, tok.manager);
  assert.equal(r.status, 409);
});

test('a refused void leaves the line active', async () => {
  const billId = await openBill();
  await addLine(billId, BEER, 1);
  const fruit = await addLine(billId, FRUIT, 1);
  await pay(billId, { method: 'cash', amount: 20000 });
  await call('POST', `/api/bills/${billId}/lines/${fruit}/void`, { reason: 'mistake' }, tok.manager);
  assert.equal((await getBill(billId)).totals.total, BEER_PRICE + FRUIT_PRICE);
});

test('a discount cannot push the total below what is already paid', async () => {
  const billId = await billOnNewTable([[BEER, 1], [FRUIT, 1]]);
  await pay(billId, { method: 'cash', amount: 20000 });
  const r = await call('POST', `/api/bills/${billId}/discount`, { amount: 5000, reason: 'x' }, tok.manager);
  assert.equal(r.status, 409);
});

test('a discount that exactly covers the remainder settles the bill', async () => {
  const billId = await billOnNewTable([[BEER, 1], [FRUIT, 1]]);
  await pay(billId, { method: 'cash', amount: 20000 });
  await call('POST', `/api/bills/${billId}/discount`, { amount: 1600, reason: 'round down' }, tok.manager);
  assert.equal((await getBill(billId)).bill.status, 'settled');
});

test('voiding down to exactly the paid amount settles the bill', async () => {
  const billId = await openBill();
  await addLine(billId, BEER, 1);
  const fruit = await addLine(billId, FRUIT, 1);
  await pay(billId, { method: 'cash', amount: BEER_PRICE });
  await call('POST', `/api/bills/${billId}/lines/${fruit}/void`, { reason: 'customer declined' }, tok.manager);
  assert.equal((await getBill(billId)).bill.status, 'settled');
});

test('voiding the only line of an unpaid bill does not close the bill', async () => {
  const billId = await openBill();
  const line = await addLine(billId, BEER, 1);
  await call('POST', `/api/bills/${billId}/lines/${line}/void`, { reason: 'wrong' }, tok.manager);
  assert.equal((await getBill(billId)).bill.status, 'open');
});

test('a fully gifted bill with zero total can be closed and frees the table', async () => {
  const tableId = await newTable();
  const billId = await openBill({}, tableId);
  await call('POST', `/api/bills/${billId}/lines`, { productId: HENNESSY, qty: 1, gift: true, reason: 'vip comp' }, tok.manager);
  const stockBefore = await stockOf(HENNESSY);
  const r = await pay(billId, { method: 'cash' });
  assert.deepEqual([r.status, r.json.settled, await tableStatus(tableId)], [200, true, 'free']);
  assert.equal(await stockOf(HENNESSY), stockBefore - 1, 'a comped bottle still leaves the shelf');
});

test('an empty bill opened by mistake can be closed', async () => {
  const tableId = await newTable();
  const billId = await openBill({}, tableId);
  const r = await pay(billId, { method: 'cash' });
  assert.deepEqual([r.status, await tableStatus(tableId)], [200, 'free']);
});

test('a fully discounted bill can be closed', async () => {
  const tableId = await newTable();
  const billId = await openBill({}, tableId);
  await addLine(billId, BEER, 1);
  await call('POST', `/api/bills/${billId}/discount`, { amount: BEER_PRICE, reason: 'on the house' }, tok.manager);
  const r = await pay(billId, { method: 'cash' });
  assert.deepEqual([r.status, (await getBill(billId)).bill.status], [200, 'settled']);
});

test('a settled bill rejects every mutation', async () => {
  const billId = await billOnNewTable([[BEER, 1]]);
  const line = (await getBill(billId)).lines[0].id;
  await pay(billId, { method: 'cash' });
  const attempts = await Promise.all([
    call('POST', `/api/bills/${billId}/lines`, { productId: BEER, qty: 1 }, tok.waiter),
    call('POST', `/api/bills/${billId}/lines/${line}/void`, { reason: 'late' }, tok.manager),
    call('POST', `/api/bills/${billId}/discount`, { amount: 100, reason: 'late' }, tok.manager),
    pay(billId, { method: 'cash' }),
    call('POST', `/api/bills/${billId}/pay-online`, { method: 'wechat' }, tok.cashier),
    call('POST', `/api/bills/${billId}/redeem`, { code: 'DY-10-late' }, tok.cashier),
    call('POST', `/api/bills/${billId}/transfer`, { toTableId: await newTable() }, tok.host),
  ]);
  assert.deepEqual(attempts.map((a) => a.status), [409, 409, 409, 409, 409, 404, 409]);
});

test('staff of another store cannot see or pay a bill', async () => {
  const billId = await billOnNewTable([[BEER, 1]]);
  const view = await call('GET', `/api/bills/${billId}`, undefined, tok.s2cashier);
  const payment = await pay(billId, { method: 'cash' }, tok.s2cashier);
  assert.deepEqual([view.status, payment.status], [404, 404]);
});

// ---- instant payments -----------------------------------------------------------------------------

test('exact cash payment settles, decrements stock once and logs a stock movement', async () => {
  const tableId = await newTable();
  const billId = await openBill({}, tableId);
  await addLine(billId, BEER, 2);
  const stockBefore = await stockOf(BEER);
  const r = await pay(billId, { method: 'cash' });
  const movements = await db.all('SELECT delta FROM stock_movements WHERE reason = ?', [`sale bill ${billId}`]);
  assert.deepEqual([r.json, await stockOf(BEER), movements, await tableStatus(tableId)], [{ settled: true, paid: 5600 }, stockBefore - 2, [{ delta: -2 }], 'free']);
});

test('paying more than due is capped at what is due', async () => {
  const billId = await billOnNewTable([[BEER, 1]]);
  const r = await pay(billId, { method: 'cash', amount: 1_000_000 });
  assert.deepEqual([r.json.paid, (await paidPayments(billId)).map((p: any) => p.amount)], [BEER_PRICE, [BEER_PRICE]]);
});

test('partial payments leave the bill open until the remainder is paid', async () => {
  const billId = await billOnNewTable([[BEER, 5]]);
  const first = await pay(billId, { method: 'cash', amount: 5000 });
  const mid = (await getBill(billId)).bill.status;
  const second = await pay(billId, { method: 'cash' });
  assert.deepEqual([first.json.settled, mid, second.json, (await getBill(billId)).bill.status], [false, 'open', { settled: true, paid: 9000 }, 'settled']);
});

test('paying an already settled bill is refused', async () => {
  const billId = await billOnNewTable([[BEER, 1]]);
  await pay(billId, { method: 'cash' });
  assert.equal((await pay(billId, { method: 'cash' })).status, 409);
});

test('non-positive, fractional and non-numeric pay amounts are client errors, never 500', async () => {
  const billId = await billOnNewTable([[BEER, 2]]);
  const statuses = [];
  for (const amount of [0, -5, 1.5, 'abc', null, true, 1e30]) statuses.push((await pay(billId, { method: 'cash', amount })).status);
  assert.ok(statuses.every((s) => s >= 400 && s < 500), `got ${statuses}`);
});

test('unknown pay method and non-cashier roles are refused', async () => {
  const billId = await billOnNewTable([[BEER, 1]]);
  const unknown = await pay(billId, { method: 'bitcoin' });
  const waiter = await pay(billId, { method: 'cash' }, tok.waiter);
  const host = await pay(billId, { method: 'cash' }, tok.host);
  assert.deepEqual([unknown.status, waiter.status, host.status], [422, 403, 403]);
});

test('member wallet payment debits the balance and writes a ledger row', async () => {
  const phone = '13500000011';
  await topUp(phone, 10000);
  const billId = await billOnNewTable([[BEER, 2]], 0, 0, { phone });
  const r = await pay(billId, { method: 'member', amount: 3000 });
  const member = await db.one('SELECT id, balance FROM members WHERE phone = ?', [phone]);
  const ledger = await db.all('SELECT delta FROM wallet_ledger WHERE member_id = ? AND bill_id = ? ', [member!.id, billId]);
  assert.deepEqual([r.status, member!.balance, ledger], [200, 7000, [{ delta: -3000 }]]);
});

test('member payment above the balance is refused and leaves the balance untouched', async () => {
  const phone = '13500000012';
  await topUp(phone, 1000);
  const billId = await billOnNewTable([[BEER, 2]], 0, 0, { phone });
  const r = await pay(billId, { method: 'member' });
  const member = await db.one('SELECT balance FROM members WHERE phone = ?', [phone]);
  assert.deepEqual([r.status, member!.balance], [402, 1000]);
});

test('member payment on a bill without a member is refused', async () => {
  const billId = await billOnNewTable([[BEER, 1]]);
  assert.equal((await pay(billId, { method: 'member' })).status, 422);
});

test('top-up credits amount plus bonus and rejects bad input', async () => {
  const phone = '13500000013';
  const ok = await call('POST', '/api/members/topup', { phone, amount: 10000, bonus: 2000 }, tok.manager);
  const bad = [
    await call('POST', '/api/members/topup', { phone, amount: -1 }, tok.manager),
    await call('POST', '/api/members/topup', { phone, amount: 0 }, tok.manager),
    await call('POST', '/api/members/topup', { phone, amount: 100.5 }, tok.manager),
    await call('POST', '/api/members/topup', { phone, amount: 100, bonus: -5 }, tok.manager),
    await call('POST', '/api/members/topup', { phone, amount: 1e30 }, tok.manager),
    await call('POST', '/api/members/topup', { amount: 100 }, tok.manager),
    await call('POST', '/api/members/topup', { phone, amount: 100 }, tok.cashier),
  ];
  assert.deepEqual([ok.json.balance, bad.map((b) => b.status)], [12000, [422, 422, 422, 422, 422, 422, 403]]);
});

test('concurrent wallet spends never overdraw the member', async () => {
  const phone = '13500000014';
  await topUp(phone, 5000);
  const a = await billOnNewTable([[BEER, 1]], 0, 0, { phone });
  const b = await billOnNewTable([[BEER, 1]], 0, 0, { phone });
  const c = await billOnNewTable([[BEER, 1]], 0, 0, { phone });
  const results = await Promise.all([a, b, c].map((id) => pay(id, { method: 'member' })));
  const member = await db.one('SELECT balance FROM members WHERE phone = ?', [phone]);
  assert.deepEqual([results.filter((r) => r.status === 200).length, results.filter((r) => r.status === 402).length, member!.balance], [1, 2, 5000 - BEER_PRICE]);
});

test('two concurrent payments for the same bill settle exactly once', async () => {
  const billId = await billOnNewTable([[HENNESSY, 1]]);
  const stockBefore = await stockOf(HENNESSY);
  const results = await Promise.all([pay(billId, { method: 'cash' }), pay(billId, { method: 'cash' })]);
  const rows = await commissionOf(billId);
  assert.deepEqual(
    [results.map((r) => r.status).sort(), (await paidPayments(billId)).length, rows.length, await stockOf(HENNESSY)],
    [[200, 409], 1, 2, stockBefore - 1]);
});

test('concurrent partial payments never overpay the bill', async () => {
  const billId = await billOnNewTable([[BEER, 5]]);
  const results = await Promise.all([1, 2, 3, 4].map(() => pay(billId, { method: 'cash', amount: 5000 })));
  const paid = (await paidPayments(billId)).reduce((a: number, p: any) => a + p.amount, 0);
  assert.equal(paid, 5 * BEER_PRICE, `statuses ${results.map((r) => r.status)}`);
});

test('malformed ids and bodies are client errors, never 500', async () => {
  const billId = await billOnNewTable([[BEER, 1]]);
  const raw = await fetch(`${base}/api/bills/${billId}/pay`, { method: 'POST', headers: { Authorization: `Bearer ${tok.cashier}`, 'Content-Type': 'application/json' }, body: 'null' });
  const results = [
    await call('GET', '/api/bills/abc', undefined, tok.cashier),
    await call('GET', '/api/bills/1.5', undefined, tok.cashier),
    await call('GET', '/api/bills/99999999999999999999', undefined, tok.cashier),
    await call('GET', '/api/bills/-1', undefined, tok.cashier),
    await call('POST', `/api/bills/${billId}/lines`, { productId: 'x', qty: 1 }, tok.waiter),
    await call('POST', `/api/bills/${billId}/lines`, { qty: 1 }, tok.waiter),
    await call('POST', `/api/bills/${billId}/transfer`, {}, tok.host),
    await call('POST', '/api/bills', {}, tok.host),
    await call('POST', '/api/bills', { tableId: 'x', repId: REP }, tok.host),
    await call('POST', '/api/bills', { tableId: await newTable(), repId: 'x' }, tok.host),
    await call('POST', `/api/bills/${billId}/discount`, { amount: 'abc', reason: 'x' }, tok.manager),
    await call('POST', `/api/bills/${billId}/pay-online`, { method: 'wechat', amount: 'abc' }, tok.cashier),
    await call('POST', `/api/bills/${billId}/lines/zzz/void`, { reason: 'x' }, tok.manager),
  ];
  if (raw.status >= 500) serverErrors.push(`POST pay with JSON null -> ${raw.status}`);
  const statuses = [...results.map((r) => r.status), raw.status];
  assert.ok(statuses.every((s) => s >= 400 && s < 500), `got ${statuses}`);
});

// ---- credit (挂账) and receivables ------------------------------------------------------------------

async function creditReceivable(qty = 3): Promise<{ billId: number; paymentId: number; amount: number }> {
  const billId = await billOnNewTable([[BEER, qty]], 0, 0, { phone: '13500000021' });
  const r = await pay(billId, { method: 'credit' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const list = (await call('GET', '/api/receivables', undefined, tok.finance)).json;
  const row = list.find((x: any) => x.billId === billId);
  return { billId, paymentId: row.paymentId, amount: row.amount };
}

test('a credit bill settles and shows up as an outstanding receivable', async () => {
  const { billId, amount } = await creditReceivable();
  const row = (await call('GET', '/api/receivables', undefined, tok.finance)).json.find((x: any) => x.billId === billId);
  assert.deepEqual([(await getBill(billId)).bill.status, amount, row.collected], ['settled', 3 * BEER_PRICE, 0]);
});

test('receivable collection is partial, then complete, and never exceeds the debt', async () => {
  const { paymentId } = await creditReceivable();
  const first = await call('POST', `/api/receivables/${paymentId}/collect`, { amount: 3000, method: 'cash' }, tok.finance);
  const over = await call('POST', `/api/receivables/${paymentId}/collect`, { amount: 5401, method: 'cash' }, tok.finance);
  const rest = await call('POST', `/api/receivables/${paymentId}/collect`, { amount: 5400, method: 'wechat' }, tok.finance);
  const extra = await call('POST', `/api/receivables/${paymentId}/collect`, { amount: 1, method: 'cash' }, tok.finance);
  assert.deepEqual([first.json.outstanding, over.status, rest.json.outstanding, extra.status], [5400, 409, 0, 409]);
});

test('concurrent collections cannot over-collect', async () => {
  const { paymentId } = await creditReceivable();
  const results = await Promise.all([1, 2, 3].map(() => call('POST', `/api/receivables/${paymentId}/collect`, { amount: 3000, method: 'cash' }, tok.finance)));
  const collected = (await db.one('SELECT COALESCE(SUM(amount),0) AS s FROM receivable_collections WHERE payment_id = ?', [paymentId]))!.s;
  assert.deepEqual([results.filter((r) => r.status === 200).length, collected], [2, 6000]);
});

test('collection input and role checks', async () => {
  const { paymentId } = await creditReceivable();
  const path = `/api/receivables/${paymentId}/collect`;
  const statuses = [
    (await call('POST', path, { amount: 0, method: 'cash' }, tok.finance)).status,
    (await call('POST', path, { amount: -5, method: 'cash' }, tok.finance)).status,
    (await call('POST', path, { amount: 1.5, method: 'cash' }, tok.finance)).status,
    (await call('POST', path, { amount: 100, method: 'barter' }, tok.finance)).status,
    (await call('POST', path, { amount: 100, method: 'cash' }, tok.cashier)).status,
    (await call('POST', path, { amount: 100, method: 'cash' }, tok.manager)).status,
  ];
  assert.deepEqual(statuses, [422, 422, 422, 422, 403, 403]);
});

test('only credit payments can be collected as receivables', async () => {
  const billId = await billOnNewTable([[BEER, 1]]);
  await pay(billId, { method: 'cash' });
  const cashPayment = (await paidPayments(billId))[0];
  const r = await call('POST', `/api/receivables/${cashPayment.id}/collect`, { amount: 100, method: 'cash' }, tok.finance);
  assert.equal(r.status, 404);
});

// ---- online payments --------------------------------------------------------------------------------

async function startOnline(billId: number, method: 'wechat' | 'alipay' = 'wechat', amount?: number) {
  const r = await call('POST', `/api/bills/${billId}/pay-online`, { method, amount }, tok.cashier);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json as { paymentId: number; outTradeNo: string; amount: number; qrContent: string };
}

test('online payment is pending until the signed webhook arrives, then settles', async () => {
  const billId = await billOnNewTable([[BEER, 2]]);
  const p = await startOnline(billId);
  const pending = (await getBill(billId)).bill.status;
  const n = await notify('wechat', paidEvent(p.outTradeNo, p.amount));
  assert.deepEqual([pending, n, (await getBill(billId)).bill.status, p.amount], ['open', { status: 200, text: 'ok' }, 'settled', 5600]);
});

test('an unconfigured or unknown online method is refused', async () => {
  const billId = await billOnNewTable([[BEER, 1]]);
  const r = await call('POST', `/api/bills/${billId}/pay-online`, { method: 'paypal' }, tok.cashier);
  assert.equal(r.status, 422);
});

test('the same notify delivered twice concurrently settles once', async () => {
  const billId = await billOnNewTable([[HENNESSY, 1]]);
  const stockBefore = await stockOf(HENNESSY);
  const p = await startOnline(billId);
  const evt = paidEvent(p.outTradeNo, p.amount);
  const results = await Promise.all([notify('wechat', evt), notify('wechat', evt), notify('wechat', evt)]);
  assert.deepEqual(
    [results.map((r) => r.status), (await paidPayments(billId)).length, (await commissionOf(billId)).length, await stockOf(HENNESSY)],
    [[200, 200, 200], 1, 2, stockBefore - 1]);
});

test('two different events for the same payment settle once and keep one paid payment', async () => {
  const billId = await billOnNewTable([[BEER, 1]]);
  const p = await startOnline(billId);
  await Promise.all([notify('wechat', paidEvent(p.outTradeNo, p.amount)), notify('wechat', paidEvent(p.outTradeNo, p.amount))]);
  assert.deepEqual([(await paidPayments(billId)).length, (await commissionOf(billId)).length], [1, 2]);
});

test('a notify with paid=false does not pay anything', async () => {
  const billId = await billOnNewTable([[BEER, 1]]);
  const p = await startOnline(billId);
  const n = await notify('wechat', { eventId: `evt-fail-${p.outTradeNo}`, outTradeNo: p.outTradeNo, amountFen: p.amount, status: 'failed' });
  assert.deepEqual([n.status, (await paidPayments(billId)).length, (await getBill(billId)).bill.status], [200, 0, 'open']);
});

test('a real payment still works after a failed notify for the same trade', async () => {
  const billId = await billOnNewTable([[BEER, 1]]);
  const p = await startOnline(billId);
  await notify('wechat', { eventId: `evt-f2-${p.outTradeNo}`, outTradeNo: p.outTradeNo, amountFen: p.amount, status: 'failed' });
  await notify('wechat', paidEvent(p.outTradeNo, p.amount));
  assert.equal((await getBill(billId)).bill.status, 'settled');
});

test('an amount mismatch is rejected and the payment stays pending', async () => {
  const billId = await billOnNewTable([[BEER, 2]]);
  const p = await startOnline(billId);
  const n = await notify('wechat', paidEvent(p.outTradeNo, 1));
  const payment = await db.one('SELECT status FROM payments WHERE id = ?', [p.paymentId]);
  assert.deepEqual([n.status, payment!.status, (await getBill(billId)).bill.status], [409, 'pending', 'open']);
});

test('a notify for an unknown out_trade_no is a 404 and changes nothing', async () => {
  const n = await notify('wechat', paidEvent('NP999999T0nope', 100));
  assert.equal(n.status, 404);
});

test('a notify quoting another bill\'s trade number with the wrong amount cannot pay either bill', async () => {
  const a = await billOnNewTable([[BEER, 1]]);
  const b = await billOnNewTable([[BEER, 4]]);
  const pa = await startOnline(a);
  const pb = await startOnline(b);
  const n = await notify('wechat', paidEvent(pb.outTradeNo, pa.amount));
  assert.deepEqual([n.status, (await paidPayments(a)).length, (await paidPayments(b)).length], [409, 0, 0]);
});

test('a notify signed with the wrong key or missing signature is refused', async () => {
  const billId = await billOnNewTable([[BEER, 1]]);
  const p = await startOnline(billId);
  const bad = await notify('wechat', paidEvent(p.outTradeNo, p.amount), 'deadbeef');
  const none = await fetch(`${base}/webhooks/wechat`, { method: 'POST', body: JSON.stringify(paidEvent(p.outTradeNo, p.amount)) });
  assert.deepEqual([bad.status, none.status, (await getBill(billId)).bill.status], [401, 401, 'open']);
});

test('a wechat payment cannot be completed through the alipay webhook', async () => {
  const billId = await billOnNewTable([[BEER, 1]]);
  const p = await startOnline(billId, 'wechat');
  const n = await notify('alipay', paidEvent(p.outTradeNo, p.amount));
  assert.deepEqual([n.status >= 400, (await paidPayments(billId)).length], [true, 0]);
});

test('a late notify after the pending payment expired is still honoured', async () => {
  const billId = await billOnNewTable([[BEER, 1]]);
  const p = await startOnline(billId);
  await db.run('UPDATE payments SET created_at = ? WHERE id = ?', [Date.now() - 20 * MS_PER_MINUTE, p.paymentId]);
  await selfHeal(db);
  const expired = (await db.one('SELECT status FROM payments WHERE id = ?', [p.paymentId]))!.status;
  await notify('wechat', paidEvent(p.outTradeNo, p.amount));
  assert.deepEqual([expired, (await getBill(billId)).bill.status], ['expired', 'settled']);
});

test('lines added after a pending online payment keep the bill open after that payment lands', async () => {
  const billId = await billOnNewTable([[BEER, 1]]);
  const p = await startOnline(billId);
  await addLine(billId, FRUIT, 1);
  await notify('wechat', paidEvent(p.outTradeNo, p.amount));
  const t = (await getBill(billId));
  assert.deepEqual([t.bill.status, t.totals.paid, t.totals.due], ['open', BEER_PRICE, FRUIT_PRICE]);
});

test('a partial online payment plus cash for the remainder settles the bill', async () => {
  const billId = await billOnNewTable([[BEER, 5]]);
  const p = await startOnline(billId, 'alipay', 4000);
  await notify('alipay', paidEvent(p.outTradeNo, p.amount));
  const mid = (await getBill(billId)).bill.status;
  await pay(billId, { method: 'cash' });
  assert.deepEqual([p.amount, mid, (await getBill(billId)).bill.status], [4000, 'open', 'settled']);
});

test('online payment amount is capped at what is due', async () => {
  const billId = await billOnNewTable([[BEER, 1]]);
  const p = await startOnline(billId, 'wechat', 10_000_000);
  assert.equal(p.amount, BEER_PRICE);
});

test('the dev mock-pay helper settles like a real webhook and is idempotent', async () => {
  const billId = await billOnNewTable([[BEER, 1]]);
  const p = await startOnline(billId);
  await call('POST', '/dev/mock-pay', { outTradeNo: p.outTradeNo }, tok.cashier);
  await call('POST', '/dev/mock-pay', { outTradeNo: p.outTradeNo }, tok.cashier);
  assert.deepEqual([(await paidPayments(billId)).length, (await getBill(billId)).bill.status], [1, 'settled']);
});

// ---- Douyin vouchers --------------------------------------------------------------------------------

const redeem = (billId: number, code: string, token = tok.cashier) => call('POST', `/api/bills/${billId}/redeem`, { code }, token);

test('a voucher smaller than the bill leaves the remainder due', async () => {
  const billId = await billOnNewTable([[BEER, 5]]);
  const r = await redeem(billId, 'DY-50-partial');
  const mid = (await getBill(billId)).totals.due;
  await pay(billId, { method: 'cash' });
  assert.deepEqual([r.json, mid, (await getBill(billId)).bill.status], [{ amount: 5000, settled: false }, 9000, 'settled']);
});

test('a voucher bigger than the bill settles it', async () => {
  const billId = await billOnNewTable([[BEER, 1]]);
  const r = await redeem(billId, 'DY-500-big');
  assert.deepEqual([r.json.settled, (await getBill(billId)).bill.status], [true, 'settled']);
});

test('a voucher cannot be redeemed twice, on the same or another bill', async () => {
  const a = await billOnNewTable([[BEER, 5]]);
  const b = await billOnNewTable([[BEER, 5]]);
  const first = await redeem(a, 'DY-10-once');
  const same = await redeem(a, 'DY-10-once');
  const other = await redeem(b, 'DY-10-once');
  assert.deepEqual([first.status, same.status, other.status], [200, 409, 409]);
});

test('the same voucher redeemed concurrently on two bills pays only one', async () => {
  const a = await billOnNewTable([[BEER, 5]]);
  const b = await billOnNewTable([[BEER, 5]]);
  const results = await Promise.all([redeem(a, 'DY-10-race'), redeem(b, 'DY-10-race')]);
  const used = await db.all("SELECT 1 FROM payments WHERE method = 'douyin_voucher' AND provider_ref = 'mockvoucher_DY-10-race'");
  assert.deepEqual([results.map((r) => r.status).sort(), used.length], [[200, 409], 1]);
});

test('an invalid voucher code and a non-cashier are refused', async () => {
  const billId = await billOnNewTable([[BEER, 1]]);
  const bad = await redeem(billId, 'nonsense');
  const waiter = await redeem(billId, 'DY-10-x', tok.waiter);
  assert.deepEqual([bad.status, waiter.status], [409, 403]);
});

// ---- settlement side effects -------------------------------------------------------------------------

test('commission floors per line, uses category rules and ignores gift and void lines', async () => {
  const product = await call('POST', '/api/products', { name: 'Pickles', price: 333, stock: 100 }, tok.manager);
  const billId = await openBill({}, await newTable());
  await addLine(billId, HENNESSY, 1);
  await addLine(billId, product.json.productId, 3);
  const fruit = await addLine(billId, FRUIT, 1);
  await call('POST', `/api/bills/${billId}/lines/${fruit}/void`, { reason: 'wrong' }, tok.manager);
  await call('POST', `/api/bills/${billId}/lines`, { productId: BEER, qty: 2, gift: true, reason: 'promo' }, tok.manager);
  await pay(billId, { method: 'cash' });
  // sales: 8% of 128800 = 10304, 5% of 999 = 49.95 -> 49. waiter: 2% of 128800 = 2576, 2% of 999 = 19.98 -> 19.
  assert.deepEqual(await commissionOf(billId), [
    { employee_id: REP, role: 'sales', amount: 10304 + 49 },
    { employee_id: WAITER_ID, role: 'waiter', amount: 2576 + 19 },
  ]);
});

test('a gifted bottle leaves stock but a voided line does not', async () => {
  const billId = await openBill({}, await newTable());
  await addLine(billId, BEER, 1);
  const voided = await addLine(billId, MIXER, 4);
  await call('POST', `/api/bills/${billId}/lines/${voided}/void`, { reason: 'wrong' }, tok.manager);
  await call('POST', `/api/bills/${billId}/lines`, { productId: FRUIT, qty: 2, gift: true, reason: 'promo' }, tok.manager);
  const before = [await stockOf(BEER), await stockOf(MIXER), await stockOf(FRUIT)];
  await pay(billId, { method: 'cash' });
  assert.deepEqual([await stockOf(BEER), await stockOf(MIXER), await stockOf(FRUIT)], [before[0] - 1, before[1], before[2] - 2]);
});

test('products that do not track stock are never decremented', async () => {
  const product = await call('POST', '/api/products', { name: 'Ice Service', price: 500, stock: 7, trackStock: false }, tok.manager);
  const billId = await billOnNewTable([[product.json.productId, 3]]);
  await pay(billId, { method: 'cash' });
  const row = await db.one('SELECT stock FROM products WHERE id = ?', [product.json.productId]);
  assert.equal(row!.stock, 7);
});

test('when the rep is also the ordering waiter they earn both commissions', async () => {
  const billId = await openBill({ repId: MANAGER_ID }, await newTable());
  await addLine(billId, HENNESSY, 1, tok.manager);
  await addLine(billId, BEER, 1, tok.manager);
  await pay(billId, { method: 'cash' });
  assert.deepEqual(await commissionOf(billId), [
    { employee_id: MANAGER_ID, role: 'sales', amount: 10304 + 140 },
    { employee_id: MANAGER_ID, role: 'waiter', amount: 2576 + 56 },
  ]);
});

test('a bill with only gift lines pays no commission', async () => {
  const billId = await openBill({}, await newTable());
  await call('POST', `/api/bills/${billId}/lines`, { productId: HENNESSY, qty: 1, gift: true, reason: 'vip' }, tok.manager);
  await pay(billId, { method: 'cash' });
  assert.deepEqual(await commissionOf(billId), []);
});

test('settling a bill that came from a booking marks the booking redeemed', async () => {
  const tableId = await newTable();
  const booking = await call('POST', '/api/bookings', { phone: '13500000031', eta: Date.now() + 3600_000, tableId, repId: REP }, tok.host);
  const billId = await openBill({ bookingId: booking.json.bookingId }, tableId);
  const checkedIn = (await db.one('SELECT status FROM bookings WHERE id = ?', [booking.json.bookingId]))!.status;
  await addLine(billId, BEER, 1);
  await pay(billId, { method: 'cash' });
  const after = (await db.one('SELECT status FROM bookings WHERE id = ?', [booking.json.bookingId]))!.status;
  assert.deepEqual([checkedIn, after], ['checked_in', 'redeemed']);
});

test('payroll rows equal the commission entries written at settlement', async () => {
  const rows = (await call('GET', `/api/payroll?from=${suiteStart}`, undefined, tok.finance)).json;
  const written = (await db.one('SELECT COALESCE(SUM(amount),0) AS s FROM commission_entries WHERE store_id = 1'))!.s;
  assert.equal(rows.reduce((a: number, r: any) => a + r.commission, 0), written);
});

test('payroll is hidden from store staff', async () => {
  const statuses = [(await call('GET', '/api/payroll', undefined, tok.manager)).status, (await call('GET', '/api/payroll', undefined, tok.cashier)).status];
  assert.deepEqual(statuses, [403, 403]);
});

// ---- tables ------------------------------------------------------------------------------------------

test('a table cannot be opened twice, even concurrently', async () => {
  const tableId = await newTable();
  const results = await Promise.all([1, 2].map(() => call('POST', '/api/bills', { tableId, repId: REP }, tok.host)));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
});

test('transfer moves the bill, frees the old table and occupies the new one', async () => {
  const from = await newTable();
  const to = await newTable();
  const billId = await openBill({}, from);
  const r = await call('POST', `/api/bills/${billId}/transfer`, { toTableId: to }, tok.host);
  assert.deepEqual([r.status, await tableStatus(from), await tableStatus(to), (await getBill(billId)).bill.table_id], [200, 'free', 'occupied', to]);
});

test('transfer to an occupied, same, inactive, other-store or missing table is refused', async () => {
  const billId = await openBill({}, await newTable());
  const occupied = await newTable();
  await openBill({}, occupied);
  const inactive = await newTable();
  await call('PATCH', `/api/tables/${inactive}`, { active: false }, tok.manager);
  const otherStore = (await db.one('SELECT id FROM dining_tables WHERE store_id = (SELECT id FROM stores ORDER BY id OFFSET 1 LIMIT 1) LIMIT 1'))!.id;
  const same = (await getBill(billId)).bill.table_id;
  const statuses = [];
  for (const toTableId of [occupied, same, inactive, otherStore, 999999]) statuses.push((await call('POST', `/api/bills/${billId}/transfer`, { toTableId }, tok.host)).status);
  assert.deepEqual(statuses, [409, 409, 404, 404, 404]);
});

test('transferring a paid-for bill table keeps the payments and still settles', async () => {
  const from = await newTable();
  const to = await newTable();
  const billId = await openBill({}, from);
  await addLine(billId, BEER, 2);
  await pay(billId, { method: 'cash', amount: 1000 });
  await call('POST', `/api/bills/${billId}/transfer`, { toTableId: to }, tok.host);
  await pay(billId, { method: 'cash' });
  assert.deepEqual([(await getBill(billId)).bill.status, await tableStatus(to), await tableStatus(from)], ['settled', 'free', 'free']);
});

// ---- shifts -------------------------------------------------------------------------------------------

test('a cashier can take cash with no open shift without error', async () => {
  const billId = await billOnNewTable([[BEER, 1]]);
  const r = await pay(billId, { method: 'cash' });
  assert.deepEqual([r.status, (await paidPayments(billId))[0].shift_id], [200, null]);
});

test('shift opening validates role, amount and uniqueness', async () => {
  const waiter = await call('POST', '/api/shifts/open', { openingCash: 0 }, tok.waiter);
  const negative = await call('POST', '/api/shifts/open', { openingCash: -1 }, tok.manager);
  const fraction = await call('POST', '/api/shifts/open', { openingCash: 1.5 }, tok.manager);
  const text = await call('POST', '/api/shifts/open', { openingCash: 'abc' }, tok.manager);
  assert.deepEqual([waiter.status, negative.status, fraction.status, text.status], [403, 422, 422, 422]);
});

test('only one shift can be open per cashier even when opened concurrently', async () => {
  const results = await Promise.all([1, 2, 3].map(() => call('POST', '/api/shifts/open', { openingCash: 100 }, tok.manager)));
  const closed = await call('POST', '/api/shifts/close', { countedCash: 100 }, tok.manager);
  assert.deepEqual([results.map((r) => r.status).sort(), closed.json.variance], [[200, 409, 409], 0]);
});

test('closing without an open shift is refused', async () => {
  assert.equal((await call('POST', '/api/shifts/close', { countedCash: 0 }, tok.cashier)).status, 404);
});

test('expected cash is opening cash plus only the cash taken during the shift', async () => {
  const phone = '13500000041';
  await topUp(phone, 10000);
  assert.equal((await call('GET', '/api/shifts/current', undefined, tok.cashier)).json, null);
  const open = await call('POST', '/api/shifts/open', { openingCash: 100000 }, tok.cashier);
  const cashBill = await billOnNewTable([[BEER, 2]]);
  const memberBill = await billOnNewTable([[BEER, 1]], 0, 0, { phone });
  const creditBill = await billOnNewTable([[BEER, 1]]);
  const onlineBill = await billOnNewTable([[BEER, 1]]);
  await pay(cashBill, { method: 'cash' });
  await pay(memberBill, { method: 'member' });
  await pay(creditBill, { method: 'credit' });
  const online = await startOnline(onlineBill);
  await notify('wechat', paidEvent(online.outTradeNo, online.amount));
  const current = (await call('GET', '/api/shifts/current', undefined, tok.cashier)).json;
  assert.deepEqual([open.status, current.expectedCash, current.byMethod.find((m: any) => m.method === 'cash').amount], [200, 100000 + 5600, 5600]);
});

test('closing records counted cash and the variance, and a second close is refused', async () => {
  const close = await call('POST', '/api/shifts/close', { countedCash: 105000 }, tok.cashier);
  const again = await call('POST', '/api/shifts/close', { countedCash: 105000 }, tok.cashier);
  assert.deepEqual([close.json.expectedCash, close.json.variance, again.status], [105600, -600, 404]);
});

test('cash taken after the shift closed does not change the closed shift', async () => {
  const billId = await billOnNewTable([[BEER, 1]]);
  await pay(billId, { method: 'cash' });
  const shifts = (await call('GET', '/api/shifts', undefined, tok.manager)).json;
  const closed = shifts.find((s: any) => s.counted_cash === 105000);
  assert.deepEqual([closed.expected_cash, closed.variance], [105600, -600]);
});

test('the shift list is hidden from cashiers', async () => {
  assert.equal((await call('GET', '/api/shifts', undefined, tok.cashier)).status, 403);
});

// ---- reports ---------------------------------------------------------------------------------------

test('daily revenue equals the paid payments of settled bills in the window', async () => {
  const report = (await call('GET', `/api/reports/daily?from=${suiteStart}&to=${Date.now() + 1000}`, undefined, tok.manager)).json;
  const expected = (await db.one(
    `SELECT COALESCE(SUM(p.amount),0) AS s, COUNT(DISTINCT b.id) AS n FROM payments p JOIN bills b ON b.id = p.bill_id
     WHERE b.store_id = 1 AND b.status = 'settled' AND p.status = 'paid' AND b.closed_at >= ?`, [suiteStart]))!;
  assert.deepEqual([report.revenue, report.bills], [expected.s, (await db.one("SELECT COUNT(*) AS n FROM bills WHERE store_id = 1 AND status = 'settled' AND closed_at >= ?", [suiteStart]))!.n]);
});

test('daily report breakdown by method sums to the revenue', async () => {
  const report = (await call('GET', `/api/reports/daily?from=${suiteStart}`, undefined, tok.finance)).json;
  assert.equal(report.byMethod.reduce((a: number, m: any) => a + m.amount, 0), report.revenue);
});

test('daily report flag counts match the audit trail', async () => {
  const report = (await call('GET', `/api/reports/daily?from=${suiteStart}`, undefined, tok.manager)).json;
  const audited = (await db.one(
    `SELECT COUNT(*) FILTER (WHERE action = 'order.void') AS v, COUNT(*) FILTER (WHERE action = 'order.gift') AS g,
            COUNT(*) FILTER (WHERE action = 'bill.discount') AS d FROM audit WHERE store_id = 1 AND ts >= ?`, [suiteStart]))!;
  assert.deepEqual([report.voids, report.gifts, report.discounts], [audited.v, audited.g, audited.d]);
});

test('daily report rejects garbage dates with a client error and hides from cashiers', async () => {
  const garbage = await call('GET', '/api/reports/daily?from=abc', undefined, tok.manager);
  const cashier = await call('GET', '/api/reports/daily', undefined, tok.cashier);
  assert.deepEqual([garbage.status >= 400 && garbage.status < 500, cashier.status], [true, 403]);
});

test('a window that closed before the sales shows no revenue', async () => {
  const report = (await call('GET', `/api/reports/daily?from=0&to=${suiteStart - 1}`, undefined, tok.manager)).json;
  assert.deepEqual([report.revenue, report.bills], [0, 0]);
});

// ---- global invariants ---------------------------------------------------------------------------------

test('every settled bill is fully paid', async () => {
  const settled = await db.all("SELECT id FROM bills WHERE status = 'settled'");
  const underpaid = [];
  for (const b of settled) if ((await totals(db, b.id)).due > 0) underpaid.push(b.id);
  assert.deepEqual(underpaid, []);
});

test('no open bill is paid beyond its total (except real money already received online)', async () => {
  const open = await db.all("SELECT id FROM bills WHERE status = 'open'");
  const over = [];
  for (const b of open) {
    const t = await totals(db, b.id);
    if (t.paid > t.total) over.push(b.id);
  }
  assert.deepEqual(over, []);
});

test('table occupancy matches open bills', async () => {
  const ghosts = await db.all(
    `SELECT t.id FROM dining_tables t WHERE (t.status = 'occupied') <> EXISTS (SELECT 1 FROM bills b WHERE b.table_id = t.id AND b.status = 'open')`);
  assert.deepEqual(ghosts, []);
});

test('wallet balance equals the sum of its ledger', async () => {
  const drift = await db.all(
    'SELECT m.id FROM members m WHERE m.balance <> COALESCE((SELECT SUM(delta) FROM wallet_ledger w WHERE w.member_id = m.id),0)');
  assert.deepEqual(drift, []);
});

test('seeded product stock equals the seed stock plus its movements', async () => {
  const seedStock: Record<number, number> = { 1: 24, 2: 30, 3: 400, 4: 100, 5: 200 };
  const drift = [];
  for (const [id, initial] of Object.entries(seedStock)) {
    const moved = (await db.one('SELECT COALESCE(SUM(delta),0) AS s FROM stock_movements WHERE product_id = ?', [Number(id)]))!.s;
    if ((await stockOf(Number(id))) !== initial + moved) drift.push(id);
  }
  assert.deepEqual(drift, []);
});

test('no bill has duplicate commission entries', async () => {
  const dup = await db.all('SELECT bill_id FROM commission_entries GROUP BY bill_id, employee_id, role HAVING COUNT(*) > 1');
  assert.deepEqual(dup, []);
});

test('self-heal finds nothing underpaid or negative after all this', async () => {
  const report = await selfHeal(db);
  assert.deepEqual(report.alerts.filter((a) => a.kind === 'settled_underpaid'), []);
});

test('no request in this suite produced a server error', () => {
  assert.deepEqual(serverErrors, []);
});
