// Sync engine: connectivity monitor, queue replay against POST /api/sync, and the "needs attention" list.
import { t, errorText } from '../i18n.js';
import { app, networkRequest } from '../session.js';
import { toast } from '../ui.js';
import { fmtMoney } from '../util.js';
import { getValue, setValue, listOps, transact, notifyChanged, onChanged, clearAll } from './store.js';

const PROBE_OFFLINE_MS = 5000;
const PROBE_ONLINE_MS = 15000;
const PROBE_TIMEOUT_MS = 3000;
const SYNC_TIMEOUT_MS = 30000;
const BATCH_SIZE = 100;
const BACKOFF_START_MS = 2000;
const BACKOFF_MAX_MS = 60000;
const SYNC_SOON_MS = 400;
const LOCK_NAME = 'nightpos-sync';
export const SYNCED_EVENT = 'nightpos:synced';

const state = { online: typeof navigator === 'undefined' ? true : navigator.onLine !== false, syncing: false, pending: 0, attention: 0, foreign: 0, needsLogin: false };
const subscribers = new Set();
let probeTimer = null;
let retryTimer = null;
let backoff = BACKOFF_START_MS;
let started = false;

export const getState = () => ({ ...state });
export const subscribe = (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); };
const emit = () => subscribers.forEach((fn) => fn(getState()));

/** Ops queued by the signed-in user at the current store; others wait until their owner signs in (the server applies ops as the caller). */
const isMine = (op) => app.actor && op.storeId === app.actor.storeId && op.actorId === app.actor.id;

export async function refreshCounts() {
  const ops = await listOps();
  const mine = ops.filter(isMine);
  Object.assign(state, {
    pending: mine.filter((o) => o.status === 'pending').length,
    attention: mine.filter((o) => o.status === 'attention').length,
    foreign: ops.filter((o) => !isMine(o) && o.status === 'pending').length,
  });
  emit();
}

export const listMyOps = async () => (await listOps()).filter(isMine);

// ---------- connectivity ----------

export function markOffline() {
  if (!state.online) return;
  state.online = false;
  emit();
  scheduleProbe();
}

export function markOnline() {
  if (state.online) return;
  state.online = true;
  emit();
  scheduleProbe();
  void syncNow();
}

async function probe() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch('/healthz', { cache: 'no-store', signal: controller.signal });
    if (res.ok) markOnline(); else markOffline();
  } catch {
    markOffline();
  } finally {
    clearTimeout(timer);
  }
  if (state.online && state.pending > 0 && !state.syncing && !state.needsLogin) void syncNow();
}

function scheduleProbe() {
  clearTimeout(probeTimer);
  probeTimer = setTimeout(async () => { await probe(); scheduleProbe(); }, state.online ? PROBE_ONLINE_MS : PROBE_OFFLINE_MS);
}

// ---------- replay ----------

const summarize = (ops) => ops.map((o) => ({ opId: o.opId, type: o.type, ...(o.ref ? { ref: o.ref } : {}), ts: o.ts, payload: o.payload }));

async function applyResults(sent, results) {
  const byId = new Map(results.map((r) => [r.opId, r]));
  for (const op of sent) if (!byId.has(op.opId)) byId.set(op.opId, { opId: op.opId, status: 'error', message: 'the server sent no result for this operation' });
  await transact(['ops', 'bills', 'kv'], 'readwrite', async (s) => {
    for (const op of sent) {
      const r = byId.get(op.opId);
      if (!r) continue;
      if (r.status === 'ok' && !r.priceDiffFen) {
        await s.del('ops', op.seq);
        if (op.meta?.tempId) await s.put('kv', r.billId, `idmap:${op.meta.tempId}`);
        continue;
      }
      if (r.status === 'ok') {
        // Applied, but with a warning the staff must see (prices changed while offline).
        await s.put('ops', { ...op, status: 'attention', result: r });
        if (op.meta?.tempId) await s.put('kv', r.billId, `idmap:${op.meta.tempId}`);
        continue;
      }
      await s.put('ops', { ...op, status: 'attention', result: r });
    }
    // A local working copy is only needed while operations for it are still queued; after that the server is the truth.
    const left = (await s.all('ops')).filter((o) => o.status === 'pending');
    for (const copy of await s.all('bills')) {
      if (!left.some((o) => o.ref === copy.ref || o.payload.billRef === copy.ref)) await s.del('bills', copy.ref);
    }
  });
}

async function runBatches() {
  for (;;) {
    const sent = (await listMyOps()).filter((o) => o.status === 'pending').slice(0, BATCH_SIZE);
    if (!sent.length || !app.token) return;
    let response;
    try {
      response = await networkRequest('POST', '/api/sync', { ops: summarize(sent) }, SYNC_TIMEOUT_MS);
    } catch (e) {
      if (e.status === 0) { markOffline(); return; }
      if (e.status === 401) { state.needsLogin = true; emit(); return; }
      if (e.status === 422 || e.status === 413 || e.status === 400) {
        // The server will never accept this batch as written; park it for a human instead of retrying forever.
        const result = { opId: '', status: 'error', message: e.message, code: e.status };
        await applyResults(sent, sent.map((o) => ({ ...result, opId: o.opId })));
        await refreshCounts();
        continue;
      }
      scheduleRetry();
      return;
    }
    backoff = BACKOFF_START_MS;
    const pendingBefore = state.pending;
    await applyResults(sent, response.results);
    await refreshCounts();
    window.dispatchEvent(new CustomEvent(SYNCED_EVENT));
    notifyChanged();
    if (state.pending >= pendingBefore) return;
  }
}

