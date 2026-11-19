// Reseller programme (渠道合作): the platform operator signs up partners who sell NightPOS in their city. Each partner
// gets a code; a company that signs up with it (or with /site?ref=CODE) is credited to that partner, and the
// operator sees each partner's companies and their commission rate for paying out.
import { randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import { DomainError } from './db.ts';

const CODE_PATTERN = /^[A-Z0-9]{4,12}$/;
const CODE_BYTES = 4;
const MAX_FIELD = 80;
const text = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, MAX_FIELD) : '');
const newCode = () => randomBytes(CODE_BYTES).toString('hex').toUpperCase();

export async function listResellers(db: Db) {
  const rows = await db.all(`SELECT r.*,
      (SELECT COUNT(*) FROM tenants t WHERE t.reseller_id = r.id) AS companies,
      (SELECT COUNT(*) FROM tenants t WHERE t.reseller_id = r.id AND t.active) AS active_companies
    FROM resellers r ORDER BY r.created_at DESC`);
  return rows.map((r) => ({
    id: Number(r.id), name: r.name, phone: r.phone, city: r.city, code: r.code, commissionBps: Number(r.commission_bps),
    active: Boolean(r.active), createdAt: Number(r.created_at), companies: Number(r.companies), activeCompanies: Number(r.active_companies),
  }));
}

export async function saveReseller(db: Db, id: number | null, b: Record<string, unknown>): Promise<{ id: number; code: string }> {
  const name = text(b.name);
  if (!name) throw new DomainError('name is required', 422);
  const bps = Math.trunc(Number(b.commissionBps ?? 0));
  if (!(bps >= 0 && bps <= 10_000)) throw new DomainError('commissionBps must be 0 to 10000', 422);
  const code = b.code === undefined || b.code === '' ? null : text(b.code).toUpperCase();
  if (code !== null && !CODE_PATTERN.test(code)) throw new DomainError('code: 4-12 letters or digits', 422);
  const values = [name, text(b.phone), text(b.city), bps, b.active !== false];
  try {
    if (id === null) {
      const finalCode = code ?? newCode();
      const newId = await db.insert('INSERT INTO resellers (name, phone, city, commission_bps, active, code, created_at) VALUES (?,?,?,?,?,?,?)',
        [...values, finalCode, Date.now()]);
      return { id: newId, code: finalCode };
    }
    const row = await db.one('UPDATE resellers SET name = ?, phone = ?, city = ?, commission_bps = ?, active = ?, code = COALESCE(?, code) WHERE id = ? RETURNING code',
      [...values, code, id]);
    if (!row) throw new DomainError('reseller not found', 404);
    return { id, code: row.code };
  } catch (e: any) {
    if (e?.code === '23505') throw new DomainError('that code is already used by another reseller', 409);
    throw e;
  }
}

/** The companies one reseller brought in, for the payout statement. */
export async function resellerCompanies(db: Db, id: number) {
  if (!(await db.one('SELECT 1 AS x FROM resellers WHERE id = ?', [id]))) throw new DomainError('reseller not found', 404);
  const rows = await db.all(`SELECT code, name, active, business_type, created_at, (SELECT COUNT(*) FROM stores s WHERE s.tenant_id = t.id) AS stores
    FROM tenants t WHERE reseller_id = ? ORDER BY created_at DESC`, [id]);
  return rows.map((r) => ({ code: r.code, name: r.name, active: Boolean(r.active), businessType: r.business_type, createdAt: Number(r.created_at), stores: Number(r.stores) }));
}

/** Sign-up: a partner code links the new company to that reseller. An unknown code is refused so the typo is noticed. */
export async function resellerIdForCode(db: Db, code: unknown): Promise<number | null> {
  const c = text(code).toUpperCase();
  if (!c) return null;
  const r = await db.one('SELECT id FROM resellers WHERE code = ? AND active', [c]);
  if (!r) throw new DomainError('partner code not found', 422);
  return Number(r.id);
}
