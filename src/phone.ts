import { DomainError } from './db.ts';

const MIN_PHONE_LENGTH = 3;
const MAX_PHONE_LENGTH = 32;
const CN_COUNTRY_PREFIX = /^\+86(\d{11})$/;

/**
 * Staff type numbers as "138 0013 8000", "138-0013-8000" or "+86 138...". One canonical form
 * keeps a guest from ending up with two wallets and two stashes. Never throws (used for lookups).
 */
export function normalizePhone(v: unknown): string {
  const raw = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : typeof v === 'string' ? v : '';
  const compact = raw.replace(/[\s\-().]/g, '');
  return CN_COUNTRY_PREFIX.exec(compact)?.[1] ?? compact;
}

/** Normalised phone for writes: refuses blank or absurd values. */
export function cleanPhone(v: unknown): string {
  const phone = normalizePhone(v);
  if (phone.length < MIN_PHONE_LENGTH || phone.length > MAX_PHONE_LENGTH) throw new DomainError(`phone is required (${MIN_PHONE_LENGTH}-${MAX_PHONE_LENGTH} characters)`, 422);
  return phone;
}
