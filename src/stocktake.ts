// Stocktakes (盘点) and stock transfers between stores (调拨).
// A stocktake snapshots what the system thinks is on the shelf; staff type what they counted; closing it moves each
// product's stock by (counted - expected), so sales rung up while counting are not lost.
// A transfer takes stock off the sending store at once and adds it to the receiving store when that store confirms it.
import type { Db } from './db.ts';
import { audit, DomainError } from './db.ts';
import type { Actor } from './auth.ts';
import { require_, whoOf } from './auth.ts';

const MAX_NOTE = 200;
const LIST_LIMIT = 100;
const note = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, MAX_NOTE) : '');
const wholeNumber = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : Number.NaN);

// ---------- stocktakes ----------

export async function startStocktake(db: Db, actor: Actor, b: Record<string, unknown>): Promise<number> {
  require_(actor, 'admin.write');
  return db.tx(async (t) => {
    if (await t.one("SELECT 1 AS x FROM stocktakes WHERE store_id = ? AND status = 'open'", [actor.storeId])) {
      throw new DomainError('a stocktake is already open for this store; finish or cancel it first', 409);
    }
    const id = await t.insert('INSERT INTO stocktakes (store_id, note, created_by, created_at) VALUES (?,?,?,?)',
      [actor.storeId, note(b.note), actor.id, Date.now()]);
    await t.run(`INSERT INTO stocktake_lines (stocktake_id, product_id, expected)
      SELECT ?, id, stock FROM products WHERE store_id = ? AND active AND track_stock`, [id, actor.storeId]);
    await audit(t, whoOf(actor), 'stocktake.start', 'stocktake', id, {});
    return id;
  });
}

export async function listStocktakes(db: Db, actor: Actor) {
  require_(actor, 'admin.write');
  const rows = await db.all(`SELECT s.id, s.status, s.note, s.created_at, s.closed_at, e.name AS created_by,
      (SELECT COUNT(*) FROM stocktake_lines l WHERE l.stocktake_id = s.id) AS lines,
      (SELECT COUNT(*) FROM stocktake_lines l WHERE l.stocktake_id = s.id AND l.counted IS NOT NULL AND l.counted <> l.expected) AS differences
    FROM stocktakes s JOIN employees e ON e.id = s.created_by WHERE s.store_id = ? ORDER BY s.created_at DESC LIMIT ?`, [actor.storeId, LIST_LIMIT]);
  return rows.map((r) => ({
    id: Number(r.id), status: r.status, note: r.note, createdAt: Number(r.created_at), closedAt: r.closed_at === null ? null : Number(r.closed_at),
    createdBy: r.created_by, lines: Number(r.lines), differences: Number(r.differences),
  }));
}

export async function getStocktake(db: Db, actor: Actor, id: number) {
  require_(actor, 'admin.write');
  const s = await db.one('SELECT * FROM stocktakes WHERE id = ? AND store_id = ?', [id, actor.storeId]);
  if (!s) throw new DomainError('stocktake not found', 404);
  const lines = await db.all(`SELECT l.product_id, l.expected, l.counted, p.name, p.category, p.unit, p.cost
    FROM stocktake_lines l JOIN products p ON p.id = l.product_id WHERE l.stocktake_id = ? ORDER BY p.category, p.name`, [id]);
  const view = lines.map((l) => {
    const counted = l.counted === null ? null : Number(l.counted);
    const diff = counted === null ? null : counted - Number(l.expected);
    return {
      productId: Number(l.product_id), name: l.name, category: l.category, unit: l.unit, expected: Number(l.expected), counted, diff,
      // kg products are stocked in grams and costed per kg
      costDiff: diff === null ? null : Math.round((diff * Number(l.cost)) / (l.unit === 'kg' ? 1000 : 1)),
    };
  });
  return {
    id: Number(s.id), status: s.status, note: s.note, createdAt: Number(s.created_at), lines: view,
    counted: view.filter((l) => l.counted !== null).length,
    costDiff: view.reduce((a, l) => a + (l.costDiff ?? 0), 0),
  };
}

