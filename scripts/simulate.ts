/**
 * Multi-company load simulation: many companies, stores and staff using the system at the same time,
 * then an invariant audit. Works against any running server (local dev or the deployed one).
 *
 *   node scripts/simulate.ts <baseUrl> <platformAdminKey> [companies=4] [billsPerCashier=25]
 *
 * Exits non-zero if any 5xx, unexpected 4xx, lost money, cross-tenant leak, or self-heal finding occurred.
 */
const BASE = (process.argv[2] ?? 'http://localhost:3500').replace(/\/$/, '');
const ADMIN_KEY = process.argv[3] ?? 'dev-admin-key';
const COMPANIES = Number(process.argv[4] ?? 4);
const BILLS_PER_CASHIER = Number(process.argv[5] ?? 25);
const STORES_PER_COMPANY = 2;
const MEMBERS_PER_STORE = 12;
const RUN_ID = Date.now().toString(36);
const PIN = 'sim-pin-1';

// ---- tiny deterministic PRNG so a failing run can be repeated ----
let seedState = Number(process.env.SIM_SEED ?? 1234567);
const rnd = () => {
  seedState = (seedState * 1664525 + 1013904223) % 4294967296;
  return seedState / 4294967296;
};
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
const chance = (p: number) => rnd() < p;

