// Office (办公): departments with a join code staff use to sign themselves up, join approval, staff requests
// (leave, missed clock-in, expenses, purchases, resignation) with manager approval, and which sales rep owns which customer.
import { randomInt } from 'node:crypto';
import type { Db } from './db.ts';
import { audit, DomainError } from './db.ts';
import type { Actor, Role } from './auth.ts';
import { can, hashPin, isTenantWide, require_, whoOf } from './auth.ts';
import { cleanPhone } from './phone.ts';

const JOIN_CODE_LENGTH = 6;
/** No 0/O/1/I: codes are read out loud and typed on phones. */
const JOIN_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_TEXT = 300;
const MAX_NAME = 40;
const MIN_PIN = 4;
/** Roles a manager may hand out when approving a join; owner and finance are created by the owner in HQ. */
const JOINABLE_ROLES: Role[] = ['host', 'waiter', 'cashier', 'manager'];
export const REQUEST_KINDS = ['leave', 'missed_clock', 'expense', 'purchase', 'resign', 'other'] as const;
type RequestKind = typeof REQUEST_KINDS[number];
const DAY_MS = 86_400_000;
const DEFAULT_DORMANT_DAYS = 30;
const MAX_AMOUNT_FEN = 100_000_000;

const text = (v: unknown, max = MAX_TEXT): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
/** Owner and finance see every store; everyone else their own. Used as `(? OR x.store_id = ?)`. */
const storeScope = (actor: Actor) => [isTenantWide(actor.role), actor.storeId];

function newJoinCode(): string {
  let code = '';
  for (let i = 0; i < JOIN_CODE_LENGTH; i += 1) code += JOIN_CODE_CHARS[randomInt(JOIN_CODE_CHARS.length)];
  return code;
}

// ---------- departments ----------

export async function listDepartments(db: Db, actor: Actor) {
  const rows = await db.all(`SELECT d.id, d.name, d.store_id, s.name AS store_name, d.join_code, d.default_role, d.active,
      (SELECT count(*) FROM employees e WHERE e.department_id = d.id AND e.active) AS staff
    FROM departments d JOIN stores s ON s.id = d.store_id
    WHERE d.tenant_id = ? AND (? OR d.store_id = ?) ORDER BY s.name, d.name`, [actor.tenantId, ...storeScope(actor)]);
  const showCode = can(actor, 'admin.write');
  return rows.map((r) => ({
    id: Number(r.id), name: r.name, storeId: Number(r.store_id), storeName: r.store_name, defaultRole: r.default_role,
    active: r.active, staff: Number(r.staff), joinCode: showCode ? r.join_code : undefined,
  }));
}

function departmentInput(actor: Actor, b: Record<string, unknown>) {
  const name = text(b.name, MAX_NAME);
  if (!name) throw new DomainError('department name required', 422);
  const defaultRole = text(b.defaultRole) as Role || 'waiter';
  if (!JOINABLE_ROLES.includes(defaultRole)) throw new DomainError('default role must be host, waiter, cashier or manager', 422);
  const storeId = isTenantWide(actor.role) && b.storeId !== undefined ? Number(b.storeId) : actor.storeId;
  return { name, defaultRole, storeId };
}

async function assertOwnStore(db: Db, actor: Actor, storeId: number) {
  if (!await db.one('SELECT 1 AS x FROM stores WHERE id = ? AND tenant_id = ?', [storeId, actor.tenantId])) throw new DomainError('store not found', 404);
}

export async function createDepartment(db: Db, actor: Actor, b: Record<string, unknown>): Promise<number> {
  require_(actor, 'admin.write');
  const d = departmentInput(actor, b);
  await assertOwnStore(db, actor, d.storeId);
  return db.tx(async (t) => {
    const id = await t.insert('INSERT INTO departments (tenant_id, store_id, name, join_code, default_role, active, created_at) VALUES (?,?,?,?,?,TRUE,?)',
      [actor.tenantId, d.storeId, d.name, newJoinCode(), d.defaultRole, Date.now()]);
    await audit(t, whoOf(actor), 'department.create', 'department', id, { name: d.name });
    return id;
  });
}

async function ownDepartment(db: Db, actor: Actor, id: number) {
  const d = await db.one('SELECT * FROM departments WHERE id = ? AND tenant_id = ?', [id, actor.tenantId]);
  if (!d || (!isTenantWide(actor.role) && Number(d.store_id) !== actor.storeId)) throw new DomainError('department not found', 404);
  return d;
}

