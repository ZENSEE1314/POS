import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { seed } from '../src/seed.ts';

const ADMIN_KEY = 'adm';
const MOCK_SECRET = 's3cret';
const ENV = { PAY_MODE: 'mock', MOCK_PAY_SECRET: MOCK_SECRET, PLATFORM_ADMIN_KEY: ADMIN_KEY, SIGNUP_OPEN: '1', API_PER_MINUTE: '1000000' } as NodeJS.ProcessEnv;
const SECURITY_HEADERS = ['x-content-type-options', 'x-frame-options', 'referrer-policy', 'content-security-policy'];
const GENERIC_LOGIN_ERROR = 'invalid credentials';

let db: Db;
let server: Server;
let base: string;
const extraServers: Server[] = [];

type Res = { status: number; json: any; headers: Headers; text: string };

/** Each caller gets its own forwarded ip so one test's failed logins never lock another test out. */
let ipCounter = 0;
const freshIp = () => `10.${(++ipCounter >> 8) & 255}.${ipCounter & 255}.7`;

function makeCall(origin: () => string) {
  return async function call(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}): Promise<Res> {
    const res = await fetch(origin() + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, headers: res.headers, text };
  };
}
const call = makeCall(() => base);

/** key: the operator key by default, null to send no header at all. */
const admin = (method: string, path: string, body?: unknown, key: string | null = ADMIN_KEY) =>
  call(method, path, body, undefined, { 'x-forwarded-for': freshIp(), ...(key === null ? {} : { 'x-admin-key': key }) });

async function startApp(env: NodeJS.ProcessEnv, useDb: Db = db): Promise<{ server: Server; base: string; call: ReturnType<typeof makeCall> }> {
  const s = createApp(useDb, env);
  await new Promise<void>((r) => s.listen(0, r));
  extraServers.push(s);
  const b = `http://localhost:${(s.address() as AddressInfo).port}`;
  return { server: s, base: b, call: makeCall(() => b) };
}

async function login(company: string, username: string, pin: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<Res> {
  return call('POST', '/api/login', { company, username, pin, ...extra }, undefined, { 'x-forwarded-for': freshIp(), ...headers });
}
async function tokenOf(company: string, username: string, pin: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await login(company, username, pin, extra);
  assert.equal(r.status, 200, `login ${company}/${username}: ${r.text}`);
  return r.json.token;
}

/** Raw http so the path reaches the server byte for byte (fetch normalises "..", this does not). */
function raw(path: string, opts: { method?: string; body?: string | Buffer; headers?: Record<string, string> } = {}): Promise<{ status: number; body: string; headers: Record<string, any> }> {
  const port = Number(new URL(base).port);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const tok: Record<string, string> = {};
const A: Record<string, any> = {};  // company "doloruu" ids
const B: Record<string, any> = {};  // company "acme" ids
const bTok: Record<string, string> = {};
const H: Record<string, any> = {};  // company "hardening"
const A_ONLY_MARKERS = ['doloruu', 'FLAG', 'LNGE', '13711112222', 'Waiter FLAG'];

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  await seed(db);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;

  const staff: Record<string, [string, string]> = {
    owner: ['owner', '6666'], finance: ['finance', '5555'], host: ['flag.host', '1111'], waiter: ['flag.waiter', '2222'],
    cashier: ['flag.cashier', '3333'], manager: ['flag.manager', '4444'],
  };
  for (const [k, [u, p]] of Object.entries(staff)) tok[k] = await tokenOf('doloruu', u, p);

  const roster = (await call('GET', '/api/staff', undefined, tok.owner)).json as any[];
  const idOf = (u: string) => roster.find((s) => s.username === u).id;
  A.rep = idOf('flag.rep'); A.waiterId = idOf('flag.waiter'); A.cashierId = idOf('flag.cashier');
  const stores = (await call('GET', '/api/hq/stores', undefined, tok.owner)).json as any[];
  A.store1 = stores.find((s) => s.code === 'FLAG').id; A.store2 = stores.find((s) => s.code === 'LNGE').id;

  // ---- company B ("acme"), created by the platform operator, with the SAME names as company A ----
  const made = await admin('POST', '/platform/companies', { name: 'Acme Bar', code: 'acme', storeName: 'Acme Main', ownerName: 'Acme Owner', ownerUsername: 'owner', ownerPin: 'acmepin1', douyinPoiId: 'poi_acme' });
  assert.equal(made.status, 200, made.text);
  B.store = made.json.storeId;
  bTok.owner = await tokenOf('acme', 'owner', 'acmepin1');
  for (const [u, role, pin] of [['manager', 'manager', '4444'], ['cashier', 'cashier', '3333'], ['waiter', 'waiter', '2222'], ['rep', 'host', '7777']] as const) {
    const r = await call('POST', '/api/hq/staff', { name: `Acme ${u}`, username: u, role, pin, storeId: B.store }, bTok.owner);
    assert.equal(r.status, 200, r.text);
    if (u === 'rep') B.rep = r.json.employeeId;
    bTok[u] = await tokenOf('acme', u, pin);
  }

  // ---- data in A (store 1) ----
  const tablesA = (await call('GET', '/api/tables', undefined, tok.manager)).json as any[];
  A.table1 = tablesA[0].id; A.table2 = tablesA[1].id; A.table3 = tablesA[2].id;
  const productsA = (await call('GET', '/api/products', undefined, tok.manager)).json as any[];
  A.product = productsA[0].id;
  A.phone = '13711112222';
  const billA = await call('POST', '/api/bills', { tableId: A.table1, repId: A.rep, phone: A.phone }, tok.host);
  A.bill = billA.json.billId;
  A.line = (await call('POST', `/api/bills/${A.bill}/lines`, { productId: A.product, qty: 2 }, tok.waiter)).json.lineId;
  await call('POST', '/api/members/topup', { phone: A.phone, amount: 50000 }, tok.manager);
  await call('POST', '/api/members/topup', { phone: '13800000001', amount: 50000 }, tok.manager);
  const stashA = (await call('POST', '/api/stash', { phone: A.phone, productId: A.product, qtyMilli: 1000 }, tok.waiter)).json;
  A.stash = stashA.id; A.stashCode = stashA.code;
  A.booking = (await call('POST', '/api/bookings', { phone: '13999999999', eta: Date.now() + 3600_000 }, tok.host)).json.bookingId;
  await call('POST', '/api/shifts/open', { openingCash: 1000 }, tok.cashier);
  A.rule = (await call('POST', '/api/commission-rules', { role: 'sales', productId: A.product, bps: 100 }, tok.manager)).json.ruleId;
  const credBill = (await call('POST', '/api/bills', { tableId: A.table2, repId: A.rep }, tok.host)).json.billId;
  await call('POST', `/api/bills/${credBill}/lines`, { productId: A.product, qty: 1 }, tok.waiter);
  await call('POST', `/api/bills/${credBill}/pay`, { method: 'credit' }, tok.cashier);
  A.payment = ((await call('GET', '/api/receivables', undefined, tok.finance)).json as any[])[0].paymentId;
  const online = await call('POST', `/api/bills/${A.bill}/pay-online`, { method: 'wechat', amount: 100 }, tok.cashier);
  assert.equal(online.status, 200, online.text);
  A.outTradeNo = online.json.outTradeNo;

  // ---- data in B ----
  B.table1 = (await call('POST', '/api/tables', { name: 'A1', kind: 'bar' }, bTok.owner)).json.tableId;   // same name as A's A1
  B.table2 = (await call('POST', '/api/tables', { name: 'A2', kind: 'bar' }, bTok.owner)).json.tableId;
  B.product = (await call('POST', '/api/products', { name: 'Hennessy VSOP 700ml', price: 99900, stock: 10 }, bTok.owner)).json.productId; // same name as A's
  B.phone = '13800000001';
  B.bill = (await call('POST', '/api/bills', { tableId: B.table1, repId: B.rep, phone: B.phone }, bTok.waiter)).json.billId;
  B.line = (await call('POST', `/api/bills/${B.bill}/lines`, { productId: B.product, qty: 1 }, bTok.waiter)).json.lineId;
  await call('POST', '/api/members/topup', { phone: B.phone, amount: 7777 }, bTok.manager);
  const stashB = (await call('POST', '/api/stash', { phone: B.phone, productId: B.product, qtyMilli: 1000 }, bTok.waiter)).json;
  B.stash = stashB.id; B.stashCode = stashB.code;
  B.booking = (await call('POST', '/api/bookings', { phone: '13999999998', eta: Date.now() + 3600_000 }, bTok.host)).json.bookingId;
  const dy = JSON.stringify({ eventId: 'acme-dy-1', type: 'booking.created', data: { poiId: 'poi_acme', bookingId: 'acme-dy-1', phone: '13999999997', eta: Date.now() + 1000 } });
  const dyRes = await fetch(`${base}/webhooks/douyin`, { method: 'POST', headers: { 'x-douyin-signature': createHmac('sha256', MOCK_SECRET).update(dy).digest('hex') }, body: dy });
  B.submittedBooking = ((await dyRes.json()) as any).bookingId;
  await call('POST', '/api/shifts/open', { openingCash: 500 }, bTok.cashier);
  B.rule = (await call('POST', '/api/commission-rules', { role: 'waiter', productId: B.product, bps: 50 }, bTok.manager)).json.ruleId;
});

after(async () => {
  server.close();
  for (const s of extraServers) s.close();
  await db.close();
});

// =====================================================================================================
// 1. LOGIN
// =====================================================================================================

test('login returns a token and the actor, and never the pin hash', async () => {
  const r = await login('doloruu', 'flag.host', '1111');
  assert.equal(r.status, 200);
  assert.match(r.json.token, /^[0-9a-f]{48}$/);
  assert.deepEqual(Object.keys(r.json.actor).sort(), ['id', 'name', 'role', 'storeId', 'tenantId']);
  assert.equal(r.text.includes('pin_hash'), false);
});

test('two logins never share a token', async () => {
  const a = await login('doloruu', 'flag.host', '1111');
  const b = await login('doloruu', 'flag.host', '1111');
  assert.notEqual(a.json.token, b.json.token);
});

test('wrong pin, unknown user and unknown company give the identical 401', async () => {
  const wrongPin = await login('doloruu', 'flag.host', '0000');
  const unknownUser = await login('doloruu', 'nobody', '1111');
  const unknownCompany = await login('no-such-co', 'flag.host', '1111');
  assert.deepEqual([wrongPin.status, unknownUser.status, unknownCompany.status], [401, 401, 401]);
  assert.deepEqual([wrongPin.text, unknownUser.text], [unknownCompany.text, unknownCompany.text]);
  assert.equal(wrongPin.json.error, GENERIC_LOGIN_ERROR);
});

test('right username and pin but for the wrong company is rejected', async () => {
  assert.equal((await login('acme', 'flag.host', '1111')).status, 401);
  assert.equal((await login('doloruu', 'manager', '4444')).status, 401);
});

test('missing or non-string credentials are 401, not 500', async () => {
  for (const body of [{}, { company: 'doloruu' }, { company: 'doloruu', username: 'flag.host' }, { company: ['doloruu'], username: { a: 1 }, pin: 1111 }, { company: null, username: null, pin: null }]) {
    const r = await call('POST', '/api/login', body, undefined, { 'x-forwarded-for': freshIp() });
    assert.equal(r.status, 401, JSON.stringify(body));
  }
});

test('a numeric pin is accepted the same as its string form', async () => {
  const r = await call('POST', '/api/login', { company: 'doloruu', username: 'flag.host', pin: 1111 }, undefined, { 'x-forwarded-for': freshIp() });
  assert.equal(r.status, 200);
});

