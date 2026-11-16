import type { Db } from './db.ts';
import { audit, DomainError } from './db.ts';
import type { Actor } from './auth.ts';
import { isTenantWide, require_, whoOf } from './auth.ts';

const HOUR_MS = 3_600_000;
/** A shift typed in by a manager longer than this is almost certainly a typo (wrong day). */
const MAX_SHIFT_MS = 24 * HOUR_MS;
const MAX_NOTE_LENGTH = 200;
const LIST_LIMIT = 1000;
const PAY_KINDS = ['hourly', 'monthly'];
/** 1 million yuan a month (or an hour) in fen: far above any real wage, far inside BIGINT. */
const MAX_RATE_FEN = 100_000_000;

export interface ShiftInput { employeeId?: unknown; clockIn?: unknown; clockOut?: unknown; note?: unknown }

const time = (v: unknown, name: string): number => {
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new DomainError(`${name} must be a time in epoch milliseconds`, 422);
  return n;
};

const note = (v: unknown): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length > MAX_NOTE_LENGTH) throw new DomainError(`note is too long (max ${MAX_NOTE_LENGTH})`, 422);
  return s;
};

function shiftTimes(input: ShiftInput): { clockIn: number; clockOut: number } {
  const clockIn = time(input.clockIn, 'clockIn');
  const clockOut = time(input.clockOut, 'clockOut');
  if (clockOut <= clockIn) throw new DomainError('clock out must be after clock in', 422);
  if (clockOut - clockIn > MAX_SHIFT_MS) throw new DomainError('a shift cannot be longer than 24 hours', 422);
  if (clockOut > Date.now()) throw new DomainError('clock out cannot be in the future', 422);
  return { clockIn, clockOut };
}

/** Owner and finance may roll up every store; everyone else sees their own store. */
const wideScope = (actor: Actor, all: boolean) => all && isTenantWide(actor.role);

// ---------- clocking in and out (every staff member, for themselves) ----------

export function myAttendance(db: Db, actor: Actor) {
  return db.one(
    `SELECT id, store_id AS "storeId", clock_in AS "clockIn" FROM attendance WHERE employee_id = ? AND clock_out IS NULL`, [actor.id]).then((r) => r ?? null);
}

export async function clockIn(db: Db, actor: Actor) {
  return db.tx(async (t) => {
    // Locks the employee row so two taps at once cannot both open a shift.
    await t.one('SELECT id FROM employees WHERE id = ? FOR UPDATE', [actor.id]);
    if (await t.one('SELECT 1 AS x FROM attendance WHERE employee_id = ? AND clock_out IS NULL', [actor.id])) {
      throw new DomainError('already clocked in', 409);
    }
    const now = Date.now();
    const id = await t.insert('INSERT INTO attendance (tenant_id, store_id, employee_id, clock_in) VALUES (?,?,?,?)', [actor.tenantId, actor.storeId, actor.id, now]);
    await audit(t, whoOf(actor), 'attendance.in', 'attendance', id, {});
    return { id, clockIn: now };
  });
}

export async function clockOut(db: Db, actor: Actor) {
  return db.tx(async (t) => {
    const open = await t.one('SELECT * FROM attendance WHERE employee_id = ? AND clock_out IS NULL FOR UPDATE', [actor.id]);
    if (!open) throw new DomainError('not clocked in', 409);
    const now = Math.max(Date.now(), open.clock_in + 1);
    await t.run('UPDATE attendance SET clock_out = ? WHERE id = ?', [now, open.id]);
    await audit(t, whoOf(actor), 'attendance.out', 'attendance', open.id, { minutes: Math.round((now - open.clock_in) / 60_000) });
    return { id: open.id, clockIn: open.clock_in, clockOut: now };
  });
}

// ---------- the attendance sheet (managers, finance, owner) ----------

export function listAttendance(db: Db, actor: Actor, fromTs: number, toTs: number, all = false) {
  require_(actor, 'audit.read');
  return db.all(
    `SELECT a.id, a.employee_id AS "employeeId", e.name, e.role, a.store_id AS "storeId", s.name AS "storeName",
            a.clock_in AS "clockIn", a.clock_out AS "clockOut", a.note, a.edited_by IS NOT NULL AS edited
     FROM attendance a JOIN employees e ON e.id = a.employee_id JOIN stores s ON s.id = a.store_id
     WHERE a.tenant_id = ? AND (? OR a.store_id = ?) AND a.clock_in >= ? AND a.clock_in < ?
     ORDER BY a.clock_in DESC LIMIT ${LIST_LIMIT}`, [actor.tenantId, wideScope(actor, all), actor.storeId, fromTs, toTs]);
}

/** A manager records a shift someone forgot to clock (in the manager's current store). */
export async function addAttendance(db: Db, actor: Actor, input: ShiftInput) {
  require_(actor, 'admin.write');
  const employeeId = typeof input.employeeId === 'number' ? input.employeeId : NaN;
  const { clockIn: start, clockOut: end } = shiftTimes(input);
  const text = note(input.note);
  return db.tx(async (t) => {
    const e = await t.one('SELECT id, store_id FROM employees WHERE id = ? AND tenant_id = ?', [employeeId, actor.tenantId]);
    if (!e || (!isTenantWide(actor.role) && e.store_id !== actor.storeId)) throw new DomainError('staff member not found', 404);
    const id = await t.insert(
      'INSERT INTO attendance (tenant_id, store_id, employee_id, clock_in, clock_out, note, edited_by) VALUES (?,?,?,?,?,?,?)',
      [actor.tenantId, actor.storeId, employeeId, start, end, text, actor.id]);
    await audit(t, whoOf(actor), 'attendance.add', 'attendance', id, { employeeId, clockIn: start, clockOut: end, note: text });
    return id;
  });
}

