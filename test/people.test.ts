import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { seed, DEMO_PINS } from '../src/seed.ts';

const ENV = { PAY_MODE: 'mock', MOCK_PAY_SECRET: 's3cret', PLATFORM_ADMIN_KEY: 'k', PUBLIC_BASE_URL: 'http://venue.test' } as NodeJS.ProcessEnv;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let db: Db;
let server: Server;
let base: string;
const tok: Record<string, string> = {};
const ids: Record<string, number> = {};

async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function signIn(key: string, username: string, pin: string) {
  const r = await call('POST', '/api/login', { company: 'doloruu', username, pin });
  tok[key] = r.json.token;
  ids[key] = r.json.actor.id;
}

const range = (from: number, to: number) => `from=${from}&to=${to}`;

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  await seed(db);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  await signIn('waiter', 'flag.waiter', DEMO_PINS.waiter);
  await signIn('cashier', 'flag.cashier', DEMO_PINS.cashier);
  await signIn('manager', 'flag.manager', DEMO_PINS.manager);
  await signIn('otherManager', 'lnge.manager', DEMO_PINS.manager);
  await signIn('lngeWaiter', 'lnge.waiter', DEMO_PINS.waiter);
  await signIn('finance', 'finance', DEMO_PINS.finance);
  await signIn('owner', 'owner', DEMO_PINS.owner);
});
after(async () => {
  server.close();
  await db.close();
});

// ---------- attendance ----------

test('a waiter can clock in', async () => {
  assert.equal((await call('POST', '/api/attendance/clock-in', {}, tok.waiter)).status, 200);
});

test('clocking in twice is refused', async () => {
  assert.equal((await call('POST', '/api/attendance/clock-in', {}, tok.waiter)).status, 409);
});

test('the till shows when a clocked-in waiter started', async () => {
  assert.equal(typeof (await call('GET', '/api/attendance/me', undefined, tok.waiter)).json.clockIn, 'number');
});

test('clocking out closes the open shift', async () => {
  await call('POST', '/api/attendance/clock-out', {}, tok.waiter);
  assert.equal((await call('GET', '/api/attendance/me', undefined, tok.waiter)).json, null);
});

test('clocking out without clocking in is refused', async () => {
  assert.equal((await call('POST', '/api/attendance/clock-out', {}, tok.cashier)).status, 409);
});

test("a manager sees their store's attendance", async () => {
  const rows = (await call('GET', `/api/attendance?${range(0, Date.now() + DAY)}`, undefined, tok.manager)).json;
  assert.ok(rows.some((r: any) => r.employeeId === ids.waiter && r.clockOut !== null));
});

test("a manager does not see another store's attendance", async () => {
  await call('POST', '/api/attendance/clock-in', {}, tok.lngeWaiter);
  const rows = (await call('GET', `/api/attendance?${range(0, Date.now() + DAY)}`, undefined, tok.manager)).json;
  assert.ok(!rows.some((r: any) => r.employeeId === ids.lngeWaiter));
});

test('a waiter cannot read the attendance sheet', async () => {
  assert.equal((await call('GET', '/api/attendance', undefined, tok.waiter)).status, 403);
});

test('a manager can add a shift someone forgot to clock', async () => {
  const clockIn = Date.now() - 10 * DAY;
  const r = await call('POST', '/api/attendance', { employeeId: ids.cashier, clockIn, clockOut: clockIn + 8 * HOUR, note: 'forgot phone' }, tok.manager);
  assert.equal(r.status, 200);
});

test('a shift longer than 24 hours is refused', async () => {
  const clockIn = Date.now() - 3 * DAY;
  assert.equal((await call('POST', '/api/attendance', { employeeId: ids.cashier, clockIn, clockOut: clockIn + 25 * HOUR }, tok.manager)).status, 422);
});

test('a shift ending in the future is refused', async () => {
  assert.equal((await call('POST', '/api/attendance', { employeeId: ids.cashier, clockIn: Date.now() - HOUR, clockOut: Date.now() + HOUR }, tok.manager)).status, 422);
});

test("a manager cannot add a shift for another store's staff", async () => {
  const clockIn = Date.now() - 2 * DAY;
  assert.equal((await call('POST', '/api/attendance', { employeeId: ids.lngeWaiter, clockIn, clockOut: clockIn + HOUR }, tok.manager)).status, 404);
});