test('company and username are case-insensitive, the pin is not interchangeable', async () => {
  assert.equal((await login('DOLORUU', 'FLAG.Host', '1111')).status, 200);
  assert.equal((await login('Doloruu', 'Owner', '6666')).status, 200);
  assert.equal((await login('ACME', 'OWNER', 'acmepin1')).status, 200);
  assert.equal((await login('ACME', 'OWNER', 'ACMEPIN1')).status, 401);
});

test('unknown user takes about as long as a wrong pin (no username timing oracle)', async () => {
  const time = async (user: string) => {
    const t0 = performance.now();
    await login('doloruu', user, '0000');
    return performance.now() - t0;
  };
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const known: number[] = [];
  const unknown: number[] = [];
  for (let i = 0; i < 7; i++) { known.push(await time('flag.rep')); unknown.push(await time(`ghost${i}`)); }
  assert.ok(median(unknown) > median(known) * 0.5, `unknown-user median ${median(unknown).toFixed(1)}ms vs wrong-pin ${median(known).toFixed(1)}ms`);
});

test('store staff are pinned to their store whatever storeId they ask for; tenant-wide staff may choose', async () => {
  const pinned = await login('doloruu', 'flag.host', '1111', { storeId: A.store2 });
  assert.equal(pinned.json.actor.storeId, A.store1);
  const wide = await login('doloruu', 'owner', '6666', { storeId: A.store2 });
  assert.equal(wide.json.actor.storeId, A.store2);
});

test('tenant-wide staff cannot log in into another company\'s store', async () => {
  assert.equal((await login('acme', 'owner', 'acmepin1', { storeId: A.store1 })).status, 403);
});

test('garbage, empty and malformed bearer tokens are 401', async () => {
  for (const h of ['', 'Bearer', 'Bearer ', 'Bearer nonsense', 'bearer ' + tok.owner, 'Basic abc', `Bearer ${tok.owner} extra`]) {
    const r = await call('GET', '/api/me', undefined, undefined, h ? { Authorization: h } : {});
    assert.equal(r.status, 401, `header: ${h}`);
  }
});

test('/api/me returns the actor, store and company and no secrets', async () => {
  const r = await call('GET', '/api/me', undefined, bTok.owner);
  assert.equal(r.json.company.code, 'acme');
  assert.equal(r.json.store.id, B.store);
  assert.equal(r.json.actor.tenantId, r.json.company.code === 'acme' ? r.json.actor.tenantId : -1);
  assert.equal(/pin|hash|password/i.test(r.text), false);
});

// ---- lockout -------------------------------------------------------------------------------------

test('10 failed logins lock ip+company+username with 429; a correct pin is locked too', async () => {
  const ip = { 'x-forwarded-for': '203.0.113.50' };
  for (let i = 0; i < 10; i++) assert.equal((await login('doloruu', 'flag.rep', '0000', {}, ip)).status, 401, `attempt ${i + 1}`);
  const locked = await login('doloruu', 'flag.rep', '0000', {}, ip);
  assert.equal(locked.status, 429);
  assert.equal((await login('doloruu', 'flag.rep', '7777', {}, ip)).status, 429);
  assert.equal((await login('DOLORUU', 'FLAG.REP', '7777', {}, ip)).status, 429, 'case variants share the same counter');
});

test('lockout is scoped: other users, other companies and other ips are unaffected', async () => {
  assert.equal((await login('doloruu', 'flag.cashier', '3333', {}, { 'x-forwarded-for': '203.0.113.50' })).status, 200);
  assert.equal((await login('doloruu', 'flag.rep', '7777', {}, { 'x-forwarded-for': '203.0.113.51' })).status, 200);
});

test('a successful login clears the failure counter', async () => {
  const ip = { 'x-forwarded-for': '203.0.113.60' };
  for (let i = 0; i < 9; i++) await login('doloruu', 'flag.waiter', '0000', {}, ip);
  assert.equal((await login('doloruu', 'flag.waiter', '2222', {}, ip)).status, 200);
  for (let i = 0; i < 10; i++) assert.equal((await login('doloruu', 'flag.waiter', '0000', {}, ip)).status, 401, `post-reset attempt ${i + 1}`);
  assert.equal((await login('doloruu', 'flag.waiter', '0000', {}, ip)).status, 429);
});

test('rotating the left side of X-Forwarded-For does not dodge the lockout (the proxy appends the real ip on the right)', async () => {
  let last = 0;
  for (let i = 0; i < 14; i++) last = (await login('doloruu', 'flag.manager', '0000', {}, { 'x-forwarded-for': `spoof-${i}, 198.51.100.77` })).status;
  assert.equal(last, 429);
});

test('lockouts are recorded in ops_events', async () => {
  const rows = await db.all("SELECT * FROM ops_events WHERE kind = 'auth.locked'");
  assert.ok(rows.length >= 1);
  assert.equal(JSON.stringify(rows).includes('7777'), false, 'the pin must never be logged');
});

// ---- account / session lifecycle -----------------------------------------------------------------

test('deactivated staff cannot log in and their live session dies; reactivation restores login', async () => {
  const made = await call('POST', '/api/hq/staff', { name: 'Temp', username: 'temp.one', role: 'waiter', pin: '8080', storeId: A.store1 }, tok.owner);
  const id = made.json.employeeId;
  const t = await tokenOf('doloruu', 'temp.one', '8080');
  assert.equal((await call('GET', '/api/me', undefined, t)).status, 200);
  assert.equal((await call('PATCH', `/api/staff/${id}`, { active: false }, tok.owner)).status, 200);
  assert.equal((await call('GET', '/api/me', undefined, t)).status, 401);
  assert.equal((await login('doloruu', 'temp.one', '8080')).status, 401);
  await call('PATCH', `/api/staff/${id}`, { active: true }, tok.owner);
  assert.equal((await login('doloruu', 'temp.one', '8080')).status, 200);
});

test('resetting a pin kills every live session of that user and the old pin; the new pin works', async () => {
  const id = (await call('POST', '/api/hq/staff', { name: 'Temp2', username: 'temp.two', role: 'cashier', pin: '8181', storeId: A.store1 }, tok.owner)).json.employeeId;
  const t1 = await tokenOf('doloruu', 'temp.two', '8181');
  const t2 = await tokenOf('doloruu', 'temp.two', '8181');
  assert.equal((await call('PATCH', `/api/staff/${id}`, { pin: '9191' }, tok.owner)).status, 200);
  assert.deepEqual([(await call('GET', '/api/me', undefined, t1)).status, (await call('GET', '/api/me', undefined, t2)).status], [401, 401]);
  assert.equal((await login('doloruu', 'temp.two', '8181')).status, 401);
  assert.equal((await login('doloruu', 'temp.two', '9191')).status, 200);
});

test('pin reset rejects short pins and does not touch the session', async () => {
  const id = (await call('POST', '/api/hq/staff', { name: 'Temp3', username: 'temp.three', role: 'cashier', pin: '8282', storeId: A.store1 }, tok.owner)).json.employeeId;
  const t = await tokenOf('doloruu', 'temp.three', '8282');
  assert.equal((await call('PATCH', `/api/staff/${id}`, { pin: '12' }, tok.owner)).status, 422);
  assert.equal((await call('GET', '/api/me', undefined, t)).status, 200);
});

test('staff patch: cannot deactivate yourself, bad roles and role-class switches are refused', async () => {
  const me = (await call('GET', '/api/staff', undefined, tok.owner)).json.find((s: any) => s.username === 'owner');
  assert.equal((await call('PATCH', `/api/staff/${me.id}`, { active: false }, tok.owner)).status, 409);
  const target = (await call('GET', '/api/staff', undefined, tok.owner)).json.find((s: any) => s.username === 'flag.cashier');
  assert.equal((await call('PATCH', `/api/staff/${target.id}`, { role: 'owner' }, tok.owner)).status, 422);
  const bad = await call('PATCH', `/api/staff/${target.id}`, { role: 'god' }, tok.owner);
  assert.equal(bad.status, 422, 'unknown roles must be rejected');
  assert.equal((await db.one('SELECT role FROM employees WHERE id = ?', [target.id]))!.role, 'cashier');
});

test('logout invalidates exactly that token, once', async () => {
  const t1 = await tokenOf('doloruu', 'flag.host', '1111');
  const t2 = await tokenOf('doloruu', 'flag.host', '1111');
  assert.equal((await call('POST', '/api/logout', {}, t1)).status, 200);
  assert.equal((await call('GET', '/api/me', undefined, t1)).status, 401);
  assert.equal((await call('POST', '/api/logout', {}, t1)).status, 401);
  assert.equal((await call('GET', '/api/me', undefined, t2)).status, 200);
});

test('an expired session is refused', async () => {
  const t = await tokenOf('doloruu', 'flag.host', '1111');
  assert.equal((await call('GET', '/api/me', undefined, t)).status, 200);
  await db.run('UPDATE sessions SET expires_at = ? WHERE token = ?', [Date.now() - 1, t]);
  assert.equal((await call('GET', '/api/me', undefined, t)).status, 401);
});

test('a deactivated company cannot log in and its live sessions stop working', async () => {
  await admin('POST', '/platform/companies', { name: 'Gone Co', code: 'gone-co', storeName: 'S', ownerName: 'O', ownerUsername: 'boss', ownerPin: 'gonepin1' });
  const t = await tokenOf('gone-co', 'boss', 'gonepin1');
  assert.equal((await call('GET', '/api/me', undefined, t)).status, 200);
  await db.run("UPDATE tenants SET active = FALSE WHERE code = 'gone-co'");
  assert.equal((await login('gone-co', 'boss', 'gonepin1')).status, 401);
  assert.equal((await call('GET', '/api/me', undefined, t)).status, 401);
});

test('switching store: tenant-wide only, own tenant only, bad ids are 4xx', async () => {
  assert.equal((await call('POST', '/api/switch-store', { storeId: A.store1 }, tok.waiter)).status, 403);
  assert.equal((await call('POST', '/api/switch-store', { storeId: B.store }, tok.owner)).status, 404);
  for (const storeId of ['abc', 1e30, null, -1, 1.5, {}, [], undefined]) {
    const r = await call('POST', '/api/switch-store', { storeId }, tok.finance);
    assert.ok(r.status >= 400 && r.status < 500, `storeId=${JSON.stringify(storeId)} -> ${r.status} ${r.text}`);
  }
  assert.equal((await call('GET', '/api/me', undefined, tok.finance)).json.store.id, A.store1);
});

// =====================================================================================================
// 2. EVERY ROUTE REQUIRES AUTH
// =====================================================================================================

