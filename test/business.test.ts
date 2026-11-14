import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { ean13Valid, parseScaleLabel } from '../src/retail.ts';

const ADMIN_KEY = 'platform-test-key';
const ENV = { PAY_MODE: 'mock', MOCK_PAY_SECRET: 's3cret', PLATFORM_ADMIN_KEY: ADMIN_KEY, GUEST_OTP_PER_IP_PER_HOUR: '1000', PUBLIC_BASE_URL: 'http://venue.test' } as NodeJS.ProcessEnv;
const PIN = '246810';
const DAY = 86_400_000;
let db: Db;
let server: Server;
let base: string;
const tok: Record<string, string> = {};
const ids: Record<string, number> = {};

async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function company(code: string, businessType?: string): Promise<string> {
  const made = await call('POST', '/platform/companies', { name: code, code, storeName: 'Main', ownerName: 'Boss', ownerUsername: 'boss', ownerPin: PIN, businessType });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  return (await call('POST', '/api/login', { company: code, username: 'boss', pin: PIN })).json.token;
}

const product = async (token: string, body: Record<string, unknown>) => (await call('POST', '/api/products', body, token)).json.productId as number;
const counterSale = async (token: string, phone?: string) => (await call('POST', '/api/counter-sales', { phone }, token)).json.billId as number;
const bill = async (token: string, id: number) => (await call('GET', `/api/bills/${id}`, undefined, token)).json;
const stockOf = async (id: number) => (await db.one('SELECT stock FROM products WHERE id = ?', [id])).stock;

/** Builds a valid in-store scale label: 2 + item code + 5-digit value + check digit. */
function scaleLabel(plu: string, value: number): string {
  const body = `2${plu}${String(value).padStart(5, '0')}`;
  const sum = [...body].reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0);
  return body + String((10 - (sum % 10)) % 10);
}

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL);
  server = createApp(db, ENV);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tok.shop = await company('grocer', 'retail');
  tok.bar = await company('nightbar');
  ids.apple = await product(tok.shop, { name: '苹果', price: 1200, unit: 'kg', stock: 10_000, barcode: '000123', cost: 600 });
  ids.milk = await product(tok.shop, { name: '牛奶', price: 650, stock: 20, barcode: '6901234567892', memberPrice: 590, reorderLevel: 10 });
  ids.bread = await product(tok.shop, { name: '面包', price: 800, stock: 5, barcode: '6900000000017', category: 'bakery', reorderLevel: 6 });
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.close();
});

test('a new company gets the modules of its business type', async () => {
  const shop = (await call('GET', '/api/business', undefined, tok.shop)).json;
  const bar = (await call('GET', '/api/business', undefined, tok.bar)).json;
  assert.deepEqual([shop.type, shop.modules.counter, shop.modules.tables, shop.modules.stash], ['retail', true, false, false]);
  assert.deepEqual([bar.type, bar.modules.tables, bar.modules.stash, bar.modules.counter], ['bar', true, true, false]);
});

test('a retail company starts without commission rules and with shop-style customer app features', async () => {
  const rules = (await call('GET', '/api/commission-rules', undefined, tok.shop)).json;
  const settings = (await call('GET', '/api/guest-settings', undefined, tok.shop)).json;
  assert.deepEqual([rules.length, settings.features.song, settings.features.loyalty], [0, false, true]);
});

test('switched-off modules answer 404', async () => {
  assert.equal((await call('GET', '/api/stash?q=1', undefined, tok.shop)).status, 404);
  assert.equal((await call('POST', '/api/counter-sales', {}, tok.bar)).status, 404);
});

test('scanning a product barcode adds it and settling takes it off the shelf', async () => {
  const id = await counterSale(tok.shop);
  assert.equal((await call('POST', `/api/bills/${id}/scan`, { code: '6901234567892', qty: 2 }, tok.shop)).status, 200);
  const before = await stockOf(ids.milk);
  const paid = (await call('POST', `/api/bills/${id}/pay`, { method: 'cash' }, tok.shop)).json;
  assert.deepEqual([paid.settled, await stockOf(ids.milk)], [true, before - 2]);
});

