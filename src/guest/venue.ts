import type { Db } from '../db.ts';
import { audit, DomainError } from '../db.ts';
import { settleIfPaid, totals } from '../bills.ts';
import { pendingHeld, reservePayment } from '../payments.ts';
import type { OnlineMethod } from '../payments/types.ts';
import { earnForPayment } from './loyalty.ts';
import { guestSettings, requireFeature } from './settings.ts';
import { businessOf, hasModule } from '../business.ts';
import { themeOf } from './theme.ts';
import { guestNews } from '../broadcasts.ts';

const MAX_ORDER_LINES = 30;
const MAX_LINE_QTY = 99;
const MAX_PENDING_ORDERS = 5;
const MAX_NOTE = 200;
const MAX_PARTY = 50;
const MAX_ACTIVE_BOOKINGS = 3;
const BOOKING_HORIZON_MS = 60 * 24 * 60 * 60 * 1000;
const BOOKING_MIN_LEAD_MS = 15 * 60 * 1000;
const RECENT = 20;
const ORDER_MODES = ['pickup', 'delivery'];
const MAX_ADDRESS = 300;
/** Pickup can be asked for up to a week ahead. */
const PICKUP_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a table keeps seeing "you received a gift" after staff confirm it. */
const GIFT_NOTICE_MS = 6 * 60 * 60 * 1000;

export const text = (v: unknown, name: string, max = MAX_NOTE): string => {
  if (v == null || v === '') return '';
  if (typeof v !== 'string' || v.length > max) throw new DomainError(`${name}: up to ${max} characters`, 422);
  return v.trim();
};
export const int = (v: unknown, name: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new DomainError(`${name} must be a whole number from ${min} to ${max}`, 422);
  return v;
};

export interface StoreRef { tenantId: number; companyName: string; companyCode: string; storeId: number; storeName: string; storeCode: string }

const STORE_SQL = `SELECT t.id AS tenant_id, t.name AS company_name, t.code AS company_code, s.id AS store_id, s.name AS store_name, s.code AS store_code
  FROM stores s JOIN tenants t ON t.id = s.tenant_id WHERE s.active AND t.active`;
const toStoreRef = (r: any): StoreRef => ({
  tenantId: r.tenant_id, companyName: r.company_name, companyCode: r.company_code, storeId: r.store_id, storeName: r.store_name, storeCode: r.store_code,
});

export async function storeByCode(db: Db, company: string, storeCode: string): Promise<StoreRef> {
  const r = await db.one(`${STORE_SQL} AND lower(t.code) = lower(?) AND lower(s.code) = lower(?)`, [company, storeCode]);
  if (!r) throw new DomainError('venue not found', 404);
  return toStoreRef(r);
}

export async function tenantByCode(db: Db, company: string): Promise<{ id: number; name: string; code: string }> {
  const t = await db.one('SELECT id, name, code FROM tenants WHERE lower(code) = lower(?) AND active', [company]);
  if (!t) throw new DomainError('venue not found', 404);
  return t;
}

/** A table is reached only through its QR token, so nobody can order onto a table they cannot see. */
export async function tableByToken(db: Db, qrToken: string, lock = false): Promise<{ table: any; store: StoreRef }> {
  if (!/^[0-9a-f]{32}$/.test(qrToken)) throw new DomainError('table not found', 404);
  const r = await db.one(
    `SELECT d.*, x.* FROM dining_tables d JOIN (${STORE_SQL}) x ON x.store_id = d.store_id WHERE d.qr_token = ? AND d.active${lock ? ' FOR UPDATE OF d' : ''}`, [qrToken]);
  if (!r) throw new DomainError('table not found', 404);
  return { table: { id: r.id, name: r.name, kind: r.kind, capacity: r.capacity, minSpend: r.min_spend, tableFee: r.table_fee }, store: toStoreRef(r) };
}

const guestProduct = (p: any) => ({
  id: p.id, name: p.name, nameEn: p.name_en ?? '', category: p.category, price: p.price, soldOut: Boolean(p.track_stock && p.stock <= 0),
  byWeight: p.unit === 'kg',
});

