import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { seed, DEMO_PINS } from '../src/seed.ts';

const ENV = { PAY_MODE: 'mock', MOCK_PAY_SECRET: 's3cret', PUBLIC_BASE_URL: 'http://venue.test' } as NodeJS.ProcessEnv;
const REP_ID = 7;
const BEER = 3; // ¥28
const BEER_FEN = 2800;
const RATE_BPS = 1000;
let db: Db;
let server: Server;
let base: string;
const staff: Record<string, string> = {};
const qr: Record<string, string> = {};

async function call(method: string, path: string, body?: unknown, token?: string, cookie = ''): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function guest(name: string): Promise<string> {
  const start = await fetch(`${base}/api/guest/auth/wechat/start?return=/g/doloruu`, { redirect: 'manual' });
  const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0];
  const state = new URL(start.headers.get('location')!, base).searchParams.get('state')!;
  const back = (await fetch(`${base}/api/guest/auth/wechat/callback?state=${state}&code=${encodeURIComponent(name)}`, { redirect: 'manual', headers: { Cookie: cookie } })).headers.get('location')!;
  const code = /#login=([0-9a-f]+)$/.exec(back)![1];
  return (await call('POST', '/api/guest/session', { code }, undefined, cookie)).json.token;
}

async function orderAndPay(token: string, table: string) {
  const { orderId } = (await call('POST', '/api/guest/orders', { qrToken: qr[table], items: [{ productId: BEER, qty: 1 }] }, token)).json;
  await call('POST', `/api/guest-orders/${orderId}/accept`, { repId: REP_ID }, staff.waiter);
  const charge = (await call('POST', `/api/guest/table/${qr[table]}/pay`, { method: 'wechat' }, token)).json;
  return call('POST', `/api/guest/payments/${charge.outTradeNo}/mock-pay`, {}, token);
}

const dist = (token: string) => call('GET', '/api/guest/distribution/doloruu', undefined, token);
const overview = async () => (await call('GET', '/api/distribution', undefined, staff.manager)).json;

/** A guest the manager has approved as a distributor; returns their token and code. */
async function distributor(name: string) {
  const token = await guest(name);
  await call('POST', '/api/guest/distribution/doloruu/apply', {}, token);
  const row = (await overview()).distributors.find((d: any) => d.name === name);
  await call('POST', `/api/distributors/${row.id}/approve`, {}, staff.manager);
  return { token, code: (await dist(token)).json.me.code as string, id: row.id as number };
}

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  await seed(db);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  for (const [k, username, pin] of [['waiter', 'flag.waiter', DEMO_PINS.waiter], ['manager', 'flag.manager', DEMO_PINS.manager], ['finance', 'finance', DEMO_PINS.finance]]) {
    staff[k] = (await call('POST', '/api/login', { company: 'doloruu', username, pin })).json.token;
  }
  for (const t of (await call('GET', '/api/tables', undefined, staff.manager)).json) qr[t.name] = t.qr_token;
});
after(async () => {
  server.close();
  await db.close();
});

test('distribution is hidden from guests until the company switches it on', async () => {
  const g = await guest('EarlyBird');
  assert.equal((await dist(g)).status, 404);
});

test('the manager switches distribution on with a commission rate', async () => {
  const r = await call('PATCH', '/api/distribution', { enabled: true, rateBps: RATE_BPS, minPayoutFen: 100 }, staff.manager);
  assert.deepEqual([r.json.enabled, r.json.rateBps], [true, RATE_BPS]);
});

test('a waiter cannot change distribution settings', async () => {
  assert.equal((await call('PATCH', '/api/distribution', { enabled: false }, staff.waiter)).status, 403);
});

test('a guest who applies waits for the manager', async () => {
  const g = await guest('Applicant');
  assert.equal((await call('POST', '/api/guest/distribution/doloruu/apply', {}, g)).json.status, 'pending');
});

test('nobody can join a distributor who is still waiting for approval', async () => {
  const pending = await guest('Applicant');
  const code = (await dist(pending)).json.me.code;
  const newbie = await guest('JoinsPending');
  assert.equal((await call('POST', '/api/guest/distribution/doloruu/join', { code }, newbie)).status, 404);
});

test('a guest who joined through a distributor earns them a share of each app payment', async () => {
  const d = await distributor('Dora');
  const newbie = await guest('DoraFriend');
  await call('POST', '/api/guest/distribution/doloruu/join', { code: d.code }, newbie);
  await orderAndPay(newbie, 'A1');
  assert.equal((await dist(d.token)).json.me.balanceFen, (BEER_FEN * RATE_BPS) / 10_000);
});

test('the distributor sees only the first character of a team member\'s name', async () => {
  const d = await distributor('Maskie');
  const newbie = await guest('Zelda');
  await call('POST', '/api/guest/distribution/doloruu/join', { code: d.code }, newbie);
  await orderAndPay(newbie, 'A2');
  assert.equal((await dist(d.token)).json.me.recent[0].guest, 'Z**');
});

