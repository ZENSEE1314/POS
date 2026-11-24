import { randomInt } from 'node:crypto';
import type { Db } from '../db.ts';
import { audit, DomainError } from '../db.ts';
import type { Actor } from '../auth.ts';
import { require_, whoOf } from '../auth.ts';
import { guestSettings, requireFeature } from './settings.ts';
import { tenantByCode } from './venue.ts';
import { creditCommission } from '../distribution.ts';

const FEN_PER_YUAN = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const VOUCHER_DAYS = 30;
const SPINS_PER_DAY = 10;
const RECENT = 30;
const MAX_LABEL = 60;
const MAX_COST = 1_000_000;
const MAX_WEIGHT = 10_000;
const REF_CODE = /^[0-9A-F]{8}$/;
// No 0/O or 1/I: staff read these codes off a phone screen.
const VOUCHER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const VOUCHER_LENGTH = 8;
const PRIZE_KINDS = ['none', 'points', 'voucher'];
/** A referral pays out only after the new guest has spent this much in the app, so ¥1 payments from throwaway accounts earn nothing. */
const REFERRAL_MIN_SPEND_FEN = 10_000;

/** Used until a company sets up its own wheel. Prizes are points or small freebies only: nothing can be cashed out. */
const DEFAULT_PRIZES = [
  { id: 0, label: '再接再厉', labelEn: 'Try again', kind: 'none', points: 0, weight: 45 },
  { id: 0, label: '+50 积分', labelEn: '+50 points', kind: 'points', points: 50, weight: 30 },
  { id: 0, label: '免费软饮一杯', labelEn: 'Free soft drink', kind: 'voucher', points: 0, weight: 15 },
  { id: 0, label: '+200 积分', labelEn: '+200 points', kind: 'points', points: 200, weight: 7 },
  { id: 0, label: '免费小食一份', labelEn: 'Free snack', kind: 'voucher', points: 0, weight: 3 },
];

// ---------- points ----------

/**
 * Adds (or with a negative delta, spends) points. With a ref the change happens at most once (returns null on a
 * repeat), so a replayed payment callback cannot pay out twice. Spending more than the balance throws 402.
 */
export async function changePoints(t: Db, tenantId: number, customerId: number, delta: number, reason: string, ref: string | null = null): Promise<number | null> {
  if (ref !== null) {
    const fresh = await t.run(
      'INSERT INTO points_ledger (tenant_id, customer_id, delta, reason, ref, ts) VALUES (?,?,?,?,?,?) ON CONFLICT (tenant_id, ref) WHERE ref IS NOT NULL DO NOTHING',
      [tenantId, customerId, delta, reason, ref, Date.now()]);
    if (!fresh) return null;
  } else {
    await t.run('INSERT INTO points_ledger (tenant_id, customer_id, delta, reason, ts) VALUES (?,?,?,?,?)', [tenantId, customerId, delta, reason, Date.now()]);
  }
  await t.run('INSERT INTO customer_points (tenant_id, customer_id, balance) VALUES (?,?,0) ON CONFLICT DO NOTHING', [tenantId, customerId]);
  const r = await t.one('UPDATE customer_points SET balance = balance + ? WHERE tenant_id = ? AND customer_id = ? AND balance + ? >= 0 RETURNING balance',
    [delta, tenantId, customerId, delta]);
  if (!r) throw new DomainError('not enough points', 402);
  return r.balance;
}

/**
 * Points for money a guest paid through the app. Once a referred guest has spent REFERRAL_MIN_SPEND_FEN at the
 * company, the referral bonus is paid to both sides.
 */
