// Offline API emulator: answers the floor's API calls from local data and queues what must reach the server later.
// It returns the SAME JSON shapes the server returns, so floor.js, bill-view.js and bill-actions.js run unchanged.
// It never invents server-owned data (stock, member balances, ids of real records): only cached copies and local bills.
import { t } from '../i18n.js';
import './strings.js';
import { app, can, ApiError } from '../session.js';
import { computeTotals } from './totals.js';
import { hasModule, isWeighed } from '../business.js';
import { getValue, setValue, deleteValue, pruneValues, transact, listBills, listOps, notifyChanged } from './store.js';

export const NOT_HANDLED = Symbol('not-handled');

const MAX_LINE_QTY = 9999;
const MAX_WEIGHT_G = 1_000_000;
const GRAMS_PER_KG = 1000;
const BARCODE_RE = /^[0-9A-Za-z-]{1,32}$/;
/** Shop scale label, same layout as src/retail.ts: 2 + 6-digit item code + 5-digit value + EAN-13 check digit. */
const SCALE_LABEL_RE = /^2\d{12}$/;
const COUNTER_SALES = '/api/counter-sales';
const FP_SEED = 0x1b873593;

/** Endpoints whose responses are cached while online and replayed offline (exact path, no query string). */
const CACHED_GETS = ['/api/tables', '/api/products', '/api/reps', '/api/me', '/api/config', '/api/shifts/current', COUNTER_SALES];
const BILL_PATH = /^\/api\/bills\/(-?\d+)(?:\/(lines|pay|scan|member))?$/;
const BILL_POST = /^\/api\/bills\/-?\d+\/(lines|pay|scan|member)$/;

const needsConnection = () => new ApiError(t('offline.needsConnection'), 0);
const fail = (message, status) => new ApiError(message, status);
const need = (action) => {
  if (!can(action)) throw fail(`role ${app.actor?.role} may not ${action}`, 403);
};
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-0000-4000-8000-${Math.random().toString(16).slice(2).padEnd(12, '0').slice(0, 12)}`);

/** Not a security hash: it only keys the cached /api/me so another user's token can never read it. */
function fingerprint(text) {
  let h1 = 0xdeadbeef ^ FP_SEED;
  let h2 = 0x41c6ce57 ^ FP_SEED;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const storeScope = () => (app.actor ? `s${app.actor.storeId}` : null);

function cacheKey(path) {
  if (path === '/api/config') return 'cache:config';
  if (path === '/api/me') return app.token ? `cache:me:${fingerprint(app.token)}` : null;
  const s = storeScope();
  if (!s) return null;
  if (path === '/api/shifts/current') return `cache:${s}:u${app.actor.id}:${path}`;
  return `cache:${s}:${path}`;
}

const billCacheKey = (id) => (storeScope() ? `cache:${storeScope()}:bill:${id}` : null);

// ---------- local bills ----------

const localBillsOfStore = async () => (await listBills()).filter((b) => b.storeId === app.actor?.storeId);

async function findLocalBill(billId) {
  return (await localBillsOfStore()).find((b) => b.billId === billId);
}

const pendingOpsFor = async (ref) => (await listOps()).filter((o) => o.status === 'pending' && (o.ref === ref || o.payload.billRef === ref));

/** Applies local bills on top of a tables list: tables taken by offline bills show occupied, tables whose bill was paid offline show free. */
export async function overlayTables(tables) {
  const copies = await localBillsOfStore();
  if (!copies.length) return tables;
  const out = tables.map((tb) => ({ ...tb }));
  for (const c of copies) {
    const tb = out.find((x) => x.id === c.bill.table_id);
    if (!tb) continue;
    if (c.bill.status === 'open' && tb.status === 'free' && !tb.bill_id) Object.assign(tb, { status: 'occupied', bill_id: c.billId });
    else if (c.bill.status === 'settled' && tb.bill_id === c.billId) Object.assign(tb, { status: 'free', bill_id: null });
  }
  return out;
}

function billResponse(copy) {
  return { bill: copy.bill, lines: copy.lines, payments: copy.payments, totals: computeTotals(copy.bill, copy.lines, copy.payments) };
}

/** Starts a local working copy of a bill that exists on the server, from the last bill response this device saw. */
async function adoptRealBill(billId) {
  const key = billCacheKey(billId);
  const cached = key ? await getValue(key) : undefined;
  if (!cached) throw needsConnection();
  return { ref: String(billId), billId, clientRef: null, storeId: app.actor.storeId, tableName: null, bill: cached.bill, lines: cached.lines, payments: cached.payments };
}

const saleName = (bill) => `${t(`channel.${bill.channel ?? 'counter'}`)} #${bill.id}`;