// ---- http with accounting ----
const stats = { calls: 0, byStatus: new Map<string, number>(), unexpected: [] as string[], latencies: [] as number[] };
async function http(method: string, path: string, body?: unknown, opts: { token?: string; admin?: boolean; expect?: number[] } = {}): Promise<{ status: number; json: any }> {
  const t0 = performance.now();
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}), ...(opts.admin ? { 'x-admin-key': ADMIN_KEY } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  stats.calls++;
  stats.latencies.push(performance.now() - t0);
  const k = `${method} ${path.replace(/\d+/g, ':n').split('?')[0]} ${res.status}`;
  stats.byStatus.set(k, (stats.byStatus.get(k) ?? 0) + 1);
  const ok = opts.expect ? opts.expect.includes(res.status) : res.status < 400;
  if (!ok) stats.unexpected.push(`${k} ${JSON.stringify(json).slice(0, 160)}`);
  return { status: res.status, json };
}
const must = async (p: Promise<{ status: number; json: any }>) => {
  const r = await p;
  if (r.status >= 400) throw new Error(`setup failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
};

// ---- world model ----
interface Session { token: string; storeId: number }
interface StoreWorld {
  storeId: number; name: string;
  manager: Session; cashiers: Session[]; waiters: Array<{ s: Session; id: number }>; reps: number[]; hosts: Session[];
  tableIds: number[]; products: Array<{ id: number; price: number; category: string }>; members: string[];
  expectedRevenue: number; settledBills: number;
}
interface CompanyWorld { code: string; name: string; owner: Session; stores: StoreWorld[] }

const login = async (company: string, username: string, pin = PIN, storeId?: number): Promise<{ token: string; actor: any }> => must(http('POST', '/api/login', { company, username, pin, storeId }));

async function buildCompany(i: number): Promise<CompanyWorld> {
  const code = `sim${RUN_ID}-${i}`;
  await must(http('POST', '/platform/companies', {
    name: `Sim Company ${i}`, code, storeName: `S${i}-1`, ownerName: 'Owner', ownerUsername: 'owner', ownerPin: PIN,
  }, { admin: true }));
  const ownerLogin = await login(code, 'owner');
  const owner: Session = { token: ownerLogin.token, storeId: ownerLogin.actor.storeId };
  const stores = await must(http('GET', '/api/hq/stores', undefined, { token: owner.token }));
  const storeIds: number[] = [stores[0].id];
  for (let s = 2; s <= STORES_PER_COMPANY; s++) {
    storeIds.push((await must(http('POST', '/api/hq/stores', { name: `S${i}-${s}`, code: `S${s}` }, { token: owner.token }))).storeId);
  }
  const world: CompanyWorld = { code, name: `Sim Company ${i}`, owner, stores: [] };
  for (const [idx, storeId] of storeIds.entries()) {
    const u = (role: string, n: number) => `${role}${idx + 1}x${n}`;
    const staffIds: Record<string, number[]> = {};
    for (const [role, count] of [['manager', 1], ['cashier', 2], ['waiter', 3], ['host', 2]] as const) {
      staffIds[role] = [];
      for (let n = 1; n <= count; n++) {
        staffIds[role].push((await must(http('POST', '/api/hq/staff', { name: u(role, n), username: u(role, n), role, pin: PIN, storeId }, { token: owner.token }))).employeeId);
      }
    }
    const sess = async (role: string, n: number): Promise<Session> => ({ token: (await login(code, u(role, n))).token, storeId });
    const manager = await sess('manager', 1);
    const tableIds: number[] = [];
    for (let t = 1; t <= 12; t++) {
      tableIds.push((await must(http('POST', '/api/tables', { name: `T${t}`, kind: t > 10 ? 'room' : 'booth', minSpend: t > 10 ? 50000 : t > 6 ? 20000 : 0 }, { token: manager.token }))).tableId);
    }
    const products: StoreWorld['products'] = [];
    for (const [name, category, price] of [['Whisky', 'spirits', 98800], ['Cognac', 'spirits', 128800], ['Beer', 'beer', 2800], ['Platter', 'food', 18800], ['Mixer', 'food', 6800], ['Vodka', 'spirits', 58800]] as const) {
      const id = (await must(http('POST', '/api/products', { name, nameEn: name, category, price, stock: 100000 }, { token: manager.token }))).productId;
      products.push({ id, price, category });
    }
    const members: string[] = [];
    for (let m = 0; m < MEMBERS_PER_STORE; m++) {
      const phone = `1${String(RUN_ID).replace(/\D/g, '').padEnd(3, '7').slice(0, 3)}${i}${idx}${String(m).padStart(5, '0')}`;
      await must(http('POST', '/api/members/topup', { phone, amount: 500000, bonus: 50000 }, { token: manager.token }));
      members.push(phone);
    }
    world.stores.push({
      storeId, name: `S${i}-${idx + 1}`, manager,
      cashiers: await Promise.all([1, 2].map((n) => sess('cashier', n))),
      waiters: await Promise.all([1, 2, 3].map(async (n) => ({ s: await sess('waiter', n), id: staffIds.waiter[n - 1] }))),
      hosts: await Promise.all([1, 2].map((n) => sess('host', n))),
      reps: staffIds.host, tableIds, products, members, expectedRevenue: 0, settledBills: 0,
    });
  }
  return world;
}

// ---- virtual cashier: runs a night of business on one store ----
async function runCashier(co: CompanyWorld, st: StoreWorld, cashierIdx: number, report: Report): Promise<void> {
  const cashier = st.cashiers[cashierIdx];
  const host = st.hosts[cashierIdx];
  await http('POST', '/api/shifts/open', { openingCash: 100000 }, { token: cashier.token });
  let cashTaken = 0;
  for (let n = 0; n < BILLS_PER_CASHIER; n++) {
    const tables = (await http('GET', '/api/tables', undefined, { token: host.token })).json as any[];
    const free = tables.filter((t) => t.status === 'free');
    if (!free.length) { await sleep(20); continue; }
    const table = pick(free);
    const phone = chance(0.8) ? pick(st.members) : undefined;
    // another host may grab the same table first: 409 is the correct, expected outcome of that race
    const open = await http('POST', '/api/bills', { tableId: table.id, repId: pick(st.reps), phone }, { token: host.token, expect: [200, 409] });
    if (open.status === 409) { report.raceLosses++; continue; }
    const billId: number = open.json.billId;

    const lineCount = 1 + Math.floor(rnd() * 5);
    for (let l = 0; l < lineCount; l++) {
      await http('POST', `/api/bills/${billId}/lines`, { productId: pick(st.products).id, qty: 1 + Math.floor(rnd() * 3) }, { token: pick(st.waiters).s.token });
    }
    if (chance(0.08)) {
      const lines = (await http('GET', `/api/bills/${billId}`, undefined, { token: cashier.token })).json.lines as any[];
      await http('POST', `/api/bills/${billId}/lines/${lines[0].id}/void`, { reason: 'sim: wrong item' }, { token: st.manager.token });
      if (lines.length === 1) await http('POST', `/api/bills/${billId}/lines`, { productId: pick(st.products).id, qty: 1 }, { token: pick(st.waiters).s.token });
    }
    if (chance(0.1)) await http('POST', `/api/bills/${billId}/lines`, { productId: pick(st.products).id, qty: 1, gift: true, reason: 'sim: vip gift' }, { token: st.manager.token });
    if (chance(0.1)) await http('POST', `/api/bills/${billId}/discount`, { amount: 1000, reason: 'sim: regular' }, { token: st.manager.token });
    if (phone && chance(0.15)) {
      const s = await http('POST', '/api/stash', { phone, productId: st.products[0].id, qtyMilli: 600 }, { token: pick(st.waiters).s.token });
      if (s.status === 200 && chance(0.5)) await http('POST', `/api/stash/${s.json.id}/retrieve`, { qtyMilli: 200, billId }, { token: pick(st.waiters).s.token });
    }

    const view = async () => (await http('GET', `/api/bills/${billId}`, undefined, { token: cashier.token })).json;
    let b = await view();
    const total: number = b.totals.total;
    const mode = rnd();
    if (total === 0) {
      // an all-voided bill has nothing to pay; the system must refuse rather than settle it, and a manager must be able to close the table
      await http('POST', `/api/bills/${billId}/pay`, { method: 'cash' }, { token: cashier.token, expect: [409] });
      await http('POST', `/api/bills/${billId}/lines`, { productId: st.products[2].id, qty: 1 }, { token: pick(st.waiters).s.token });
      b = await view();
    }
    const due = (b.totals.due as number);
    if (mode < 0.35) {
      await http('POST', `/api/bills/${billId}/pay`, { method: 'cash' }, { token: cashier.token });
      cashTaken += due;
    } else if (mode < 0.55 && phone) {
      const r = await http('POST', `/api/bills/${billId}/pay`, { method: 'member' }, { token: cashier.token, expect: [200, 402] });
      if (r.status === 402) { await http('POST', `/api/bills/${billId}/pay`, { method: 'cash' }, { token: cashier.token }); cashTaken += due; }
    } else if (mode < 0.7) {
      const part = Math.floor(due / 2);
      await http('POST', `/api/bills/${billId}/pay`, { method: 'cash', amount: part }, { token: cashier.token });
      cashTaken += part;
      await http('POST', `/api/bills/${billId}/pay`, { method: 'cash' }, { token: cashier.token });
      cashTaken += due - part;
    } else if (mode < 0.8) {
      await http('POST', `/api/bills/${billId}/pay`, { method: 'credit' }, { token: cashier.token });
      report.creditFen += due;
    } else if (mode < 0.9 && report.mock) {
      const p = await http('POST', `/api/bills/${billId}/pay-online`, { method: pick(['wechat', 'alipay']) }, { token: cashier.token });
      await http('POST', '/dev/mock-pay', { outTradeNo: p.json.outTradeNo }, { token: cashier.token });
      await http('POST', '/dev/mock-pay', { outTradeNo: p.json.outTradeNo }, { token: cashier.token }); // duplicate delivery
    } else if (due > 5000 && report.mock) {
      await http('POST', `/api/bills/${billId}/redeem`, { code: `DY-10-${RUN_ID}${billId}` }, { token: cashier.token });
      await http('POST', `/api/bills/${billId}/pay`, { method: 'cash' }, { token: cashier.token });
      cashTaken += due - 1000;
    } else {
      await http('POST', `/api/bills/${billId}/pay`, { method: 'cash' }, { token: cashier.token });
      cashTaken += due;
    }
    b = await view();
    if (b.bill.status === 'settled') {
      st.expectedRevenue += b.totals.total;
      st.settledBills++;
    } else {
      report.problems.push(`bill ${billId} (${co.code}/${st.name}) not settled after payment: status=${b.bill.status} due=${b.totals.due}`);
    }
  }
  const cur = (await http('GET', '/api/shifts/current', undefined, { token: cashier.token })).json;
  const close = await http('POST', '/api/shifts/close', { countedCash: cur.expectedCash }, { token: cashier.token });
  if (close.json.variance !== 0) report.problems.push(`shift variance ${close.json.variance} for ${co.code}/${st.name} (cashier tracked cash ${cashTaken})`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Report { mock: boolean; raceLosses: number; creditFen: number; problems: string[] }

/** After the run: reconcile every company against what the virtual cashiers know, and probe isolation. */
async function audit(worlds: CompanyWorld[], report: Report): Promise<void> {
  for (const co of worlds) {
    const hq = (await http('GET', '/api/hq/summary?from=0', undefined, { token: co.owner.token })).json;
    if (!hq.stores) { report.problems.push(`HQ summary failed for ${co.code}: ${JSON.stringify(hq)}`); continue; }
    for (const st of co.stores) {
      const row = hq.stores.find((r: any) => r.storeId === st.storeId);
      if (!row) { report.problems.push(`${co.code}/${st.name} missing from HQ summary`); continue; }
      if (row.revenue !== st.expectedRevenue) report.problems.push(`REVENUE MISMATCH ${co.code}/${st.name}: hq=${row.revenue} expected=${st.expectedRevenue}`);
      if (row.bills !== st.settledBills) report.problems.push(`BILL COUNT MISMATCH ${co.code}/${st.name}: hq=${row.bills} expected=${st.settledBills}`);
      if (row.openBills !== 0) report.problems.push(`${co.code}/${st.name} still has ${row.openBills} open bills`);
      const tables = (await http('GET', '/api/tables', undefined, { token: st.manager.token })).json as any[];
      const stuck = tables.filter((t) => t.status !== 'free');
      if (stuck.length) report.problems.push(`${co.code}/${st.name}: ${stuck.length} tables not free after close`);
    }
  }
  // isolation: another company's token must not see or touch this company's records
  for (let i = 0; i < worlds.length; i++) {
    const a = worlds[i];
    const b = worlds[(i + 1) % worlds.length];
    if (a === b) continue;
    const bills = await http('GET', '/api/bills/1', undefined, { token: b.owner.token, expect: [200, 404] });
    if (bills.status === 200 && bills.json.bill?.store_id && a.stores.some((s) => s.storeId === bills.json.bill.store_id)) report.problems.push(`CROSS-TENANT LEAK: ${b.code} can read a bill of ${a.code}`);
    const member = await http('GET', `/api/members/${a.stores[0].members[0]}`, undefined, { token: b.owner.token, expect: [404] });
    if (member.status === 200) report.problems.push(`CROSS-TENANT LEAK: ${b.code} can read member of ${a.code}`);
    const catalog = await http('POST', '/api/hq/catalog/copy', { fromStoreId: a.stores[0].storeId, toStoreIds: [b.stores[0].storeId] }, { token: b.owner.token, expect: [404] });
    if (catalog.status === 200) report.problems.push(`CROSS-TENANT WRITE: ${b.code} copied catalog from ${a.code}`);
  }
}

async function main(): Promise<void> {
  const cfg = (await http('GET', '/api/config')).json;
  const report: Report = { mock: Boolean(cfg.mock), raceLosses: 0, creditFen: 0, problems: [] };
  console.log(`[sim] target=${BASE} companies=${COMPANIES} stores/company=${STORES_PER_COMPANY} bills/cashier=${BILLS_PER_CASHIER} mock=${report.mock}`);

  const t0 = Date.now();
  const worlds = await Promise.all(Array.from({ length: COMPANIES }, (_, i) => buildCompany(i + 1)));
  console.log(`[sim] built ${worlds.length} companies in ${Date.now() - t0}ms`);

  const t1 = Date.now();
  const jobs: Array<Promise<void>> = [];
  for (const co of worlds) for (const st of co.stores) for (let c = 0; c < st.cashiers.length; c++) jobs.push(runCashier(co, st, c, report).catch((e) => { report.problems.push(`cashier crashed ${co.code}/${st.name}: ${e.message}`); }));
  await Promise.all(jobs);
  console.log(`[sim] ${jobs.length} cashiers finished in ${Date.now() - t1}ms (${stats.calls} calls)`);

  await audit(worlds, report);

  const heal = await http('POST', '/platform/selfheal', undefined, { admin: true });
  const healed = (heal.json.healed ?? []).filter((h: any) => h.kind !== 'pending_payment_expired');
  if (healed.length || (heal.json.alerts ?? []).length) report.problems.push(`self-heal found inconsistencies: ${JSON.stringify({ healed, alerts: heal.json.alerts })}`);
  const ops = await http('GET', '/platform/ops?level=error&limit=50', undefined, { admin: true });
  const errorEvents = (ops.json as any[]).filter((e) => e.kind !== 'alert.negative_stock' && String(e.kind).startsWith('http.500'));
  if (errorEvents.length) report.problems.push(`${errorEvents.length} server 500 events: ${JSON.stringify(errorEvents.slice(0, 3).map((e) => e.message))}`);
  const metrics = (await http('GET', '/platform/metrics', undefined, { admin: true })).json;

  const lat = [...stats.latencies].sort((a, b) => a - b);
  const q = (p: number) => Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length * p))]);
  const fives = [...stats.byStatus.entries()].filter(([k]) => / 5\d\d$/.test(k));
  console.log(JSON.stringify({
    calls: stats.calls, latencyMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: Math.round(lat[lat.length - 1]) },
    raceLosses: report.raceLosses, serverErrors: fives, serverMetrics: { total: metrics.total, errors5xx: metrics.errors5xx, slowest: metrics.slowest?.slice(0, 3) },
    unexpectedResponses: stats.unexpected.length,
  }, null, 2));
  if (stats.unexpected.length) console.log('[sim] unexpected responses (first 20):\n  ' + stats.unexpected.slice(0, 20).join('\n  '));
  if (report.problems.length) console.log('[sim] PROBLEMS:\n  ' + report.problems.join('\n  '));
  const bad = report.problems.length + stats.unexpected.length + fives.length;
  console.log(bad === 0 ? '[sim] PASS: no errors, books reconcile, no leaks' : `[sim] FAIL: ${bad} issue(s)`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => { console.error('[sim] fatal:', e); process.exit(2); });
