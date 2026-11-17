import type { Db } from './db.ts';
import { audit, DomainError } from './db.ts';
import { hashPin } from './auth.ts';
import { applyGuestPreset, BUSINESS_TYPES, isBusinessType, MODULE_PRESETS } from './business.ts';
import type { BusinessType } from './business.ts';
import { placeOf } from './hq.ts';

const CODE_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}$/i;
const USERNAME_PATTERN = /^[a-z0-9._-]{2,32}$/i;
const MIN_PIN_LENGTH = 6;
const MAX_OPS_LIMIT = 1000;

export interface NewCompany {
  name: string;
  code: string;
  storeName: string;
  ownerName: string;
  ownerUsername: string;
  ownerPin: string;
  douyinPoiId?: string;
  businessType?: BusinessType;
  city?: string;
  address?: string;
  postalCode?: string;
}

/**
 * SaaS onboarding: one tenant, its first store, an owner, and sensible default commission rules. Self sign-up passes
 * `requireAddress` so every new business has a full address the customer app can show; the platform admin may leave it out.
 */
export async function createCompany(db: Db, input: NewCompany, { requireAddress = false } = {}): Promise<{ tenantId: number; storeId: number; ownerId: number }> {
  const required = [input.name, input.code, input.storeName, input.ownerName, input.ownerUsername, input.ownerPin];
  if (!required.every((v) => typeof v === 'string')) throw new DomainError('name, code, storeName, ownerName, ownerUsername and ownerPin must all be text', 422);
  if (!input.name?.trim() || !input.storeName?.trim() || !input.ownerName?.trim()) throw new DomainError('name, storeName and ownerName are required', 422);
  if (!CODE_PATTERN.test(input.code ?? '')) throw new DomainError('company code: 2-31 letters, digits or hyphens', 422);
  if (!USERNAME_PATTERN.test(input.ownerUsername ?? '')) throw new DomainError('username: 2-32 letters, digits, . _ -', 422);
  if (!input.ownerPin || input.ownerPin.length < MIN_PIN_LENGTH) throw new DomainError(`owner PIN needs at least ${MIN_PIN_LENGTH} characters`, 422);
  const type = input.businessType ?? 'bar';
  if (!isBusinessType(type)) throw new DomainError(`businessType must be one of ${BUSINESS_TYPES.join(', ')}`, 422);
  const place = placeOf(input, requireAddress);
  return db.tx(async (t) => {
    if (await t.one('SELECT 1 AS x FROM tenants WHERE lower(code) = lower(?)', [input.code])) throw new DomainError('company code already taken', 409);
    const tenantId = await t.insert('INSERT INTO tenants (name, code, created_at, business_type) VALUES (?,?,?,?)', [input.name.trim(), input.code, Date.now(), type]);
    await applyGuestPreset(t, tenantId, type);
    const storeId = await t.insert('INSERT INTO stores (tenant_id, name, code, douyin_poi_id, created_at, city, address, postal_code) VALUES (?,?,?,?,?,?,?,?)',
      [tenantId, input.storeName.trim(), 'MAIN', input.douyinPoiId ?? null, Date.now(), place.city, place.address, place.postalCode]);
    const ownerId = await t.insert('INSERT INTO employees (tenant_id, store_id, name, role, pin_hash, username) VALUES (?,NULL,?,?,?,?)',
      [tenantId, input.ownerName.trim(), 'owner', hashPin(input.ownerPin), input.ownerUsername]);
    if (MODULE_PRESETS[type].reps) {
      await t.run('INSERT INTO commission_rules (store_id, role, category, bps, fixed) VALUES (?,?,?,?,?)', [storeId, 'sales', null, 500, 0]);
      await t.run('INSERT INTO commission_rules (store_id, role, category, bps, fixed) VALUES (?,?,?,?,?)', [storeId, 'waiter', null, 200, 0]);
    }
    await audit(t, { tenantId, storeId, actorId: ownerId }, 'company.create', 'tenant', tenantId, { code: input.code, name: input.name, businessType: type });
    return { tenantId, storeId, ownerId };
  });
}

export function listCompanies(db: Db) {
  return db.all(
    `SELECT t.id, t.code, t.name, t.active, t.business_type AS "businessType", t.created_at AS "createdAt",
       (SELECT COUNT(*) FROM stores s WHERE s.tenant_id = t.id) AS stores,
       (SELECT COUNT(*) FROM employees e WHERE e.tenant_id = t.id) AS staff,
       (SELECT COUNT(*) FROM bills b JOIN stores s ON s.id = b.store_id WHERE s.tenant_id = t.id AND b.status = 'settled') AS bills
     FROM tenants t ORDER BY t.id`);
}

export async function recentOps(db: Db, limit = 200, level?: string) {
  if (limit < 1) throw new DomainError('limit must be at least 1', 422);
  return db.all(
    `SELECT id, ts, level, kind, message, detail, tenant_id AS "tenantId", store_id AS "storeId" FROM ops_events
     WHERE (?::text IS NULL OR level = ?) ORDER BY id DESC LIMIT ?`, [level ?? null, level ?? null, Math.min(Math.max(limit, 1), MAX_OPS_LIMIT)]);
}

/** Suspends (or restores) a company: its staff can no longer log in and live sessions stop working. Data is kept. */
export async function setCompanyActive(db: Db, code: string, active: boolean): Promise<void> {
  const n = await db.run("UPDATE tenants SET active = ? WHERE lower(code) = lower(?)", [active, code]);
  if (!n) throw new DomainError("company not found", 404);
  if (!active) await db.run("DELETE FROM sessions WHERE employee_id IN (SELECT e.id FROM employees e JOIN tenants t ON t.id = e.tenant_id WHERE lower(t.code) = lower(?))", [code]);
}
