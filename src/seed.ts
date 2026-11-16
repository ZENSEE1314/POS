import type { Db } from './db.ts';
import { openDb } from './db.ts';
import { hashPin } from './auth.ts';

/** Demo data for local development only. The PINs below are dev placeholders: never reuse in production. */
export const DEMO_COMPANY = 'doloruu';
export const DEMO_PINS = { host: '1111', waiter: '2222', cashier: '3333', manager: '4444', finance: '5555', owner: '6666', rep: '7777' };

interface StoreSeed { name: string; code: string; poi: string; city: string; address: string }
const STORES: StoreSeed[] = [
  { name: 'Doloruu Flagship', code: 'FLAG', poi: 'poi_flagship', city: 'Shanghai', address: '88 Julu Road, Jing\'an' },
  { name: 'Doloruu Lounge', code: 'LNGE', poi: 'poi_lounge', city: 'Hangzhou', address: '12 Nanshan Road, Xihu' },
];

const PRODUCTS: Array<[string, string, number, number]> = [
  ['Hennessy VSOP 700ml', 'spirits', 128800, 24],
  ['Johnnie Walker Black 750ml', 'spirits', 98800, 30],
  ['Tsingtao Beer (bottle)', 'beer', 2800, 400],
  ['Fruit Platter', 'food', 18800, 100],
  ['Mixer Pack', 'food', 6800, 200],
];

/**
 * Creates one tenant with two stores. Employee ids are assigned per insert order:
 * 1 owner, 2 finance (tenant-wide), then per store: host, waiter, cashier, manager, sales rep.
 */
export async function seed(db: Db): Promise<void> {
  if ((await db.one('SELECT COUNT(*) AS c FROM tenants'))!.c > 0) return;
  await db.tx(async (t) => {
    const tenantId = await t.insert('INSERT INTO tenants (name, code, created_at) VALUES (?,?,?)', ['Doloruu Group', DEMO_COMPANY, Date.now()]);
    await t.run('INSERT INTO employees (tenant_id, store_id, name, role, pin_hash, username) VALUES (?,NULL,?,?,?,?)', [tenantId, 'Owner Fay', 'owner', hashPin(DEMO_PINS.owner), 'owner']);
    await t.run('INSERT INTO employees (tenant_id, store_id, name, role, pin_hash, username) VALUES (?,NULL,?,?,?,?)', [tenantId, 'Finance Ed', 'finance', hashPin(DEMO_PINS.finance), 'finance']);

    for (const s of STORES) {
      const storeId = await t.insert('INSERT INTO stores (tenant_id, name, code, douyin_poi_id, created_at, city, address) VALUES (?,?,?,?,?,?,?)',
        [tenantId, s.name, s.code, s.poi, Date.now(), s.city, s.address]);
      const staff: Array<[string, string, string, string]> = [
        [`Host ${s.code}`, 'host', DEMO_PINS.host, 'host'], [`Waiter ${s.code}`, 'waiter', DEMO_PINS.waiter, 'waiter'],
        [`Cashier ${s.code}`, 'cashier', DEMO_PINS.cashier, 'cashier'], [`Manager ${s.code}`, 'manager', DEMO_PINS.manager, 'manager'],
        [`Sales ${s.code}`, 'host', DEMO_PINS.rep, 'rep'],
      ];
      for (const [name, role, pin, user] of staff) {
        await t.run('INSERT INTO employees (tenant_id, store_id, name, role, pin_hash, username) VALUES (?,?,?,?,?,?)', [tenantId, storeId, name, role, hashPin(pin), `${s.code.toLowerCase()}.${user}`]);
      }
      for (let i = 1; i <= 6; i++) await t.run('INSERT INTO dining_tables (store_id, name, zone, kind, capacity, min_spend, table_fee) VALUES (?,?,?,?,?,?,?)', [storeId, `A${i}`, 'Floor', 'bar', 4, 0, 0]);
      for (let i = 1; i <= 6; i++) await t.run('INSERT INTO dining_tables (store_id, name, zone, kind, capacity, min_spend, table_fee) VALUES (?,?,?,?,?,?,?)', [storeId, `B${i}`, 'Booth', 'booth', 6, 200000, 0]);
      for (let i = 1; i <= 2; i++) await t.run('INSERT INTO dining_tables (store_id, name, zone, kind, capacity, min_spend, table_fee) VALUES (?,?,?,?,?,?,?)', [storeId, `VIP${i}`, 'VIP', 'room', 10, 800000, 20000]);
      for (const [name, cat, price, stock] of PRODUCTS) await t.run('INSERT INTO products (store_id, name, category, price, stock) VALUES (?,?,?,?,?)', [storeId, name, cat, price, stock]);
      await t.run('INSERT INTO commission_rules (store_id, role, category, bps, fixed) VALUES (?,?,?,?,?)', [storeId, 'sales', null, 500, 0]);      // 5% default for the booking rep
      await t.run('INSERT INTO commission_rules (store_id, role, category, bps, fixed) VALUES (?,?,?,?,?)', [storeId, 'sales', 'spirits', 800, 0]); // 8% on spirits
      await t.run('INSERT INTO commission_rules (store_id, role, category, bps, fixed) VALUES (?,?,?,?,?)', [storeId, 'waiter', null, 200, 0]);     // 2% to the ordering waiter
    }
  });
}

if (import.meta.main) {
  const db = await openDb(process.env.DATABASE_URL ?? 'pglite:data/pglite');
  await seed(db);
  console.log('[nightpos] seeded demo tenant (dev PINs, see src/seed.ts)');
  await db.close();
}
