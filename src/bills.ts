import type { Db } from './db.ts';
import { audit, DomainError } from './db.ts';
import type { Actor } from './auth.ts';
import { require_, whoOf } from './auth.ts';
import { cleanPhone } from './phone.ts';
import { hasModule, requireModule } from './business.ts';
import { linePrice, priceFor } from './pricing.ts';
import { claimCustomer } from './office.ts';

export interface BillTotals {
  subtotal: number;      // active sale lines
  minSpendTopUp: number; // difference charged when subtotal < min spend
  tableFee: number;
  discount: number;
  total: number;
  paid: number;
  due: number;
}

const MAX_LINE_QTY = 9999;
/** One tonne: far beyond any scale a till is attached to. */
const MAX_WEIGHT_G = 1_000_000;
export type TablelessChannel = 'counter' | 'pickup' | 'delivery';
const isId = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) > 0;

export async function openTable(db: Db, actor: Actor, input: { tableId: number; repId?: number; phone?: string; bookingId?: number }): Promise<number> {
  require_(actor, 'table.open');
  if (!isId(input.tableId)) throw new DomainError('tableId is required', 422);
  if (input.repId != null && !isId(input.repId)) throw new DomainError('repId must be an employee id', 422);
  if (input.bookingId != null && !isId(input.bookingId)) throw new DomainError('bookingId must be a booking id', 422);
  return db.tx(async (t) => {
    // Lock the table row so two hosts cannot open it at once (the partial unique index is the backstop).
    const table = await t.one('SELECT * FROM dining_tables WHERE id = ? AND store_id = ? AND active FOR UPDATE', [input.tableId, actor.storeId]);
    if (!table) throw new DomainError('table not found', 404);
    if (table.status === 'occupied') throw new DomainError('table already occupied', 409);

    let repId = input.repId;
    let phone = input.phone;
    let bookingId: number | undefined;
    if (input.bookingId) {
      const booking = await t.one('SELECT * FROM bookings WHERE id = ? AND store_id = ? FOR UPDATE', [input.bookingId, actor.storeId]);
      if (!booking) throw new DomainError('booking not found', 404);
      if (!['confirmed', 'submitted'].includes(booking.status)) throw new DomainError(`booking is ${booking.status}`, 409);
      repId ??= booking.rep_id ?? undefined;
      phone ??= booking.phone;
      bookingId = booking.id;
    }
    // Without the reps module nobody earns sales commission, so the person opening the table owns the bill.
    if (!repId && !(await hasModule(t, actor.tenantId, 'reps'))) repId = actor.id;
    // Commission ownership is decided here; forgetting the rep is the most common error in competing systems.
    if (!repId) throw new DomainError('sales rep (repId) is required to open a table', 422);
    await assertRep(t, actor, repId);
    const memberId = phone ? await getOrCreateMember(t, actor.tenantId, phone) : null;
    if (memberId) await claimCustomer(t, memberId, repId);
    const billId = await t.insert(
      `INSERT INTO bills (store_id, table_id, rep_id, member_id, booking_id, min_spend, table_fee, opened_at)
       VALUES (?,?,?,?,?,?,?,?)`, [actor.storeId, table.id, repId, memberId, bookingId ?? null, table.min_spend, table.table_fee, Date.now()]);
    await t.run("UPDATE dining_tables SET status = 'occupied' WHERE id = ?", [table.id]);
    if (bookingId) await t.run("UPDATE bookings SET status = 'checked_in', table_id = ? WHERE id = ?", [table.id, bookingId]);
    await audit(t, whoOf(actor), 'table.open', 'bill', billId, { tableId: table.id, repId, bookingId });
    return billId;
  });
}

/** The rep must work at this store, or be tenant-wide staff (store_id NULL). */
async function assertRep(t: Db, actor: Actor, repId: number): Promise<void> {
  const rep = await t.one(
    'SELECT id FROM employees WHERE id = ? AND tenant_id = ? AND (store_id = ? OR store_id IS NULL) AND active', [repId, actor.tenantId, actor.storeId]);
  if (!rep) throw new DomainError('sales rep not found in this store', 422);
}