export async function earnForPayment(t: Db, customerId: number, billId: number, paymentId: number, amountFen: number): Promise<void> {
  await creditCommission(t, customerId, billId, paymentId, amountFen);
  const tenantId = (await t.one('SELECT s.tenant_id FROM bills b JOIN stores s ON s.id = b.store_id WHERE b.id = ?', [billId]))?.tenant_id;
  if (!tenantId) return;
  const s = await guestSettings(t, tenantId);
  if (!s.features.loyalty) return;
  const points = Math.floor((amountFen * s.pointsPerYuan) / FEN_PER_YUAN);
  if (points > 0) await changePoints(t, tenantId, customerId, points, 'spend', `pay:${paymentId}`);
  if (!s.features.referral || s.referralPoints <= 0) return;
  const ref = await t.one('SELECT referrer_id FROM referrals WHERE tenant_id = ? AND referee_id = ? AND rewarded_at IS NULL FOR UPDATE', [tenantId, customerId]);
  if (!ref) return;
  const spent = await t.one(
    `SELECT COALESCE(SUM(p.amount), 0) AS s FROM payments p JOIN bills b ON b.id = p.bill_id JOIN stores st ON st.id = b.store_id
     WHERE p.customer_id = ? AND st.tenant_id = ? AND p.status = 'paid'`, [customerId, tenantId]);
  if (spent.s < REFERRAL_MIN_SPEND_FEN) return;
  await t.run('UPDATE referrals SET rewarded_at = ? WHERE tenant_id = ? AND referee_id = ?', [Date.now(), tenantId, customerId]);
  await changePoints(t, tenantId, customerId, s.referralPoints, 'referral', `ref:${customerId}:joined`);
  await changePoints(t, tenantId, ref.referrer_id, s.referralPoints, 'referral', `ref:${customerId}:invited`);
}

/** A new guest at a company enters the code of the friend who invited them. */
export async function claimReferral(db: Db, customerId: number, company: unknown, code: unknown): Promise<{ ok: true }> {
  const t0 = await tenantByCode(db, String(company ?? ''));
  await requireFeature(db, t0.id, 'referral');
  const clean = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (!REF_CODE.test(clean)) throw new DomainError('enter the 8-character invite code', 422);
  return db.tx(async (t) => {
    const referrer = await t.one('SELECT id FROM customers WHERE ref_code = ?', [clean]);
    if (!referrer) throw new DomainError('no guest has that invite code', 404);
    if (referrer.id === customerId) throw new DomainError('you cannot use your own invite code', 422);
    if (await t.one('SELECT 1 AS x FROM referrals WHERE tenant_id = ? AND referee_id = ?', [t0.id, customerId])) throw new DomainError('you already used an invite code here', 409);
    if (await t.one('SELECT 1 AS x FROM referrals WHERE tenant_id = ? AND referee_id = ? AND referrer_id = ?', [t0.id, referrer.id, customerId])) {
      throw new DomainError('you invited this guest, so their code does not work for you', 409);
    }
    const paidBefore = await t.one(
      `SELECT 1 AS x FROM payments p JOIN bills b ON b.id = p.bill_id JOIN stores s ON s.id = b.store_id
       WHERE p.customer_id = ? AND s.tenant_id = ? AND p.status = 'paid' LIMIT 1`, [customerId, t0.id]);
    if (paidBefore) throw new DomainError('invite codes are for guests who have not paid here before', 409);
    await t.run('INSERT INTO referrals (tenant_id, referee_id, referrer_id, created_at) VALUES (?,?,?,?)', [t0.id, customerId, referrer.id, Date.now()]);
    await audit(t, { tenantId: t0.id }, 'guest.referral', 'customer', customerId, { referrerId: referrer.id });
    return { ok: true as const };
  });
}

// ---------- vouchers ----------

function voucherCode(): string {
  return Array.from({ length: VOUCHER_LENGTH }, () => VOUCHER_ALPHABET[randomInt(VOUCHER_ALPHABET.length)]).join('');
}

async function issueVoucher(t: Db, tenantId: number, customerId: number, title: string, source: 'reward' | 'spin') {
  const now = Date.now();
  const code = voucherCode();
  const expiresAt = now + VOUCHER_DAYS * DAY_MS;
  await t.run('INSERT INTO vouchers (tenant_id, customer_id, title, source, code, created_at, expires_at) VALUES (?,?,?,?,?,?,?)',
    [tenantId, customerId, title, source, code, now, expiresAt]);
  return { code, title, expiresAt };
}

const bilingual = (zh: string, en: string) => (en && en !== zh ? `${zh} / ${en}` : zh);

// ---------- guest side ----------

async function activePrizes(db: Db, tenantId: number) {
  const rows = await db.all('SELECT id, label, label_en AS "labelEn", kind, points, weight FROM spin_prizes WHERE tenant_id = ? AND active ORDER BY id', [tenantId]);
  return rows.length >= 2 ? rows : DEFAULT_PRIZES;
}

