import type { Db } from './db.ts';
import { audit, DomainError } from './db.ts';
import type { Actor } from './auth.ts';
import { require_, whoOf } from './auth.ts';
import { requireModule } from './business.ts';

const KINDS = ['price', 'percent'];
const MAX_TEXT = 200;
const MAX_PRICE = 1_000_000_000;
const MAX_PERCENT_OFF = 100;

const VIEW = `SELECT id, name, product_id AS "productId", category, kind, value, members_only AS "membersOnly",
  starts_at AS "startsAt", ends_at AS "endsAt", active FROM promotions`;

export async function listPromotions(db: Db, actor: Actor) {
  require_(actor, 'admin.write');
  await requireModule(db, actor.tenantId, 'promotions');
  return db.all(`${VIEW} WHERE store_id = ? ORDER BY active DESC, starts_at DESC`, [actor.storeId]);
}

/**
 * A sale price ("price": the item sells for value fen, per kg for weighed items) or a discount ("percent": value% off),
 * for one product, one category, or everything when neither is given. The lowest price wins when several apply.
 */
export async function savePromotion(db: Db, actor: Actor, id: number | null, b: any): Promise<number> {
  require_(actor, 'admin.write');
  await requireModule(db, actor.tenantId, 'promotions');
  const cur = id ? await db.one('SELECT * FROM promotions WHERE id = ? AND store_id = ?', [id, actor.storeId]) : null;
  if (id && !cur) throw new DomainError('promotion not found', 404);
  const pick = (k: string, col: string) => (b[k] !== undefined ? b[k] : cur?.[col]);
  const name = typeof pick('name', 'name') === 'string' ? String(pick('name', 'name')).trim() : '';
  if (!name || name.length > MAX_TEXT) throw new DomainError('name is required (max 200 characters)', 422);
  const kind = pick('kind', 'kind');
  if (!KINDS.includes(kind)) throw new DomainError('kind must be price or percent', 422);
  const value = pick('value', 'value');
  const max = kind === 'percent' ? MAX_PERCENT_OFF : MAX_PRICE;
  if (!Number.isSafeInteger(value) || value < (kind === 'percent' ? 1 : 0) || value > max) throw new DomainError(`value must be a whole number up to ${max}`, 422);
  const productId = pick('productId', 'product_id') ?? null;
  const category = (pick('category', 'category') || null) as string | null;
  if (productId !== null && category !== null) throw new DomainError('choose a product or a category, not both', 422);
  if (productId !== null && !(await db.one('SELECT 1 AS x FROM products WHERE id = ? AND store_id = ?', [productId, actor.storeId]))) throw new DomainError('product not found', 404);
  if (category !== null && (typeof category !== 'string' || category.length > MAX_TEXT)) throw new DomainError('category must be text', 422);
  const startsAt = pick('startsAt', 'starts_at');
  const endsAt = pick('endsAt', 'ends_at');
  if (!Number.isSafeInteger(startsAt) || !Number.isSafeInteger(endsAt) || endsAt <= startsAt) throw new DomainError('startsAt and endsAt are epoch ms, with the end after the start', 422);
  const membersOnly = pick('membersOnly', 'members_only') === true;
  const active = b.active !== undefined ? b.active === true : cur?.active ?? true;
  const row = [name, productId, category, kind, value, membersOnly, startsAt, endsAt, active];
  const saved = cur
    ? (await db.run('UPDATE promotions SET name = ?, product_id = ?, category = ?, kind = ?, value = ?, members_only = ?, starts_at = ?, ends_at = ?, active = ? WHERE id = ?', [...row, id]), id!)
    : await db.insert('INSERT INTO promotions (name, product_id, category, kind, value, members_only, starts_at, ends_at, active, store_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [...row, actor.storeId, Date.now()]);
  await audit(db, whoOf(actor), cur ? 'promotion.update' : 'promotion.create', 'promotion', saved, { name, kind, value, productId, category });
  return saved;
}
