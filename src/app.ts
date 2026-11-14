import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { Db } from './db.ts';
import { audit, DomainError } from './db.ts';
import { actorFromToken, can, login, require_, switchStore, whoOf } from './auth.ts';
import type { Actor } from './auth.ts';
import { addLine, attachMember, getBill, listOpenTableless, openCounterSale, openTable, payrollSummary, setDiscount, settleIfPaid, transferTable, voidLine } from './bills.ts';
import { businessOf, requireModule, updateBusiness } from './business.ts';
import { scanCode } from './retail.ts';
import { registerStockRoutes } from './stock-routes.ts';
import { expireStash, lookupStash, retrieveWine, storeWine, transferStash } from './stash.ts';
import { cancelBooking, confirmBooking, createBooking, ingestDouyinBooking, listBookings, liveVoucherVerifier, mockVoucherVerifier, redeemVoucher, verifyDouyinSignature } from './bookings.ts';
import type { DouyinBookingEvent } from './bookings.ts';
import { handleNotify, payInstant, startOnlinePayment } from './payments.ts';
import { buildProviders } from './payments/index.ts';
import { MockProvider } from './payments/mock.ts';
import type { OnlineMethod, PayProvider } from './payments/types.ts';
import { copyCatalog, createStaff, createStore, hqSummary, listStores } from './hq.ts';
import {
  adjustStock, closeShift, collectReceivable, createProduct, createRule, createTable, currentShift, dailyReport, deleteRule,
  listReceivables, listRules, listShifts, listStaff, openShift, searchMembers, updateProduct, updateStaff, updateTable,
} from './admin.ts';
import { createPrinter, deletePrinter, listPrinters, updatePrinter } from './printers.ts';
import { createCompany, listCompanies, recentOps, setCompanyActive } from './platform.ts';
import { logEvent, Metrics, RateLimiter, selfHeal } from './ops.ts';
import { buildAssetManifest } from './static-assets.ts';
import { syncOps } from './sync.ts';
import { cleanPhone, normalizePhone } from './phone.ts';
import { HtmlPage, Redirect } from './responses.ts';
import { AlipayProvider } from './payments/alipay.ts';
import { buildIdentityProviders } from './guest/identity.ts';
import { buildSms } from './guest/sms.ts';
import { registerGuestRoutes } from './guest/routes.ts';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_TOPUP_FEN = 1_000_000_000;
const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};
const LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const API_PER_MINUTE = 600;
const SIGNUPS_PER_HOUR = 5;
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:*; frame-ancestors 'none'",
};

type Handler = (ctx: { db: Db; actor: Actor; token: string; params: string[]; body: any; query: URLSearchParams; ip: string; cookie: string }) => unknown | Promise<unknown>;
interface Route { method: string; pattern: RegExp; auth: boolean; key: string; handler: Handler }

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new DomainError('body too large', 413);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: unknown, contentType = 'application/json', extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': contentType, ...SECURITY_HEADERS, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function sameSecret(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** URL path params arrive percent-encoded (phones like "+86 138" are legitimate lookup keys); a malformed escape is kept as typed. */
function decodeParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Postgres rejects bad client input (value out of range, bad text, NUL byte, unique/not-null/check violation) with
 * an SQLSTATE in class 22 or 23. Those are the caller's fault, not a server bug, so they must not surface as a 500.
 */
function databaseInputStatus(e: unknown): { status: number; message: string } | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return undefined;
  if (code === '23505') return { status: 409, message: 'already exists' };
  // Deadlock victim / serialization failure: several devices changed the same bill at the same instant; nothing was written.
  if (code === '40P01' || code === '40001') return { status: 409, message: 'busy, please try again' };
  if (code.startsWith('22') || code.startsWith('23')) return { status: 422, message: 'invalid value' };
  return undefined;
}

export interface AppHandle { server: Server; metrics: Metrics }

export function createApp(db: Db, env: NodeJS.ProcessEnv = process.env): Server {
  return createAppWithMetrics(db, env).server;
}

