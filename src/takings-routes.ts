import type { Db } from './db.ts';
import type { Actor } from './auth.ts';
import { compAllowances, myComps, setCompAllowance } from './comps.ts';
import { applyDeposit, listDeposits, listTips, recordTip, refundDeposit, takeDeposit } from './takings.ts';

interface Ctx { db: Db; actor: Actor; params: string[]; body: any; query: URLSearchParams }
type RouteFn = (method: string, path: string, auth: boolean, handler: (ctx: Ctx) => unknown) => void;

const OK = { ok: true };

/** Comp allowances, tips and rewards, deposits. */
export function registerTakingsRoutes(route: RouteFn, { num }: { num: (v: unknown) => number }): void {
  route('GET', '/api/comps/me', true, ({ db, actor }) => myComps(db, actor));
  route('GET', '/api/comps', true, ({ db, actor }) => compAllowances(db, actor));
  route('PUT', '/api/comps/:id', true, async ({ db, actor, params, body }) => {
    await setCompAllowance(db, actor, num(params[0]), body.allowance);
    return OK;
  });

  route('POST', '/api/tips', true, async ({ db, actor, body }) => ({ id: await recordTip(db, actor, body) }));
  route('GET', '/api/tips', true, ({ db, actor, query }) => listTips(db, actor, num(query.get('from') ?? 0), num(query.get('to') ?? Date.now() + 1)));

  route('POST', '/api/deposits', true, async ({ db, actor, body }) => ({ id: await takeDeposit(db, actor, body) }));
  route('GET', '/api/deposits', true, ({ db, actor, query }) => listDeposits(db, actor, query.get('status') ?? 'held'));
  route('POST', '/api/deposits/:id/apply', true, ({ db, actor, params, body }) => applyDeposit(db, actor, num(params[0]), body.billId));
  route('POST', '/api/deposits/:id/refund', true, async ({ db, actor, params, body }) => {
    await refundDeposit(db, actor, num(params[0]), body.reason);
    return OK;
  });
}
