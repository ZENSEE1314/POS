import type { Db } from './db.ts';
import { audit, DomainError } from './db.ts';
import type { Actor, Role } from './auth.ts';
import { hashPin, isTenantWide, require_, whoOf } from './auth.ts';

const ROLES: Role[] = ['host', 'waiter', 'cashier', 'manager', 'finance', 'owner'];
const MIN_PIN_LENGTH = 4;
const MAX_TEXT_LENGTH = 200;

export function listStores(db: Db, actor: Actor) {
  require_(actor, 'hq.read');
  return db.all('SELECT id, name, code, douyin_poi_id AS "douyinPoiId", active FROM stores WHERE tenant_id = ? ORDER BY id', [actor.tenantId]);
}

export async function createStore(db: Db, actor: Actor, input: { name: string; code: string; douyinPoiId?: string; copyCatalogFrom?: number }): Promise<number> {
  require_(actor, 'hq.write');
  if (typeof input.name !== 'string' || typeof input.code !== 'string' || !input.name.trim() || !input.code.trim()) throw new DomainError('name and code required', 422);
  // An empty poi means "no Douyin mapping": storing '' would make the second such store collide on the unique index.
  const poi = input.douyinPoiId == null || input.douyinPoiId === '' ? null : input.douyinPoiId;
  if (poi !== null && (typeof poi !== 'string' || poi.length > MAX_TEXT_LENGTH)) throw new DomainError('douyinPoiId must be text', 422);
  if (input.copyCatalogFrom && !Number.isSafeInteger(Number(input.copyCatalogFrom))) throw new DomainError('copyCatalogFrom must be a store id', 422);
  return db.tx(async (t) => {
    const exists = await t.one('SELECT 1 AS x FROM stores WHERE tenant_id = ? AND code = ?', [actor.tenantId, input.code]);
    if (exists) throw new DomainError('store code already used', 409);
    if (poi && (await t.one('SELECT 1 AS x FROM stores WHERE douyin_poi_id = ?', [poi]))) throw new DomainError('Douyin poi is already mapped to another store', 409);
    const id = await t.insert('INSERT INTO stores (tenant_id, name, code, douyin_poi_id, created_at) VALUES (?,?,?,?,?)', [actor.tenantId, input.name, input.code, poi, Date.now()]);
    await audit(t, { tenantId: actor.tenantId, storeId: id, actorId: actor.id }, 'store.create', 'store', id, input);
    if (input.copyCatalogFrom) await copyCatalog(t, actor, Number(input.copyCatalogFrom), [id]);
    return id;
  });
}

export async function createStaff(db: Db, actor: Actor, input: { name: string; username: string; role: Role; pin: string; storeId?: number }): Promise<number> {
  require_(actor, 'hq.write');
  if (typeof input.name !== 'string' || !input.name.trim()) throw new DomainError('name required', 422);
  if (!ROLES.includes(input.role)) throw new DomainError('unknown role', 422);
  if (typeof input.username !== 'string' || !/^[a-z0-9._-]{2,32}$/i.test(input.username)) throw new DomainError('username: 2-32 letters, digits, . _ -', 422);
  if (typeof input.pin !== 'string' || input.pin.length < MIN_PIN_LENGTH) throw new DomainError(`pin needs at least ${MIN_PIN_LENGTH} digits`, 422);
  const tenantWide = isTenantWide(input.role);
  if (!tenantWide && !input.storeId) throw new DomainError('storeId required for store staff', 422);
  if (input.storeId && !Number.isSafeInteger(Number(input.storeId))) throw new DomainError('storeId must be an integer', 422);
  return db.tx(async (t) => {
    if (input.storeId) {
      const s = await t.one('SELECT id FROM stores WHERE id = ? AND tenant_id = ?', [input.storeId, actor.tenantId]);
      if (!s) throw new DomainError('store not found', 404);
    }
    if (await t.one('SELECT 1 AS x FROM employees WHERE tenant_id = ? AND lower(username) = lower(?)', [actor.tenantId, input.username])) throw new DomainError('username already used', 409);
    const id = await t.insert('INSERT INTO employees (tenant_id, store_id, name, role, pin_hash, username) VALUES (?,?,?,?,?,?)',
      [actor.tenantId, tenantWide ? null : input.storeId, input.name, input.role, hashPin(input.pin), input.username]);
    await audit(t, whoOf(actor), 'staff.create', 'employee', id, { name: input.name, role: input.role, storeId: input.storeId });
    return id;
  });
}