test('several counter sales can be open (held) at once', async () => {
  const a = await counterSale(tok.shop);
  const b = await counterSale(tok.shop);
  const open = (await call('GET', '/api/counter-sales', undefined, tok.shop)).json.map((x: any) => x.id);
  assert.ok(open.includes(a) && open.includes(b));
});

test('a weighed item scanned by its own code asks for the weight', async () => {
  const r = await call('POST', `/api/bills/${await counterSale(tok.shop)}/scan`, { code: '000123' }, tok.shop);
  assert.deepEqual([r.json.needsWeight, r.json.product.id], [true, ids.apple]);
});

test('a weighed item entered by hand is priced by weight', async () => {
  const id = await counterSale(tok.shop);
  await call('POST', `/api/bills/${id}/lines`, { productId: ids.apple, qty: 1, weightG: 750 }, tok.shop);
  assert.equal((await bill(tok.shop, id)).totals.total, 900);
});

test('a weighed item cannot be added without its weight', async () => {
  const r = await call('POST', `/api/bills/${await counterSale(tok.shop)}/lines`, { productId: ids.apple, qty: 2 }, tok.shop);
  assert.equal(r.status, 422);
});

test('a price scale label charges the printed price and takes the implied weight off stock', async () => {
  const id = await counterSale(tok.shop);
  await call('POST', `/api/bills/${id}/scan`, { code: scaleLabel('000123', 1500) }, tok.shop);
  const before = await stockOf(ids.apple);
  await call('POST', `/api/bills/${id}/pay`, { method: 'cash' }, tok.shop);
  assert.deepEqual([(await bill(tok.shop, id)).totals.total, before - (await stockOf(ids.apple))], [1500, 1250]);
});

test('a weight scale label is priced at today\'s price per kg', async () => {
  await call('PATCH', '/api/business', { scaleMode: 'weight' }, tok.shop);
  const id = await counterSale(tok.shop);
  await call('POST', `/api/bills/${id}/scan`, { code: scaleLabel('000123', 500) }, tok.shop);
  await call('PATCH', '/api/business', { scaleMode: 'price' }, tok.shop);
  assert.equal((await bill(tok.shop, id)).totals.total, 600);
});

test('a scale label with a wrong check digit is not read as a label', () => {
  const good = scaleLabel('000123', 1500);
  assert.deepEqual([ean13Valid(good), parseScaleLabel(`${good.slice(0, 12)}${(Number(good[12]) + 1) % 10}`)], [true, null]);
});

test('an unknown barcode is a 404', async () => {
  assert.equal((await call('POST', `/api/bills/${await counterSale(tok.shop)}/scan`, { code: '999999999' }, tok.shop)).status, 404);
});

test('a member gets the member price', async () => {
  const id = await counterSale(tok.shop, '13800000001');
  await call('POST', `/api/bills/${id}/scan`, { code: '6901234567892' }, tok.shop);
  assert.equal((await bill(tok.shop, id)).totals.total, 590);
});

test('adding a member after scanning lowers the lines to member prices', async () => {
  const id = await counterSale(tok.shop);
  await call('POST', `/api/bills/${id}/scan`, { code: '6901234567892' }, tok.shop);
  await call('POST', `/api/bills/${id}/member`, { phone: '13800000002' }, tok.shop);
  assert.equal((await bill(tok.shop, id)).totals.total, 590);
});

test('a running category promotion lowers the price', async () => {
  const now = Date.now();
  await call('POST', '/api/promotions', { name: 'Bakery 25% off', category: 'bakery', kind: 'percent', value: 25, startsAt: now - DAY, endsAt: now + DAY }, tok.shop);
  const id = await counterSale(tok.shop);
  await call('POST', `/api/bills/${id}/scan`, { code: '6900000000017' }, tok.shop);
  const { lines, totals } = await bill(tok.shop, id);
  assert.deepEqual([totals.total, lines[0].price_note], [600, 'promo:Bakery 25% off']);
});

test('promotions stop applying when the module is switched off', async () => {
  await call('PATCH', '/api/business', { modules: { promotions: false } }, tok.shop);
  const id = await counterSale(tok.shop);
  await call('POST', `/api/bills/${id}/scan`, { code: '6900000000017' }, tok.shop);
  await call('PATCH', '/api/business', { modules: { promotions: true } }, tok.shop);
  assert.equal((await bill(tok.shop, id)).totals.total, 800);
});

