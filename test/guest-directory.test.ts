import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { seed } from '../src/seed.ts';

const ADMIN_KEY = 'platform-test-key';
const ENV = {
  PAY_MODE: 'mock', MOCK_PAY_SECRET: 's3cret', PLATFORM_ADMIN_KEY: ADMIN_KEY, PUBLIC_BASE_URL: 'http://venue.test',
  GUEST_OTP_PER_IP_PER_HOUR: '1000', GUEST_REGISTER_PER_IP_PER_HOUR: '1000', GUEST_LOGIN_PER_IP_PER_10MIN: '1000',
} as NodeJS.ProcessEnv;
const PIN = '246810';
const HOUR = 3_600_000;
let db: Db;
let server: Server;
let base: string;
const owners: Record<string, string> = {};

async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function company(code: string, name: string, businessType: string, city: string, address: string) {
  await call('POST', '/platform/companies', { name, code, storeName: 'Main', ownerName: 'Boss', ownerUsername: 'boss', ownerPin: PIN, businessType });
  owners[code] = (await call('POST', '/api/login', { company: code, username: 'boss', pin: PIN })).json.token;
  const [store] = (await call('GET', '/api/hq/stores', undefined, owners[code])).json;
  await call('PATCH', `/api/hq/stores/${store.id}/location`, { city, address }, owners[code]);
}

const search = (q = '', city = '') => call('GET', `/api/guest/directory?q=${encodeURIComponent(q)}&city=${encodeURIComponent(city)}`);
const codes = (r: { json: any }) => r.json.results.map((e: any) => e.company.code).sort();

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  await seed(db);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  await company('noodle', 'Lanzhou Noodle House', 'restaurant', 'Shanghai', '5 Wulumuqi Road');
  await company('beans', 'Bean There Cafe', 'cafe', 'Beijing', '20 Sanlitun Road');
  await company('secret', 'Hidden Speakeasy', 'bar', 'Suzhou', '1 Back Alley');
  await call('PATCH', '/api/guest-settings', { listed: false }, owners.secret);
});
after(async () => {
  server.close();
  await db.close();
});

test('an empty search lists every listed business', async () => {
  assert.deepEqual(codes(await search()), ['beans', 'doloruu', 'noodle']);
});

test('a business that turned listing off is not shown', async () => {
  assert.ok(!codes(await search('speakeasy')).includes('secret'));
});

test('an unlisted business can still be opened by its code', async () => {
  assert.equal((await call('GET', '/api/guest/venue/secret')).status, 200);
});

test('search matches the business name', async () => {
  assert.deepEqual(codes(await search('noodle')), ['noodle']);
});

test('search matches the street address', async () => {
  assert.deepEqual(codes(await search('sanlitun')), ['beans']);
});

test('the city filter keeps only places in that city', async () => {
  assert.deepEqual(codes(await search('', 'shanghai')), ['doloruu', 'noodle']);
});

test('the city list offers every listed city once', async () => {
  assert.deepEqual((await search()).json.cities, ['Beijing', 'Hangzhou', 'Shanghai']);
});

test('the city of an unlisted business is not offered', async () => {
  assert.ok(!(await search()).json.cities.includes('Suzhou'));
});

test('percent and underscore in a search are taken literally', async () => {
  assert.deepEqual(codes(await search('%')), []);
});

test('results show public details only', async () => {
  const entry = (await search('noodle')).json.results[0];
  assert.deepEqual(entry, { company: { name: 'Lanzhou Noodle House', code: 'noodle', business: 'restaurant' }, stores: [{ name: 'Main', code: 'MAIN', city: 'Shanghai', address: '5 Wulumuqi Road' }] });
});

test('a manager cannot change location details', async () => {
  const manager = (await call('POST', '/api/login', { company: 'doloruu', username: 'flag.manager', pin: '4444' })).json.token;
  assert.equal((await call('PATCH', '/api/hq/stores/1/location', { city: 'X' }, manager)).status, 403);
});

test("an owner cannot edit another company's location", async () => {
  assert.equal((await call('PATCH', '/api/hq/stores/1/location', { city: 'Hacked' }, owners.noodle)).status, 404);
});

test('my places lists the businesses a guest has booked with, newest first', async () => {
  const { token } = (await call('POST', '/api/guest/register', { phone: '13600000001', password: 'places-pass-1' })).json;
  await call('POST', '/api/guest/bookings', { company: 'noodle', store: 'MAIN', partySize: 2, eta: Date.now() + 5 * HOUR }, token);
  await db.run("UPDATE bookings SET created_at = created_at - ? WHERE customer_id = (SELECT customer_id FROM guest_passwords WHERE phone = '13600000001')", [HOUR]);
  await call('POST', '/api/guest/bookings', { company: 'doloruu', store: 'FLAG', partySize: 2, eta: Date.now() + 5 * HOUR }, token);
  const places = (await call('GET', '/api/guest/me/places', undefined, token)).json;
  assert.deepEqual(places.map((p: any) => p.company.code), ['doloruu', 'noodle']);
});

test('my places needs a signed-in guest', async () => {
  assert.equal((await call('GET', '/api/guest/me/places')).status, 401);
});
