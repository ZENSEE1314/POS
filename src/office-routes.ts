import type { Db } from './db.ts';
import type { Actor } from './auth.ts';
import {
  allCustomers, approveJoin, assignCustomers, cancelRequest, createDepartment, createRequest, decideRequest, dormantCustomers,
  listApprovals, listDepartments, listJoins, myCustomers, myRequests, newDepartmentCode, rejectJoin, setStaffDepartment, updateDepartment,
} from './office.ts';
import { myToday, performance } from './workbench.ts';

interface Ctx { db: Db; actor: Actor; params: string[]; body: any; query: URLSearchParams }
type RouteFn = (method: string, path: string, auth: boolean, handler: (ctx: Ctx) => unknown) => void;

const OK = { ok: true };

/** Departments, join approval, staff requests and approvals, customer owners. Public joining is in app.ts (rate-limited). */
export function registerOfficeRoutes(route: RouteFn, { num }: { num: (v: unknown) => number }): void {
  route('GET', '/api/departments', true, ({ db, actor }) => listDepartments(db, actor));
  route('POST', '/api/departments', true, async ({ db, actor, body }) => ({ id: await createDepartment(db, actor, body) }));
  route('PATCH', '/api/departments/:id', true, async ({ db, actor, params, body }) => {
    await updateDepartment(db, actor, num(params[0]), body);
    return OK;
  });
  route('POST', '/api/departments/:id/code', true, async ({ db, actor, params }) => ({ joinCode: await newDepartmentCode(db, actor, num(params[0])) }));
  route('PUT', '/api/staff/:id/department', true, async ({ db, actor, params, body }) => {
    const departmentId = body.departmentId === null || body.departmentId === undefined || body.departmentId === '' ? null : num(body.departmentId);
    await setStaffDepartment(db, actor, num(params[0]), departmentId);
    return OK;
  });

  route('GET', '/api/joins', true, ({ db, actor }) => listJoins(db, actor));
  route('POST', '/api/joins/:id/approve', true, async ({ db, actor, params, body }) => ({ employeeId: await approveJoin(db, actor, num(params[0]), body) }));
  route('POST', '/api/joins/:id/reject', true, async ({ db, actor, params }) => {
    await rejectJoin(db, actor, num(params[0]));
    return OK;
  });

  route('GET', '/api/requests/mine', true, ({ db, actor }) => myRequests(db, actor));
  route('POST', '/api/requests', true, async ({ db, actor, body }) => ({ id: await createRequest(db, actor, body) }));
  route('POST', '/api/requests/:id/cancel', true, async ({ db, actor, params }) => {
    await cancelRequest(db, actor, num(params[0]));
    return OK;
  });
  route('GET', '/api/approvals', true, ({ db, actor, query }) => listApprovals(db, actor, query.get('status') ?? 'pending'));
  route('POST', '/api/approvals/:id', true, async ({ db, actor, params, body }) => {
    await decideRequest(db, actor, num(params[0]), body);
    return OK;
  });

  route('GET', '/api/customers/mine', true, ({ db, actor }) => myCustomers(db, actor));
  route('GET', '/api/customers/dormant', true, ({ db, actor, query }) => dormantCustomers(db, actor, Number(query.get('days') ?? 0)));
  route('GET', '/api/customers', true, ({ db, actor, query }) => allCustomers(db, actor, query.get('q') ?? ''));
  route('GET', '/api/me/today', true, ({ db, actor }) => myToday(db, actor));
  route('GET', '/api/performance', true, ({ db, actor, query }) =>
    performance(db, actor, num(query.get('from') ?? 0), num(query.get('to') ?? Date.now() + 1), query.get('all') === '1'));
  route('POST', '/api/customers/assign', true, async ({ db, actor, body }) => ({ changed: await assignCustomers(db, actor, body) }));
}
