import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { seed } from '../src/seed.ts';

const ENV = { PAY_MODE: 'mock', MOCK_PAY_SECRET: 's3cret', PUBLIC_BASE_URL: 'http://venue.test', GUEST_OTP_PER_IP_PER_HOUR: '1000' } as NodeJS.ProcessEnv;
const HOUR = 3_600_000;
const REP_ID = 7;
const BEER = 3; // ¥28
let db: Db;
let server: Server;
let base: string;
const staff: Record<string, string> = {};
const qr: Record<string, string> = {};
const tableId: Record<string, number> = {};

async function call(method: string, path: string, body?: unknown, token?: string, cookie = ''): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function guest(name: string): Promise<string> {
  const start = await fetch(`${base}/api/guest/auth/wechat/start?return=/g/doloruu`, { redirect: 'manual' });
  const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0];
  const state = new URL(start.headers.get('location')!, base).searchParams.get('state')!;
  const back = (await fetch(`${base}/api/guest/auth/wechat/callback?state=${state}&code=${encodeURIComponent(name)}`, { redirect: 'manual', headers: { Cookie: cookie } })).headers.get('location')!;
  const code = /#login=([0-9a-f]+)$/.exec(back)![1];
  return (await call('POST', '/api/guest/session', { code }, undefined, cookie)).json.token;
}

async function verifyPhone(token: string, phone: string) {
  await db.run('DELETE FROM guest_otps WHERE phone = ?', [phone]);
  const { devCode } = (await call('POST', '/api/guest/otp', { phone })).json;
  return call('POST', '/api/guest/me/phone', { phone, code: devCode }, token);
}

/** Order at a table, staff accept (opening it), returns the bill id. */
async function openWithOrder(token: string, table: string, qty = 1): Promise<number> {
  const { orderId } = (await call('POST', '/api/guest/orders', { qrToken: qr[table], items: [{ productId: BEER, qty }] }, token)).json;
  return (await call('POST', `/api/guest-orders/${orderId}/accept`, { repId: REP_ID }, staff.waiter)).json.billId;
}

async function payInApp(token: string, table: string) {
  const charge = (await call('POST', `/api/guest/table/${qr[table]}/pay`, { method: 'wechat' }, token)).json;
  return call('POST', `/api/guest/payments/${charge.outTradeNo}/mock-pay`, {}, token);
}

const points = async (token: string) => (await call('GET', '/api/guest/loyalty/doloruu', undefined, token)).json.balance;
const request = (token: string, body: Record<string, unknown>) => call('POST', '/api/guest/requests', body, token);

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  await seed(db);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  for (const [k, [username, pin]] of Object.entries({ waiter: ['flag.waiter', '2222'], manager: ['flag.manager', '4444'], host: ['flag.host', '1111'] })) {
    staff[k] = (await call('POST', '/api/login', { company: 'doloruu', username, pin })).json.token;
  }
  for (const t of (await call('GET', '/api/tables', undefined, staff.manager)).json) {
    qr[t.name] = t.qr_token;
    tableId[t.name] = t.id;
  }
});
after(async () => {
  server.close();
  await db.close();
});

// ---------- requests to staff ----------

test('a guest can call a waiter from the table and staff see it with the table name', async () => {
  const g = await guest('Caller');
  await request(g, { kind: 'service', qrToken: qr.A1, reason: 'ice' });
  const list = (await call('GET', '/api/guest-requests', undefined, staff.waiter)).json;
  assert.deepEqual([list[0].kind, list[0].tableName, list[0].detail.reason], ['service', 'A1', 'ice']);
});

test('an unknown service reason is a 422', async () => {
  const g = await guest('Caller');
  assert.equal((await request(g, { kind: 'service', qrToken: qr.A1, reason: 'dance' })).status, 422);
});

test('a song request needs a song title', async () => {
  const g = await guest('Singer');
  assert.equal((await request(g, { kind: 'song', qrToken: qr.A1, artist: 'Jay Chou' })).status, 422);
});

test('a song request reaches staff with title and artist', async () => {
  const g = await guest('Singer');
  const { requestId } = (await request(g, { kind: 'song', qrToken: qr.A1, title: '晴天', artist: 'Jay Chou' })).json;
  const r = (await call('GET', '/api/guest-requests', undefined, staff.waiter)).json.find((x: any) => x.id === requestId);
  assert.deepEqual([r.detail.title, r.detail.artist], ['晴天', 'Jay Chou']);
});