test('a manager can fix a missed clock-out', async () => {
  const open = (await call('GET', '/api/attendance/me', undefined, tok.lngeWaiter)).json;
  const r = await call('PATCH', `/api/attendance/${open.id}`, { clockIn: open.clockIn, clockOut: open.clockIn + 1 }, tok.otherManager);
  assert.equal(r.status, 200);
});

test("a manager cannot edit another store's shift", async () => {
  const [row] = (await call('GET', `/api/attendance?${range(0, Date.now() + DAY)}`, undefined, tok.manager)).json;
  assert.equal((await call('PATCH', `/api/attendance/${row.id}`, { clockIn: row.clockIn - 2 * HOUR, clockOut: row.clockIn - HOUR }, tok.otherManager)).status, 404);
});

test('a waiter cannot edit shifts', async () => {
  const [row] = (await call('GET', `/api/attendance?${range(0, Date.now() + DAY)}`, undefined, tok.manager)).json;
  assert.equal((await call('PATCH', `/api/attendance/${row.id}`, { clockIn: row.clockIn, clockOut: row.clockIn + HOUR }, tok.waiter)).status, 403);
});

test('an edited shift keeps the old times in the activity log', async () => {
  const { rows } = (await call('GET', '/api/activity?action=attendance.edit', undefined, tok.otherManager)).json;
  assert.equal(typeof rows[0].detail.before.clockIn, 'number');
});

// ---------- salary ----------

test('finance can set an hourly rate', async () => {
  assert.equal((await call('PUT', `/api/staff-pay/${ids.cashier}`, { kind: 'hourly', rate: 3000 }, tok.finance)).status, 200);
});

test('a manager cannot set pay', async () => {
  assert.equal((await call('PUT', `/api/staff-pay/${ids.cashier}`, { kind: 'hourly', rate: 99999 }, tok.manager)).status, 403);
});

test('an unknown pay kind is refused', async () => {
  assert.equal((await call('PUT', `/api/staff-pay/${ids.cashier}`, { kind: 'weekly', rate: 100 }, tok.finance)).status, 422);
});

test('hourly pay is hours worked times the rate', async () => {
  const from = Date.now() - 11 * DAY;
  const rows = (await call('GET', `/api/salary?${range(from, Date.now())}`, undefined, tok.finance)).json;
  assert.equal(rows.find((r: any) => r.employeeId === ids.cashier).basePay, 8 * 3000);
});

test('a monthly salary is paid once for the period', async () => {
  await call('PUT', `/api/staff-pay/${ids.manager}`, { kind: 'monthly', rate: 800000 }, tok.owner);
  const rows = (await call('GET', `/api/salary?${range(Date.now() - 30 * DAY, Date.now())}`, undefined, tok.owner)).json;
  assert.equal(rows.find((r: any) => r.employeeId === ids.manager).total, 800000);
});

test('the salary sheet includes sales commission in the total', async () => {
  const from = Date.now() - 30 * DAY;
  const billId = await db.insert(
    "INSERT INTO bills (store_id, table_id, rep_id, status, opened_at) SELECT store_id, id, ?, 'settled', ? FROM dining_tables WHERE store_id = (SELECT store_id FROM employees WHERE id = ?) LIMIT 1",
    [ids.cashier, Date.now() - 2 * HOUR, ids.cashier]);
  await db.run('INSERT INTO commission_entries (bill_id, store_id, employee_id, role, amount, ts) SELECT id, store_id, ?, ?, ?, ? FROM bills WHERE id = ?', [ids.cashier, 'waiter', 500, Date.now() - HOUR, billId]);
  const rows = (await call('GET', `/api/salary?${range(from, Date.now())}`, undefined, tok.finance)).json;
  assert.equal(rows.find((r: any) => r.employeeId === ids.cashier).total, 8 * 3000 + 500);
});

test('a manager cannot read salaries', async () => {
  assert.equal((await call('GET', '/api/salary', undefined, tok.manager)).status, 403);
});

test('a manager reading the activity log does not see pay rates', async () => {
  const { rows } = (await call('GET', '/api/activity?action=staff.pay&all=1', undefined, tok.manager)).json;
  assert.ok(rows.every((r: any) => r.detail === null));
});

test('the old audit endpoint hides pay rates from managers too', async () => {
  const rows = (await call('GET', '/api/audit', undefined, tok.manager)).json;
  assert.ok(rows.filter((r: any) => r.action === 'staff.pay').every((r: any) => r.detail === null));
});