async function tableName(tableId) {
  const key = cacheKey('/api/tables');
  const tables = key ? await getValue(key) : null;
  return tables?.find((x) => x.id === tableId)?.name ?? `#${tableId}`;
}

function enqueue(s, copy, type, payload, meta) {
  const op = {
    opId: newId(), type, payload, ts: Date.now(), status: 'pending', actorId: app.actor.id, storeId: app.actor.storeId,
    meta: { ...meta, tableName: copy.tableName, billId: copy.billId },
  };
  if (type === 'bill.open' || type === 'counter.open') op.ref = copy.ref;
  return s.put('ops', op);
}

/**
 * Runs one read-modify-write on a bill's working copy in a single IndexedDB transaction, so two tabs cannot interleave.
 * Everything that needs another store (cached tables, cached bills) is read BEFORE the transaction: an IndexedDB
 * transaction closes itself if it waits on anything else.
 */
async function mutateBill(billId, mutate) {
  const base = (await findLocalBill(billId)) ?? (billId > 0 ? await adoptRealBill(billId) : null);
  if (!base) throw fail('bill not found', 404);
  const name = base.tableName ?? (base.bill.table_id == null ? saleName(base.bill) : await tableName(base.bill.table_id));
  const result = await transact(['bills', 'ops'], 'readwrite', async (s) => {
    const copy = (await s.all('bills')).find((b) => b.billId === billId && b.storeId === app.actor.storeId) ?? { ...base, tableName: name };
    if (copy.bill.status !== 'open') throw fail(`bill is ${copy.bill.status}`, 409);
    copy.tableName ??= name;
    const out = await mutate(copy, s);
    await s.put('bills', copy);
    return out;
  });
  notifyChanged();
  return result;
}

// ---------- mutations ----------

async function openBill(body) {
  need('table.open');
  if (!isId(body.tableId)) throw fail('tableId is required', 422);
  if (body.repId != null && !isId(body.repId)) throw fail('repId must be an employee id', 422);
  // Same rule as the server: without the reps module the person opening the table owns the bill.
  const repId = body.repId || (hasModule('reps') ? null : app.actor.id);
  if (!repId) throw fail('sales rep (repId) is required to open a table', 422);
  const tablesKey = cacheKey('/api/tables');
  const repsKey = cacheKey('/api/reps');
  const [tables, reps] = await Promise.all([tablesKey && getValue(tablesKey), repsKey && getValue(repsKey)]);
  if (!tables || !reps) throw needsConnection();
  const table = (await overlayTables(tables)).find((x) => x.id === body.tableId);
  if (!table) throw fail('table not found', 404);
  if (table.status === 'occupied' || table.bill_id) throw fail('table already occupied', 409);
  if (repId !== app.actor.id && !reps.some((r) => r.id === repId)) throw fail('sales rep not found in this store', 422);

  const billId = await transact(['bills', 'ops', 'kv'], 'readwrite', async (s) => {
    const next = ((await s.get('kv', 'meta:tempSeq')) ?? 0) + 1;
    await s.put('kv', next, 'meta:tempSeq');
    const id = -next;
    const ref = newId();
    const copy = {
      ref, billId: id, clientRef: ref, storeId: app.actor.storeId, tableName: table.name,
      bill: {
        id, store_id: app.actor.storeId, table_id: table.id, channel: 'table', rep_id: repId, member_id: null, booking_id: null, status: 'open',
        min_spend: table.min_spend, table_fee: table.table_fee, discount: 0, opened_at: Date.now(), closed_at: null,
        member_phone: body.phone || null, member_balance: null, offline: true,
      },
      lines: [], payments: [],
    };
    await s.put('bills', copy);
    await enqueue(s, copy, 'bill.open', { tableId: table.id, repId, ...(body.phone ? { phone: String(body.phone) } : {}) }, { tempId: id });
    return id;
  });
  notifyChanged();
  return { billId };
}

