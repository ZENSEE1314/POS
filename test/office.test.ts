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
let ipSeq = 0;
const staff: Record<string, string> = {};
let salesDept: { id: number; joinCode: string };

async function call(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const login = async (username: string, pin: string) => (await call('POST', '/api/login', { company: 'doloruu', username, pin })).json.token;
const join = (body: Record<string, unknown>) => call('POST', '/api/join',
  { company: 'doloruu', joinCode: salesDept.joinCode, name: 'New Rep', pin: '9090', phone: '13711112222', ...body },
  undefined, { 'x-forwarded-for': `192.0.2.${++ipSeq}` });
const ask = (token: string, body: Record<string, unknown>) => call('POST', '/api/requests', body, token);
const pendingFor = async (detail: string) => (await call('GET', '/api/approvals', undefined, staff.manager)).json.find((r: any) => r.detail === detail);

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  await seed(db);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  staff.manager = await login('flag.manager', DEMO_PINS.manager);
  staff.waiter = await login('flag.waiter', DEMO_PINS.waiter);
  staff.rep = await login('flag.rep', DEMO_PINS.rep);
  staff.owner = await login('owner', DEMO_PINS.owner);
  const { id } = (await call('POST', '/api/departments', { name: 'Sales team 1', defaultRole: 'host' }, staff.manager)).json;
  salesDept = (await call('GET', '/api/departments', undefined, staff.manager)).json.find((d: any) => d.id === id);
});
after(async () => {
  server.close();
  await db.close();
});

// ---------- departments and joining ----------

test('a new department gets a six-character join code', () => {
  assert.match(salesDept.joinCode, /^[A-HJ-NP-Z2-9]{6}$/);
});

test('a waiter does not see department join codes', async () => {
  const d = (await call('GET', '/api/departments', undefined, staff.waiter)).json.find((x: any) => x.id === salesDept.id);
  assert.equal(d.joinCode, undefined);
});

test('a wrong join code is refused', async () => {
  assert.equal((await join({ joinCode: 'ZZZZZZ', username: 'nobody1' })).status, 404);
});

test('someone who joined with a code cannot sign in before approval', async () => {
  await join({ username: 'waiting.rep' });
  assert.equal((await call('POST', '/api/login', { company: 'doloruu', username: 'waiting.rep', pin: '9090' })).status, 401);
});

test('an approved join can sign in with the PIN they chose', async () => {
  await join({ username: 'new.rep' });
  const j = (await call('GET', '/api/joins', undefined, staff.manager)).json.find((x: any) => x.username === 'new.rep');
  await call('POST', `/api/joins/${j.id}/approve`, {}, staff.manager);
  const r = await call('POST', '/api/login', { company: 'doloruu', username: 'new.rep', pin: '9090' });
  assert.deepEqual([r.status, r.json.actor.role], [200, 'host']);
});

test('an approved join lands in the department it used the code of', async () => {
  await join({ username: 'dept.rep' });
  const j = (await call('GET', '/api/joins', undefined, staff.manager)).json.find((x: any) => x.username === 'dept.rep');
  const { employeeId } = (await call('POST', `/api/joins/${j.id}/approve`, {}, staff.manager)).json;
  const e = (await call('GET', '/api/staff', undefined, staff.manager)).json.find((x: any) => x.id === employeeId);
  assert.equal(e.departmentId, salesDept.id);
});

test('a manager cannot approve a join as a manager', async () => {
  await join({ username: 'wants.boss' });
  const j = (await call('GET', '/api/joins', undefined, staff.manager)).json.find((x: any) => x.username === 'wants.boss');
  assert.equal((await call('POST', `/api/joins/${j.id}/approve`, { role: 'manager' }, staff.manager)).status, 403);
});

test('joining with a username already taken is a 409', async () => {
  assert.equal((await join({ username: 'flag.waiter' })).status, 409);
});

test('a new join code stops the old one working', async () => {
  const old = salesDept.joinCode;
  const { joinCode } = (await call('POST', `/api/departments/${salesDept.id}/code`, {}, staff.manager)).json;
  salesDept.joinCode = joinCode;
  assert.equal((await join({ joinCode: old, username: 'late.rep' })).status, 404);
});

// ---------- requests and approvals ----------