test('a song request from the app without a table reaches staff at the chosen location', async () => {
  const g = await guest('Lobby singer');
  const { requestId } = (await request(g, { kind: 'song', company: 'doloruu', store: 'FLAG', title: '稻香' })).json;
  const r = (await call('GET', '/api/guest-requests', undefined, staff.waiter)).json.find((x: any) => x.id === requestId);
  assert.deepEqual([r.detail.title, r.tableName, r.storeCode], ['稻香', null, 'FLAG']);
});

test('a song request without a table needs a real location', async () => {
  const g = await guest('Lost singer');
  assert.equal((await request(g, { kind: 'song', company: 'doloruu', store: 'NOPE', title: '稻香' })).status, 404);
});

test('asking for a bottle the guest has not stored is a 404', async () => {
  const g = await guest('Bottle');
  await verifyPhone(g, '13800000101');
  assert.equal((await request(g, { kind: 'bottle', qrToken: qr.A1, code: 'NOPE01' })).status, 404);
});

test('a guest can ask for their own stored bottle at the table', async () => {
  const g = await guest('Bottle');
  await db.run(`INSERT INTO stash (store_id, phone, product_id, name, qty_milli, left_milli, expires_at, code, created_at)
    VALUES (1, '13800000101', 1, 'Hennessy XO', 1000, 600, ?, 'STASH1', ?)`, [Date.now() + 30 * 24 * HOUR, Date.now()]);
  const r = await request(g, { kind: 'bottle', qrToken: qr.A1, code: 'STASH1' });
  const saved = (await call('GET', '/api/guest-requests', undefined, staff.waiter)).json.find((x: any) => x.id === r.json.requestId);
  assert.deepEqual([saved.detail.name, saved.detail.leftMilli], ['Hennessy XO', 600]);
});

test('declining a request needs a reason', async () => {
  const g = await guest('Decline');
  const { requestId } = (await request(g, { kind: 'song', qrToken: qr.A2, title: 'Song' })).json;
  assert.equal((await call('POST', `/api/guest-requests/${requestId}/decline`, {}, staff.waiter)).status, 422);
});

test('the guest reads the staff reply to a support message', async () => {
  const g = await guest('Helpme');
  const { requestId } = (await request(g, { kind: 'support', company: 'doloruu', store: 'FLAG', message: 'I left my jacket' })).json;
  await call('POST', `/api/guest-requests/${requestId}/done`, { reply: 'Found it at the bar' }, staff.waiter);
  const mine = (await call('GET', '/api/guest/requests/doloruu', undefined, g)).json.find((x: any) => x.id === requestId);
  assert.deepEqual([mine.status, mine.reply], ['done', 'Found it at the bar']);
});

test('a guest can cancel a request that is still waiting', async () => {
  const g = await guest('Cancel');
  const { requestId } = (await request(g, { kind: 'service', qrToken: qr.A2, reason: 'waiter' })).json;
  assert.equal((await call('POST', `/api/guest/requests/${requestId}/cancel`, {}, g)).status, 200);
});

test('a sixth waiting request from one guest is refused', async () => {
  const g = await guest('Spammer');
  for (let i = 0; i < 5; i++) await request(g, { kind: 'service', qrToken: qr.A3, reason: 'other' });
  assert.equal((await request(g, { kind: 'service', qrToken: qr.A3, reason: 'other' })).status, 429);
});

test('the waiting count on the staff tab includes requests', async () => {
  const c = (await call('GET', '/api/guest-orders/count', undefined, staff.waiter)).json;
  assert.equal(c.pending, c.orders + c.requests);
});

test('a host (no order.add) cannot read guest requests', async () => {
  assert.equal((await call('GET', '/api/guest-requests', undefined, staff.host)).status, 403);
});

// ---------- pet care ----------

test('pet care is switched off until the venue turns it on', async () => {
  const g = await guest('Petowner');
  const { id } = (await call('POST', '/api/guest/pets', { name: 'Mochi', species: 'cat' }, g)).json;
  assert.equal((await request(g, { kind: 'pet', company: 'doloruu', store: 'FLAG', petId: id, service: 'grooming', when: Date.now() + HOUR })).status, 404);
});

test('once on, a pet care request carries the pet details for staff', async () => {
  await call('PATCH', '/api/guest-settings', { features: { pets: true } }, staff.manager);
  const g = await guest('Petowner');
  const { id } = (await call('POST', '/api/guest/pets', { name: 'Bean', species: 'dog', breed: 'Corgi', notes: 'shy' }, g)).json;
  const { requestId } = (await request(g, { kind: 'pet', company: 'doloruu', store: 'FLAG', petId: id, service: 'bath', when: Date.now() + HOUR })).json;
  const r = (await call('GET', '/api/guest-requests', undefined, staff.waiter)).json.find((x: any) => x.id === requestId);
  assert.deepEqual([r.detail.pet.name, r.detail.pet.breed, r.detail.service], ['Bean', 'Corgi', 'bath']);
});