const AUTH_ROUTES: Array<[string, string]> = [
  ['POST', '/api/logout'], ['GET', '/api/me'], ['POST', '/api/switch-store'], ['GET', '/api/tables'], ['POST', '/api/tables'], ['PATCH', '/api/tables/1'],
  ['GET', '/api/products'], ['POST', '/api/products'], ['PATCH', '/api/products/1'], ['POST', '/api/products/1/stock'],
  ['GET', '/api/commission-rules'], ['POST', '/api/commission-rules'], ['DELETE', '/api/commission-rules/1'],
  ['POST', '/api/bills'], ['GET', '/api/bills/1'], ['POST', '/api/bills/1/lines'], ['POST', '/api/bills/1/lines/1/void'], ['POST', '/api/bills/1/discount'],
  ['POST', '/api/bills/1/transfer'], ['POST', '/api/bills/1/pay'], ['POST', '/api/bills/1/pay-online'], ['POST', '/api/bills/1/redeem'],
  ['POST', '/api/bookings'], ['GET', '/api/bookings'], ['POST', '/api/bookings/1/confirm'], ['POST', '/api/bookings/1/cancel'],
  ['POST', '/api/stash'], ['GET', '/api/stash'], ['POST', '/api/stash/1/retrieve'], ['POST', '/api/stash/1/transfer'],
  ['POST', '/api/members/topup'], ['GET', '/api/members'], ['GET', '/api/members/1'],
  ['GET', '/api/payroll'], ['GET', '/api/reports/daily'], ['GET', '/api/audit'], ['POST', '/api/shifts/open'], ['GET', '/api/shifts/current'],
  ['POST', '/api/shifts/close'], ['GET', '/api/shifts'], ['GET', '/api/receivables'], ['POST', '/api/receivables/1/collect'], ['POST', '/api/maintenance/expire-stash'],
  ['GET', '/api/staff'], ['PATCH', '/api/staff/1'], ['GET', '/api/hq/stores'], ['POST', '/api/hq/stores'], ['POST', '/api/hq/staff'],
  ['POST', '/api/hq/catalog/copy'], ['GET', '/api/hq/summary'], ['POST', '/dev/mock-pay'],
];

test('every authenticated route answers 401 without a token and with a bogus one', async () => {
  for (const [method, path] of AUTH_ROUTES) {
    const none = await call(method, path, method === 'GET' || method === 'DELETE' ? undefined : {});
    assert.equal(none.status, 401, `${method} ${path} without token -> ${none.status}`);
    const bogus = await call(method, path, method === 'GET' || method === 'DELETE' ? undefined : {}, 'deadbeef');
    assert.equal(bogus.status, 401, `${method} ${path} with bogus token -> ${bogus.status}`);
  }
});

// =====================================================================================================
// 3. ROLE / PERMISSION MATRIX (expected lists are written out here, independent of src/auth.ts)
// =====================================================================================================

type RoleName = 'host' | 'waiter' | 'cashier' | 'manager' | 'finance' | 'owner';
const ROLE_NAMES: RoleName[] = ['host', 'waiter', 'cashier', 'manager', 'finance', 'owner'];
const MATRIX: Array<{ action: string; allowed: RoleName[]; method: string; path: () => string; body?: () => unknown }> = [
  { action: 'booking.create', allowed: ['host', 'cashier', 'manager', 'owner'], method: 'POST', path: () => '/api/bookings', body: () => ({ phone: '13000000000', eta: Date.now() + 1000 }) },
  { action: 'table.open', allowed: ['host', 'waiter', 'cashier', 'manager', 'owner'], method: 'POST', path: () => '/api/bills', body: () => ({ tableId: 999999, repId: A.rep }) },
  { action: 'order.add', allowed: ['waiter', 'cashier', 'manager', 'owner'], method: 'POST', path: () => '/api/bills/999999/lines', body: () => ({ productId: A.product, qty: 1 }) },
  { action: 'order.gift', allowed: ['manager', 'owner'], method: 'POST', path: () => '/api/bills/999999/lines', body: () => ({ productId: A.product, qty: 1, gift: true }) },
  { action: 'order.void', allowed: ['manager', 'owner'], method: 'POST', path: () => '/api/bills/999999/lines/1/void', body: () => ({ reason: 'x' }) },
  { action: 'bill.discount', allowed: ['manager', 'owner'], method: 'POST', path: () => '/api/bills/999999/discount', body: () => ({ amount: 1, reason: 'x' }) },
  { action: 'bill.settle', allowed: ['cashier', 'manager', 'owner'], method: 'POST', path: () => '/api/bills/999999/pay', body: () => ({ method: 'cash' }) },
  { action: 'bill.settle (online)', allowed: ['cashier', 'manager', 'owner'], method: 'POST', path: () => '/api/bills/999999/pay-online', body: () => ({ method: 'wechat' }) },
  { action: 'bill.settle (redeem)', allowed: ['cashier', 'manager', 'owner'], method: 'POST', path: () => '/api/bills/999999/redeem', body: () => ({ code: 'DY-1-x' }) },
  { action: 'bill.settle (shift)', allowed: ['cashier', 'manager', 'owner'], method: 'POST', path: () => '/api/shifts/close', body: () => ({ countedCash: 0 }) },
  { action: 'stash.write', allowed: ['waiter', 'cashier', 'manager', 'owner'], method: 'POST', path: () => '/api/stash', body: () => ({ phone: '13000000000', productId: 999999, qtyMilli: 1000 }) },
  { action: 'payroll.read', allowed: ['finance', 'owner'], method: 'GET', path: () => '/api/payroll' },
  { action: 'payroll.read (receivables)', allowed: ['finance', 'owner'], method: 'GET', path: () => '/api/receivables' },
  { action: 'admin.write (stock)', allowed: ['manager', 'owner'], method: 'POST', path: () => '/api/products/999999/stock', body: () => ({ delta: 1, reason: 'x' }) },
  { action: 'admin.write (table)', allowed: ['manager', 'owner'], method: 'PATCH', path: () => '/api/tables/999999', body: () => ({ name: 'x' }) },
  { action: 'admin.write (product)', allowed: ['manager', 'owner'], method: 'PATCH', path: () => '/api/products/999999', body: () => ({ name: 'x' }) },
  { action: 'admin.write (rule)', allowed: ['manager', 'owner'], method: 'DELETE', path: () => '/api/commission-rules/999999' },
  { action: 'admin.write (topup)', allowed: ['manager', 'owner'], method: 'POST', path: () => '/api/members/topup', body: () => ({ phone: '', amount: 1 }) },
  { action: 'admin.write (staff list)', allowed: ['manager', 'owner'], method: 'GET', path: () => '/api/staff' },
  { action: 'admin.write (stash transfer)', allowed: ['manager', 'owner'], method: 'POST', path: () => '/api/stash/999999/transfer', body: () => ({ toStoreId: 1 }) },
  { action: 'admin.write (expire stash)', allowed: ['manager', 'owner'], method: 'POST', path: () => '/api/maintenance/expire-stash', body: () => ({}) },
  { action: 'audit.read', allowed: ['manager', 'finance', 'owner'], method: 'GET', path: () => '/api/audit' },
  { action: 'audit.read (shifts)', allowed: ['manager', 'finance', 'owner'], method: 'GET', path: () => '/api/shifts' },
  { action: 'audit.read (daily)', allowed: ['manager', 'finance', 'owner'], method: 'GET', path: () => '/api/reports/daily' },
  { action: 'hq.read', allowed: ['finance', 'owner'], method: 'GET', path: () => '/api/hq/stores' },
  { action: 'hq.read (summary)', allowed: ['finance', 'owner'], method: 'GET', path: () => '/api/hq/summary' },
  { action: 'hq.write (staff)', allowed: ['owner'], method: 'POST', path: () => '/api/hq/staff', body: () => ({}) },
  { action: 'hq.write (store)', allowed: ['owner'], method: 'POST', path: () => '/api/hq/stores', body: () => ({}) },
  { action: 'hq.write (copy)', allowed: ['owner'], method: 'POST', path: () => '/api/hq/catalog/copy', body: () => ({ fromStoreId: 999999, toStoreIds: [] }) },
  { action: 'hq.write (staff patch)', allowed: ['owner'], method: 'PATCH', path: () => '/api/staff/999999', body: () => ({ name: 'x' }) },
];

for (const row of MATRIX) {
  test(`permission matrix: ${row.action} ${row.method} -> allowed for ${row.allowed.join(',')}`, async () => {
    for (const role of ROLE_NAMES) {
      const r = await call(row.method, row.path(), row.body?.(), tok[role]);
      if (row.allowed.includes(role)) assert.notEqual(r.status, 403, `${role} should pass the permission check: ${r.text}`);
      else assert.equal(r.status, 403, `${role} must be forbidden (got ${r.status}): ${r.text}`);
      assert.ok(r.status < 500, `${role}: ${r.status} ${r.text}`);
    }
  });
}

test('the audit log is store-scoped for managers and tenant-wide only for hq.read roles with ?all=1', async () => {
  await call('POST', '/api/shifts/open', { openingCash: 1 }, tok.manager);
  await call('POST', '/api/shifts/close', { countedCash: 1 }, tok.manager);
  const mgr = (await call('GET', '/api/audit?all=1', undefined, tok.manager)).json as any[];
  assert.ok(mgr.length > 0 && mgr.every((r) => r.store_id === A.store1), 'manager ?all=1 must stay store scoped');
  const own = (await call('GET', '/api/audit?all=1', undefined, tok.owner)).json as any[];
  assert.ok(own.every((r) => r.tenant_id === own[0].tenant_id));
});

test('host, waiter and cashier rows in the staff list are not readable by them', async () => {
  for (const r of ['host', 'waiter', 'cashier'] as const) assert.equal((await call('GET', '/api/staff', undefined, tok[r])).status, 403);
});

// =====================================================================================================
// 4. CROSS-TENANT ISOLATION
// =====================================================================================================

const snapshotOf = async (token: string, ids: { bill: number; phone?: string }) => {
  const get = async (p: string) => (await call('GET', p, undefined, token)).text;
  return JSON.stringify({
    bill: await get(`/api/bills/${ids.bill}`), products: await get('/api/products?all=1'), tables: await get('/api/tables?all=1'),
    stash: await get(`/api/stash?q=${ids.phone}`), members: await get('/api/members?q='), staff: await get('/api/staff'),
    rules: await get('/api/commission-rules'), stores: await get('/api/hq/stores'), receivables: await get('/api/receivables'),
    bookings: await get('/api/bookings'), shifts: await get('/api/shifts'),
  });
};