/** Corrects a shift: a missed clock-out, a wrong time. The old times stay in the audit log. */
export async function editAttendance(db: Db, actor: Actor, id: number, input: ShiftInput) {
  require_(actor, 'admin.write');
  const { clockIn: start, clockOut: end } = shiftTimes(input);
  const text = note(input.note);
  await db.tx(async (t) => {
    const row = await t.one('SELECT * FROM attendance WHERE id = ? AND tenant_id = ? FOR UPDATE', [id, actor.tenantId]);
    if (!row || (!isTenantWide(actor.role) && row.store_id !== actor.storeId)) throw new DomainError('shift not found', 404);
    await t.run('UPDATE attendance SET clock_in = ?, clock_out = ?, note = ?, edited_by = ? WHERE id = ?', [start, end, text, actor.id, id]);
    await audit(t, whoOf(actor), 'attendance.edit', 'attendance', id, {
      employeeId: row.employee_id, before: { clockIn: row.clock_in, clockOut: row.clock_out }, after: { clockIn: start, clockOut: end }, note: text,
    });
  });
}

// ---------- salary (finance and owner) ----------

export async function setPay(db: Db, actor: Actor, employeeId: number, input: { kind?: unknown; rate?: unknown }) {
  require_(actor, 'payroll.write');
  const kind = String(input.kind ?? '');
  if (!PAY_KINDS.includes(kind)) throw new DomainError('kind must be hourly or monthly', 422);
  const rate = typeof input.rate === 'number' ? input.rate : NaN;
  if (!Number.isSafeInteger(rate) || rate < 0 || rate > MAX_RATE_FEN) throw new DomainError(`rate must be an amount in fen from 0 to ${MAX_RATE_FEN}`, 422);
  await db.tx(async (t) => {
    if (!await t.one('SELECT 1 AS x FROM employees WHERE id = ? AND tenant_id = ?', [employeeId, actor.tenantId])) throw new DomainError('staff member not found', 404);
    await t.run(
      `INSERT INTO staff_pay (employee_id, tenant_id, kind, rate, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT (employee_id) DO UPDATE SET kind = EXCLUDED.kind, rate = EXCLUDED.rate, updated_at = EXCLUDED.updated_at`,
      [employeeId, actor.tenantId, kind, rate, Date.now()]);
    await audit(t, whoOf(actor), 'staff.pay', 'employee', employeeId, { kind, rate });
  });
}

/**
 * Pay for one period, normally a calendar month: base pay (hours worked x hourly rate, or the monthly
 * salary once) plus sales commission. Only finished shifts count; staff still clocked in are flagged.
 * Store-scoped by default; `all` rolls up the whole company.
 */
export async function salaryReport(db: Db, actor: Actor, fromTs: number, toTs: number, all = false) {
  require_(actor, 'payroll.read');
  const wide = wideScope(actor, all);
  const staff = await db.all(
    `SELECT e.id, e.name, e.role, e.store_id AS "storeId", e.active, p.kind, p.rate
     FROM employees e LEFT JOIN staff_pay p ON p.employee_id = e.id
     WHERE e.tenant_id = ? AND (? OR e.store_id = ? OR e.store_id IS NULL) ORDER BY e.name`, [actor.tenantId, wide, actor.storeId]);
  const worked = await db.all(
    `SELECT employee_id AS id, SUM(clock_out - clock_in) AS ms, COUNT(*) AS shifts
     FROM attendance WHERE tenant_id = ? AND (? OR store_id = ?) AND clock_out IS NOT NULL AND clock_in >= ? AND clock_in < ?
     GROUP BY employee_id`, [actor.tenantId, wide, actor.storeId, fromTs, toTs]);
  const open = await db.all(
    'SELECT employee_id AS id FROM attendance WHERE tenant_id = ? AND clock_out IS NULL AND clock_in < ?', [actor.tenantId, toTs]);
  const commission = await db.all(
    `SELECT c.employee_id AS id, SUM(c.amount) AS amount FROM commission_entries c JOIN stores s ON s.id = c.store_id
     WHERE s.tenant_id = ? AND (? OR c.store_id = ?) AND c.ts >= ? AND c.ts < ? GROUP BY c.employee_id`,
    [actor.tenantId, wide, actor.storeId, fromTs, toTs]);
  const byId = <T extends { id: number }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
  const workedBy = byId(worked);
  const commissionBy = byId(commission);
  const openIds = new Set(open.map((r) => r.id));
  return staff.flatMap((e) => {
    const ms = workedBy.get(e.id)?.ms ?? 0;
    const comm = commissionBy.get(e.id)?.amount ?? 0;
    // Leavers drop off the sheet once they have nothing to be paid for in the period.
    if (!e.active && ms === 0 && comm === 0) return [];
    const base = e.kind === 'hourly' ? Math.round((ms * e.rate) / HOUR_MS) : e.kind === 'monthly' ? e.rate : 0;
    return [{
      employeeId: e.id, name: e.name, role: e.role, storeId: e.storeId, active: e.active,
      payKind: e.kind ?? null, rate: e.rate ?? null, shifts: workedBy.get(e.id)?.shifts ?? 0, workedMs: ms,
      stillClockedIn: openIds.has(e.id), basePay: base, commission: comm, total: base + comm,
    }];
  });
}
