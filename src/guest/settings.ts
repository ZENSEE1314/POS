import type { Db } from '../db.ts';
import { audit, DomainError } from '../db.ts';
import type { Actor } from '../auth.ts';
import { require_, whoOf } from '../auth.ts';

/** Customer app features a company can switch on or off. */
export const FEATURES = ['service', 'song', 'bottle', 'gift', 'loyalty', 'referral', 'spin', 'events', 'games', 'support', 'pets'] as const;
export type Feature = typeof FEATURES[number];
/** Pet care only makes sense at venues with pets, so it starts switched off. */
const OFF_BY_DEFAULT: readonly Feature[] = ['pets'];
const DEFAULT_POINTS_PER_YUAN = 1;
const DEFAULT_REFERRAL_POINTS = 200;
const DEFAULT_SPIN_COST = 100;
const MAX_POINTS_PER_YUAN = 100;
const MAX_POINTS_SETTING = 100_000;

export interface GuestSettings {
  features: Record<Feature, boolean>;
  pointsPerYuan: number;
  referralPoints: number;
  spinCost: number;
  /** Shown in the platform-wide customer app search. */
  listed: boolean;
}

function parseFeatures(json: string | undefined): Record<Feature, boolean> {
  let saved: Record<string, unknown> = {};
  try { saved = json ? JSON.parse(json) : {}; } catch { /* a damaged row falls back to the defaults */ }
  return Object.fromEntries(FEATURES.map((f) => [f, typeof saved[f] === 'boolean' ? saved[f] : !OFF_BY_DEFAULT.includes(f)])) as Record<Feature, boolean>;
}

export async function guestSettings(db: Db, tenantId: number): Promise<GuestSettings> {
  const r = await db.one('SELECT * FROM guest_settings WHERE tenant_id = ?', [tenantId]);
  const tenant = await db.one('SELECT listed FROM tenants WHERE id = ?', [tenantId]);
  return {
    listed: tenant?.listed ?? true,
    features: parseFeatures(r?.features),
    pointsPerYuan: r?.points_per_yuan ?? DEFAULT_POINTS_PER_YUAN,
    referralPoints: r?.referral_points ?? DEFAULT_REFERRAL_POINTS,
    spinCost: r?.spin_cost ?? DEFAULT_SPIN_COST,
  };
}

/** Throws 404 when the company has switched the feature off; points-based features also need loyalty on. */
export async function requireFeature(db: Db, tenantId: number, feature: Feature): Promise<GuestSettings> {
  const s = await guestSettings(db, tenantId);
  const needsLoyalty = feature === 'referral' || feature === 'spin';
  if (!s.features[feature] || (needsLoyalty && !s.features.loyalty)) throw new DomainError('this is not available at this venue', 404);
  return s;
}

const setting = (v: unknown, name: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new DomainError(`${name} must be a whole number from ${min} to ${max}`, 422);
  return v;
};

export async function updateGuestSettings(db: Db, actor: Actor, b: Record<string, unknown>): Promise<GuestSettings> {
  require_(actor, 'admin.write');
  const cur = await guestSettings(db, actor.tenantId);
  const incoming = (b.features ?? {}) as Record<string, unknown>;
  if (typeof incoming !== 'object' || Array.isArray(incoming)) throw new DomainError('features must be an object', 422);
  const features = { ...cur.features };
  for (const [k, v] of Object.entries(incoming)) {
    if (!FEATURES.includes(k as Feature) || typeof v !== 'boolean') throw new DomainError(`unknown feature or value: ${k}`, 422);
    features[k as Feature] = v;
  }
  if (b.listed !== undefined && typeof b.listed !== 'boolean') throw new DomainError('listed must be true or false', 422);
  const next: GuestSettings = {
    features,
    listed: b.listed === undefined ? cur.listed : (b.listed as boolean),
    pointsPerYuan: b.pointsPerYuan === undefined ? cur.pointsPerYuan : setting(b.pointsPerYuan, 'pointsPerYuan', 0, MAX_POINTS_PER_YUAN),
    referralPoints: b.referralPoints === undefined ? cur.referralPoints : setting(b.referralPoints, 'referralPoints', 0, MAX_POINTS_SETTING),
    spinCost: b.spinCost === undefined ? cur.spinCost : setting(b.spinCost, 'spinCost', 1, MAX_POINTS_SETTING),
  };
  await db.run(
    `INSERT INTO guest_settings (tenant_id, features, points_per_yuan, referral_points, spin_cost) VALUES (?,?,?,?,?)
     ON CONFLICT (tenant_id) DO UPDATE SET features = EXCLUDED.features, points_per_yuan = EXCLUDED.points_per_yuan,
       referral_points = EXCLUDED.referral_points, spin_cost = EXCLUDED.spin_cost`,
    [actor.tenantId, JSON.stringify(next.features), next.pointsPerYuan, next.referralPoints, next.spinCost]);
  await db.run('UPDATE tenants SET listed = ? WHERE id = ?', [next.listed, actor.tenantId]);
  await audit(db, whoOf(actor), 'guest.settings', 'tenant', actor.tenantId, next);
  return next;
}
