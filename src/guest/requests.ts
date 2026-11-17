import type { Db } from '../db.ts';
import { audit, DomainError } from '../db.ts';
import type { Actor } from '../auth.ts';
import { require_, whoOf } from '../auth.ts';
import type { Feature } from './settings.ts';
import { requireFeature } from './settings.ts';
import type { StoreRef } from './venue.ts';
import { int, storeByCode, tableByToken, tenantByCode, text } from './venue.ts';

const KINDS = ['service', 'song', 'bottle', 'support', 'pet'] as const;
type Kind = typeof KINDS[number];
const FEATURE_OF: Record<Kind, Feature> = { service: 'service', song: 'song', bottle: 'bottle', support: 'support', pet: 'pets' };
const AT_TABLE: readonly Kind[] = ['service', 'bottle'];
const SERVICE_REASONS = ['waiter', 'ice', 'glasses', 'cleanup', 'bill', 'other'];
const PET_SERVICES = ['grooming', 'bath', 'daycare', 'boarding', 'visit', 'other'];
const PET_SPECIES = ['dog', 'cat', 'other'];
const STATUSES = ['pending', 'done', 'declined', 'cancelled'];
const MAX_PENDING = 5;
const MAX_PER_HOUR = 20;
const MAX_MESSAGE = 1000;
const MAX_PETS = 10;
const HOUR_MS = 60 * 60 * 1000;
const PET_HORIZON_MS = 60 * 24 * HOUR_MS;
const RECENT = 30;
const LIST_LIMIT = 100;
const BIRTHDAY = /^\d{4}-\d{2}-\d{2}$/;

const required = (v: unknown, name: string, max: number): string => {
  const s = text(v, name, max);
  if (!s) throw new DomainError(`${name} is required`, 422);
  return s;
};
const oneOf = (v: unknown, name: string, list: string[]): string => {
  if (typeof v !== 'string' || !list.includes(v)) throw new DomainError(`${name} must be one of ${list.join(', ')}`, 422);
  return v;
};

/** What the guest asked for, checked per kind. Pet requests keep a copy of the pet so staff see it as it was. */
async function detailFor(db: Db, kind: Kind, customerId: number, store: StoreRef, b: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (kind) {
    case 'service':
      return { reason: oneOf(b.reason, 'reason', SERVICE_REASONS), note: text(b.note, 'note') };
    case 'song':
      return { title: required(b.title, 'song title', 100), artist: text(b.artist, 'artist', 100), note: text(b.note, 'note') };
    case 'bottle': {
      const phone = (await db.one('SELECT phone FROM customers WHERE id = ?', [customerId]))?.phone;
      if (!phone) throw new DomainError('verify your phone number to use your stored bottles', 403);
      const code = required(b.code, 'bottle code', 40);
      const x = await db.one(
        "SELECT code, name, left_milli FROM stash WHERE code = ? AND phone = ? AND store_id = ? AND status = 'stored' AND left_milli > 0 AND expires_at >= ?",
        [code, phone, store.storeId, Date.now()]);
      if (!x) throw new DomainError('that bottle is not stored at this location', 404);
      return { code: x.code, name: x.name, leftMilli: x.left_milli, note: text(b.note, 'note') };
    }
    case 'support':
      return { message: required(b.message, 'message', MAX_MESSAGE) };
    case 'pet': {
      const petId = int(b.petId, 'petId', 1, Number.MAX_SAFE_INTEGER);
      const pet = await db.one('SELECT name, species, breed, birthday, notes FROM customer_pets WHERE id = ? AND customer_id = ? AND active', [petId, customerId]);
      if (!pet) throw new DomainError('pet not found', 404);
      const when = int(b.when, 'when', 0, Number.MAX_SAFE_INTEGER);
      if (when < Date.now() || when > Date.now() + PET_HORIZON_MS) throw new DomainError('choose a time within the next 60 days', 422);
      return { petId, pet, service: oneOf(b.service, 'service', PET_SERVICES), when, note: text(b.note, 'note') };
    }
  }
}

/**
 * A guest asks the staff for something: at a table (service, bottle), at a location (support, pet care), or either (a song
 * request from the table QR, or from the app's song page before the guest has sat down).
 */
export async function createRequest(db: Db, customerId: number, b: Record<string, unknown>): Promise<{ requestId: number }> {
  const kind = oneOf(b.kind, 'kind', [...KINDS]) as Kind;
  let store: StoreRef;
  let tableId: number | null = null;
  if (AT_TABLE.includes(kind) || (kind === 'song' && b.qrToken)) {
    const r = await tableByToken(db, String(b.qrToken ?? ''));
    store = r.store;
    tableId = r.table.id;
  } else {
    store = await storeByCode(db, String(b.company ?? ''), String(b.store ?? ''));
  }
  await requireFeature(db, store.tenantId, FEATURE_OF[kind]);
  const detail = await detailFor(db, kind, customerId, store, b);
  return db.tx(async (t) => {
    // Serialise one guest's requests so the limits below cannot be raced.
    await t.one('SELECT id FROM customers WHERE id = ? FOR UPDATE', [customerId]);
    const c = await t.one(
      "SELECT COUNT(*) FILTER (WHERE status = 'pending') AS pending, COUNT(*) FILTER (WHERE created_at > ?) AS recent FROM guest_requests WHERE customer_id = ?",
      [Date.now() - HOUR_MS, customerId]);
    if (c.pending >= MAX_PENDING) throw new DomainError('you have requests waiting for staff; please wait for them first', 429);
    if (c.recent >= MAX_PER_HOUR) throw new DomainError('too many requests, try again later', 429);
    const id = await t.insert('INSERT INTO guest_requests (store_id, table_id, customer_id, kind, detail, created_at) VALUES (?,?,?,?,?,?)',
      [store.storeId, tableId, customerId, kind, JSON.stringify(detail), Date.now()]);
    await audit(t, { tenantId: store.tenantId, storeId: store.storeId }, `guest.request.${kind}`, 'guest_request', id, { customerId, tableId });
    return { requestId: id };
  });
}

