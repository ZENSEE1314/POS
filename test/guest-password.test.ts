import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { seed } from '../src/seed.ts';

// Mock mode has a development SMS sender, which the merge test uses to verify a phone. All requests share one IP,
// so the per-IP limits are lifted and the per-phone limits are what gets tested.
const ENV = {
  PAY_MODE: 'mock', MOCK_PAY_SECRET: 's3cret', PUBLIC_BASE_URL: 'http://venue.test',
  GUEST_OTP_PER_IP_PER_HOUR: '1000', GUEST_REGISTER_PER_IP_PER_HOUR: '1000', GUEST_LOGIN_PER_IP_PER_10MIN: '1000',
} as NodeJS.ProcessEnv;
const PASSWORD = 'night-owl-88';
let db: Db;
let server: Server;
let base: string;
let manager = '';
let waiter = '';

async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const register = (phone: string, password = PASSWORD, name = 'Mei') => call('POST', '/api/guest/register', { phone, password, name });
const signIn = (phone: string, password = PASSWORD) => call('POST', '/api/guest/login/password', { phone, password });

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  await seed(db);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  manager = (await call('POST', '/api/login', { company: 'doloruu', username: 'flag.manager', pin: '4444' })).json.token;
  waiter = (await call('POST', '/api/login', { company: 'doloruu', username: 'flag.waiter', pin: '2222' })).json.token;
});

const issueCode = (phone: string, token = manager) => call('POST', '/api/guest-password-resets', { phone }, token);
const reset = (phone: string, code: string, password = 'brand-new-pass') => call('POST', '/api/guest/password/reset', { phone, code, password });
after(async () => {
  server.close();
  await db.close();
});

test('the customer app config offers phone and password sign-in', async () => {
  assert.equal((await call('GET', '/api/guest/config')).json.login.password, true);
});

test('registering signs the guest in under the chosen name', async () => {
  const r = await register('13800000001');
  const me = await call('GET', '/api/guest/me', undefined, r.json.token);
  assert.deepEqual([me.json.name, me.json.loginPhone], ['Mei', '13800000001']);
});

test('a registered phone is not treated as verified', async () => {
  const r = await register('13800000002');
  assert.equal(r.json.customer.phone, null);
});

test('the wallet stays locked until the phone is verified by SMS', async () => {
  const { json } = await register('13800000003');
  const a = await call('GET', '/api/guest/account/doloruu', undefined, json.token);
  assert.equal(a.json.phoneVerified, false);
});

test('signing in with the right password returns the same account', async () => {
  const created = (await register('13800000004')).json.customer.id;
  assert.equal((await signIn('+86 138-0000-0004')).json.customer.id, created);
});

test('a wrong password is refused', async () => {
  await register('13800000005');
  assert.equal((await signIn('13800000005', 'not-the-password')).status, 401);
});

test('an unknown phone gets the same answer as a wrong password', async () => {
  const r = await signIn('13800000099');
  assert.deepEqual([r.status, r.json.error], [401, 'wrong phone number or password']);
});

test('the same phone cannot register twice', async () => {
  await register('13800000006');
  assert.equal((await register('13800000006', 'another-pass')).status, 409);
});

test('a password shorter than 8 characters is refused', async () => {
  assert.equal((await register('13800000007', 'short')).status, 422);
});

test('a non-mainland number is refused', async () => {
  assert.equal((await register('12345')).status, 422);
});

test('password guesses on one phone are capped', async () => {
  await register('13800000008');
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) statuses.push((await signIn('13800000008', `guess-${i}xxx`)).status);
  assert.equal(statuses.at(-1), 429);
});

