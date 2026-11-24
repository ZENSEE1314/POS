// Distribution (分销): a guest signs up as a distributor and shares their link. A new guest who joins through it is
// tied to that distributor for good, and every later payment that guest makes through the app earns the distributor a
// share. Distributors ask for a payout; finance pays them outside the system and marks the request paid.
import type { Db } from './db.ts';
import { audit, DomainError } from './db.ts';
import type { Actor } from './auth.ts';
import { require_, whoOf } from './auth.ts';
import { tenantByCode } from './guest/venue.ts';

const BPS = 10_000;
const MAX_RATE_BPS = 5_000;
const MAX_MIN_PAYOUT_FEN = 100_000_000;
const MAX_ACCOUNT = 80;
const MAX_NOTE = 200;
const RECENT = 30;
const REF_CODE = /^[0-9A-F]{8}$/;
const DISTRIBUTOR_ACTIONS = { approve: 'active', stop: 'stopped', resume: 'active' } as const;
const PAYOUT_ACTIONS = { paid: 'paid', reject: 'rejected' } as const;

interface Settings { enabled: boolean; rateBps: number; minPayoutFen: number; autoApprove: boolean }
const DEFAULTS: Settings = { enabled: false, rateBps: 500, minPayoutFen: 10_000, autoApprove: false };

async function settingsOf(db: Db, tenantId: number): Promise<Settings> {
  const r = await db.one('SELECT * FROM distribution_settings WHERE tenant_id = ?', [tenantId]);
  if (!r) return { ...DEFAULTS };
  return { enabled: Boolean(r.enabled), rateBps: Number(r.rate_bps), minPayoutFen: Number(r.min_payout_fen), autoApprove: Boolean(r.auto_approve) };
}

/** For the customer app home page: whether to show the distributor tile. */
export const distributionEnabled = async (db: Db, tenantId: number) => (await settingsOf(db, tenantId)).enabled;

async function enabledTenant(db: Db, company: unknown) {
  const tenant = await tenantByCode(db, String(company ?? ''));
  const s = await settingsOf(db, tenant.id);
  if (!s.enabled) throw new DomainError('this is not available at this venue', 404);
  return { tenant, s };
}

const balanceOf = async (db: Db, distributorId: number) =>
  Number((await db.one('SELECT COALESCE(SUM(delta_fen), 0) AS b FROM distributor_ledger WHERE distributor_id = ?', [distributorId])).b);

/** Shows guests only a first character, so a distributor sees that someone spent without learning who. */
const masked = (name: unknown) => (typeof name === 'string' && name ? `${[...name][0]}**` : '**');

const whole = (v: unknown, name: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new DomainError(`${name} must be a whole number from ${min} to ${max}`, 422);
  return v;
};

const hasPaidAt = async (db: Db, customerId: number, tenantId: number) => Boolean(await db.one(
  `SELECT 1 AS x FROM payments p JOIN bills b ON b.id = p.bill_id JOIN stores s ON s.id = b.store_id
   WHERE p.customer_id = ? AND s.tenant_id = ? AND p.status = 'paid' LIMIT 1`, [customerId, tenantId]));

// ---------- payments ----------

/** Called inside the payment transaction for every app payment; the ledger ref makes a replayed callback pay nothing extra. */
export async function creditCommission(t: Db, customerId: number, billId: number, paymentId: number, amountFen: number): Promise<void> {
  const tenantId = (await t.one('SELECT s.tenant_id FROM bills b JOIN stores s ON s.id = b.store_id WHERE b.id = ?', [billId]))?.tenant_id;
  if (!tenantId) return;
  const s = await settingsOf(t, tenantId);
  if (!s.enabled) return;
  const d = await t.one(
    `SELECT d.id, d.rate_bps FROM distributor_links l JOIN distributors d ON d.id = l.distributor_id
     WHERE l.tenant_id = ? AND l.customer_id = ? AND d.status = 'active'`, [tenantId, customerId]);
  if (!d) return;
  const commission = Math.floor((amountFen * (d.rate_bps ?? s.rateBps)) / BPS);
  if (commission <= 0) return;
  await t.run(
    `INSERT INTO distributor_ledger (tenant_id, distributor_id, delta_fen, kind, ref, customer_id, amount_fen, ts)
     VALUES (?,?,?,'commission',?,?,?,?) ON CONFLICT (ref) DO NOTHING`,
    [tenantId, d.id, commission, `pay:${paymentId}`, customerId, amountFen, Date.now()]);
}

// ---------- guest side ----------