export async function updateDepartment(db: Db, actor: Actor, id: number, b: Record<string, unknown>): Promise<void> {
  require_(actor, 'admin.write');
  const old = await ownDepartment(db, actor, id);
  const d = departmentInput(actor, { storeId: old.store_id, ...b });
  const active = b.active === undefined ? old.active : Boolean(b.active);
  await db.run('UPDATE departments SET name = ?, default_role = ?, active = ? WHERE id = ?', [d.name, d.defaultRole, active, id]);
  await audit(db, whoOf(actor), 'department.update', 'department', id, { name: d.name, active });
}

/** A leaked code is useless after this: anyone with the old one is refused. */
export async function newDepartmentCode(db: Db, actor: Actor, id: number): Promise<string> {
  require_(actor, 'admin.write');
  await ownDepartment(db, actor, id);
  const code = newJoinCode();
  await db.run('UPDATE departments SET join_code = ? WHERE id = ?', [code, id]);
  await audit(db, whoOf(actor), 'department.code', 'department', id, {});
  return code;
}

export async function setStaffDepartment(db: Db, actor: Actor, employeeId: number, departmentId: number | null): Promise<void> {
  require_(actor, 'admin.write');
  const e = await db.one('SELECT store_id FROM employees WHERE id = ? AND tenant_id = ?', [employeeId, actor.tenantId]);
  if (!e || (!isTenantWide(actor.role) && Number(e.store_id) !== actor.storeId)) throw new DomainError('staff member not found', 404);
  if (departmentId !== null) await ownDepartment(db, actor, departmentId);
  await db.run('UPDATE employees SET department_id = ? WHERE id = ?', [departmentId, employeeId]);
  await audit(db, whoOf(actor), 'staff.department', 'employee', employeeId, { departmentId });
}

// ---------- joining with a code (public) and join approval ----------

export async function requestJoin(db: Db, b: Record<string, unknown>): Promise<void> {
  const code = text(b.joinCode, JOIN_CODE_LENGTH + 4).toUpperCase().replace(/\s/g, '');
  const company = text(b.company, 40).toLowerCase();
  const d = await db.one(`SELECT d.id, d.tenant_id, d.store_id FROM departments d JOIN tenants t ON t.id = d.tenant_id
    WHERE lower(t.code) = ? AND d.join_code = ? AND d.active AND t.active`, [company, code]);
  // Same message for a wrong company and a wrong code, so the form cannot be used to find valid codes one part at a time.
  if (!d) throw new DomainError('company or join code not recognised', 404);
  const name = text(b.name, MAX_NAME);
  if (!name) throw new DomainError('name required', 422);
  const username = text(b.username, 32);
  if (!/^[a-z0-9._-]{2,32}$/i.test(username)) throw new DomainError('username: 2-32 letters, digits, . _ -', 422);
  const pin = typeof b.pin === 'string' ? b.pin : '';
  if (!/^\d+$/.test(pin) || pin.length < MIN_PIN) throw new DomainError(`PIN: at least ${MIN_PIN} digits`, 422);
  const phone = cleanPhone(text(b.phone, 20));
  await db.tx(async (t) => {
    const taken = await t.one(`SELECT 1 AS x FROM employees WHERE tenant_id = ? AND lower(username) = lower(?)
      UNION SELECT 1 FROM staff_joins WHERE tenant_id = ? AND lower(username) = lower(?) AND status = 'pending'`, [d.tenant_id, username, d.tenant_id, username]);
    if (taken) throw new DomainError('username already used', 409);
    const id = await t.insert(`INSERT INTO staff_joins (tenant_id, store_id, department_id, name, username, phone, pin_hash, status, created_at)
      VALUES (?,?,?,?,?,?,?,'pending',?)`, [d.tenant_id, d.store_id, d.id, name, username, phone, hashPin(pin), Date.now()]);
    await audit(t, { tenantId: Number(d.tenant_id), storeId: Number(d.store_id), actorId: null }, 'staff.join.request', 'staff_join', id, { name, username });
  });
}