const view = (r: any) => ({
  id: r.id, kind: r.kind, status: r.status, detail: JSON.parse(r.detail), reply: r.reply, createdAt: r.created_at, decidedAt: r.decided_at,
  tableName: r.table_name ?? null, storeName: r.store_name, storeCode: r.store_code,
});

const REQUEST_SQL = `SELECT r.*, d.name AS table_name, s.name AS store_name, s.code AS store_code FROM guest_requests r
  JOIN stores s ON s.id = r.store_id LEFT JOIN dining_tables d ON d.id = r.table_id`;

export async function myRequests(db: Db, customerId: number, company: string) {
  const t0 = await tenantByCode(db, company);
  const rows = await db.all(`${REQUEST_SQL} WHERE r.customer_id = ? AND s.tenant_id = ? ORDER BY r.id DESC LIMIT ?`, [customerId, t0.id, RECENT]);
  return rows.map(view);
}

export async function cancelRequest(db: Db, customerId: number, id: number): Promise<void> {
  const n = await db.run("UPDATE guest_requests SET status = 'cancelled', decided_at = ? WHERE id = ? AND customer_id = ? AND status = 'pending'", [Date.now(), id, customerId]);
  if (!n) throw new DomainError('this request can no longer be cancelled', 409);
}

// ---------- staff ----------

export async function listGuestRequests(db: Db, actor: Actor, status = 'pending') {
  require_(actor, 'order.add');
  if (!STATUSES.includes(status)) throw new DomainError('unknown status', 422);
  const rows = await db.all(
    `SELECT r.*, d.name AS table_name, s.name AS store_name, s.code AS store_code, c.display_name AS guest_name, c.phone AS guest_phone
     FROM guest_requests r JOIN stores s ON s.id = r.store_id JOIN customers c ON c.id = r.customer_id LEFT JOIN dining_tables d ON d.id = r.table_id
     WHERE r.store_id = ? AND r.status = ? ORDER BY r.id ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT ?`, [actor.storeId, status, LIST_LIMIT]);
  return rows.map((r) => ({ ...view(r), guestName: r.guest_name, guestPhone: r.guest_phone }));
}

/** Marks a request handled. Declining needs a reply, which the guest sees; a reply to a support message is optional. */
export async function decideRequest(db: Db, actor: Actor, id: number, outcome: 'done' | 'declined', reply: unknown): Promise<void> {
  require_(actor, 'order.add');
  const msg = text(reply, 'reply', MAX_MESSAGE);
  if (outcome === 'declined' && !msg) throw new DomainError('a reason is required (shown to the guest)', 422);
  const n = await db.run("UPDATE guest_requests SET status = ?, reply = ?, decided_at = ?, decided_by = ? WHERE id = ? AND store_id = ? AND status = 'pending'",
    [outcome, msg || null, Date.now(), actor.id, id, actor.storeId]);
  if (!n) throw new DomainError('request not found or already handled', 404);
  await audit(db, whoOf(actor), `guest.request.${outcome}`, 'guest_request', id, { reply: msg });
}

// ---------- the guest's pets ----------

export function listPets(db: Db, customerId: number) {
  return db.all('SELECT id, name, species, breed, birthday, notes FROM customer_pets WHERE customer_id = ? AND active ORDER BY id', [customerId]);
}

export async function savePet(db: Db, customerId: number, id: number | null, b: Record<string, unknown>): Promise<{ id: number }> {
  const birthday = text(b.birthday, 'birthday', 10);
  if (birthday && !BIRTHDAY.test(birthday)) throw new DomainError('birthday must look like 2023-05-31', 422);
  const row = {
    name: required(b.name, 'name', 40), species: oneOf(b.species, 'species', PET_SPECIES),
    breed: text(b.breed, 'breed', 60), birthday, notes: text(b.notes, 'notes', 500),
  };
  if (id === null) {
    const n = (await db.one('SELECT COUNT(*) AS n FROM customer_pets WHERE customer_id = ? AND active', [customerId])).n;
    if (n >= MAX_PETS) throw new DomainError(`up to ${MAX_PETS} pets`, 409);
    return { id: await db.insert('INSERT INTO customer_pets (customer_id, name, species, breed, birthday, notes, created_at) VALUES (?,?,?,?,?,?,?)',
      [customerId, row.name, row.species, row.breed, row.birthday, row.notes, Date.now()]) };
  }
  const n = await db.run('UPDATE customer_pets SET name = ?, species = ?, breed = ?, birthday = ?, notes = ? WHERE id = ? AND customer_id = ? AND active',
    [row.name, row.species, row.breed, row.birthday, row.notes, id, customerId]);
  if (!n) throw new DomainError('pet not found', 404);
  return { id };
}

export async function removePet(db: Db, customerId: number, id: number): Promise<void> {
  const n = await db.run('UPDATE customer_pets SET active = FALSE WHERE id = ? AND customer_id = ? AND active', [id, customerId]);
  if (!n) throw new DomainError('pet not found', 404);
}
