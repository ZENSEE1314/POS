// Venue extras matched from 连娱宝: forfeited bottles (酒水充公), the waiting queue (排队叫号), staff training (学院)
// and the singers on stage tonight (驻唱).
import { randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import { audit, DomainError } from './db.ts';
import type { Actor } from './auth.ts';
import { require_, whoOf } from './auth.ts';
import { cleanPhone } from './phone.ts';

const DAY_MS = 86_400_000;
const MAX_NAME = 40;
const MAX_TITLE = 80;
const MAX_BODY = 20_000;
const MAX_PARTY = 99;
/** A day of queue numbers runs from 6am to 6am China time, so a night's numbers do not restart at midnight. */
const QUEUE_DAY_OFFSET_MS = (8 - 6) * 3_600_000;
const SETS_AHEAD_MS = DAY_MS;
const text = (v: unknown, max = MAX_NAME) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ---------- forfeited bottles (酒水充公) ----------

/** Bottles past their keep-until date that nobody collected. */
export async function expiredStash(db: Db, actor: Actor) {
  require_(actor, 'admin.write');
  const rows = await db.all(`SELECT id, phone, name, qty_milli, left_milli, expires_at, code FROM stash
    WHERE store_id = ? AND status IN ('stored','expired') AND expires_at < ? AND left_milli > 0 ORDER BY expires_at`, [actor.storeId, Date.now()]);
  return rows.map((r) => ({
    id: Number(r.id), phone: `${String(r.phone).slice(0, 3)}****${String(r.phone).slice(-4)}`, name: r.name,
    leftMilli: Number(r.left_milli), qtyMilli: Number(r.qty_milli), expiredAt: Number(r.expires_at), code: r.code,
  }));
}

/**
 * The venue takes expired bottles (充公). With `toStock`, bottles still full go back on the shelf as stock;
 * opened bottles are only written off.
 */
export async function forfeitStash(db: Db, actor: Actor, b: Record<string, unknown>): Promise<{ forfeited: number; restocked: number }> {
  require_(actor, 'admin.write');
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!ids.length) throw new DomainError('pick at least one bottle', 422);
  const toStock = b.toStock === true;
  return db.tx(async (t) => {
    let forfeited = 0;
    let restocked = 0;
    for (const id of ids) {
      const s = await t.one(`SELECT * FROM stash WHERE id = ? AND store_id = ? AND status IN ('stored','expired') AND expires_at < ? AND left_milli > 0 FOR UPDATE`,
        [id, actor.storeId, Date.now()]);
      if (!s) throw new DomainError(`bottle ${id} is not an expired bottle in this store`, 409);
      await t.run("UPDATE stash SET status = 'forfeited', forfeited_at = ?, forfeited_by = ? WHERE id = ?", [Date.now(), actor.id, id]);
      forfeited += 1;
      const full = Number(s.left_milli) === Number(s.qty_milli) && Number(s.qty_milli) % 1000 === 0;
      if (toStock && full) {
        restocked += await t.run('UPDATE products SET stock = stock + ? WHERE id = ? AND store_id = ? AND track_stock',
          [Number(s.qty_milli) / 1000, s.product_id, actor.storeId]);
      }
    }
    await audit(t, whoOf(actor), 'stash.forfeit', 'stash', ids[0], { ids, toStock, restocked });
    return { forfeited, restocked };
  });
}

// ---------- waiting queue (排队叫号) ----------

const QUEUE_OPEN = ['waiting', 'called'];
const queueDay = (now = Date.now()) => new Date(now + QUEUE_DAY_OFFSET_MS).toISOString().slice(0, 10);

const ticketView = (r: any) => ({
  id: Number(r.id), number: Number(r.number), code: r.code, partySize: Number(r.party_size), name: r.name,
  phone: r.phone ? `${String(r.phone).slice(0, 3)}****${String(r.phone).slice(-4)}` : '', source: r.source, status: r.status,
  createdAt: Number(r.created_at), calledAt: r.called_at === null ? null : Number(r.called_at),
});