export async function distributionAt(db: Db, customerId: number, company: string) {
  const { tenant, s } = await enabledTenant(db, company);
  const d = await db.one('SELECT * FROM distributors WHERE tenant_id = ? AND customer_id = ?', [tenant.id, customerId]);
  const joined = Boolean(await db.one('SELECT 1 AS x FROM distributor_links WHERE tenant_id = ? AND customer_id = ?', [tenant.id, customerId]));
  const base = { company: { name: tenant.name, code: tenant.code }, rateBps: s.rateBps, minPayoutFen: s.minPayoutFen, joined };
  if (!d) return { ...base, me: null };
  const code = (await db.one('SELECT ref_code FROM customers WHERE id = ?', [customerId]))?.ref_code ?? '';
  const totals = await db.one(
    `SELECT COALESCE(SUM(delta_fen) FILTER (WHERE kind = 'commission'), 0) AS earned, COALESCE(SUM(delta_fen), 0) AS balance
     FROM distributor_ledger WHERE distributor_id = ?`, [d.id]);
  const team = await db.one('SELECT COUNT(*) AS n FROM distributor_links WHERE distributor_id = ?', [d.id]);
  const recent = await db.all(
    `SELECT l.ts, l.delta_fen, l.kind, l.amount_fen, c.display_name FROM distributor_ledger l LEFT JOIN customers c ON c.id = l.customer_id
     WHERE l.distributor_id = ? ORDER BY l.id DESC LIMIT ?`, [d.id, RECENT]);
  const payouts = await db.all('SELECT id, amount_fen, account, status, note, created_at, decided_at FROM distributor_payouts WHERE distributor_id = ? ORDER BY id DESC LIMIT ?', [d.id, RECENT]);
  return {
    ...base,
    me: {
      status: d.status, code, rateBps: d.rate_bps ?? s.rateBps,
      earnedFen: Number(totals.earned), balanceFen: Number(totals.balance), team: Number(team.n),
      recent: recent.map((r) => ({ ts: Number(r.ts), deltaFen: Number(r.delta_fen), kind: r.kind, spentFen: r.amount_fen === null ? null : Number(r.amount_fen), guest: r.kind === 'commission' ? masked(r.display_name) : '' })),
      payouts: payouts.map((p) => ({ id: Number(p.id), amountFen: Number(p.amount_fen), account: p.account, status: p.status, note: p.note, createdAt: Number(p.created_at), decidedAt: p.decided_at === null ? null : Number(p.decided_at) })),
    },
  };
}

export async function applyAsDistributor(db: Db, customerId: number, company: string): Promise<{ status: string }> {
  const { tenant, s } = await enabledTenant(db, company);
  const existing = await db.one('SELECT status FROM distributors WHERE tenant_id = ? AND customer_id = ?', [tenant.id, customerId]);
  if (existing) return { status: existing.status };
  const status = s.autoApprove ? 'active' : 'pending';
  const now = Date.now();
  await db.run('INSERT INTO distributors (tenant_id, customer_id, status, created_at, decided_at) VALUES (?,?,?,?,?) ON CONFLICT (tenant_id, customer_id) DO NOTHING',
    [tenant.id, customerId, status, now, s.autoApprove ? now : null]);
  await audit(db, { tenantId: tenant.id }, 'distributor.apply', 'customer', customerId, { status });
  return { status };
}

/** A guest new to the venue joins a distributor's team, from their link or by typing the code. */
export async function joinDistributor(db: Db, customerId: number, company: string, code: unknown): Promise<{ ok: true }> {
  const { tenant } = await enabledTenant(db, company);
  const clean = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (!REF_CODE.test(clean)) throw new DomainError('enter the 8-character distributor code', 422);
  return db.tx(async (t) => {
    const d = await t.one(
      `SELECT d.id, d.customer_id FROM distributors d JOIN customers c ON c.id = d.customer_id
       WHERE c.ref_code = ? AND d.tenant_id = ? AND d.status = 'active'`, [clean, tenant.id]);
    if (!d) throw new DomainError('no distributor has that code here', 404);
    if (Number(d.customer_id) === customerId) throw new DomainError('you cannot join your own team', 422);
    if (await t.one('SELECT 1 AS x FROM distributor_links WHERE tenant_id = ? AND customer_id = ?', [tenant.id, customerId])) {
      throw new DomainError('you already joined a distributor here', 409);
    }
    const mine = await t.one('SELECT id FROM distributors WHERE tenant_id = ? AND customer_id = ?', [tenant.id, customerId]);
    if (mine && await t.one('SELECT 1 AS x FROM distributor_links WHERE distributor_id = ? AND customer_id = ?', [mine.id, d.customer_id])) {
      throw new DomainError('this distributor is in your team, so you cannot join theirs', 409);
    }
    if (await hasPaidAt(t, customerId, tenant.id)) throw new DomainError('distributor codes are for guests who have not paid here before', 409);
    await t.run('INSERT INTO distributor_links (tenant_id, customer_id, distributor_id, created_at) VALUES (?,?,?,?)', [tenant.id, customerId, d.id, Date.now()]);
    await audit(t, { tenantId: tenant.id }, 'distributor.join', 'customer', customerId, { distributorId: Number(d.id) });
    return { ok: true as const };
  });
}

