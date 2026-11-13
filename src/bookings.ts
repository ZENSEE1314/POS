import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.ts';
import { audit, DomainError } from './db.ts';
import type { Actor } from './auth.ts';
import { require_, whoOf } from './auth.ts';
import { totals } from './bills.ts';
import { cleanPhone } from './phone.ts';

const DEFAULT_PARTY_SIZE = 2;
const MAX_PARTY_SIZE = 1000;
const MAX_EPOCH_MS = 32_503_680_000_000; // year 3000: anything later is a typo, and keeps BIGINT safe
const MAX_VOUCHER_FEN = 1_000_000_000;
const MAX_TEXT_LENGTH = 200;

export interface NewBooking {
  phone: string;
  name?: string;
  partySize?: number;
  eta: number;
  tableId?: number;
  repId?: number;
}

/** Epoch ms as a number or a digit string; anything else would reach SQL as NaN or overflow and surface as a 500. */
function toEpochMs(v: unknown): number {
  const n = typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v.trim())) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0 || n > MAX_EPOCH_MS) throw new DomainError('eta must be epoch milliseconds', 422);
  return n;
}

function toPartySize(v: unknown): number {
  if (v == null) return DEFAULT_PARTY_SIZE;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_PARTY_SIZE) throw new DomainError(`partySize must be an integer 1..${MAX_PARTY_SIZE}`, 422);
  return v;
}

function toOptionalText(v: unknown, name: string): string {
  if (v == null) return '';
  if (typeof v !== 'string' || v.length > MAX_TEXT_LENGTH) throw new DomainError(`${name} must be text up to ${MAX_TEXT_LENGTH} characters`, 422);
  return v;
}

function toOptionalId(v: unknown, name: string): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isSafeInteger(n)) throw new DomainError(`${name} must be an integer`, 422);
  return n;
}

/** A booking may only point at a table of this store and a rep who works here (or is tenant-wide), as openTable enforces. */
async function assertTableAndRep(t: Db, actor: Actor, tableId: number | null, repId: number | null): Promise<void> {
  if (tableId !== null && !(await t.one('SELECT id FROM dining_tables WHERE id = ? AND store_id = ?', [tableId, actor.storeId]))) throw new DomainError('table not found in this store', 404);
  if (repId !== null && !(await t.one('SELECT id FROM employees WHERE id = ? AND tenant_id = ? AND (store_id = ? OR store_id IS NULL) AND active', [repId, actor.tenantId, actor.storeId]))) {
    throw new DomainError('sales rep not found in this store', 422);
  }
}

export async function createBooking(db: Db, actor: Actor, input: NewBooking): Promise<number> {
  require_(actor, 'booking.create');
  const phone = cleanPhone(input.phone);
  const name = toOptionalText(input.name, 'name');
  const partySize = toPartySize(input.partySize);
  const eta = toEpochMs(input.eta);
  const tableId = toOptionalId(input.tableId, 'tableId');
  const repId = toOptionalId(input.repId, 'repId');
  return db.tx(async (t) => {
    await assertTableAndRep(t, actor, tableId, repId);
    const id = await t.insert(
      `INSERT INTO bookings (store_id, source, phone, name, party_size, eta, table_id, rep_id, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`, [actor.storeId, 'manual', phone, name, partySize, eta, tableId, repId, 'confirmed', Date.now()]);
    await audit(t, whoOf(actor), 'booking.create', 'booking', id, { ...input, phone });
    return id;
  });
}

export async function confirmBooking(db: Db, actor: Actor, bookingId: number, tableId: number, repId: number): Promise<void> {
  require_(actor, 'booking.create');
  await db.tx(async (t) => {
    const b = await t.one('SELECT * FROM bookings WHERE id = ? AND store_id = ? FOR UPDATE', [bookingId, actor.storeId]);
    if (!b) throw new DomainError('booking not found', 404);
    if (b.status !== 'submitted') throw new DomainError(`booking is ${b.status}`, 409);
    await assertTableAndRep(t, actor, tableId, repId);
    await t.run("UPDATE bookings SET status = 'confirmed', table_id = ?, rep_id = ? WHERE id = ?", [tableId, repId, bookingId]);
    await audit(t, whoOf(actor), 'booking.confirm', 'booking', bookingId, { tableId, repId });
  });
}

export async function cancelBooking(db: Db, actor: Actor, bookingId: number, status: "cancelled" | "no_show"): Promise<void> {
  require_(actor, "booking.create");
  await db.tx(async (t) => {
    const n = await t.run("UPDATE bookings SET status = ? WHERE id = ? AND store_id = ? AND status IN ('submitted', 'confirmed')", [status, bookingId, actor.storeId]);
    if (!n) throw new DomainError("booking not found or already used", 404);
    await audit(t, whoOf(actor), `booking.${status}`, "booking", bookingId, {});
  });
}

export function listBookings(db: Db, actor: Actor, statuses = ['submitted', 'confirmed']) {
  return db.all('SELECT * FROM bookings WHERE store_id = ? AND status = ANY(?) ORDER BY eta', [actor.storeId, statuses]);
}

/**
 * Douyin Life Services webhook (booking submitted).
 * ASSUMPTION: HMAC-SHA256(rawBody, DOUYIN_WEBHOOK_SECRET) in `x-douyin-signature` and the normalised payload below.
 * Align both with the official docs once the merchant/developer account is approved.
 * `poiId` identifies the physical store; it is mapped through stores.douyin_poi_id.
 */
