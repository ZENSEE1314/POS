import type { Db } from './db.ts';
import type { Actor } from './auth.ts';
import { addAttendance, clockIn, clockOut, editAttendance, listAttendance, myAttendance, salaryReport, setPay } from './attendance.ts';
import { createBroadcast, listBroadcasts, staffNews, stopBroadcast } from './broadcasts.ts';
import { listActivity } from './activity.ts';

interface Ctx { db: Db; actor: Actor; params: string[]; body: any; query: URLSearchParams }
type RouteFn = (method: string, path: string, auth: boolean, handler: (ctx: Ctx) => unknown) => void;

/** Attendance, salary, broadcasts and the activity log. */
export function registerPeopleRoutes(route: RouteFn, { num }: { num: (v: unknown) => number }): void {
  const optional = (v: string | null) => (v === null || v === '' ? undefined : num(v));
  const range = (q: URLSearchParams) => [num(q.get('from') ?? 0), num(q.get('to') ?? Date.now() + 1)] as const;

  route('GET', '/api/attendance/me', true, ({ db, actor }) => myAttendance(db, actor));
  route('POST', '/api/attendance/clock-in', true, ({ db, actor }) => clockIn(db, actor));
  route('POST', '/api/attendance/clock-out', true, ({ db, actor }) => clockOut(db, actor));
  route('GET', '/api/attendance', true, ({ db, actor, query }) => listAttendance(db, actor, ...range(query), query.get('all') === '1'));
  route('POST', '/api/attendance', true, async ({ db, actor, body }) => ({ id: await addAttendance(db, actor, body) }));
  route('PATCH', '/api/attendance/:id', true, async ({ db, actor, params, body }) => {
    await editAttendance(db, actor, num(params[0]), body);
    return { ok: true };
  });

  route('GET', '/api/salary', true, ({ db, actor, query }) => salaryReport(db, actor, ...range(query), query.get('all') === '1'));
  route('PUT', '/api/staff-pay/:id', true, async ({ db, actor, params, body }) => {
    await setPay(db, actor, num(params[0]), body);
    return { ok: true };
  });

  route('GET', '/api/broadcasts', true, ({ db, actor }) => listBroadcasts(db, actor));
  route('POST', '/api/broadcasts', true, async ({ db, actor, body }) => ({ id: await createBroadcast(db, actor, body) }));
  route('POST', '/api/broadcasts/:id/stop', true, async ({ db, actor, params }) => {
    await stopBroadcast(db, actor, num(params[0]));
    return { ok: true };
  });
  route('GET', '/api/news', true, ({ db, actor }) => staffNews(db, actor));

  route('GET', '/api/activity', true, ({ db, actor, query }) => listActivity(db, actor, {
    from: optional(query.get('from')), to: optional(query.get('to')), staffId: optional(query.get('staff')),
    action: query.get('action')?.trim() || undefined, before: optional(query.get('before')), all: query.get('all') === '1',
  }));
}