export async function venueInfo(db: Db, company: string) {
  const t = await tenantByCode(db, company);
  const stores = await db.all(`SELECT name, code, city, address, postal_code AS "postalCode", wifi_ssid AS "wifiSsid", wifi_password AS "wifiPassword"
    FROM stores WHERE tenant_id = ? AND active ORDER BY id`, [t.id]);
  const { type, modules } = await businessOf(db, t.id);
  return {
    company: { name: t.name, code: t.code }, stores, features: (await guestSettings(db, t.id)).features,
    business: type, orderAhead: modules.delivery, bookings: modules.bookings, tables: modules.tables,
    theme: await themeOf(db, t.id, t.code), news: await guestNews(db, t.id),
  };
}

export async function menu(db: Db, company: string, storeCode: string) {
  const s = await storeByCode(db, company, storeCode);
  const products = await db.all('SELECT * FROM products WHERE store_id = ? AND active ORDER BY category, id', [s.storeId]);
  return { company: { name: s.companyName, code: s.companyCode }, store: { name: s.storeName, code: s.storeCode }, products: products.map(guestProduct) };
}

export async function tableInfo(db: Db, qrToken: string) {
  const { table, store } = await tableByToken(db, qrToken);
  const gifts = await db.all(
    `SELECT o.id, o.note AS message, o.decided_at AS "decidedAt", d.name AS "fromTable",
            (SELECT string_agg(i.name || ' × ' || i.qty, ', ' ORDER BY i.id) FROM guest_order_items i WHERE i.order_id = o.id) AS items
     FROM guest_orders o JOIN dining_tables d ON d.id = o.table_id
     WHERE o.to_table_id = ? AND o.status = 'accepted' AND o.decided_at > ? ORDER BY o.decided_at DESC`, [table.id, Date.now() - GIFT_NOTICE_MS]);
  return {
    company: { name: store.companyName, code: store.companyCode }, store: { name: store.storeName, code: store.storeCode }, table,
    features: (await guestSettings(db, store.tenantId)).features, gifts,
    theme: await themeOf(db, store.tenantId, store.companyCode),
  };
}

/** Other tables a guest can send a gift to: open (occupied) tables in the same store, by name only. */
export async function giftTables(db: Db, qrToken: string) {
  const { table, store } = await tableByToken(db, qrToken);
  await requireFeature(db, store.tenantId, 'gift');
  return db.all(
    `SELECT d.id, d.name FROM dining_tables d WHERE d.store_id = ? AND d.active AND d.id <> ?
       AND EXISTS (SELECT 1 FROM bills b WHERE b.table_id = d.id AND b.status = 'open') ORDER BY d.name`, [store.storeId, table.id]);
}

// ---------- table ordering ----------

