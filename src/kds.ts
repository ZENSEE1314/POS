// Bar / kitchen display (出品台): every drink and dish ordered on an open bill, oldest first, grouped by table, until
// the bar marks it made. Replaces shouting and paper for venues that put a screen behind the bar.
import type { Db } from './db.ts';
import { audit, DomainError } from './db.ts';
import type { Actor } from './auth.ts';
import { require_, whoOf } from './auth.ts';

export const KDS_STATIONS = ['all', 'bar', 'kitchen'] as const;
type Station = typeof KDS_STATIONS[number];
/** Made items stay on a "just served" strip this long, so a mistaken tap can be undone. */
const RECENT_MS = 30 * 60_000;
const RECENT_LIMIT = 30;

// Products without a station are drinks for the bar: most bars never set one.
const stationSql = (s: Station) => (s === 'kitchen' ? "AND p.station = 'kitchen'" : s === 'bar' ? "AND p.station IN ('', 'bar')" : '');

export async function kdsQueue(db: Db, actor: Actor, station: string) {
  require_(actor, 'order.add');
  if (!(KDS_STATIONS as readonly string[]).includes(station)) throw new DomainError('station must be all, bar or kitchen', 422);
  const where = stationSql(station as Station);
  const select = `SELECT l.id, l.bill_id, l.name, l.qty, l.kind, l.created_at, l.served_at, b.channel, t.name AS table_name, w.name AS waiter_name
    FROM bill_lines l JOIN bills b ON b.id = l.bill_id JOIN products p ON p.id = l.product_id
    LEFT JOIN dining_tables t ON t.id = b.table_id LEFT JOIN employees w ON w.id = l.waiter_id
    WHERE b.store_id = ? AND l.status = 'active' AND l.kind IN ('sale','gift') ${where}`;
  const now = Date.now();
  const [pending, recent] = await Promise.all([
    db.all(`${select} AND b.status = 'open' AND l.served_at IS NULL ORDER BY l.created_at, l.id`, [actor.storeId]),
    db.all(`${select} AND l.served_at >= ? ORDER BY l.served_at DESC LIMIT ?`, [actor.storeId, now - RECENT_MS, RECENT_LIMIT]),
  ]);
  const view = (l: any) => ({
    id: Number(l.id), billId: Number(l.bill_id), name: l.name, qty: Number(l.qty), gift: l.kind === 'gift',
    orderedAt: Number(l.created_at), servedAt: l.served_at === null ? null : Number(l.served_at),
    place: l.table_name ?? `${l.channel} #${l.bill_id}`, waiter: l.waiter_name ?? null,
  });
  const tickets = new Map<number, { billId: number; place: string; since: number; items: ReturnType<typeof view>[] }>();
  for (const l of pending.map(view)) {
    const tk = tickets.get(l.billId) ?? { billId: l.billId, place: l.place, since: l.orderedAt, items: [] };
    tk.items.push(l);
    tickets.set(l.billId, tk);
  }
  return { station, at: now, tickets: [...tickets.values()], recent: recent.map(view) };
}

/** Marks lines made (served) or, with `served: false`, puts them back on the screen. */
export async function setServed(db: Db, actor: Actor, b: Record<string, unknown>): Promise<number> {
  require_(actor, 'order.add');
  const ids = Array.isArray(b.lineIds) ? b.lineIds.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!ids.length) throw new DomainError('lineIds is required', 422);
  const served = b.served !== false;
  return db.tx(async (t) => {
    let changed = 0;
    for (const id of ids) {
      changed += await t.run(
        `UPDATE bill_lines SET served_at = ?, served_by = ? WHERE id = ? AND status = 'active'
           AND bill_id IN (SELECT id FROM bills WHERE store_id = ?)`,
        served ? [Date.now(), actor.id, id, actor.storeId] : [null, null, id, actor.storeId]);
    }
    if (!changed) throw new DomainError('no such items on this store', 404);
    await audit(t, whoOf(actor), served ? 'kds.serve' : 'kds.recall', 'bill_line', ids[0], { lineIds: ids });
    return changed;
  });
}