export async function loyaltyAt(db: Db, customerId: number, company: string) {
  const t0 = await tenantByCode(db, company);
  const s = await requireFeature(db, t0.id, 'loyalty');
  const balance = (await db.one('SELECT balance FROM customer_points WHERE tenant_id = ? AND customer_id = ?', [t0.id, customerId]))?.balance ?? 0;
  const ledger = await db.all('SELECT delta, reason, ts FROM points_ledger WHERE tenant_id = ? AND customer_id = ? ORDER BY id DESC LIMIT ?', [t0.id, customerId, RECENT]);
  const rewards = await db.all('SELECT id, name, name_en AS "nameEn", cost FROM loyalty_rewards WHERE tenant_id = ? AND active ORDER BY cost, id', [t0.id]);
  const vouchers = await db.all(
    `SELECT code, title, source, status, created_at AS "createdAt", expires_at AS "expiresAt", used_at AS "usedAt" FROM vouchers
     WHERE tenant_id = ? AND customer_id = ? ORDER BY id DESC LIMIT ?`, [t0.id, customerId, RECENT]);
  const me = await db.one('SELECT ref_code FROM customers WHERE id = ?', [customerId]);
  const referredBy = Boolean(await db.one('SELECT 1 AS x FROM referrals WHERE tenant_id = ? AND referee_id = ?', [t0.id, customerId]));
  const invited = (await db.one('SELECT COUNT(*) FILTER (WHERE rewarded_at IS NOT NULL) AS done, COUNT(*) AS n FROM referrals WHERE tenant_id = ? AND referrer_id = ?', [t0.id, customerId]))!;
  return {
    company: { name: t0.name, code: t0.code },
    balance, ledger, rewards, vouchers,
    pointsPerYuan: s.pointsPerYuan,
    referral: s.features.referral ? { code: me?.ref_code ?? '', points: s.referralPoints, referredBy, invited: invited.n, rewarded: invited.done } : null,
    spin: s.features.spin ? { cost: s.spinCost, prizes: (await activePrizes(db, t0.id)).map(({ weight: _w, ...p }) => p) } : null,
  };
}

export async function redeemReward(db: Db, customerId: number, company: string, rewardId: unknown) {
  const t0 = await tenantByCode(db, company);
  await requireFeature(db, t0.id, 'loyalty');
  if (typeof rewardId !== 'number' || !Number.isInteger(rewardId)) throw new DomainError('rewardId is required', 422);
  return db.tx(async (t) => {
    const r = await t.one('SELECT * FROM loyalty_rewards WHERE id = ? AND tenant_id = ? AND active', [rewardId, t0.id]);
    if (!r) throw new DomainError('this reward is no longer offered', 404);
    const balance = await changePoints(t, t0.id, customerId, -r.cost, 'reward');
    const voucher = await issueVoucher(t, t0.id, customerId, bilingual(r.name, r.name_en), 'reward');
    await audit(t, { tenantId: t0.id }, 'guest.reward', 'loyalty_reward', r.id, { customerId, cost: r.cost, code: voucher.code });
    return { balance, voucher };
  });
}

function pickWeighted<T extends { weight: number }>(items: T[]): number {
  const total = items.reduce((s, p) => s + p.weight, 0);
  let roll = randomInt(total);
  for (let i = 0; i < items.length; i++) {
    roll -= items[i].weight;
    if (roll < 0) return i;
  }
  return items.length - 1;
}

