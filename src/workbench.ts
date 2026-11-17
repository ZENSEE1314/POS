// Workbench (工作台): today's numbers for the person signed in, and sales performance by department and by person
// (业绩) for managers. Sales are the sale lines of settled bills a person was the sales rep on.
import type { Db } from './db.ts';
import type { Actor } from './auth.ts';
import { require_ } from './auth.ts';
import { myComps } from './comps.ts';

const DAY_MS = 86_400_000;
/** The night does not end at midnight: a venue's "today" starts at 6 am. */
const BUSINESS_DAY_START_HOUR = 6;

export function businessDayStart(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(BUSINESS_DAY_START_HOUR, 0, 0, 0);
  return d.getTime() > now ? d.getTime() - DAY_MS : d.getTime();
}

const SALES_BY_REP = `SELECT b.rep_id AS id, COUNT(DISTINCT b.id) AS tables,
    COALESCE(SUM(l.qty * l.unit_price) FILTER (WHERE l.kind = 'sale' AND l.status = 'active'), 0) AS sales,
    COALESCE(SUM(l.qty * l.unit_price) FILTER (WHERE l.kind = 'gift' AND l.status = 'active'), 0) AS comps
  FROM bills b LEFT JOIN bill_lines l ON l.bill_id = b.id
  WHERE b.store_id = ANY(?) AND b.status = 'settled' AND b.closed_at >= ? AND b.closed_at < ? GROUP BY b.rep_id`;

async function storesOf(db: Db, actor: Actor, all: boolean): Promise<number[]> {
  if (!all) return [actor.storeId];
  const rows = await db.all('SELECT id FROM stores WHERE tenant_id = ?', [actor.tenantId]);
  return rows.map((r) => Number(r.id));
}

export async function myToday(db: Db, actor: Actor) {
  const from = businessDayStart();
  const to = Date.now() + 1;
  const [sales, commission, tips, open, bookings, comps] = await Promise.all([
    db.one(`SELECT * FROM (${SALES_BY_REP}) s WHERE s.id = ?`, [[actor.storeId], from, to, actor.id]),
    db.one('SELECT COALESCE(SUM(amount), 0) AS v FROM commission_entries WHERE employee_id = ? AND ts >= ?', [actor.id, from]),
    db.one('SELECT COALESCE(SUM(amount), 0) AS v FROM tips WHERE employee_id = ? AND created_at >= ?', [actor.id, from]),
    db.one("SELECT COUNT(*) AS n FROM bills WHERE rep_id = ? AND status = 'open'", [actor.id]),
    db.one("SELECT COUNT(*) AS n FROM bookings WHERE rep_id = ? AND status IN ('submitted','confirmed') AND eta >= ? AND eta < ?", [actor.id, from, from + DAY_MS]),
    myComps(db, actor),
  ]);
  return {
    from, sales: Number(sales?.sales ?? 0), tables: Number(sales?.tables ?? 0), openTables: Number(open.n),
    commission: Number(commission.v), tips: Number(tips.v), bookings: Number(bookings.n), comps,
  };
}

export async function performance(db: Db, actor: Actor, fromTs: number, toTs: number, all: boolean) {
  require_(actor, 'audit.read');
  const stores = await storesOf(db, actor, all && ['owner', 'finance'].includes(actor.role));
  const [people, sales, commission, tips] = await Promise.all([
    db.all(`SELECT e.id, e.name, e.role, d.id AS dept_id, d.name AS dept_name FROM employees e LEFT JOIN departments d ON d.id = e.department_id
      WHERE e.tenant_id = ?`, [actor.tenantId]),
    db.all(SALES_BY_REP, [stores, fromTs, toTs]),
    db.all('SELECT employee_id AS id, SUM(amount) AS v FROM commission_entries WHERE store_id = ANY(?) AND ts >= ? AND ts < ? GROUP BY employee_id', [stores, fromTs, toTs]),
    db.all('SELECT employee_id AS id, SUM(amount) AS v FROM tips WHERE store_id = ANY(?) AND created_at >= ? AND created_at < ? GROUP BY employee_id', [stores, fromTs, toTs]),
  ]);
  const by = (rows: any[]) => new Map(rows.map((r) => [Number(r.id), r]));
  const salesBy = by(sales);
  const commBy = by(commission);
  const tipsBy = by(tips);
  const staff = people.map((p) => {
    const s = salesBy.get(Number(p.id));
    return {
      employeeId: Number(p.id), name: p.name, role: p.role, departmentId: p.dept_id === null ? null : Number(p.dept_id), departmentName: p.dept_name ?? null,
      sales: Number(s?.sales ?? 0), tables: Number(s?.tables ?? 0), comps: Number(s?.comps ?? 0),
      commission: Number(commBy.get(Number(p.id))?.v ?? 0), tips: Number(tipsBy.get(Number(p.id))?.v ?? 0),
    };
  }).filter((p) => p.sales || p.tables || p.commission || p.tips).sort((a, b) => b.sales - a.sales);

  const depts = new Map<string, { departmentId: number | null; name: string | null; sales: number; tables: number; commission: number; tips: number; people: number }>();
  for (const p of staff) {
    const key = String(p.departmentId);
    const d = depts.get(key) ?? { departmentId: p.departmentId, name: p.departmentName, sales: 0, tables: 0, commission: 0, tips: 0, people: 0 };
    d.sales += p.sales; d.tables += p.tables; d.commission += p.commission; d.tips += p.tips; d.people += 1;
    depts.set(key, d);
  }
  const total = staff.reduce((a, p) => ({ sales: a.sales + p.sales, tables: a.tables + p.tables, commission: a.commission + p.commission, tips: a.tips + p.tips }),
    { sales: 0, tables: 0, commission: 0, tips: 0 });
  return { total, departments: [...depts.values()].sort((a, b) => b.sales - a.sales), staff };
}