export async function placeOrder(db: Db, customerId: number, input: { qrToken?: unknown; items?: unknown; note?: unknown; giftTo?: unknown }) {
  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length || items.length > MAX_ORDER_LINES) throw new DomainError(`an order needs 1 to ${MAX_ORDER_LINES} items`, 422);
  const wanted = new Map<number, number>();
  for (const it of items) {
    const productId = int((it as any)?.productId, 'productId', 1, Number.MAX_SAFE_INTEGER);
    wanted.set(productId, (wanted.get(productId) ?? 0) + int((it as any)?.qty, 'qty', 1, MAX_LINE_QTY));
  }
  const note = text(input.note, 'note');
  return db.tx(async (t) => {
    const { table, store } = await tableByToken(t, String(input.qrToken ?? ''));
    let giftTo: number | null = null;
    if (input.giftTo !== undefined && input.giftTo !== null) {
      // A gift is charged to the sender's own table and carried to the other one.
      await requireFeature(t, store.tenantId, 'gift');
      giftTo = int(input.giftTo, 'giftTo', 1, Number.MAX_SAFE_INTEGER);
      const target = await t.one(
        `SELECT d.id FROM dining_tables d WHERE d.id = ? AND d.store_id = ? AND d.active AND d.id <> ?
           AND EXISTS (SELECT 1 FROM bills b WHERE b.table_id = d.id AND b.status = 'open')`, [giftTo, store.storeId, table.id]);
      if (!target) throw new DomainError('that table is not open right now', 409);
    }
    const pending = await t.one("SELECT COUNT(*) AS n FROM guest_orders WHERE customer_id = ? AND status = 'pending'", [customerId]);
    if (pending.n >= MAX_PENDING_ORDERS) throw new DomainError('you have orders waiting for staff; please wait for them first', 429);
    const products = await t.all('SELECT * FROM products WHERE store_id = ? AND active AND id = ANY(?)', [store.storeId, [...wanted.keys()]]);
    if (products.length !== wanted.size) throw new DomainError('an item is no longer on the menu', 409);
    for (const p of products) {
      // Staff weigh these at the till; an order for "2 apples" has no weight to price.
      if (p.unit === 'kg') throw new DomainError(`${p.name}: sold by weight, ask staff`, 422);
      if (p.track_stock && p.stock < wanted.get(p.id)!) throw new DomainError(`${p.name}: not enough left`, 409);
    }
    const orderId = await t.insert('INSERT INTO guest_orders (store_id, table_id, customer_id, note, created_at, to_table_id) VALUES (?,?,?,?,?,?)',
      [store.storeId, table.id, customerId, note, Date.now(), giftTo]);
    for (const p of products) {
      await t.run('INSERT INTO guest_order_items (order_id, product_id, name, qty, unit_price) VALUES (?,?,?,?,?)', [orderId, p.id, p.name, wanted.get(p.id), p.price]);
    }
    await audit(t, { tenantId: store.tenantId, storeId: store.storeId }, 'guest.order', 'guest_order', orderId, { customerId, tableId: table.id });
    return { orderId };
  });
}

async function orderItems(db: Db, orderIds: number[]) {
  if (!orderIds.length) return new Map<number, any[]>();
  const rows = await db.all(
    `SELECT i.order_id, i.product_id AS "productId", i.name, p.name_en AS "nameEn", i.qty, i.unit_price AS "unitPrice"
     FROM guest_order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = ANY(?) ORDER BY i.id`, [orderIds]);
  const out = new Map<number, any[]>();
  for (const { order_id, ...r } of rows) out.set(order_id, [...(out.get(order_id) ?? []), r]);
  return out;
}

const orderView = (o: any, items: any[]) => ({
  id: o.id, status: o.status, note: o.note, rejectReason: o.reject_reason, createdAt: o.created_at, decidedAt: o.decided_at,
  tableName: o.table_name, storeName: o.store_name, toTableName: o.to_table_name ?? null, items, total: items.reduce((s, i) => s + i.qty * i.unitPrice, 0),
  mode: o.mode, address: o.address, pickupAt: o.pickup_at, fulfilStatus: o.fulfil_status,
  // Pickup and delivery orders are paid in the app once the shop has accepted them.
  bill: o.mode !== 'table' && o.bill_id ? { id: o.bill_id, status: o.bill_status, due: o.bill_due ?? 0 } : null,
});

const ORDER_SQL = `SELECT o.*, d.name AS table_name, s.name AS store_name, g.name AS to_table_name, b.status AS bill_status FROM guest_orders o
  LEFT JOIN dining_tables d ON d.id = o.table_id JOIN stores s ON s.id = o.store_id LEFT JOIN dining_tables g ON g.id = o.to_table_id
  LEFT JOIN bills b ON b.id = o.bill_id`;

async function withDue(db: Db, o: any) {
  if (o?.mode !== 'table' && o?.bill_id && o.bill_status === 'open') o.bill_due = (await totals(db, o.bill_id)).due;
  return o;
}

