import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { seed, DEMO_PINS } from '../src/seed.ts';
import { WechatMiniProgramLogin } from '../src/guest/identity.ts';
import { WechatProvider } from '../src/payments/wechat.ts';

const paths = createRequire(import.meta.url)('../miniprogram/utils/paths.js');
const ENV = { PAY_MODE: 'mock', MOCK_PAY_SECRET: 's3cret', PUBLIC_BASE_URL: 'http://venue.test' } as NodeJS.ProcessEnv;
let db: Db;
let server: Server;
let base: string;
let manager: string;

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const mpLogin = (code: string) => call('POST', '/api/guest/mp/login', { code });

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  await seed(db);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  manager = (await call('POST', '/api/login', { company: 'doloruu', username: 'flag.manager', pin: DEMO_PINS.manager })).json.token;
});
after(async () => {
  server.close();
  await db.close();
});

// ---------- sign-in ----------

test('a wx.login code signs the guest in', async () => {
  const { token } = (await mpLogin('wx-code-1')).json;
  assert.equal((await call('GET', '/api/guest/me', undefined, token)).status, 200);
});

test('the same WeChat user signing in again gets the same guest account', async () => {
  const a = (await mpLogin('wx-code-2')).json.customer.id;
  const b = (await mpLogin('wx-code-2')).json.customer.id;
  assert.equal(a, b);
});

test('mini program sign-in needs a code', async () => {
  assert.equal((await mpLogin('')).status, 422);
});

test('the customer app reports the mini program as available', async () => {
  assert.equal((await call('GET', '/api/guest/config')).json.miniProgram, true);
});

// ---------- web-view hand-off ----------

test('a hand-off code signs the web-view in as the same guest', async () => {
  const { token, customer } = (await mpLogin('wx-code-3')).json;
  const { code } = (await call('POST', '/api/guest/mp/handoff', undefined, token)).json;
  assert.equal((await call('POST', '/api/guest/mp/session', { code })).json.customer.id, customer.id);
});

test('a hand-off code works only once', async () => {
  const { token } = (await mpLogin('wx-code-4')).json;
  const { code } = (await call('POST', '/api/guest/mp/handoff', undefined, token)).json;
  await call('POST', '/api/guest/mp/session', { code });
  assert.equal((await call('POST', '/api/guest/mp/session', { code })).status, 401);
});

test('a hand-off code is refused by the browser sign-in exchange', async () => {
  const { token } = (await mpLogin('wx-code-5')).json;
  const { code } = (await call('POST', '/api/guest/mp/handoff', undefined, token)).json;
  assert.equal((await call('POST', '/api/guest/session', { code })).status, 401);
});

test('a hand-off code needs a signed-in mini program', async () => {
  assert.equal((await call('POST', '/api/guest/mp/handoff')).status, 401);
});

test('customer app pages may load the WeChat JS-SDK', async () => {
  const res = await fetch(`${base}/g/doloruu`);
  assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self' https:\/\/res\.wx\.qq\.com;/);
});

// ---------- paying from the mini program ----------

test('paying a table from the mini program starts a WeChat payment', async () => {
  const { token } = (await mpLogin('wx-code-6')).json;
  const tables = (await call('GET', '/api/tables', undefined, manager)).json;
  const reps = (await call('GET', '/api/reps', undefined, manager)).json;
  const product = (await call('GET', '/api/products', undefined, manager)).json.find((p: any) => p.price > 0 && p.unit !== 'kg');
  const table = tables.find((x: any) => x.status === 'free' && !x.min_spend);
  const billId = (await call('POST', '/api/bills', { tableId: table.id, repId: reps[0].id }, manager)).json.billId;
  await call('POST', `/api/bills/${billId}/lines`, { productId: product.id, qty: 1 }, manager);
  const { qrToken } = (await call('POST', `/api/tables/${table.id}/qr`, undefined, manager)).json;
  const r = await call('POST', `/api/guest/table/${qrToken}/pay`, { method: 'wechat', channel: 'miniprogram', returnPath: '/g/doloruu' }, token);
  assert.deepEqual([r.status, r.json.kind], [200, 'mock']);
});

test('Alipay cannot be used from the mini program', async () => {
  const { token } = (await mpLogin('wx-code-7')).json;
  assert.equal((await call('POST', '/api/guest/table/nope/pay', { method: 'alipay', channel: 'miniprogram' }, token)).status, 422);
});

// ---------- WeChat side ----------

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const replyWith = (reply: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(reply), { status: 200 })) as typeof fetch;
};

test('jscode2session signs the guest in by openid', async () => {
  replyWith({ openid: 'o-123', session_key: 'k', unionid: 'u-1' });
  const p = await new WechatMiniProgramLogin('wxapp', 'secret').login('c');
  assert.deepEqual([p.subject, p.appId, p.unionId], ['o-123', 'wxapp', 'u-1']);
});

test('a rejected jscode2session code fails the sign-in', async () => {
  replyWith({ errcode: 40029, errmsg: 'invalid code' });
  await assert.rejects(new WechatMiniProgramLogin('wxapp', 'secret').login('c'), /40029/);
});

test('mini program payments are ordered and signed under the mini program appid', async () => {
  const k = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = (x: any, type: 'private' | 'public') => x.export({ type: type === 'private' ? 'pkcs8' : 'spki', format: 'pem' }) as string;
  let sent: any;
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ prepay_id: 'wx1' }), { status: 200 });
  }) as typeof fetch;
  const wx = new WechatProvider({ appId: 'wx-oa', mchId: 'm', serialNo: 's', apiV3Key: 'k'.repeat(32), privateKeyPem: pem(k.privateKey, 'private'), platformPublicKeyPem: pem(k.publicKey, 'public') });
  const charge = await wx.createGuestCharge({ outTradeNo: 'T1', amountFen: 100, subject: 's', notifyUrl: 'http://x', returnUrl: 'http://x', openId: 'o', appId: 'wx-mp' });
  assert.deepEqual([sent.appid, (charge as any).params.appId], ['wx-mp', 'wx-mp']);
});

// ---------- mini program helpers ----------

test('a scanned table code on our domain opens that table', () => {
  assert.equal(paths.pathFromScan('https://pos.example.cn/g/doloruu/FLAG/t/abc', 'https://pos.example.cn'), '/g/doloruu/FLAG/t/abc');
});

test('a scanned code from another site is not opened', () => {
  assert.equal(paths.pathFromScan('https://evil.example/g/doloruu', 'https://pos.example.cn'), null);
});

test('the pay page only calls the customer app pay endpoints', () => {
  assert.equal(paths.isPayPath('/api/guest/me'), false);
});