let soonTimer = null;
/** An operation queued while online (its bill already has queued operations) should not wait for the next probe. */
function scheduleSyncSoon() {
  clearTimeout(soonTimer);
  soonTimer = setTimeout(() => void syncNow(), SYNC_SOON_MS);
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void syncNow(), backoff);
  backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
}

/** Runs one replay pass. A Web Lock makes sure only one tab does it; the other tabs just see the result via the channel. */
export async function syncNow() {
  if (state.syncing || !state.online || !app.token || !app.actor) return;
  await refreshCounts();
  if (state.pending === 0) return;
  state.needsLogin = false;
  const run = async () => {
    state.syncing = true;
    emit();
    const before = state.pending;
    try {
      await runBatches();
    } finally {
      state.syncing = false;
      await refreshCounts();
      if (before > state.pending) {
        toast(state.attention > 0 ? t('sync.doneAttention', { n: state.attention }) : t('sync.done', { n: before - state.pending }), state.attention > 0 ? 'error' : 'success');
      }
    }
  };
  try {
    if (navigator.locks?.request) await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => { if (lock) await run(); });
    else await run();
  } catch (e) {
    state.syncing = false;
    emit();
    if (!(e instanceof DOMException)) throw e;
  }
}

// ---------- needs-attention actions ----------

/** Puts an op back in the queue, together with the ops that were skipped because of it. */
export async function retryOp(seq) {
  await transact(['ops'], 'readwrite', async (s) => {
    const all = await s.all('ops');
    const op = all.find((o) => o.seq === seq);
    if (!op) return;
    const ref = op.ref ?? op.payload.billRef;
    const group = all.filter((o) => o.seq === seq || (o.status === 'attention' && o.result?.status === 'skipped' && (o.payload.billRef === ref || o.ref === ref)));
    for (const o of group) await s.put('ops', { ...o, status: 'pending', result: undefined });
  });
  notifyChanged();
  await refreshCounts();
  void syncNow();
}

/** Removes an op from the list. Dismissing a failed bill-open also drops everything that depended on it. */
export async function dismissOp(seq) {
  await transact(['ops'], 'readwrite', async (s) => {
    const all = await s.all('ops');
    const op = all.find((o) => o.seq === seq);
    if (!op) return;
    const drop = op.ref ? all.filter((o) => o.seq === seq || (o.status === 'attention' && o.payload.billRef === op.ref)) : [op];
    for (const o of drop) await s.del('ops', o.seq);
  });
  notifyChanged();
  await refreshCounts();
}

/** What the temp bill became on the server, once its bill.open has synced. */
export const realBillId = (tempId) => getValue(`idmap:${tempId}`);

// ---------- lifecycle ----------

export function describeOp(op) {
  const m = op.meta ?? {};
  const table = m.tableName ?? '?';
  switch (op.type) {
    case 'bill.open': return t('sync.what.open', { table });
    case 'counter.open': return t('sync.what.sale');
    case 'bill.addLine': return t(m.gift ? 'sync.what.gift' : 'sync.what.line', { qty: m.qty, product: m.productName, table });
    case 'bill.transfer': return t('sync.what.transfer', { table, to: m.toTable ?? '?' });
    case 'bill.scan': return t('sync.what.label', { product: m.productName, table });
    case 'bill.member': return t('sync.what.member', { phone: m.phone, table });
    case 'bill.void': return t('sync.what.void', { qty: m.qty, product: m.productName, table });
    case 'bill.discount': return t('sync.what.discount', { amount: fmtMoney(m.amount ?? 0), table });
    default: return t('sync.what.pay', { amount: fmtMoney(m.amount ?? 0), method: m.method === 'credit' ? t('pay.credit') : t('pay.cash'), table });
  }
}

export function explainOp(op) {
  const r = op.result ?? {};
  const reason = errorText({ message: r.message ?? '' });
  if (r.status === 'ok') return t('sync.why.price', { reason });
  if (r.status === 'skipped') return t(op.type === 'bill.void' && r.message?.includes('never added') ? 'sync.why.skippedVoid' : 'sync.why.skipped');
  return reason || t('sync.why.unknown');
}

export function startSync() {
  if (started) return;
  started = true;
  window.addEventListener('online', () => void probe());
  window.addEventListener('offline', markOffline);
  onChanged((remote) => {
    void refreshCounts();
    if (remote) window.dispatchEvent(new CustomEvent(SYNCED_EVENT, { detail: { remote: true } }));
    else if (state.online) scheduleSyncSoon();
  });
  scheduleProbe();
}

/** Called after sign-in or store switch: count what is waiting for this user and replay it. */
export async function onSignedIn() {
  state.needsLogin = false;
  await refreshCounts();
  void syncNow();
}

/** Explicit logout: forget everything this device cached. Callers must have confirmed that unsynced work may be lost. */
export async function forgetEverything() {
  await clearAll();
  await setValue('meta:cleared', Date.now());
  await refreshCounts();
}
