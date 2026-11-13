// Session state, role permissions (mirrors src/auth.ts; the server stays authoritative) and the API client.
const TOKEN_KEY = 'nightpos.token';
const MANAGERS = ['manager', 'owner'];

const PERMISSIONS = {
  'booking.create': ['host', 'cashier', 'manager', 'owner'],
  'table.open': ['host', 'waiter', 'cashier', 'manager', 'owner'],
  'order.add': ['waiter', 'cashier', 'manager', 'owner'],
  'order.gift': MANAGERS,
  'order.void': MANAGERS,
  'bill.discount': MANAGERS,
  'bill.settle': ['cashier', 'manager', 'owner'],
  'stash.write': ['waiter', 'cashier', 'manager', 'owner'],
  'payroll.read': ['finance', 'owner'],
  'admin.write': MANAGERS,
  'audit.read': ['manager', 'finance', 'owner'],
  'hq.read': ['finance', 'owner'],
  'hq.write': ['owner'],
};

export const app = { token: null, actor: null, store: null, company: null, config: { mock: false, signupOpen: false, payments: {} } };

export const can = (action) => Boolean(app.actor && PERMISSIONS[action].includes(app.actor.role));

export function readStore(storage, key) {
  try { return storage.getItem(key); } catch { return null; }
}

export function writeStore(storage, key, value) {
  try {
    if (value === null) storage.removeItem(key); else storage.setItem(key, value);
  } catch { /* storage may be blocked (private mode); the app keeps working in memory */ }
}

export const loadToken = () => { app.token = readStore(sessionStorage, TOKEN_KEY); };
export const saveToken = (token) => { app.token = token; writeStore(sessionStorage, TOKEN_KEY, token); };

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

// Offline layer (public/offline/): installed at boot by initOffline(). Without it the API client is a plain fetch wrapper.
let offline = null;
export const setOfflineHooks = (hooks) => { offline = hooks; };

// Calls the offline emulator answers get a short timeout so a dead link fails over quickly; everything else may be slow.
const FAILOVER_READ_MS = 4000;
const FAILOVER_WRITE_MS = 10000;
const DEFAULT_TIMEOUT_MS = 30000;

/** The real HTTP call. Rejects with status 0 when the server cannot be reached (network down, timeout). */
export async function networkRequest(method, path, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const headers = {};
  if (app.token) headers.Authorization = `Bearer ${app.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(path, { method, headers, signal: controller.signal, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError('network error', 0);
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && app.token) onUnauthorized();
    throw new ApiError(data?.error ?? res.statusText, res.status);
  }
  return data;
}

export async function api(method, path, body) {
  if (offline) {
    // Bills with queued offline work stay local even when the connection is back, so the queue is applied in order.
    if ((await offline.owns(method, path)) || (offline.isOffline() && offline.emulated(method, path))) return offline.emulate(method, path, body);
  }
  const failsOver = offline?.emulated(method, path);
  let data;
  try {
    data = await networkRequest(method, path, body, failsOver ? (method === 'GET' ? FAILOVER_READ_MS : FAILOVER_WRITE_MS) : DEFAULT_TIMEOUT_MS);
  } catch (e) {
    if (e.status !== 0 || !offline) throw e;
    offline.networkDown();
    return offline.emulate(method, path, body); // throws "needs connection" for anything it cannot serve
  }
  if (!offline) return data;
  offline.networkUp();
  return offline.after(method, path, data);
}

export const get = (path) => api('GET', path);
export const post = (path, body = {}) => api('POST', path, body);
export const patch = (path, body) => api('PATCH', path, body);
export const del = (path) => api('DELETE', path);
