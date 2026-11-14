import type { Db } from './db.ts';
import type { Actor } from './auth.ts';
import { cancelPurchaseOrder, createPurchaseOrder, listPurchaseOrders, listSuppliers, lowStock, markOrdered, receivePurchaseOrder, saveSupplier } from './purchasing.ts';
import { listPromotions, savePromotion } from './promotions.ts';

interface Ctx { db: Db; actor: Actor; params: string[]; body: any; query: URLSearchParams }
type RouteFn = (method: string, path: string, auth: boolean, handler: (ctx: Ctx) => unknown) => void;

/** Suppliers, purchase orders, low stock and promotions (each behind its module switch). */
export function registerStockRoutes(route: RouteFn, { num }: { num: (v: unknown) => number }): void {
  route('GET', '/api/suppliers', true, ({ db, actor }) => listSuppliers(db, actor));
  route('POST', '/api/suppliers', true, async ({ db, actor, body }) => ({ supplierId: await saveSupplier(db, actor, null, body) }));
  route('PATCH', '/api/suppliers/:id', true, async ({ db, actor, params, body }) => ({ supplierId: await saveSupplier(db, actor, num(params[0]), body) }));

  route('GET', '/api/purchase-orders', true, ({ db, actor, query }) => listPurchaseOrders(db, actor, query.get('status') ?? undefined));
  route('POST', '/api/purchase-orders', true, async ({ db, actor, body }) => ({ poId: await createPurchaseOrder(db, actor, body) }));
  route('POST', '/api/purchase-orders/:id/order', true, async ({ db, actor, params }) => {
    await markOrdered(db, actor, num(params[0]));
    return { ok: true };
  });
  route('POST', '/api/purchase-orders/:id/cancel', true, async ({ db, actor, params }) => {
    await cancelPurchaseOrder(db, actor, num(params[0]));
    return { ok: true };
  });
  route('POST', '/api/purchase-orders/:id/receive', true, async ({ db, actor, params, body }) => {
    await receivePurchaseOrder(db, actor, num(params[0]), body.received ?? {});
    return { ok: true };
  });
  route('GET', '/api/low-stock', true, ({ db, actor }) => lowStock(db, actor));

  route('GET', '/api/promotions', true, ({ db, actor }) => listPromotions(db, actor));
  route('POST', '/api/promotions', true, async ({ db, actor, body }) => ({ promotionId: await savePromotion(db, actor, null, body) }));
  route('PATCH', '/api/promotions/:id', true, async ({ db, actor, params, body }) => ({ promotionId: await savePromotion(db, actor, num(params[0]), body) }));
}