test('after verifying a phone that already had an account, the password signs in to the merged account', async () => {
  const sms = (await call('POST', '/api/guest/otp', { phone: '13900000001' })).json;
  const owner = (await call('POST', '/api/guest/login/phone', { phone: '13900000001', code: sms.devCode })).json.customer.id;
  const { token } = (await register('13800000010')).json;
  await db.run('DELETE FROM guest_otps WHERE phone = ?', ['13900000001']);
  const again = (await call('POST', '/api/guest/otp', { phone: '13900000001' })).json;
  await call('POST', '/api/guest/me/phone', { phone: '13900000001', code: again.devCode }, token);
  assert.equal((await signIn('13800000010')).json.customer.id, owner);
});

test('a staff reset code lets the guest sign in with a new password', async () => {
  await register('13800000020');
  await reset('13800000020', (await issueCode('13800000020')).json.code);
  assert.equal((await signIn('13800000020', 'brand-new-pass')).status, 200);
});

test('the old password stops working after a reset', async () => {
  await register('13800000021');
  await reset('13800000021', (await issueCode('13800000021')).json.code);
  assert.equal((await signIn('13800000021')).status, 401);
});

test('a reset signs out the guest everywhere else', async () => {
  const { token } = (await register('13800000022')).json;
  await reset('13800000022', (await issueCode('13800000022')).json.code);
  assert.equal((await call('GET', '/api/guest/me', undefined, token)).status, 401);
});

test('a reset code works only once', async () => {
  await register('13800000023');
  const { code } = (await issueCode('13800000023')).json;
  await reset('13800000023', code);
  assert.notEqual((await reset('13800000023', code, 'third-pass-99')).status, 200);
});

test('a wrong reset code is refused', async () => {
  await register('13800000024');
  await issueCode('13800000024');
  assert.equal((await reset('13800000024', '00000000')).status, 401);
});

test('a waiter cannot give out reset codes', async () => {
  await register('13800000025');
  assert.equal((await issueCode('13800000025', waiter)).status, 403);
});

test('staff cannot reset an account whose phone is verified', async () => {
  const { token } = (await register('13800000026')).json;
  const sms = (await call('POST', '/api/guest/otp', { phone: '13900000026' })).json;
  await call('POST', '/api/guest/me/phone', { phone: '13900000026', code: sms.devCode }, token);
  assert.equal((await issueCode('13800000026')).status, 409);
});

test('the reset code is recorded in the audit log', async () => {
  await register('13800000027');
  await issueCode('13800000027');
  const row = await db.one("SELECT detail FROM audit WHERE action = 'guest.password_reset_code' ORDER BY id DESC LIMIT 1");
  assert.match(String(row.detail), /13800000027/);
});

const HOUR = 3_600_000;
const book = (token: string) => call('POST', '/api/guest/bookings', { company: 'doloruu', store: 'FLAG', partySize: 4, eta: Date.now() + 5 * HOUR }, token);

test('a password account can book a table', async () => {
  const { token } = (await register('13800000030')).json;
  assert.equal((await book(token)).status, 200);
});

test('the booking carries the registered phone so staff can call', async () => {
  const { token } = (await register('13800000031')).json;
  const { bookingId } = (await book(token)).json;
  const row = await db.one('SELECT phone FROM bookings WHERE id = ?', [bookingId]);
  assert.equal(row.phone, '13800000031');
});

test("registering a member's phone does not open their wallet", async () => {
  const tenant = await db.one("SELECT id FROM tenants WHERE code = 'doloruu'");
  await db.run('INSERT INTO members (tenant_id, phone, name, balance) VALUES (?,?,?,?)', [tenant.id, '13800000032', 'Real member', 50000]);
  const { token } = (await register('13800000032')).json;
  const a = await call('GET', '/api/guest/account/doloruu', undefined, token);
  assert.ok(!a.json.wallet);
});

test('the password is stored hashed, never as typed', async () => {
  await register('13800000009');
  const row = await db.one('SELECT pw_hash FROM guest_passwords WHERE phone = ?', ['13800000009']);
  assert.ok(!row.pw_hash.includes(PASSWORD));
});
