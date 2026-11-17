import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { seed } from '../src/seed.ts';
import { oaSignature } from '../src/guest/wechat-oa.ts';
import { similarity } from '../src/guest/bot.ts';

const ENV = { PAY_MODE: 'mock', MOCK_PAY_SECRET: 's3cret', PUBLIC_BASE_URL: 'http://venue.test', SIGNUP_OPEN: '1' } as NodeJS.ProcessEnv;
const OA_TOKEN = 'doloruuBot2026';
const SIGNUP = { name: 'Corner Bar', storeName: 'Main', ownerName: 'Lee', ownerUsername: 'lee', ownerPin: 'secret1', address: '9 Wulumuqi Road', city: 'Shanghai', postalCode: '200031' };
let db: Db;
let server: Server;
let base: string;
let ipSeq = 0;
const staff: Record<string, string> = {};

async function call(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function guest(phone: string): Promise<string> {
  return (await call('POST', '/api/guest/register', { phone, password: 'guestpass1', name: 'Guest' })).json.token;
}

const ask = (token: string, message: string, extra: Record<string, unknown> = {}) =>
  call('POST', '/api/guest/requests', { kind: 'support', company: 'doloruu', store: 'FLAG', message, ...extra }, token);

const signup = (body: Record<string, unknown>) => call('POST', '/api/signup', body, undefined, { 'x-forwarded-for': `198.51.100.${++ipSeq}` });

function oaQuery(extra: Record<string, string> = {}): string {
  const timestamp = '1763380000';
  const nonce = 'n0nce';
  return new URLSearchParams({ timestamp, nonce, signature: oaSignature(OA_TOKEN, timestamp, nonce), ...extra }).toString();
}

const oaText = (content: string) => `<xml><ToUserName><![CDATA[gh_venue]]></ToUserName><FromUserName><![CDATA[oFollower1]]></FromUserName>
<CreateTime>1763380000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content><MsgId>1</MsgId></xml>`;

async function oaPost(xml: string, query = oaQuery()) {
  const res = await fetch(`${base}/webhooks/wechat-oa/doloruu?${query}`, { method: 'POST', body: xml });
  return { status: res.status, text: await res.text() };
}

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  await seed(db);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  for (const [k, [username, pin]] of Object.entries({ waiter: ['flag.waiter', '2222'], manager: ['flag.manager', '4444'] })) {
    staff[k] = (await call('POST', '/api/login', { company: 'doloruu', username, pin })).json.token;
  }
  await call('POST', '/api/bot/faqs', { question: '营业到几点\n几点关门', answer: '我们每天营业到凌晨两点。', questionEn: 'What time do you close?', answerEn: 'We are open until 2 am every day.' }, staff.manager);
  await call('PUT', '/api/bot/wechat', { appId: 'wx0123456789abcdef', token: OA_TOKEN }, staff.manager);
});
after(async () => {
  server.close();
  await db.close();
});

// ---------- merchant sign-up address ----------

test('merchant sign-up without a street address is a 422', async () => {
  assert.equal((await signup({ ...SIGNUP, code: 'no-address', address: '' })).status, 422);
});

test('merchant sign-up without a postal code is a 422', async () => {
  assert.equal((await signup({ ...SIGNUP, code: 'no-postal', postalCode: '' })).status, 422);
});

test('merchant sign-up with a malformed postal code is a 422', async () => {
  assert.equal((await signup({ ...SIGNUP, code: 'bad-postal', postalCode: '2000#1' })).status, 422);
});

test('a signed-up merchant shows in the customer app with its address and postal code', async () => {
  await signup({ ...SIGNUP, code: 'corner-bar' });
  const v = (await call('GET', '/api/guest/venue/corner-bar')).json;
  assert.deepEqual([v.stores[0].address, v.stores[0].city, v.stores[0].postalCode], ['9 Wulumuqi Road', 'Shanghai', '200031']);
});

test('a signed-up merchant is found in the directory by its street', async () => {
  await signup({ ...SIGNUP, code: 'street-bar', ownerUsername: 'lee2', address: '77 Anfu Road' });
  const r = (await call('GET', '/api/guest/directory?q=Anfu&city=')).json;
  assert.deepEqual(r.results.map((x: any) => x.company.code), ['street-bar']);
});

test('the owner can change a location postal code later', async () => {
  const owner = (await call('POST', '/api/login', { company: 'doloruu', username: 'owner', pin: '6666' })).json.token;
  const flag = (await call('GET', '/api/hq/stores', undefined, owner)).json.find((s: any) => s.code === 'FLAG');
  await call('PATCH', `/api/hq/stores/${flag.id}/location`, { city: flag.city, address: flag.address, postalCode: '200040' }, owner);
  assert.equal((await call('GET', '/api/hq/stores', undefined, owner)).json.find((s: any) => s.code === 'FLAG').postalCode, '200040');
});

// ---------- matching ----------

test('a Chinese question asked in other words still matches', () => {
  assert.ok(similarity('请问你们几点关门呀', '几点关门') >= 0.6);
});

test('an unrelated question does not match', () => {
  assert.ok(similarity('可以带狗吗', '营业到几点') < 0.6);
});

// ---------- in the app ----------

test('the auto-reply answers a FAQ question in the app straight away', async () => {
  const g = await guest('13700000001');
  assert.equal((await ask(g, '你们几点关门？')).json.autoReply, '我们每天营业到凌晨两点。');
});

test('the auto-reply answers in English when asked in English', async () => {
  const g = await guest('13700000002');
  assert.equal((await ask(g, 'what time do you close')).json.autoReply, 'We are open until 2 am every day.');
});

