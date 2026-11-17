// Host desk (咨客台): every table at a glance for the person at the door. Who is sitting there, which sales rep and
// department brought them, how much they have spent against the minimum and what is still short (低差), tonight's
// bookings, and tables held back (locked) for a guest who is on the way.
import type { Db } from './db.ts';
import { audit, DomainError } from './db.ts';
import type { Actor } from './auth.ts';
import { require_, whoOf } from './auth.ts';

const HOUR_MS = 3_600_000;
/** Bookings shown: from a few hours ago (late arrivals) to the end of the night. */
const BOOKINGS_BEFORE_MS = 4 * HOUR_MS;
const BOOKINGS_AFTER_MS = 18 * HOUR_MS;
const MAX_NOTE = 60;

const maskPhone = (p: string | null) => (p ? `${p.slice(0, 3)}****${p.slice(-4)}` : null);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function hostDesk(db: Db, actor: Actor) {
  require_(actor, 'table.open');
  const now = Date.now();
  const [tables, bills, bookings] = await Promise.all([
    db.all(`SELECT t.id, t.name, t.zone, t.kind, t.capacity, t.min_spend, t.status, t.locked_at, t.lock_note, l.name AS locked_by
      FROM dining_tables t LEFT JOIN employees l ON l.id = t.locked_by WHERE t.store_id = ? AND t.active ORDER BY t.zone, t.name`, [actor.storeId]),
    db.all(`SELECT b.id, b.table_id, b.opened_at, b.min_spend, r.name AS rep_name, d.name AS dept_name, m.name AS guest_name, m.phone AS guest_phone,
        (SELECT COALESCE(SUM(qty * unit_price), 0) FROM bill_lines WHERE bill_id = b.id AND status = 'active' AND kind = 'sale') AS spent,
        (SELECT COALESCE(SUM(qty), 0) FROM bill_lines WHERE bill_id = b.id AND status = 'active') AS items
      FROM bills b JOIN employees r ON r.id = b.rep_id LEFT JOIN departments d ON d.id = r.department_id LEFT JOIN members m ON m.id = b.member_id
      WHERE b.store_id = ? AND b.status = 'open' AND b.table_id IS NOT NULL`, [actor.storeId]),
    db.all(`SELECT k.id, k.table_id, k.name, k.phone, k.party_size, k.eta, k.status, r.name AS rep_name
      FROM bookings k LEFT JOIN employees r ON r.id = k.rep_id
      WHERE k.store_id = ? AND k.status IN ('submitted','confirmed') AND k.eta BETWEEN ? AND ? ORDER BY k.eta`,
    [actor.storeId, now - BOOKINGS_BEFORE_MS, now + BOOKINGS_AFTER_MS]),
  ]);
  const billOf = new Map(bills.map((b) => [Number(b.table_id), b]));
  const bookingView = (k: any) => ({ id: Number(k.id), name: k.name, phone: maskPhone(k.phone), partySize: Number(k.party_size), eta: Number(k.eta), status: k.status, repName: k.rep_name ?? null });
  const bookingsOf = new Map<number, ReturnType<typeof bookingView>[]>();
  for (const k of bookings) if (k.table_id !== null) bookingsOf.set(Number(k.table_id), [...(bookingsOf.get(Number(k.table_id)) ?? []), bookingView(k)]);

  const rows = tables.map((t) => {
    const b = billOf.get(Number(t.id));
    const spent = b ? Number(b.spent) : 0;
    const minSpend = b ? Number(b.min_spend) : Number(t.min_spend);
    return {
      id: Number(t.id), name: t.name, zone: t.zone, kind: t.kind, capacity: Number(t.capacity), minSpend,
      state: b ? 'open' : t.locked_at ? 'locked' : bookingsOf.has(Number(t.id)) ? 'booked' : 'free',
      lock: t.locked_at ? { at: Number(t.locked_at), by: t.locked_by, note: t.lock_note } : null,
      bill: b ? {
        id: Number(b.id), openedAt: Number(b.opened_at), spent, shortfall: Math.max(0, minSpend - spent), items: Number(b.items),
        repName: b.rep_name, departmentName: b.dept_name ?? null, guestName: b.guest_name || null, guestPhone: maskPhone(b.guest_phone),
      } : null,
      bookings: bookingsOf.get(Number(t.id)) ?? [],
    };
  });
  const open = rows.filter((r) => r.bill);
  return {
    tables: rows,
    unassigned: bookings.filter((k) => k.table_id === null).map(bookingView),
    summary: {
      open: open.length, free: rows.filter((r) => r.state === 'free').length, booked: rows.filter((r) => r.state === 'booked').length,
      locked: rows.filter((r) => r.state === 'locked').length, spent: open.reduce((a, r) => a + r.bill!.spent, 0),
      shortfall: open.reduce((a, r) => a + r.bill!.shortfall, 0), at: now,
    },
  };
}

/** Holds a free table for a guest on the way (锁台): nobody can open it until it is unlocked or opened from its booking. */
export async function setTableLock(db: Db, actor: Actor, tableId: number, b: Record<string, unknown>): Promise<void> {
  require_(actor, 'booking.create');
  const locked = b.locked === true;
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, MAX_NOTE) : '';
  await db.tx(async (t) => {
    const table = await t.one('SELECT * FROM dining_tables WHERE id = ? AND store_id = ? AND active FOR UPDATE', [tableId, actor.storeId]);
    if (!table) throw new DomainError('table not found', 404);
    if (locked && table.status === 'occupied') throw new DomainError('this table is in use', 409);
    await t.run('UPDATE dining_tables SET locked_at = ?, locked_by = ?, lock_note = ? WHERE id = ?',
      locked ? [Date.now(), actor.id, note, tableId] : [null, null, '', tableId]);
    await audit(t, whoOf(actor), locked ? 'table.lock' : 'table.unlock', 'table', tableId, { note });
  });
}

/** Called inside openTable: a locked table opens only from a booking for that very table, and the lock is then lifted. */
export async function releaseLockForOpen(t: Db, table: { id: number; locked_at: unknown }, bookingTableId: number | null): Promise<void> {
  if (num(table.locked_at) === null) return;
  if (bookingTableId !== Number(table.id)) throw new DomainError('this table is locked for a guest; unlock it first', 409);
  await t.run("UPDATE dining_tables SET locked_at = NULL, locked_by = NULL, lock_note = '' WHERE id = ?", [table.id]);
}