export function createAppWithMetrics(db: Db, env: NodeJS.ProcessEnv = process.env): AppHandle {
  const providers = buildProviders(env);
  const baseUrl = env.PUBLIC_BASE_URL ?? 'http://localhost:3500';
  const isMock = env.PAY_MODE === 'mock';
  const verifier = isMock ? mockVoucherVerifier : liveVoucherVerifier;
  const mockSecret = env.MOCK_PAY_SECRET ?? 'dev-mock-secret';
  const adminKey = env.PLATFORM_ADMIN_KEY;
  const signupOpen = env.SIGNUP_OPEN === '1';
  const metrics = new Metrics();
  const loginLimiter = new RateLimiter(LOGIN_ATTEMPTS, LOGIN_WINDOW_MS);
  const apiLimiter = new RateLimiter(Number(env.API_PER_MINUTE ?? API_PER_MINUTE), 60_000);
  const signupLimiter = new RateLimiter(SIGNUPS_PER_HOUR, 60 * 60_000);

  // Every numeric input is an integer id, fen amount or epoch ms; anything else would reach SQL as NaN/1.5/1e30 and 500.
  const num = (v: unknown): number => {
    const n = typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN;
    if (!Number.isSafeInteger(n)) throw new DomainError('expected an integer number', 422);
    return n;
  };
  const routes: Route[] = [];
  const route = (method: string, path: string, auth: boolean, handler: Handler) =>
    routes.push({ method, pattern: new RegExp(`^${path.replace(/:\w+/g, '([^/]+)')}$`), auth, key: `${method} ${path}`, handler });
  const provider = (m: string): PayProvider => {
    const p = providers[m as OnlineMethod];
    if (!p) throw new DomainError(`${m} payments are not configured for this server`, 422);
    return p;
  };

  // ---- public ----
  route('GET', '/healthz', false, async ({ db }) => {
    await db.one('SELECT 1 AS ok');
    return { ok: true, mode: isMock ? 'mock' : 'live' };
  });
  route('GET', '/api/config', false, () => ({
    mock: isMock, signupOpen, payments: { wechat: Boolean(providers.wechat), alipay: Boolean(providers.alipay) },
  }));
  route('POST', '/api/login', false, async ({ db, body, ip }) => {
    const company = String(body.company ?? '');
    const username = String(body.username ?? '');
    const key = `${ip}|${company.toLowerCase()}|${username.toLowerCase()}`;
    if (!loginLimiter.allow(key)) {
      await logEvent(db, 'warn', 'auth.locked', 'too many login attempts', { ip, company, username });
      throw new DomainError('too many attempts, try again in a few minutes', 429);
    }
    try {
      const r = await login(db, company, username, String(body.pin ?? ''), body.storeId ? num(body.storeId) : undefined);
      loginLimiter.clear(key);
      return r;
    } catch (e) {
      if (e instanceof DomainError && e.status === 401) await logEvent(db, 'warn', 'auth.failed', 'failed login', { ip, company, username });
      throw e;
    }
  });
  route('POST', '/api/signup', false, async ({ db, body, ip }) => {
    if (!signupOpen) throw new DomainError('self sign-up is disabled', 403);
    if (!signupLimiter.allow(ip)) throw new DomainError('too many sign-ups from this address', 429);
    const made = await createCompany(db, body);
    await logEvent(db, 'info', 'company.signup', 'new company', { code: body.code });
    return made;
  });

  // ---- session ----
  route('POST', '/api/logout', true, async ({ db, token }) => {
    await db.run('DELETE FROM sessions WHERE token = ?', [token]);
    return { ok: true };
  });
  route('GET', '/api/me', true, async ({ actor, db }) => ({
    actor,
    store: await db.one('SELECT id, name, code FROM stores WHERE id = ?', [actor.storeId]),
    company: await db.one('SELECT name, code FROM tenants WHERE id = ?', [actor.tenantId]),
    business: await businessOf(db, actor.tenantId),
  }));
  route('GET', '/api/business', true, ({ db, actor }) => businessOf(db, actor.tenantId));
  route('PATCH', '/api/business', true, ({ db, actor, body }) => updateBusiness(db, actor, body));
  route('POST', '/api/switch-store', true, async ({ db, actor, token, body }) => ({ actor: await switchStore(db, token, actor, num(body.storeId)) }));

  // ---- floor ----
  route('GET', '/api/tables', true, ({ db, actor, query }) =>
    db.all(
      `SELECT t.*, (SELECT id FROM bills b WHERE b.table_id = t.id AND b.status = 'open') AS bill_id
       FROM dining_tables t WHERE t.store_id = ? AND (t.active OR ?) ORDER BY t.id`, [actor.storeId, query.get('all') === '1']));
  route('POST', '/api/tables', true, async ({ db, actor, body }) => ({ tableId: await createTable(db, actor, body) }));
  route('PATCH', '/api/tables/:id', true, async ({ db, actor, params, body }) => {
    await updateTable(db, actor, num(params[0]), body);
    return { ok: true };
  });
  route('GET', '/api/products', true, ({ db, actor, query }) =>
    db.all('SELECT * FROM products WHERE store_id = ? AND (active OR ?) ORDER BY category, id', [actor.storeId, query.get('all') === '1']));
  route('POST', '/api/products', true, async ({ db, actor, body }) => ({ productId: await createProduct(db, actor, body) }));
  route('PATCH', '/api/products/:id', true, async ({ db, actor, params, body }) => {
    await updateProduct(db, actor, num(params[0]), body);
    return { ok: true };
  });
  route('POST', '/api/products/:id/stock', true, async ({ db, actor, params, body }) => ({ stock: await adjustStock(db, actor, num(params[0]), num(body.delta), String(body.reason ?? '')) }));
  route('GET', '/api/commission-rules', true, ({ db, actor }) => listRules(db, actor));
  route('POST', '/api/commission-rules', true, async ({ db, actor, body }) => ({ ruleId: await createRule(db, actor, body) }));
  route('DELETE', '/api/commission-rules/:id', true, async ({ db, actor, params }) => {
    await deleteRule(db, actor, num(params[0]));
    return { ok: true };
  });

  // ---- printers (routing only: the local bridge owns the real addresses) ----
  route('GET', '/api/printers', true, ({ db, actor }) => listPrinters(db, actor));
  route('POST', '/api/printers', true, async ({ db, actor, body }) => ({ printerId: await createPrinter(db, actor, body) }));
  route('PATCH', '/api/printers/:id', true, async ({ db, actor, params, body }) => {
    await updatePrinter(db, actor, num(params[0]), body);
    return { ok: true };
  });
  route('DELETE', '/api/printers/:id', true, async ({ db, actor, params }) => {
    await deletePrinter(db, actor, num(params[0]));
    return { ok: true };
  });

  // ---- bills ----
  route('POST', '/api/bills', true, async ({ db, actor, body }) => ({ billId: await openTable(db, actor, body) }));
  route('GET', '/api/bills/:id', true, ({ db, actor, params }) => getBill(db, actor, num(params[0])));
  route('POST', '/api/bills/:id/lines', true, async ({ db, actor, params, body }) => ({
    lineId: await addLine(db, actor, num(params[0]), { productId: body.productId, qty: body.qty, gift: body.gift, reason: body.reason, weightG: body.weightG }),
  }));
  route('POST', '/api/bills/:id/scan', true, ({ db, actor, params, body }) => scanCode(db, actor, num(params[0]), body.code, body.qty === undefined ? 1 : num(body.qty)));
  route('POST', '/api/bills/:id/member', true, async ({ db, actor, params, body }) => {
    await attachMember(db, actor, num(params[0]), cleanPhone(body.phone));
    return { ok: true };
  });
  route('GET', '/api/counter-sales', true, ({ db, actor }) => listOpenTableless(db, actor));
  route('POST', '/api/counter-sales', true, async ({ db, actor, body }) => ({
    billId: await openCounterSale(db, actor, { phone: body.phone || undefined, repId: body.repId == null ? undefined : num(body.repId) }),
  }));
  route('POST', '/api/bills/:id/lines/:lid/void', true, async ({ db, actor, params, body }) => {
    await voidLine(db, actor, num(params[0]), num(params[1]), String(body.reason ?? ''));
    return { ok: true };
  });
  route('POST', '/api/bills/:id/discount', true, async ({ db, actor, params, body }) => {
    await setDiscount(db, actor, num(params[0]), num(body.amount), String(body.reason ?? ''));
    return { ok: true };
  });
  route('POST', '/api/bills/:id/transfer', true, async ({ db, actor, params, body }) => {
    await transferTable(db, actor, num(params[0]), num(body.toTableId));
    return { ok: true };
  });
  route('POST', '/api/bills/:id/pay', true, ({ db, actor, params, body }) => {
    if (!['cash', 'member', 'credit'].includes(body.method)) throw new DomainError('method must be cash, member or credit', 422);
    return payInstant(db, actor, num(params[0]), body.method, body.amount === undefined ? undefined : num(body.amount));
  });
  route('POST', '/api/sync', true, ({ db, actor, body }) => syncOps(db, actor, body));
  route('POST', '/api/bills/:id/pay-online', true, ({ db, actor, params, body }) =>
    startOnlinePayment(db, actor, provider(String(body.method)), baseUrl, num(params[0]), body.amount === undefined ? undefined : num(body.amount)));
  route('POST', '/api/bills/:id/redeem', true, async ({ db, actor, params, body }) => {
    const billId = num(params[0]);
    const amount = await redeemVoucher(db, actor, verifier, billId, String(body.code ?? ''));
    return { amount, settled: await settleIfPaid(db, actor.id, billId) };
  });

  // ---- bookings ----
  route('POST', '/api/bookings', true, async ({ db, actor, body }) => ({ bookingId: await createBooking(db, actor, body) }));
  route('GET', '/api/bookings', true, ({ db, actor }) => listBookings(db, actor));
  route('POST', '/api/bookings/:id/confirm', true, async ({ db, actor, params, body }) => {
    await confirmBooking(db, actor, num(params[0]), num(body.tableId), num(body.repId));
    return { ok: true };
  });
  route('POST', '/api/bookings/:id/cancel', true, async ({ db, actor, params, body }) => {
    await cancelBooking(db, actor, num(params[0]), body.noShow ? 'no_show' : 'cancelled');
    return { ok: true };
  });

  // ---- stash ----
  const stashOn = (actor: Actor) => requireModule(db, actor.tenantId, 'stash');
  route('POST', '/api/stash', true, async ({ db, actor, body }) => { await stashOn(actor); return storeWine(db, actor, body); });
  route('GET', '/api/stash', true, async ({ db, actor, query }) => { await stashOn(actor); return lookupStash(db, actor, query.get('q') ?? ''); });
  route('POST', '/api/stash/:id/retrieve', true, async ({ db, actor, params, body }) => {
    await stashOn(actor);
    return retrieveWine(db, actor, { stashId: num(params[0]), qtyMilli: num(body.qtyMilli), billId: num(body.billId) });
  });
  route('POST', '/api/stash/:id/transfer', true, async ({ db, actor, params, body }) => {
    await stashOn(actor);
    await transferStash(db, actor, num(params[0]), num(body.toStoreId));
    return { ok: true };
  });

  // ---- members (tenant-wide wallet) ----
  route('POST', '/api/members/topup', true, async ({ db, actor, body }) => {
    require_(actor, 'admin.write');
    const amount = num(body.amount);
    const bonus = num(body.bonus ?? 0);
    const phone = cleanPhone(body.phone);
    if (!Number.isInteger(amount) || amount <= 0 || !Number.isInteger(bonus) || bonus < 0) throw new DomainError('amount/bonus must be fen integers', 422);
    if (amount > MAX_TOPUP_FEN || bonus > MAX_TOPUP_FEN) throw new DomainError(`a single top-up is limited to ${MAX_TOPUP_FEN} fen`, 422);
    return db.tx(async (t) => {
      await t.run('INSERT INTO members (tenant_id, phone) VALUES (?,?) ON CONFLICT (tenant_id, phone) DO NOTHING', [actor.tenantId, phone]);
      const m = await t.one('UPDATE members SET balance = balance + ? WHERE tenant_id = ? AND phone = ? RETURNING *', [amount + bonus, actor.tenantId, phone]);
      await t.run('INSERT INTO wallet_ledger (member_id, store_id, delta, reason, ts) VALUES (?,?,?,?,?)', [m.id, actor.storeId, amount + bonus, `top-up ${amount} + bonus ${bonus}`, Date.now()]);
      await audit(t, whoOf(actor), 'member.topup', 'member', m.id, { amount, bonus });
      return m;
    });
  });
  route('GET', '/api/members', true, ({ db, actor, query }) => searchMembers(db, actor, query.get('q') ?? ''));
  route('GET', '/api/members/:phone', true, async ({ db, actor, params }) => {
    const m = await db.one('SELECT id, phone, name, balance FROM members WHERE tenant_id = ? AND phone = ?', [actor.tenantId, normalizePhone(params[0])]);
    if (!m) throw new DomainError('member not found', 404);
    return m;
  });

  // ---- money reports ----
  route('GET', '/api/payroll', true, ({ db, actor, query }) =>
    payrollSummary(db, actor, num(query.get('from') ?? 0), num(query.get('to') ?? Date.now() + 1), query.get('all') === '1'));
  route('GET', '/api/reports/daily', true, ({ db, actor, query }) => dailyReport(db, actor, num(query.get('from') ?? 0), num(query.get('to') ?? Date.now() + 1)));
  route('GET', '/api/audit', true, ({ db, actor, query }) => {
    require_(actor, 'audit.read');
    const wide = query.get('all') === '1' && can(actor, 'hq.read');
    return db.all('SELECT * FROM audit WHERE tenant_id = ? AND (? OR store_id = ?) ORDER BY id DESC LIMIT 200', [actor.tenantId, wide, actor.storeId]);
  });
  route('POST', '/api/shifts/open', true, async ({ db, actor, body }) => ({ shiftId: await openShift(db, actor, num(body.openingCash ?? 0)) }));
  route('GET', '/api/shifts/current', true, ({ db, actor }) => currentShift(db, actor));
  route('POST', '/api/shifts/close', true, ({ db, actor, body }) => closeShift(db, actor, num(body.countedCash)));
  route('GET', '/api/shifts', true, ({ db, actor }) => listShifts(db, actor));
  route('GET', '/api/receivables', true, ({ db, actor }) => listReceivables(db, actor));
  route('POST', '/api/receivables/:id/collect', true, ({ db, actor, params, body }) => collectReceivable(db, actor, num(params[0]), num(body.amount), String(body.method ?? '')));
  route('POST', '/api/maintenance/expire-stash', true, async ({ db, actor }) => {
    require_(actor, 'admin.write');
    return { expired: await expireStash(db) };
  });

  // ---- staff and head office ----
  // Any signed-in staff may pick a sales rep when opening a table; only names and ids are exposed.
  route('GET', '/api/reps', true, ({ db, actor }) =>
    db.all('SELECT id, name, role, store_id AS "storeId", active FROM employees WHERE tenant_id = ? AND active AND (store_id = ? OR store_id IS NULL) ORDER BY name', [actor.tenantId, actor.storeId]));
  route('GET', '/api/staff', true, ({ db, actor }) => listStaff(db, actor));
  route('PATCH', '/api/staff/:id', true, async ({ db, actor, params, body }) => {
    await updateStaff(db, actor, num(params[0]), body);
    return { ok: true };
  });
  route('GET', '/api/hq/stores', true, ({ db, actor }) => listStores(db, actor));
  route('POST', '/api/hq/stores', true, async ({ db, actor, body }) => ({ storeId: await createStore(db, actor, body) }));
  route('POST', '/api/hq/staff', true, async ({ db, actor, body }) => ({ employeeId: await createStaff(db, actor, body) }));
  route('POST', '/api/hq/catalog/copy', true, ({ db, actor, body }) => {
    if (!Array.isArray(body.toStoreIds)) throw new DomainError('toStoreIds must be an array', 422);
    return copyCatalog(db, actor, num(body.fromStoreId), body.toStoreIds.map(num));
  });
  route('GET', '/api/hq/summary', true, ({ db, actor, query }) => hqSummary(db, actor, num(query.get('from') ?? 0), num(query.get('to') ?? Date.now() + 1)));

  // ---- platform operator (SaaS owner) ----
  route('GET', '/platform/companies', false, ({ db }) => listCompanies(db));
  route('POST', '/platform/companies', false, ({ db, body }) => createCompany(db, body));
  route('POST', '/platform/companies/:code/active', false, async ({ db, params, body }) => {
    await setCompanyActive(db, decodeURIComponent(params[0]), body.active !== false);
    return { ok: true };
  });
  route('GET', '/platform/ops', false, ({ db, query }) => recentOps(db, num(query.get('limit') ?? 200), query.get('level') ?? undefined));
  route('GET', '/platform/metrics', false, () => metrics.snapshot());
  route('POST', '/platform/selfheal', false, ({ db }) => selfHeal(db));

  registerStockRoutes(route, { num });

  registerGuestRoutes(route, {
    db, payProviders: providers, baseUrl, isMock, num, sms: buildSms(env), smsPerHour: env.GUEST_SMS_PER_HOUR ? Number(env.GUEST_SMS_PER_HOUR) : undefined,
    otpPerIpPerHour: env.GUEST_OTP_PER_IP_PER_HOUR ? Number(env.GUEST_OTP_PER_IP_PER_HOUR) : undefined,
    identities: buildIdentityProviders(env, providers.alipay instanceof AlipayProvider ? providers.alipay : undefined),
  });

  if (isMock) {
    route('POST', '/dev/mock-pay', true, async ({ db, actor, body }) => {
      const p = await db.one(
        `SELECT p.* FROM payments p JOIN bills b ON b.id = p.bill_id JOIN stores s ON s.id = b.store_id
         WHERE p.out_trade_no = ? AND s.tenant_id = ?`, [body.outTradeNo, actor.tenantId]);
      if (!p) throw new DomainError('payment not found', 404);
      const raw = JSON.stringify({ eventId: `evt_${Date.now()}_${Math.random()}`, outTradeNo: p.out_trade_no, amountFen: p.amount, status: 'paid' });
      const mock = providers[p.method as OnlineMethod] as MockProvider;
      await handleNotify(db, p.method, mock, { 'x-mock-signature': mock.sign(raw) }, raw);
      return { ok: true };
    });
  }

  const serveStatic = (res: ServerResponse, pathname: string): void => {
    // Customer app: every /g/... address (venue, store, table QR) is the same single page; it routes itself.
    const isGuestPage = pathname === '/g' || pathname.startsWith('/g/');
    const rel = isGuestPage ? 'guest/index.html' : normalize(pathname === '/' ? '/index.html' : pathname).replace(/^([/\\])+/, '');
    const file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || !statSync(file).isFile()) throw new DomainError('not found', 404);
    // The service worker carries the asset list and a content version, so any changed file changes sw.js and triggers an update.
    const body = rel === 'sw.js'
      ? readFileSync(file, 'utf8').replace('/*BUILD*/ null', JSON.stringify(buildAssetManifest(PUBLIC_DIR)))
      : readFileSync(file);
    send(res, 200, body, MIME[extname(file)] ?? 'application/octet-stream', { 'Cache-Control': 'no-cache' });
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = Date.now();
    // Prefixing the origin (instead of passing it as a base) stops "//host/path" or "//" from being read as a
    // protocol-relative url, which used to throw outside the try block and leave the request hanging.
    let url: URL;
    try {
      url = new URL(`http://localhost${req.url ?? '/'}`);
    } catch {
      return send(res, 400, { error: 'malformed url' });
    }
    // The proxy appends the real client address on the right; anything to its left is client-controlled and would let
    // an attacker dodge the login lockout by rotating a fake X-Forwarded-For.
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',').pop()!.trim();
    let status = 200;
    // Constant until a route matches, so random 404 urls cannot grow the metrics maps without bound.
    let routeKey = `${req.method} ${url.pathname.startsWith('/api/') ? '/api/(unmatched)' : url.pathname.startsWith('/platform/') ? '/platform/(unmatched)' : '(static)'}`;
    let scope: { tenantId?: number; storeId?: number } = {};
    try {
      const m = /^\/webhooks\/(wechat|alipay)$/.exec(url.pathname);
      if (req.method === 'POST' && m) {
        const raw = await readRaw(req);
        let ack: string;
        try {
          ack = await handleNotify(db, m[1] as OnlineMethod, provider(m[1]), req.headers as any, raw);
        } catch (e) {
          if (e instanceof DomainError) {
            // A validly signed callback we refused (wrong amount, unknown order, wrong method) means money may have moved without a record.
            await logEvent(db, 'error', 'webhook.unreconciled', `${m[1]} callback refused: ${e.message}`, { ip, status: e.status });
            throw e;
          }
          await logEvent(db, 'warn', 'webhook.rejected', `${m[1]} callback rejected: ${(e as Error).message}`, { ip });
          throw new DomainError('webhook rejected', 401);
        }
        return send(res, 200, ack, m[1] === 'alipay' ? 'text/plain' : 'application/json');
      }
      if (req.method === 'POST' && url.pathname === '/webhooks/douyin') {
        const raw = await readRaw(req);
        if (!verifyDouyinSignature(env.DOUYIN_WEBHOOK_SECRET ?? (isMock ? mockSecret : ''), raw, req.headers['x-douyin-signature'] as string | undefined)) {
          await logEvent(db, 'warn', 'webhook.rejected', 'douyin callback with bad signature', { ip });
          throw new DomainError('bad douyin signature', 401);
        }
        return send(res, 200, await ingestDouyinBooking(db, JSON.parse(raw) as DouyinBookingEvent));
      }

      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/dev/') || url.pathname.startsWith('/platform/') || url.pathname === '/healthz') {
        // Limit per session token, not per IP: a whole venue shares one NAT address, so an IP limit would throttle all its tablets.
        // Unauthenticated calls fall back to a per-IP limit.
        const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
        if (url.pathname.startsWith('/api/') && !apiLimiter.allow(bearer ? `tok|${bearer}` : `ip|${ip}`)) throw new DomainError('rate limit exceeded', 429);
        const raw = req.method === 'GET' || req.method === 'DELETE' ? '' : await readRaw(req);
        const body = raw ? JSON.parse(raw) : {};
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new DomainError('body must be a JSON object', 400);
        for (const r of routes) {
          const match = r.pattern.exec(url.pathname);
          if (r.method !== req.method || !match) continue;
          routeKey = r.key;
          if (url.pathname.startsWith('/platform/') && !sameSecret(req.headers['x-admin-key'] as string | undefined, adminKey)) {
            // wrong guesses at the operator key are throttled like wrong PINs
            if (!loginLimiter.allow(`admin|${ip}`)) throw new DomainError('too many attempts, try again in a few minutes', 429);
            throw new DomainError('forbidden', 403);
          }
          const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
          const actor = r.auth ? await actorFromToken(db, token || undefined) : (undefined as unknown as Actor);
          if (actor) scope = { tenantId: actor.tenantId, storeId: actor.storeId };
          const out = await r.handler({ db, actor, token, params: match.slice(1).map(decodeParam), body, query: url.searchParams, ip, cookie: String(req.headers.cookie ?? '') });
          if (out instanceof Redirect) {
            status = 302;
            res.writeHead(302, { Location: out.location, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...out.headers });
            return void res.end();
          }
          if (out instanceof HtmlPage) return send(res, 200, out.body, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
          return send(res, 200, out);
        }
        throw new DomainError('not found', 404);
      }
      serveStatic(res, url.pathname);
    } catch (e) {
      if (e instanceof DomainError) {
        status = e.status;
        return send(res, e.status, { error: e.message });
      }
      if (e instanceof SyntaxError) {
        status = 400;
        return send(res, 400, { error: 'invalid JSON' });
      }
      const dbStatus = databaseInputStatus(e);
      if (dbStatus) {
        status = dbStatus.status;
        return send(res, dbStatus.status, { error: dbStatus.message });
      }
      status = 500;
      await logEvent(db, 'error', 'http.500', (e as Error).message, { route: routeKey, stack: (e as Error).stack?.split('\n').slice(0, 4) }, scope);
      return send(res, 500, { error: 'internal error' });
    } finally {
      const ms = Date.now() - started;
      status = res.statusCode || status;
      metrics.record(routeKey, status, ms);
      if (status !== 404 || routeKey.startsWith('POST') || routeKey.startsWith('GET /api')) {
        void logEvent(null, status >= 500 ? 'error' : 'info', 'http', `${req.method} ${url.pathname} ${status} ${ms}ms`, { status, ms }, scope);
      }
    }
  };
  return { server: createServer((req, res) => {
    handler(req, res).catch((e) => {
      void logEvent(db, 'error', 'http.unhandled', (e as Error).message);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.end();
    });
  }), metrics };
}
