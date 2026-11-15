import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { hashPin, verifyPin } from '../auth.ts';
import type { Db } from '../db.ts';
import { DomainError } from '../db.ts';
import type { IdentityProfile, LoginProvider } from './identity.ts';
import type { SmsSender } from './sms.ts';
import { mergeGuestExtras } from './loyalty.ts';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_STATE_TTL_MS = 10 * 60 * 1000;
const LOGIN_CODE_TTL_MS = 2 * 60 * 1000;
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_DIGITS = 6;
const MAX_NAME = 40;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 72;
/** Mainland mobile numbers: the only kind the SMS provider can reach. */
const CN_MOBILE = /^1[3-9]\d{9}$/;
// Hashed for an unknown phone too, so the response time does not reveal which phones have an account.
const DUMMY_PASSWORD_HASH = hashPin('timing-equaliser');

/** `phone` is the SMS-verified number; `loginPhone` is the unverified one a password account signs in with. */
export interface Customer { id: number; name: string; phone: string | null; loginPhone: string | null; providers: LoginProvider[] }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const newSecret = () => randomBytes(24).toString('hex');

/** "+86 138-0013-8000" -> "13800138000"; anything that is not a mainland mobile is refused. */
export function guestPhone(v: unknown): string {
  const raw = typeof v === 'string' ? v.replace(/[\s\-().]/g, '').replace(/^\+?86(?=1\d{10}$)/, '') : '';
  if (!CN_MOBILE.test(raw)) throw new DomainError('enter an 11-digit mainland mobile number', 422);
  return raw;
}

/** Only same-site customer-app paths may be a post-login destination (no open redirect). */
export function safeReturnPath(v: unknown): string {
  const s = typeof v === 'string' ? v : '';
  return /^\/g(\/[A-Za-z0-9._~%-]*)*$/.test(s) && s.length <= 200 ? s : '/g/';
}

/** Random value kept in an HttpOnly cookie by the browser that starts a provider sign-in. */
export const newBrowserNonce = newSecret;

const sameHash = (stored: string, nonce: string | undefined) =>
  Boolean(nonce) && stored.length === 64 && timingSafeEqual(Buffer.from(stored), Buffer.from(sha256(nonce!)));

export async function createAuthState(db: Db, provider: LoginProvider, returnTo: string, nonce: string): Promise<string> {
  const state = newSecret();
  await db.run('DELETE FROM guest_auth_states WHERE expires_at < ?', [Date.now()]);
  await db.run('INSERT INTO guest_auth_states (state, provider, return_to, expires_at, nonce_hash) VALUES (?,?,?,?,?)',
    [state, provider, returnTo, Date.now() + AUTH_STATE_TTL_MS, sha256(nonce)]);
  return state;
}

/**
 * One-time, and only in the browser that started the sign-in: a callback link opened anywhere else (a fake table
 * sticker, a forwarded chat link) finds no matching cookie and is refused.
 */
export async function consumeAuthState(db: Db, state: string, provider: LoginProvider, nonce: string | undefined): Promise<string> {
  const row = await db.one('DELETE FROM guest_auth_states WHERE state = ? RETURNING provider, return_to, expires_at, nonce_hash', [state]);
  if (!row || row.provider !== provider || row.expires_at < Date.now()) throw new DomainError('sign-in link expired, please try again', 400);
  if (!sameHash(row.nonce_hash, nonce)) throw new DomainError('please start sign-in again on this phone', 400);
  return row.return_to;
}

/** Finds or creates the guest behind a provider identity. */
export async function signInWithIdentity(db: Db, provider: LoginProvider, p: IdentityProfile): Promise<number> {
  return db.tx(async (t) => {
    const now = Date.now();
    const found = await t.one('SELECT customer_id FROM customer_identities WHERE provider = ? AND app_id = ? AND subject = ?', [provider, p.appId, p.subject]);
    if (found) {
      await t.run("UPDATE customers SET last_seen_at = ?, display_name = CASE WHEN display_name = '' THEN ? ELSE display_name END WHERE id = ?", [now, p.displayName, found.customer_id]);
      return found.customer_id as number;
    }
    const id = await t.insert('INSERT INTO customers (display_name, created_at, last_seen_at) VALUES (?,?,?)', [p.displayName, now, now]);
    // Two first-time callbacks for one identity racing: the unique index decides, the loser reuses the winner's account.
    const row = await t.one(
      `INSERT INTO customer_identities (customer_id, provider, app_id, subject, union_id, created_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT (provider, app_id, subject) DO NOTHING RETURNING customer_id`, [id, provider, p.appId, p.subject, p.unionId ?? null, now]);
    if (row) return id;
    await t.run('DELETE FROM customers WHERE id = ?', [id]);
    return (await t.one('SELECT customer_id FROM customer_identities WHERE provider = ? AND app_id = ? AND subject = ?', [provider, p.appId, p.subject]))!.customer_id;
  });
}

