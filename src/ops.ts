import type { Db } from './db.ts';
import { audit } from './db.ts';
import { expireStash } from './stash.ts';
import { settleIfPaid } from './bills.ts';
import { purgeExpiredGuestAuth } from './guest/accounts.ts';

export type Level = 'info' | 'warn' | 'error';

const MAX_OPS_EVENTS = 5000;
const PENDING_PAYMENT_TTL_MS = 15 * 60 * 1000;
const LATENCY_WINDOW = 500;
const ALERT_REPEAT_MS = 6 * 60 * 60 * 1000;

/** One JSON line per event on stdout (Railway captures it) and, for warn/error, a row in ops_events for the monitor UI. */
export async function logEvent(
  db: Db | null, level: Level, kind: string, message: string, detail: unknown = {}, scope: { tenantId?: number | null; storeId?: number | null } = {},
): Promise<void> {
  const line = { ts: new Date().toISOString(), level, kind, message, ...scope, detail };
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
  if (!db || level === 'info') return;
  try {
    await db.run('INSERT INTO ops_events (ts, level, kind, message, detail, tenant_id, store_id) VALUES (?,?,?,?,?,?,?)',
      [Date.now(), level, kind, message, JSON.stringify(detail), scope.tenantId ?? null, scope.storeId ?? null]);
    await db.run('DELETE FROM ops_events WHERE id < (SELECT COALESCE(MAX(id),0) - ? FROM ops_events)', [MAX_OPS_EVENTS]);
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', kind: 'ops.write_failed', message: (e as Error).message }));
  }
}

/** In-memory request metrics: counts by status class and a rolling latency window per route. */
export class Metrics {
  private started = Date.now();
  private counts = new Map<string, number>();
  private latency = new Map<string, number[]>();
  total = 0;
  errors5xx = 0;

  record(routeKey: string, status: number, ms: number): void {
    this.total++;
    if (status >= 500) this.errors5xx++;
    const k = `${routeKey} ${Math.floor(status / 100)}xx`;
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
    const w = this.latency.get(routeKey) ?? [];
    w.push(ms);
    if (w.length > LATENCY_WINDOW) w.shift();
    this.latency.set(routeKey, w);
  }

  snapshot() {
    const p = (arr: number[], q: number) => {
      const s = [...arr].sort((a, b) => a - b);
      return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : 0;
    };
    const routes = [...this.latency.entries()].map(([route, w]) => ({ route, n: w.length, p50: p(w, 0.5), p95: p(w, 0.95), max: Math.max(...w) }))
      .sort((a, b) => b.p95 - a.p95).slice(0, 25);
    return { uptimeSec: Math.round((Date.now() - this.started) / 1000), total: this.total, errors5xx: this.errors5xx, statuses: Object.fromEntries(this.counts), slowest: routes };
  }
}

/** Fixed-window limiter, in memory (single instance). Returns true if the call is allowed. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  private limit: number;
  private windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || h.reset <= now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      this.sweep(now);
      return true;
    }
    h.n++;
    return h.n <= this.limit;
  }

  clear(key: string): void {
    this.hits.delete(key);
  }

  private sweep(now: number): void {
    if (this.hits.size < 5000) return;
    for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
  }
}

export interface HealReport { checked: number; healed: Array<{ kind: string; ids: number[] }>; alerts: Array<{ kind: string; ids: number[] }> }

/**
 * Invariant checker + safe auto-repair. Repairs only what is unambiguous (stale flags, expiries,
 * a fully-paid bill that never got settled). Anything involving money that cannot be derived is
 * raised as an alert for a human instead of "fixed".
 */
