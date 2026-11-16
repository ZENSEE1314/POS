import type { Db } from './db.ts';
import type { Actor } from './auth.ts';
import { can, require_ } from './auth.ts';

const PAGE = 100;
/** Pay rates are for finance and the owner only, even though managers can read the rest of the log. */
const PAY_ACTIONS = new Set(['staff.pay']);

export interface ActivityFilter { from?: number; to?: number; staffId?: number; action?: string; before?: number; all?: boolean }

function parseDetail(raw: string | null): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

/** The audit trail with staff names, newest first, 100 at a time (pass `before` = the last id for more). */
export async function listActivity(db: Db, actor: Actor, f: ActivityFilter) {
  require_(actor, 'audit.read');
  const wide = Boolean(f.all) && can(actor, 'hq.read');
  const where = ['a.tenant_id = ?', '(? OR a.store_id = ?)'];
  const params: unknown[] = [actor.tenantId, wide, actor.storeId];
  if (f.from !== undefined) { where.push('a.ts >= ?'); params.push(f.from); }
  if (f.to !== undefined) { where.push('a.ts < ?'); params.push(f.to); }
  if (f.staffId !== undefined) { where.push('a.actor_id = ?'); params.push(f.staffId); }
  // "order" matches order.void and order.gift; the prefix is escaped so % and _ are literal.
  if (f.action) { where.push("a.action LIKE ? ESCAPE '\\'"); params.push(`${f.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
  if (f.before !== undefined) { where.push('a.id < ?'); params.push(f.before); }
  const rows = await db.all(
    `SELECT a.id, a.ts, a.actor_id AS "staffId", e.name AS "staffName", a.store_id AS "storeId", s.name AS "storeName",
            a.action, a.entity, a.entity_id AS "entityId", a.detail
     FROM audit a LEFT JOIN employees e ON e.id = a.actor_id LEFT JOIN stores s ON s.id = a.store_id
     WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ${PAGE + 1}`, params);
  const seesPay = can(actor, 'payroll.read');
  const page = rows.slice(0, PAGE).map((r) => ({ ...r, detail: PAY_ACTIONS.has(r.action) && !seesPay ? null : parseDetail(r.detail) }));
  return { rows: page, next: rows.length > PAGE ? page[page.length - 1].id : null };
}