test('a guest cannot join their own team', async () => {
  const d = await distributor('Selfie');
  assert.equal((await call('POST', '/api/guest/distribution/doloruu/join', { code: d.code }, d.token)).status, 422);
});

test('a guest who has paid here before cannot join a distributor', async () => {
  const d = await distributor('Poacher');
  const regular = await guest('Regular');
  await orderAndPay(regular, 'A3');
  assert.equal((await call('POST', '/api/guest/distribution/doloruu/join', { code: d.code }, regular)).status, 409);
});

test('a guest can join only one distributor', async () => {
  const first = await distributor('First');
  const second = await distributor('Second');
  const newbie = await guest('Loyal');
  await call('POST', '/api/guest/distribution/doloruu/join', { code: first.code }, newbie);
  assert.equal((await call('POST', '/api/guest/distribution/doloruu/join', { code: second.code }, newbie)).status, 409);
});

test('a stopped distributor earns nothing more', async () => {
  const d = await distributor('Stoppy');
  const newbie = await guest('StoppyFriend');
  await call('POST', '/api/guest/distribution/doloruu/join', { code: d.code }, newbie);
  await call('POST', `/api/distributors/${d.id}/stop`, {}, staff.manager);
  await orderAndPay(newbie, 'A4');
  assert.equal((await dist(d.token)).json.me.balanceFen, 0);
});

test('a personal rate replaces the company rate for that distributor', async () => {
  const d = await distributor('Vip');
  await call('PATCH', `/api/distributors/${d.id}`, { rateBps: 2000 }, staff.manager);
  const newbie = await guest('VipFriend');
  await call('POST', '/api/guest/distribution/doloruu/join', { code: d.code }, newbie);
  await orderAndPay(newbie, 'A5');
  assert.equal((await dist(d.token)).json.me.balanceFen, (BEER_FEN * 2000) / 10_000);
});

test('a payout request takes the amount off the balance', async () => {
  const d = await distributor('Payee');
  const newbie = await guest('PayeeFriend');
  await call('POST', '/api/guest/distribution/doloruu/join', { code: d.code }, newbie);
  await orderAndPay(newbie, 'A6');
  await call('POST', '/api/guest/distribution/doloruu/payout', { amountFen: 200, account: 'WeChat payee01' }, d.token);
  assert.equal((await dist(d.token)).json.me.balanceFen, 280 - 200);
});

test('a payout larger than the balance is refused', async () => {
  const d = await distributor('Greedy');
  const r = await call('POST', '/api/guest/distribution/doloruu/payout', { amountFen: 500, account: 'WeChat greedy' }, d.token);
  assert.equal(r.status, 402);
});

test('a payout below the company minimum is refused', async () => {
  await call('PATCH', '/api/distribution', { minPayoutFen: 1000 }, staff.manager);
  const d = await distributor('Tiny');
  const r = await call('POST', '/api/guest/distribution/doloruu/payout', { amountFen: 50, account: 'WeChat tiny' }, d.token);
  await call('PATCH', '/api/distribution', { minPayoutFen: 100 }, staff.manager);
  assert.equal(r.status, 422);
});

test('a manager without finance rights cannot mark a payout paid', async () => {
  const payout = (await overview()).payouts.find((p: any) => p.status === 'requested');
  assert.equal((await call('POST', `/api/distributor-payouts/${payout.id}/paid`, {}, staff.manager)).status, 403);
});

test('a rejected payout goes back to the distributor\'s balance', async () => {
  const payee = await guest('Payee');
  const payout = (await overview()).payouts.find((p: any) => p.name === 'Payee' && p.status === 'requested');
  await call('POST', `/api/distributor-payouts/${payout.id}/reject`, { note: 'wrong account' }, staff.finance);
  assert.equal((await dist(payee)).json.me.balanceFen, 280);
});

test('a payout cannot be decided twice', async () => {
  const payee = await guest('Payee');
  await call('POST', '/api/guest/distribution/doloruu/payout', { amountFen: 280, account: 'WeChat payee01' }, payee);
  const payout = (await overview()).payouts.find((p: any) => p.name === 'Payee' && p.status === 'requested');
  await call('POST', `/api/distributor-payouts/${payout.id}/paid`, {}, staff.finance);
  assert.equal((await call('POST', `/api/distributor-payouts/${payout.id}/reject`, {}, staff.finance)).status, 409);
});

test('the manager sees each distributor\'s team size and earnings', async () => {
  const row = (await overview()).distributors.find((d: any) => d.name === 'Dora');
  assert.deepEqual([row.team, row.earnedFen], [1, 280]);
});

test('with auto approve on, a new distributor can start straight away', async () => {
  await call('PATCH', '/api/distribution', { autoApprove: true }, staff.manager);
  const g = await guest('Instant');
  assert.equal((await call('POST', '/api/guest/distribution/doloruu/apply', {}, g)).json.status, 'active');
});