/** Short-lived code handed to the browser in the URL fragment after the provider redirect; swapped for a session token by POST. */
export async function createLoginCode(db: Db, customerId: number, nonce: string): Promise<string> {
  const code = newSecret();
  await db.run('DELETE FROM guest_login_codes WHERE expires_at < ?', [Date.now()]);
  await db.run('INSERT INTO guest_login_codes (code_hash, customer_id, expires_at, nonce_hash) VALUES (?,?,?,?)',
    [sha256(code), customerId, Date.now() + LOGIN_CODE_TTL_MS, sha256(nonce)]);
  return code;
}

/** The code is also bound to the starting browser's cookie, so a copied "#login=" link is useless elsewhere. */
export async function exchangeLoginCode(db: Db, code: unknown, nonce: string | undefined): Promise<{ token: string; customer: Customer }> {
  if (typeof code !== 'string' || !code) throw new DomainError('code required', 422);
  const row = await db.one('DELETE FROM guest_login_codes WHERE code_hash = ? RETURNING customer_id, expires_at, nonce_hash', [sha256(code)]);
  if (!row || row.expires_at < Date.now() || !sameHash(row.nonce_hash, nonce)) throw new DomainError('sign-in link expired, please try again', 401);
  return startSession(db, row.customer_id);
}

async function startSession(db: Db, customerId: number): Promise<{ token: string; customer: Customer }> {
  const token = newSecret();
  await db.run('INSERT INTO guest_sessions (token_hash, customer_id, expires_at, created_at) VALUES (?,?,?,?)', [sha256(token), customerId, Date.now() + SESSION_TTL_MS, Date.now()]);
  return { token, customer: await getCustomer(db, customerId) };
}

export async function customerIdFromToken(db: Db, token: string): Promise<number> {
  if (!token) throw new DomainError('please sign in', 401);
  const row = await db.one('SELECT customer_id FROM guest_sessions WHERE token_hash = ? AND expires_at > ?', [sha256(token), Date.now()]);
  if (!row) throw new DomainError('please sign in', 401);
  return row.customer_id;
}

export async function endSession(db: Db, token: string): Promise<void> {
  await db.run('DELETE FROM guest_sessions WHERE token_hash = ?', [sha256(token)]);
}

export async function getCustomer(db: Db, id: number): Promise<Customer> {
  const c = await db.one('SELECT id, display_name, phone FROM customers WHERE id = ?', [id]);
  if (!c) throw new DomainError('please sign in', 401);
  const ids = await db.all('SELECT DISTINCT provider FROM customer_identities WHERE customer_id = ? ORDER BY provider', [id]);
  const pw = await db.one('SELECT phone FROM guest_passwords WHERE customer_id = ?', [id]);
  return { id: c.id, name: c.display_name, phone: c.phone, loginPhone: pw?.phone ?? null, providers: ids.map((r) => r.provider) };
}

function guestPassword(v: unknown): string {
  if (typeof v !== 'string' || v.length < MIN_PASSWORD || v.length > MAX_PASSWORD) {
    throw new DomainError(`password: ${MIN_PASSWORD} to ${MAX_PASSWORD} characters`, 422);
  }
  return v;
}

/**
 * Creates a guest account that signs in with phone + password, no SMS needed. The phone is not verified, so it does
 * not become customers.phone: the wallet, stored bottles and bookings still need the SMS check (verify phone).
 */