export async function selfHeal(db: Db): Promise<HealReport> {
  const report: HealReport = { checked: 0, healed: [], alerts: [] };
  const healed = async (kind: string, ids: number[], message: string) => {
    if (!ids.length) return;
    report.healed.push({ kind, ids });
    await logEvent(db, 'warn', `heal.${kind}`, message, { ids });
  };
  const alert = async (kind: string, ids: number[], message: string) => {
    if (!ids.length) return;
    report.alerts.push({ kind, ids });
    // A standing condition (negative stock) would otherwise add a row every run and push real events out of the capped table.
    const alreadyLogged = await db.one('SELECT 1 AS x FROM ops_events WHERE kind = ? AND detail = ? AND ts > ?', [`alert.${kind}`, JSON.stringify({ ids }), Date.now() - ALERT_REPEAT_MS]);
    if (!alreadyLogged) await logEvent(db, 'error', `alert.${kind}`, message, { ids });
  };
  const ids = (rows: any[]) => rows.map((r) => r.id as number);

  report.checked++;
  const expired = await expireStash(db);
  if (expired) await logEvent(db, 'info', 'heal.stash_expired', `expired ${expired} stash items`);

  report.checked++;
  const stale = await db.all("UPDATE payments SET status = 'expired' WHERE status = 'pending' AND created_at < ? RETURNING id", [Date.now() - PENDING_PAYMENT_TTL_MS]);
  await healed('pending_payment_expired', ids(stale), `expired ${stale.length} unpaid online payments older than 15 min`);

  report.checked++;
  const ghostOccupied = await db.all(
    "UPDATE dining_tables t SET status = 'free' WHERE t.status = 'occupied' AND NOT EXISTS (SELECT 1 FROM bills b WHERE b.table_id = t.id AND b.status = 'open') RETURNING t.id");
  await healed('table_ghost_occupied', ids(ghostOccupied), 'tables marked occupied with no open bill were freed');

  report.checked++;
  const ghostFree = await db.all(
    "UPDATE dining_tables t SET status = 'occupied' WHERE t.status = 'free' AND EXISTS (SELECT 1 FROM bills b WHERE b.table_id = t.id AND b.status = 'open') RETURNING t.id");
  await healed('table_ghost_free', ids(ghostFree), 'tables with an open bill were marked free; fixed to occupied');

  report.checked++;
  const stuck = await db.all(
    `SELECT b.id FROM bills b WHERE b.status = 'open'
       AND (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.bill_id = b.id AND p.status = 'paid') > 0
       AND (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.bill_id = b.id AND p.status = 'paid') >=
           GREATEST(b.min_spend, COALESCE((SELECT SUM(qty * unit_price) FROM bill_lines l WHERE l.bill_id = b.id AND l.status = 'active' AND l.kind = 'sale'),0)) + b.table_fee - b.discount
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.bill_id = b.id AND p.status = 'pending')`);
  const settled: number[] = [];
  for (const b of stuck) {
    // One bill that cannot settle must not stop the remaining checks from running every minute.
    try {
      if (await settleIfPaid(db, null, b.id)) settled.push(b.id);
    } catch (e) {
      await logEvent(db, 'error', 'heal.settle_failed', `bill ${b.id} is fully paid but could not be settled: ${(e as Error).message}`, { id: b.id });
    }
  }
  await healed('paid_bill_settled', settled, 'fully paid bills that were never settled were settled');

  report.checked++;
  const overdue = await db.all(
    `SELECT b.id FROM bills b WHERE b.status = 'settled'
       AND (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.bill_id = b.id AND p.status = 'paid') <
           GREATEST(b.min_spend, COALESCE((SELECT SUM(qty * unit_price) FROM bill_lines l WHERE l.bill_id = b.id AND l.status = 'active' AND l.kind = 'sale'),0)) + b.table_fee - b.discount`);
  await alert('settled_underpaid', ids(overdue), 'settled bills whose payments are below the bill total: needs manual review');

  report.checked++;
  const negStock = await db.all('SELECT id FROM products WHERE track_stock AND stock < 0 AND active');
  await alert('negative_stock', ids(negStock), 'products with negative stock: a stocktake or stock-in was missed');

  await db.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
  await purgeExpiredGuestAuth(db);
  return report;
}

/** Runs selfHeal on an interval; never throws; stops when the returned function is called. */
export function startSelfHealLoop(db: Db, everyMs: number): () => void {
  const timer = setInterval(() => {
    selfHeal(db).catch((e) => logEvent(db, 'error', 'selfheal.failed', (e as Error).message));
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

export { audit };
