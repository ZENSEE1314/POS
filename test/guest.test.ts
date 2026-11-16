import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { seed } from '../src/seed.ts';

// Every test request comes from one IP; the per-IP SMS limit is lifted so the per-phone limits are what gets tested.
const ENV = { PAY_MODE: 'mock', MOCK_PAY_SECRET: 's3cret', PUBLIC_BASE_URL: 'http://venue.test', GUEST_OTP_PER_IP_PER_HOUR: '1000' } as NodeJS.ProcessEnv;
const HOUR = 3_600_000;
let db: Db;
let server: Server;
let base: string;
const staff: Record<string, string> = {};
let qrA1 = '';
let qrA2 = '';
let qrB1 = '';

async function call(method: string, path: string, body?: unknown, token?: string, cookie = ''): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const location = async (path: string, cookie = '') =>
  (await fetch(base + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} })).headers.get('location') ?? '';

/** Starts a provider sign-in like a browser: returns the state and the cookie the server set. */
async function startLogin(provider: string, returnPath = '/g/doloruu/FLAG') {
  const res = await fetch(`${base}/api/guest/auth/${provider}/start?return=${encodeURIComponent(returnPath)}`, { redirect: 'manual' });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  return { state: new URL(res.headers.get('location')!, base).searchParams.get('state')!, cookie };
}

/** Walks the whole simulated provider sign-in, exactly as the browser does, and returns a guest token. */
async function socialLogin(provider: string, name: string, returnPath = '/g/doloruu/FLAG'): Promise<string> {
  const { state, cookie } = await startLogin(provider, returnPath);
  const back = await location(`/api/guest/auth/${provider}/callback?state=${state}&code=${encodeURIComponent(name)}`, cookie);
  const code = /#login=([0-9a-f]+)$/.exec(back)![1];
  return (await call('POST', '/api/guest/session', { code }, undefined, cookie)).json.token;
}

async function phoneLogin(phone: string): Promise<string> {
  const { devCode } = (await call('POST', '/api/guest/otp', { phone })).json;
  return (await call('POST', '/api/guest/login/phone', { phone, code: devCode })).json.token;
}

async function verifyPhone(token: string, phone: string) {
  await db.run('DELETE FROM guest_otps WHERE phone = ?', [phone]);
  const { devCode } = (await call('POST', '/api/guest/otp', { phone })).json;
  return call('POST', '/api/guest/me/phone', { phone, code: devCode }, token);
}

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  await seed(db);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  for (const [k, [username, pin]] of Object.entries({ waiter: ['flag.waiter', '2222'], manager: ['flag.manager', '4444'], cashier: ['flag.cashier', '3333'], s2waiter: ['lnge.waiter', '2222'], host: ['flag.host', '1111'] })) {
    staff[k] = (await call('POST', '/api/login', { company: 'doloruu', username, pin })).json.token;
  }
  const tables = (await call('GET', '/api/tables', undefined, staff.manager)).json;
  qrA1 = tables.find((t: any) => t.name === 'A1').qr_token;
  qrA2 = tables.find((t: any) => t.name === 'A2').qr_token;
  qrB1 = tables.find((t: any) => t.name === 'B1').qr_token;
});
after(async () => {
  server.close();
  await db.close();
});

test('every table gets an unguessable 32-hex QR token', () => {
  assert.match(qrA1, /^[0-9a-f]{32}$/);
});

test('the guest page is served for any /g/ address', async () => {
  const res = await fetch(`${base}/g/doloruu/FLAG/t/${qrA1}`);
  assert.match(await res.text(), /guest\/main\.js/);
});

test('the venue page lists the company stores without signing in', async () => {
  const r = await call('GET', '/api/guest/venue/DOLORUU');
  assert.deepEqual(r.json.stores.map((s: any) => s.code), ['FLAG', 'LNGE']);
});

test('the menu hides prices of nothing and marks sold-out items', async () => {
  await db.run("UPDATE products SET stock = 0 WHERE store_id = 1 AND name = 'Fruit Platter'");
  const r = await call('GET', '/api/guest/venue/doloruu/FLAG/menu');
  assert.equal(r.json.products.find((p: any) => p.name === 'Fruit Platter').soldOut, true);
  await db.run("UPDATE products SET stock = 100 WHERE store_id = 1 AND name = 'Fruit Platter'");
});