/** A counter sale (no table) opened offline: it gets a temp id now and its real id when counter.open syncs. */
async function openCounterSale(body) {
  need('order.add');
  if (!hasModule('counter')) throw fail('not found', 404);
  if (body.repId != null && !isId(body.repId)) throw fail('repId must be an employee id', 422);
  const phone = body.phone ? String(body.phone) : null;
  const billId = await transact(['bills', 'ops', 'kv'], 'readwrite', async (s) => {
    const next = ((await s.get('kv', 'meta:tempSeq')) ?? 0) + 1;
    await s.put('kv', next, 'meta:tempSeq');
    const id = -next;
    const ref = newId();
    const bill = {
      id, store_id: app.actor.storeId, table_id: null, channel: 'counter', rep_id: body.repId ?? app.actor.id, member_id: null, booking_id: null,
      status: 'open', min_spend: 0, table_fee: 0, discount: 0, opened_at: Date.now(), closed_at: null, member_phone: phone, member_balance: null, offline: true,
    };
    const copy = { ref, billId: id, clientRef: ref, storeId: app.actor.storeId, tableName: t('channel.counter'), bill, lines: [], payments: [] };
    await s.put('bills', copy);
    await enqueue(s, copy, 'counter.open', { ...(body.repId ? { repId: body.repId } : {}), ...(phone ? { phone } : {}) }, { tempId: id });
    return id;
  });
  notifyChanged();
  return { billId };
}

// ---------- prices: a mirror of src/pricing.ts minus promotions (not cached offline; the server re-prices on sync) ----------

const linePrice = (pricePerKg, weightG) => Math.round((pricePerKg * weightG) / GRAMS_PER_KG);
const weightFromPrice = (labelPrice, pricePerKg) => Math.max(1, pricePerKg > 0 ? Math.round((labelPrice * GRAMS_PER_KG) / pricePerKg) : 1);

function offlinePrice(p, hasMember) {
  if (hasMember && p.member_price != null && p.member_price < p.price) return { unitPrice: p.member_price, note: 'member' };
  return { unitPrice: p.price, note: null };
}

async function cachedProducts() {
  const key = cacheKey('/api/products');
  const products = key ? await getValue(key) : null;
  if (!products) throw needsConnection();
  return products;
}

/** Adds one sale line to the working copy and queues the op that will add it on the server. */
async function pushLine(copy, s, p, { qty, weightG = null, unitPrice, note }, op) {
  const lineId = Math.min(0, ...copy.lines.map((l) => l.id)) - 1;
  copy.lines.push({
    id: lineId, bill_id: copy.billId, product_id: p.id, name: p.name, qty, unit_price: unitPrice, kind: 'sale', status: 'active', reason: null,
    waiter_id: app.actor.id, created_at: Date.now(), weight_g: weightG, price_note: note,
  });
  await enqueue(s, copy, op.type, { billRef: copy.ref, ...op.payload }, { productName: p.name, qty, ...(weightG ? { weightG } : {}) });
  return { lineId, productId: p.id };
}

