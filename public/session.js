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

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(method, path, body) {
  const headers = {};
  if (app.token) headers.Authorization = `Bearer ${app.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError('network error', 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && app.token) onUnauthorized();
    throw new ApiError(data?.error ?? res.statusText, res.status);
  }
  return data;
}

export const get = (path) => api('GET', path);
export const post = (path, body = {}) => api('POST', path, body);
export const patch = (path, body) => api('PATCH', path, body);
export const del = (path) => api('DELETE', path);