/** Copies products and commission rules from one store into others. Existing products (same name) are updated, not duplicated. */
export async function copyCatalog(db: Db, actor: Actor, fromStoreId: number, toStoreIds: number[]): Promise<{ stores: number; products: number }> {
  require_(actor, 'hq.write');
  if (!Number.isSafeInteger(fromStoreId) || !Array.isArray(toStoreIds) || !toStoreIds.every(Number.isSafeInteger)) throw new DomainError('fromStoreId and toStoreIds (a list of store ids) are required', 422);
  return db.tx(async (t) => {
    const ids = [fromStoreId, ...toStoreIds];
    const valid = await t.all('SELECT id FROM stores WHERE tenant_id = ? AND id = ANY(?)', [actor.tenantId, ids]);
    if (valid.length !== new Set(ids).size) throw new DomainError('all stores must belong to your tenant', 404);
    const products = await t.all('SELECT * FROM products WHERE store_id = ? AND active', [fromStoreId]);
    const rules = await t.all('SELECT * FROM commission_rules WHERE store_id = ?', [fromStoreId]);
    for (const to of toStoreIds) {
      if (to === fromStoreId) continue;
      for (const p of products) {
        // price/category sync; stock is local to each store and starts at 0
        await t.run(
          `INSERT INTO products (store_id, name, name_en, category, price, stock, track_stock, station) VALUES (?,?,?,?,?,0,?,?)
           ON CONFLICT (store_id, name) DO UPDATE SET name_en = EXCLUDED.name_en, category = EXCLUDED.category, price = EXCLUDED.price, track_stock = EXCLUDED.track_stock, station = EXCLUDED.station, active = TRUE`,
          [to, p.name, p.name_en, p.category, p.price, p.track_stock, p.station]);
      }
      // Rules reference products by id, which differ per store, so only store/category-level rules are copied.
      await t.run('DELETE FROM commission_rules WHERE store_id = ?', [to]);
      for (const r of rules.filter((x) => x.product_id == null)) {
        await t.run('INSERT INTO commission_rules (store_id, role, category, bps, fixed) VALUES (?,?,?,?,?)', [to, r.role, r.category, r.bps, r.fixed]);
      }
    }
    await audit(t, whoOf(actor), 'catalog.copy', 'store', fromStoreId, { toStoreIds });
    return { stores: toStoreIds.length, products: products.length };
  });
}

/** Per-store roll-up of settled bills in [from, to): revenue by tender, bill count, commission, open exposure. */
export async function hqSummary(db: Db, actor: Actor, fromTs: number, toTs: number) {
  require_(actor, 'hq.read');
  const rows = await db.all(
    `SELECT s.id AS "storeId", s.name,
       (SELECT COUNT(*) FROM bills b WHERE b.store_id = s.id AND b.status = 'settled' AND b.closed_at >= ? AND b.closed_at < ?) AS bills,
       (SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN bills b ON b.id = p.bill_id
          WHERE b.store_id = s.id AND b.status = 'settled' AND b.closed_at >= ? AND b.closed_at < ? AND p.status = 'paid') AS revenue,
       (SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN bills b ON b.id = p.bill_id
          WHERE b.store_id = s.id AND b.status = 'settled' AND b.closed_at >= ? AND b.closed_at < ? AND p.status = 'paid' AND p.method = 'credit') AS credit,
       (SELECT COALESCE(SUM(c.amount),0) FROM commission_entries c WHERE c.store_id = s.id AND c.ts >= ? AND c.ts < ?) AS commission,
       (SELECT COUNT(*) FROM bills b WHERE b.store_id = s.id AND b.status = 'open') AS "openBills",
       (SELECT COUNT(*) FROM stash st WHERE st.store_id = s.id AND st.status = 'stored') AS "stashItems"
     FROM stores s WHERE s.tenant_id = ? AND s.active ORDER BY s.id`,
    [fromTs, toTs, fromTs, toTs, fromTs, toTs, fromTs, toTs, actor.tenantId]);
  const sum = (k: string) => rows.reduce((a: number, r: any) => a + r[k], 0);
  return { stores: rows, totals: { bills: sum('bills'), revenue: sum('revenue'), credit: sum('credit'), commission: sum('commission'), openBills: sum('openBills') } };
}
