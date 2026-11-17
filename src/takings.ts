// Money that is not a sale: tips and rewards (小费 / 打赏) a guest gives a staff member or performer, and deposits
// (预收款 / 押金) taken before or on arrival that are later put toward the bill or handed back.
import type { Db } from './db.ts';
import { audit, DomainError } from './db.ts';
import type { Actor } from './auth.ts';
import { require_, whoOf } from './auth.ts';
import { normalizePhone } from './phone.ts';
import { settleIfPaid } from './bills.ts';

export const TIP_KINDS = ['tip', 'reward'] as const;
export const TAKING_METHODS = ['cash', 'wechat', 'alipay', 'card', 'other'] as const;
const MAX_AMOUNT_FEN = 100_000_000;
const MAX_NOTE = 120;
const LIST_LIMIT = 300;

const amountOf = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0 || n > MAX_AMOUNT_FEN) throw new DomainError('amount must be a positive whole number of fen', 422);
  return n;
};
const methodOf = (v: unknown): string => {
  if (!(TAKING_METHODS as readonly unknown[]).includes(v)) throw new DomainError(`method must be one of ${TAKING_METHODS.join(', ')}`, 422);
  return v as string;
};
const note = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, MAX_NOTE) : '');

async function storeEmployee(t: Db, actor: Actor, id: unknown): Promise<number> {
  const e = await t.one('SELECT id FROM employees WHERE id = ? AND tenant_id = ? AND active AND (store_id = ? OR store_id IS NULL)', [Number(id), actor.tenantId, actor.storeId]);
  if (!e) throw new DomainError('staff member not found', 404);
  return Number(e.id);
}

async function openTableBill(t: Db, actor: Actor, tableId: unknown): Promise<number | null> {
  if (tableId === undefined || tableId === null || tableId === '') return null;
  const b = await t.one("SELECT id FROM bills WHERE table_id = ? AND store_id = ? AND status = 'open'", [Number(tableId), actor.storeId]);
  return b ? Number(b.id) : null;
}

// ---------- tips and rewards ----------

