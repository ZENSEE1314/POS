import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { seed, DEMO_PINS } from '../src/seed.ts';

const ENV = { PAY_MODE: 'mock', MOCK_PAY_SECRET: 's3cret', PUBLIC_BASE_URL: 'http://venue.test', GUEST_OTP_PER_IP_PER_HOUR: '1000' } as NodeJS.ProcessEnv;
let db: Db;
let server: Server;
let base: string;
let owner: string;
let manager: string;
let flagId: number;

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** A signed-up guest whose phone is verified, as needed for anything stored under their phone. */
async function guest(phone: string): Promise<string> {
  const token = (await call('POST', '/api/guest/register', { phone, password: 'guestpass1', name: 'Guest' })).json.token;
  await db.run('DELETE FROM guest_otps WHERE phone = ?', [phone]);
  const { devCode } = (await call('POST', '/api/guest/otp', { phone })).json;
  await call('POST', '/api/guest/me/phone', { phone, code: devCode }, token);
  return token;
}
const storeBottle = (token: string, extra: Record<string, unknown> = {}) =>
  call('POST', '/api/guest/requests', { kind: 'stash_in', company: 'doloruu', store: 'FLAG', name: 'Hennessy XO', left: 'half', ...extra }, token);

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  await seed(db);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  owner = (await call('POST', '/api/login', { company: 'doloruu', username: 'owner', pin: DEMO_PINS.owner })).json.token;
  manager = (await call('POST', '/api/login', { company: 'doloruu', username: 'flag.manager', pin: DEMO_PINS.manager })).json.token;
  const flag = (await call('GET', '/api/hq/stores', undefined, owner)).json.find((s: any) => s.code === 'FLAG');
  flagId = flag.id;
  await call('PATCH', `/api/hq/stores/${flagId}/location`, { city: flag.city, address: flag.address, postalCode: '200040', wifiSsid: 'Doloruu-Guest', wifiPassword: 'party2026' }, owner);
});
after(async () => {
  server.close();
  await db.close();
});

// ---------- WiFi ----------

test('the venue WiFi set in Locations shows in the customer app', async () => {
  const s = (await call('GET', '/api/guest/venue/doloruu')).json.stores.find((x: any) => x.code === 'FLAG');
  assert.deepEqual([s.wifiSsid, s.wifiPassword], ['Doloruu-Guest', 'party2026']);
});

test('saving a location without WiFi fields keeps the WiFi', async () => {
  const flag = (await call('GET', '/api/hq/stores', undefined, owner)).json.find((s: any) => s.code === 'FLAG');
  await call('PATCH', `/api/hq/stores/${flagId}/location`, { city: flag.city, address: flag.address, postalCode: flag.postalCode }, owner);
  assert.equal((await call('GET', '/api/hq/stores', undefined, owner)).json.find((s: any) => s.code === 'FLAG').wifiSsid, 'Doloruu-Guest');
});

// ---------- self-service bottle storage ----------

test('a guest asking staff to store a bottle reaches the staff inbox with their phone', async () => {
  const g = await guest('13811110001');
  const { requestId } = (await storeBottle(g)).json;
  const r = (await call('GET', '/api/guest-requests', undefined, manager)).json.find((x: any) => x.id === requestId);
  assert.deepEqual([r.kind, r.detail.name, r.detail.left, r.detail.phone], ['stash_in', 'Hennessy XO', 'half', '13811110001']);
});

test('how much is left must be one of the choices', async () => {
  const g = await guest('13811110002');
  assert.equal((await storeBottle(g, { left: 'some' })).status, 422);
});

test('a bottle to store needs its name', async () => {
  const g = await guest('13811110003');
  assert.equal((await storeBottle(g, { name: '' })).status, 422);
});

// ---------- total spent ----------

test('a new guest has spent nothing yet', async () => {
  const g = await guest('13811110004');
  assert.equal((await call('GET', '/api/guest/account/doloruu', undefined, g)).json.totalSpent, 0);
});

test('total spent counts what was paid on settled bills under the guest\'s phone', async () => {
  const g = await guest('13811110005');
  const tables = (await call('GET', '/api/tables', undefined, manager)).json;
  const reps = (await call('GET', '/api/reps', undefined, manager)).json;
  const product = (await call('GET', '/api/products', undefined, manager)).json.find((p: any) => p.price > 0 && p.unit !== 'kg');
  const billId = (await call('POST', '/api/bills', { tableId: tables.find((x: any) => x.status === 'free' && !x.min_spend).id, repId: reps[0].id, phone: '13811110005' }, manager)).json.billId;
  await call('POST', `/api/bills/${billId}/lines`, { productId: product.id, qty: 2 }, manager);
  await call('POST', `/api/bills/${billId}/pay`, { method: 'cash' }, manager);
  assert.equal((await call('GET', '/api/guest/account/doloruu', undefined, g)).json.totalSpent, product.price * 2);
});
