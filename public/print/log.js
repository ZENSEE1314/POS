// Local print log (last 100 jobs) so a failed or lost slip can be reprinted without touching the sale.
import { readStore, writeStore } from '../session.js';

const LOG_KEY = 'nightpos.print.log';
const PRINTERS_KEY = 'nightpos.print.printers';
export const MAX_LOG_ENTRIES = 100;

export function getLog() {
  try {
    const list = JSON.parse(readStore(localStorage, LOG_KEY) ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveLog(list) {
  let keep = list.slice(0, MAX_LOG_ENTRIES);
  // Models are the bulky part; if storage is full, shed them from the oldest entries first.
  for (let drop = 0; drop <= keep.length; drop += 10) {
    const trimmed = keep.map((e, i) => (i >= keep.length - drop ? { ...e, model: undefined } : e));
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(trimmed));
      return;
    } catch { /* quota or blocked storage: try again with fewer models */ }
  }
}

let seq = 0;

/** Newest first. Returns the entry id. */
export function addLog(entry) {
  const id = `${Date.now().toString(36)}-${(seq++).toString(36)}`;
  saveLog([{ id, ts: Date.now(), ...entry }, ...getLog()]);
  return id;
}

export function updateLog(id, patch) {
  saveLog(getLog().map((e) => (e.id === id ? { ...e, ...patch } : e)));
}

/** Print slips and the printer list cache belong to the signed-in staff; the device settings do not. */
export function clearPrintData() {
  writeStore(localStorage, LOG_KEY, null);
  writeStore(localStorage, PRINTERS_KEY, null);
}

export const printersCacheKey = PRINTERS_KEY;
