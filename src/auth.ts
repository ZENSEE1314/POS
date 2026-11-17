import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.ts';
import { DomainError } from './db.ts';

export type Role = 'host' | 'waiter' | 'cashier' | 'manager' | 'finance' | 'owner';
export type Action =
  | 'booking.create' | 'table.open' | 'order.add' | 'order.gift' | 'order.void'
  | 'bill.discount' | 'bill.settle' | 'stash.write' | 'payroll.read' | 'payroll.write' | 'admin.write' | 'audit.read'
  | 'hq.read' | 'hq.write';

const MANAGERS: Role[] = ['manager', 'owner'];
/** Roles that see every store in the tenant and may switch between them. */
const TENANT_WIDE: Role[] = ['owner', 'finance'];

const PERMISSIONS: Record<Action, Role[]> = {
  'booking.create': ['host', 'cashier', 'manager', 'owner'],
  'table.open': ['host', 'waiter', 'cashier', 'manager', 'owner'],
  'order.add': ['waiter', 'cashier', 'manager', 'owner'],
  'order.gift': MANAGERS,
  'order.void': MANAGERS,
  'bill.discount': MANAGERS,
  'bill.settle': ['cashier', 'manager', 'owner'],
  'stash.write': ['waiter', 'cashier', 'manager', 'owner'],
  'payroll.read': ['finance', 'owner'],
  'payroll.write': ['finance', 'owner'],
  'admin.write': MANAGERS,
  'audit.read': ['manager', 'finance', 'owner'],
  'hq.read': ['finance', 'owner'],
  'hq.write': ['owner'],
};

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Only the SHA-256 of a session token is stored (column sessions.token), so a database leak does not hand out live logins. */
export const hashSessionToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const DUMMY_PIN_HASH = hashPin('timing-equaliser');

export interface Actor { id: number; name: string; role: Role; tenantId: number; storeId: number }

export function whoOf(a: Actor) {
  return { tenantId: a.tenantId, storeId: a.storeId, actorId: a.id };
}

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pin, salt, 32).toString('hex')}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(pin, Buffer.from(saltHex, 'hex'), 32);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function isTenantWide(role: Role): boolean {
  return TENANT_WIDE.includes(role);
}

export async function login(db: Db, company: string, username: string, pin: string, storeId?: number): Promise<{ token: string; actor: Actor }> {
  // Same error for unknown company, unknown user and wrong PIN so nothing can be enumerated.
  const e = await db.one(
    `SELECT e.* FROM employees e JOIN tenants t ON t.id = e.tenant_id
     WHERE lower(t.code) = lower(?) AND lower(e.username) = lower(?) AND e.active AND t.active`, [company, username]);
  // Always run scrypt, even for an unknown user, so response time does not reveal which usernames exist.
  const pinOk = verifyPin(pin, e?.pin_hash ?? DUMMY_PIN_HASH);
  if (!e || !pinOk) throw new DomainError("invalid credentials", 401);

  let chosen: number | undefined = e.store_id ?? undefined;
  if (chosen === undefined) {
    // tenant-wide staff: requested store, else the tenant's first active store
    const s = storeId
      ? await db.one("SELECT id FROM stores WHERE id = ? AND tenant_id = ? AND active", [storeId, e.tenant_id])
      : await db.one("SELECT id FROM stores WHERE tenant_id = ? AND active ORDER BY id LIMIT 1", [e.tenant_id]);
    if (!s) throw new DomainError("no accessible store", 403);
    chosen = s.id;
  }
  const token = randomBytes(24).toString("hex");
  await db.run("INSERT INTO sessions (token, employee_id, store_id, expires_at) VALUES (?,?,?,?)", [hashSessionToken(token), e.id, chosen, Date.now() + SESSION_TTL_MS]);
  return { token, actor: { id: e.id, name: e.name, role: e.role, tenantId: e.tenant_id, storeId: chosen! } };
}

export async function actorFromToken(db: Db, token: string | undefined): Promise<Actor> {
  if (!token) throw new DomainError('unauthenticated', 401);
  const r = await db.one(
    `SELECT e.id, e.name, e.role, e.tenant_id, s.store_id FROM sessions s JOIN employees e ON e.id = s.employee_id
     JOIN tenants t ON t.id = e.tenant_id WHERE s.token = ? AND s.expires_at > ? AND e.active AND t.active`, [hashSessionToken(token), Date.now()]);
  if (!r) throw new DomainError('unauthenticated', 401);
  return { id: r.id, name: r.name, role: r.role, tenantId: r.tenant_id, storeId: r.store_id };
}

/** True when the bearer token is a live staff or guest session. Used to decide how to rate-limit a caller, never to authorise. */
export async function isLiveSession(db: Db, token: string): Promise<boolean> {
  const now = Date.now();
  const staff = await db.one('SELECT 1 AS x FROM sessions WHERE token = ? AND expires_at > ?', [hashSessionToken(token), now]);
  if (staff) return true;
  const guest = await db.one('SELECT 1 AS x FROM guest_sessions WHERE token_hash = ? AND expires_at > ?', [hashSessionToken(token), now]);
  return Boolean(guest);
}

/** Tenant-wide roles move their session between stores; store staff cannot. */
export async function switchStore(db: Db, token: string, actor: Actor, storeId: number): Promise<Actor> {
  if (!isTenantWide(actor.role)) throw new DomainError('this role is pinned to one store', 403);
  const s = await db.one('SELECT id FROM stores WHERE id = ? AND tenant_id = ? AND active', [storeId, actor.tenantId]);
  if (!s) throw new DomainError('store not found', 404);
  await db.run('UPDATE sessions SET store_id = ? WHERE token = ?', [storeId, hashSessionToken(token)]);
  return { ...actor, storeId };
}

export function can(actor: Actor, action: Action): boolean {
  return PERMISSIONS[action].includes(actor.role);
}

export function require_(actor: Actor, action: Action): void {
  if (!can(actor, action)) throw new DomainError(`role ${actor.role} may not ${action}`, 403);
}