test('an unknown table token is a 404', async () => {
  assert.equal((await call('GET', `/api/guest/table/${'0'.repeat(32)}`)).status, 404);
});

test('the table token resolves to its store and table name', async () => {
  const r = await call('GET', `/api/guest/table/${qrA1}`);
  assert.deepEqual([r.json.store.code, r.json.table.name], ['FLAG', 'A1']);
});

test('sign-in start refuses a return address outside the customer app', async () => {
  const { state, cookie } = await startLogin('wechat', 'https://evil.example');
  const back = await location(`/api/guest/auth/wechat/callback?state=${state}&code=Eve`, cookie);
  assert.match(back, /^\/g\/#login=/);
});

test('the sign-in cookie is HttpOnly and SameSite=Lax', async () => {
  const res = await fetch(`${base}/api/guest/auth/wechat/start?return=/g/doloruu`, { redirect: 'manual' });
  assert.match(res.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Lax/);
});

test('a sign-in state cannot be replayed', async () => {
  const { state, cookie } = await startLogin('alipay', '/g/doloruu');
  await location(`/api/guest/auth/alipay/callback?state=${state}&code=Rae`, cookie);
  assert.match(await location(`/api/guest/auth/alipay/callback?state=${state}&code=Rae`, cookie), /#loginError=/);
});

test('a callback link opened in another browser (no sign-in cookie) is refused', async () => {
  const { state } = await startLogin('wechat');
  assert.match(await location(`/api/guest/auth/wechat/callback?state=${state}&code=Attacker`), /#loginError=/);
});

test('a captured #login code cannot be used in another browser', async () => {
  const { state, cookie } = await startLogin('wechat');
  const code = /#login=([0-9a-f]+)$/.exec(await location(`/api/guest/auth/wechat/callback?state=${state}&code=Attacker2`, cookie))![1];
  const other = (await startLogin('wechat')).cookie;
  assert.equal((await call('POST', '/api/guest/session', { code }, undefined, other)).status, 401);
});

test('signing in with the same provider name returns the same guest', async () => {
  const a = (await call('GET', '/api/guest/me', undefined, await socialLogin('douyin', 'Sam'))).json.id;
  const b = (await call('GET', '/api/guest/me', undefined, await socialLogin('douyin', 'Sam'))).json.id;
  assert.equal(a, b);
});

test('a login code works once only', async () => {
  const { state, cookie } = await startLogin('wechat', '/g/doloruu');
  const code = /#login=([0-9a-f]+)$/.exec(await location(`/api/guest/auth/wechat/callback?state=${state}&code=Once`, cookie))![1];
  await call('POST', '/api/guest/session', { code }, undefined, cookie);
  assert.equal((await call('POST', '/api/guest/session', { code }, undefined, cookie)).status, 401);
});

test('a staff token is not a guest token', async () => {
  assert.equal((await call('GET', '/api/guest/me', undefined, staff.manager)).status, 401);
});

test('placing an order needs a guest sign-in', async () => {
  assert.equal((await call('POST', '/api/guest/orders', { qrToken: qrA1, items: [{ productId: 3, qty: 1 }] })).status, 401);
});

test('a guest cannot order another store product onto this table', async () => {
  const g = await socialLogin('wechat', 'Cross');
  assert.equal((await call('POST', '/api/guest/orders', { qrToken: qrA1, items: [{ productId: 8, qty: 1 }] }, g)).status, 409);
});

test('an order larger than the stock left is refused', async () => {
  const g = await socialLogin('wechat', 'Greedy');
  assert.equal((await call('POST', '/api/guest/orders', { qrToken: qrA1, items: [{ productId: 1, qty: 99 }] }, g)).status, 409);
});

test('quantities outside 1..99 are a 422', async () => {
  const g = await socialLogin('wechat', 'Zero');
  assert.equal((await call('POST', '/api/guest/orders', { qrToken: qrA1, items: [{ productId: 3, qty: 0 }] }, g)).status, 422);
});

test('accepting an order on a free table needs a sales rep', async () => {
  const g = await socialLogin('wechat', 'Norep');
  const { orderId } = (await call('POST', '/api/guest/orders', { qrToken: qrA2, items: [{ productId: 3, qty: 2 }] }, g)).json;
  assert.equal((await call('POST', `/api/guest-orders/${orderId}/accept`, {}, staff.waiter)).status, 422);
});

test('accepting a free-table order opens the table and puts the items on its bill', async () => {
  const g = await socialLogin('wechat', 'Alice');
  const { orderId } = (await call('POST', '/api/guest/orders', { qrToken: qrA1, items: [{ productId: 3, qty: 2 }, { productId: 4, qty: 1 }] }, g)).json;
  const r = (await call('POST', `/api/guest-orders/${orderId}/accept`, { repId: 7 }, staff.waiter)).json;
  const bill = (await call('GET', `/api/bills/${r.billId}`, undefined, staff.waiter)).json;
  assert.equal(bill.totals.subtotal, 2 * 2800 + 18800);
});

test('the guest sees the order as accepted', async () => {
  const g = await socialLogin('wechat', 'Alice');
  const acct = (await call('GET', '/api/guest/account/doloruu', undefined, g)).json;
  assert.equal(acct.orders[0].status, 'accepted');
});

test('another store waiter cannot accept this store guest order', async () => {
  const g = await socialLogin('wechat', 'Bob');
  const { orderId } = (await call('POST', '/api/guest/orders', { qrToken: qrA1, items: [{ productId: 3, qty: 1 }] }, g)).json;
  assert.equal((await call('POST', `/api/guest-orders/${orderId}/accept`, {}, staff.s2waiter)).status, 404);
});

test('a host (no order.add) cannot see guest orders', async () => {
  assert.equal((await call('GET', '/api/guest-orders', undefined, staff.host)).status, 403);
});

test('rejecting needs a reason the guest can read', async () => {
  const g = await socialLogin('wechat', 'Carl');
  const { orderId } = (await call('POST', '/api/guest/orders', { qrToken: qrA1, items: [{ productId: 3, qty: 1 }] }, g)).json;
  await call('POST', `/api/guest-orders/${orderId}/reject`, { reason: 'Kitchen closed' }, staff.waiter);
  assert.equal((await call('GET', `/api/guest/orders/${orderId}`, undefined, g)).json.rejectReason, 'Kitchen closed');
});

test('a guest cannot read someone else order', async () => {
  const a = await socialLogin('wechat', 'Dana');
  const b = await socialLogin('wechat', 'Evan');
  const { orderId } = (await call('POST', '/api/guest/orders', { qrToken: qrA1, items: [{ productId: 3, qty: 1 }] }, a)).json;
  assert.equal((await call('GET', `/api/guest/orders/${orderId}`, undefined, b)).status, 404);
});

test('a guest can cancel a pending order but not an accepted one', async () => {
  const g = await socialLogin('wechat', 'Fay');
  const { orderId } = (await call('POST', '/api/guest/orders', { qrToken: qrA1, items: [{ productId: 3, qty: 1 }] }, g)).json;
  await call('POST', `/api/guest-orders/${orderId}/accept`, {}, staff.waiter);
  assert.equal((await call('POST', `/api/guest/orders/${orderId}/cancel`, {}, g)).status, 409);
});

test('the guest sees the table bill with its total due', async () => {
  const g = await socialLogin('wechat', 'Alice');
  const r = (await call('GET', `/api/guest/table/${qrA1}/bill`, undefined, g)).json;
  assert.equal(r.bill.totals.due, r.bill.totals.total);
});

test('paying with WeChat in mock mode settles the bill and frees the table', async () => {
  const g = await socialLogin('wechat', 'Alice');
  const charge = (await call('POST', `/api/guest/table/${qrA1}/pay`, { method: 'wechat', returnPath: `/g/doloruu/FLAG/t/${qrA1}` }, g)).json;
  const done = (await call('POST', `/api/guest/payments/${charge.outTradeNo}/mock-pay`, {}, g)).json;
  const table = (await call('GET', '/api/tables', undefined, staff.manager)).json.find((t: any) => t.name === 'A1');
  assert.deepEqual([charge.kind, done.status, done.billSettled, table.status], ['mock', 'paid', true, 'free']);
});

test('a guest cannot simulate paying someone else payment', async () => {
  const a = await socialLogin('alipay', 'Gus');
  const b = await socialLogin('alipay', 'Hal');
  const { orderId } = (await call('POST', '/api/guest/orders', { qrToken: qrB1, items: [{ productId: 3, qty: 1 }] }, a)).json;
  await call('POST', `/api/guest-orders/${orderId}/accept`, { repId: 7 }, staff.waiter);
  const charge = (await call('POST', `/api/guest/table/${qrB1}/pay`, { method: 'alipay', amount: 100 }, a)).json;
  assert.equal((await call('POST', `/api/guest/payments/${charge.outTradeNo}/mock-pay`, {}, b)).status, 404);
});

test('a phone code is needed to verify a phone', async () => {
  const g = await socialLogin('wechat', 'Ivy');
  await call('POST', '/api/guest/otp', { phone: '13900000001' });
  assert.equal((await call('POST', '/api/guest/me/phone', { phone: '13900000001', code: '000000x' }, g)).status, 401);
});

test('a code stops working after five wrong guesses', async () => {
  const phone = '13900000002';
  const { devCode } = (await call('POST', '/api/guest/otp', { phone })).json;
  for (let i = 0; i < 5; i++) await call('POST', '/api/guest/login/phone', { phone, code: 'nope' });
  assert.equal((await call('POST', '/api/guest/login/phone', { phone, code: devCode })).status, 401);
});

test('a second code within a minute is refused', async () => {
  await call('POST', '/api/guest/otp', { phone: '13900000003' });
  assert.equal((await call('POST', '/api/guest/otp', { phone: '13900000003' })).status, 429);
});

test('non-mainland numbers are refused for SMS', async () => {
  assert.equal((await call('POST', '/api/guest/otp', { phone: '12345' })).status, 422);
});

test('a verified phone links the guest to their member wallet', async () => {
  await call('POST', '/api/members/topup', { phone: '13800000001', amount: 50000, bonus: 0 }, staff.manager);
  const g = await socialLogin('wechat', 'Jo');
  await verifyPhone(g, '13800000001');
  assert.equal((await call('GET', '/api/guest/account/doloruu', undefined, g)).json.wallet.balance, 50000);
});

test('an unverified guest has no wallet access', async () => {
  const g = await socialLogin('wechat', 'Kim');
  assert.equal((await call('GET', '/api/guest/account/doloruu', undefined, g)).json.wallet, null);
});

test('verifying a phone that another account owns merges the two accounts', async () => {
  const byPhone = await phoneLogin('13800000009');
  const phoneId = (await call('GET', '/api/guest/me', undefined, byPhone)).json.id;
  const social = await socialLogin('douyin', 'Lee');
  const merged = (await verifyPhone(social, '13800000009')).json;
  assert.deepEqual([merged.id, merged.providers], [phoneId, ['douyin']]);
});

test('the session of a merged account keeps working', async () => {
  const social = await socialLogin('douyin', 'Lee');
  assert.equal((await call('GET', '/api/guest/me', undefined, social)).json.phone, '13800000009');
});

test('merging ends every other session of both accounts', async () => {
  const byPhone = await phoneLogin('13800000010');
  const social = await socialLogin('douyin', 'Nia');
  await verifyPhone(social, '13800000010');
  assert.equal((await call('GET', '/api/guest/me', undefined, byPhone)).status, 401);
});

test('verifying a phone ends the account sessions on other devices', async () => {
  const deviceA = await socialLogin('wechat', 'Omar');
  const deviceB = await socialLogin('wechat', 'Omar');
  await verifyPhone(deviceB, '13800000011');
  assert.equal((await call('GET', '/api/guest/me', undefined, deviceA)).status, 401);
});

test('one phone cannot be sent more than 5 codes an hour', async () => {
  const phone = '13900000020';
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    await db.run('UPDATE guest_otps SET sent_at = 0 WHERE phone = ?', [phone]);
    statuses.push((await call('POST', '/api/guest/otp', { phone })).status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
});

test('a second guest cannot pay the whole bill while another guest is mid-payment', async () => {
  const a = await socialLogin('wechat', 'Pia');
  const b = await socialLogin('wechat', 'Quin');
  const tables = (await call('GET', '/api/tables', undefined, staff.manager)).json;
  const a4 = tables.find((t: any) => t.name === 'A4');
  const { orderId } = (await call('POST', '/api/guest/orders', { qrToken: a4.qr_token, items: [{ productId: 3, qty: 1 }] }, a)).json;
  await call('POST', `/api/guest-orders/${orderId}/accept`, { repId: 7 }, staff.waiter);
  await call('POST', `/api/guest/table/${a4.qr_token}/pay`, { method: 'wechat' }, a);
  assert.equal((await call('POST', `/api/guest/table/${a4.qr_token}/pay`, { method: 'alipay' }, b)).status, 409);
});

test('a late online payment on an already-paid bill raises an overpaid alert', async () => {
  const a = await socialLogin('wechat', 'Ray');
  const tables = (await call('GET', '/api/tables', undefined, staff.manager)).json;
  const a5 = tables.find((t: any) => t.name === 'A5');
  const { orderId } = (await call('POST', '/api/guest/orders', { qrToken: a5.qr_token, items: [{ productId: 3, qty: 1 }] }, a)).json;
  const { billId } = (await call('POST', `/api/guest-orders/${orderId}/accept`, { repId: 7 }, staff.waiter)).json;
  const charge = (await call('POST', `/api/guest/table/${a5.qr_token}/pay`, { method: 'wechat' }, a)).json;
  await call('POST', `/api/bills/${billId}/pay`, { method: 'cash' }, staff.cashier);
  await call('POST', `/api/guest/payments/${charge.outTradeNo}/mock-pay`, {}, a);
  const alert = await db.one("SELECT detail FROM ops_events WHERE kind = 'payment.overpaid' ORDER BY id DESC LIMIT 1");
  assert.equal(JSON.parse(alert.detail).billId, billId);
});

test('paying from the wallet takes the balance and settles the bill', async () => {
  const g = await socialLogin('wechat', 'Jo');
  const { orderId } = (await call('POST', '/api/guest/orders', { qrToken: qrA2, items: [{ productId: 3, qty: 1 }] }, g)).json;
  await call('POST', `/api/guest-orders/${orderId}/accept`, { repId: 7 }, staff.waiter);
  const r = (await call('POST', `/api/guest/table/${qrA2}/pay`, { method: 'member' }, g)).json;
  const acct = (await call('GET', '/api/guest/account/doloruu', undefined, g)).json;
  assert.deepEqual([r.settled, acct.wallet.balance], [true, 50000 - 2800]);
});

test('wallet pay without enough balance is a 402', async () => {
  const g = await socialLogin('wechat', 'Jo');
  const { orderId } = (await call('POST', '/api/guest/orders', { qrToken: qrA2, items: [{ productId: 1, qty: 1 }] }, g)).json;
  await call('POST', `/api/guest-orders/${orderId}/accept`, { repId: 7 }, staff.waiter);
  assert.equal((await call('POST', `/api/guest/table/${qrA2}/pay`, { method: 'member' }, g)).status, 402);
});

test('booking needs a phone number', async () => {
  const g = await socialLogin('wechat', 'Mo');
  assert.equal((await call('POST', '/api/guest/bookings', { company: 'doloruu', store: 'FLAG', partySize: 4, eta: Date.now() + 5 * HOUR }, g)).status, 403);
});

test('a guest booking shows up for staff as submitted from the app', async () => {
  const g = await socialLogin('wechat', 'Jo');
  const { bookingId } = (await call('POST', '/api/guest/bookings', { company: 'doloruu', store: 'FLAG', partySize: 4, eta: Date.now() + 5 * HOUR, note: 'birthday' }, g)).json;
  const b = (await call('GET', '/api/bookings', undefined, staff.manager)).json.find((x: any) => x.id === bookingId);
  assert.deepEqual([b.source, b.status, b.phone], ['guest', 'submitted', '13800000001']);
});

test('a booking time in the past is refused', async () => {
  const g = await socialLogin('wechat', 'Jo');
  assert.equal((await call('POST', '/api/guest/bookings', { company: 'doloruu', store: 'FLAG', partySize: 2, eta: Date.now() - HOUR }, g)).status, 422);
});

test('renewing a table QR makes the old code stop working', async () => {
  const tables = (await call('GET', '/api/tables', undefined, staff.manager)).json;
  const a3 = tables.find((t: any) => t.name === 'A3');
  await call('POST', `/api/tables/${a3.id}/qr`, {}, staff.manager);
  assert.equal((await call('GET', `/api/guest/table/${a3.qr_token}`)).status, 404);
});

test('a waiter cannot renew table QR codes', async () => {
  assert.equal((await call('POST', '/api/tables/1/qr', {}, staff.waiter)).status, 403);
});

test('a suspended company venue page disappears', async () => {
  await db.run("UPDATE tenants SET active = false WHERE code = 'doloruu'");
  const status = (await call('GET', '/api/guest/venue/doloruu')).status;
  await db.run("UPDATE tenants SET active = true WHERE code = 'doloruu'");
  assert.equal(status, 404);
});
