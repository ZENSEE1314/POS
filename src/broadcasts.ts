import type { Db } from './db.ts';
import { audit, DomainError } from './db.ts';
import type { Actor } from './auth.ts';
import { isTenantWide, require_, whoOf } from './auth.ts';

const AUDIENCES = ['guests', 'staff'];
const MAX_TITLE_LENGTH = 80;
const MAX_BODY_LENGTH = 1000;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const DAY_MS = 86_400_000;
const SHOWN = 5;
const LIST_LIMIT = 100;

export interface BroadcastInput { audience?: unknown; title?: unknown; body?: unknown; days?: unknown }

const clean = (v: unknown, name: string, max: number, required: boolean): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new DomainError(`${name} is required`, 422);
  if (s.length > max) throw new DomainError(`${name} is too long (max ${max})`, 422);
  return s;
};

/**
 * An owner's broadcast goes to the whole company; a store manager's goes to their own store.
 * Guests see a store's messages on that company's page, with the store named.
 */
export async function createBroadcast(db: Db, actor: Actor, input: BroadcastInput) {
  require_(actor, 'admin.write');
  const audience = String(input.audience ?? '');
  if (!AUDIENCES.includes(audience)) throw new DomainError('audience must be guests or staff', 422);
  const title = clean(input.title, 'title', MAX_TITLE_LENGTH, true);
  const body = clean(input.body, 'body', MAX_BODY_LENGTH, false);
  const days = input.days === undefined ? DEFAULT_DAYS : input.days;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new DomainError(`days must be 1 to ${MAX_DAYS}`, 422);
  const now = Date.now();
  const storeId = isTenantWide(actor.role) ? null : actor.storeId;
  return db.tx(async (t) => {
    const id = await t.insert(
      'INSERT INTO broadcasts (tenant_id, store_id, audience, title, body, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)',
      [actor.tenantId, storeId, audience, title, body, actor.id, now, now + days * DAY_MS]);
    await audit(t, whoOf(actor), 'broadcast.create', 'broadcast', id, { audience, title, days });
    return id;
  });
}

export function listBroadcasts(db: Db, actor: Actor) {
  require_(actor, 'admin.write');
  return db.all(
    `SELECT b.id, b.audience, b.title, b.body, b.store_id AS "storeId", s.name AS "storeName", e.name AS author,
            b.created_at AS "createdAt", b.expires_at AS "expiresAt", b.stopped
     FROM broadcasts b LEFT JOIN stores s ON s.id = b.store_id LEFT JOIN employees e ON e.id = b.created_by
     WHERE b.tenant_id = ? AND (? OR b.store_id IS NULL OR b.store_id = ?) ORDER BY b.id DESC LIMIT ${LIST_LIMIT}`,
    [actor.tenantId, isTenantWide(actor.role), actor.storeId]);
}

/** Takes a message down early. A store manager can only stop their own store's messages. */
export async function stopBroadcast(db: Db, actor: Actor, id: number) {
  require_(actor, 'admin.write');
  await db.tx(async (t) => {
    const b = await t.one('SELECT * FROM broadcasts WHERE id = ? AND tenant_id = ? FOR UPDATE', [id, actor.tenantId]);
    if (!b || (!isTenantWide(actor.role) && b.store_id !== actor.storeId)) throw new DomainError('message not found', 404);
    await t.run('UPDATE broadcasts SET stopped = TRUE WHERE id = ?', [id]);
    await audit(t, whoOf(actor), 'broadcast.stop', 'broadcast', id, { title: b.title });
  });
}

/** Messages for the staff member signed in: company-wide ones plus their store's. */
export function staffNews(db: Db, actor: Actor) {
  return db.all(
    `SELECT b.id, b.title, b.body, b.created_at AS "createdAt", e.name AS author
     FROM broadcasts b LEFT JOIN employees e ON e.id = b.created_by
     WHERE b.tenant_id = ? AND b.audience = 'staff' AND NOT b.stopped AND b.expires_at > ? AND (b.store_id IS NULL OR b.store_id = ?)
     ORDER BY b.id DESC LIMIT ${SHOWN}`, [actor.tenantId, Date.now(), actor.storeId]);
}

/** News on a company's customer page. Only public wording: no author. */
export function guestNews(db: Db, tenantId: number) {
  return db.all(
    `SELECT b.id, b.title, b.body, b.created_at AS "createdAt", s.name AS store
     FROM broadcasts b LEFT JOIN stores s ON s.id = b.store_id
     WHERE b.tenant_id = ? AND b.audience = 'guests' AND NOT b.stopped AND b.expires_at > ?
     ORDER BY b.id DESC LIMIT ${SHOWN}`, [tenantId, Date.now()]);
}