export interface DouyinBookingEvent {
  eventId: string;
  type: 'booking.created';
  data: { poiId: string; bookingId: string; phone: string; name?: string; partySize?: number; eta: number; voucherCode?: string; voucherAmount?: number };
}

export function verifyDouyinSignature(secret: string, rawBody: string, signatureHex: string | undefined): boolean {
  if (!secret || !signatureHex) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(signatureHex, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The payload is signed but still third-party input: a malformed event gets a 422 instead of a 500 that Douyin would retry forever. */
function parseDouyinData(ev: unknown) {
  const d = (ev as { data?: unknown } | null)?.data as Record<string, unknown> | null | undefined;
  if (d === null || d === undefined || typeof d !== 'object' || Array.isArray(d)) throw new DomainError('data object required', 422);
  const text = (v: unknown, name: string): string => {
    const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : typeof v === 'string' ? v.trim() : '';
    if (!s || s.length > MAX_TEXT_LENGTH) throw new DomainError(`${name} is required`, 422);
    return s;
  };
  const voucherAmount = d.voucherAmount ?? 0;
  if (typeof voucherAmount !== 'number' || !Number.isInteger(voucherAmount) || voucherAmount < 0 || voucherAmount > MAX_VOUCHER_FEN) throw new DomainError('voucherAmount must be fen', 422);
  return {
    poiId: text(d.poiId, 'poiId'), bookingId: text(d.bookingId, 'bookingId'), phone: cleanPhone(d.phone), name: toOptionalText(d.name, 'name'),
    partySize: toPartySize(d.partySize), eta: toEpochMs(d.eta), voucherCode: d.voucherCode == null ? null : text(d.voucherCode, 'voucherCode'), voucherAmount,
  };
}

/** Idempotent on (source, external_id): Douyin retries never create duplicate bookings. */
export async function ingestDouyinBooking(db: Db, ev: DouyinBookingEvent): Promise<{ bookingId: number; storeId: number; duplicate: boolean }> {
  const d = parseDouyinData(ev);
  const store = await db.one('SELECT id, tenant_id FROM stores WHERE douyin_poi_id = ? AND active', [d.poiId]);
  if (!store) throw new DomainError(`no store mapped to Douyin poi ${d.poiId}`, 422);
  return db.tx(async (t) => {
    const existing = await t.one("SELECT id, store_id FROM bookings WHERE source = 'douyin' AND external_id = ?", [d.bookingId]);
    if (existing) return { bookingId: existing.id, storeId: existing.store_id, duplicate: true };
    const id = await t.insert(
      `INSERT INTO bookings (store_id, source, external_id, phone, name, party_size, eta, status, voucher_code, voucher_amount, created_at)
       VALUES (?,?,?,?,?,?,?,'submitted',?,?,?)`, [store.id, 'douyin', d.bookingId, d.phone, d.name, d.partySize, d.eta, d.voucherCode, d.voucherAmount, Date.now()]);
    await audit(t, { tenantId: store.tenant_id, storeId: store.id }, 'booking.douyin', 'booking', id, ev);
    return { bookingId: id, storeId: store.id, duplicate: false };
  });
}

/**
 * Redeems a Douyin voucher as a payment on an open bill. The voucher check goes through the
 * injected verifier so it can be mocked now and wired to the real API after approval.
 */
export type VoucherVerifier = (code: string) => Promise<{ valid: boolean; amountFen: number; ref: string }>;

export async function redeemVoucher(db: Db, actor: Actor, verify: VoucherVerifier, billId: number, code: string): Promise<number> {
  require_(actor, 'bill.settle');
  const v = await verify(code);
  if (!v.valid) throw new DomainError('voucher invalid or already used', 409);
  return db.tx(async (t) => {
    const bill = await t.one("SELECT id FROM bills WHERE id = ? AND store_id = ? AND status = 'open' FOR UPDATE", [billId, actor.storeId]);
    if (!bill) throw new DomainError('open bill not found', 404);
    // Two bills redeeming one code lock different bill rows; serialise on the voucher itself so the reuse check is race-free.
    await t.run('SELECT pg_advisory_xact_lock(hashtext(?))', [`voucher:${v.ref}`]);
    const used = await t.one("SELECT 1 AS x FROM payments WHERE method = 'douyin_voucher' AND provider_ref = ?", [v.ref]);
    if (used) throw new DomainError('voucher already redeemed', 409);
    // A voucher pays at most what is due: no change is given and the excess is not counted as revenue.
    const applied = Math.min(v.amountFen, (await totals(t, billId)).due);
    if (applied <= 0) throw new DomainError('nothing due on this bill', 409);
    await t.run("INSERT INTO payments (bill_id, method, amount, status, provider_ref, created_at, paid_at) VALUES (?,?,?,'paid',?,?,?)", [billId, 'douyin_voucher', applied, v.ref, Date.now(), Date.now()]);
    await audit(t, whoOf(actor), 'pay.douyin_voucher', 'bill', billId, { code, faceValue: v.amountFen, applied });
    return applied;
  });
}

export const mockVoucherVerifier: VoucherVerifier = async (code) => {
  // Mock codes look like DY-<yuan>-<anything>; real verification calls Douyin after account approval.
  const m = /^DY-(\d+)-/.exec(code);
  return m ? { valid: true, amountFen: Number(m[1]) * 100, ref: `mockvoucher_${code}` } : { valid: false, amountFen: 0, ref: code };
};

export const liveVoucherVerifier: VoucherVerifier = async () => {
  throw new DomainError('Douyin live voucher verification is not wired yet: needs approved 抖音来客 account and verified API endpoints', 501);
};
