import type { Db } from './db.ts';
import { audit, DomainError } from './db.ts';
import type { Actor } from './auth.ts';
import { require_, whoOf } from './auth.ts';
import { requireModule } from './business.ts';
import { linePrice } from './pricing.ts';

const MAX_TEXT = 200;
const MAX_QTY = 1_000_000_000;
const MAX_PO_LINES = 200;
const LIST_LIMIT = 100;
const PO_STATUSES = ['draft', 'ordered', 'received', 'cancelled'];

const text = (v: unknown, name: string, required = true): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new DomainError(`${name} is required`, 422);
  if (s.length > MAX_TEXT) throw new DomainError(`${name} is too long (max ${MAX_TEXT})`, 422);
  return s;
};
const count = (v: unknown, name: string, min: number): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > MAX_QTY) throw new DomainError(`${name} must be a whole number from ${min} to ${MAX_QTY}`, 422);
  return v;
};

async function gate(db: Db, actor: Actor): Promise<void> {
  require_(actor, 'admin.write');
  await requireModule(db, actor.tenantId, 'purchasing');
}

/** What a line costs: per piece, or per kg for items sold by weight (whose quantities are grams). */
const lineCost = (unit: string, qty: number, unitCost: number): number => (unit === 'kg' ? linePrice(unitCost, qty) : qty * unitCost);

// ---- suppliers (shared by every store of the company) ------------------------------------------------

export async function listSuppliers(db: Db, actor: Actor) {
  await gate(db, actor);
  return db.all('SELECT id, name, contact, phone, note, active FROM suppliers WHERE tenant_id = ? ORDER BY active DESC, name', [actor.tenantId]);
}

export async function saveSupplier(db: Db, actor: Actor, id: number | null, b: any): Promise<number> {
  await gate(db, actor);
  const cur = id ? await db.one('SELECT * FROM suppliers WHERE id = ? AND tenant_id = ?', [id, actor.tenantId]) : null;
  if (id && !cur) throw new DomainError('supplier not found', 404);
  const v = {
    name: b.name !== undefined || !cur ? text(b.name, 'name') : cur.name,
    contact: b.contact !== undefined ? text(b.contact, 'contact', false) : cur?.contact ?? '',
    phone: b.phone !== undefined ? text(b.phone, 'phone', false) : cur?.phone ?? '',
    note: b.note !== undefined ? text(b.note, 'note', false) : cur?.note ?? '',
    active: b.active !== undefined ? b.active === true : cur?.active ?? true,
  };
  if (await db.one('SELECT 1 AS x FROM suppliers WHERE tenant_id = ? AND lower(name) = lower(?) AND id <> ?', [actor.tenantId, v.name, id ?? 0])) {
    throw new DomainError('a supplier with this name already exists', 409);
  }
  const saved = cur
    ? (await db.run('UPDATE suppliers SET name = ?, contact = ?, phone = ?, note = ?, active = ? WHERE id = ?', [v.name, v.contact, v.phone, v.note, v.active, id]), id!)
    : await db.insert('INSERT INTO suppliers (tenant_id, name, contact, phone, note, active, created_at) VALUES (?,?,?,?,?,?,?)',
      [actor.tenantId, v.name, v.contact, v.phone, v.note, v.active, Date.now()]);
  await audit(db, whoOf(actor), cur ? 'supplier.update' : 'supplier.create', 'supplier', saved, v);
  return saved;
}

// ---- purchase orders ------------------------------------------------------------------------------

export async function listPurchaseOrders(db: Db, actor: Actor, status?: string) {
  await gate(db, actor);
  if (status && !PO_STATUSES.includes(status)) throw new DomainError('unknown status', 422);
  const orders = await db.all(
    `SELECT o.id, o.status, o.note, o.created_at AS "createdAt", o.ordered_at AS "orderedAt", o.received_at AS "receivedAt",
            o.supplier_id AS "supplierId", s.name AS "supplierName"
     FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id
     WHERE o.store_id = ? AND (?::text IS NULL OR o.status = ?) ORDER BY o.id DESC LIMIT ?`, [actor.storeId, status ?? null, status ?? null, LIST_LIMIT]);
  if (!orders.length) return [];
  const lines = await db.all(
    `SELECT l.id, l.po_id AS "poId", l.product_id AS "productId", p.name, p.name_en AS "nameEn", p.unit, l.qty, l.unit_cost AS "unitCost", l.received_qty AS "receivedQty"
     FROM po_lines l JOIN products p ON p.id = l.product_id WHERE l.po_id = ANY(?) ORDER BY l.id`, [orders.map((o) => o.id)]);
  return orders.map((o) => {
    const own = lines.filter((l) => l.poId === o.id);
    return { ...o, lines: own, total: own.reduce((a, l) => a + lineCost(l.unit, l.receivedQty ?? l.qty, l.unitCost), 0) };
  });
}

