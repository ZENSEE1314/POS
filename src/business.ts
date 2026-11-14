import type { Db } from './db.ts';
import { audit, DomainError } from './db.ts';
import type { Actor } from './auth.ts';
import { require_, whoOf } from './auth.ts';
import { FEATURES } from './guest/settings.ts';
import type { Feature } from './guest/settings.ts';

/** What kind of business a company runs. It only picks the starting set of modules; every module can still be switched. */
export const BUSINESS_TYPES = ['bar', 'restaurant', 'cafe', 'retail', 'pet', 'salon', 'other'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

/**
 * Staff-side modules:
 *  tables      floor plan with tables / rooms           minSpend   minimum spend and table fees
 *  reps        sales reps and commission                stash      stored bottles
 *  bookings    reservations / appointments              kitchen    bar and kitchen tickets
 *  counter     quick counter sales without a table      barcode    barcode scanning, weighed items, scale labels
 *  purchasing  suppliers, purchase orders, low stock    promotions sale prices and member prices
 *  guestApp    customer app (QR, account, extras)       delivery   customer pickup and delivery orders
 */
export const MODULES = ['tables', 'minSpend', 'reps', 'stash', 'bookings', 'kitchen', 'counter', 'barcode', 'purchasing', 'promotions', 'guestApp', 'delivery'] as const;
export type Module = (typeof MODULES)[number];
export type Modules = Record<Module, boolean>;

/** How a scale's EAN-13 label (starting with 2) carries its 5-digit value: the price in fen or the weight in grams. */
export const SCALE_MODES = ['price', 'weight'] as const;
export type ScaleMode = (typeof SCALE_MODES)[number];

const on = (...list: Module[]): Modules => Object.fromEntries(MODULES.map((m) => [m, list.includes(m)])) as Modules;

export const MODULE_PRESETS: Record<BusinessType, Modules> = {
  bar: on('tables', 'minSpend', 'reps', 'stash', 'bookings', 'kitchen', 'promotions', 'guestApp'),
  restaurant: on('tables', 'bookings', 'kitchen', 'counter', 'purchasing', 'promotions', 'guestApp', 'delivery'),
  cafe: on('tables', 'kitchen', 'counter', 'promotions', 'guestApp', 'delivery'),
  retail: on('counter', 'barcode', 'purchasing', 'promotions', 'guestApp', 'delivery'),
  pet: on('tables', 'bookings', 'counter', 'barcode', 'purchasing', 'promotions', 'guestApp', 'delivery'),
  salon: on('reps', 'bookings', 'counter', 'promotions', 'guestApp'),
  other: on('tables', 'counter', 'promotions', 'guestApp'),
};

/** Customer app features (see guest/settings.ts) that suit each kind of business. */
export const GUEST_FEATURE_PRESETS: Record<BusinessType, Feature[]> = {
  bar: ['service', 'song', 'bottle', 'gift', 'loyalty', 'referral', 'spin', 'events', 'games', 'support'],
  restaurant: ['service', 'gift', 'loyalty', 'referral', 'spin', 'events', 'support'],
  cafe: ['service', 'loyalty', 'referral', 'spin', 'events', 'games', 'support'],
  retail: ['loyalty', 'referral', 'spin', 'events', 'support'],
  pet: ['service', 'loyalty', 'referral', 'spin', 'events', 'support', 'pets'],
  salon: ['loyalty', 'referral', 'spin', 'events', 'support'],
  other: ['service', 'loyalty', 'referral', 'events', 'support'],
};

export interface Business { type: BusinessType; modules: Modules; scaleMode: ScaleMode }

export const isBusinessType = (v: unknown): v is BusinessType => typeof v === 'string' && (BUSINESS_TYPES as readonly string[]).includes(v);

function parseModules(type: BusinessType, raw: string | null): Modules {
  let saved: Record<string, unknown> = {};
  try { saved = JSON.parse(raw || '{}'); } catch { /* corrupt settings fall back to the preset */ }
  const preset = MODULE_PRESETS[type];
  return Object.fromEntries(MODULES.map((m) => [m, typeof saved[m] === 'boolean' ? saved[m] : preset[m]])) as Modules;
}

export async function businessOf(db: Db, tenantId: number): Promise<Business> {
  const r = await db.one('SELECT business_type, modules, scale_mode FROM tenants WHERE id = ?', [tenantId]);
  if (!r) throw new DomainError('company not found', 404);
  const type = isBusinessType(r.business_type) ? r.business_type : 'bar';
  return { type, modules: parseModules(type, r.modules), scaleMode: r.scale_mode === 'weight' ? 'weight' : 'price' };
}

export async function hasModule(db: Db, tenantId: number, module: Module): Promise<boolean> {
  return (await businessOf(db, tenantId)).modules[module];
}

/** Switched-off modules answer 404 so a till that was set up for another kind of business cannot reach them by accident. */
export async function requireModule(db: Db, tenantId: number, module: Module): Promise<void> {
  if (!(await hasModule(db, tenantId, module))) throw new DomainError(`the ${module} module is switched off for this company`, 404);
}

/**
 * Owner changes the business type and/or modules. A new type resets modules (and, when asked, customer app features)
 * to that type's preset; explicit module switches in the same call are applied on top.
 */
export async function updateBusiness(db: Db, actor: Actor, b: any): Promise<Business> {
  require_(actor, 'hq.write');
  if (b.type !== undefined && !isBusinessType(b.type)) throw new DomainError(`type must be one of ${BUSINESS_TYPES.join(', ')}`, 422);
  if (b.scaleMode !== undefined && !(SCALE_MODES as readonly string[]).includes(b.scaleMode)) throw new DomainError('scaleMode must be price or weight', 422);
  if (b.modules !== undefined && (b.modules === null || typeof b.modules !== 'object' || Array.isArray(b.modules))) throw new DomainError('modules must be an object', 422);
  for (const [k, v] of Object.entries(b.modules ?? {})) {
    if (!(MODULES as readonly string[]).includes(k)) throw new DomainError(`unknown module ${k}`, 422);
    if (typeof v !== 'boolean') throw new DomainError(`module ${k} must be true or false`, 422);
  }
  return db.tx(async (t) => {
    const now = await businessOf(t, actor.tenantId);
    const type: BusinessType = b.type ?? now.type;
    const base = b.type !== undefined && b.type !== now.type ? MODULE_PRESETS[type] : now.modules;
    const modules = { ...base, ...(b.modules ?? {}) } as Modules;
    const scaleMode: ScaleMode = b.scaleMode ?? now.scaleMode;
    await t.run('UPDATE tenants SET business_type = ?, modules = ?, scale_mode = ? WHERE id = ?', [type, JSON.stringify(modules), scaleMode, actor.tenantId]);
    if (b.applyGuestPreset === true) await applyGuestPreset(t, actor.tenantId, type);
    await audit(t, whoOf(actor), 'business.update', 'tenant', actor.tenantId, { type, modules, scaleMode, applyGuestPreset: b.applyGuestPreset === true });
    return { type, modules, scaleMode };
  });
}

/** Writes the customer app feature switches that suit a business type (used at sign-up and when the owner asks for it). */
export async function applyGuestPreset(db: Db, tenantId: number, type: BusinessType): Promise<void> {
  const wanted = GUEST_FEATURE_PRESETS[type];
  const features = JSON.stringify(Object.fromEntries(FEATURES.map((f) => [f, wanted.includes(f)])));
  await db.run('INSERT INTO guest_settings (tenant_id, features) VALUES (?,?) ON CONFLICT (tenant_id) DO UPDATE SET features = EXCLUDED.features', [tenantId, features]);
}