/** One spin of the prize wheel: costs points, the server picks the prize, and the page only animates to it. */
export async function spinWheel(db: Db, customerId: number, company: string) {
  const t0 = await tenantByCode(db, company);
  const s = await requireFeature(db, t0.id, 'spin');
  return db.tx(async (t) => {
    // Serialises spins per guest so the daily limit and the balance check cannot be raced.
    await t.run('INSERT INTO customer_points (tenant_id, customer_id, balance) VALUES (?,?,0) ON CONFLICT DO NOTHING', [t0.id, customerId]);
    await t.one('SELECT balance FROM customer_points WHERE tenant_id = ? AND customer_id = ? FOR UPDATE', [t0.id, customerId]);
    const today = await t.one("SELECT COUNT(*) AS n FROM points_ledger WHERE tenant_id = ? AND customer_id = ? AND reason = 'spin' AND ts > ?", [t0.id, customerId, Date.now() - DAY_MS]);
    if (today.n >= SPINS_PER_DAY) throw new DomainError(`you can spin ${SPINS_PER_DAY} times a day; come back tomorrow`, 429);
    let balance = (await changePoints(t, t0.id, customerId, -s.spinCost, 'spin'))!;
    const prizes = await activePrizes(t, t0.id);
    const index = pickWeighted(prizes);
    const prize = prizes[index];
    let voucher = null;
    if (prize.kind === 'points' && prize.points > 0) balance = (await changePoints(t, t0.id, customerId, prize.points, 'prize'))!;
    if (prize.kind === 'voucher') voucher = await issueVoucher(t, t0.id, customerId, bilingual(prize.label, prize.labelEn), 'spin');
    await audit(t, { tenantId: t0.id }, 'guest.spin', 'customer', customerId, { prize: prize.labelEn || prize.label, cost: s.spinCost });
    return { index, prize: { label: prize.label, labelEn: prize.labelEn, kind: prize.kind, points: prize.points }, balance, voucher };
  });
}

// ---------- staff: vouchers ----------

async function voucherByCode(db: Db, actor: Actor, code: string) {
  const v = await db.one(
    `SELECT v.*, c.display_name, c.phone FROM vouchers v JOIN customers c ON c.id = v.customer_id WHERE v.code = ? AND v.tenant_id = ?`,
    [code.trim().toUpperCase(), actor.tenantId]);
  if (!v) throw new DomainError('no voucher with that code', 404);
  return v;
}

const voucherView = (v: any) => ({
  code: v.code, title: v.title, source: v.source, status: v.status, guestName: v.display_name, guestPhone: v.phone,
  createdAt: v.created_at, expiresAt: v.expires_at, usedAt: v.used_at, expired: v.status === 'issued' && v.expires_at < Date.now(),
});

export async function checkVoucher(db: Db, actor: Actor, code: string) {
  require_(actor, 'order.add');
  return voucherView(await voucherByCode(db, actor, code));
}

/** Staff hand over the freebie, then mark the code used so it cannot be shown again at another table or store. */
export async function useVoucher(db: Db, actor: Actor, code: string) {
  require_(actor, 'order.add');
  const v = await voucherByCode(db, actor, code);
  const n = await db.run("UPDATE vouchers SET status = 'used', used_at = ?, used_by = ?, used_store_id = ? WHERE id = ? AND status = 'issued' AND expires_at >= ?",
    [Date.now(), actor.id, actor.storeId, v.id, Date.now()]);
  if (!n) throw new DomainError(v.status === 'used' ? 'this voucher was already used' : 'this voucher has expired', 409);
  await audit(db, whoOf(actor), 'voucher.use', 'voucher', v.id, { code: v.code, title: v.title });
  return voucherView(await voucherByCode(db, actor, code));
}

// ---------- admin: rewards and wheel prizes ----------

const label = (v: unknown, name: string, required = true): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new DomainError(`${name} is required`, 422);
  if (s.length > MAX_LABEL) throw new DomainError(`${name}: up to ${MAX_LABEL} characters`, 422);
  return s;
};
const whole = (v: unknown, name: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new DomainError(`${name} must be a whole number from ${min} to ${max}`, 422);
  return v;
};

export function listRewards(db: Db, actor: Actor) {
  require_(actor, 'admin.write');
  return db.all('SELECT id, name, name_en AS "nameEn", cost, active FROM loyalty_rewards WHERE tenant_id = ? ORDER BY cost, id', [actor.tenantId]);
}