test('an approved missed clock-in adds the shift to attendance', async () => {
  const clockIn = Date.now() - 30 * HOUR;
  await ask(staff.waiter, { kind: 'missed_clock', detail: 'phone died', startAt: clockIn, endAt: clockIn + 6 * HOUR });
  await call('POST', `/api/approvals/${(await pendingFor('phone died')).id}`, { approve: true }, staff.manager);
  const shifts = (await call('GET', `/api/attendance?from=${clockIn - 1}&to=${clockIn + 1}`, undefined, staff.manager)).json;
  assert.ok(shifts.some((s: any) => s.clockIn === clockIn && s.clockOut === clockIn + 6 * HOUR));
});

test('leave without dates is a 422', async () => {
  assert.equal((await ask(staff.waiter, { kind: 'leave', detail: 'family' })).status, 422);
});

test('an expense without an amount is a 422', async () => {
  assert.equal((await ask(staff.waiter, { kind: 'expense', detail: 'ice' })).status, 422);
});

test('the person who asked sees the decision and the note', async () => {
  await ask(staff.waiter, { kind: 'expense', detail: 'taxi for stock run', amount: 4500 });
  await call('POST', `/api/approvals/${(await pendingFor('taxi for stock run')).id}`, { approve: false, note: 'use the van' }, staff.manager);
  const mine = (await call('GET', '/api/requests/mine', undefined, staff.waiter)).json.find((r: any) => r.detail === 'taxi for stock run');
  assert.deepEqual([mine.status, mine.decisionNote], ['rejected', 'use the van']);
});

test('a manager cannot approve their own request', async () => {
  await ask(staff.manager, { kind: 'other', detail: 'manager own request' });
  assert.equal((await call('POST', `/api/approvals/${(await pendingFor('manager own request')).id}`, { approve: true }, staff.manager)).status, 403);
});

test('a waiter cannot open the approval inbox', async () => {
  assert.equal((await call('GET', '/api/approvals', undefined, staff.waiter)).status, 403);
});

test('a cancelled request leaves the inbox', async () => {
  const { id } = (await ask(staff.waiter, { kind: 'other', detail: 'changed my mind' })).json;
  await call('POST', `/api/requests/${id}/cancel`, {}, staff.waiter);
  assert.equal(await pendingFor('changed my mind'), undefined);
});

// ---------- customers ----------

test('the sales rep on a table becomes the owner of that customer', async () => {
  const reps = (await call('GET', '/api/reps', undefined, staff.manager)).json;
  const rep = reps.find((r: any) => r.name === 'Sales FLAG');
  const tables = (await call('GET', '/api/tables', undefined, staff.manager)).json;
  await call('POST', '/api/bills', { tableId: tables.find((x: any) => x.status === 'free').id, repId: rep.id, phone: '13655556666' }, staff.manager);
  assert.ok((await call('GET', '/api/customers/mine', undefined, staff.rep)).json.some((c: any) => c.phone === '13655556666'));
});

test('a customer who never settled a bill counts as dormant for their rep', async () => {
  assert.ok((await call('GET', '/api/customers/dormant', undefined, staff.rep)).json.some((c: any) => c.phone === '13655556666'));
});

test('a manager can move a customer to another rep', async () => {
  const c = (await call('GET', '/api/customers?q=13655556666', undefined, staff.manager)).json[0];
  const waiterId = (await call('GET', '/api/staff', undefined, staff.manager)).json.find((s: any) => s.username === 'flag.waiter').id;
  await call('POST', '/api/customers/assign', { memberIds: [c.id], ownerId: waiterId }, staff.manager);
  assert.ok((await call('GET', '/api/customers/mine', undefined, staff.waiter)).json.some((x: any) => x.id === c.id));
});

test('when a rep leaves, their customers go back to the venue', async () => {
  const c = (await call('GET', '/api/customers?q=13655556666', undefined, staff.manager)).json[0];
  await ask(staff.waiter, { kind: 'resign', detail: 'moving city' });
  await call('POST', `/api/approvals/${(await pendingFor('moving city')).id}`, { approve: true }, staff.owner);
  const after = (await call('GET', '/api/customers?q=13655556666', undefined, staff.manager)).json[0];
  assert.deepEqual([c.ownerId !== null, after.ownerId], [true, null]);
});
