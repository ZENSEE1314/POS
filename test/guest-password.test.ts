import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { seed } from '../src/seed.ts';

// Mock mode has a development SMS sender, which the merge test uses to verify a phone. All requests share one IP,
// so the per-IP register limit is lifted.
const ENV = {
  PAY_MODE: 'mock', MOCK_PAY_SECRET: 's3cret', PUBLIC_BASE_URL: 'http://venue.test', GUEST_OTP_PER_IP_PER_HOUR: '1000', GUEST_REGISTER_PER_IP_PER_HOUR: '1000',
} as NodeJS.ProcessEnv;
const PASSWORD = 'night-owl-88';
let db: Db;
let server: Server;
let base: string;

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
});
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

test('the password is stored hashed, never as typed', async () => {
  await register('13800000009');
  const row = await db.one('SELECT pw_hash FROM guest_passwords WHERE phone = ?', ['13800000009']);
  assert.ok(!row.pw_hash.includes(PASSWORD));
});
