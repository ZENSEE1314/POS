import type { Db } from './db.ts';
import { audit, DomainError } from './db.ts';
import type { Actor, Role } from './auth.ts';
import { hashPin, isTenantWide, require_, whoOf } from './auth.ts';
import { validStation } from './printers.ts';

const MIN_PIN_LENGTH = 4;
const TABLE_KINDS = ['bar', 'booth', 'room'];
const ROLES: Role[] = ['host', 'waiter', 'cashier', 'manager', 'finance', 'owner'];

/** Fen/count ceiling (10 million yuan) so SUM(qty * price) and stock arithmetic stay far inside BIGINT. */
const MAX_AMOUNT = 1_000_000_000;
const MAX_NAME_LENGTH = 200;

/** Numbers and digit strings only: Number(null), Number(true) and Number([]) would silently become 0 or 1. */
const int = (v: unknown, name: string, min = 0): number => {
  const n = typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < min) throw new DomainError(`${name} must be an integer >= ${min}`, 422);
  if (n > MAX_AMOUNT) throw new DomainError(`${name} is too large (max ${MAX_AMOUNT})`, 422);
  return n;
};
const text = (v: unknown, name: string): string => {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
  if (!s) throw new DomainError(`${name} is required`, 422);
  if (s.length > MAX_NAME_LENGTH) throw new DomainError(`${name} is too long (max ${MAX_NAME_LENGTH})`, 422);
  return s;
};
const flag = (v: unknown, name: string): boolean => {
  if (typeof v !== 'boolean') throw new DomainError(`${name} must be true or false`, 422);
  return v;
};

// ---- tables ----------------------------------------------------------------------------------

export async function createTable(db: Db, actor: Actor, b: any): Promise<number> {
  require_(actor, 'admin.write');
  const kind = String(b.kind ?? 'booth');
  if (!TABLE_KINDS.includes(kind)) throw new DomainError(`kind must be one of ${TABLE_KINDS.join(', ')}`, 422);
  const name = text(b.name, 'name');
  if (await db.one('SELECT 1 AS x FROM dining_tables WHERE store_id = ? AND name = ?', [actor.storeId, name])) throw new DomainError('table name already used', 409);
  const id = await db.insert('INSERT INTO dining_tables (store_id, name, zone, kind, capacity, min_spend, table_fee) VALUES (?,?,?,?,?,?,?)',
    [actor.storeId, name, String(b.zone ?? ''), kind, int(b.capacity ?? 4, 'capacity', 1), int(b.minSpend ?? 0, 'minSpend'), int(b.tableFee ?? 0, 'tableFee')]);
  await audit(db, whoOf(actor), 'table.create', 'table', id, b);
  return id;
}

export async function updateTable(db: Db, actor: Actor, id: number, b: any): Promise<void> {
  require_(actor, 'admin.write');
  const t = await db.one('SELECT * FROM dining_tables WHERE id = ? AND store_id = ?', [id, actor.storeId]);
  if (!t) throw new DomainError('table not found', 404);
  const next = {
    name: b.name !== undefined ? text(b.name, 'name') : t.name,
    zone: b.zone ?? t.zone,
    capacity: b.capacity !== undefined ? int(b.capacity, 'capacity', 1) : t.capacity,
    minSpend: b.minSpend !== undefined ? int(b.minSpend, 'minSpend') : t.min_spend,
    tableFee: b.tableFee !== undefined ? int(b.tableFee, 'tableFee') : t.table_fee,
    active: b.active !== undefined ? flag(b.active, 'active') : t.active,
  };
  if (next.name !== t.name && (await db.one('SELECT 1 AS x FROM dining_tables WHERE store_id = ? AND name = ? AND id <> ?', [actor.storeId, next.name, id]))) throw new DomainError('table name already used', 409);
  if (!next.active && t.status === 'occupied') throw new DomainError('cannot deactivate an occupied table', 409);
  // price changes apply to future bills only: open bills snapshot min_spend/table_fee when opened
  await db.run('UPDATE dining_tables SET name = ?, zone = ?, capacity = ?, min_spend = ?, table_fee = ?, active = ? WHERE id = ?',
    [next.name, next.zone, next.capacity, next.minSpend, next.tableFee, next.active, id]);
  await audit(db, whoOf(actor), 'table.update', 'table', id, b);
}

// ---- products and stock ------------------------------------------------------------------------

