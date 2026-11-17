import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { AlipayProvider } from '../src/payments/alipay.ts';
import { WechatProvider } from '../src/payments/wechat.ts';
import { PENDING_HOLD_MS } from '../src/payments/http.ts';
import { MockProvider } from '../src/payments/mock.ts';
import { addLine, openTable } from '../src/bills.ts';
import { actorFromToken, login } from '../src/auth.ts';
import { openDb } from '../src/db.ts';
import { handleNotify, startOnlinePayment } from '../src/payments.ts';
import { seed } from '../src/seed.ts';

const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const publicKeyPem = merchant.publicKey.export({ type: 'spki', format: 'pem' }) as string;
const CHARGE = { outTradeNo: 'NP1T1', amountFen: 1234, subject: 'Bill 1', notifyUrl: 'http://x.test/webhooks/x' };
const RFC3339_BEIJING = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

interface Captured { url: string; init: RequestInit }
function stubFetch(reply: unknown): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as typeof fetch;
  return calls;
}

const wechat = () => new WechatProvider({ appId: 'a', mchId: 'm', serialNo: 's', apiV3Key: 'k'.repeat(32), privateKeyPem, platformPublicKeyPem: publicKeyPem });
const alipay = () => new AlipayProvider({ appId: 'app1', privateKeyPem, alipayPublicKeyPem: publicKeyPem });

function parseBeijing(rfc3339: string): number {
  return Date.parse(rfc3339);
}

test('wechat order carries time_expire equal to the pending hold', async () => {
  const calls = stubFetch({ code_url: 'weixin://x' });
  const before = Date.now();
  await wechat().createCharge(CHARGE);
  const body = JSON.parse(String(calls[0].init.body));
  assert.match(body.time_expire, RFC3339_BEIJING);
  const delta = parseBeijing(body.time_expire) - before;
  assert.ok(Math.abs(delta - PENDING_HOLD_MS) < 5_000, `expires in ${delta}ms`);
});

test('alipay precreate carries timeout_express matching the pending hold', async () => {
  const calls = stubFetch({ alipay_trade_precreate_response: { code: '10000', qr_code: 'https://qr' } });
  await alipay().createCharge(CHARGE);
  const biz = JSON.parse(new URLSearchParams(String(calls[0].init.body)).get('biz_content')!);
  assert.equal(biz.timeout_express, `${PENDING_HOLD_MS / 60_000}m`);
});

test('alipay wap pay carries timeout_express matching the pending hold', async () => {
  const charge = await alipay().createGuestCharge({ ...CHARGE, returnUrl: 'http://x.test/back' });
  assert.equal(charge.kind, 'redirect');
  const url = new URL((charge as { url: string }).url);
  assert.equal(JSON.parse(url.searchParams.get('biz_content')!).timeout_express, `${PENDING_HOLD_MS / 60_000}m`);
});

test('every provider call carries an abort signal', async () => {
  const calls = stubFetch({ code_url: 'weixin://x' });
  await wechat().createCharge(CHARGE);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('a provider call that times out fails with a clear message', async () => {
  globalThis.fetch = (async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }) as typeof fetch;
  await assert.rejects(wechat().createCharge(CHARGE), /timed out/);
});

test('a charge that timed out is marked failed, and a late paid notify still books it', async () => {
  const db = await openDb();
  await seed(db, {} as NodeJS.ProcessEnv);
  const host = await actorFromToken(db, (await login(db, 'doloruu', 'flag.host', '1111')).token);
  const cashier = await actorFromToken(db, (await login(db, 'doloruu', 'flag.cashier', '3333')).token);
  const billId = await openTable(db, host, { tableId: 3, repId: 7 });
  const waiter = await actorFromToken(db, (await login(db, 'doloruu', 'flag.waiter', '2222')).token);
  await addLine(db, waiter, billId, { productId: 3, qty: 1 });
  const mock = new MockProvider('wechat', 's3cret');
  const hung = { method: 'wechat' as const, createGuestCharge: mock.createGuestCharge, parseNotify: mock.parseNotify.bind(mock),
    createCharge: async () => { throw new Error('request timed out after 10s'); } };

  await assert.rejects(startOnlinePayment(db, cashier, hung, 'http://x.test', billId), /timed out/);
  const failed = (await db.one('SELECT id, status, out_trade_no, amount FROM payments WHERE bill_id = ?', [billId]))!;
  const raw = JSON.stringify({ eventId: 'late-1', outTradeNo: failed.out_trade_no, amountFen: failed.amount, status: 'paid' });
  await handleNotify(db, 'wechat', mock, { 'x-mock-signature': mock.sign(raw) }, raw);

  const after = (await db.one('SELECT status FROM payments WHERE id = ?', [failed.id]))!.status;
  assert.deepEqual([failed.status, after], ['failed', 'paid']);
  await db.close();
});