export async function registerWithPassword(db: Db, rawPhone: unknown, password: unknown, name: unknown): Promise<{ token: string; customer: Customer }> {
  const phone = guestPhone(rawPhone);
  const pwHash = hashPin(guestPassword(password));
  const displayName = typeof name === 'string' ? name.trim().slice(0, MAX_NAME) : '';
  const id = await db.tx(async (t) => {
    const now = Date.now();
    if (await t.one('SELECT 1 AS x FROM guest_passwords WHERE phone = ?', [phone])) return null;
    const customerId = await t.insert('INSERT INTO customers (display_name, created_at, last_seen_at) VALUES (?,?,?)', [displayName, now, now]);
    // Two registrations of one phone racing: the primary key decides; the loser's empty account is rolled back below.
    const row = await t.one('INSERT INTO guest_passwords (phone, customer_id, pw_hash, created_at) VALUES (?,?,?,?) ON CONFLICT (phone) DO NOTHING RETURNING customer_id',
      [phone, customerId, pwHash, now]);
    if (!row) await t.run('DELETE FROM customers WHERE id = ?', [customerId]);
    return row ? customerId : null;
  });
  if (id === null) throw new DomainError('this phone already has an account, please sign in', 409);
  return startSession(db, id);
}

export async function loginWithPassword(db: Db, rawPhone: unknown, password: unknown): Promise<{ token: string; customer: Customer }> {
  const phone = guestPhone(rawPhone);
  const row = await db.one('SELECT customer_id, pw_hash FROM guest_passwords WHERE phone = ?', [phone]);
  const ok = verifyPin(typeof password === 'string' ? password : '', row?.pw_hash ?? DUMMY_PASSWORD_HASH);
  if (!row || !ok) throw new DomainError('wrong phone number or password', 401);
  await db.run('UPDATE customers SET last_seen_at = ? WHERE id = ?', [Date.now(), row.customer_id]);
  return startSession(db, row.customer_id);
}

export async function renameCustomer(db: Db, id: number, name: unknown): Promise<Customer> {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean || clean.length > MAX_NAME) throw new DomainError(`name: 1 to ${MAX_NAME} characters`, 422);
  await db.run('UPDATE customers SET display_name = ? WHERE id = ?', [clean, id]);
  return getCustomer(db, id);
}

/** Sends a 6-digit code. Returns the code itself only when the sender is the development stand-in. */
export async function requestOtp(db: Db, sms: SmsSender, rawPhone: unknown): Promise<{ sent: true; devCode?: string }> {
  const phone = guestPhone(rawPhone);
  const prev = await db.one('SELECT sent_at FROM guest_otps WHERE phone = ?', [phone]);
  if (prev && Date.now() - prev.sent_at < OTP_RESEND_MS) throw new DomainError('please wait a minute before asking for another code', 429);
  const code = String(randomInt(0, 10 ** OTP_DIGITS)).padStart(OTP_DIGITS, '0');
  const now = Date.now();
  await db.run(
    `INSERT INTO guest_otps (phone, code_hash, attempts, sent_at, expires_at) VALUES (?,?,0,?,?)
     ON CONFLICT (phone) DO UPDATE SET code_hash = EXCLUDED.code_hash, attempts = 0, sent_at = EXCLUDED.sent_at, expires_at = EXCLUDED.expires_at`,
    [phone, sha256(`${phone}:${code}`), now, now + OTP_TTL_MS]);
  try {
    await sms.sendCode(phone, code);
  } catch (e) {
    await db.run('DELETE FROM guest_otps WHERE phone = ?', [phone]);
    throw new DomainError(`could not send the code: ${(e as Error).message}`, 502);
  }
  return sms.live ? { sent: true } : { sent: true, devCode: code };
}

/**
 * Each code allows a few guesses, then must be re-requested; a correct code is single-use. The outcome is returned and
 * thrown only after the transaction commits, so a wrong guess still counts against the limit.
 */
async function checkOtp(db: Db, phone: string, code: unknown): Promise<void> {
  const outcome = await db.tx(async (t) => {
    const row = await t.one('SELECT * FROM guest_otps WHERE phone = ? FOR UPDATE', [phone]);
    if (!row || row.expires_at < Date.now() || row.attempts >= OTP_MAX_ATTEMPTS) return 'expired';
    const given = Buffer.from(sha256(`${phone}:${String(code ?? '')}`));
    if (!timingSafeEqual(given, Buffer.from(row.code_hash))) {
      await t.run('UPDATE guest_otps SET attempts = attempts + 1 WHERE phone = ?', [phone]);
      return 'wrong';
    }
    await t.run('DELETE FROM guest_otps WHERE phone = ?', [phone]);
    return 'ok';
  });
  if (outcome === 'expired') throw new DomainError('code expired, ask for a new one', 401);
  if (outcome === 'wrong') throw new DomainError('wrong code', 401);
}

