// The print pipeline: pick printers for a job, rasterise, POST to the local bridge, log, fall back to the browser.
// Printing must never block or fail a sale: printJob() never rejects and jobs run one at a time in the background.
import { t } from '../i18n.js';
import { app, get, readStore, writeStore } from '../session.js';
import { toast } from '../ui.js';
import { toBase64 } from './escpos.js';
import { modelToEscPos } from './raster.js';
import { printModelHtml } from './html-fallback.js';
import { testModel } from './templates.js';
import { addLog, updateLog, getLog, printersCacheKey } from './log.js';
import { bridgeBase, getSettings, isBridgeConfigured } from './settings.js';

const BRIDGE_TIMEOUT_MS = 15_000;
const STATUS_TIMEOUT_MS = 4000;
/** Which configured printer kinds can serve each job kind, in order of preference. */
const KINDS_FOR_JOB = { receipt: ['receipt'], report: ['receipt'], label: ['label', 'receipt'], bar: ['bar'], kitchen: ['kitchen'] };
/** Slips a person is waiting for may fall back to the browser's print dialog; station tickets may not. */
const BROWSER_FALLBACK_JOBS = new Set(['receipt', 'report', 'label']);

class PrintError extends Error {}

let chain = Promise.resolve();
const enqueue = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};

// ---- printers (routing from the server, cached for when the internet is down) ----------------------------

export async function getPrinters() {
  const storeId = app.actor?.storeId;
  try {
    const list = await get('/api/printers');
    writeStore(localStorage, printersCacheKey, JSON.stringify({ storeId, list }));
    return list;
  } catch {
    try {
      const cached = JSON.parse(readStore(localStorage, printersCacheKey) ?? 'null');
      if (cached?.storeId === storeId && Array.isArray(cached.list)) return cached.list;
    } catch { /* corrupt cache */ }
    return [];
  }
}

async function printersFor(kind) {
  const all = (await getPrinters()).filter((p) => p.enabled);
  for (const wanted of KINDS_FOR_JOB[kind] ?? []) {
    const hit = all.filter((p) => p.kind === wanted);
    if (hit.length) return hit;
  }
  return [];
}

// ---- bridge -----------------------------------------------------------------------------------------------

async function bridgeFetch(settings, path, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${bridgeBase(settings)}${path}`, {
      ...init, mode: 'cors', credentials: 'omit', cache: 'no-store', signal: controller.signal,
      headers: { 'x-bridge-token': settings.token, ...init.headers },
    });
  } catch {
    throw new PrintError(t('print.err.bridge'));
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new PrintError(res.status === 401 ? t('print.err.token') : body.error ?? `bridge ${res.status}`);
  return body;
}

/** Asks the bridge who it is and which printer names it knows (used by "Test connection"). */
export const checkBridge = (settings = getSettings()) => bridgeFetch(settings, '/status', { method: 'GET' }, STATUS_TIMEOUT_MS);

async function sendToBridge(settings, target, model) {
  const data = toBase64(modelToEscPos(model, target.paperMm));
  for (let copy = 0; copy < (target.copies ?? 1); copy++) {
    await bridgeFetch(settings, '/print', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ printer: target.bridgeName, data }) }, BRIDGE_TIMEOUT_MS);
  }
}

const targetOf = (p) => ({ bridgeName: p.bridgeName, paperMm: p.paperMm, copies: p.copies });

function browserPrint(job, settings, model) {
  const id = addLog({ kind: job.kind, title: job.title, printerName: t('print.browser'), target: null, status: 'fallback', model });
  try {
    printModelHtml(model, settings.paperMm);
  } catch (e) {
    updateLog(id, { status: 'failed', error: e.message });
  }
}

// ---- jobs -------------------------------------------------------------------------------------------------

async function run(job) {
  const settings = getSettings();
  if (!isBridgeConfigured(settings)) {
    // Without a bridge only an explicit button press prints, through the browser; automatic prints stay silent.
    if (!job.auto) browserPrint(job, settings, job.build({ lang: settings.lang, paperMm: settings.paperMm }));
    return;
  }
  const printers = await printersFor(job.kind);
  let delivered = false;
  if (!printers.length) toast(t('print.noPrinter', { kind: t(`print.kind.${job.kind === 'report' ? 'receipt' : job.kind}`) }), 'error');
  for (const p of printers) {
    const model = job.build({ lang: p.lang, paperMm: p.paperMm });
    const id = addLog({ kind: job.kind, title: job.title, printerName: p.name, target: targetOf(p), status: 'pending', model });
    try {
      await sendToBridge(settings, p, model);
      updateLog(id, { status: 'ok' });
      delivered = true;
      toast(t('print.sent', { name: p.name }), 'success');
    } catch (e) {
      updateLog(id, { status: 'failed', error: e.message });
      toast(t('print.failed', { name: p.name, error: e.message }), 'error');
    }
  }
  if (!delivered && settings.fallback && BROWSER_FALLBACK_JOBS.has(job.kind)) {
    browserPrint(job, settings, job.build({ lang: settings.lang, paperMm: settings.paperMm }));
    toast(t('print.fallbackOpened'), 'info');
  }
}

/** job: { kind: receipt|report|label|bar|kitchen, title, build({ lang, paperMm }) -> model, auto? }. Never rejects. */
export function printJob(job) {
  return enqueue(() => run(job)).catch((e) => toast(t('print.failed', { name: t('print.title'), error: e.message }), 'error'));
}

/** Prints one log entry again, to the same printer it was meant for. */
export function reprint(id) {
  return enqueue(async () => {
    const entry = getLog().find((e) => e.id === id);
    if (!entry?.model) { toast(t('print.noModel'), 'error'); return; }
    const settings = getSettings();
    if (entry.target && isBridgeConfigured(settings)) {
      try {
        await sendToBridge(settings, entry.target, entry.model);
        updateLog(id, { status: 'ok', error: undefined, ts: Date.now() });
        toast(t('print.sent', { name: entry.printerName }), 'success');
        return;
      } catch (e) {
        updateLog(id, { status: 'failed', error: e.message });
        toast(t('print.failed', { name: entry.printerName, error: e.message }), 'error');
        return;
      }
    }
    printModelHtml(entry.model, entry.target?.paperMm ?? settings.paperMm);
  }).catch((e) => toast(e.message, 'error'));
}

/** Manager's "Test print" button: straight to that printer, no fallback, so a wiring problem is visible. */
export function testPrint(printer) {
  return enqueue(async () => {
    const settings = getSettings();
    if (!isBridgeConfigured(settings)) { toast(t('print.needSettings'), 'error'); return; }
    const model = testModel({ printerName: printer.name, kind: printer.kind, paperMm: printer.paperMm }, { lang: printer.lang });
    const id = addLog({ kind: 'test', title: model.title, printerName: printer.name, target: targetOf(printer), status: 'pending', model });
    try {
      await sendToBridge(settings, { ...targetOf(printer), copies: 1 }, model);
      updateLog(id, { status: 'ok' });
      toast(t('print.sent', { name: printer.name }), 'success');
    } catch (e) {
      updateLog(id, { status: 'failed', error: e.message });
      toast(t('print.failed', { name: printer.name, error: e.message }), 'error');
    }
  }).catch((e) => toast(e.message, 'error'));
}