export async function takeQueueNumber(db: Db, storeId: number, b: Record<string, unknown>, source: 'staff' | 'guest') {
  const partySize = Math.trunc(Number(b.partySize ?? 2));
  if (!(partySize >= 1 && partySize <= MAX_PARTY)) throw new DomainError(`party size must be 1 to ${MAX_PARTY}`, 422);
  const phone = b.phone ? cleanPhone(text(b.phone)) : '';
  if (source === 'guest' && !phone) throw new DomainError('please enter your phone number so we can find you', 422);
  const day = queueDay();
  return db.tx(async (t) => {
    // serialise numbering per store; the UNIQUE (store_id, day, number) index is the backstop
    await t.run('SELECT id FROM stores WHERE id = ? FOR UPDATE', [storeId]);
    const last = await t.one('SELECT MAX(number) AS n FROM queue_tickets WHERE store_id = ? AND day = ?', [storeId, day]);
    const number = Number(last?.n ?? 0) + 1;
    const id = await t.insert(`INSERT INTO queue_tickets (store_id, day, number, code, party_size, name, phone, source, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, [storeId, day, number, randomBytes(9).toString('base64url'), partySize, text(b.name), phone, source, Date.now()]);
    return ticketView(await t.one('SELECT * FROM queue_tickets WHERE id = ?', [id]));
  });
}

export async function listQueue(db: Db, actor: Actor) {
  require_(actor, 'table.open');
  const rows = await db.all('SELECT * FROM queue_tickets WHERE store_id = ? AND day = ? ORDER BY number', [actor.storeId, queueDay()]);
  const all = rows.map(ticketView);
  return {
    waiting: all.filter((x) => QUEUE_OPEN.includes(x.status)),
    done: all.filter((x) => !QUEUE_OPEN.includes(x.status)).slice(-20),
    calling: all.filter((x) => x.status === 'called').at(-1) ?? null,
  };
}

const QUEUE_MOVES: Record<string, { to: string; from: string[] }> = {
  call: { to: 'called', from: ['waiting', 'called'] },
  seat: { to: 'seated', from: ['waiting', 'called'] },
  skip: { to: 'skipped', from: ['waiting', 'called'] },
};

export async function moveQueueTicket(db: Db, actor: Actor, id: number, move: string): Promise<void> {
  require_(actor, 'table.open');
  const m = QUEUE_MOVES[move];
  if (!m) throw new DomainError('unknown queue action', 404);
  const now = Date.now();
  const inFrom = `status IN (${m.from.map(() => '?').join(',')})`;
  const n = m.to === 'called'
    ? await db.run(`UPDATE queue_tickets SET status = 'called', called_at = ? WHERE id = ? AND store_id = ? AND ${inFrom}`, [now, id, actor.storeId, ...m.from])
    : await db.run(`UPDATE queue_tickets SET status = ?, closed_at = ? WHERE id = ? AND store_id = ? AND ${inFrom}`, [m.to, now, id, actor.storeId, ...m.from]);
  if (!n) throw new DomainError('ticket not found or already done', 409);
}

/** What a guest's phone shows: their number, how many are ahead, and the number being called now. */
export async function guestQueueTicket(db: Db, code: string) {
  const r = await db.one('SELECT q.*, s.name AS store_name FROM queue_tickets q JOIN stores s ON s.id = q.store_id WHERE q.code = ?', [code]);
  if (!r) throw new DomainError('ticket not found', 404);
  const ahead = await db.one(`SELECT COUNT(*) AS n FROM queue_tickets WHERE store_id = ? AND day = ? AND number < ? AND status IN ('waiting','called')`,
    [r.store_id, r.day, r.number]);
  const calling = await db.one("SELECT MAX(number) AS n FROM queue_tickets WHERE store_id = ? AND day = ? AND status = 'called'", [r.store_id, r.day]);
  return { ...ticketView(r), storeName: r.store_name, ahead: Number(ahead.n), nowCalling: calling?.n === null ? null : Number(calling.n) };
}

export async function cancelGuestQueueTicket(db: Db, code: string): Promise<void> {
  const n = await db.run("UPDATE queue_tickets SET status = 'cancelled', closed_at = ? WHERE code = ? AND status IN ('waiting','called')", [Date.now(), code]);
  if (!n) throw new DomainError('ticket not found or already done', 409);
}

// ---------- staff training (学院) ----------

export async function listLessons(db: Db, actor: Actor) {
  const rows = await db.all(`SELECT l.*, r.read_at,
      (SELECT COUNT(*) FROM lesson_reads x WHERE x.lesson_id = l.id) AS readers
    FROM lessons l LEFT JOIN lesson_reads r ON r.lesson_id = l.id AND r.employee_id = ?
    WHERE l.tenant_id = ? AND (l.active OR ?) ORDER BY l.required DESC, l.category, l.created_at DESC`,
  [actor.id, actor.tenantId, actor.role === 'manager' || actor.role === 'owner']);
  return rows.map((r) => ({
    id: Number(r.id), title: r.title, category: r.category, body: r.body, videoUrl: r.video_url, required: Boolean(r.required),
    active: Boolean(r.active), createdAt: Number(r.created_at), readAt: r.read_at === null ? null : Number(r.read_at), readers: Number(r.readers),
  }));
}

export async function saveLesson(db: Db, actor: Actor, id: number | null, b: Record<string, unknown>): Promise<number> {
  require_(actor, 'admin.write');
  const title = text(b.title, MAX_TITLE);
  if (!title) throw new DomainError('title is required', 422);
  const videoUrl = text(b.videoUrl, 500);
  if (videoUrl && !/^https:\/\//.test(videoUrl)) throw new DomainError('video link must start with https://', 422);
  const values = [title, text(b.category), typeof b.body === 'string' ? b.body.slice(0, MAX_BODY) : '', videoUrl, b.required === true, b.active !== false];
  const lessonId = id === null
    ? await db.insert('INSERT INTO lessons (title, category, body, video_url, required, active, tenant_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [...values, actor.tenantId, actor.id, Date.now()])
    : (await db.run('UPDATE lessons SET title = ?, category = ?, body = ?, video_url = ?, required = ?, active = ? WHERE id = ? AND tenant_id = ?',
      [...values, id, actor.tenantId])) ? id : 0;
  if (!lessonId) throw new DomainError('lesson not found', 404);
  await audit(db, whoOf(actor), id === null ? 'lesson.create' : 'lesson.update', 'lesson', lessonId, { title });
  return lessonId;
}

export async function markLessonRead(db: Db, actor: Actor, id: number): Promise<void> {
  if (!(await db.one('SELECT 1 AS x FROM lessons WHERE id = ? AND tenant_id = ? AND active', [id, actor.tenantId]))) throw new DomainError('lesson not found', 404);
  await db.run('INSERT INTO lesson_reads (lesson_id, employee_id, read_at) VALUES (?,?,?) ON CONFLICT (lesson_id, employee_id) DO NOTHING', [id, actor.id, Date.now()]);
}

/** Managers: who has not yet read each required lesson. */
export async function trainingProgress(db: Db, actor: Actor) {
  require_(actor, 'admin.write');
  const rows = await db.all(`SELECT l.id, l.title, e.name FROM lessons l
    JOIN employees e ON e.tenant_id = l.tenant_id AND e.active AND e.role <> 'owner' AND (e.store_id = ? OR e.store_id IS NULL)
    LEFT JOIN lesson_reads r ON r.lesson_id = l.id AND r.employee_id = e.id
    WHERE l.tenant_id = ? AND l.active AND l.required AND r.read_at IS NULL ORDER BY l.id, e.name`, [actor.storeId, actor.tenantId]);
  const byLesson = new Map<number, { id: number; title: string; notRead: string[] }>();
  for (const r of rows) {
    const k = byLesson.get(Number(r.id)) ?? { id: Number(r.id), title: r.title, notRead: [] };
    k.notRead.push(r.name);
    byLesson.set(k.id, k);
  }
  return [...byLesson.values()];
}

// ---------- singers on stage (驻唱) ----------

const PERFORMER_KINDS = ['singer', 'dj', 'band', 'dancer', 'mc'];

export async function listPerformers(db: Db, actor: Actor) {
  require_(actor, 'admin.write');
  const [people, sets] = await Promise.all([
    db.all('SELECT id, name, kind, bio, active FROM performers WHERE tenant_id = ? ORDER BY active DESC, name', [actor.tenantId]),
    db.all(`SELECT s.id, s.performer_id, s.starts_at, s.ends_at, p.name FROM performer_sets s JOIN performers p ON p.id = s.performer_id
      WHERE s.store_id = ? AND s.ends_at >= ? ORDER BY s.starts_at`, [actor.storeId, Date.now()]),
  ]);
  return {
    performers: people.map((p) => ({ id: Number(p.id), name: p.name, kind: p.kind, bio: p.bio, active: Boolean(p.active) })),
    sets: sets.map((s) => ({ id: Number(s.id), performerId: Number(s.performer_id), name: s.name, startsAt: Number(s.starts_at), endsAt: Number(s.ends_at) })),
  };
}

export async function savePerformer(db: Db, actor: Actor, id: number | null, b: Record<string, unknown>): Promise<number> {
  require_(actor, 'admin.write');
  const name = text(b.name);
  if (!name) throw new DomainError('name is required', 422);
  const kind = PERFORMER_KINDS.includes(String(b.kind)) ? String(b.kind) : 'singer';
  const values = [name, kind, text(b.bio, 300), b.active !== false];
  const performerId = id === null
    ? await db.insert('INSERT INTO performers (name, kind, bio, active, tenant_id) VALUES (?,?,?,?,?)', [...values, actor.tenantId])
    : (await db.run('UPDATE performers SET name = ?, kind = ?, bio = ?, active = ? WHERE id = ? AND tenant_id = ?', [...values, id, actor.tenantId])) ? id : 0;
  if (!performerId) throw new DomainError('performer not found', 404);
  return performerId;
}

export async function addPerformerSet(db: Db, actor: Actor, b: Record<string, unknown>): Promise<number> {
  require_(actor, 'admin.write');
  const startsAt = Number(b.startsAt);
  const endsAt = Number(b.endsAt);
  if (!(Number.isFinite(startsAt) && endsAt > startsAt)) throw new DomainError('the set must end after it starts', 422);
  if (!(await db.one('SELECT 1 AS x FROM performers WHERE id = ? AND tenant_id = ? AND active', [Number(b.performerId), actor.tenantId]))) {
    throw new DomainError('performer not found', 404);
  }
  return db.insert('INSERT INTO performer_sets (performer_id, store_id, starts_at, ends_at) VALUES (?,?,?,?)', [Number(b.performerId), actor.storeId, startsAt, endsAt]);
}

export async function removePerformerSet(db: Db, actor: Actor, id: number): Promise<void> {
  require_(actor, 'admin.write');
  if (!(await db.run('DELETE FROM performer_sets WHERE id = ? AND store_id = ?', [id, actor.storeId]))) throw new DomainError('set not found', 404);
}

/** Customer app: who is on stage now and next, at each location of the company. */
export async function tonightsPerformers(db: Db, tenantId: number) {
  const now = Date.now();
  const rows = await db.all(`SELECT s.starts_at, s.ends_at, p.name, p.kind, p.bio, st.name AS store_name, st.code AS store_code
    FROM performer_sets s JOIN performers p ON p.id = s.performer_id JOIN stores st ON st.id = s.store_id
    WHERE st.tenant_id = ? AND st.active AND p.active AND s.ends_at >= ? AND s.starts_at <= ? ORDER BY s.starts_at`, [tenantId, now, now + SETS_AHEAD_MS]);
  return rows.map((r) => ({
    name: r.name, kind: r.kind, bio: r.bio, storeName: r.store_name, storeCode: r.store_code,
    startsAt: Number(r.starts_at), endsAt: Number(r.ends_at), onNow: Number(r.starts_at) <= now,
  }));
}