/** Phone + SMS code sign-in, for guests who do not want to use WeChat, Alipay or Douyin. */
export async function loginWithPhone(db: Db, rawPhone: unknown, code: unknown): Promise<{ token: string; customer: Customer }> {
  const phone = guestPhone(rawPhone);
  await checkOtp(db, phone, code);
  const id = await db.tx(async (t) => {
    const now = Date.now();
    const found = await t.one('SELECT id FROM customers WHERE phone = ?', [phone]);
    if (found) {
      await t.run('UPDATE customers SET last_seen_at = ? WHERE id = ?', [now, found.id]);
      return found.id as number;
    }
    const row = await t.one('INSERT INTO customers (display_name, phone, created_at, last_seen_at) VALUES (?,?,?,?) ON CONFLICT (phone) DO NOTHING RETURNING id', ['', phone, now, now]);
    return row ? row.id : (await t.one('SELECT id FROM customers WHERE phone = ?', [phone]))!.id;
  });
  return startSession(db, id);
}

/**
 * Verifies a phone for the signed-in guest. The phone is what links the guest to each venue's member wallet and stash.
 * If another guest account already owns the phone (they signed in another way before), the two accounts are merged
 * into that one and this session follows.
 */
export async function linkPhone(db: Db, customerId: number, token: string, rawPhone: unknown, code: unknown): Promise<Customer> {
  const phone = guestPhone(rawPhone);
  await checkOtp(db, phone, code);
  const current = sha256(token);
  const finalId = await db.tx(async (t) => {
    const owner = await t.one('SELECT id, display_name FROM customers WHERE phone = ? FOR UPDATE', [phone]);
    if (!owner || owner.id === customerId) {
      await t.run('UPDATE customers SET phone = ? WHERE id = ?', [phone, customerId]);
      // The phone unlocks a wallet: only the device that proved it keeps a session on the account.
      await t.run('DELETE FROM guest_sessions WHERE customer_id = ? AND token_hash <> ?', [customerId, current]);
      return customerId;
    }
    const me = await t.one('SELECT display_name FROM customers WHERE id = ? FOR UPDATE', [customerId]);
    for (const table of ['customer_identities', 'guest_orders', 'bookings', 'payments']) {
      await t.run(`UPDATE ${table} SET customer_id = ? WHERE customer_id = ?`, [owner.id, customerId]);
    }
    await mergeGuestExtras(t, customerId, owner.id);
    // The password login follows the merge, unless the surviving account already has one of its own.
    await t.run('UPDATE guest_passwords SET customer_id = ? WHERE customer_id = ? AND NOT EXISTS (SELECT 1 FROM guest_passwords WHERE customer_id = ?)',
      [owner.id, customerId, owner.id]);
    await t.run('DELETE FROM guest_passwords WHERE customer_id = ?', [customerId]);
    // Sessions are not carried over: every other session of either account ends, and only this device (which just
    // proved the phone) moves to the merged account.
    await t.run('DELETE FROM guest_sessions WHERE customer_id IN (?, ?) AND token_hash <> ?', [customerId, owner.id, current]);
    await t.run('UPDATE guest_sessions SET customer_id = ? WHERE token_hash = ?', [owner.id, current]);
    await t.run('DELETE FROM guest_login_codes WHERE customer_id = ?', [customerId]);
    if (!owner.display_name && me?.display_name) await t.run('UPDATE customers SET display_name = ? WHERE id = ?', [me.display_name, owner.id]);
    await t.run('DELETE FROM customers WHERE id = ?', [customerId]);
    return owner.id as number;
  });
  return getCustomer(db, finalId);
}

/** Housekeeping for the self-heal loop. */
export async function purgeExpiredGuestAuth(db: Db, now = Date.now()): Promise<void> {
  await db.run('DELETE FROM guest_sessions WHERE expires_at < ?', [now]);
  await db.run('DELETE FROM guest_auth_states WHERE expires_at < ?', [now]);
  await db.run('DELETE FROM guest_login_codes WHERE expires_at < ?', [now]);
  await db.run('DELETE FROM guest_otps WHERE expires_at < ?', [now]);
}