function checkWeight(p, qty, weightG) {
  if (isWeighed(p)) {
    if (weightG == null || qty !== 1) throw fail('this item is sold by weight: send qty 1 and weightG', 422);
    if (!Number.isInteger(weightG) || weightG <= 0 || weightG > MAX_WEIGHT_G) throw fail(`weightG must be whole grams from 1 to ${MAX_WEIGHT_G}`, 422);
  } else if (weightG != null) throw fail('weightG is only for items sold by weight', 422);
}

async function addLine(billId, body) {
  need('order.add');
  if (!Number.isInteger(body.qty) || body.qty <= 0 || body.qty > MAX_LINE_QTY) throw fail(`qty must be an integer from 1 to ${MAX_LINE_QTY}`, 422);
  if (!isId(body.productId)) throw fail('productId is required', 422);
  // Gifts need a manager's approval and a reason on the server: online only.
  if (body.gift) throw needsConnection();
  const p = (await cachedProducts()).find((x) => x.id === body.productId && x.active);
  if (!p) throw fail('product not found', 404);
  const weightG = body.weightG ?? null;
  checkWeight(p, body.qty, weightG);
  return mutateBill(billId, async (copy, s) => {
    const price = offlinePrice(p, Boolean(copy.bill.member_phone));
    const unitPrice = weightG ? linePrice(price.unitPrice, weightG) : price.unitPrice;
    const payload = { productId: p.id, qty: body.qty, ...(weightG ? { weightG } : {}) };
    const { lineId } = await pushLine(copy, s, p, { qty: body.qty, weightG, unitPrice, note: price.note }, { type: 'bill.addLine', payload });
    return { lineId };
  });
}

/** Barcode scan, the same decisions as scanCode() in src/retail.ts. */
async function scan(billId, body) {
  need('order.add');
  if (!hasModule('barcode')) throw fail('not found', 404);
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!BARCODE_RE.test(code)) throw fail('barcode: 1-32 letters, digits or hyphens', 422);
  const qty = body.qty ?? 1;
  if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_LINE_QTY) throw fail(`qty must be an integer from 1 to ${MAX_LINE_QTY}`, 422);
  const products = (await cachedProducts()).filter((x) => x.active);
  const p = products.find((x) => x.barcode === code);
  if (p) {
    if (isWeighed(p)) return { needsWeight: true, product: { id: p.id, name: p.name, nameEn: p.name_en, price: p.price } };
    return { ...(await addLine(billId, { productId: p.id, qty })), productId: p.id };
  }
  const label = parseScaleLabel(code);
  const item = label && products.find((x) => x.barcode === label.plu);
  if (!label || !item) throw fail('no product has this barcode', 404);
  if (label.value <= 0) throw fail('this scale label has no amount on it', 422);
  if (app.business?.scaleMode === 'weight') {
    if (!isWeighed(item)) throw fail('this label carries a weight but the item is not sold by weight', 422);
    return { ...(await addLine(billId, { productId: item.id, qty: 1, weightG: label.value })), productId: item.id };
  }
  // A price label charges the printed price; the server reads that price from the code itself, so the scan is queued as is.
  const weightG = isWeighed(item) ? weightFromPrice(label.value, item.price) : null;
  return mutateBill(billId, (copy, s) => pushLine(copy, s, item, { qty: 1, weightG, unitPrice: label.value, note: 'label' }, { type: 'bill.scan', payload: { code, qty: 1 } }));
}

function parseScaleLabel(code) {
  if (!SCALE_LABEL_RE.test(code)) return null;
  const sum = [...code.slice(0, 12)].reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0);
  if ((10 - (sum % 10)) % 10 !== Number(code[12])) return null;
  return { plu: code.slice(1, 7), value: Number(code.slice(7, 12)) };
}