export async function createProduct(db: Db, actor: Actor, b: any): Promise<number> {
  require_(actor, 'admin.write');
  const name = text(b.name, 'name');
  if (await db.one('SELECT 1 AS x FROM products WHERE store_id = ? AND name = ?', [actor.storeId, name])) throw new DomainError('product name already used', 409);
  const id = await db.insert('INSERT INTO products (store_id, name, name_en, category, price, stock, track_stock, station) VALUES (?,?,?,?,?,?,?,?)',
    [actor.storeId, name, b.nameEn ? String(b.nameEn) : null, String(b.category ?? ''), int(b.price, 'price'), int(b.stock ?? 0, 'stock'), b.trackStock !== false, validStation(b.station ?? '')]);
  await audit(db, whoOf(actor), 'product.create', 'product', id, b);
  return id;
}

export async function updateProduct(db: Db, actor: Actor, id: number, b: any): Promise<void> {
  require_(actor, 'admin.write');
  const p = await db.one('SELECT * FROM products WHERE id = ? AND store_id = ?', [id, actor.storeId]);
  if (!p) throw new DomainError('product not found', 404);
  const name = b.name !== undefined ? text(b.name, 'name') : p.name;
  if (name !== p.name && (await db.one('SELECT 1 AS x FROM products WHERE store_id = ? AND name = ? AND id <> ?', [actor.storeId, name, id]))) throw new DomainError('product name already used', 409);
  await db.run('UPDATE products SET name = ?, name_en = ?, category = ?, price = ?, track_stock = ?, active = ?, station = ? WHERE id = ?', [
    name,
    b.nameEn !== undefined ? (b.nameEn ? String(b.nameEn) : null) : p.name_en,
    b.category ?? p.category,
    b.price !== undefined ? int(b.price, 'price') : p.price,
    b.trackStock !== undefined ? flag(b.trackStock, 'trackStock') : p.track_stock,
    b.active !== undefined ? flag(b.active, 'active') : p.active,
    b.station !== undefined ? validStation(b.station) : p.station, id]);
  await audit(db, whoOf(actor), 'product.update', 'product', id, b);
}

/** Stock-in / adjustment with a reason, kept as a movement log so stock is explainable. */
export async function adjustStock(db: Db, actor: Actor, productId: number, delta: number, reason: string): Promise<number> {
  require_(actor, 'admin.write');
  if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > MAX_AMOUNT) throw new DomainError(`delta must be a non-zero integer, at most ${MAX_AMOUNT} either way`, 422);
  const why = String(reason ?? '').trim();
  if (!why) throw new DomainError('reason required', 422);
  if (why.length > MAX_NAME_LENGTH) throw new DomainError(`reason is too long (max ${MAX_NAME_LENGTH})`, 422);
  return db.tx(async (t) => {
    const p = await t.one('UPDATE products SET stock = stock + ? WHERE id = ? AND store_id = ? RETURNING stock', [delta, productId, actor.storeId]);
    if (!p) throw new DomainError('product not found', 404);
    await t.run('INSERT INTO stock_movements (store_id, product_id, delta, reason, actor_id, ts) VALUES (?,?,?,?,?,?)', [actor.storeId, productId, delta, why, actor.id, Date.now()]);
    await audit(t, whoOf(actor), 'stock.adjust', 'product', productId, { delta, reason: why });
    return p.stock;
  });
}

// ---- commission rules ---------------------------------------------------------------------------

export function listRules(db: Db, actor: Actor) {
  return db.all('SELECT * FROM commission_rules WHERE store_id = ? ORDER BY role, id', [actor.storeId]);
}

export async function createRule(db: Db, actor: Actor, b: any): Promise<number> {
  require_(actor, 'admin.write');
  if (!['sales', 'waiter'].includes(b.role)) throw new DomainError('role must be sales or waiter', 422);
  const bps = int(b.bps ?? 0, 'bps');
  if (bps > 10000) throw new DomainError('bps cannot exceed 10000 (100%)', 422);
  const fixed = int(b.fixed ?? 0, 'fixed');
  if (b.category != null && typeof b.category !== 'string') throw new DomainError('category must be text', 422);
  const productId = b.productId == null ? null : int(b.productId, 'productId');
  if (productId !== null && !(await db.one('SELECT 1 AS x FROM products WHERE id = ? AND store_id = ?', [productId, actor.storeId]))) throw new DomainError('product not found', 404);
  const id = await db.insert('INSERT INTO commission_rules (store_id, role, category, product_id, bps, fixed) VALUES (?,?,?,?,?,?)',
    [actor.storeId, b.role, b.category ?? null, productId, bps, fixed]);
  await audit(db, whoOf(actor), 'rule.create', 'commission_rule', id, b);
  return id;
}

export async function deleteRule(db: Db, actor: Actor, id: number): Promise<void> {
  require_(actor, 'admin.write');
  const n = await db.run('DELETE FROM commission_rules WHERE id = ? AND store_id = ?', [id, actor.storeId]);
  if (!n) throw new DomainError('rule not found', 404);
  await audit(db, whoOf(actor), 'rule.delete', 'commission_rule', id, {});
}

