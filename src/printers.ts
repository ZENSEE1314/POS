import type { Db } from './db.ts';
import { audit, DomainError } from './db.ts';
import type { Actor } from './auth.ts';
import { require_, whoOf } from './auth.ts';

export const PRINTER_KINDS = ['receipt', 'bar', 'kitchen', 'label'];
export const PRINTER_LANGS = ['both', 'zh', 'en'];
export const PAPER_WIDTHS = [58, 80];
export const PRODUCT_STATIONS = ['', 'bar', 'kitchen'];

const MAX_PRINTERS_PER_STORE = 20;
const MAX_COPIES = 5;
const MAX_NAME_LENGTH = 60;
/** The name the local bridge knows the printer by, never an address: letters, digits, space, dot, dash, underscore. */
const BRIDGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

const COLUMNS = `id, name, kind, bridge_name AS "bridgeName", paper_mm AS "paperMm", copies, enabled, lang`;

function validName(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new DomainError('name is required', 422);
  if (s.length > MAX_NAME_LENGTH) throw new DomainError(`name is too long (max ${MAX_NAME_LENGTH})`, 422);
  return s;
}

function oneOf<T>(v: unknown, allowed: T[], name: string): T {
  if (!allowed.includes(v as T)) throw new DomainError(`${name} must be one of ${allowed.join(', ')}`, 422);
  return v as T;
}

function validBridgeName(v: unknown): string {
  if (typeof v !== 'string' || !BRIDGE_NAME_PATTERN.test(v.trim())) {
    throw new DomainError('bridgeName must be the printer name from the bridge config (letters, digits, space . _ -, up to 64)', 422);
  }
  return v.trim();
}

function validCopies(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_COPIES) throw new DomainError(`copies must be an integer from 1 to ${MAX_COPIES}`, 422);
  return v;
}

function validEnabled(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new DomainError('enabled must be true or false', 422);
  return v;
}

/** Any signed-in staff may read: tickets and receipts print from whichever tablet the staff member is holding. */
export function listPrinters(db: Db, actor: Actor) {
  return db.all(`SELECT ${COLUMNS} FROM printers WHERE store_id = ? ORDER BY id`, [actor.storeId]);
}

export async function createPrinter(db: Db, actor: Actor, b: any): Promise<number> {
  require_(actor, 'admin.write');
  const name = validName(b.name);
  const kind = oneOf(b.kind, PRINTER_KINDS, 'kind');
  const bridgeName = validBridgeName(b.bridgeName);
  const paperMm = oneOf(b.paperMm ?? 80, PAPER_WIDTHS, 'paperMm');
  const copies = validCopies(b.copies ?? 1);
  const enabled = validEnabled(b.enabled ?? true);
  const lang = oneOf(b.lang ?? 'both', PRINTER_LANGS, 'lang');
  return db.tx(async (t) => {
    if ((await t.one('SELECT COUNT(*) AS n FROM printers WHERE store_id = ?', [actor.storeId]))!.n >= MAX_PRINTERS_PER_STORE) {
      throw new DomainError(`a store can have at most ${MAX_PRINTERS_PER_STORE} printers`, 409);
    }
    if (await t.one('SELECT 1 AS x FROM printers WHERE store_id = ? AND lower(name) = lower(?)', [actor.storeId, name])) throw new DomainError('printer name already used', 409);
    const id = await t.insert(
      'INSERT INTO printers (store_id, name, kind, bridge_name, paper_mm, copies, enabled, lang, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [actor.storeId, name, kind, bridgeName, paperMm, copies, enabled, lang, Date.now()]);
    await audit(t, whoOf(actor), 'printer.create', 'printer', id, { name, kind, bridgeName, paperMm, copies, enabled, lang });
    return id;
  });
}

export async function updatePrinter(db: Db, actor: Actor, id: number, b: any): Promise<void> {
  require_(actor, 'admin.write');
  await db.tx(async (t) => {
    const p = await t.one(`SELECT ${COLUMNS} FROM printers WHERE id = ? AND store_id = ? FOR UPDATE`, [id, actor.storeId]);
    if (!p) throw new DomainError('printer not found', 404);
    const next = {
      name: b.name !== undefined ? validName(b.name) : p.name,
      kind: b.kind !== undefined ? oneOf(b.kind, PRINTER_KINDS, 'kind') : p.kind,
      bridgeName: b.bridgeName !== undefined ? validBridgeName(b.bridgeName) : p.bridgeName,
      paperMm: b.paperMm !== undefined ? oneOf(b.paperMm, PAPER_WIDTHS, 'paperMm') : p.paperMm,
      copies: b.copies !== undefined ? validCopies(b.copies) : p.copies,
      enabled: b.enabled !== undefined ? validEnabled(b.enabled) : p.enabled,
      lang: b.lang !== undefined ? oneOf(b.lang, PRINTER_LANGS, 'lang') : p.lang,
    };
    if (next.name.toLowerCase() !== p.name.toLowerCase()
      && await t.one('SELECT 1 AS x FROM printers WHERE store_id = ? AND lower(name) = lower(?) AND id <> ?', [actor.storeId, next.name, id])) {
      throw new DomainError('printer name already used', 409);
    }
    await t.run('UPDATE printers SET name = ?, kind = ?, bridge_name = ?, paper_mm = ?, copies = ?, enabled = ?, lang = ? WHERE id = ?',
      [next.name, next.kind, next.bridgeName, next.paperMm, next.copies, next.enabled, next.lang, id]);
    await audit(t, whoOf(actor), 'printer.update', 'printer', id, next);
  });
}

export async function deletePrinter(db: Db, actor: Actor, id: number): Promise<void> {
  require_(actor, 'admin.write');
  const n = await db.run('DELETE FROM printers WHERE id = ? AND store_id = ?', [id, actor.storeId]);
  if (!n) throw new DomainError('printer not found', 404);
  await audit(db, whoOf(actor), 'printer.delete', 'printer', id, {});
}

/** Shared by product create/update: '' means the product prints on no station ticket. */
export function validStation(v: unknown): string {
  return oneOf(v, PRODUCT_STATIONS, 'station');
}