/** Puts a member on the sale and lowers lines that are cheaper for members, like attachMember() on the server. */
async function attachMember(billId, body) {
  need('order.add');
  const phone = String(body.phone ?? '').replace(/[\s\-().]/g, '').replace(/^\+86(\d{11})$/, '$1');
  if (phone.length < 3 || phone.length > 32) throw fail('phone is required (3-32 characters)', 422);
  const products = await cachedProducts();
  return mutateBill(billId, async (copy, s) => {
    if (copy.bill.member_phone) throw fail('this bill already has a member', 409);
    copy.bill.member_phone = phone;
    for (const l of copy.lines) {
      const p = products.find((x) => x.id === l.product_id);
      if (!p || l.status !== 'active' || l.kind !== 'sale' || l.price_note === 'label') continue;
      const price = offlinePrice(p, true);
      const unitPrice = l.weight_g != null ? linePrice(price.unitPrice, l.weight_g) : price.unitPrice;
      if (unitPrice < l.unit_price) Object.assign(l, { unit_price: unitPrice, price_note: price.note });
    }
    await enqueue(s, copy, 'bill.member', { billRef: copy.ref, phone }, { phone });
    return { ok: true };
  });
}

async function pay(billId, body) {
  need('bill.settle');
  if (!['cash', 'member', 'credit'].includes(body.method)) throw fail('method must be cash, member or credit', 422);
  // The wallet balance is server-owned: spending it offline could overdraw it.
  if (body.method === 'member') throw needsConnection();
  if (body.amount !== undefined && !Number.isSafeInteger(body.amount)) throw fail('expected an integer number', 422);
  return mutateBill(billId, async (copy, s) => {
    const due = computeTotals(copy.bill, copy.lines, copy.payments).due;
    const settle = () => Object.assign(copy.bill, { status: 'settled', closed_at: Date.now() });
    const amount = due === 0 ? 0 : Math.min(body.amount ?? due, due);
    if (due > 0 && amount <= 0) throw fail('nothing due', 409);
    if (amount > 0) {
      copy.payments.push({
        id: Math.min(0, ...copy.payments.map((p) => p.id)) - 1, bill_id: copy.billId, method: body.method, amount, status: 'paid',
        out_trade_no: null, provider_ref: null, created_at: Date.now(), paid_at: Date.now(), shift_id: null, offline: true,
      });
    }
    // Same rule as the server: settled once nothing is due; a zero-total bill is settled by the pay call itself.
    if (computeTotals(copy.bill, copy.lines, copy.payments).due === 0) settle();
    await enqueue(s, copy, 'bill.pay', { billRef: copy.ref, method: body.method, amount, expectedDue: due }, { amount, method: body.method });
    return { settled: copy.bill.status === 'settled', paid: amount };
  });
}

// ---------- reads ----------

async function cachedGet(path) {
  const key = cacheKey(path);
  const hit = key ? await getValue(key) : undefined;
  if (hit === undefined) throw needsConnection();
  return hit;
}

const saleRow = (c) => ({
  id: c.billId, channel: c.bill.channel ?? 'counter', openedAt: c.bill.opened_at, repId: c.bill.rep_id, memberPhone: c.bill.member_phone ?? null,
  lines: c.lines.filter((l) => l.status === 'active').length, total: computeTotals(c.bill, c.lines, c.payments).total,
});

/** The open-sales list with this device's offline work on top: new sales added, changed ones updated, ones paid offline removed. */
async function overlayCounterSales(sales) {
  const copies = (await localBillsOfStore()).filter((c) => c.bill.table_id == null);
  if (!copies.length) return sales;
  const byId = new Map(copies.map((c) => [c.billId, c]));
  const out = sales.filter((b) => byId.get(b.id)?.bill.status !== 'settled').map((b) => (byId.has(b.id) ? saleRow(byId.get(b.id)) : b));
  for (const c of copies) if (c.bill.status === 'open' && !out.some((b) => b.id === c.billId)) out.unshift(saleRow(c));
  return out;
}