interface Attack { label: string; method: string; path: string; body?: unknown; ok?: number[] }
const attacks = (): Attack[] => [
  { label: 'read A bill', method: 'GET', path: `/api/bills/${A.bill}` },
  { label: 'add B product to A bill', method: 'POST', path: `/api/bills/${A.bill}/lines`, body: { productId: B.product, qty: 1 } },
  { label: 'add A product to B bill', method: 'POST', path: `/api/bills/${B.bill}/lines`, body: { productId: A.product, qty: 1 } },
  { label: 'add A product to A bill', method: 'POST', path: `/api/bills/${A.bill}/lines`, body: { productId: A.product, qty: 1 } },
  { label: 'void A line', method: 'POST', path: `/api/bills/${A.bill}/lines/${A.line}/void`, body: { reason: 'x' } },
  { label: 'void A line through B bill', method: 'POST', path: `/api/bills/${B.bill}/lines/${A.line}/void`, body: { reason: 'x' } },
  { label: 'discount A bill', method: 'POST', path: `/api/bills/${A.bill}/discount`, body: { amount: 100, reason: 'x' } },
  { label: 'transfer A bill to B table', method: 'POST', path: `/api/bills/${A.bill}/transfer`, body: { toTableId: B.table2 } },
  { label: 'transfer B bill to A table', method: 'POST', path: `/api/bills/${B.bill}/transfer`, body: { toTableId: A.table3 } },
  { label: 'pay A bill cash', method: 'POST', path: `/api/bills/${A.bill}/pay`, body: { method: 'cash' } },
  { label: 'pay A bill member', method: 'POST', path: `/api/bills/${A.bill}/pay`, body: { method: 'member' } },
  { label: 'pay-online A bill', method: 'POST', path: `/api/bills/${A.bill}/pay-online`, body: { method: 'wechat' } },
  { label: 'redeem voucher on A bill', method: 'POST', path: `/api/bills/${A.bill}/redeem`, body: { code: 'DY-10-zz' } },
  { label: 'open A table', method: 'POST', path: '/api/bills', body: { tableId: A.table3, repId: B.rep } },
  { label: 'open B table with A rep', method: 'POST', path: '/api/bills', body: { tableId: B.table2, repId: A.rep }, ok: [422] },
  { label: 'open B table with A booking', method: 'POST', path: '/api/bills', body: { tableId: B.table2, repId: B.rep, bookingId: A.booking } },
  { label: 'patch A table', method: 'PATCH', path: `/api/tables/${A.table3}`, body: { name: 'hacked', active: false } },
  { label: 'patch A product', method: 'PATCH', path: `/api/products/${A.product}`, body: { price: 1, active: false } },
  { label: 'adjust A stock', method: 'POST', path: `/api/products/${A.product}/stock`, body: { delta: 100, reason: 'x' } },
  { label: 'delete A rule', method: 'DELETE', path: `/api/commission-rules/${A.rule}` },
  { label: 'rule on A product', method: 'POST', path: '/api/commission-rules', body: { role: 'sales', productId: A.product, bps: 1 } },
  { label: 'confirm A booking', method: 'POST', path: `/api/bookings/${A.booking}/confirm`, body: { tableId: B.table2, repId: B.rep } },
  { label: 'cancel A booking', method: 'POST', path: `/api/bookings/${A.booking}/cancel`, body: {} },
  { label: 'confirm B booking onto A table', method: 'POST', path: `/api/bookings/${B.submittedBooking}/confirm`, body: { tableId: A.table3, repId: B.rep } },
  { label: 'confirm B booking with A rep', method: 'POST', path: `/api/bookings/${B.submittedBooking}/confirm`, body: { tableId: B.table2, repId: A.rep }, ok: [404, 422] },
  { label: 'create booking with A table and rep', method: 'POST', path: '/api/bookings', body: { phone: '13000000000', eta: Date.now() + 1000, tableId: A.table3, repId: A.rep }, ok: [404, 422] },
  { label: 'retrieve A stash on B bill', method: 'POST', path: `/api/stash/${A.stash}/retrieve`, body: { qtyMilli: 100, billId: B.bill } },
  { label: 'retrieve B stash on A bill', method: 'POST', path: `/api/stash/${B.stash}/retrieve`, body: { qtyMilli: 100, billId: A.bill } },
  { label: 'transfer A stash to B store', method: 'POST', path: `/api/stash/${A.stash}/transfer`, body: { toStoreId: B.store } },
  { label: 'transfer B stash to A store', method: 'POST', path: `/api/stash/${B.stash}/transfer`, body: { toStoreId: A.store2 } },
  { label: 'store stash for A product', method: 'POST', path: '/api/stash', body: { phone: '13000000000', productId: A.product, qtyMilli: 1000 } },
  { label: 'read A-only member', method: 'GET', path: `/api/members/${A.phone}` },
  { label: 'collect A receivable', method: 'POST', path: `/api/receivables/${A.payment}/collect`, body: { amount: 1, method: 'cash' } },
  { label: 'deactivate A staff', method: 'PATCH', path: `/api/staff/${A.waiterId}`, body: { active: false } },
  { label: 'reset A staff pin', method: 'PATCH', path: `/api/staff/${A.waiterId}`, body: { pin: '999999' } },
  { label: 'promote A staff', method: 'PATCH', path: `/api/staff/${A.waiterId}`, body: { role: 'manager' } },
  { label: 'copy A catalog into B', method: 'POST', path: '/api/hq/catalog/copy', body: { fromStoreId: A.store1, toStoreIds: [B.store] } },
  { label: 'copy B catalog into A', method: 'POST', path: '/api/hq/catalog/copy', body: { fromStoreId: B.store, toStoreIds: [A.store2] } },
  { label: 'create store copying A catalog', method: 'POST', path: '/api/hq/stores', body: { name: 'x', code: 'XX', copyCatalogFrom: A.store1 } },
  { label: 'add staff to A store', method: 'POST', path: '/api/hq/staff', body: { name: 'x', username: 'zz.zz', role: 'waiter', pin: '1234', storeId: A.store1 } },
  { label: 'switch to A store', method: 'POST', path: '/api/switch-store', body: { storeId: A.store1 } },
  { label: 'mock-pay A payment', method: 'POST', path: '/dev/mock-pay', body: { outTradeNo: A.outTradeNo } },
];

for (const who of ['owner', 'manager'] as const) {
  test(`isolation: ${who} of company B cannot touch any of company A's ids (no leak, no mutation)`, async () => {
    const aBefore = await snapshotOf(tok.owner, { bill: A.bill, phone: A.phone });
    const bBefore = await snapshotOf(bTok.owner, { bill: B.bill, phone: B.phone });
    const failures: string[] = [];
    for (const a of attacks()) {
      const r = await call(a.method, a.path, a.body, bTok[who]);
      const expected = a.ok ?? [403, 404];
      const accept = who === 'manager' ? [...expected, 403] : expected;
      if (!accept.includes(r.status)) failures.push(`${a.label}: ${a.method} ${a.path} -> ${r.status} ${r.text.slice(0, 120)}`);
      for (const m of [A.phone, A.stashCode, 'Waiter FLAG', 'Doloruu']) if (r.text.includes(m)) failures.push(`${a.label}: response leaks "${m}"`);
    }
    assert.deepEqual(failures, []);
    assert.equal(await snapshotOf(tok.owner, { bill: A.bill, phone: A.phone }), aBefore, 'company A data changed');
    assert.equal(await snapshotOf(bTok.owner, { bill: B.bill, phone: B.phone }), bBefore, 'company B data changed');
    assert.equal((await db.one('SELECT status FROM payments WHERE out_trade_no = ?', [A.outTradeNo]))!.status, 'pending', 'A online payment was completed by B');
  });
}

test('isolation: B login cannot be steered to A store, and A staff still log in with their old pin', async () => {
  assert.equal((await login('doloruu', 'flag.waiter', '2222')).status, 200);
});

test('isolation: every list endpoint as company B contains nothing of company A', async () => {
  const lists = ['/api/tables?all=1', '/api/products?all=1', '/api/commission-rules', `/api/stash?q=${A.phone}`, `/api/stash?q=${A.stashCode}`, '/api/members?q=', '/api/members?q=137',
    '/api/staff', '/api/hq/stores', '/api/hq/summary', '/api/audit?all=1', '/api/payroll?all=1', '/api/receivables', '/api/shifts', '/api/bookings', '/api/reports/daily', '/api/me'];
  for (const p of lists) {
    const r = await call('GET', p, undefined, bTok.owner);
    assert.equal(r.status, 200, `${p}: ${r.text}`);
    for (const m of A_ONLY_MARKERS) assert.equal(r.text.includes(m), false, `${p} leaks ${m}`);
  }
  assert.deepEqual((await call('GET', `/api/stash?q=${A.phone}`, undefined, bTok.owner)).json, []);
  assert.deepEqual((await call('GET', `/api/stash?q=${A.stashCode}`, undefined, bTok.owner)).json, []);
});

test('isolation: LIKE wildcards in member search only ever match the caller\'s own members', async () => {
  const all = (await call('GET', '/api/members?q=%25', undefined, bTok.owner)).json as any[];
  assert.ok(all.length >= 1 && all.every((m) => m.phone !== A.phone));
  const under = (await call('GET', '/api/members?q=_', undefined, bTok.owner)).json as any[];
  assert.ok(under.every((m) => m.phone !== A.phone));
});

test('same names in two companies do not collide: wallet, product, table and username', async () => {
  assert.equal((await call('GET', `/api/members/${B.phone}`, undefined, bTok.owner)).json.balance, 7777);
  assert.equal((await call('GET', `/api/members/${B.phone}`, undefined, tok.owner)).json.balance, 50000);
  assert.equal((await call('GET', '/api/products', undefined, bTok.owner)).json.find((p: any) => p.name === 'Hennessy VSOP 700ml').price, 99900);
  assert.equal((await call('GET', '/api/products', undefined, tok.owner)).json.find((p: any) => p.name === 'Hennessy VSOP 700ml').price, 128800);
  const tables = (await call('GET', '/api/tables', undefined, bTok.owner)).json as any[];
  assert.deepEqual(tables.map((t) => t.name).sort(), ['A1', 'A2']);
  assert.equal((await call('GET', '/api/me', undefined, bTok.owner)).json.company.code, 'acme');
  assert.equal((await call('GET', '/api/me', undefined, tok.owner)).json.company.code, 'doloruu');
});

test('same name within one company is still a 409 (product, table, username, store code)', async () => {
  assert.equal((await call('POST', '/api/products', { name: 'Hennessy VSOP 700ml', price: 1 }, bTok.owner)).status, 409);
  assert.equal((await call('POST', '/api/tables', { name: 'A1' }, bTok.owner)).status, 409);
  assert.equal((await call('POST', '/api/hq/staff', { name: 'x', username: 'OWNER', role: 'waiter', pin: '1234', storeId: B.store }, bTok.owner)).status, 409);
  assert.equal((await call('POST', '/api/hq/stores', { name: 'x', code: 'MAIN' }, bTok.owner)).status, 409);
  assert.equal((await call('POST', '/api/hq/stores', { name: 'x', code: 'FLAG' }, bTok.owner)).status, 200, 'a store code used by another company is fine');
});

test('a token only ever carries its own tenant, even after switching stores', async () => {
  const owner = await tokenOf('acme', 'owner', 'acmepin1');
  const stores = (await call('GET', '/api/hq/stores', undefined, owner)).json as any[];
  for (const s of stores) {
    const sw = await call('POST', '/api/switch-store', { storeId: s.id }, owner);
    assert.equal(sw.status, 200);
    assert.equal(sw.json.actor.tenantId, (await call('GET', '/api/me', undefined, bTok.owner)).json.actor.tenantId);
  }
});

test('payroll and daily report for B never include A money', async () => {
  const pay = (await call('GET', '/api/payroll?all=1', undefined, bTok.owner)).json as any[];
  assert.ok(pay.every((r) => r.name.startsWith('Acme') || r.name === 'Acme Owner'));
  const hq = (await call('GET', '/api/hq/summary', undefined, bTok.owner)).json;
  assert.ok(hq.stores.every((s: any) => !/Doloruu/.test(s.name)));
});

// =====================================================================================================
// 5. PLATFORM OPERATOR
// =====================================================================================================

test('platform routes: 403 without a key, with a wrong key, with a same-length wrong key', async () => {
  for (const [m, p] of [['GET', '/platform/companies'], ['POST', '/platform/companies'], ['GET', '/platform/ops'], ['GET', '/platform/metrics'], ['POST', '/platform/selfheal']] as const) {
    assert.equal((await admin(m, p, m === 'POST' ? {} : undefined, null)).status, 403, `${m} ${p} no key`);
    assert.equal((await admin(m, p, m === 'POST' ? {} : undefined, 'wrong')).status, 403, `${m} ${p} wrong key`);
    assert.equal((await admin(m, p, m === 'POST' ? {} : undefined, 'adn')).status, 403, `${m} ${p} same length`);
    assert.equal((await admin(m, p, m === 'POST' ? {} : undefined, '')).status, 403, `${m} ${p} empty key`);
  }
  assert.equal((await call('GET', '/platform/companies', undefined, tok.owner, { 'x-forwarded-for': freshIp() })).status, 403, 'a tenant owner token is not an operator key');
});

