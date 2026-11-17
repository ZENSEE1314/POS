// Leads from the public sales website (/site): bars asking for a demo or a quote, would-be resellers, and referrals.
// They land here for the platform operator (GET /platform/leads) instead of an email nobody reads.
import type { Db } from './db.ts';
import { DomainError } from './db.ts';
import { cleanPhone } from './phone.ts';

export const LEAD_KINDS = ['demo', 'quote', 'partner', 'referral'] as const;
export const LEAD_STATUSES = ['new', 'contacted', 'won', 'lost'] as const;
const MAX_TEXT = 500;
const MAX_FIELD = 80;
const VENUE_TYPES = ['bar', 'club', 'livehouse', 'ktv', 'restaurant', 'other'] as const;

type LeadKind = typeof LEAD_KINDS[number];

const text = (v: unknown, max = MAX_FIELD): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export async function createLead(db: Db, b: Record<string, unknown>, ip: string): Promise<number> {
  const kind = text(b.kind) as LeadKind;
  if (!LEAD_KINDS.includes(kind)) throw new DomainError('kind must be demo, quote, partner or referral', 422);
  const name = text(b.name);
  if (!name) throw new DomainError('please enter your name', 422);
  const phone = cleanPhone(text(b.phone));
  const venueType = text(b.venueType);
  const row = await db.one(`INSERT INTO site_leads (kind, name, phone, wechat, company, city, venue_type, stores, referrer, message, ip, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'new',?) RETURNING id`, [
    kind, name, phone, text(b.wechat), text(b.company), text(b.city),
    (VENUE_TYPES as readonly string[]).includes(venueType) ? venueType : '',
    Math.max(0, Math.min(999, Number.parseInt(String(b.stores ?? 0), 10) || 0)),
    text(b.referrer), text(b.message, MAX_TEXT), ip.slice(0, 64), Date.now(),
  ]);
  return Number(row.id);
}

export async function listLeads(db: Db, status?: string) {
  const rows = status
    ? await db.all('SELECT * FROM site_leads WHERE status = ? ORDER BY created_at DESC LIMIT 500', [status])
    : await db.all('SELECT * FROM site_leads ORDER BY created_at DESC LIMIT 500');
  return rows.map((r) => ({
    id: Number(r.id), kind: r.kind, name: r.name, phone: r.phone, wechat: r.wechat, company: r.company, city: r.city,
    venueType: r.venue_type, stores: Number(r.stores), referrer: r.referrer, message: r.message, status: r.status,
    note: r.note, createdAt: Number(r.created_at),
  }));
}

export async function updateLead(db: Db, id: number, b: Record<string, unknown>): Promise<void> {
  const status = text(b.status);
  if (!(LEAD_STATUSES as readonly string[]).includes(status)) throw new DomainError('status must be new, contacted, won or lost', 422);
  const changed = await db.run('UPDATE site_leads SET status = ?, note = ? WHERE id = ?', [status, text(b.note, MAX_TEXT), id]);
  if (!changed) throw new DomainError('lead not found', 404);
}