// ---- staff --------------------------------------------------------------------------------------

export function listStaff(db: Db, actor: Actor) {
  require_(actor, 'admin.write');
  return db.all(
    `SELECT e.id, e.username, e.name, e.role, e.store_id AS "storeId", e.active FROM employees e
     WHERE e.tenant_id = ? AND (e.store_id = ? OR e.store_id IS NULL OR ?) ORDER BY e.id`, [actor.tenantId, actor.storeId, actor.role === 'owner']);
}

export async function updateStaff(db: Db, actor: Actor, id: number, b: { active?: boolean; pin?: string; name?: string; role?: Role }): Promise<void> {
  require_(actor, 'hq.write');
  const e = await db.one('SELECT * FROM employees WHERE id = ? AND tenant_id = ?', [id, actor.tenantId]);
  if (!e) throw new DomainError('staff not found', 404);
  if (e.id === actor.id && b.active === false) throw new DomainError('you cannot deactivate yourself', 409);
  if (b.pin !== undefined && (!['string', 'number'].includes(typeof b.pin) || String(b.pin).length < MIN_PIN_LENGTH)) throw new DomainError(`pin needs at least ${MIN_PIN_LENGTH} digits`, 422);
  if (b.role && !ROLES.includes(b.role)) throw new DomainError('unknown role', 422);
  if (b.role && isTenantWide(b.role) !== isTenantWide(e.role)) throw new DomainError('cannot switch between store and tenant-wide roles; create a new account', 422);
  if (b.role && e.id === actor.id && b.role !== e.role) throw new DomainError('you cannot change your own role', 409);
  const active = b.active === undefined ? e.active : flag(b.active, 'active');
  const name = b.name === undefined ? e.name : text(b.name, 'name');
  await db.tx(async (t) => {
    await t.run('UPDATE employees SET active = ?, name = ?, role = ?, pin_hash = ? WHERE id = ?',
      [active, name, b.role || e.role, b.pin !== undefined ? hashPin(String(b.pin)) : e.pin_hash, id]);
    if (b.active === false || b.pin !== undefined) await t.run('DELETE FROM sessions WHERE employee_id = ?', [id]);
    await audit(t, whoOf(actor), 'staff.update', 'employee', id, { ...b, pin: b.pin !== undefined ? '***' : undefined });
  });
}

// ---- shifts ---------------------------------------------------------------------------------------

export async function openShift(db: Db, actor: Actor, openingCash: number): Promise<number> {
  require_(actor, 'bill.settle');
  int(openingCash, 'openingCash');
  try {
    const id = await db.insert('INSERT INTO shifts (store_id, cashier_id, opened_at, opening_cash) VALUES (?,?,?,?)', [actor.storeId, actor.id, Date.now(), openingCash]);
    await audit(db, whoOf(actor), 'shift.open', 'shift', id, { openingCash });
    return id;
  } catch (e) {
    if (String((e as Error).message).includes('shifts_one_open_per_cashier')) throw new DomainError('you already have an open shift', 409);
    throw e;
  }
}

export async function currentShift(db: Db, actor: Actor) {
  const s = await db.one('SELECT * FROM shifts WHERE cashier_id = ? AND closed_at IS NULL', [actor.id]);
  if (!s) return null;
  const by = await db.all("SELECT method, COALESCE(SUM(amount),0) AS amount, COUNT(*) AS n FROM payments WHERE shift_id = ? AND status = 'paid' GROUP BY method", [s.id]);
  const cash = by.find((r: any) => r.method === 'cash')?.amount ?? 0;
  return { ...s, byMethod: by, expectedCash: s.opening_cash + cash };
}

/** Closing records the cash count and the variance; it does not block on open bills (they carry to the next shift). */
export async function closeShift(db: Db, actor: Actor, countedCash: number) {
  require_(actor, 'bill.settle');
  int(countedCash, 'countedCash');
  return db.tx(async (t) => {
    const s = await currentShift(t, actor);
    if (!s) throw new DomainError('no open shift', 404);
    const variance = countedCash - s.expectedCash;
    await t.run('UPDATE shifts SET closed_at = ?, counted_cash = ?, expected_cash = ?, variance = ? WHERE id = ?', [Date.now(), countedCash, s.expectedCash, variance, s.id]);
    await audit(t, whoOf(actor), 'shift.close', 'shift', s.id, { countedCash, expected: s.expectedCash, variance });
    return { shiftId: s.id, expectedCash: s.expectedCash, countedCash, variance, byMethod: s.byMethod };
  });
}

