import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';

const ADMIN_KEY = 'leads-admin-key-0123456789';
const ENV = { PAY_MODE: 'mock', MOCK_PAY_SECRET: 's3cret', PLATFORM_ADMIN_KEY: ADMIN_KEY } as NodeJS.ProcessEnv;
let db: Db;
let server: Server;
let base: string;
let ipSeq = 0;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const lead = (body: Record<string, unknown>, ip = `203.0.113.${++ipSeq}`) =>
  call('POST', '/api/leads', { kind: 'demo', name: 'Lee', phone: '13800138000', ...body }, { 'x-forwarded-for': ip });
const admin = { 'x-admin-key': ADMIN_KEY };

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await db.close();
});

test('the sales website page is served at /site', async () => {
  const res = await fetch(`${base}/site`);
  assert.match(await res.text(), /id="lead-form"/);
});

test('a demo request from the website reaches the operator lead list', async () => {
  await lead({ company: 'Blue Note Bar', city: 'Chengdu' });
  const leads = (await call('GET', '/platform/leads', undefined, admin)).json;
  assert.ok(leads.some((l: any) => l.company === 'Blue Note Bar' && l.city === 'Chengdu' && l.status === 'new'));
});

test('a referral keeps who referred the bar', async () => {
  await lead({ kind: 'referral', company: 'Moon Lounge', referrer: 'Amy 13900000000' });
  const leads = (await call('GET', '/platform/leads', undefined, admin)).json;
  assert.equal(leads.find((l: any) => l.company === 'Moon Lounge').referrer, 'Amy 13900000000');
});

test('a request without a phone number is a 422', async () => {
  assert.equal((await lead({ phone: '' })).status, 422);
});

test('an unknown request kind is a 422', async () => {
  assert.equal((await lead({ kind: 'spam' })).status, 422);
});

test('one address cannot flood the lead list', async () => {
  const statuses = [];
  for (let i = 0; i < 11; i += 1) statuses.push((await lead({}, '198.18.0.1')).status);
  assert.equal(statuses.at(-1), 429);
});

test('the lead list needs the operator key', async () => {
  assert.equal((await call('GET', '/platform/leads')).status, 403);
});

test('the operator can mark a lead as contacted with a note', async () => {
  await lead({ company: 'Neon Club' });
  const id = (await call('GET', '/platform/leads', undefined, admin)).json.find((l: any) => l.company === 'Neon Club').id;
  await call('PATCH', `/platform/leads/${id}`, { status: 'contacted', note: 'called, demo Friday' }, admin);
  const after = (await call('GET', '/platform/leads?status=contacted', undefined, admin)).json.find((l: any) => l.id === id);
  assert.deepEqual([after.status, after.note], ['contacted', 'called, demo Friday']);
});