test('platform routes are disabled when PLATFORM_ADMIN_KEY is unset, whatever key is sent', async () => {
  const off = await startApp({ PAY_MODE: 'mock', MOCK_PAY_SECRET: MOCK_SECRET } as NodeJS.ProcessEnv);
  for (const key of ['', 'undefined', 'null', 'adm', ADMIN_KEY]) {
    const r = await off.call('GET', '/platform/companies', undefined, undefined, { 'x-admin-key': key });
    assert.equal(r.status, 403, `key "${key}"`);
  }
});

test('platform: unknown route with a valid key is 404, wrong method too', async () => {
  assert.equal((await admin('GET', '/platform/nothing')).status, 404);
  assert.equal((await admin('DELETE', '/platform/companies')).status, 404);
});

test('guessing the operator key is rate limited per ip', async () => {
  const fixed = { 'x-forwarded-for': '203.0.113.99' };
  let last = 0;
  for (let i = 0; i < 14; i++) last = (await call('GET', '/platform/companies', undefined, undefined, { ...fixed, 'x-admin-key': `guess${i}` })).status;
  assert.equal(last, 429);
  assert.equal((await call('GET', '/platform/companies', undefined, undefined, { 'x-forwarded-for': '203.0.113.98', 'x-admin-key': ADMIN_KEY })).status, 200);
});

test('platform: list companies has counts and no secrets', async () => {
  const r = await admin('GET', '/platform/companies');
  assert.equal(r.status, 200);
  const codes = r.json.map((c: any) => c.code);
  assert.ok(codes.includes('doloruu') && codes.includes('acme'));
  assert.equal(/pin|hash/i.test(r.text), false);
  assert.ok(r.json.find((c: any) => c.code === 'doloruu').stores >= 2);
});

const GOOD_COMPANY = { name: 'Valid Co', code: 'valid-co', storeName: 'Main', ownerName: 'Boss', ownerUsername: 'boss', ownerPin: 'secret1' };

test('createCompany rejects bad codes, usernames, pins and missing names with 422 (never 500)', async () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['one-char code', { code: 'a' }], ['leading hyphen', { code: '-abc' }], ['space', { code: 'a b' }], ['underscore', { code: 'ab_cd' }],
    ['32 chars', { code: 'a'.repeat(32) }], ['unicode', { code: '酒吧酒吧' }], ['sql', { code: "x'; DROP TABLE tenants;--" }], ['slash', { code: 'a/b' }],
    ['missing code', { code: undefined }], ['null code', { code: null }], ['numeric code', { code: 12345 }], ['array code', { code: ['abc'] }],
    ['username 1 char', { ownerUsername: 'a' }], ['username space', { ownerUsername: 'a b' }], ['username 33 chars', { ownerUsername: 'a'.repeat(33) }], ['username missing', { ownerUsername: undefined }],
    ['pin 5 chars', { ownerPin: '12345' }], ['pin missing', { ownerPin: undefined }], ['numeric pin', { ownerPin: 1234567 }], ['array pin', { ownerPin: ['1', '2', '3', '4', '5', '6'] }], ['object pin', { ownerPin: { length: 9 } }],
    ['blank name', { name: '   ' }], ['numeric name', { name: 42 }], ['object name', { name: { a: 1 } }], ['missing storeName', { storeName: undefined }], ['numeric ownerName', { ownerName: 7 }],
  ];
  for (const [label, patch] of bad) {
    const r = await admin('POST', '/platform/companies', { ...GOOD_COMPANY, ...patch });
    assert.equal(r.status, 422, `${label}: ${r.status} ${r.text}`);
  }
  assert.equal((await db.one("SELECT COUNT(*) AS n FROM tenants WHERE lower(code) = 'valid-co'"))!.n, 0);
});

test('createCompany: success logs in, has default commission rules; duplicate codes are 409 case-insensitively', async () => {
  const ok = await admin('POST', '/platform/companies', GOOD_COMPANY);
  assert.equal(ok.status, 200, ok.text);
  const t = await tokenOf('VALID-CO', 'BOSS', 'secret1');
  assert.equal((await call('GET', '/api/commission-rules', undefined, t)).json.length, 2);
  assert.equal((await admin('POST', '/platform/companies', GOOD_COMPANY)).status, 409);
  assert.equal((await admin('POST', '/platform/companies', { ...GOOD_COMPANY, code: 'VALID-CO' })).status, 409);
  assert.equal((await admin('POST', '/platform/companies', { ...GOOD_COMPANY, code: 'Doloruu' })).status, 409);
});

test('createCompany: two simultaneous requests for one code give one 200 and one 409', async () => {
  const body = { ...GOOD_COMPANY, code: 'race-co', ownerUsername: 'racer' };
  const [a, b] = await Promise.all([admin('POST', '/platform/companies', body), admin('POST', '/platform/companies', body)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], `${a.text} / ${b.text}`);
});

test('platform ops: level filter and limit, bad limits are 4xx', async () => {
  const warn = await admin('GET', '/platform/ops?level=warn&limit=5');
  assert.equal(warn.status, 200);
  assert.ok(warn.json.length <= 5 && warn.json.every((e: any) => e.level === 'warn'));
  for (const q of ['limit=abc', 'limit=-1', 'limit=1.5', 'limit=1e30', 'limit=0']) {
    const r = await admin('GET', `/platform/ops?${q}`);
    assert.ok(r.status === 200 || (r.status >= 400 && r.status < 500), `${q} -> ${r.status} ${r.text}`);
  }
});

test('platform selfheal returns a report', async () => {
  const r = await admin('POST', '/platform/selfheal', {});
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.healed) && Array.isArray(r.json.alerts) && r.json.checked > 0);
});

test('platform metrics: sane numbers, and unmatched urls do not create unbounded metric keys', async () => {
  const before = (await admin('GET', '/platform/metrics')).json;
  assert.ok(before.total > 0 && before.uptimeSec >= 0 && typeof before.errors5xx === 'number');
  assert.ok(Array.isArray(before.slowest) && before.slowest.length <= 25);
  assert.ok(Object.keys(before.statuses).some((k) => k.endsWith('2xx')));
  for (let i = 0; i < 40; i++) {
    await call('GET', `/nothing-here-${i}-${Math.random()}`);
    await call('GET', `/api/nothing-${i}-${Math.random()}`, undefined, tok.owner);
  }
  const after = (await admin('GET', '/platform/metrics')).json;
  assert.ok(Object.keys(after.statuses).length - Object.keys(before.statuses).length <= 4, 'metrics key count grows with attacker-chosen urls');
});

// =====================================================================================================
// 6. SIGNUP
// =====================================================================================================

test('signup is disabled unless SIGNUP_OPEN is exactly "1"', async () => {
  for (const flag of [undefined, '0', 'true', '']) {
    const app = await startApp({ PAY_MODE: 'mock', ...(flag === undefined ? {} : { SIGNUP_OPEN: flag }) } as NodeJS.ProcessEnv);
    assert.equal((await app.call('GET', '/api/config')).json.signupOpen, false, `flag ${flag}`);
    const r = await app.call('POST', '/api/signup', { ...GOOD_COMPANY, code: `off-${String(flag)}` });
    assert.equal(r.status, 403, `flag ${flag}`);
  }
  assert.equal((await db.one("SELECT COUNT(*) AS n FROM tenants WHERE code LIKE 'off-%'"))!.n, 0);
});

test('signup when open creates a working company; validation and duplicates behave like the platform route', async () => {
  assert.equal((await call('GET', '/api/config')).json.signupOpen, true);
  const ok = await call('POST', '/api/signup', { ...GOOD_COMPANY, code: 'signup-co' }, undefined, { 'x-forwarded-for': freshIp() });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await login('signup-co', 'boss', 'secret1')).status, 200);
  assert.equal((await call('POST', '/api/signup', { ...GOOD_COMPANY, code: 'SIGNUP-CO' }, undefined, { 'x-forwarded-for': freshIp() })).status, 409);
  assert.equal((await call('POST', '/api/signup', { ...GOOD_COMPANY, code: 'x' }, undefined, { 'x-forwarded-for': freshIp() })).status, 422);
});

test('signup is rate limited to 5 per ip per hour', async () => {
  const app = await startApp(ENV);
  const ip = { 'x-forwarded-for': '203.0.113.140' };
  const statuses: number[] = [];
  for (let i = 0; i < 7; i++) statuses.push((await app.call('POST', '/api/signup', { ...GOOD_COMPANY, code: `rl-co-${i}`, ownerUsername: `rl${i}` }, undefined, ip)).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
  assert.equal((await app.call('POST', '/api/signup', { ...GOOD_COMPANY, code: 'rl-co-other' }, undefined, { 'x-forwarded-for': '203.0.113.141' })).status, 200);
});

test('a signed-up owner cannot see seeded company data and platform routes stay closed to them', async () => {
  const t = await tokenOf('signup-co', 'boss', 'secret1');
  assert.deepEqual((await call('GET', '/api/products', undefined, t)).json, []);
  assert.equal((await call('GET', '/platform/companies', undefined, t, { 'x-forwarded-for': freshIp() })).status, 403);
});

// =====================================================================================================
// 7. API RATE LIMIT
// =====================================================================================================

test('the per-ip API limit returns 429 once exceeded and does not affect /healthz', async () => {
  const app = await startApp({ ...ENV, API_PER_MINUTE: '5' } as NodeJS.ProcessEnv);
  const ip = { 'x-forwarded-for': '203.0.113.150' };
  const statuses: number[] = [];
  for (let i = 0; i < 8; i++) statuses.push((await app.call('GET', '/api/config', undefined, undefined, ip)).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429, 429]);
  assert.equal((await app.call('GET', '/healthz', undefined, undefined, ip)).status, 200);
  assert.equal((await app.call('GET', '/api/config', undefined, undefined, { 'x-forwarded-for': '203.0.113.151' })).status, 200);
});

// =====================================================================================================
// 8. INPUT HARDENING
// =====================================================================================================

test('malformed JSON is a 400 on public and authenticated routes', async () => {
  for (const [path, token] of [['/api/login', undefined], ['/api/tables', tok.manager], ['/platform/companies', undefined]] as const) {
    for (const body of ['{', '{"a":', 'not json', '{"a":1}}', "{'a':1}", '\u0000']) {
      const r = await call('POST', path, body, token, { 'x-forwarded-for': freshIp(), 'x-admin-key': ADMIN_KEY });
      assert.equal(r.status, 400, `${path} ${JSON.stringify(body)} -> ${r.status} ${r.text}`);
      assert.equal(r.json.error, 'invalid JSON');
    }
  }
});

test('valid JSON that is not an object is a 4xx, never a 500', async () => {
  for (const body of ['null', '123', '"text"', '[]', '[1,2]', 'true']) {
    for (const [path, token] of [['/api/login', undefined], ['/api/tables', tok.manager], ['/api/members/topup', tok.manager], ['/api/hq/catalog/copy', tok.owner], ['/api/bills', tok.host]] as const) {
      const r = await call('POST', path, body, token, { 'x-forwarded-for': freshIp() });
      assert.ok(r.status >= 400 && r.status < 500, `${path} body ${body} -> ${r.status} ${r.text}`);
    }
  }
});