export async function guestOrder(db: Db, customerId: number, orderId: number) {
  const o = await withDue(db, await db.one(`${ORDER_SQL} WHERE o.id = ? AND o.customer_id = ?`, [orderId, customerId]));
  if (!o) throw new DomainError('order not found', 404);
  return orderView(o, (await orderItems(db, [o.id])).get(o.id) ?? []);
}

export async function cancelGuestOrder(db: Db, customerId: number, orderId: number): Promise<void> {
  const n = await db.run("UPDATE guest_orders SET status = 'cancelled', decided_at = ? WHERE id = ? AND customer_id = ? AND status = 'pending'", [Date.now(), orderId, customerId]);
  if (!n) throw new DomainError('this order can no longer be cancelled', 409);
}

// ---------- pickup and delivery orders (shops, takeaway) ----------

/**
 * Orders ahead from the store page, without a table. Staff accept them in Guest orders (that opens a pickup or delivery
 * sale at today's prices), then mark them ready / out for delivery / done. Items sold by weight are weighed in store,
 * so they cannot be ordered here. A phone number is needed so the shop can call about the order.
 */
export async function placeShopOrder(db: Db, customerId: number, input: Record<string, unknown>) {
  const mode = String(input.mode ?? '');
  if (!ORDER_MODES.includes(mode)) throw new DomainError('mode must be pickup or delivery', 422);
  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length || items.length > MAX_ORDER_LINES) throw new DomainError(`an order needs 1 to ${MAX_ORDER_LINES} items`, 422);
  const wanted = new Map<number, number>();
  for (const it of items) {
    const productId = int((it as any)?.productId, 'productId', 1, Number.MAX_SAFE_INTEGER);
    wanted.set(productId, (wanted.get(productId) ?? 0) + int((it as any)?.qty, 'qty', 1, MAX_LINE_QTY));
  }
  const note = text(input.note, 'note');
  const address = text(input.address, 'address', MAX_ADDRESS);
  if (mode === 'delivery' && !address) throw new DomainError('a delivery address is required', 422);
  const now = Date.now();
  const pickupAt = input.pickupAt == null ? null : int(input.pickupAt, 'pickupAt', now, now + PICKUP_HORIZON_MS);
  if (!(await contactPhone(db, customerId))) throw new DomainError('add your phone number so the shop can reach you', 403);
  const s = await storeByCode(db, String(input.company ?? ''), String(input.store ?? ''));
  if (!(await hasModule(db, s.tenantId, 'delivery'))) throw new DomainError('this shop does not take orders ahead', 404);
  return db.tx(async (t) => {
    const pending = await t.one("SELECT COUNT(*) AS n FROM guest_orders WHERE customer_id = ? AND status = 'pending'", [customerId]);
    if (pending.n >= MAX_PENDING_ORDERS) throw new DomainError('you have orders waiting for staff; please wait for them first', 429);
    const products = await t.all('SELECT * FROM products WHERE store_id = ? AND active AND id = ANY(?)', [s.storeId, [...wanted.keys()]]);
    if (products.length !== wanted.size) throw new DomainError('an item is no longer on the menu', 409);
    for (const p of products) {
      if (p.unit === 'kg') throw new DomainError(`${p.name}: sold by weight, please buy it in store`, 422);
      if (p.track_stock && p.stock < wanted.get(p.id)!) throw new DomainError(`${p.name}: not enough left`, 409);
    }
    const orderId = await t.insert(
      'INSERT INTO guest_orders (store_id, table_id, customer_id, note, created_at, mode, address, pickup_at) VALUES (?,NULL,?,?,?,?,?,?)',
      [s.storeId, customerId, note, now, mode, mode === 'delivery' ? address : '', pickupAt]);
    for (const p of products) {
      await t.run('INSERT INTO guest_order_items (order_id, product_id, name, qty, unit_price) VALUES (?,?,?,?,?)', [orderId, p.id, p.name, wanted.get(p.id), p.price]);
    }
    await audit(t, { tenantId: s.tenantId, storeId: s.storeId }, 'guest.order', 'guest_order', orderId, { customerId, mode });
    return { orderId };
  });
}

