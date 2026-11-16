import type { Db } from '../db.ts';
import { audit, DomainError } from '../db.ts';
import type { Actor } from '../auth.ts';
import { require_, whoOf } from '../auth.ts';

/** Must match the presets in public/guest/themes.js. */
export const THEME_PRESETS = ['night', 'midnight', 'noir', 'daylight', 'blush'] as const;
export const THEME_LAYOUTS = ['list', 'grid'] as const;
export const IMAGE_KINDS = ['logo', 'cover'] as const;
type ImageKind = (typeof IMAGE_KINDS)[number];

const MAX_HEADLINE = 60;
const MAX_TAGLINE = 140;
/** Decoded bytes; the browser shrinks photos before upload, so this only stops abuse. */
const MAX_IMAGE_BYTES = 180 * 1024;
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

export interface GuestTheme {
  preset: string; accent: string; headline: string; tagline: string; layout: string;
  logo: string | null; cover: string | null;
}

const DEFAULT_THEME = { preset: 'night', accent: '', headline: '', tagline: '', layout: 'list' };

/** Theme for the customer app; images come back as versioned URLs so browsers can cache them. */
export async function themeOf(db: Db, tenantId: number, companyCode: string): Promise<GuestTheme> {
  const r = await db.one('SELECT preset, accent, headline, tagline, layout FROM guest_theme WHERE tenant_id = ?', [tenantId]);
  const images = await db.all('SELECT kind, updated_at FROM tenant_images WHERE tenant_id = ?', [tenantId]);
  const url = (kind: ImageKind) => {
    const img = images.find((i) => i.kind === kind);
    return img ? `/api/guest/images/${encodeURIComponent(companyCode)}/${kind}?v=${img.updated_at}` : null;
  };
  return { ...DEFAULT_THEME, ...(r ?? {}), logo: url('logo'), cover: url('cover') };
}

const oneOf = <T extends string>(v: unknown, list: readonly T[], name: string, fallback: T): T => {
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) throw new DomainError(`${name} must be one of ${list.join(', ')}`, 422);
  return v as T;
};
const textOf = (v: unknown, name: string, max: number, fallback: string): string => {
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || v.trim().length > max) throw new DomainError(`${name}: up to ${max} characters`, 422);
  return v.trim();
};

export async function updateTheme(db: Db, actor: Actor, b: Record<string, unknown>): Promise<GuestTheme> {
  require_(actor, 'admin.write');
  const cur = await db.one('SELECT preset, accent, headline, tagline, layout FROM guest_theme WHERE tenant_id = ?', [actor.tenantId]) ?? DEFAULT_THEME;
  const accent = textOf(b.accent, 'accent', 7, cur.accent);
  if (accent && !HEX_COLOUR.test(accent)) throw new DomainError('accent must be a colour like #f7d774', 422);
  const next = {
    preset: oneOf(b.preset, THEME_PRESETS, 'preset', cur.preset),
    accent: accent.toLowerCase(),
    headline: textOf(b.headline, 'headline', MAX_HEADLINE, cur.headline),
    tagline: textOf(b.tagline, 'tagline', MAX_TAGLINE, cur.tagline),
    layout: oneOf(b.layout, THEME_LAYOUTS, 'layout', cur.layout),
  };
  await db.run(
    `INSERT INTO guest_theme (tenant_id, preset, accent, headline, tagline, layout, updated_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT (tenant_id) DO UPDATE SET preset = EXCLUDED.preset, accent = EXCLUDED.accent, headline = EXCLUDED.headline,
       tagline = EXCLUDED.tagline, layout = EXCLUDED.layout, updated_at = EXCLUDED.updated_at`,
    [actor.tenantId, next.preset, next.accent, next.headline, next.tagline, next.layout, Date.now()]);
  await audit(db, whoOf(actor), 'guest.theme', 'tenant', actor.tenantId, next);
  return staffTheme(db, actor);
}

/** The same theme for the admin screen, which needs the company code for image URLs. */
export async function staffTheme(db: Db, actor: Actor): Promise<GuestTheme> {
  const t = await db.one('SELECT code FROM tenants WHERE id = ?', [actor.tenantId]);
  return themeOf(db, actor.tenantId, t.code);
}

const imageKind = (v: string): ImageKind => {
  if (!(IMAGE_KINDS as readonly string[]).includes(v)) throw new DomainError('image must be logo or cover', 404);
  return v as ImageKind;
};

/** Accepts a data: URL (the browser has already resized it), checks its type and size, and stores it. */
export async function saveImage(db: Db, actor: Actor, rawKind: string, dataUrl: unknown): Promise<GuestTheme> {
  require_(actor, 'admin.write');
  const kind = imageKind(rawKind);
  const m = typeof dataUrl === 'string' ? /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl) : null;
  if (!m || !IMAGE_MIMES.includes(m[1])) throw new DomainError('upload a JPEG, PNG or WebP image', 422);
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) throw new DomainError(`image too large (max ${MAX_IMAGE_BYTES / 1024} KB)`, 413);
  if (!looksLike(m[1], bytes)) throw new DomainError('the file is not a valid image', 422);
  await db.run(
    `INSERT INTO tenant_images (tenant_id, kind, mime, data, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT (tenant_id, kind) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
    [actor.tenantId, kind, m[1], m[2], Date.now()]);
  await audit(db, whoOf(actor), 'guest.image', 'tenant', actor.tenantId, { kind, bytes: bytes.length });
  return staffTheme(db, actor);
}

/** The declared type must match the file's own signature, so nothing else can be served as an image. */
function looksLike(mime: string, b: Buffer): boolean {
  if (mime === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8;
  if (mime === 'image/png') return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
}

export async function removeImage(db: Db, actor: Actor, rawKind: string): Promise<GuestTheme> {
  require_(actor, 'admin.write');
  const kind = imageKind(rawKind);
  await db.run('DELETE FROM tenant_images WHERE tenant_id = ? AND kind = ?', [actor.tenantId, kind]);
  await audit(db, whoOf(actor), 'guest.image_removed', 'tenant', actor.tenantId, { kind });
  return staffTheme(db, actor);
}

export async function imageOf(db: Db, companyCode: string, rawKind: string): Promise<{ mime: string; bytes: Buffer }> {
  const kind = imageKind(rawKind);
  const r = await db.one(
    'SELECT i.mime, i.data FROM tenant_images i JOIN tenants t ON t.id = i.tenant_id WHERE lower(t.code) = lower(?) AND t.active AND i.kind = ?',
    [companyCode, kind]);
  if (!r) throw new DomainError('no image', 404);
  return { mime: r.mime, bytes: Buffer.from(r.data, 'base64') };
}