export async function recordTip(db: Db, actor: Actor, b: Record<string, unknown>): Promise<number> {
  require_(actor, 'order.add');
  const kind = (TIP_KINDS as readonly unknown[]).includes(b.kind) ? b.kind as string : 'tip';
  return db.tx(async (t) => {
    const employeeId = await storeEmployee(t, actor, b.employeeId);
    const billId = await openTableBill(t, actor, b.tableId);
    const id = await t.insert(`INSERT INTO tips (tenant_id, store_id, employee_id, bill_id, kind, amount, method, note, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [actor.tenantId, actor.storeId, employeeId, billId, kind, amountOf(b.amount), methodOf(b.method ?? 'cash'), note(b.note), actor.id, Date.now()]);
    await audit(t, whoOf(actor), `tip.${kind}`, 'tip', id, { employeeId, amount: b.amount });
    return id;
  });
}

export async function listTips(db: Db, actor: Actor, fromTs: number, toTs: number) {
  require_(actor, 'audit.read');
  const rows = await db.all(`SELECT p.*, e.name AS employee_name, c.name AS by_name, d.name AS table_name FROM tips p
    JOIN employees e ON e.id = p.employee_id JOIN employees c ON c.id = p.created_by
    LEFT JOIN bills b ON b.id = p.bill_id LEFT JOIN dining_tables d ON d.id = b.table_id
    WHERE p.store_id = ? AND p.created_at >= ? AND p.created_at < ? ORDER BY p.created_at DESC LIMIT ${LIST_LIMIT}`, [actor.storeId, fromTs, toTs]);
  return rows.map((r) => ({ id: Number(r.id), employeeId: Number(r.employee_id), employeeName: r.employee_name, kind: r.kind, amount: Number(r.amount),
    method: r.method, note: r.note, tableName: r.table_name ?? null, byName: r.by_name, createdAt: Number(r.created_at) }));
}

// ---------- deposits ----------

export async function takeDeposit(db: Db, actor: Actor, b: Record<string, unknown>): Promise<number> {
  require_(actor, 'booking.create');
  const phone = normalizePhone(b.phone ?? '');
  const name = note(b.name);
  if (!phone && !name) throw new DomainError('enter the guest name or phone', 422);
  return db.tx(async (t) => {
    let tableId: number | null = null;
    if (b.tableId !== undefined && b.tableId !== null && b.tableId !== '') {
      const tb = await t.one('SELECT id FROM dining_tables WHERE id = ? AND store_id = ?', [Number(b.tableId), actor.storeId]);
      if (!tb) throw new DomainError('table not found', 404);
      tableId = Number(tb.id);
    }
    const id = await t.insert(`INSERT INTO deposits (tenant_id, store_id, table_id, name, phone, amount, method, note, status, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,'held',?,?)`, [actor.tenantId, actor.storeId, tableId, name, phone, amountOf(b.amount), methodOf(b.method ?? 'cash'), note(b.note), actor.id, Date.now()]);
    await audit(t, whoOf(actor), 'deposit.take', 'deposit', id, { amount: b.amount, tableId });
    return id;
  });
}

export async function listDeposits(db: Db, actor: Actor, status: string) {
  require_(actor, 'booking.create');
  const held = status !== 'closed';
  const rows = await db.all(`SELECT p.*, d.name AS table_name, c.name AS by_name FROM deposits p
    LEFT JOIN dining_tables d ON d.id = p.table_id JOIN employees c ON c.id = p.created_by
    WHERE p.store_id = ? AND ${held ? "p.status = 'held'" : "p.status <> 'held'"} ORDER BY p.created_at DESC LIMIT ${LIST_LIMIT}`, [actor.storeId]);
  return rows.map((r) => ({ id: Number(r.id), tableId: r.table_id === null ? null : Number(r.table_id), tableName: r.table_name ?? null, name: r.name,
    phone: r.phone, amount: Number(r.amount), method: r.method, note: r.note, status: r.status, billId: r.bill_id === null ? null : Number(r.bill_id),
    byName: r.by_name, createdAt: Number(r.created_at), closedAt: r.closed_at === null ? null : Number(r.closed_at) }));
}

async function heldDeposit(t: Db, actor: Actor, id: number) {
  const d = await t.one("SELECT * FROM deposits WHERE id = ? AND store_id = ? AND status = 'held' FOR UPDATE", [id, actor.storeId]);
  if (!d) throw new DomainError('deposit not found or already used', 404);
  return d;
}

/** Puts a deposit toward an open bill as a payment; anything above what the bill still owes stays as a smaller deposit. */
export async function applyDeposit(db: Db, actor: Actor, id: number, billIdInput: unknown): Promise<{ applied: number; settled: boolean }> {
  require_(actor, 'bill.settle');
  const result = await db.tx(async (t) => {
    const d = await heldDeposit(t, actor, id);
    const billId = Number(billIdInput ?? 0) || await openTableBill(t, actor, d.table_id);
    const bill = billId ? await t.one("SELECT id FROM bills WHERE id = ? AND store_id = ? AND status = 'open' FOR UPDATE", [billId, actor.storeId]) : null;
    if (!bill) throw new DomainError('no open bill to put the deposit toward', 409);
    const owed = await t.one(`SELECT
        GREATEST(COALESCE((SELECT SUM(qty * unit_price) FROM bill_lines WHERE bill_id = b.id AND status = 'active' AND kind = 'sale'), 0), b.min_spend)
        + b.table_fee - b.discount - COALESCE((SELECT SUM(amount) FROM payments WHERE bill_id = b.id AND status = 'paid'), 0) AS due
      FROM bills b WHERE b.id = ?`, [bill.id]);
    const applied = Math.min(Number(d.amount), Math.max(0, Number(owed.due)));
    if (applied <= 0) throw new DomainError('this bill has nothing left to pay', 409);
    await t.run("INSERT INTO payments (bill_id, method, amount, status, created_at, paid_at) VALUES (?, 'deposit', ?, 'paid', ?, ?)", [bill.id, applied, Date.now(), Date.now()]);
    const rest = Number(d.amount) - applied;
    await t.run("UPDATE deposits SET status = 'applied', bill_id = ?, amount = ?, closed_at = ?, closed_by = ? WHERE id = ?", [bill.id, applied, Date.now(), actor.id, id]);
    if (rest > 0) {
      await t.insert(`INSERT INTO deposits (tenant_id, store_id, table_id, name, phone, amount, method, note, status, created_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,'held',?,?)`, [d.tenant_id, d.store_id, d.table_id, d.name, d.phone, rest, d.method, `rest of #${id}`, actor.id, Date.now()]);
    }
    await audit(t, whoOf(actor), 'deposit.apply', 'deposit', id, { billId: bill.id, amount: applied });
    return { billId: Number(bill.id), applied };
  });
  const settled = await settleIfPaid(db, actor.id, result.billId);
  return { applied: result.applied, settled };
}

export async function refundDeposit(db: Db, actor: Actor, id: number, reason: unknown): Promise<void> {
  require_(actor, 'bill.settle');
  const why = note(reason);
  if (!why) throw new DomainError('say why the deposit is handed back', 422);
  await db.tx(async (t) => {
    await heldDeposit(t, actor, id);
    await t.run("UPDATE deposits SET status = 'refunded', note = ?, closed_at = ?, closed_by = ? WHERE id = ?", [why, Date.now(), actor.id, id]);
    await audit(t, whoOf(actor), 'deposit.refund', 'deposit', id, { reason: why });
  });
}