// ---------- the table's bill ----------

async function openBillAt(db: Db, tableId: number, lock = false): Promise<number | null> {
  const b = await db.one(`SELECT id FROM bills WHERE table_id = ? AND status = 'open'${lock ? ' FOR UPDATE' : ''}`, [tableId]);
  return b?.id ?? null;
}

/** What a guest pays: a table (by its QR token) or their own accepted pickup / delivery order. */
export type PayTarget = string | { orderId: number };

async function payTarget(db: Db, customerId: number, target: PayTarget, lock = false): Promise<{ billId: number; store: StoreRef }> {
  if (typeof target === 'string') {
    const { table, store } = await tableByToken(db, target);
    const billId = await openBillAt(db, table.id, lock);
    if (!billId) throw new DomainError('this table has no open bill yet', 409);
    return { billId, store };
  }
  const o = await db.one(
    `SELECT o.bill_id, x.* FROM guest_orders o JOIN (${STORE_SQL}) x ON x.store_id = o.store_id JOIN bills b ON b.id = o.bill_id
     WHERE o.id = ? AND o.customer_id = ? AND o.mode <> 'table' AND o.status = 'accepted' AND b.status = 'open'${lock ? ' FOR UPDATE OF b' : ''}`,
    [target.orderId, customerId]);
  if (!o) throw new DomainError('this order has nothing to pay right now', 409);
  return { billId: o.bill_id, store: toStoreRef(o) };
}

/** What the guests at a table see: the items and totals of its open bill (never who else paid or staff details). */
export async function tableBill(db: Db, qrToken: string) {
  const { table, store } = await tableByToken(db, qrToken);
  const billId = await openBillAt(db, table.id);
  if (!billId) return { table, store: { name: store.storeName }, bill: null };
  const lines = await db.all(
    `SELECT l.id, l.name, p.name_en AS "nameEn", l.qty, l.unit_price AS "unitPrice", l.kind FROM bill_lines l JOIN products p ON p.id = l.product_id
     WHERE l.bill_id = ? AND l.status = 'active' ORDER BY l.id`, [billId]);
  const paid = await db.all("SELECT method, amount, paid_at AS \"paidAt\" FROM payments WHERE bill_id = ? AND status = 'paid' ORDER BY id", [billId]);
  return { table, store: { name: store.storeName }, bill: { id: billId, lines, payments: paid, totals: await totals(db, billId) } };
}

/** Books a pending WeChat/Alipay payment on the table's open bill, owned by this guest. */
export async function reserveGuestPayment(db: Db, customerId: number, target: PayTarget, method: OnlineMethod, amount?: number) {
  const { billId, store } = await payTarget(db, customerId, target);
  if (amount !== undefined) int(amount, 'amount', 1, Number.MAX_SAFE_INTEGER);
  const r = await reservePayment(db, store.storeId, billId, method, amount, customerId);
  return { ...r, billId, storeName: store.storeName, companyCode: store.companyCode };
}

export async function markPaymentFailed(db: Db, paymentId: number): Promise<void> {
  await db.run("UPDATE payments SET status = 'failed' WHERE id = ? AND status = 'pending'", [paymentId]);
}

export async function paymentStatus(db: Db, customerId: number, outTradeNo: string) {
  const p = await db.one('SELECT method, amount, status, bill_id FROM payments WHERE out_trade_no = ? AND customer_id = ?', [outTradeNo, customerId]);
  if (!p) throw new DomainError('payment not found', 404);
  const bill = await db.one('SELECT status FROM bills WHERE id = ?', [p.bill_id]);
  return { method: p.method, amount: p.amount, status: p.status, billSettled: bill?.status === 'settled' };
}

