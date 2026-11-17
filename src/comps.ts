// Comps (签送): staff who are not managers may give drinks away up to a monthly allowance set per person, so a sales rep
// can treat a good customer without calling the manager every time, and the boss still sees and caps it.
import type { Db } from './db.ts';
import { audit, DomainError } from './db.ts';
import type { Actor } from './auth.ts';
import { can, require_, whoOf } from './auth.ts';

/** 1 million yuan in fen: far above any real allowance. */
const MAX_ALLOWANCE_FEN = 100_000_000;

export function monthStart(now = Date.now()): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/** Value of everything this person comped this month, at list price. */
async function usedThisMonth(t: Db, employeeId: number): Promise<number> {
  const r = await t.one(`SELECT COALESCE(SUM(qty * unit_price), 0) AS v FROM bill_lines
    WHERE waiter_id = ? AND kind = 'gift' AND status = 'active' AND created_at >= ? AND COALESCE(reason, '') NOT LIKE 'stash:%'`, [employeeId, monthStart()]);
  return Number(r.v);
}

export async function myComps(db: Db, actor: Actor) {
  const e = await db.one('SELECT comp_allowance FROM employees WHERE id = ?', [actor.id]);
  const used = await usedThisMonth(db, actor.id);
  const unlimited = can(actor, 'order.gift');
  return { unlimited, allowance: Number(e?.comp_allowance ?? 0), used, left: unlimited ? null : Math.max(0, Number(e?.comp_allowance ?? 0) - used) };
}

/** Up-front refusal for someone who may never comp, so they get a 403 before any other check on the line. */
export async function assertMayComp(db: Db, actor: Actor): Promise<void> {
  if (can(actor, 'order.gift')) return;
  const e = await db.one('SELECT comp_allowance FROM employees WHERE id = ?', [actor.id]);
  if (Number(e?.comp_allowance ?? 0) <= 0) throw new DomainError('you have no comp allowance; ask a manager', 403);
}

/**
 * Called by addLine for a gift line. Managers may always comp; anyone else needs allowance left for the whole line.
 * Runs inside the line's transaction and locks the employee row so two quick comps cannot both squeeze under the cap.
 */
export async function assertCompAllowed(t: Db, actor: Actor, value: number): Promise<void> {
  if (can(actor, 'order.gift')) return;
  const e = await t.one('SELECT comp_allowance FROM employees WHERE id = ? FOR UPDATE', [actor.id]);
  const allowance = Number(e?.comp_allowance ?? 0);
  if (allowance <= 0) throw new DomainError('you have no comp allowance; ask a manager', 403);
  const used = await usedThisMonth(t, actor.id);
  if (used + value > allowance) throw new DomainError(`not enough comp allowance left this month (${Math.max(0, allowance - used)} fen left)`, 403);
}

export async function compAllowances(db: Db, actor: Actor) {
  require_(actor, 'admin.write');
  const rows = await db.all(`SELECT e.id, e.name, e.role, e.comp_allowance,
      (SELECT COALESCE(SUM(l.qty * l.unit_price), 0) FROM bill_lines l WHERE l.waiter_id = e.id AND l.kind = 'gift' AND l.status = 'active'
        AND l.created_at >= ? AND COALESCE(l.reason, '') NOT LIKE 'stash:%') AS used
    FROM employees e WHERE e.tenant_id = ? AND e.active AND (e.store_id = ? OR e.store_id IS NULL) ORDER BY e.name`, [monthStart(), actor.tenantId, actor.storeId]);
  return rows.map((r) => ({ employeeId: Number(r.id), name: r.name, role: r.role, unlimited: ['manager', 'owner'].includes(r.role),
    allowance: Number(r.comp_allowance), used: Number(r.used) }));
}

export async function setCompAllowance(db: Db, actor: Actor, employeeId: number, amount: unknown): Promise<void> {
  require_(actor, 'admin.write');
  const fen = Number(amount);
  if (!Number.isSafeInteger(fen) || fen < 0 || fen > MAX_ALLOWANCE_FEN) throw new DomainError('allowance must be a whole number of fen', 422);
  const changed = await db.run('UPDATE employees SET comp_allowance = ? WHERE id = ? AND tenant_id = ?', [fen, employeeId, actor.tenantId]);
  if (!changed) throw new DomainError('staff member not found', 404);
  await audit(db, whoOf(actor), 'staff.comp_allowance', 'employee', employeeId, { amount: fen });
}