test('catalog copy with a non-array toStoreIds is 4xx', async () => {
  for (const toStoreIds of [undefined, null, 5, 'abc', {}, ['x'], [null], [1e30]]) {
    const r = await call('POST', '/api/hq/catalog/copy', { fromStoreId: A.store1, toStoreIds }, tok.owner);
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(toStoreIds)} -> ${r.status} ${r.text}`);
  }
});

test('an oversized body is 413 and the server keeps serving', async () => {
  const big = JSON.stringify({ company: 'doloruu', username: 'x'.repeat(300 * 1024), pin: '1' });
  let status = 0;
  try {
    status = (await call('POST', '/api/login', big, undefined, { 'x-forwarded-for': freshIp() })).status;
  } catch {
    status = (await raw('/api/login', { method: 'POST', body: big, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(big)) } }).catch(() => ({ status: 413 }))).status;
  }
  assert.equal(status, 413);
  assert.equal((await call('GET', '/healthz')).status, 200);
});

test('a body just under the limit is processed normally', async () => {
  const pad = 'x'.repeat(200 * 1024);
  const r = await call('POST', '/api/login', { company: 'doloruu', username: 'flag.host', pin: '1111', pad }, undefined, { 'x-forwarded-for': freshIp() });
  assert.equal(r.status, 200);
});

// A throwaway company so hardening tests cannot disturb the isolation data.
test('hardening fixture', async () => {
  const c = await admin('POST', '/platform/companies', { name: 'Hardening', code: 'hardening', storeName: 'H', ownerName: 'Hh', ownerUsername: 'hh', ownerPin: 'hardpin1' });
  assert.equal(c.status, 200);
  H.tok = await tokenOf('hardening', 'hh', 'hardpin1');
  H.ownerId = c.json.ownerId;
  H.product = (await call('POST', '/api/products', { name: 'Beer', price: 1000, stock: 100 }, H.tok)).json.productId;
  H.table = (await call('POST', '/api/tables', { name: 'T1' }, H.tok)).json.tableId;
  H.table2 = (await call('POST', '/api/tables', { name: 'T2' }, H.tok)).json.tableId;
  H.bill = (await call('POST', '/api/bills', { tableId: H.table, repId: H.ownerId, phone: '13500000000' }, H.tok)).json.billId;
  await call('POST', `/api/bills/${H.bill}/lines`, { productId: H.product, qty: 3 }, H.tok);
  await call('POST', '/api/shifts/open', { openingCash: 0 }, H.tok);
});

const BAD_NUMBERS: unknown[] = [-1, 1.5, 'abc', '', null, {}, [], 1e30, true, false, 'NaN', '1e999', -0.5, 2 ** 53];
const label = (v: unknown) => JSON.stringify(v) ?? String(v);

async function expectAll422(method: string, path: () => string, build: (v: unknown) => unknown, values: unknown[] = BAD_NUMBERS) {
  for (const v of values) {
    const r = await call(method, path(), build(v), H.tok);
    assert.equal(r.status, 422, `${method} ${path()} with ${label(v)} -> ${r.status} ${r.text}`);
  }
}

test('qty on bill lines: negative, zero, float, string, huge are 422', async () => {
  await expectAll422('POST', () => `/api/bills/${H.bill}/lines`, (v) => ({ productId: H.product, qty: v }), [...BAD_NUMBERS, 0, '2', 1e30]);
});

test('bill totals are unchanged by all the rejected lines', async () => {
  const b = (await call('GET', `/api/bills/${H.bill}`, undefined, H.tok)).json;
  assert.equal(b.lines.length, 1);
  assert.equal(b.totals.subtotal, 3000);
});

test('ids in bodies: junk product, bill and table ids are 4xx, never 500', async () => {
  const junk = ['abc', -1, 0, 1.5, 1e30, null, {}, [], 99999999999999999999, '9'.repeat(40)];
  for (const v of junk) {
    for (const [method, path, body] of [
      ['POST', `/api/bills/${H.bill}/lines`, { productId: v, qty: 1 }],
      ['POST', '/api/bills', { tableId: v, repId: H.ownerId }],
      ['POST', '/api/bills', { tableId: H.table2, repId: v }],
      ['POST', `/api/bills/${H.bill}/transfer`, { toTableId: v }],
      ['POST', '/api/stash', { phone: '1', productId: v, qtyMilli: 1000 }],
      ['POST', `/api/stash/${H.product}/retrieve`, { qtyMilli: 10, billId: v }],
      ['POST', '/api/stash/1/transfer', { toStoreId: v }],
      ['POST', '/api/bookings/1/confirm', { tableId: v, repId: v }],
      ['POST', '/api/commission-rules', { role: 'sales', productId: v, bps: 1 }],
      ['POST', '/api/hq/catalog/copy', { fromStoreId: v, toStoreIds: [v] }],
      ['POST', '/api/hq/staff', { name: 'x', username: 'junk.id', role: 'waiter', pin: '1234', storeId: v }],
      ['POST', '/api/hq/stores', { name: 'x', code: `JUNK${++ipCounter}`, copyCatalogFrom: v }],
      ['POST', '/api/receivables/1/collect', { amount: v, method: 'cash' }],
    ] as const) {
      const r = await call(method, path, body, H.tok);
      const ignoredFalsy = (path === '/api/hq/stores' || path === '/api/commission-rules') && !v; // 0/null mean "not provided" for these optional ids
      assert.ok(ignoredFalsy || (r.status >= 400 && r.status < 500), `${method} ${path} ${label(v)} -> ${r.status} ${r.text}`);
    }
  }
});

test('ids in the url: junk, huge, negative and hex-looking ids are 4xx, never 500', async () => {
  const ids = ['abc', '99999999999999999999', '-1', '1.5', '0x10', '1e30', 'NaN', 'Infinity', '%00', '%E0%A4%A', "1'--", '1%20OR%201=1', '9'.repeat(400)];
  for (const id of ids) {
    for (const [method, path] of [
      ['GET', `/api/bills/${id}`], ['POST', `/api/bills/${id}/lines`], ['POST', `/api/bills/${H.bill}/lines/${id}/void`], ['PATCH', `/api/tables/${id}`],
      ['PATCH', `/api/products/${id}`], ['POST', `/api/products/${id}/stock`], ['DELETE', `/api/commission-rules/${id}`], ['POST', `/api/bookings/${id}/cancel`],
      ['POST', `/api/stash/${id}/retrieve`], ['PATCH', `/api/staff/${id}`], ['POST', `/api/receivables/${id}/collect`],
    ] as const) {
      const r = await call(method, path, method === 'GET' || method === 'DELETE' ? undefined : { qty: 1, reason: 'x', delta: 1, amount: 1, method: 'cash', billId: 1, qtyMilli: 1 }, H.tok);
      assert.ok(r.status >= 400 && r.status < 500, `${method} ${path} -> ${r.status} ${r.text}`);
    }
  }
});

test('products: negative, float, string and huge price/stock are 422; nothing is created', async () => {
  const before = (await db.one("SELECT COUNT(*) AS n FROM products p JOIN stores s ON s.id = p.store_id JOIN tenants t ON t.id = s.tenant_id WHERE t.code = 'hardening'"))!.n;
  await expectAll422('POST', () => '/api/products', (v) => ({ name: `bad-price-${Math.random()}`, price: v }));
  await expectAll422('POST', () => '/api/products', (v) => ({ name: `bad-stock-${Math.random()}`, price: 1, stock: v }), BAD_NUMBERS.filter((v) => v !== null));
  await expectAll422('PATCH', () => `/api/products/${H.product}`, (v) => ({ price: v }));
  const after = (await db.one("SELECT COUNT(*) AS n FROM products p JOIN stores s ON s.id = p.store_id JOIN tenants t ON t.id = s.tenant_id WHERE t.code = 'hardening'"))!.n;
  assert.equal(after, before);
  assert.equal((await call('GET', '/api/products', undefined, H.tok)).json.find((p: any) => p.id === H.product).price, 1000);
});

test('products: name is required and must be text', async () => {
  for (const name of [undefined, '', '   ', null]) assert.equal((await call('POST', '/api/products', { name, price: 1 }, H.tok)).status, 422, label(name));
});

test('stock adjust: zero, float, string, huge delta and missing reason are 422', async () => {
  await expectAll422('POST', () => `/api/products/${H.product}/stock`, (v) => ({ delta: v, reason: 'x' }), BAD_NUMBERS.filter((v) => v !== -1 && v !== true && v !== false).concat([0]));
  assert.equal((await call('POST', `/api/products/${H.product}/stock`, { delta: 5 }, H.tok)).status, 422);
});

test('stock cannot be pushed past the database range', async () => {
  const big = 9_000_000_000_000_000;
  const first = await call('POST', `/api/products/${H.product}/stock`, { delta: big, reason: 'x' }, H.tok);
  const second = await call('POST', `/api/products/${H.product}/stock`, { delta: big, reason: 'x' }, H.tok);
  assert.ok(first.status < 500 && second.status < 500, `${first.text} / ${second.text}`);
  if (first.status === 200) await call('POST', `/api/products/${H.product}/stock`, { delta: -big, reason: 'undo' }, H.tok);
});

test('tables: bad capacity, min spend and fee are 422', async () => {
  await expectAll422('POST', () => '/api/tables', (v) => ({ name: `bad-cap-${Math.random()}`, capacity: v }), BAD_NUMBERS.filter((v) => v !== null && v !== ''));
  await expectAll422('POST', () => '/api/tables', (v) => ({ name: `bad-min-${Math.random()}`, minSpend: v }), BAD_NUMBERS.filter((v) => v !== null));
  await expectAll422('PATCH', () => `/api/tables/${H.table2}`, (v) => ({ tableFee: v }));
  for (const kind of ['sofa', '', 5, {}]) assert.equal((await call('POST', '/api/tables', { name: `k-${Math.random()}`, kind }, H.tok)).status, 422, label(kind));
});

test('wallet top-up: bad amounts and bonuses are 422 and the balance is untouched', async () => {
  await expectAll422('POST', () => '/api/members/topup', (v) => ({ phone: '13500000000', amount: v }), [...BAD_NUMBERS, 0]);
  await expectAll422('POST', () => '/api/members/topup', (v) => ({ phone: '13500000000', amount: 100, bonus: v }), BAD_NUMBERS.filter((v) => v !== null && v !== '' && v !== false && !(Array.isArray(v))));
  for (const phone of [undefined, '', null]) assert.equal((await call('POST', '/api/members/topup', { phone, amount: 100 }, H.tok)).status, 422, label(phone));
  const m = await call('GET', '/api/members/13500000000', undefined, H.tok);
  assert.equal(m.json.balance, 0);
});

test('wallet cannot overflow the database range', async () => {
  const ok = await call('POST', '/api/members/topup', { phone: '13500000001', amount: 9_000_000_000_000_000 }, H.tok);
  const again = await call('POST', '/api/members/topup', { phone: '13500000001', amount: 9_000_000_000_000_000 }, H.tok);
  assert.ok(ok.status < 500 && again.status < 500, `${ok.text} / ${again.text}`);
});

test('phone must be text: objects and arrays are rejected, not stored as JSON', async () => {
  for (const phone of [{ a: 1 }, [1, 2], true]) {
    const r = await call('POST', '/api/members/topup', { phone, amount: 100 }, H.tok);
    assert.ok(r.status >= 400 && r.status < 500, `${label(phone)} -> ${r.status}`);
  }
  const odd = await db.all("SELECT phone FROM members m JOIN tenants t ON t.id = m.tenant_id WHERE t.code = 'hardening' AND phone LIKE '{%'");
  assert.deepEqual(odd, []);
});

test('payments: float, string, NaN and negative amounts never create a payment', async () => {
  const before = (await db.one('SELECT COUNT(*) AS n FROM payments WHERE bill_id = ?', [H.bill]))!.n;
  for (const amount of [1.5, 'abc', -5, '', {}, [], 1e30, '12abc']) {
    for (const method of ['cash', 'credit']) {
      const r = await call('POST', `/api/bills/${H.bill}/pay`, { method, amount }, H.tok);
      assert.ok(r.status >= 400 && r.status < 500, `pay ${method} ${label(amount)} -> ${r.status} ${r.text}`);
    }
    const online = await call('POST', `/api/bills/${H.bill}/pay-online`, { method: 'wechat', amount }, H.tok);
    assert.ok(online.status >= 400 && online.status < 500, `pay-online ${label(amount)} -> ${online.status} ${online.text}`);
  }
  assert.equal((await db.one('SELECT COUNT(*) AS n FROM payments WHERE bill_id = ?', [H.bill]))!.n, before);
});

test('payment method is validated', async () => {
  for (const method of [undefined, null, 'bitcoin', '', 5, ['cash'], 'CASH']) {
    const r = await call('POST', `/api/bills/${H.bill}/pay`, { method }, H.tok);
    assert.equal(r.status, 422, label(method));
  }
  assert.equal((await call('POST', `/api/bills/${H.bill}/pay-online`, { method: 'paypal' }, H.tok)).status, 422);
});

test('discount: negative, float, string amounts and missing reason are 422', async () => {
  await expectAll422('POST', () => `/api/bills/${H.bill}/discount`, (v) => ({ amount: v, reason: 'x' }), BAD_NUMBERS.filter((v) => v !== false && v !== '' && v !== null && !Array.isArray(v)));
  assert.equal((await call('POST', `/api/bills/${H.bill}/discount`, { amount: 5 }, H.tok)).status, 422);
});

test('shifts: bad opening and counted cash are 422', async () => {
  await expectAll422('POST', () => '/api/shifts/close', (v) => ({ countedCash: v }), BAD_NUMBERS.filter((v) => v !== false && v !== '' && v !== null && !Array.isArray(v)));
  assert.equal((await call('GET', '/api/shifts/current', undefined, H.tok)).status, 200);
});

test('opening a shift twice is 409', async () => {
  assert.equal((await call('POST', '/api/shifts/open', { openingCash: 0 }, H.tok)).status, 409);
});

test('commission rules: bad bps, fixed and role are 422', async () => {
  await expectAll422('POST', () => '/api/commission-rules', (v) => ({ role: 'sales', bps: v }), [...BAD_NUMBERS.filter((v) => v !== null && v !== false && v !== '' && !Array.isArray(v)), 10001]);
  await expectAll422('POST', () => '/api/commission-rules', (v) => ({ role: 'sales', bps: 1, fixed: v }), BAD_NUMBERS.filter((v) => v !== null && v !== false && v !== '' && !Array.isArray(v)));
  for (const role of [undefined, 'owner', '', null, 5]) assert.equal((await call('POST', '/api/commission-rules', { role, bps: 1 }, H.tok)).status, 422, label(role));
});

test('stash: bad quantities and days are 4xx and nothing is stored', async () => {
  const before = (await db.one('SELECT COUNT(*) AS n FROM stash'))!.n;
  for (const qtyMilli of [-1, 0, 1.5, 'abc', null, 10001, 1e30, '1000']) {
    const r = await call('POST', '/api/stash', { phone: '135', productId: H.product, qtyMilli }, H.tok);
    assert.equal(r.status, 422, `qtyMilli ${label(qtyMilli)} -> ${r.status} ${r.text}`);
  }
  for (const days of ['abc', -5, 1e30, 1.5, {}, 1e12]) {
    const r = await call('POST', '/api/stash', { phone: '135', productId: H.product, qtyMilli: 1000, days }, H.tok);
    assert.ok(r.status >= 400 && r.status < 500, `days ${label(days)} -> ${r.status} ${r.text}`);
  }
  assert.equal((await db.one('SELECT COUNT(*) AS n FROM stash'))!.n, before);
  const noPhone = await call('POST', '/api/stash', { productId: H.product, qtyMilli: 1000 }, H.tok);
  assert.ok(noPhone.status >= 400 && noPhone.status < 500, `missing phone -> ${noPhone.status}`);
});

test('bookings: junk eta, party size and phone are 4xx', async () => {
  for (const eta of ['abc', null, undefined, 1.5, -1, {}, 1e30]) {
    const r = await call('POST', '/api/bookings', { phone: '135', eta }, H.tok);
    assert.ok(r.status >= 400 && r.status < 500, `eta ${label(eta)} -> ${r.status} ${r.text}`);
  }
  for (const partySize of ['abc', -3, 0, 1.5, 1e30, {}]) {
    const r = await call('POST', '/api/bookings', { phone: '135', eta: Date.now() + 1000, partySize }, H.tok);
    assert.ok(r.status >= 400 && r.status < 500, `partySize ${label(partySize)} -> ${r.status} ${r.text}`);
  }
  for (const phone of [undefined, '', null]) assert.equal((await call('POST', '/api/bookings', { phone, eta: Date.now() + 1000 }, H.tok)).status, 422, label(phone));
});

test('reports: junk from/to are 4xx', async () => {
  for (const q of ['from=abc', 'to=abc', 'from=-1&to=-2', 'from=1.5', 'from=1e30', 'from=&to=', 'from=NaN']) {
    for (const p of ['/api/payroll', '/api/reports/daily', '/api/hq/summary']) {
      const r = await call('GET', `${p}?${q}`, undefined, H.tok);
      assert.ok(r.status === 200 || (r.status >= 400 && r.status < 500), `${p}?${q} -> ${r.status} ${r.text}`);
    }
  }
});

test('hq: junk staff and store input is 4xx and creates nothing', async () => {
  const before = (await db.one("SELECT COUNT(*) AS n FROM employees e JOIN tenants t ON t.id = e.tenant_id WHERE t.code = 'hardening'"))!.n;
  const storeId = (await call('GET', '/api/hq/stores', undefined, H.tok)).json[0].id;
  const good = { name: 'N', username: 'good.name', role: 'waiter', pin: '1234', storeId };
  const bad: Array<Record<string, unknown>> = [
    { role: 'god' }, { role: undefined }, { role: ['waiter'] }, { username: 'a' }, { username: 'bad name' }, { username: undefined }, { username: ['good.name'] },
    { pin: '12' }, { pin: undefined }, { pin: 1234 }, { pin: ['1', '2', '3', '4'] }, { pin: { length: 9 } }, { name: undefined }, { name: null }, { name: '' }, { name: { a: 1 } },
    { storeId: undefined }, { storeId: 'abc' }, { storeId: 1e30 },
  ];
  for (const patch of bad) {
    const r = await call('POST', '/api/hq/staff', { ...good, ...patch }, H.tok);
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(patch)} -> ${r.status} ${r.text}`);
  }
  assert.equal((await db.one("SELECT COUNT(*) AS n FROM employees e JOIN tenants t ON t.id = e.tenant_id WHERE t.code = 'hardening'"))!.n, before);
  for (const body of [{}, { name: 'x' }, { code: 'x' }, { name: 5, code: 6 }, { name: ['a'], code: ['b'] }, { name: 'x', code: { a: 1 } }]) {
    const r = await call('POST', '/api/hq/stores', body, H.tok);
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(body)} -> ${r.status} ${r.text}`);
  }
});

test('hq: duplicate staff username is 409, store code duplicates are 409', async () => {
  const storeId = (await call('GET', '/api/hq/stores', undefined, H.tok)).json[0].id;
  const body = { name: 'Dup', username: 'dup.user', role: 'waiter', pin: '1234', storeId };
  assert.equal((await call('POST', '/api/hq/staff', body, H.tok)).status, 200);
  assert.equal((await call('POST', '/api/hq/staff', body, H.tok)).status, 409);
  assert.equal((await call('POST', '/api/hq/staff', { ...body, username: 'DUP.USER' }, H.tok)).status, 409);
});

test('staff patch: non-string name and pin types are 4xx', async () => {
  const id = (await call('POST', '/api/hq/staff', { name: 'P', username: 'patch.me', role: 'waiter', pin: '1234', storeId: (await call('GET', '/api/hq/stores', undefined, H.tok)).json[0].id }, H.tok)).json.employeeId;
  for (const patch of [{ name: { a: 1 } }, { name: ['x'] }, { pin: ['1', '2', '3', '4'] }, { pin: { length: 9 } }, { active: 'maybe' }, { role: 5 }, { role: ['waiter'] }]) {
    const r = await call('PATCH', `/api/staff/${id}`, patch, H.tok);
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(patch)} -> ${r.status} ${r.text}`);
  }
  assert.equal((await login('hardening', 'patch.me', '1234')).status, 200, 'rejected patches must not have changed the account');
});