export async function requestPayout(db: Db, customerId: number, company: string, b: Record<string, unknown>): Promise<{ payoutId: number }> {
  const { tenant, s } = await enabledTenant(db, company);
  const account = typeof b.account === 'string' ? b.account.trim() : '';
  if (!account) throw new DomainError('say where to send the money (WeChat, Alipay or bank)', 422);
  if (account.length > MAX_ACCOUNT) throw new DomainError(`account: up to ${MAX_ACCOUNT} characters`, 422);
  const amount = whole(b.amountFen, 'amountFen', 1, Number.MAX_SAFE_INTEGER);
  if (amount < s.minPayoutFen) throw new DomainError(`the smallest payout is ${s.minPayoutFen / 100} yuan`, 422);
  return db.tx(async (t) => {
    const d = await t.one('SELECT id, status FROM distributors WHERE tenant_id = ? AND customer_id = ? FOR UPDATE', [tenant.id, customerId]);
    if (!d || d.status === 'pending') throw new DomainError('you are not a distributor here yet', 403);
    if (await t.one("SELECT 1 AS x FROM distributor_payouts WHERE distributor_id = ? AND status = 'requested'", [d.id])) {
      throw new DomainError('you already have a payout waiting; wait until the venue pays it', 409);
    }
    if (amount > await balanceOf(t, d.id)) throw new DomainError('that is more than your balance', 402);
    const now = Date.now();
    const payoutId = await t.insert('INSERT INTO distributor_payouts (tenant_id, distributor_id, amount_fen, account, created_at) VALUES (?,?,?,?,?)',
      [tenant.id, d.id, amount, account, now]);
    await t.run("INSERT INTO distributor_ledger (tenant_id, distributor_id, delta_fen, kind, ref, ts) VALUES (?,?,?,'payout',?,?)",
      [tenant.id, d.id, -amount, `payout:${payoutId}`, now]);
    await audit(t, { tenantId: tenant.id }, 'distributor.payout.request', 'distributor_payout', payoutId, { amount });
    return { payoutId };
  });
}

// ---------- staff side ----------

export async function distributionOverview(db: Db, actor: Actor) {
  require_(actor, 'admin.write');
  const settings = await settingsOf(db, actor.tenantId);
  const rows = await db.all(
    `SELECT d.id, d.status, d.rate_bps, d.created_at, c.display_name, c.phone, c.ref_code,
       (SELECT COUNT(*) FROM distributor_links l WHERE l.distributor_id = d.id) AS team,
       (SELECT COALESCE(SUM(delta_fen) FILTER (WHERE kind = 'commission'), 0) FROM distributor_ledger g WHERE g.distributor_id = d.id) AS earned,
       (SELECT COALESCE(SUM(delta_fen), 0) FROM distributor_ledger g WHERE g.distributor_id = d.id) AS balance
     FROM distributors d JOIN customers c ON c.id = d.customer_id WHERE d.tenant_id = ?
     ORDER BY CASE d.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, d.id DESC`, [actor.tenantId]);
  const payouts = await db.all(
    `SELECT p.id, p.amount_fen, p.account, p.status, p.note, p.created_at, p.decided_at, c.display_name, c.phone
     FROM distributor_payouts p JOIN distributors d ON d.id = p.distributor_id JOIN customers c ON c.id = d.customer_id
     WHERE p.tenant_id = ? ORDER BY CASE p.status WHEN 'requested' THEN 0 ELSE 1 END, p.id DESC LIMIT 100`, [actor.tenantId]);
  return {
    settings,
    distributors: rows.map((r) => ({
      id: Number(r.id), status: r.status, rateBps: r.rate_bps === null ? null : Number(r.rate_bps), createdAt: Number(r.created_at),
      name: r.display_name, phone: r.phone, code: r.ref_code, team: Number(r.team), earnedFen: Number(r.earned), balanceFen: Number(r.balance),
    })),
    payouts: payouts.map((p) => ({
      id: Number(p.id), amountFen: Number(p.amount_fen), account: p.account, status: p.status, note: p.note, name: p.display_name, phone: p.phone,
      createdAt: Number(p.created_at), decidedAt: p.decided_at === null ? null : Number(p.decided_at),
    })),
  };
}

