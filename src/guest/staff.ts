import type { Db } from '../db.ts';
import { audit, DomainError } from '../db.ts';
import type { Actor } from '../auth.ts';
import { require_, whoOf } from '../auth.ts';
import { addLine, openTable, openTablelessBill } from '../bills.ts';

const ORDER_STATUSES = ['pending', 'accepted', 'rejected', 'cancelled'];
const LIST_LIMIT = 100;
const MAX_REASON = 200;
/** Steps of a pickup or delivery order after staff accept it. */
const FULFIL_STEPS: Record<string, string[]> = { pickup: ['ready', 'done'], delivery: ['out', 'done'] };

/** Guest orders for this store, newest first, with items and who placed them. */
export async function listGuestOrders(db: Db, actor: Actor, status = 'pending') {
  require_(actor, 'order.add');
  if (!ORDER_STATUSES.includes(status)) throw new DomainError('unknown status', 422);
  const orders = await db.all(
    `SELECT o.id, o.status, o.note, o.reject_reason AS "rejectReason", o.created_at AS "createdAt", o.decided_at AS "decidedAt", o.bill_id AS "billId",
            o.table_id AS "tableId", d.name AS "tableName", g.name AS "toTableName", c.display_name AS "guestName", c.phone AS "guestPhone",
            o.mode, o.address, o.pickup_at AS "pickupAt", o.fulfil_status AS "fulfilStatus",
            (SELECT b.id FROM bills b WHERE b.table_id = o.table_id AND b.status = 'open') AS "openBillId",
            (SELECT b.status FROM bills b WHERE b.id = o.bill_id) AS "billStatus"
     FROM guest_orders o LEFT JOIN dining_tables d ON d.id = o.table_id JOIN customers c ON c.id = o.customer_id
     LEFT JOIN dining_tables g ON g.id = o.to_table_id
     WHERE o.store_id = ? AND o.status = ? ORDER BY o.id ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT ?`, [actor.storeId, status, LIST_LIMIT]);
  if (!orders.length) return [];
  const items = await db.all(
    `SELECT i.order_id AS "orderId", i.product_id AS "productId", i.name, p.name_en AS "nameEn", p.station, i.qty, i.unit_price AS "unitPrice"
     FROM guest_order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = ANY(?) ORDER BY i.id`, [orders.map((o) => o.id)]);
  return orders.map((o) => ({ ...o, items: items.filter((i) => i.orderId === o.id) }));
}

export async function pendingGuestOrderCount(db: Db, actor: Actor): Promise<{ pending: number; orders: number; requests: number }> {
  require_(actor, 'order.add');
  const r = await db.one(
    `SELECT (SELECT COUNT(*) FROM guest_orders WHERE store_id = ? AND status = 'pending') AS orders,
            (SELECT COUNT(*) FROM guest_requests WHERE store_id = ? AND status = 'pending') AS requests`, [actor.storeId, actor.storeId]);
  return { pending: r.orders + r.requests, orders: r.orders, requests: r.requests };
}

/**
 * Staff confirm what the guest asked for. The items go onto the table's open bill through the normal addLine path
 * (current prices, stock and commission rules, the accepting staff member as the waiter). A free table is opened
 * first, which needs a sales rep exactly as when staff open it themselves.
 */
