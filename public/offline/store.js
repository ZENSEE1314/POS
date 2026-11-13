// Local data layer: IndexedDB with a promise API. If IndexedDB is missing or blocked (private mode, policy) every call
// silently falls back to an in-memory copy, so the app keeps working online and only loses persistence across reloads.
//
//   kv    out-of-line keys: cached GET responses ("cache:..."), small metadata
//   ops   the pending/attention operation queue, auto-increment key `seq` (= strict FIFO order)
//   bills local working copies of bills touched while offline, keyed by `ref`
const DB_NAME = 'nightpos-offline';
const DB_VERSION = 1;
const STORES = ['kv', 'ops', 'bills'];
const CHANNEL = 'nightpos-offline';

let dbPromise = null;
let persistent = true;
const memory = { kv: new Map(), ops: new Map(), bills: new Map(), seq: 0 };
const listeners = new Set();
let channel = null;
try { channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null; } catch { channel = null; }
if (channel) {
  channel.onmessage = () => listeners.forEach((fn) => fn(true));
  channel.unref?.(); // Node only: an open channel must not keep a test process alive
}

const clone = (v) => (v === undefined ? v : structuredClone(v));

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') throw new Error('no indexedDB');
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('kv');
        db.createObjectStore('ops', { keyPath: 'seq', autoIncrement: true });
        db.createObjectStore('bills', { keyPath: 'ref' });
      };
      req.onsuccess = () => {
        req.result.onversionchange = () => req.result.close();
        resolve(req.result);
      };
      req.onerror = () => { persistent = false; resolve(null); };
      req.onblocked = () => { persistent = false; resolve(null); };
    } catch {
      persistent = false;
      resolve(null);
    }
  });
  return dbPromise;
}

const wrap = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

function idbApi(tx) {
  return {
    get: (name, key) => wrap(tx.objectStore(name).get(key)),
    put: (name, value, key) => wrap(name === 'kv' ? tx.objectStore(name).put(value, key) : tx.objectStore(name).put(value)),
    del: (name, key) => wrap(tx.objectStore(name).delete(key)),
    all: (name) => wrap(tx.objectStore(name).getAll()),
    keys: (name) => wrap(tx.objectStore(name).getAllKeys()),
    clear: (name) => wrap(tx.objectStore(name).clear()),
  };
}

const memoryApi = {
  async get(name, key) { return clone(memory[name].get(key)); },
  async put(name, value, key) {
    let k = key;
    if (name === 'ops') { value = { ...value, seq: value.seq ?? ++memory.seq }; k = value.seq; } else if (name === 'bills') k = value.ref;
    memory[name].set(k, clone(value));
    return k;
  },
  async del(name, key) { memory[name].delete(key); },
  async all(name) { return [...memory[name].entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => clone(v)); },
  async keys(name) { return [...memory[name].keys()].sort(); },
  async clear(name) { memory[name].clear(); },
};

/** Runs fn(api) in one atomic IndexedDB transaction (read-modify-write safe across tabs). Do not await non-IndexedDB work inside fn. */
export async function transact(names, mode, fn) {
  const db = await openDb();
  if (!db) return fn(memoryApi);
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(names, mode); } catch (e) { reject(e); return; }
    let out;
    tx.oncomplete = () => resolve(out);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    tx.onerror = () => reject(tx.error);
    Promise.resolve().then(() => fn(idbApi(tx))).then((v) => { out = v; }, (e) => { try { tx.abort(); } catch { /* already finished */ } reject(e); });
  });
}

/** Every read helper swallows storage failures: the offline layer must never break the online app. */
async function safely(fallback, fn) {
  try { return await fn(); } catch { return fallback; }
}

export const isPersistent = async () => { await openDb(); return persistent; };

export const getValue = (key) => safely(undefined, () => transact(['kv'], 'readonly', (s) => s.get('kv', key)));
export const setValue = (key, value) => safely(undefined, () => transact(['kv'], 'readwrite', (s) => s.put('kv', value, key)));
export const deleteValue = (key) => safely(undefined, () => transact(['kv'], 'readwrite', (s) => s.del('kv', key)));

/** Deletes cached responses under `prefix` whose key is not in `keep`. */
export const pruneValues = (prefix, keep) => safely(undefined, () => transact(['kv'], 'readwrite', async (s) => {
  for (const key of await s.keys('kv')) if (typeof key === 'string' && key.startsWith(prefix) && !keep.has(key)) await s.del('kv', key);
}));

export const listOps = () => safely([], () => transact(['ops'], 'readonly', (s) => s.all('ops')));
export const listBills = () => safely([], () => transact(['bills'], 'readonly', (s) => s.all('bills')));
export const getLocalBill = (ref) => safely(undefined, () => transact(['bills'], 'readonly', (s) => s.get('bills', ref)));

/** Removes everything this device keeps for offline use (logout). */
export const clearAll = () => safely(undefined, async () => {
  await transact(STORES, 'readwrite', async (s) => { for (const name of STORES) await s.clear(name); });
  notifyChanged();
});

export function notifyChanged() {
  listeners.forEach((fn) => fn(false));
  try { channel?.postMessage('changed'); } catch { /* channel closed */ }
}

/** Called with `remote` = true when another tab changed the queue or the local bills, false for this tab's own changes. Returns an unsubscribe function. */
export function onChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
