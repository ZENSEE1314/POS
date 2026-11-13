import { randomInt } from 'node:crypto';
import type { Db } from './db.ts';
import { audit, DomainError } from './db.ts';
import type { Actor } from './auth.ts';
import { require_, whoOf } from './auth.ts';
import { cleanPhone, normalizePhone } from './phone.ts';

/** Quantities are stored in thousandths of a bottle so 0.6 bottle is exact integer math. */
export const MILLI = 1000;
const MS_PER_DAY = 86_400_000;
const CODE_LENGTH = 8;
const DEFAULT_STASH_DAYS = 90;
const MAX_STASH_MILLI = 10 * MILLI;
const MAX_STASH_DAYS = 3650;
const STASH_KINDS = ['free', 'purchased'];
const CODE_ATTEMPTS = 5;

function newCode(): string {
  let c = '';
  for (let i = 0; i < CODE_LENGTH; i++) c += randomInt(0, 10);
  return c;
}

export async function storeWine(db: Db, actor: Actor, input: { phone: string; productId: number; qtyMilli: number; kind?: 'free' | 'purchased'; days?: number }) {
  require_(actor, 'stash.write');
  const phone = cleanPhone(input.phone);
  const kind = input.kind || 'purchased';
  const days = input.days ?? DEFAULT_STASH_DAYS;
  if (!Number.isInteger(input.qtyMilli) || input.qtyMilli <= 0 || input.qtyMilli > MAX_STASH_MILLI) throw new DomainError('qtyMilli must be 1..10000', 422);
  if (!Number.isSafeInteger(input.productId)) throw new DomainError('productId must be an integer', 422);
  if (!STASH_KINDS.includes(kind)) throw new DomainError(`kind must be one of ${STASH_KINDS.join(', ')}`, 422);
  if (!Number.isInteger(days) || days < 1 || days > MAX_STASH_DAYS) throw new DomainError(`days must be 1..${MAX_STASH_DAYS}`, 422);
  return db.tx(async (t) => {
    const p = await t.one('SELECT * FROM products WHERE id = ? AND store_id = ?', [input.productId, actor.storeId]);
    if (!p) throw new DomainError('product not found', 404);
    const now = Date.now();
    // 8 random digits collide eventually on a busy tenant; retry instead of failing the waiter with a 500.
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
      const code = newCode();
      const row = await t.one(
        `INSERT INTO stash (store_id, phone, product_id, name, qty_milli, left_milli, kind, expires_at, code, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (code) DO NOTHING RETURNING id`,
        [actor.storeId, phone, p.id, p.name, input.qtyMilli, input.qtyMilli, kind, now + days * MS_PER_DAY, code, now]);
      if (!row) continue;
      await audit(t, whoOf(actor), 'stash.store', 'stash', row.id, { ...input, phone });
      return { id: row.id as number, code };
    }
    throw new DomainError('could not allocate a stash code, try again', 503);
  });
}

export function lookupStash(db: Db, actor: Actor, phoneOrCode: string) {
  const q = phoneOrCode.trim();
  return db.all(
    "SELECT * FROM stash WHERE store_id = ? AND (phone = ? OR code = ?) AND status = 'stored' AND left_milli > 0 AND expires_at >= ? ORDER BY expires_at",
    [actor.storeId, normalizePhone(q), q, Date.now()]);
}

/** Retrieval moves stash onto a bill as a zero-price line: stash is a liability, not new revenue. */
export async function retrieveWine(db: Db, actor: Actor, input: { stashId: number; qtyMilli: number; billId: number }) {
  require_(actor, 'stash.write');
  if (!Number.isInteger(input.qtyMilli) || input.qtyMilli <= 0) throw new DomainError('qtyMilli must be positive', 422);
  return db.tx(async (t) => {
    const s = await t.one('SELECT * FROM stash WHERE id = ? AND store_id = ? FOR UPDATE', [input.stashId, actor.storeId]);
    if (!s) throw new DomainError('stash not found', 404);
    if (s.status !== 'stored') throw new DomainError(`stash is ${s.status}`, 409);
    if (s.expires_at < Date.now()) throw new DomainError('stash expired', 409);
    if (input.qtyMilli > s.left_milli) throw new DomainError('not enough left in stash', 409);
    const bill = await t.one("SELECT id FROM bills WHERE id = ? AND store_id = ? AND status = 'open'", [input.billId, actor.storeId]);
    if (!bill) throw new DomainError('open bill not found', 404);

    const left = s.left_milli - input.qtyMilli;
    await t.run('UPDATE stash SET left_milli = ?, status = ? WHERE id = ?', [left, left === 0 ? 'retrieved' : 'stored', s.id]);
    await t.run(
      `INSERT INTO bill_lines (bill_id, product_id, name, qty, unit_price, kind, status, reason, waiter_id, created_at)
       VALUES (?,?,?,?,0,'gift','active',?,?,?)`, [input.billId, s.product_id, `${s.name} (stash ${input.qtyMilli / MILLI})`, 1, `stash:${s.id}`, actor.id, Date.now()]);
    await audit(t, whoOf(actor), 'stash.retrieve', 'stash', s.id, input);
    return { leftMilli: left };
  });
}

/** Physically moving a bottle to another store of the same tenant. */
export async function transferStash(db: Db, actor: Actor, stashId: number, toStoreId: number): Promise<void> {
  require_(actor, 'admin.write');
  await db.tx(async (t) => {
    const dest = await t.one('SELECT id FROM stores WHERE id = ? AND tenant_id = ? AND active', [toStoreId, actor.tenantId]);
    if (!dest) throw new DomainError('destination store not found', 404);
    const n = await t.run("UPDATE stash SET store_id = ? WHERE id = ? AND store_id = ? AND status = 'stored'", [toStoreId, stashId, actor.storeId]);
    if (n === 0) throw new DomainError('stash not found in this store', 404);
    await audit(t, whoOf(actor), 'stash.transfer', 'stash', stashId, { from: actor.storeId, to: toStoreId });
  });
}

export function expireStash(db: Db, now = Date.now()): Promise<number> {
  return db.run("UPDATE stash SET status = 'expired' WHERE status = 'stored' AND expires_at < ?", [now]);
}
