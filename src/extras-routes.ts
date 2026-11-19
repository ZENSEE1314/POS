import type { Db } from './db.ts';
import { DomainError } from './db.ts';
import type { Actor } from './auth.ts';
import { require_ } from './auth.ts';
import { RateLimiter } from './ops.ts';
import { kdsQueue, setServed } from './kds.ts';
import {
  cancelStocktake, cancelTransfer, closeStocktake, getStocktake, listStocktakes, listTransfers, receiveTransfer, saveCounts, sendTransfer, startStocktake,
} from './stocktake.ts';
import {
  addPerformerSet, cancelGuestQueueTicket, expiredStash, forfeitStash, guestQueueTicket, listLessons, listPerformers, listQueue, markLessonRead,
  moveQueueTicket, removePerformerSet, saveLesson, savePerformer, takeQueueNumber, tonightsPerformers, trainingProgress,
} from './venue-extras.ts';
import { listResellers, resellerCompanies, saveReseller } from './resellers.ts';
import { tenantByCode } from './guest/venue.ts';

interface Ctx { db: Db; actor: Actor; params: string[]; body: any; query: URLSearchParams; ip: string }
type RouteFn = (method: string, path: string, auth: boolean, handler: (ctx: Ctx) => unknown) => void;

const GUEST_QUEUE_PER_IP_PER_HOUR = 20;
const HOUR_MS = 3_600_000;
const ok = { ok: true };

/** Bar display, stocktake/transfers, forfeited bottles, queue, training, singers and resellers. */
export function registerExtrasRoutes(route: RouteFn, { num }: { num: (v: unknown) => number }): void {
  route('GET', '/api/kds', true, ({ db, actor, query }) => kdsQueue(db, actor, query.get('station') ?? 'all'));
  route('POST', '/api/kds/served', true, async ({ db, actor, body }) => ({ changed: await setServed(db, actor, body) }));

  route('GET', '/api/stocktakes', true, ({ db, actor }) => listStocktakes(db, actor));
  route('POST', '/api/stocktakes', true, async ({ db, actor, body }) => ({ stocktakeId: await startStocktake(db, actor, body) }));
  route('GET', '/api/stocktakes/:id', true, ({ db, actor, params }) => getStocktake(db, actor, num(params[0])));
  route('PATCH', '/api/stocktakes/:id', true, async ({ db, actor, params, body }) => { await saveCounts(db, actor, num(params[0]), body); return ok; });
  route('POST', '/api/stocktakes/:id/close', true, ({ db, actor, params }) => closeStocktake(db, actor, num(params[0])));
  route('POST', '/api/stocktakes/:id/cancel', true, async ({ db, actor, params }) => { await cancelStocktake(db, actor, num(params[0])); return ok; });

  // Every location of the company, for picking where to send stock; names only, so any signed-in staff may see it.
  route('GET', '/api/stores', true, ({ db, actor }) =>
    db.all('SELECT id, name, code FROM stores WHERE tenant_id = ? AND active ORDER BY id', [actor.tenantId]));
  route('GET', '/api/stock-transfers', true, ({ db, actor }) => listTransfers(db, actor));
  route('POST', '/api/stock-transfers', true, async ({ db, actor, body }) => ({ transferId: await sendTransfer(db, actor, body) }));
  route('POST', '/api/stock-transfers/:id/receive', true, async ({ db, actor, params }) => { await receiveTransfer(db, actor, num(params[0])); return ok; });
  route('POST', '/api/stock-transfers/:id/cancel', true, async ({ db, actor, params }) => { await cancelTransfer(db, actor, num(params[0])); return ok; });

  route('GET', '/api/stash/expired', true, ({ db, actor }) => expiredStash(db, actor));
  route('POST', '/api/stash/forfeit', true, ({ db, actor, body }) => forfeitStash(db, actor, body));

  route('GET', '/api/queue', true, ({ db, actor }) => listQueue(db, actor));
  route('POST', '/api/queue', true, ({ db, actor, body }) => {
    require_(actor, 'table.open');
    return takeQueueNumber(db, actor.storeId, body, 'staff');
  });
  route('POST', '/api/queue/:id/:move', true, async ({ db, actor, params }) => { await moveQueueTicket(db, actor, num(params[0]), params[1]); return ok; });

  route('GET', '/api/lessons', true, ({ db, actor }) => listLessons(db, actor));
  route('POST', '/api/lessons', true, async ({ db, actor, body }) => ({ lessonId: await saveLesson(db, actor, null, body) }));
  route('PATCH', '/api/lessons/:id', true, async ({ db, actor, params, body }) => ({ lessonId: await saveLesson(db, actor, num(params[0]), body) }));
  route('POST', '/api/lessons/:id/read', true, async ({ db, actor, params }) => { await markLessonRead(db, actor, num(params[0])); return ok; });
  route('GET', '/api/training-progress', true, ({ db, actor }) => trainingProgress(db, actor));

  route('GET', '/api/performers', true, ({ db, actor }) => listPerformers(db, actor));
  route('POST', '/api/performers', true, async ({ db, actor, body }) => ({ performerId: await savePerformer(db, actor, null, body) }));
  route('PATCH', '/api/performers/:id', true, async ({ db, actor, params, body }) => ({ performerId: await savePerformer(db, actor, num(params[0]), body) }));
  route('POST', '/api/performer-sets', true, async ({ db, actor, body }) => ({ setId: await addPerformerSet(db, actor, body) }));
  route('DELETE', '/api/performer-sets/:id', true, async ({ db, actor, params }) => { await removePerformerSet(db, actor, num(params[0])); return ok; });

  // ---- customer app ----
  const queueLimiter = new RateLimiter(GUEST_QUEUE_PER_IP_PER_HOUR, HOUR_MS);
  route('POST', '/api/guest/queue/:company', false, async ({ db, params, body, ip }) => {
    if (!queueLimiter.allow(ip)) throw new DomainError('too many queue numbers from this address', 429);
    const tenant = await tenantByCode(db, params[0]);
    const store = await db.one('SELECT id FROM stores WHERE tenant_id = ? AND active AND (code = ? OR ? = \'\') ORDER BY id LIMIT 1',
      [tenant.id, String(body.storeCode ?? ''), String(body.storeCode ?? '')]);
    if (!store) throw new DomainError('location not found', 404);
    return takeQueueNumber(db, Number(store.id), body, 'guest');
  });
  route('GET', '/api/guest/queue-ticket/:code', false, ({ db, params }) => guestQueueTicket(db, params[0]));
  route('POST', '/api/guest/queue-ticket/:code/cancel', false, async ({ db, params }) => { await cancelGuestQueueTicket(db, params[0]); return ok; });
  route('GET', '/api/guest/performers/:company', false, async ({ db, params }) => tonightsPerformers(db, (await tenantByCode(db, params[0])).id));

  // ---- platform operator ----
  route('GET', '/platform/resellers', false, ({ db }) => listResellers(db));
  route('POST', '/platform/resellers', false, ({ db, body }) => saveReseller(db, null, body));
  route('PATCH', '/platform/resellers/:id', false, ({ db, params, body }) => saveReseller(db, num(params[0]), body));
  route('GET', '/platform/resellers/:id/companies', false, ({ db, params }) => resellerCompanies(db, num(params[0])));
}
