import type { Db } from '../db.ts';
import { audit, DomainError } from '../db.ts';
import type { Actor } from '../auth.ts';
import { require_, whoOf } from '../auth.ts';
import { requireFeature } from './settings.ts';
import { int, tenantByCode, text } from './venue.ts';

const MAX_TITLE = 100;
const MAX_DESCRIPTION = 1000;
const LIST_LIMIT = 50;
const PAST_DAYS_SHOWN = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const EVENT_COLUMNS = `e.id, e.title, e.title_en AS "titleEn", e.description, e.starts_at AS "startsAt", e.ends_at AS "endsAt", e.active`;

/** Upcoming and running events at every location of a company, soonest first. */
export async function upcomingEvents(db: Db, company: string) {
  const t0 = await tenantByCode(db, company);
  await requireFeature(db, t0.id, 'events');
  return db.all(
    `SELECT ${EVENT_COLUMNS}, s.name AS "storeName", s.code AS "storeCode" FROM venue_events e JOIN stores s ON s.id = e.store_id
     WHERE s.tenant_id = ? AND s.active AND e.active AND e.ends_at >= ? ORDER BY e.starts_at LIMIT ?`, [t0.id, Date.now(), LIST_LIMIT]);
}

export function listEvents(db: Db, actor: Actor) {
  require_(actor, 'admin.write');
  return db.all(`SELECT ${EVENT_COLUMNS} FROM venue_events e WHERE e.store_id = ? AND e.ends_at >= ? ORDER BY e.starts_at DESC LIMIT ?`,
    [actor.storeId, Date.now() - PAST_DAYS_SHOWN * DAY_MS, LIST_LIMIT]);
}

export async function saveEvent(db: Db, actor: Actor, id: number | null, b: Record<string, unknown>): Promise<{ id: number }> {
  require_(actor, 'admin.write');
  const title = text(b.title, 'title', MAX_TITLE);
  if (!title) throw new DomainError('title is required', 422);
  const startsAt = int(b.startsAt, 'startsAt', 0, Number.MAX_SAFE_INTEGER);
  const endsAt = int(b.endsAt, 'endsAt', 0, Number.MAX_SAFE_INTEGER);
  if (endsAt <= startsAt) throw new DomainError('the event must end after it starts', 422);
  const row = { title, titleEn: text(b.titleEn, 'titleEn', MAX_TITLE), description: text(b.description, 'description', MAX_DESCRIPTION), startsAt, endsAt, active: b.active !== false };
  if (id === null) {
    const newId = await db.insert('INSERT INTO venue_events (store_id, title, title_en, description, starts_at, ends_at, active, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [actor.storeId, row.title, row.titleEn, row.description, row.startsAt, row.endsAt, row.active, Date.now()]);
    await audit(db, whoOf(actor), 'event.create', 'venue_event', newId, row);
    return { id: newId };
  }
  const n = await db.run('UPDATE venue_events SET title = ?, title_en = ?, description = ?, starts_at = ?, ends_at = ?, active = ? WHERE id = ? AND store_id = ?',
    [row.title, row.titleEn, row.description, row.startsAt, row.endsAt, row.active, id, actor.storeId]);
  if (!n) throw new DomainError('event not found', 404);
  await audit(db, whoOf(actor), 'event.update', 'venue_event', id, row);
  return { id };
}