export async function listJoins(db: Db, actor: Actor) {
  require_(actor, 'admin.write');
  const rows = await db.all(`SELECT j.id, j.name, j.username, j.phone, j.created_at, d.name AS department, d.default_role, s.name AS store_name
    FROM staff_joins j JOIN departments d ON d.id = j.department_id JOIN stores s ON s.id = j.store_id
    WHERE j.tenant_id = ? AND j.status = 'pending' AND (? OR j.store_id = ?) ORDER BY j.created_at`, [actor.tenantId, ...storeScope(actor)]);
  return rows.map((r) => ({ id: Number(r.id), name: r.name, username: r.username, phone: r.phone, department: r.department,
    defaultRole: r.default_role, storeName: r.store_name, createdAt: Number(r.created_at) }));
}

async function pendingJoin(t: Db, actor: Actor, id: number) {
  const j = await t.one(`SELECT j.*, d.default_role FROM staff_joins j JOIN departments d ON d.id = j.department_id
    WHERE j.id = ? AND j.tenant_id = ? AND j.status = 'pending' FOR UPDATE OF j`, [id, actor.tenantId]);
  if (!j || (!isTenantWide(actor.role) && Number(j.store_id) !== actor.storeId)) throw new DomainError('join request not found', 404);
  return j;
}