test('an answered message is closed and marked as answered by the bot', async () => {
  const g = await guest('13700000003');
  const { requestId } = (await ask(g, '几点关门')).json;
  const mine = (await call('GET', '/api/guest/requests/doloruu', undefined, g)).json.find((r: any) => r.id === requestId);
  assert.deepEqual([mine.status, mine.byBot], ['done', true]);
});

test('asking for the address gets the street, postal code and a map link', async () => {
  const g = await guest('13700000004');
  const reply = (await ask(g, '你们的地址在哪里')).json.autoReply as string;
  assert.match(reply, /88 Julu Road.*\n.*uri\.amap\.com\/search\?keyword=/);
});

test('asking how to book gets the booking link in the app', async () => {
  const g = await guest('13700000005');
  assert.equal((await ask(g, 'how do I book a table')).json.autoReply, 'Book online: /g/doloruu/FLAG/book');
});

test('a question the bot cannot answer waits for staff', async () => {
  const g = await guest('13700000006');
  const { requestId, autoReply } = (await ask(g, '可以带狗狗进来吗')).json;
  const inbox = (await call('GET', '/api/guest-requests', undefined, staff.waiter)).json.find((r: any) => r.id === requestId);
  assert.deepEqual([autoReply, inbox.status], [null, 'pending']);
});

test('a question the bot cannot answer shows in Admin open questions', async () => {
  const g = await guest('13700000007');
  await ask(g, '包间最低消费多少');
  assert.ok((await call('GET', '/api/bot/questions', undefined, staff.manager)).json.some((q: any) => q.text === '包间最低消费多少'));
});

test('answering an open question removes it and the bot answers it next time', async () => {
  const g = await guest('13700000008');
  await ask(g, '可以刷信用卡吗');
  const q = (await call('GET', '/api/bot/questions', undefined, staff.manager)).json.find((x: any) => x.text === '可以刷信用卡吗');
  await call('POST', '/api/bot/faqs', { question: q.text, answer: '可以，支持 Visa 和万事达卡。', fromQuestion: q.id }, staff.manager);
  const open = (await call('GET', '/api/bot/questions', undefined, staff.manager)).json.some((x: any) => x.id === q.id);
  assert.deepEqual([open, (await ask(g, '能刷信用卡吗？')).json.autoReply], [false, '可以，支持 Visa 和万事达卡。']);
});

test('asking for a person skips the bot', async () => {
  const g = await guest('13700000009');
  assert.equal((await ask(g, '几点关门', { human: true })).json.autoReply, null);
});

test('with auto-reply switched off nothing is answered automatically', async () => {
  const g = await guest('13700000010');
  await call('PATCH', '/api/guest-settings', { features: { bot: false } }, staff.manager);
  const r = (await ask(g, '几点关门')).json.autoReply;
  await call('PATCH', '/api/guest-settings', { features: { bot: true } }, staff.manager);
  assert.equal(r, null);
});

test('a waiter cannot edit the auto-reply answers', async () => {
  assert.equal((await call('POST', '/api/bot/faqs', { question: 'x', answer: 'y' }, staff.waiter)).status, 403);
});

// ---------- WeChat Official Account ----------

test('the WeChat token is never sent back to staff', async () => {
  const w = (await call('GET', '/api/bot/wechat', undefined, staff.manager)).json;
  assert.deepEqual([w.hasToken, w.token, w.url], [true, undefined, 'http://venue.test/webhooks/wechat-oa/doloruu']);
});

test('WeChat server verification echoes echostr when signed with the token', async () => {
  const res = await fetch(`${base}/webhooks/wechat-oa/doloruu?${oaQuery({ echostr: 'hello123' })}`);
  assert.deepEqual([res.status, await res.text()], [200, 'hello123']);
});

test('WeChat calls with a wrong signature are refused', async () => {
  const res = await fetch(`${base}/webhooks/wechat-oa/doloruu?timestamp=1&nonce=2&signature=bad&echostr=x`);
  assert.equal(res.status, 401);
});

test('a WeChat follower question is answered from the FAQ in a reply message', async () => {
  const r = await oaPost(oaText('几点关门'));
  assert.match(r.text, /<ToUserName><!\[CDATA\[oFollower1\]\]><\/ToUserName>.*<Content><!\[CDATA\[我们每天营业到凌晨两点。\]\]><\/Content>/s);
});

test('WeChat replies use full links back to the app', async () => {
  const r = await oaPost(oaText('点歌'));
  assert.match(r.text, /http:\/\/venue\.test\/g\/doloruu\/songs/);
});

test('an unknown WeChat question gets the hand-off message and is kept for staff', async () => {
  const r = await oaPost(oaText('能开发票吗'));
  const kept = (await call('GET', '/api/bot/questions', undefined, staff.manager)).json.find((q: any) => q.text === '能开发票吗');
  assert.deepEqual([/转给工作人员/.test(r.text), kept?.channel], [true, 'wechat']);
});

test('a new WeChat follower gets the welcome message', async () => {
  const xml = '<xml><ToUserName><![CDATA[gh_venue]]></ToUserName><FromUserName><![CDATA[oNew]]></FromUserName><CreateTime>1</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe]]></Event></xml>';
  assert.match((await oaPost(xml)).text, /Doloruu Group 自动回复/);
});

test('a WeChat message to a company that has not linked its account is refused', async () => {
  const res = await fetch(`${base}/webhooks/wechat-oa/corner-bar?${oaQuery()}`, { method: 'POST', body: oaText('hi') });
  assert.equal(res.status, 401);
});