test('a guest cannot book care for someone else pet', async () => {
  const owner = await guest('Petowner');
  const { id } = (await call('POST', '/api/guest/pets', { name: 'Kiwi', species: 'other' }, owner)).json;
  const other = await guest('Stranger');
  assert.equal((await request(other, { kind: 'pet', company: 'doloruu', store: 'FLAG', petId: id, service: 'visit', when: Date.now() + HOUR })).status, 404);
});

// ---------- feature switches ----------

test('a waiter cannot change customer app settings', async () => {
  assert.equal((await call('PATCH', '/api/guest-settings', { features: { song: false } }, staff.waiter)).status, 403);
});

test('a feature switched off is refused', async () => {
  await call('PATCH', '/api/guest-settings', { features: { song: false } }, staff.manager);
  const g = await guest('Singer');
  const status = (await request(g, { kind: 'song', qrToken: qr.A4, title: 'x' })).status;
  await call('PATCH', '/api/guest-settings', { features: { song: true } }, staff.manager);
  assert.equal(status, 404);
});

test('the venue page tells the app which features are on', async () => {
  const v = (await call('GET', '/api/guest/venue/doloruu')).json;
  assert.equal(v.features.pets, true);
});

// ---------- loyalty, vouchers, wheel ----------

test('paying through the app earns one point per yuan', async () => {
  const g = await guest('Earner');
  await openWithOrder(g, 'B1', 2);
  await payInApp(g, 'B1');
  // B tables have a ¥2,000 minimum spend, which is what gets paid.
  assert.equal(await points(g), 2000);
});

test('redeeming a reward spends points and gives a voucher code', async () => {
  const { id } = (await call('POST', '/api/loyalty-rewards', { name: '免费果盘', nameEn: 'Free fruit platter', cost: 500 }, staff.manager)).json;
  const g = await guest('Earner');
  const r = (await call('POST', '/api/guest/loyalty/doloruu/redeem', { rewardId: id }, g)).json;
  assert.deepEqual([r.balance, /^[A-Z2-9]{8}$/.test(r.voucher.code)], [1500, true]);
});

test('redeeming without enough points is a 402', async () => {
  const { id } = (await call('POST', '/api/loyalty-rewards', { name: 'Big prize', cost: 999999 }, staff.manager)).json;
  const g = await guest('Earner');
  assert.equal((await call('POST', '/api/guest/loyalty/doloruu/redeem', { rewardId: id }, g)).status, 402);
});

test('a voucher can be used by staff only once', async () => {
  const g = await guest('Earner');
  const code = (await call('GET', '/api/guest/loyalty/doloruu', undefined, g)).json.vouchers[0].code;
  await call('POST', `/api/vouchers/${code}/use`, {}, staff.waiter);
  assert.equal((await call('POST', `/api/vouchers/${code}/use`, {}, staff.waiter)).status, 409);
});

test('spinning without enough points is a 402', async () => {
  const g = await guest('Broke');
  assert.equal((await call('POST', '/api/guest/loyalty/doloruu/spin', {}, g)).status, 402);
});

test('a spin costs points and lands on one of the wheel prizes', async () => {
  const g = await guest('Earner');
  const before = await points(g);
  const wheel = (await call('GET', '/api/guest/loyalty/doloruu', undefined, g)).json.spin;
  const r = (await call('POST', '/api/guest/loyalty/doloruu/spin', {}, g)).json;
  const won = r.prize.kind === 'points' ? r.prize.points : 0;
  assert.deepEqual([r.balance, wheel.prizes[r.index].label], [before - wheel.cost + won, r.prize.label]);
});

test('a guest can spin at most 10 times a day', async () => {
  const g = await guest('Earner');
  await db.run('UPDATE customer_points SET balance = 100000');
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await call('POST', '/api/guest/loyalty/doloruu/spin', {}, g)).status);
  assert.equal(statuses.at(-1), 429);
});

// ---------- referrals ----------

test('a guest cannot use their own invite code', async () => {
  const g = await guest('Newbie');
  const code = (await call('GET', '/api/guest/loyalty/doloruu', undefined, g)).json.referral.code;
  assert.equal((await call('POST', '/api/guest/referral', { company: 'doloruu', code }, g)).status, 422);
});