test('a promotion that has ended does not apply', async () => {
  const now = Date.now();
  await call('POST', '/api/promotions', { name: 'Old milk deal', productId: ids.milk, kind: 'price', value: 100, startsAt: now - 2 * DAY, endsAt: now - DAY }, tok.shop);
  const id = await counterSale(tok.shop);
  await call('POST', `/api/bills/${id}/scan`, { code: '6901234567892' }, tok.shop);
  assert.equal((await bill(tok.shop, id)).totals.total, 650);
});

test('low stock lists items at or below their reorder level', async () => {
  const rows = (await call('GET', '/api/low-stock', undefined, tok.shop)).json;
  assert.deepEqual(rows.map((r: any) => r.id), [ids.bread]);
});

test('receiving a purchase order adds stock and updates the cost', async () => {
  const { supplierId } = (await call('POST', '/api/suppliers', { name: '面包坊', phone: '021-1234' }, tok.shop)).json;
  const { poId } = (await call('POST', '/api/purchase-orders', { supplierId, lines: [{ productId: ids.bread, qty: 12, unitCost: 350 }] }, tok.shop)).json;
  await call('POST', `/api/purchase-orders/${poId}/order`, {}, tok.shop);
  const before = await stockOf(ids.bread);
  const lineId = (await db.one('SELECT id FROM po_lines WHERE po_id = ?', [poId])).id;
  await call('POST', `/api/purchase-orders/${poId}/receive`, { received: { [lineId]: 10 } }, tok.shop);
  const p = await db.one('SELECT stock, cost FROM products WHERE id = ?', [ids.bread]);
  assert.deepEqual([p.stock - before, p.cost], [10, 350]);
});

test('a received purchase order cannot be received twice', async () => {
  const { supplierId } = (await call('POST', '/api/suppliers', { name: '牛奶厂' }, tok.shop)).json;
  const { poId } = (await call('POST', '/api/purchase-orders', { supplierId, lines: [{ productId: ids.milk, qty: 5, unitCost: 400 }] }, tok.shop)).json;
  await call('POST', `/api/purchase-orders/${poId}/receive`, {}, tok.shop);
  assert.equal((await call('POST', `/api/purchase-orders/${poId}/receive`, {}, tok.shop)).status, 409);
});

test('purchasing is not available to a bar that has not switched it on', async () => {
  assert.equal((await call('GET', '/api/suppliers', undefined, tok.bar)).status, 404);
});

test('two products in one store cannot share a barcode', async () => {
  const r = await call('POST', '/api/products', { name: '牛奶2', price: 650, barcode: '6901234567892' }, tok.shop);
  assert.equal(r.status, 409);
});

test('without the reps module a table opens with the person opening it as owner', async () => {
  await call('PATCH', '/api/business', { modules: { tables: true } }, tok.shop);
  const { tableId } = (await call('POST', '/api/tables', { name: 'T1' }, tok.shop)).json;
  const r = await call('POST', '/api/bills', { tableId }, tok.shop);
  assert.equal(r.status, 200);
});

test('a bar still needs a sales rep to open a table', async () => {
  const { tableId } = (await call('POST', '/api/tables', { name: 'B1' }, tok.bar)).json;
  assert.equal((await call('POST', '/api/bills', { tableId }, tok.bar)).status, 422);
});

test('changing the business type resets modules to the new preset', async () => {
  const r = (await call('PATCH', '/api/business', { type: 'salon', applyGuestPreset: true }, tok.bar)).json;
  assert.deepEqual([r.modules.reps, r.modules.tables, r.modules.bookings], [true, false, true]);
});

test('only the owner may change the business type', async () => {
  await call('POST', '/api/hq/staff', { name: 'Mgr', username: 'mgr', role: 'manager', pin: '1234', storeId: (await db.one("SELECT s.id FROM stores s JOIN tenants t ON t.id = s.tenant_id WHERE t.code = 'grocer'")).id }, tok.shop);
  const mgr = (await call('POST', '/api/login', { company: 'grocer', username: 'mgr', pin: '1234' })).json.token;
  assert.equal((await call('PATCH', '/api/business', { type: 'bar' }, mgr)).status, 403);
});

// ---- pickup and delivery orders from the customer app ----