/** Pays from the guest's own member wallet at this company, found through their verified phone. */
export async function payFromWallet(db: Db, customerId: number, target: PayTarget, amount?: number) {
  const phone = (await db.one('SELECT phone FROM customers WHERE id = ?', [customerId]))?.phone;
  if (!phone) throw new DomainError('verify your phone number to use your member wallet', 403);
  if (amount !== undefined) int(amount, 'amount', 1, Number.MAX_SAFE_INTEGER);
  return db.tx(async (t) => {
    const { billId, store } = await payTarget(t, customerId, target, true);
    // Switching from an unfinished WeChat/Alipay payment to the wallet replaces it; other guests' unfinished payments are held back.
    await t.run("UPDATE payments SET status = 'expired' WHERE bill_id = ? AND customer_id = ? AND status = 'pending'", [billId, customerId]);
    const due = (await totals(t, billId)).due - await pendingHeld(t, billId);
    if (due <= 0) throw new DomainError('someone at this table is paying right now; try again in a few minutes', 409);
    const pay = Math.min(amount ?? due, due);
    const member = await t.one('SELECT id FROM members WHERE tenant_id = ? AND phone = ?', [store.tenantId, phone]);
    if (!member) throw new DomainError('you have no member wallet at this venue', 404);
    const n = await t.run('UPDATE members SET balance = balance - ? WHERE id = ? AND balance >= ?', [pay, member.id, pay]);
    if (!n) throw new DomainError('not enough balance in your wallet', 402);
    const now = Date.now();
    await t.run('INSERT INTO wallet_ledger (member_id, store_id, delta, reason, bill_id, ts) VALUES (?,?,?,?,?,?)', [member.id, store.storeId, -pay, 'bill payment (guest app)', billId, now]);
    const paymentId = await t.insert("INSERT INTO payments (bill_id, method, amount, status, created_at, paid_at, customer_id) VALUES (?,'member',?,'paid',?,?,?)", [billId, pay, now, now, customerId]);
    await earnForPayment(t, customerId, billId, paymentId, pay);
    await audit(t, { tenantId: store.tenantId, storeId: store.storeId }, 'pay.member', 'bill', billId, { amount: pay, customerId, via: 'guest' });
    return { paid: pay, settled: await settleIfPaid(t, null, billId) };
  });
}

// ---------- bookings ----------

/**
 * A number staff can call: the verified phone, else the phone a password account registered with. Only for contact;
 * money (wallet, stored bottles) still needs the verified phone.
 */
async function contactPhone(db: Db, customerId: number): Promise<string | null> {
  const r = await db.one('SELECT c.phone, p.phone AS login_phone FROM customers c LEFT JOIN guest_passwords p ON p.customer_id = c.id WHERE c.id = ?', [customerId]);
  return r?.phone ?? r?.login_phone ?? null;
}

export async function createGuestBooking(db: Db, customerId: number, input: Record<string, unknown>) {
  const c = await db.one('SELECT display_name FROM customers WHERE id = ?', [customerId]);
  const phone = await contactPhone(db, customerId);
  if (!phone) throw new DomainError('add your phone number so the venue can reach you', 403);
  const s = await storeByCode(db, String(input.company ?? ''), String(input.store ?? ''));
  const partySize = int(input.partySize, 'partySize', 1, MAX_PARTY);
  const eta = int(input.eta, 'eta', 0, Number.MAX_SAFE_INTEGER);
  const now = Date.now();
  if (eta < now + BOOKING_MIN_LEAD_MS || eta > now + BOOKING_HORIZON_MS) throw new DomainError('choose a time between 15 minutes and 60 days from now', 422);
  const name = text(input.name, 'name', 40) || c?.display_name || '';
  let note = text(input.note, 'note');
  let eventId: number | null = null;
  if (input.eventId !== undefined && input.eventId !== null) {
    eventId = int(input.eventId, 'eventId', 1, Number.MAX_SAFE_INTEGER);
    const ev = await db.one('SELECT title FROM venue_events WHERE id = ? AND store_id = ? AND active AND ends_at >= ?', [eventId, s.storeId, now]);
    if (!ev) throw new DomainError('this event is not open for booking', 404);
    // Staff read the booking note, so the event name goes there too.
    note = `[${ev.title}] ${note}`.trim();
  }
  return db.tx(async (t) => {
    const active = await t.one("SELECT COUNT(*) AS n FROM bookings WHERE customer_id = ? AND store_id = ? AND status IN ('submitted','confirmed') AND eta > ?", [customerId, s.storeId, now]);
    if (active.n >= MAX_ACTIVE_BOOKINGS) throw new DomainError(`you already have ${MAX_ACTIVE_BOOKINGS} upcoming bookings here`, 409);
    const id = await t.insert(
      `INSERT INTO bookings (store_id, source, phone, name, party_size, eta, status, created_at, customer_id, note, event_id)
       VALUES (?, 'guest', ?, ?, ?, ?, 'submitted', ?, ?, ?, ?)`, [s.storeId, phone, name, partySize, eta, now, customerId, note, eventId]);
    await audit(t, { tenantId: s.tenantId, storeId: s.storeId }, 'booking.guest', 'booking', id, { customerId, partySize, eta });
    return { bookingId: id };
  });
}