test('a small first payment does not pay out the invite bonus yet', async () => {
  const friend = await guest('InviterSmall');
  const code = (await call('GET', '/api/guest/loyalty/doloruu', undefined, friend)).json.referral.code;
  const newbie = await guest('InviteeSmall');
  await call('POST', '/api/guest/referral', { company: 'doloruu', code }, newbie);
  await openWithOrder(newbie, 'A5');
  await payInApp(newbie, 'A5');
  assert.equal(await points(friend), 0);
});

test('the invite bonus goes to both guests once the new guest has spent ¥100', async () => {
  const friend = await guest('Inviter');
  const code = (await call('GET', '/api/guest/loyalty/doloruu', undefined, friend)).json.referral.code;
  const newbie = await guest('Invitee');
  await call('POST', '/api/guest/referral', { company: 'doloruu', code }, newbie);
  await openWithOrder(newbie, 'B4');
  await payInApp(newbie, 'B4');
  // B tables have a ¥2,000 minimum spend.
  assert.deepEqual([await points(friend), await points(newbie)], [200, 200 + 2000]);
});

test('a guest who has paid here before cannot use an invite code', async () => {
  const friend = await guest('Inviter2');
  const code = (await call('GET', '/api/guest/loyalty/doloruu', undefined, friend)).json.referral.code;
  const regular = await guest('Earner');
  assert.equal((await call('POST', '/api/guest/referral', { company: 'doloruu', code }, regular)).status, 409);
});

// ---------- events ----------

test('guests see an upcoming event and booking it puts the event in the staff note', async () => {
  const start = Date.now() + 24 * HOUR;
  const { id } = (await call('POST', '/api/venue-events', { title: '电音之夜', titleEn: 'EDM night', startsAt: start, endsAt: start + 5 * HOUR }, staff.manager)).json;
  const g = await guest('Partygoer');
  await verifyPhone(g, '13800000102');
  const events = (await call('GET', '/api/guest/events/doloruu')).json;
  const { bookingId } = (await call('POST', '/api/guest/bookings', { company: 'doloruu', store: 'FLAG', partySize: 6, eta: start, eventId: id }, g)).json;
  const b = (await call('GET', '/api/bookings', undefined, staff.manager)).json.find((x: any) => x.id === bookingId);
  assert.deepEqual([events[0].titleEn, b.note], ['EDM night', '[电音之夜]']);
});

test('a past event cannot be booked', async () => {
  const start = Date.now() - 10 * HOUR;
  const { id } = (await call('POST', '/api/venue-events', { title: 'Old', startsAt: start, endsAt: start + HOUR }, staff.manager)).json;
  const g = await guest('Partygoer');
  assert.equal((await call('POST', '/api/guest/bookings', { company: 'doloruu', store: 'FLAG', partySize: 2, eta: Date.now() + 2 * HOUR, eventId: id }, g)).status, 404);
});

// ---------- gifts ----------

test('a gift to a table that is not open is refused', async () => {
  const g = await guest('Giver');
  assert.equal((await call('POST', '/api/guest/orders', { qrToken: qr.A6, items: [{ productId: BEER, qty: 1 }], giftTo: tableId.VIP2 }, g)).status, 409);
});

test('an accepted gift goes on the sender bill and shows at the other table', async () => {
  const receiver = await guest('Receiver');
  await openWithOrder(receiver, 'B2');
  const giver = await guest('Giver');
  const giverBill = await openWithOrder(giver, 'B3');
  const { orderId } = (await call('POST', '/api/guest/orders', { qrToken: qr.B3, items: [{ productId: BEER, qty: 2 }], giftTo: tableId.B2, note: 'Cheers!' }, giver)).json;
  const accepted = (await call('POST', `/api/guest-orders/${orderId}/accept`, {}, staff.waiter)).json;
  const seen = (await call('GET', `/api/guest/table/${qr.B2}`)).json.gifts[0];
  assert.deepEqual([accepted.billId, seen.fromTable, seen.message], [giverBill, 'B3', 'Cheers!']);
});

test('the gift table list shows only other open tables', async () => {
  const g = await guest('Giver');
  const names = (await call('GET', `/api/guest/table/${qr.B3}/tables`, undefined, g)).json.map((t: any) => t.name);
  assert.equal(names.includes('B3') || names.includes('VIP2'), false);
});

// ---------- account merge ----------

test('points follow the guest when two accounts merge on phone verification', async () => {
  const byPhone = await guest('MergeA');
  await verifyPhone(byPhone, '13800000103');
  await openWithOrder(byPhone, 'A6');
  await payInApp(byPhone, 'A6');
  const other = await guest('MergeB');
  await verifyPhone(other, '13800000103');
  assert.equal(await points(other), 28);
});
