import type { Db } from './db.ts';
import { hasModule } from './business.ts';

const GRAMS_PER_KG = 1000;
const PERCENT = 100;

export interface Price { unitPrice: number; note: string | null }

/**
 * The price a product sells at on this bill right now: the lowest of the list price, the member price (when the bill
 * has a member) and any running promotion for the product or its category. For items sold by weight the prices are
 * per kg; the caller turns them into a line price with linePrice().
 */
export async function priceFor(db: Db, product: any, hasMember: boolean, now = Date.now()): Promise<Price> {
  let best: Price = { unitPrice: product.price, note: null };
  const consider = (unitPrice: number, note: string) => {
    if (unitPrice < best.unitPrice) best = { unitPrice, note };
  };
  if (hasMember && product.member_price != null) consider(product.member_price, 'member');
  const store = await db.one('SELECT tenant_id FROM stores WHERE id = ?', [product.store_id]);
  if (!(await hasModule(db, store.tenant_id, 'promotions'))) return best;
  const promos = await db.all(
    `SELECT * FROM promotions WHERE store_id = ? AND active AND starts_at <= ? AND ends_at > ?
       AND (product_id = ? OR (product_id IS NULL AND (category IS NULL OR category = ?)))`,
    [product.store_id, now, now, product.id, product.category]);
  for (const p of promos) {
    if (p.members_only && !hasMember) continue;
    consider(p.kind === 'price' ? p.value : Math.round((product.price * (PERCENT - p.value)) / PERCENT), `promo:${p.name}`);
  }
  return best;
}

/** Price of a weighed portion, rounded to the fen. */
export const linePrice = (pricePerKg: number, weightG: number): number => Math.round((pricePerKg * weightG) / GRAMS_PER_KG);

/** Weight implied by a scale label that carries only the price, so stock still goes down by roughly the right amount. */
export const weightFromPrice = (labelPrice: number, pricePerKg: number): number =>
  Math.max(1, pricePerKg > 0 ? Math.round((labelPrice * GRAMS_PER_KG) / pricePerKg) : 1);