test('finance sees pay rates in the activity log', async () => {
  const { rows } = (await call('GET', '/api/activity?action=staff.pay', undefined, tok.finance)).json;
  assert.equal(rows[0].detail.kind, 'monthly');
});

// ---------- broadcasts ----------

test('a manager can send a message to staff', async () => {
  assert.equal((await call('POST', '/api/broadcasts', { audience: 'staff', title: 'Team meeting 6pm', body: 'Bar area' }, tok.manager)).status, 200);
});

test("staff of the manager's store see the message", async () => {
  const news = (await call('GET', '/api/news', undefined, tok.waiter)).json;
  assert.equal(news[0].title, 'Team meeting 6pm');
});

test("staff of another store do not see a store manager's message", async () => {
  const news = (await call('GET', '/api/news', undefined, tok.lngeWaiter)).json;
  assert.ok(!news.some((n: any) => n.title === 'Team meeting 6pm'));
});

test("staff of every store see the owner's message", async () => {
  await call('POST', '/api/broadcasts', { audience: 'staff', title: 'Holiday hours' }, tok.owner);
  const news = (await call('GET', '/api/news', undefined, tok.lngeWaiter)).json;
  assert.ok(news.some((n: any) => n.title === 'Holiday hours'));
});

test('a waiter cannot send a broadcast', async () => {
  assert.equal((await call('POST', '/api/broadcasts', { audience: 'staff', title: 'Hi' }, tok.waiter)).status, 403);
});

test('a broadcast needs a title', async () => {
  assert.equal((await call('POST', '/api/broadcasts', { audience: 'staff', title: ' ' }, tok.manager)).status, 422);
});

test('a broadcast cannot stay up longer than 90 days', async () => {
  assert.equal((await call('POST', '/api/broadcasts', { audience: 'guests', title: 'Forever', days: 91 }, tok.manager)).status, 422);
});

test("customers see a message for guests on the company's page", async () => {
  await call('POST', '/api/broadcasts', { audience: 'guests', title: 'Ladies night Friday', body: 'Free entry' }, tok.manager);
  const venue = (await call('GET', '/api/guest/venue/doloruu')).json;
  assert.equal(venue.news[0].title, 'Ladies night Friday');
});

test('customers do not see messages meant for staff', async () => {
  const venue = (await call('GET', '/api/guest/venue/doloruu')).json;
  assert.ok(!venue.news.some((n: any) => n.title === 'Team meeting 6pm'));
});

test('customer news does not name the staff member who wrote it', async () => {
  const venue = (await call('GET', '/api/guest/venue/doloruu')).json;
  assert.equal(venue.news[0].author, undefined);
});

test('a stopped message disappears for customers', async () => {
  const [latest] = (await call('GET', '/api/broadcasts', undefined, tok.manager)).json;
  await call('POST', `/api/broadcasts/${latest.id}/stop`, {}, tok.manager);
  const venue = (await call('GET', '/api/guest/venue/doloruu')).json;
  assert.ok(!venue.news.some((n: any) => n.id === latest.id));
});

test("a store manager cannot stop the owner's company-wide message", async () => {
  const owners = (await call('GET', '/api/broadcasts', undefined, tok.owner)).json;
  const holiday = owners.find((b: any) => b.title === 'Holiday hours');
  assert.equal((await call('POST', `/api/broadcasts/${holiday.id}/stop`, {}, tok.manager)).status, 404);
});

// ---------- activity log ----------

test('the activity log names the staff member', async () => {
  const { rows } = (await call('GET', '/api/activity?action=broadcast.create', undefined, tok.manager)).json;
  assert.equal(rows[0].staffName, 'Manager FLAG');
});

test('the activity log can be filtered by staff member', async () => {
  const { rows } = (await call('GET', `/api/activity?staff=${ids.waiter}`, undefined, tok.manager)).json;
  assert.ok(rows.length > 0 && rows.every((r: any) => r.staffId === ids.waiter));
});

test('an action filter with % is taken literally', async () => {
  const { rows } = (await call('GET', '/api/activity?action=%25', undefined, tok.manager)).json;
  assert.deepEqual(rows, []);
});

test('a waiter cannot read the activity log', async () => {
  assert.equal((await call('GET', '/api/activity', undefined, tok.waiter)).status, 403);
});
