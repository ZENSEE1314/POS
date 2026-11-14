import type { Db } from './db.ts';
import { DomainError } from './db.ts';
import type { Actor } from './auth.ts';
import { require_ } from './auth.ts';
import { addLine } from './bills.ts';
import { businessOf, requireModule } from './business.ts';
import { weightFromPrice } from './pricing.ts';

const BARCODE_PATTERN = /^[0-9A-Za-z-]{1,32}$/;
/** In-store EAN-13 (prefix 2) as printed by shop scales: 2 + 6-digit item code + 5-digit value + check digit. */
const SCALE_LABEL_PATTERN = /^2\d{12}$/;
const PLU_END = 7;
const VALUE_END = 12;
const EAN_LENGTH = 13;

export function cleanBarcode(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
  if (!BARCODE_PATTERN.test(s)) throw new DomainError('barcode: 1-32 letters, digits or hyphens', 422);
  return s;
}

/** EAN-13 check digit: weights 1,3,1,3... over the first 12 digits. */
export function ean13Valid(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  const sum = [...code.slice(0, EAN_LENGTH - 1)].reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(code[EAN_LENGTH - 1]);
}

export function parseScaleLabel(code: string): { plu: string; value: number } | null {
  if (!SCALE_LABEL_PATTERN.test(code) || !ean13Valid(code)) return null;
  return { plu: code.slice(1, PLU_END), value: Number(code.slice(PLU_END, VALUE_END)) };
}

export type ScanResult =
  | { lineId: number; productId: number }
  | { needsWeight: true; product: { id: number; name: string; nameEn: string | null; price: number } };

/**
 * One scan at the till. A product's own barcode adds qty of it (an item sold by weight asks for its weight instead).
 * A scale label adds the weighed portion: the label's price as printed, or its weight at today's price, depending on
 * the company's scale setting.
 */
export async function scanCode(db: Db, actor: Actor, billId: number, rawCode: unknown, qty = 1): Promise<ScanResult> {
  require_(actor, 'order.add');
  await requireModule(db, actor.tenantId, 'barcode');
  const code = cleanBarcode(rawCode);
  const find = (c: string) => db.one('SELECT * FROM products WHERE store_id = ? AND barcode = ? AND active', [actor.storeId, c]);
  const p = await find(code);
  if (p) {
    if (p.unit === 'kg') return { needsWeight: true, product: { id: p.id, name: p.name, nameEn: p.name_en, price: p.price } };
    return { lineId: await addLine(db, actor, billId, { productId: p.id, qty }), productId: p.id };
  }
  const label = parseScaleLabel(code);
  const item = label && (await find(label.plu));
  if (!label || !item) throw new DomainError('no product has this barcode', 404);
  if (label.value <= 0) throw new DomainError('this scale label has no amount on it', 422);
  const { scaleMode } = await businessOf(db, actor.tenantId);
  const weighed = item.unit === 'kg';
  if (scaleMode === 'weight') {
    if (!weighed) throw new DomainError('this label carries a weight but the item is not sold by weight', 422);
    return { lineId: await addLine(db, actor, billId, { productId: item.id, qty: 1, weightG: label.value }), productId: item.id };
  }
  const input = { productId: item.id, qty: 1, weightG: weighed ? weightFromPrice(label.value, item.price) : undefined };
  return { lineId: await addLine(db, actor, billId, input, label.value), productId: item.id };
}