export async function acceptGuestOrder(db: Db, actor: Actor, orderId: number, repId?: number) {
  require_(actor, 'order.add');
  return db.tx(async (t) => {
    const o = await t.one('SELECT * FROM guest_orders WHERE id = ? AND store_id = ? FOR UPDATE', [orderId, actor.storeId]);
    if (!o) throw new DomainError('order not found', 404);
    if (o.status !== 'pending') throw new DomainError(`order is ${o.status}`, 409);
    let billId = o.table_id ? (await t.one("SELECT id FROM bills WHERE table_id = ? AND status = 'open'", [o.table_id]))?.id as number | undefined : undefined;
    let opened = false;
    if (!o.table_id) {
      // Pickup / delivery: its own sale with no table, owned by whoever accepts it, listed under Checkout until paid.
      const phone = (await t.one('SELECT phone FROM customers WHERE id = ?', [o.customer_id]))?.phone ?? undefined;
      billId = await openTablelessBill(t, actor, o.mode, actor.id, phone);
      opened = true;
    } else if (!billId) {
      if (!repId) throw new DomainError('this table is not open: choose a sales rep to open it', 422);
      const phone = (await t.one('SELECT phone FROM customers WHERE id = ?', [o.customer_id]))?.phone ?? undefined;
      billId = await openTable(t, actor, { tableId: o.table_id, repId, phone });
      opened = true;
    }
    const items = await t.all('SELECT product_id, qty FROM guest_order_items WHERE order_id = ? ORDER BY id', [orderId]);
    const lines = [];
    for (const it of items) lines.push({ lineId: await addLine(t, actor, billId, { productId: it.product_id, qty: it.qty }), productId: it.product_id, qty: it.qty });
    await t.run("UPDATE guest_orders SET status = 'accepted', bill_id = ?, decided_at = ?, decided_by = ? WHERE id = ?", [billId, Date.now(), actor.id, orderId]);
    await audit(t, whoOf(actor), 'guest.order.accept', 'guest_order', orderId, { billId, opened });
    return { billId, opened, lines };
  });
}

/** Pickup: ready -> done (collected). Delivery: out (on its way) -> done (delivered). The guest sees each step. */
export async function fulfilGuestOrder(db: Db, actor: Actor, orderId: number, step: unknown): Promise<void> {
  require_(actor, 'order.add');
  await db.tx(async (t) => {
    const o = await t.one('SELECT * FROM guest_orders WHERE id = ? AND store_id = ? FOR UPDATE', [orderId, actor.storeId]);
    if (!o) throw new DomainError('order not found', 404);
    const steps = FULFIL_STEPS[o.mode];
    if (!steps || o.status !== 'accepted') throw new DomainError('only accepted pickup or delivery orders have these steps', 409);
    if (typeof step !== 'string' || !steps.includes(step)) throw new DomainError(`step must be one of ${steps.join(', ')}`, 422);
    if (o.fulfil_status === 'done') throw new DomainError('this order is already done', 409);
    await t.run('UPDATE guest_orders SET fulfil_status = ? WHERE id = ?', [step, orderId]);
    await audit(t, whoOf(actor), 'guest.order.fulfil', 'guest_order', orderId, { step });
  });
}

export async function rejectGuestOrder(db: Db, actor: Actor, orderId: number, reason: unknown): Promise<void> {
  require_(actor, 'order.add');
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (!why || why.length > MAX_REASON) throw new DomainError('a reason is required (shown to the guest)', 422);
  await db.tx(async (t) => {
    const n = await t.run("UPDATE guest_orders SET status = 'rejected', reject_reason = ?, decided_at = ?, decided_by = ? WHERE id = ? AND store_id = ? AND status = 'pending'",
      [why, Date.now(), actor.id, orderId, actor.storeId]);
    if (!n) throw new DomainError('order not found or already handled', 404);
    await audit(t, whoOf(actor), 'guest.order.reject', 'guest_order', orderId, { reason: why });
  });
}

/** A new QR token makes every printed code for that table stop working (e.g. a photo of it was shared). */
export async function renewTableQr(db: Db, actor: Actor, tableId: number): Promise<{ qrToken: string }> {
  require_(actor, 'admin.write');
  const r = await db.one("UPDATE dining_tables SET qr_token = replace(gen_random_uuid()::text, '-', '') WHERE id = ? AND store_id = ? RETURNING qr_token", [tableId, actor.storeId]);
  if (!r) throw new DomainError('table not found', 404);
  await audit(db, whoOf(actor), 'table.qr_renew', 'table', tableId, {});
  return { qrToken: r.qr_token };
}