export function listShifts(db: Db, actor: Actor) {
  require_(actor, 'audit.read');
  return db.all(
    `SELECT s.*, e.name AS cashier FROM shifts s JOIN employees e ON e.id = s.cashier_id WHERE s.store_id = ? ORDER BY s.id DESC LIMIT 50`, [actor.storeId]);
}

// ---- receivables (挂账) -------------------------------------------------------------------------------

export function listReceivables(db: Db, actor: Actor) {
  require_(actor, 'payroll.read');
  return db.all(
    `SELECT p.id AS "paymentId", p.bill_id AS "billId", p.amount, p.created_at AS "createdAt",
            COALESCE((SELECT SUM(c.amount) FROM receivable_collections c WHERE c.payment_id = p.id),0) AS collected,
            m.phone
     FROM payments p JOIN bills b ON b.id = p.bill_id LEFT JOIN members m ON m.id = b.member_id
     WHERE p.method = 'credit' AND p.status = 'paid' AND b.store_id = ?
     ORDER BY p.id DESC LIMIT 200`, [actor.storeId]);
}

export async function collectReceivable(db: Db, actor: Actor, paymentId: number, amount: number, method: string) {
  require_(actor, 'payroll.read');
  int(amount, 'amount', 1);
  if (!['cash', 'wechat', 'alipay', 'transfer'].includes(method)) throw new DomainError('method must be cash, wechat, alipay or transfer', 422);
  return db.tx(async (t) => {
    const p = await t.one(
      "SELECT p.* FROM payments p JOIN bills b ON b.id = p.bill_id WHERE p.id = ? AND p.method = 'credit' AND p.status = 'paid' AND b.store_id = ? FOR UPDATE", [paymentId, actor.storeId]);
    if (!p) throw new DomainError('receivable not found', 404);
    const done = (await t.one('SELECT COALESCE(SUM(amount),0) AS s FROM receivable_collections WHERE payment_id = ?', [paymentId]))!.s;
    if (done + amount > p.amount) throw new DomainError('collection exceeds the outstanding amount', 409);
    await t.run('INSERT INTO receivable_collections (payment_id, amount, method, actor_id, ts) VALUES (?,?,?,?,?)', [paymentId, amount, method, actor.id, Date.now()]);
    await audit(t, whoOf(actor), 'receivable.collect', 'payment', paymentId, { amount, method });
    return { outstanding: p.amount - done - amount };
  });
}

// ---- reports ---------------------------------------------------------------------------------------

export async function dailyReport(db: Db, actor: Actor, fromTs: number, toTs: number) {
  require_(actor, 'audit.read');
  const bills = await db.one("SELECT COUNT(*) AS n FROM bills WHERE store_id = ? AND status = 'settled' AND closed_at >= ? AND closed_at < ?", [actor.storeId, fromTs, toTs]);
  const byMethod = await db.all(
    `SELECT p.method, SUM(p.amount) AS amount, COUNT(*) AS n FROM payments p JOIN bills b ON b.id = p.bill_id
     WHERE b.store_id = ? AND b.status = 'settled' AND b.closed_at >= ? AND b.closed_at < ? AND p.status = 'paid' GROUP BY p.method ORDER BY amount DESC`, [actor.storeId, fromTs, toTs]);
  const topItems = await db.all(
    `SELECT l.name, SUM(l.qty) AS qty, SUM(l.qty * l.unit_price) AS amount FROM bill_lines l JOIN bills b ON b.id = l.bill_id
     WHERE b.store_id = ? AND b.status = 'settled' AND b.closed_at >= ? AND b.closed_at < ? AND l.status = 'active' AND l.kind = 'sale'
     GROUP BY l.name ORDER BY amount DESC LIMIT 10`, [actor.storeId, fromTs, toTs]);
  const flags = await db.one(
    `SELECT COUNT(*) FILTER (WHERE action = 'order.void') AS voids, COUNT(*) FILTER (WHERE action = 'order.gift') AS gifts,
            COUNT(*) FILTER (WHERE action = 'bill.discount') AS discounts
     FROM audit WHERE store_id = ? AND ts >= ? AND ts < ?`, [actor.storeId, fromTs, toTs]);
  const revenue = byMethod.reduce((a: number, r: any) => a + r.amount, 0);
  return { bills: bills!.n, revenue, byMethod, topItems, voids: flags!.voids, gifts: flags!.gifts, discounts: flags!.discounts };
}

export function searchMembers(db: Db, actor: Actor, q: string) {
  return db.all('SELECT id, phone, name, balance FROM members WHERE tenant_id = ? AND (phone LIKE ? OR name LIKE ?) ORDER BY id DESC LIMIT 50',
    [actor.tenantId, `%${q}%`, `%${q}%`]);
}