/** A draft order to one supplier. Quantities of items sold by weight are grams, their cost is per kg. */
export async function createPurchaseOrder(db: Db, actor: Actor, b: any): Promise<number> {
  await gate(db, actor);
  if (!Array.isArray(b.lines) || b.lines.length === 0 || b.lines.length > MAX_PO_LINES) throw new DomainError(`lines: 1 to ${MAX_PO_LINES} items`, 422);
  const supplierId = count(b.supplierId, 'supplierId', 1);
  return db.tx(async (t) => {
    if (!(await t.one('SELECT 1 AS x FROM suppliers WHERE id = ? AND tenant_id = ? AND active', [supplierId, actor.tenantId]))) throw new DomainError('supplier not found', 404);
    const id = await t.insert('INSERT INTO purchase_orders (store_id, supplier_id, note, created_by, created_at) VALUES (?,?,?,?,?)',
      [actor.storeId, supplierId, text(b.note, 'note', false), actor.id, Date.now()]);
    for (const l of b.lines) {
      const productId = count(l?.productId, 'productId', 1);
      if (!(await t.one('SELECT 1 AS x FROM products WHERE id = ? AND store_id = ?', [productId, actor.storeId]))) throw new DomainError('product not found', 404);
      await t.run('INSERT INTO po_lines (po_id, product_id, qty, unit_cost) VALUES (?,?,?,?)', [id, productId, count(l.qty, 'qty', 1), count(l.unitCost, 'unitCost', 0)]);
    }
    await audit(t, whoOf(actor), 'po.create', 'purchase_order', id, { supplierId, lines: b.lines.length });
    return id;
  });
}

async function lockOrder(t: Db, actor: Actor, id: number) {
  const o = await t.one('SELECT * FROM purchase_orders WHERE id = ? AND store_id = ? FOR UPDATE', [id, actor.storeId]);
  if (!o) throw new DomainError('purchase order not found', 404);
  return o;
}

export async function markOrdered(db: Db, actor: Actor, id: number): Promise<void> {
  await gate(db, actor);
  await db.tx(async (t) => {
    const o = await lockOrder(t, actor, id);
    if (o.status !== 'draft') throw new DomainError(`order is ${o.status}`, 409);
    await t.run("UPDATE purchase_orders SET status = 'ordered', ordered_at = ? WHERE id = ?", [Date.now(), id]);
    await audit(t, whoOf(actor), 'po.order', 'purchase_order', id, {});
  });
}

export async function cancelPurchaseOrder(db: Db, actor: Actor, id: number): Promise<void> {
  await gate(db, actor);
  await db.tx(async (t) => {
    const o = await lockOrder(t, actor, id);
    if (o.status !== 'draft' && o.status !== 'ordered') throw new DomainError(`order is ${o.status}`, 409);
    await t.run("UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?", [id]);
    await audit(t, whoOf(actor), 'po.cancel', 'purchase_order', id, {});
  });
}

/**
 * Goods arrived: stock goes up by what actually came (received[lineId], default the ordered qty, 0 for a missing item),
 * each item's cost becomes the price paid on this order, and every change is in the stock movement log.
 */
export async function receivePurchaseOrder(db: Db, actor: Actor, id: number, received: Record<string, unknown> = {}): Promise<void> {
  await gate(db, actor);
  if (received === null || typeof received !== 'object' || Array.isArray(received)) throw new DomainError('received must be an object of lineId: qty', 422);
  await db.tx(async (t) => {
    const o = await lockOrder(t, actor, id);
    if (o.status !== 'draft' && o.status !== 'ordered') throw new DomainError(`order is ${o.status}`, 409);
    const lines = await t.all('SELECT * FROM po_lines WHERE po_id = ? ORDER BY id', [id]);
    for (const key of Object.keys(received)) if (!lines.some((l) => String(l.id) === key)) throw new DomainError(`line ${key} is not on this order`, 422);
    const now = Date.now();
    for (const l of lines) {
      const qty = received[String(l.id)] === undefined ? l.qty : count(received[String(l.id)], 'received qty', 0);
      await t.run('UPDATE po_lines SET received_qty = ? WHERE id = ?', [qty, l.id]);
      if (qty === 0) continue;
      await t.run('UPDATE products SET stock = stock + ?, cost = ? WHERE id = ?', [qty, l.unit_cost, l.product_id]);
      await t.run('INSERT INTO stock_movements (store_id, product_id, delta, reason, actor_id, ts) VALUES (?,?,?,?,?,?)',
        [actor.storeId, l.product_id, qty, `purchase order ${id}`, actor.id, now]);
    }
    await t.run("UPDATE purchase_orders SET status = 'received', received_at = ?, received_by = ? WHERE id = ?", [now, actor.id, id]);
    await audit(t, whoOf(actor), 'po.receive', 'purchase_order', id, { received });
  });
}

/** Items at or below their reorder level, with a suggested order that brings them back to twice that level. */
export async function lowStock(db: Db, actor: Actor) {
  await gate(db, actor);
  const rows = await db.all(
    `SELECT id, name, name_en AS "nameEn", unit, stock, reorder_level AS "reorderLevel", cost FROM products
     WHERE store_id = ? AND active AND track_stock AND reorder_level > 0 AND stock <= reorder_level ORDER BY stock - reorder_level, name`, [actor.storeId]);
  return rows.map((r) => ({ ...r, suggest: r.reorderLevel * 2 - r.stock }));
}