export async function saveDistributionSettings(db: Db, actor: Actor, b: Record<string, unknown>): Promise<Settings> {
  require_(actor, 'admin.write');
  const cur = await settingsOf(db, actor.tenantId);
  const flag = (v: unknown, name: string, fallback: boolean) => {
    if (v === undefined) return fallback;
    if (typeof v !== 'boolean') throw new DomainError(`${name} must be true or false`, 422);
    return v;
  };
  const next: Settings = {
    enabled: flag(b.enabled, 'enabled', cur.enabled),
    autoApprove: flag(b.autoApprove, 'autoApprove', cur.autoApprove),
    rateBps: b.rateBps === undefined ? cur.rateBps : whole(b.rateBps, 'rateBps', 0, MAX_RATE_BPS),
    minPayoutFen: b.minPayoutFen === undefined ? cur.minPayoutFen : whole(b.minPayoutFen, 'minPayoutFen', 0, MAX_MIN_PAYOUT_FEN),
  };
  await db.run(
    `INSERT INTO distribution_settings (tenant_id, enabled, rate_bps, min_payout_fen, auto_approve) VALUES (?,?,?,?,?)
     ON CONFLICT (tenant_id) DO UPDATE SET enabled = EXCLUDED.enabled, rate_bps = EXCLUDED.rate_bps,
       min_payout_fen = EXCLUDED.min_payout_fen, auto_approve = EXCLUDED.auto_approve`,
    [actor.tenantId, next.enabled, next.rateBps, next.minPayoutFen, next.autoApprove]);
  await audit(db, whoOf(actor), 'distribution.settings', 'tenant', actor.tenantId, next);
  return next;
}

/** approve / stop / resume a distributor. A stopped distributor earns nothing more but can still be paid what they earned. */
export async function decideDistributor(db: Db, actor: Actor, id: number, action: string): Promise<void> {
  require_(actor, 'admin.write');
  const status = DISTRIBUTOR_ACTIONS[action as keyof typeof DISTRIBUTOR_ACTIONS];
  if (!status) throw new DomainError(`action must be one of ${Object.keys(DISTRIBUTOR_ACTIONS).join(', ')}`, 422);
  const n = await db.run('UPDATE distributors SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND tenant_id = ?',
    [status, Date.now(), actor.id, id, actor.tenantId]);
  if (!n) throw new DomainError('distributor not found', 404);
  await audit(db, whoOf(actor), `distributor.${action}`, 'distributor', id, { status });
}

/** A personal rate for one distributor; null goes back to the company rate. */
export async function setDistributorRate(db: Db, actor: Actor, id: number, rateBps: unknown): Promise<void> {
  require_(actor, 'admin.write');
  const rate = rateBps === null ? null : whole(rateBps, 'rateBps', 0, MAX_RATE_BPS);
  const n = await db.run('UPDATE distributors SET rate_bps = ? WHERE id = ? AND tenant_id = ?', [rate, id, actor.tenantId]);
  if (!n) throw new DomainError('distributor not found', 404);
  await audit(db, whoOf(actor), 'distributor.rate', 'distributor', id, { rateBps: rate });
}

/** Finance pays the distributor (WeChat, Alipay, bank), then marks the request paid; a rejected request returns the money to the balance. */
export async function decidePayout(db: Db, actor: Actor, id: number, action: string, note: unknown): Promise<void> {
  require_(actor, 'payroll.write');
  const status = PAYOUT_ACTIONS[action as keyof typeof PAYOUT_ACTIONS];
  if (!status) throw new DomainError(`action must be one of ${Object.keys(PAYOUT_ACTIONS).join(', ')}`, 422);
  const text = typeof note === 'string' ? note.trim().slice(0, MAX_NOTE) : '';
  await db.tx(async (t) => {
    const p = await t.one("SELECT * FROM distributor_payouts WHERE id = ? AND tenant_id = ? FOR UPDATE", [id, actor.tenantId]);
    if (!p) throw new DomainError('payout not found', 404);
    if (p.status !== 'requested') throw new DomainError(`this payout was already ${p.status}`, 409);
    const now = Date.now();
    await t.run('UPDATE distributor_payouts SET status = ?, note = ?, decided_at = ?, decided_by = ? WHERE id = ?', [status, text, now, actor.id, id]);
    if (status === 'rejected') {
      await t.run("INSERT INTO distributor_ledger (tenant_id, distributor_id, delta_fen, kind, ref, ts) VALUES (?,?,?,'payout_back',?,?)",
        [actor.tenantId, p.distributor_id, Number(p.amount_fen), `payout-back:${id}`, now]);
    }
    await audit(t, whoOf(actor), `distributor.payout.${action}`, 'distributor_payout', id, { amount: Number(p.amount_fen), note: text });
  });
}