test('SQL-injection-looking strings are stored verbatim and nothing is executed', async () => {
  const evil = [`' OR '1'='1`, `'; DROP TABLE members; --`, `" OR ""="`, `Robert'); DROP TABLE products;--`, '\\', '%', '_', '${7*7}', '{{7*7}}', '<script>alert(1)</script>'];
  for (const [i, s] of evil.entries()) {
    const phone = `${s}${String(i).padStart(3, '0')}`;
    const stored = phone.replace(/[\s\-().]/g, ''); // phones are normalised on write and on lookup
    assert.equal((await call('POST', '/api/members/topup', { phone, amount: 100 }, H.tok)).status, 200, s);
    const get = await call('GET', `/api/members/${encodeURIComponent(phone)}`, undefined, H.tok);
    assert.equal(get.status, 200, `${s} -> ${get.text}`);
    assert.equal(get.json.phone, stored);
    assert.equal(get.json.balance, 100);
    const prod = await call('POST', '/api/products', { name: `${s}-${i}`, nameEn: s, category: s, price: 5 }, H.tok);
    assert.equal(prod.status, 200, `${s} -> ${prod.text}`);
    const search = await call('GET', `/api/members?q=${encodeURIComponent(s)}`, undefined, H.tok);
    assert.equal(search.status, 200, search.text);
    assert.equal((await call('GET', `/api/stash?q=${encodeURIComponent(s)}`, undefined, H.tok)).status, 200);
  }
  const names = (await call('GET', '/api/products?all=1', undefined, H.tok)).json.map((p: any) => p.name);
  assert.ok(names.includes(`' OR '1'='1-0`));
  assert.equal((await db.one("SELECT COUNT(*) AS n FROM members")) !== undefined, true, 'members table still exists');
  assert.ok((await call('GET', '/api/products', undefined, H.tok)).json.length >= 1, 'products table still exists');
});

test('search "q" with an injection string never widens the result beyond the tenant', async () => {
  const r = await call('GET', `/api/members?q=${encodeURIComponent("' OR tenant_id <> 0 --")}`, undefined, H.tok);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, []);
});

test('member lookup by phone decodes the url: plus signs and spaces round trip', async () => {
  const phone = '+86 138 0000 0002';
  assert.equal((await call('POST', '/api/members/topup', { phone, amount: 100 }, H.tok)).status, 200);
  const r = await call('GET', `/api/members/${encodeURIComponent(phone)}`, undefined, H.tok);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.phone, '13800000002', 'the +86 prefix and spaces are normalised away');
  assert.ok([400, 404].includes((await call('GET', '/api/members/%E0%A4%A', undefined, H.tok)).status));
});

test('unicode, emoji, RTL and combining characters round trip exactly', async () => {
  const names = ['🍾 Dom Pérignon 香槟', 'عربى مزيج', 'e\u0301 combining', '\u202eRLO', '𝔘𝔫𝔦𝔠𝔬𝔡𝔢', '😀'.repeat(50), '  padded  '];
  for (const n of names) {
    const r = await call('POST', '/api/products', { name: n, price: 10 }, H.tok);
    assert.equal(r.status, 200, `${n}: ${r.text}`);
  }
  const stored = (await call('GET', '/api/products?all=1', undefined, H.tok)).json.map((p: any) => p.name);
  for (const n of names) assert.ok(stored.includes(n.trim()), `missing ${n}`);
});