/** A quick sale at the counter: no table, the cashier owns it (or the chosen stylist / sales rep). Several can be open (held) at once. */
export async function openCounterSale(db: Db, actor: Actor, input: { phone?: string; repId?: number }): Promise<number> {
  require_(actor, 'order.add');
  if (input.repId != null && !isId(input.repId)) throw new DomainError('repId must be an employee id', 422);
  await requireModule(db, actor.tenantId, 'counter');
  return db.tx((t) => openTablelessBill(t, actor, 'counter', input.repId ?? actor.id, input.phone));
}

export async function openTablelessBill(t: Db, actor: Actor, channel: TablelessChannel, repId: number, phone?: string): Promise<number> {
  await assertRep(t, actor, repId);
  const memberId = phone ? await getOrCreateMember(t, actor.tenantId, phone) : null;
  const billId = await t.insert('INSERT INTO bills (store_id, table_id, channel, rep_id, member_id, opened_at) VALUES (?,NULL,?,?,?,?)',
    [actor.storeId, channel, repId, memberId, Date.now()]);
  await audit(t, whoOf(actor), 'bill.open', 'bill', billId, { channel, repId });
  return billId;
}

/** Open sales that are not on a table (counter, pickup, delivery), newest first, with their running totals. */
export async function listOpenTableless(db: Db, actor: Actor) {
  require_(actor, 'order.add');
  const bills = await db.all(
    `SELECT b.id, b.channel, b.opened_at AS "openedAt", b.rep_id AS "repId", m.phone AS "memberPhone",
            (SELECT COUNT(*) FROM bill_lines l WHERE l.bill_id = b.id AND l.status = 'active') AS lines
     FROM bills b LEFT JOIN members m ON m.id = b.member_id
     WHERE b.store_id = ? AND b.table_id IS NULL AND b.status = 'open' ORDER BY b.id DESC`, [actor.storeId]);
  return Promise.all(bills.map(async (b) => ({ ...b, total: (await totals(db, b.id)).total })));
}

export async function getOrCreateMember(db: Db, tenantId: number, rawPhone: string): Promise<number> {
  const phone = cleanPhone(rawPhone);
  await db.run('INSERT INTO members (tenant_id, phone) VALUES (?,?) ON CONFLICT (tenant_id, phone) DO NOTHING', [tenantId, phone]);
  return (await db.one('SELECT id FROM members WHERE tenant_id = ? AND phone = ?', [tenantId, phone]))!.id;
}

async function assertOpenBill(db: Db, actor: Actor, billId: number): Promise<{ member_id: number | null; rep_id: number | null }> {
  // FOR UPDATE: a line must not slip into a bill that a concurrent payment is settling.
  const bill = await db.one('SELECT status, member_id, rep_id FROM bills WHERE id = ? AND store_id = ? FOR UPDATE', [billId, actor.storeId]);
  if (!bill) throw new DomainError('bill not found', 404);
  if (bill.status !== 'open') throw new DomainError(`bill is ${bill.status}`, 409);
  return bill;
}

export interface LineInput { productId: number; qty: number; gift?: boolean; reason?: string; weightG?: number }

/**
 * Adds a line at today's price for this bill (member price and running promotions included). Items sold by weight take
 * qty 1 plus weightG, and the line carries the price of that portion. labelPrice is the price printed on a scale label;
 * it is only ever passed by the barcode scanner, never taken from a request body.
 */