/** Saves counts: `{ counts: { [productId]: counted } }`; null clears a count. */
export async function saveCounts(db: Db, actor: Actor, id: number, b: Record<string, unknown>): Promise<void> {
  require_(actor, 'admin.write');
  const counts = b.counts;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) throw new DomainError('counts must be an object', 422);
  await db.tx(async (t) => {
    await openStocktake(t, actor, id);
    for (const [productId, raw] of Object.entries(counts as Record<string, unknown>)) {
      const counted = raw === null ? null : wholeNumber(raw);
      if (counted !== null && (Number.isNaN(counted) || counted < 0)) throw new DomainError('counts must be whole numbers, 0 or more', 422);
      const n = await t.run('UPDATE stocktake_lines SET counted = ? WHERE stocktake_id = ? AND product_id = ?', [counted, id, Number(productId)]);
      if (!n) throw new DomainError(`product ${productId} is not in this stocktake`, 422);
    }
  });
}

/** Applies the counted lines to stock. Lines nobody counted are left alone. */
export async function closeStocktake(db: Db, actor: Actor, id: number): Promise<{ adjusted: number }> {
  require_(actor, 'admin.write');
  return db.tx(async (t) => {
    await openStocktake(t, actor, id);
    const lines = await t.all('SELECT product_id, expected, counted FROM stocktake_lines WHERE stocktake_id = ? AND counted IS NOT NULL AND counted <> expected', [id]);
    for (const l of lines) {
      await t.run('UPDATE products SET stock = stock + ? WHERE id = ? AND store_id = ?', [Number(l.counted) - Number(l.expected), l.product_id, actor.storeId]);
    }
    await t.run("UPDATE stocktakes SET status = 'closed', closed_by = ?, closed_at = ? WHERE id = ?", [actor.id, Date.now(), id]);
    await audit(t, whoOf(actor), 'stocktake.close', 'stocktake', id, {
      adjustments: lines.map((l) => ({ productId: Number(l.product_id), diff: Number(l.counted) - Number(l.expected) })),
    });
    return { adjusted: lines.length };
  });
}

export async function cancelStocktake(db: Db, actor: Actor, id: number): Promise<void> {
  require_(actor, 'admin.write');
  await db.tx(async (t) => {
    await openStocktake(t, actor, id);
    await t.run("UPDATE stocktakes SET status = 'cancelled', closed_by = ?, closed_at = ? WHERE id = ?", [actor.id, Date.now(), id]);
    await audit(t, whoOf(actor), 'stocktake.cancel', 'stocktake', id, {});
  });
}

async function openStocktake(t: Db, actor: Actor, id: number) {
  const s = await t.one('SELECT status FROM stocktakes WHERE id = ? AND store_id = ? FOR UPDATE', [id, actor.storeId]);
  if (!s) throw new DomainError('stocktake not found', 404);
  if (s.status !== 'open') throw new DomainError(`this stocktake is ${s.status}`, 409);
}

// ---------- transfers ----------

/** `{ toStoreId, items: [{ productId, qty }], note }`: stock leaves this store now. */
export async function sendTransfer(db: Db, actor: Actor, b: Record<string, unknown>): Promise<number> {
  require_(actor, 'admin.write');
  const toStoreId = Number(b.toStoreId);
  if (toStoreId === actor.storeId) throw new DomainError('pick another store to send to', 422);
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) throw new DomainError('add at least one product', 422);
  return db.tx(async (t) => {
    if (!(await t.one('SELECT 1 AS x FROM stores WHERE id = ? AND tenant_id = ? AND active', [toStoreId, actor.tenantId]))) {
      throw new DomainError('store not found', 404);
    }
    const id = await t.insert('INSERT INTO stock_transfers (tenant_id, from_store_id, to_store_id, note, created_by, created_at) VALUES (?,?,?,?,?,?)',
      [actor.tenantId, actor.storeId, toStoreId, note(b.note), actor.id, Date.now()]);
    const seen = new Set<number>();
    for (const item of items as Array<Record<string, unknown>>) {
      const productId = Number(item?.productId);
      const qty = wholeNumber(item?.qty);
      if (!(qty > 0)) throw new DomainError('each quantity must be a whole number above 0', 422);
      if (seen.has(productId)) throw new DomainError('each product only once per transfer', 422);
      seen.add(productId);
      const p = await t.one('SELECT id, name, stock, track_stock FROM products WHERE id = ? AND store_id = ? FOR UPDATE', [productId, actor.storeId]);
      if (!p) throw new DomainError(`product ${productId} not found in this store`, 404);
      if (p.track_stock && Number(p.stock) < qty) throw new DomainError(`only ${p.stock} of ${p.name} in stock`, 409);
      await t.run('UPDATE products SET stock = stock - ? WHERE id = ?', [qty, productId]);
      await t.run('INSERT INTO stock_transfer_lines (transfer_id, product_id, name, qty) VALUES (?,?,?,?)', [id, productId, p.name, qty]);
    }
    await audit(t, whoOf(actor), 'transfer.send', 'stock_transfer', id, { toStoreId, items });
    return id;
  });
}