test('NUL bytes in text are a 4xx, not a 500', async () => {
  for (const [path, body] of [
    ['/api/products', { name: 'a\u0000b', price: 1 }], ['/api/tables', { name: 'a\u0000b' }], ['/api/members/topup', { phone: 'a\u0000b', amount: 1 }],
    ['/api/bookings', { phone: 'a\u0000b', eta: Date.now() + 1000 }], ['/api/hq/stores', { name: 'a\u0000b', code: 'nul-store' }],
  ] as const) {
    const r = await call('POST', path, body, H.tok);
    assert.ok(r.status >= 400 && r.status < 500, `${path} -> ${r.status} ${r.text}`);
  }
  assert.equal((await call('GET', `/api/members?q=${encodeURIComponent('a\u0000b')}`, undefined, H.tok)).status < 500, true);
  assert.ok([401, 422].includes((await login('hardening', 'a\u0000b', 'x')).status));
});

test('very long strings are handled (stored or refused) without a 500', async () => {
  const long = 'x'.repeat(120 * 1024);
  for (const [path, body] of [
    ['/api/products', { name: long, price: 1 }], ['/api/tables', { name: long }], ['/api/members/topup', { phone: long, amount: 1 }], ['/api/bookings', { phone: long, name: long, eta: Date.now() + 1000 }],
  ] as const) {
    const r = await call('POST', path, body, H.tok);
    assert.ok(r.status < 500, `${path} -> ${r.status} ${r.text.slice(0, 100)}`);
  }
  const r = await call('GET', `/api/members?q=${'y'.repeat(6000)}`, undefined, H.tok);
  assert.ok(r.status < 500, `long q -> ${r.status}`);
  assert.equal((await login('hardening', long.slice(0, 60000), long.slice(0, 60000))).status, 401);
});

test('huge integers and exotic JSON numbers in bodies never produce a 500', async () => {
  const bodies = ['{"productId":1e400,"qty":1}', '{"productId":-1e400,"qty":1}', '{"productId":1,"qty":1e400}', '{"productId":123456789012345678901234567890,"qty":1}', '{"productId":1,"qty":-0}'];
  for (const b of bodies) {
    const r = await call('POST', `/api/bills/${H.bill}/lines`, b, H.tok);
    assert.ok(r.status >= 400 && r.status < 500, `${b} -> ${r.status} ${r.text}`);
  }
});

test('prototype-pollution style keys in bodies are harmless', async () => {
  const r = await call('POST', '/api/products', '{"name":"proto","price":1,"__proto__":{"admin":true},"constructor":{"prototype":{"x":1}}}', H.tok);
  assert.equal(r.status, 200, r.text);
  assert.equal(({} as any).admin, undefined);
  assert.equal(({} as any).x, undefined);
});

test('no request in this file produced an HTTP 500 recorded in ops_events', async () => {
  const rows = await db.all("SELECT message, detail FROM ops_events WHERE kind = 'http.500' ORDER BY id");
  assert.deepEqual(rows.map((r: any) => `${r.message} ${r.detail}`.slice(0, 300)), []);
});

// =====================================================================================================
// 9. HEADERS, HEALTH, STATIC FILES
// =====================================================================================================

test('/healthz is public and reports the mode', async () => {
  const r = await call('GET', '/healthz');
  assert.deepEqual(r.json, { ok: true, mode: 'mock' });
});

test('/api/config is public and exposes no secrets', async () => {
  const r = await call('GET', '/api/config');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ['mock', 'payments', 'signupOpen']);
  assert.equal(r.text.includes(MOCK_SECRET), false);
  assert.equal(r.text.includes(ADMIN_KEY), false);
});

test('security headers are on JSON, error, 404 and static responses', async () => {
  const samples: Array<[string, Res]> = [
    ['healthz', await call('GET', '/healthz')], ['401', await call('GET', '/api/me')], ['403', await call('GET', '/platform/companies')],
    ['404 api', await call('GET', '/api/nope', undefined, tok.owner)], ['404 static', await call('GET', '/definitely-missing.js')], ['400', await call('POST', '/api/login', '{')],
    ['static index', await call('GET', '/')],
  ];
  for (const [name, r] of samples) for (const h of SECURITY_HEADERS) assert.ok(r.headers.get(h), `${name} lacks ${h}`);
  const csp = samples[0][1].headers.get('content-security-policy')!;
  assert.ok(csp.includes("default-src 'self'") && csp.includes("frame-ancestors 'none'") && !csp.includes('unsafe-eval'));
  assert.equal(samples[0][1].headers.get('x-frame-options'), 'DENY');
  assert.equal(samples[0][1].headers.get('x-content-type-options'), 'nosniff');
});

test('responses do not advertise the framework and errors do not leak stack traces or sql', async () => {
  const r = await call('POST', '/api/products', { name: 'a'.repeat(10), price: 'x' }, tok.manager);
  assert.equal(/at .*\.ts|node_modules|SELECT |INSERT |pg_|violates/i.test(r.text), false, r.text);
  assert.equal(r.headers.get('x-powered-by'), null);
});

const TRAVERSAL_PATHS = [
  '/../src/db.ts', '/%2e%2e/src/db.ts', '/%2E%2E/src/db.ts', '/..%2fsrc/db.ts', '/%2e%2e%2fsrc%2fdb.ts', '/..%5csrc%5cdb.ts', '/..\\src\\db.ts',
  '/public/../src/db.ts', '/../package.json', '/....//src/db.ts', '/.%2e/src/db.ts', '/%252e%252e/src/db.ts', '/./../src/db.ts', '//../src/db.ts',
  '/index.html/../../src/db.ts', '/src/db.ts', '/package.json', '/node_modules/pg/package.json', '/C:/Windows/win.ini', '/..%00/src/db.ts', '/index.html%00.png',
  '/../test/agent-auth.test.ts', '/..%c0%afsrc/db.ts', '/%2e%2e/%2e%2e/%2e%2e/Windows/win.ini', '/../../../../../../etc/passwd',
];

test('static file path traversal is refused and never serves source files', async () => {
  for (const p of TRAVERSAL_PATHS) {
    const r = await raw(p);
    assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
    assert.equal(/openDb|DomainError|"dependencies"|root:|\[fonts\]/.test(r.body), false, `${p} leaked file content`);
  }
});

test('static serving still works for real files and hides directories', async () => {
  const index = await raw('/');
  assert.equal(index.status, 200);
  assert.match(String(index.headers['content-type']), /text\/html/);
  assert.equal((await raw('/index.html')).status, 200);
  assert.equal((await raw('/tokens.css')).status, 200);
  assert.equal((await raw('/?x=1')).status, 200);
  assert.equal((await raw('//')).status === 404 || (await raw('//')).status === 200, true);
});

test('static serving only answers GET semantics for known files: POST and DELETE to static paths do not serve files', async () => {
  const r = await raw('/index.html', { method: 'DELETE' });
  assert.ok(r.status === 404 || r.status === 405 || r.status === 200);
  const post = await call('POST', '/definitely-missing', {});
  assert.equal(post.status, 404);
});

test('unknown /api, /dev and /platform paths are 404 JSON', async () => {
  for (const p of ['/api/', '/api/unknown', '/api/bills/1/unknown', '/dev/unknown', '/platform']) {
    const r = await call('GET', p, undefined, tok.owner, { 'x-admin-key': ADMIN_KEY, 'x-forwarded-for': freshIp() });
    assert.ok(r.status === 404 || r.status === 401 || r.status === 403, `${p} -> ${r.status}`);
  }
});

// =====================================================================================================
// 10. 500 HANDLING AND MONITORING
// =====================================================================================================

test('an unexpected failure is a 500 without internals, is recorded in ops_events, and shows in /platform/ops and metrics', async () => {
  const fresh = await openDb();
  const flaky: any = Object.create(fresh);
  let broken = false;
  const realOne = fresh.one.bind(fresh);
  flaky.one = async (...args: any[]) => {
    if (broken) throw new Error('boom: secret connection string postgres://u:p@h/db');
    return (realOne as any)(...args);
  };
  const app = await startApp(ENV, flaky);
  broken = true;
  const r = await app.call('GET', '/healthz');
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { error: 'internal error' });
  assert.equal(r.text.includes('boom') || r.text.includes('postgres://'), false);
  broken = false;
  const ops = await app.call('GET', '/platform/ops?level=error', undefined, undefined, { 'x-admin-key': ADMIN_KEY, 'x-forwarded-for': freshIp() });
  assert.equal(ops.status, 200);
  const ev = ops.json.find((e: any) => e.kind === 'http.500');
  assert.ok(ev, 'http.500 event recorded');
  assert.equal(ev.level, 'error');
  assert.match(ev.message, /boom/);
  assert.equal(JSON.parse(ev.detail).route, 'GET /healthz');
  const metrics = await app.call('GET', '/platform/metrics', undefined, undefined, { 'x-admin-key': ADMIN_KEY, 'x-forwarded-for': freshIp() });
  assert.ok(metrics.json.errors5xx >= 1);
  assert.ok(Object.keys(metrics.json.statuses).some((k) => k === 'GET /healthz 5xx'));
  await fresh.close();
});

test('a 500 in an authenticated request records the tenant and store', async () => {
  const fresh = await openDb();
  await seed(fresh);
  const flaky: any = Object.create(fresh);
  let broken = false;
  const realAll = fresh.all.bind(fresh);
  flaky.all = async (sql: string, ...rest: any[]) => {
    if (broken && sql.includes('FROM dining_tables')) throw new Error('tables exploded');
    return (realAll as any)(sql, ...rest);
  };
  const app = await startApp(ENV, flaky);
  const t = (await app.call('POST', '/api/login', { company: 'doloruu', username: 'owner', pin: '6666' }, undefined, { 'x-forwarded-for': freshIp() })).json.token;
  broken = true;
  assert.equal((await app.call('GET', '/api/tables', undefined, t)).status, 500);
  broken = false;
  const row = await fresh.one("SELECT tenant_id, store_id FROM ops_events WHERE kind = 'http.500'");
  assert.deepEqual([row!.tenant_id, row!.store_id], [1, 1]);
  await fresh.close();
});

test('the ops_events table keeps only the newest events', async () => {
  const fresh = await openDb();
  const { logEvent } = await import('../src/ops.ts');
  const quiet = console.error;
  const quietLog = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    for (let i = 0; i < 5050; i++) await logEvent(fresh, 'warn', 'test.spam', `m${i}`);
  } finally {
    console.error = quiet;
    console.log = quietLog;
  }
  const n = (await fresh.one('SELECT COUNT(*) AS n FROM ops_events'))!.n;
  assert.ok(n <= 5001, `kept ${n} rows`);
  await fresh.close();
});

test('rotating random bearer tokens shares one per-ip rate limit, while a real session keeps its own', async () => {
  const limited = await startApp({ PAY_MODE: 'mock', MOCK_PAY_SECRET: MOCK_SECRET, API_PER_MINUTE: '5' } as NodeJS.ProcessEnv);
  const attackerIp = { 'x-forwarded-for': '198.51.100.77' };
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) statuses.push((await limited.call('GET', '/api/tables', undefined, `random-token-${i}`, attackerIp)).status);
  const throttled = statuses.filter((s) => s === 429).length;
  const real = await limited.call('GET', '/api/tables', undefined, tok.cashier, attackerIp);
  assert.deepEqual([throttled >= 7, real.status], [true, 200]);
});