export async function saveReward(db: Db, actor: Actor, id: number | null, b: Record<string, unknown>): Promise<{ id: number }> {
  require_(actor, 'admin.write');
  const row = { name: label(b.name, 'name'), nameEn: label(b.nameEn, 'nameEn', false), cost: whole(b.cost, 'cost', 1, MAX_COST), active: b.active !== false };
  if (id === null) {
    const newId = await db.insert('INSERT INTO loyalty_rewards (tenant_id, name, name_en, cost, active) VALUES (?,?,?,?,?)', [actor.tenantId, row.name, row.nameEn, row.cost, row.active]);
    await audit(db, whoOf(actor), 'reward.create', 'loyalty_reward', newId, row);
    return { id: newId };
  }
  const n = await db.run('UPDATE loyalty_rewards SET name = ?, name_en = ?, cost = ?, active = ? WHERE id = ? AND tenant_id = ?', [row.name, row.nameEn, row.cost, row.active, id, actor.tenantId]);
  if (!n) throw new DomainError('reward not found', 404);
  await audit(db, whoOf(actor), 'reward.update', 'loyalty_reward', id, row);
  return { id };
}

export async function listPrizes(db: Db, actor: Actor) {
  require_(actor, 'admin.write');
  const rows = await db.all('SELECT id, label, label_en AS "labelEn", kind, points, weight, active FROM spin_prizes WHERE tenant_id = ? ORDER BY id', [actor.tenantId]);
  return { prizes: rows, usingDefaults: rows.filter((r) => r.active).length < 2, defaults: DEFAULT_PRIZES };
}

export async function savePrize(db: Db, actor: Actor, id: number | null, b: Record<string, unknown>): Promise<{ id: number }> {
  require_(actor, 'admin.write');
  const kind = String(b.kind ?? '');
  if (!PRIZE_KINDS.includes(kind)) throw new DomainError(`kind must be one of ${PRIZE_KINDS.join(', ')}`, 422);
  const row = {
    label: label(b.label, 'label'), labelEn: label(b.labelEn, 'labelEn', false), kind,
    points: kind === 'points' ? whole(b.points, 'points', 1, MAX_COST) : 0, weight: whole(b.weight, 'weight', 1, MAX_WEIGHT), active: b.active !== false,
  };
  if (id === null) {
    const newId = await db.insert('INSERT INTO spin_prizes (tenant_id, label, label_en, kind, points, weight, active) VALUES (?,?,?,?,?,?,?)',
      [actor.tenantId, row.label, row.labelEn, row.kind, row.points, row.weight, row.active]);
    await audit(db, whoOf(actor), 'prize.create', 'spin_prize', newId, row);
    return { id: newId };
  }
  const n = await db.run('UPDATE spin_prizes SET label = ?, label_en = ?, kind = ?, points = ?, weight = ?, active = ? WHERE id = ? AND tenant_id = ?',
    [row.label, row.labelEn, row.kind, row.points, row.weight, row.active, id, actor.tenantId]);
  if (!n) throw new DomainError('prize not found', 404);
  await audit(db, whoOf(actor), 'prize.update', 'spin_prize', id, row);
  return { id };
}

// ---------- account merge (phone verification found an older account) ----------

/** Moves points, vouchers, requests, pets and referrals from one guest account to the one that survives a merge. */
export async function mergeGuestExtras(t: Db, fromId: number, toId: number): Promise<void> {
  await t.run(
    `INSERT INTO customer_points (tenant_id, customer_id, balance) SELECT tenant_id, ?, balance FROM customer_points WHERE customer_id = ?
     ON CONFLICT (tenant_id, customer_id) DO UPDATE SET balance = customer_points.balance + EXCLUDED.balance`, [toId, fromId]);
  await t.run('DELETE FROM customer_points WHERE customer_id = ?', [fromId]);
  for (const table of ['points_ledger', 'vouchers', 'guest_requests', 'customer_pets']) {
    await t.run(`UPDATE ${table} SET customer_id = ? WHERE customer_id = ?`, [toId, fromId]);
  }
  await t.run('DELETE FROM referrals r WHERE r.referee_id = ? AND EXISTS (SELECT 1 FROM referrals x WHERE x.tenant_id = r.tenant_id AND x.referee_id = ?)', [fromId, toId]);
  await t.run('UPDATE referrals SET referee_id = ? WHERE referee_id = ?', [toId, fromId]);
  await t.run('UPDATE referrals SET referrer_id = ? WHERE referrer_id = ?', [toId, fromId]);
  await t.run('DELETE FROM referrals WHERE referee_id = referrer_id');
}