async function readBill(billId) {
  const local = await findLocalBill(billId);
  if (local) return billResponse(local);
  if (billId < 0) throw fail('bill not found', 404);
  const key = billCacheKey(billId);
  const hit = key ? await getValue(key) : undefined;
  if (!hit) throw needsConnection();
  return hit;
}

const cleanPath = (path) => path.split('?')[0];
const hasQuery = (path) => path.includes('?');

/** Is this a call the emulator can answer (given the data it holds)? Everything else must say "needs connection" offline. */
export function isEmulated(method, path) {
  const p = cleanPath(path);
  if (method === 'GET') return (!hasQuery(path) && CACHED_GETS.includes(p)) || /^\/api\/bills\/-?\d+$/.test(p);
  if (method === 'POST') return p === '/api/bills' || p === COUNTER_SALES || BILL_POST.test(p);
  return false;
}

/** Answers an emulated call from local data. Throws the "needs connection" error for anything it cannot serve. */
export async function emulate(method, path, body = {}) {
  if (!isEmulated(method, path)) throw needsConnection();
  const p = cleanPath(path);
  if (method === 'GET' && p === COUNTER_SALES) {
    // A till that never loaded Checkout online can still ring up sales offline: start from an empty list.
    const key = cacheKey(p);
    return overlayCounterSales((key && (await getValue(key))) ?? []);
  }
  if (method === 'GET' && CACHED_GETS.includes(p)) {
    const data = await cachedGet(p);
    return p === '/api/tables' ? overlayTables(data) : data;
  }
  if (method === 'POST' && p === '/api/bills') return openBill(body);
  if (method === 'POST' && p === COUNTER_SALES) return openCounterSale(body);
  const m = BILL_PATH.exec(p);
  const billId = Number(m[1]);
  if (method === 'GET') return readBill(billId);
  const handler = { lines: addLine, pay, scan, member: attachMember }[m[2]];
  return handler(billId, body);
}

/** Bill ids whose last response is worth keeping: bills on a table, and open counter sales. */
async function liveBillKeys() {
  const [tables, sales] = await Promise.all([cacheKey('/api/tables'), cacheKey(COUNTER_SALES)].map((k) => (k ? getValue(k) : null)));
  return new Set([...(tables ?? []).filter((x) => x.bill_id).map((x) => x.bill_id), ...(sales ?? []).map((b) => b.id)].map(billCacheKey));
}

/**
 * Called before the network: a bill that has local state (a temp bill, or a real one with queued operations) must keep being
 * served locally, even when the connection is back, or the queued operations would be applied out of order.
 */
export async function ownsRequest(method, path) {
  const m = BILL_PATH.exec(cleanPath(path));
  if (!m || !isEmulated(method, path)) return false;
  const billId = Number(m[1]);
  if (billId < 0) return true;
  const local = await findLocalBill(billId);
  return Boolean(local && (local.bill.status !== 'open' || (await pendingOpsFor(local.ref)).length > 0));
}

/** Called with every successful network response: refresh the offline cache and show local bills on the board. */
export async function afterNetwork(method, path, data) {
  if (method !== 'GET' || hasQuery(path)) return data;
  const p = cleanPath(path);
  try {
    if (CACHED_GETS.includes(p)) {
      const key = cacheKey(p);
      if (key) await setValue(key, data);
      if (p === '/api/tables' || p === COUNTER_SALES) await pruneValues(`cache:${storeScope()}:bill:`, await liveBillKeys());
      if (p === '/api/tables') return await overlayTables(data);
      if (p === COUNTER_SALES) return await overlayCounterSales(data);
      return data;
    }
    const m = BILL_PATH.exec(p);
    if (m && !m[2]) {
      const key = billCacheKey(Number(m[1]));
      if (key) {
        if (data.bill.status === 'open') await setValue(key, data); else await deleteValue(key);
      }
    }
  } catch { /* caching is best effort */ }
  return data;
}