export async function approveJoin(db: Db, actor: Actor, id: number, b: Record<string, unknown>): Promise<number> {
  require_(actor, 'admin.write');
  return db.tx(async (t) => {
    const j = await pendingJoin(t, actor, id);
    const role = (text(b.role) || j.default_role) as Role;
    if (!JOINABLE_ROLES.includes(role)) throw new DomainError('role must be host, waiter, cashier or manager', 422);
    if (role === 'manager' && actor.role !== 'owner') throw new DomainError('only the owner can approve a new manager', 403);
    if (await t.one('SELECT 1 AS x FROM employees WHERE tenant_id = ? AND lower(username) = lower(?)', [actor.tenantId, j.username])) {
      throw new DomainError('username already used', 409);
    }
    const employeeId = await t.insert(`INSERT INTO employees (tenant_id, store_id, name, role, pin_hash, username, department_id, phone, joined_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, [actor.tenantId, j.store_id, j.name, role, j.pin_hash, j.username, j.department_id, j.phone, Date.now()]);
    await t.run("UPDATE staff_joins SET status = 'approved', decided_by = ?, decided_at = ?, employee_id = ? WHERE id = ?", [actor.id, Date.now(), employeeId, id]);
    await audit(t, whoOf(actor), 'staff.join.approve', 'employee', employeeId, { joinId: id, role });
    return employeeId;
  });
}

export async function rejectJoin(db: Db, actor: Actor, id: number): Promise<void> {
  require_(actor, 'admin.write');
  await db.tx(async (t) => {
    await pendingJoin(t, actor, id);
    await t.run("UPDATE staff_joins SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?", [actor.id, Date.now(), id]);
    await audit(t, whoOf(actor), 'staff.join.reject', 'staff_join', id, {});
  });
}

// ---------- staff requests and approvals ----------

function requestInput(b: Record<string, unknown>) {
  const kind = text(b.kind) as RequestKind;
  if (!REQUEST_KINDS.includes(kind)) throw new DomainError(`kind must be one of ${REQUEST_KINDS.join(', ')}`, 422);
  const detail = text(b.detail);
  const amount = b.amount === undefined || b.amount === null || b.amount === '' ? 0 : Number(b.amount);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_AMOUNT_FEN) throw new DomainError('amount must be a whole number of fen', 422);
  const startAt = b.startAt ? Number(b.startAt) : null;
  const endAt = b.endAt ? Number(b.endAt) : null;
  for (const v of [startAt, endAt]) if (v !== null && (!Number.isSafeInteger(v) || v <= 0)) throw new DomainError('times must be epoch milliseconds', 422);
  if (startAt && endAt && endAt <= startAt) throw new DomainError('the end must be after the start', 422);
  if (kind === 'leave' && !(startAt && endAt)) throw new DomainError('leave needs a start and an end', 422);
  if (kind === 'missed_clock') {
    if (!(startAt && endAt)) throw new DomainError('a missed clock-in needs the real clock-in and clock-out times', 422);
    if (endAt > Date.now()) throw new DomainError('clock out cannot be in the future', 422);
    if (endAt - startAt > DAY_MS) throw new DomainError('a shift cannot be longer than 24 hours', 422);
  }
  if ((kind === 'expense' || kind === 'purchase') && amount <= 0) throw new DomainError('enter the amount', 422);
  if (kind !== 'resign' && !detail) throw new DomainError('please say what the request is for', 422);
  return { kind, detail, amount, startAt, endAt };
}

export async function createRequest(db: Db, actor: Actor, b: Record<string, unknown>): Promise<number> {
  const r = requestInput(b);
  return db.tx(async (t) => {
    if (r.kind === 'resign' && await t.one("SELECT 1 AS x FROM staff_requests WHERE employee_id = ? AND kind = 'resign' AND status = 'pending'", [actor.id])) {
      throw new DomainError('you already asked to leave; wait for the answer', 409);
    }
    const id = await t.insert(`INSERT INTO staff_requests (tenant_id, store_id, employee_id, kind, detail, amount, start_at, end_at, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,'pending',?)`, [actor.tenantId, actor.storeId, actor.id, r.kind, r.detail, r.amount, r.startAt, r.endAt, Date.now()]);
    await audit(t, whoOf(actor), 'request.create', 'staff_request', id, { kind: r.kind, amount: r.amount });
    return id;
  });
}

const requestView = (r: any) => ({
  id: Number(r.id), kind: r.kind, detail: r.detail, amount: Number(r.amount), startAt: r.start_at === null ? null : Number(r.start_at),
  endAt: r.end_at === null ? null : Number(r.end_at), status: r.status, createdAt: Number(r.created_at),
  employeeId: Number(r.employee_id), employeeName: r.employee_name, deciderName: r.decider_name ?? null,
  decidedAt: r.decided_at === null ? null : Number(r.decided_at), decisionNote: r.decision_note,
});

const REQUEST_SELECT = `SELECT q.*, e.name AS employee_name, x.name AS decider_name FROM staff_requests q
  JOIN employees e ON e.id = q.employee_id LEFT JOIN employees x ON x.id = q.decided_by`;

export async function myRequests(db: Db, actor: Actor) {
  return (await db.all(`${REQUEST_SELECT} WHERE q.employee_id = ? ORDER BY q.created_at DESC LIMIT 100`, [actor.id])).map(requestView);
}

/** The approval inbox: pending first, then the last decisions. A manager never decides their own request. */
export async function listApprovals(db: Db, actor: Actor, status: string) {
  require_(actor, 'admin.write');
  const wanted = status === 'done' ? "q.status IN ('approved','rejected')" : "q.status = 'pending'";
  const rows = await db.all(`${REQUEST_SELECT} WHERE q.tenant_id = ? AND ${wanted} AND (? OR q.store_id = ?)
    ORDER BY q.created_at ${status === 'done' ? 'DESC' : 'ASC'} LIMIT 200`, [actor.tenantId, ...storeScope(actor)]);
  return rows.map(requestView);
}

export async function decideRequest(db: Db, actor: Actor, id: number, b: Record<string, unknown>): Promise<void> {
  require_(actor, 'admin.write');
  const approve = b.approve === true;
  await db.tx(async (t) => {
    const q = await t.one("SELECT * FROM staff_requests WHERE id = ? AND tenant_id = ? AND status = 'pending' FOR UPDATE", [id, actor.tenantId]);
    if (!q || (!isTenantWide(actor.role) && Number(q.store_id) !== actor.storeId)) throw new DomainError('request not found', 404);
    if (Number(q.employee_id) === actor.id) throw new DomainError('someone else has to decide your own request', 403);
    await t.run('UPDATE staff_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?',
      [approve ? 'approved' : 'rejected', actor.id, Date.now(), text(b.note), id]);
    if (approve) await applyApproved(t, actor, q);
    await audit(t, whoOf(actor), approve ? 'request.approve' : 'request.reject', 'staff_request', id, { kind: q.kind });
  });
}

/** What an approval changes beyond the request itself. */
async function applyApproved(t: Db, actor: Actor, q: any): Promise<void> {
  if (q.kind === 'missed_clock') {
    await t.insert('INSERT INTO attendance (tenant_id, store_id, employee_id, clock_in, clock_out, note, edited_by) VALUES (?,?,?,?,?,?,?)',
      [q.tenant_id, q.store_id, q.employee_id, q.start_at, q.end_at, `missed clock-in approved (#${q.id})`, actor.id]);
  }
  if (q.kind === 'resign') {
    await t.run('UPDATE employees SET active = FALSE, left_at = ? WHERE id = ?', [Date.now(), q.employee_id]);
    await t.run('DELETE FROM sessions WHERE employee_id = ?', [q.employee_id]);
    // Their customers go back to the venue so nobody walks out with the list.
    await t.run('UPDATE members SET owner_id = NULL WHERE owner_id = ?', [q.employee_id]);
  }
}

export async function cancelRequest(db: Db, actor: Actor, id: number): Promise<void> {
  const changed = await db.run("UPDATE staff_requests SET status = 'cancelled' WHERE id = ? AND employee_id = ? AND status = 'pending'", [id, actor.id]);
  if (!changed) throw new DomainError('request not found or already decided', 404);
  await audit(db, whoOf(actor), 'request.cancel', 'staff_request', id, {});
}

// ---------- customers and the sales rep who looks after them ----------

const CUSTOMER_SELECT = `SELECT m.id, m.name, m.phone, m.balance, m.owner_id, o.name AS owner_name,
    (SELECT max(b.closed_at) FROM bills b WHERE b.member_id = m.id AND b.status = 'closed') AS last_visit,
    (SELECT count(*) FROM bills b WHERE b.member_id = m.id AND b.status = 'closed') AS visits
  FROM members m LEFT JOIN employees o ON o.id = m.owner_id`;

const customerView = (r: any, showPhone: boolean) => ({
  id: Number(r.id), name: r.name, phone: showPhone ? r.phone : `${String(r.phone).slice(0, 3)}****${String(r.phone).slice(-4)}`,
  balance: Number(r.balance), ownerId: r.owner_id === null ? null : Number(r.owner_id), ownerName: r.owner_name ?? null,
  lastVisit: r.last_visit === null ? null : Number(r.last_visit), visits: Number(r.visits),
});

export async function myCustomers(db: Db, actor: Actor) {
  const rows = await db.all(`${CUSTOMER_SELECT} WHERE m.tenant_id = ? AND m.owner_id = ? ORDER BY m.name`, [actor.tenantId, actor.id]);
  return rows.map((r) => customerView(r, true));
}

/** Customers who have not been back for `days` (or never came): the list to call this week. */
export async function dormantCustomers(db: Db, actor: Actor, days: number) {
  const cutoff = Date.now() - Math.max(1, days || DEFAULT_DORMANT_DAYS) * DAY_MS;
  const mine = !can(actor, 'admin.write');
  const rows = await db.all(`SELECT * FROM (${CUSTOMER_SELECT} WHERE m.tenant_id = ? ${mine ? 'AND m.owner_id = ?' : ''}) c
    WHERE c.last_visit IS NULL OR c.last_visit < ? ORDER BY c.last_visit NULLS FIRST LIMIT 300`,
  mine ? [actor.tenantId, actor.id, cutoff] : [actor.tenantId, cutoff]);
  return rows.map((r) => customerView(r, !mine || Number(r.owner_id) === actor.id));
}

export async function allCustomers(db: Db, actor: Actor, q: string) {
  require_(actor, 'admin.write');
  const like = `%${q.trim()}%`;
  const rows = await db.all(`${CUSTOMER_SELECT} WHERE m.tenant_id = ? AND (m.name ILIKE ? OR m.phone LIKE ?) ORDER BY m.name LIMIT 300`, [actor.tenantId, like, like]);
  return rows.map((r) => customerView(r, true));
}

export async function assignCustomers(db: Db, actor: Actor, b: Record<string, unknown>): Promise<number> {
  require_(actor, 'admin.write');
  const ids = Array.isArray(b.memberIds) ? b.memberIds.map(Number).filter(Number.isSafeInteger) : [];
  if (!ids.length) throw new DomainError('choose at least one customer', 422);
  const ownerId = b.ownerId === null ? null : Number(b.ownerId);
  if (ownerId !== null && !await db.one('SELECT 1 AS x FROM employees WHERE id = ? AND tenant_id = ? AND active', [ownerId, actor.tenantId])) {
    throw new DomainError('staff member not found', 404);
  }
  const placeholders = ids.map(() => '?').join(',');
  const changed = await db.run(`UPDATE members SET owner_id = ? WHERE tenant_id = ? AND id IN (${placeholders})`, [ownerId, actor.tenantId, ...ids]);
  await audit(db, whoOf(actor), 'customer.assign', 'employee', ownerId ?? 0, { memberIds: ids });
  return changed;
}

/** A rep who serves a customer with no owner yet becomes their owner, so the list builds itself as the venue works. */
export async function claimCustomer(db: Db, memberId: number, repId: number): Promise<void> {
  await db.run('UPDATE members SET owner_id = ? WHERE id = ? AND owner_id IS NULL', [repId, memberId]);
}