export async function listTransfers(db: Db, actor: Actor) {
  require_(actor, 'admin.write');
  const rows = await db.all(`SELECT x.*, f.name AS from_name, s.name AS to_name, e.name AS created_by_name
    FROM stock_transfers x JOIN stores f ON f.id = x.from_store_id JOIN stores s ON s.id = x.to_store_id JOIN employees e ON e.id = x.created_by
    WHERE x.tenant_id = ? AND (x.from_store_id = ? OR x.to_store_id = ?) ORDER BY x.created_at DESC LIMIT ?`,
  [actor.tenantId, actor.storeId, actor.storeId, LIST_LIMIT]);
  const lines = rows.length
    ? await db.all(`SELECT transfer_id, product_id, name, qty FROM stock_transfer_lines WHERE transfer_id IN (${rows.map(() => '?').join(',')})`, rows.map((r) => r.id))
    : [];
  return rows.map((r) => ({
    id: Number(r.id), status: r.status, note: r.note, createdAt: Number(r.created_at), createdBy: r.created_by_name,
    from: { id: Number(r.from_store_id), name: r.from_name }, to: { id: Number(r.to_store_id), name: r.to_name },
    incoming: Number(r.to_store_id) === actor.storeId,
    items: lines.filter((l) => Number(l.transfer_id) === Number(r.id)).map((l) => ({ name: l.name, qty: Number(l.qty) })),
  }));
}

/** The receiving store confirms: each product is matched by name in this store. */
export async function receiveTransfer(db: Db, actor: Actor, id: number): Promise<void> {
  require_(actor, 'admin.write');
  await db.tx(async (t) => {
    const x = await sentTransfer(t, actor, id, 'to');
    const lines = await t.all('SELECT name, qty FROM stock_transfer_lines WHERE transfer_id = ?', [id]);
    const missing: string[] = [];
    for (const l of lines) {
      const n = await t.run('UPDATE products SET stock = stock + ? WHERE store_id = ? AND name = ?', [Number(l.qty), actor.storeId, l.name]);
      if (!n) missing.push(l.name);
    }
    if (missing.length) throw new DomainError(`add these products to this store first: ${missing.join(', ')}`, 409);
    await t.run("UPDATE stock_transfers SET status = 'received', closed_by = ?, closed_at = ? WHERE id = ?", [actor.id, Date.now(), id]);
    await audit(t, whoOf(actor), 'transfer.receive', 'stock_transfer', id, { from: Number(x.from_store_id) });
  });
}

/** The sending store takes a transfer back before it is received; the stock returns. */
export async function cancelTransfer(db: Db, actor: Actor, id: number): Promise<void> {
  require_(actor, 'admin.write');
  await db.tx(async (t) => {
    await sentTransfer(t, actor, id, 'from');
    for (const l of await t.all('SELECT product_id, qty FROM stock_transfer_lines WHERE transfer_id = ?', [id])) {
      await t.run('UPDATE products SET stock = stock + ? WHERE id = ?', [Number(l.qty), l.product_id]);
    }
    await t.run("UPDATE stock_transfers SET status = 'cancelled', closed_by = ?, closed_at = ? WHERE id = ?", [actor.id, Date.now(), id]);
    await audit(t, whoOf(actor), 'transfer.cancel', 'stock_transfer', id, {});
  });
}

async function sentTransfer(t: Db, actor: Actor, id: number, side: 'from' | 'to') {
  const x = await t.one(`SELECT * FROM stock_transfers WHERE id = ? AND tenant_id = ? AND ${side}_store_id = ? FOR UPDATE`, [id, actor.tenantId, actor.storeId]);
  if (!x) throw new DomainError('transfer not found', 404);
  if (x.status !== 'sent') throw new DomainError(`this transfer is ${x.status}`, 409);
  return x;
}