async function guest(name: string): Promise<string> {
  const start = await fetch(`${base}/api/guest/auth/wechat/start?return=/g/grocer`, { redirect: 'manual' });
  const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0];
  const state = new URL(start.headers.get('location')!, base).searchParams.get('state')!;
  const back = (await fetch(`${base}/api/guest/auth/wechat/callback?state=${state}&code=${encodeURIComponent(name)}`, { redirect: 'manual', headers: { Cookie: cookie } })).headers.get('location')!;
  const code = /#login=([0-9a-f]+)$/.exec(back)![1];
  const res = await fetch(`${base}/api/guest/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ code }) });
  const token = (await res.json()).token;
  const phone = `1390000${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
  const { devCode } = (await call('POST', '/api/guest/otp', { phone })).json;
  await call('POST', '/api/guest/me/phone', { phone, code: devCode }, token);
  return token;
}

const shopOrder = (token: string, body: Record<string, unknown>) =>
  call('POST', '/api/guest/shop-orders', { company: 'grocer', store: 'MAIN', items: [{ productId: ids.milk, qty: 2 }], ...body }, token);

test('the venue page says the shop takes orders ahead', async () => {
  assert.equal((await call('GET', '/api/guest/venue/grocer')).json.orderAhead, true);
});

test('a delivery order needs an address', async () => {
  assert.equal((await shopOrder(await guest('ann'), { mode: 'delivery' })).status, 422);
});

test('items sold by weight cannot be ordered ahead', async () => {
  const r = await shopOrder(await guest('ben'), { mode: 'pickup', items: [{ productId: ids.apple, qty: 1 }] });
  assert.equal(r.status, 422);
});

test('a shop without the delivery module refuses orders ahead', async () => {
  const r = await call('POST', '/api/guest/shop-orders', { company: 'nightbar', store: 'MAIN', mode: 'pickup', items: [{ productId: 1, qty: 1 }] }, await guest('cat'));
  assert.equal(r.status, 404);
});

test('an accepted pickup order becomes a pickup sale the guest pays in the app at member prices', async () => {
  const g = await guest('dan');
  const { orderId } = (await shopOrder(g, { mode: 'pickup' })).json;
  const { billId } = (await call('POST', `/api/guest-orders/${orderId}/accept`, {}, tok.shop)).json;
  const listed = (await call('GET', '/api/counter-sales', undefined, tok.shop)).json.find((b: any) => b.id === billId);
  const charge = (await call('POST', `/api/guest/orders/${orderId}/pay`, { method: 'wechat' }, g)).json;
  await call('POST', `/api/guest/payments/${charge.outTradeNo}/mock-pay`, {}, g);
  const order = (await call('GET', `/api/guest/orders/${orderId}`, undefined, g)).json;
  assert.deepEqual([listed.channel, charge.amount, order.bill.status], ['pickup', 1180, 'settled']);
});

test('nobody else can pay a guest\'s order', async () => {
  const { orderId } = (await shopOrder(await guest('eve'), { mode: 'pickup' })).json;
  await call('POST', `/api/guest-orders/${orderId}/accept`, {}, tok.shop);
  assert.equal((await call('POST', `/api/guest/orders/${orderId}/pay`, { method: 'wechat' }, await guest('fay'))).status, 409);
});

test('staff move a delivery order out and then done', async () => {
  const g = await guest('gus');
  const { orderId } = (await shopOrder(g, { mode: 'delivery', address: '1 Main Road' })).json;
  await call('POST', `/api/guest-orders/${orderId}/accept`, {}, tok.shop);
  const wrong = (await call('POST', `/api/guest-orders/${orderId}/fulfil`, { step: 'ready' }, tok.shop)).status;
  await call('POST', `/api/guest-orders/${orderId}/fulfil`, { step: 'out' }, tok.shop);
  const seen = (await call('GET', `/api/guest/orders/${orderId}`, undefined, g)).json;
  assert.deepEqual([wrong, seen.fulfilStatus, seen.address], [422, 'out', '1 Main Road']);
});

test('staff see pickup and delivery orders with their mode', async () => {
  await shopOrder(await guest('hal'), { mode: 'pickup' });
  const rows = (await call('GET', '/api/guest-orders?status=pending', undefined, tok.shop)).json;
  assert.ok(rows.some((r: any) => r.mode === 'pickup' && r.tableName === null));
});
