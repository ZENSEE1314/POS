import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { seed } from '../src/seed.ts';

const ADMIN_KEY = 'platform-test-key';
const ENV = { PAY_MODE: 'mock', MOCK_PAY_SECRET: 's3cret', PLATFORM_ADMIN_KEY: ADMIN_KEY, PUBLIC_BASE_URL: 'http://venue.test' } as NodeJS.ProcessEnv;
/** A real 1x1 PNG. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let db: Db;
let server: Server;
let base: string;
let manager = '';
let waiter = '';

async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const venueTheme = async (code = 'doloruu') => (await call('GET', `/api/guest/venue/${code}`)).json.theme;

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  await seed(db);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  manager = (await call('POST', '/api/login', { company: 'doloruu', username: 'flag.manager', pin: '4444' })).json.token;
  waiter = (await call('POST', '/api/login', { company: 'doloruu', username: 'flag.waiter', pin: '2222' })).json.token;
  await call('POST', '/platform/companies', { name: 'Other Bar', code: 'otherbar', storeName: 'Main', ownerName: 'Boss', ownerUsername: 'boss', ownerPin: '246810' });
});
after(async () => {
  server.close();
  await db.close();
});

test('a company starts with the night theme and no pictures', async () => {
  assert.deepEqual(await venueTheme('otherbar'), { preset: 'night', accent: '', headline: '', tagline: '', layout: 'list', logo: null, cover: null });
});

test('a manager can change the theme and guests see it', async () => {
  await call('PATCH', '/api/guest-theme', { preset: 'daylight', accent: '#0F766E', layout: 'grid', headline: 'Doloruu', tagline: 'Late nights' }, manager);
  const th = await venueTheme();
  assert.deepEqual([th.preset, th.accent, th.layout, th.headline, th.tagline], ['daylight', '#0f766e', 'grid', 'Doloruu', 'Late nights']);
});

test('changing one field keeps the others', async () => {
  await call('PATCH', '/api/guest-theme', { preset: 'blush', accent: '#d9467a', layout: 'list' }, manager);
  await call('PATCH', '/api/guest-theme', { tagline: 'Only this' }, manager);
  assert.equal((await venueTheme()).preset, 'blush');
});

test('an unknown theme is refused', async () => {
  assert.equal((await call('PATCH', '/api/guest-theme', { preset: 'rainbow' }, manager)).status, 422);
});

test('a colour that is not #rrggbb is refused', async () => {
  assert.equal((await call('PATCH', '/api/guest-theme', { accent: 'red' }, manager)).status, 422);
});

test('a waiter cannot change the design', async () => {
  assert.equal((await call('PATCH', '/api/guest-theme', { preset: 'noir' }, waiter)).status, 403);
});

test('an uploaded logo is served to guests as an image', async () => {
  await call('PUT', '/api/guest-theme/images/logo', { dataUrl: PNG }, manager);
  const res = await fetch(base + (await venueTheme()).logo);
  assert.deepEqual([res.status, res.headers.get('content-type')], [200, 'image/png']);
});

test('a file that only claims to be an image is refused', async () => {
  const fake = `data:image/png;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`;
  assert.equal((await call('PUT', '/api/guest-theme/images/cover', { dataUrl: fake }, manager)).status, 422);
});

test('an SVG upload is refused', async () => {
  const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`;
  assert.equal((await call('PUT', '/api/guest-theme/images/cover', { dataUrl: svg }, manager)).status, 422);
});

test('an image over the size limit is refused', async () => {
  const big = `data:image/png;base64,${Buffer.concat([Buffer.from(PNG.split(',')[1], 'base64'), Buffer.alloc(185 * 1024)]).toString('base64')}`;
  assert.equal((await call('PUT', '/api/guest-theme/images/cover', { dataUrl: big }, manager)).status, 413);
});

test('only logo and cover pictures exist', async () => {
  assert.equal((await call('PUT', '/api/guest-theme/images/banner', { dataUrl: PNG }, manager)).status, 404);
});

test('removing the logo takes it off the customer app', async () => {
  await call('PUT', '/api/guest-theme/images/logo', { dataUrl: PNG }, manager);
  await call('DELETE', '/api/guest-theme/images/logo', undefined, manager);
  assert.equal((await venueTheme()).logo, null);
});

test("one company's picture is not served under another company's code", async () => {
  await call('PUT', '/api/guest-theme/images/cover', { dataUrl: PNG }, manager);
  assert.equal((await fetch(`${base}/api/guest/images/otherbar/cover`)).status, 404);
});

test('the search results carry the company logo', async () => {
  await call('PUT', '/api/guest-theme/images/logo', { dataUrl: PNG }, manager);
  const entry = (await call('GET', '/api/guest/directory?q=doloruu')).json.results[0];
  assert.match(entry.company.logo, /^\/api\/guest\/images\/doloruu\/logo\?v=\d+$/);
});

test('design changes are recorded in the audit log', async () => {
  const row = await db.one("SELECT COUNT(*) AS n FROM audit WHERE action IN ('guest.theme', 'guest.image')");
  assert.ok(Number(row.n) > 0);
});