export async function addLine(db: Db, actor: Actor, billId: number, input: LineInput, labelPrice?: number): Promise<number> {
  require_(actor, 'order.add');
  if (!Number.isInteger(input.qty) || input.qty <= 0 || input.qty > MAX_LINE_QTY) throw new DomainError(`qty must be an integer from 1 to ${MAX_LINE_QTY}`, 422);
  if (!isId(input.productId)) throw new DomainError('productId is required', 422);
  if (input.weightG != null && (!Number.isInteger(input.weightG) || input.weightG <= 0 || input.weightG > MAX_WEIGHT_G)) throw new DomainError(`weightG must be whole grams from 1 to ${MAX_WEIGHT_G}`, 422);
  if (input.gift) {
    require_(actor, 'order.gift');
    if (!input.reason) throw new DomainError('gift requires a reason', 422);
  }
  return db.tx(async (t) => {
    const bill = await assertOpenBill(t, actor, billId);
    const p = await t.one('SELECT * FROM products WHERE id = ? AND store_id = ? AND active', [input.productId, actor.storeId]);
    if (!p) throw new DomainError('product not found', 404);
    const weighed = p.unit === 'kg';
    if (weighed && (input.weightG == null || input.qty !== 1)) throw new DomainError('this item is sold by weight: send qty 1 and weightG', 422);
    if (!weighed && input.weightG != null) throw new DomainError('weightG is only for items sold by weight', 422);
    let price = { unitPrice: p.price, note: null as string | null };
    if (labelPrice != null) price = { unitPrice: labelPrice, note: 'label' };
    else if (!input.gift) price = await priceFor(t, p, bill.member_id != null);
    const unitPrice = weighed && labelPrice == null ? linePrice(price.unitPrice, input.weightG!) : price.unitPrice;
    const lineId = await t.insert(
      `INSERT INTO bill_lines (bill_id, product_id, name, qty, unit_price, kind, reason, waiter_id, created_at, weight_g, price_note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [billId, p.id, p.name, input.qty, unitPrice, input.gift ? 'gift' : 'sale', input.reason ?? null, actor.id, Date.now(), input.weightG ?? null, price.note]);
    if (input.gift) await audit(t, whoOf(actor), 'order.gift', 'bill_line', lineId, { billId, productId: p.id, qty: input.qty, reason: input.reason });
    return lineId;
  });
}

/**
 * Puts a member on an open bill (a shopper shows their membership after the first items were scanned) and lowers any
 * line that is now cheaper for members. Prices never go up here, and scale-label prices stay as printed.
 */
export async function attachMember(db: Db, actor: Actor, billId: number, phone: string): Promise<void> {
  require_(actor, 'order.add');
  await db.tx(async (t) => {
    const bill = await assertOpenBill(t, actor, billId);
    if (bill.member_id != null) throw new DomainError('this bill already has a member', 409);
    const memberId = await getOrCreateMember(t, actor.tenantId, phone);
    await t.run('UPDATE bills SET member_id = ? WHERE id = ?', [memberId, billId]);
    if (bill.rep_id != null) await claimCustomer(t, memberId, Number(bill.rep_id));
    const lines = await t.all(
      `SELECT p.*, l.id AS line_id, l.unit_price AS line_price, l.weight_g FROM bill_lines l JOIN products p ON p.id = l.product_id
       WHERE l.bill_id = ? AND l.status = 'active' AND l.kind = 'sale' AND COALESCE(l.price_note, '') <> 'label'`, [billId]);
    for (const l of lines) {
      const price = await priceFor(t, l, true);
      const unitPrice = l.weight_g != null ? linePrice(price.unitPrice, l.weight_g) : price.unitPrice;
      if (unitPrice < l.line_price) await t.run('UPDATE bill_lines SET unit_price = ?, price_note = ? WHERE id = ?', [unitPrice, price.note, l.line_id]);
    }
    await audit(t, whoOf(actor), 'bill.member', 'bill', billId, { memberId });
  });
}

export async function voidLine(db: Db, actor: Actor, billId: number, lineId: number, reason: string): Promise<void> {
  require_(actor, 'order.void');
  if (!reason) throw new DomainError('void requires a reason', 422);
  await db.tx(async (t) => {
    await assertOpenBill(t, actor, billId);
    const n = await t.run("UPDATE bill_lines SET status = 'void', reason = ? WHERE id = ? AND bill_id = ? AND status = 'active'", [reason, lineId, billId]);
    if (n === 0) throw new DomainError('line not found or already void', 404);
    await audit(t, whoOf(actor), 'order.void', 'bill_line', lineId, { billId, reason });
    await reconcileAfterReduction(t, actor, billId);
  });
}

export async function setDiscount(db: Db, actor: Actor, billId: number, amount: number, reason: string): Promise<void> {
  require_(actor, 'bill.discount');
  if (!Number.isInteger(amount) || amount < 0) throw new DomainError('discount must be a non-negative integer (fen)', 422);
  if (!reason) throw new DomainError('discount requires a reason', 422);
  await db.tx(async (t) => {
    await assertOpenBill(t, actor, billId);
    await t.run('UPDATE bills SET discount = ? WHERE id = ?', [amount, billId]);
    await audit(t, whoOf(actor), 'bill.discount', 'bill', billId, { amount, reason });
    await reconcileAfterReduction(t, actor, billId);
  });
}

/** A void or discount may not leave the bill overpaid (there is no refund flow); landing exactly on the paid amount completes the bill. */
async function reconcileAfterReduction(t: Db, actor: Actor, billId: number): Promise<void> {
  const tot = await totals(t, billId);
  if (tot.paid > tot.total) throw new DomainError('this would drop the bill below what has already been paid', 409);
  if (tot.paid > 0 && tot.due === 0) await settleIfPaid(t, actor.id, billId);
}

export async function totals(db: Db, billId: number): Promise<BillTotals> {
  const bill = await db.one('SELECT * FROM bills WHERE id = ?', [billId]);
  const sub = await db.one("SELECT COALESCE(SUM(qty * unit_price),0) AS s FROM bill_lines WHERE bill_id = ? AND status = 'active' AND kind = 'sale'", [billId]);
  const paid = await db.one("SELECT COALESCE(SUM(amount),0) AS p FROM payments WHERE bill_id = ? AND status = 'paid'", [billId]);
  const topUp = Math.max(0, bill.min_spend - sub.s);
  const total = Math.max(0, sub.s + topUp + bill.table_fee - bill.discount);
  return { subtotal: sub.s, minSpendTopUp: topUp, tableFee: bill.table_fee, discount: bill.discount, total, paid: paid.p, due: Math.max(0, total - paid.p) };
}

export async function getBill(db: Db, actor: Actor, billId: number) {
  const bill = await db.one('SELECT b.*, m.phone AS member_phone, m.balance AS member_balance FROM bills b LEFT JOIN members m ON m.id = b.member_id WHERE b.id = ? AND b.store_id = ?', [billId, actor.storeId]);
  if (!bill) throw new DomainError('bill not found', 404);
  const lines = await db.all('SELECT * FROM bill_lines WHERE bill_id = ? ORDER BY id', [billId]);
  const payments = await db.all('SELECT * FROM payments WHERE bill_id = ? ORDER BY id', [billId]);
  return { bill, lines, payments, totals: await totals(db, billId) };
}

/**
 * Settles a fully-paid bill in ONE transaction: status, stock, commission, table release.
 * Called after every confirmed payment; a no-op until paid >= total. The row lock makes
 * two concurrent callbacks settle it exactly once.
 */
export async function settleIfPaid(db: Db, actorId: number | null, billId: number): Promise<boolean> {
  return db.tx(async (t) => {
    const bill = await t.one('SELECT * FROM bills WHERE id = ? FOR UPDATE', [billId]);
    if (!bill || bill.status !== 'open') return false;
    const tot = await totals(t, billId);
    if (tot.due > 0) return false;

    const lines = await t.all(
      "SELECT l.*, p.category, p.track_stock FROM bill_lines l JOIN products p ON p.id = l.product_id WHERE l.bill_id = ? AND l.status = 'active'", [billId]);
    for (const l of lines) {
      // A stash retrieval is a fraction of a bottle already stored (and already off the shelf), and its product may belong to
      // another store after a stash transfer; counting it as qty 1 here would drain whole bottles of the wrong store's stock.
      if (l.track_stock && !String(l.reason ?? '').startsWith('stash:')) {
        // Items sold by weight keep their stock in grams.
        const used = l.weight_g ?? l.qty;
        await t.run('UPDATE products SET stock = stock - ? WHERE id = ?', [used, l.product_id]);
        await t.run('INSERT INTO stock_movements (store_id, product_id, delta, reason, actor_id, ts) VALUES (?,?,?,?,?,?)', [bill.store_id, l.product_id, -used, `sale bill ${billId}`, actorId, Date.now()]);
      }
    }
    await writeCommission(t, bill, lines);
    await t.run("UPDATE bills SET status = 'settled', closed_at = ? WHERE id = ?", [Date.now(), billId]);
    if (bill.table_id) await t.run("UPDATE dining_tables SET status = 'free' WHERE id = ?", [bill.table_id]);
    if (bill.booking_id) await t.run("UPDATE bookings SET status = 'redeemed' WHERE id = ?", [bill.booking_id]);
    const tenant = await t.one('SELECT tenant_id FROM stores WHERE id = ?', [bill.store_id]);
    await audit(t, { tenantId: tenant.tenant_id, storeId: bill.store_id, actorId }, 'bill.settle', 'bill', billId, { total: tot.total });
    return true;
  });
}

async function writeCommission(t: Db, bill: any, lines: any[]): Promise<void> {
  const rules = await t.all('SELECT * FROM commission_rules WHERE store_id = ?', [bill.store_id]);
  const earned = new Map<string, number>();
  const add = (employeeId: number, role: string, amount: number) => {
    const key = `${employeeId}:${role}`;
    earned.set(key, (earned.get(key) ?? 0) + amount);
  };
  for (const l of lines.filter((x) => x.kind === 'sale')) {
    const base = l.qty * l.unit_price;
    // product rule beats category rule beats store default
    const pick = (role: string) =>
      rules.find((r) => r.role === role && r.product_id === l.product_id) ??
      rules.find((r) => r.role === role && r.product_id == null && r.category === l.category) ??
      rules.find((r) => r.role === role && r.product_id == null && r.category == null);
    const sales = pick('sales');
    if (sales) add(bill.rep_id, 'sales', Math.floor((base * sales.bps) / 10000) + sales.fixed * l.qty);
    const waiter = pick('waiter');
    if (waiter && l.waiter_id) add(l.waiter_id, 'waiter', Math.floor((base * waiter.bps) / 10000) + waiter.fixed * l.qty);
  }
  const now = Date.now();
  for (const [key, amount] of earned) {
    if (amount <= 0) continue;
    const [employeeId, role] = key.split(':');
    await t.run('INSERT INTO commission_entries (bill_id, store_id, employee_id, role, amount, ts) VALUES (?,?,?,?,?,?)', [bill.id, bill.store_id, Number(employeeId), role, amount, now]);
  }
}

/** Store-scoped by default; owner/finance can pass allStores to roll up the whole tenant. */
export async function payrollSummary(db: Db, actor: Actor, fromTs: number, toTs: number, allStores = false) {
  require_(actor, 'payroll.read');
  return db.all(
    `SELECT e.id AS "employeeId", e.name, c.role, c.store_id AS "storeId", SUM(c.amount) AS commission, COUNT(DISTINCT c.bill_id) AS bills
     FROM commission_entries c JOIN employees e ON e.id = c.employee_id JOIN stores s ON s.id = c.store_id
     WHERE s.tenant_id = ? AND (? OR c.store_id = ?) AND c.ts >= ? AND c.ts < ?
     GROUP BY e.id, e.name, c.role, c.store_id ORDER BY commission DESC`, [actor.tenantId, allStores, actor.storeId, fromTs, toTs]);
}

/** Moves an open bill (转台) to another free table of the same store; the old table is released. */
export async function transferTable(db: Db, actor: Actor, billId: number, toTableId: number): Promise<void> {
  require_(actor, "table.open");
  await db.tx(async (t) => {
    const bill = await t.one("SELECT * FROM bills WHERE id = ? AND store_id = ? FOR UPDATE", [billId, actor.storeId]);
    if (!bill) throw new DomainError("bill not found", 404);
    if (bill.status !== "open") throw new DomainError(`bill is ${bill.status}`, 409);
    if (bill.table_id == null) throw new DomainError("this sale is not on a table", 409);
    if (bill.table_id === toTableId) throw new DomainError("already on that table", 409);
    const to = await t.one("SELECT * FROM dining_tables WHERE id = ? AND store_id = ? AND active FOR UPDATE", [toTableId, actor.storeId]);
    if (!to) throw new DomainError("table not found", 404);
    if (to.status !== "free") throw new DomainError("target table is not free", 409);
    await t.run("UPDATE bills SET table_id = ? WHERE id = ?", [toTableId, billId]);
    await t.run("UPDATE dining_tables SET status = 'free' WHERE id = ?", [bill.table_id]);
    await t.run("UPDATE dining_tables SET status = 'occupied' WHERE id = ?", [toTableId]);
    await audit(t, whoOf(actor), "table.transfer", "bill", billId, { from: bill.table_id, to: toTableId });
  });
}