export async function cancelGuestBooking(db: Db, customerId: number, bookingId: number): Promise<void> {
  const n = await db.run("UPDATE bookings SET status = 'cancelled' WHERE id = ? AND customer_id = ? AND status IN ('submitted','confirmed') AND eta > ?", [bookingId, customerId, Date.now()]);
  if (!n) throw new DomainError('this booking can no longer be cancelled', 409);
}

// ---------- my account at one company ----------

export async function accountAt(db: Db, customerId: number, company: string) {
  const t = await tenantByCode(db, company);
  const phone = (await db.one('SELECT phone FROM customers WHERE id = ?', [customerId]))?.phone ?? null;
  const member = phone ? await db.one('SELECT id, balance FROM members WHERE tenant_id = ? AND phone = ?', [t.id, phone]) : undefined;
  const ledger = member
    ? await db.all('SELECT delta, reason, ts FROM wallet_ledger WHERE member_id = ? ORDER BY id DESC LIMIT ?', [member.id, RECENT])
    : [];
  const stash = phone
    ? await db.all(
      `SELECT x.code, x.name, x.left_milli AS "leftMilli", x.qty_milli AS "qtyMilli", x.expires_at AS "expiresAt", s.name AS "storeName"
       FROM stash x JOIN stores s ON s.id = x.store_id WHERE s.tenant_id = ? AND x.phone = ? AND x.status = 'stored' AND x.left_milli > 0 AND x.expires_at >= ?
       ORDER BY x.expires_at`, [t.id, phone, Date.now()])
    : [];
  const bookings = await db.all(
    `SELECT b.id, b.status, b.party_size AS "partySize", b.eta, b.name, b.note, s.name AS "storeName", d.name AS "tableName"
     FROM bookings b JOIN stores s ON s.id = b.store_id LEFT JOIN dining_tables d ON d.id = b.table_id
     WHERE b.customer_id = ? AND s.tenant_id = ? ORDER BY b.eta DESC LIMIT ?`, [customerId, t.id, RECENT]);
  const orders = await db.all(`${ORDER_SQL} WHERE o.customer_id = ? AND s.tenant_id = ? ORDER BY o.id DESC LIMIT ?`, [customerId, t.id, RECENT]);
  for (const o of orders) await withDue(db, o);
  // Everything paid on settled bills this guest was the member on (总消费), at every location of the company.
  const spent = member
    ? await db.one(`SELECT COALESCE(SUM(p.amount), 0) AS v FROM payments p JOIN bills b ON b.id = p.bill_id
        WHERE b.member_id = ? AND b.status = 'settled' AND p.status = 'paid'`, [member.id])
    : null;
  const items = await orderItems(db, orders.map((o) => o.id));
  return {
    company: { name: t.name, code: t.code },
    phoneVerified: Boolean(phone),
    wallet: member ? { balance: member.balance, ledger } : null,
    totalSpent: Number(spent?.v ?? 0),
    stash, bookings,
    orders: orders.map((o) => orderView(o, items.get(o.id) ?? [])),
  };
}
