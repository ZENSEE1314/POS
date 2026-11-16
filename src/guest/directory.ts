import type { Db } from '../db.ts';
import { DomainError } from '../db.ts';

const MAX_RESULTS = 50;
const MAX_QUERY = 60;
const MAX_CITIES = 30;

export interface DirectoryStore { name: string; code: string; city: string; address: string }
export interface DirectoryEntry { company: { name: string; code: string; business: string; logo: string | null }; stores: DirectoryStore[] }

const LOGO_VERSION = "(SELECT i.updated_at FROM tenant_images i WHERE i.tenant_id = t.id AND i.kind = 'logo') AS logo_v";

/** "50%_off" must match those characters literally, not as LIKE wildcards. */
const likePattern = (q: string) => `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function groupByCompany(rows: any[]): DirectoryEntry[] {
  const out = new Map<string, DirectoryEntry>();
  for (const r of rows) {
    let e = out.get(r.company_code);
    if (!e) {
      const logo = r.logo_v ? `/api/guest/images/${encodeURIComponent(r.company_code)}/logo?v=${r.logo_v}` : null;
      e = { company: { name: r.company_name, code: r.company_code, business: r.business_type, logo }, stores: [] };
      out.set(r.company_code, e);
    }
    e.stores.push({ name: r.store_name, code: r.store_code, city: r.city, address: r.address });
  }
  return [...out.values()];
}

const DIRECTORY_SQL = `SELECT t.name AS company_name, t.code AS company_code, t.business_type, s.name AS store_name, s.code AS store_code, s.city, s.address,
    ${LOGO_VERSION}
  FROM tenants t JOIN stores s ON s.tenant_id = t.id WHERE t.active AND t.listed AND s.active`;

/**
 * Platform-wide search for the customer app: every active, listed business, matched on its name, code, location
 * names, city or address. Only public details leave here; a business sees nothing of another.
 */
export async function searchDirectory(db: Db, rawQuery: unknown, rawCity: unknown): Promise<{ results: DirectoryEntry[]; cities: string[] }> {
  const q = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  const city = typeof rawCity === 'string' ? rawCity.trim() : '';
  if (q.length > MAX_QUERY || city.length > MAX_QUERY) throw new DomainError(`search: up to ${MAX_QUERY} characters`, 422);
  const where: string[] = [];
  const args: unknown[] = [];
  if (q) {
    // A company matches when any of its locations or its own name does; all its locations are then shown.
    where.push(`t.id IN (SELECT t2.id FROM tenants t2 JOIN stores s2 ON s2.tenant_id = t2.id
      WHERE s2.active AND (lower(t2.name) LIKE ? ESCAPE '\\' OR lower(t2.code) LIKE ? ESCAPE '\\' OR lower(s2.name) LIKE ? ESCAPE '\\'
        OR lower(s2.city) LIKE ? ESCAPE '\\' OR lower(s2.address) LIKE ? ESCAPE '\\'))`);
    const p = likePattern(q);
    args.push(p, p, p, p, p);
  }
  if (city) {
    where.push('lower(s.city) = lower(?)');
    args.push(city);
  }
  const rows = await db.all(`${DIRECTORY_SQL}${where.map((w) => ` AND ${w}`).join('')} ORDER BY t.name, s.id`, args);
  const cities = await db.all(
    `SELECT DISTINCT s.city FROM tenants t JOIN stores s ON s.tenant_id = t.id WHERE t.active AND t.listed AND s.active AND s.city <> '' ORDER BY s.city LIMIT ?`,
    [MAX_CITIES]);
  return { results: groupByCompany(rows).slice(0, MAX_RESULTS), cities: cities.map((c) => c.city) };
}

/**
 * The businesses this guest has dealt with (orders, bookings, points), newest first, so one account shows every place
 * they use. Unlisted businesses still appear here: the guest already knows them.
 */
export async function myPlaces(db: Db, customerId: number): Promise<DirectoryEntry[]> {
  const rows = await db.all(
    `SELECT t.name AS company_name, t.code AS company_code, t.business_type, s.name AS store_name, s.code AS store_code, s.city, s.address,
       ${LOGO_VERSION}
     FROM tenants t JOIN stores s ON s.tenant_id = t.id
     JOIN (SELECT tenant_id, MAX(ts) AS last FROM (
             SELECT st.tenant_id, o.created_at AS ts FROM guest_orders o JOIN stores st ON st.id = o.store_id WHERE o.customer_id = ?
             UNION ALL SELECT st.tenant_id, b.created_at FROM bookings b JOIN stores st ON st.id = b.store_id WHERE b.customer_id = ?
             UNION ALL SELECT p.tenant_id, 0 FROM customer_points p WHERE p.customer_id = ?) x GROUP BY tenant_id) used ON used.tenant_id = t.id
     WHERE t.active AND s.active ORDER BY used.last DESC, t.id, s.id`, [customerId, customerId, customerId]);
  return groupByCompany(rows).slice(0, MAX_RESULTS);
}
