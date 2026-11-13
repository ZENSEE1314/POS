// Customer app plumbing: safe HTML templating, formatting, the API client and small UI primitives.
import { t, getLang } from './i18n.js';

const TOKEN_KEY = 'nightpos.guestToken';
const FEN_PER_YUAN = 100;
const MILLI_PER_BOTTLE = 1000;
const TOAST_MS = 4500;
const LOCALES = { en: 'en-GB', zh: 'zh-CN' };
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

class SafeHtml {
  constructor(text) { this.text = text; }

  toString() { return this.text; }
}
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
const render = (v) => {
  if (v instanceof SafeHtml) return v.text;
  if (Array.isArray(v)) return v.map(render).join('');
  if (v === false || v === null || v === undefined) return '';
  return esc(v);
};
/** Tagged template: interpolations are escaped unless they are html`` themselves (or raw()). */
export const html = (strings, ...values) => new SafeHtml(strings.reduce((out, s, i) => out + s + (i < values.length ? render(values[i]) : ''), ''));
export const raw = (text) => new SafeHtml(text);
export const setHtml = (el, safe) => { el.innerHTML = safe.text; };

const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtMoney = (fen) => `¥${money.format(Number(fen ?? 0) / FEN_PER_YUAN)}`;
export const fmtBottles = (milli) => (Number(milli) / MILLI_PER_BOTTLE).toFixed(milli % 100 === 0 ? 1 : 2);
export const fmtDateTime = (ms) => new Intl.DateTimeFormat(LOCALES[getLang()], { month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
export const fmtDate = (ms) => new Intl.DateTimeFormat(LOCALES[getLang()], { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

/** "88.5" -> 8850 fen; NaN when it is not a positive amount with up to 2 decimals. */
export function parseFen(text) {
  const s = String(text ?? '').trim().replace(/[¥,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const fen = Math.round(Number(s) * FEN_PER_YUAN);
  return fen > 0 ? fen : NaN;
}

export const productName = (p) => (getLang() === 'en' && p.nameEn ? p.nameEn : p.name);
export const productSubName = (p) => (getLang() === 'en' ? (p.nameEn ? p.name : '') : p.nameEn || '');
export const isWechatBrowser = () => /MicroMessenger/i.test(navigator.userAgent);

// ---------- session + API ----------

export const session = { token: null, customer: null, config: { login: {}, payments: {}, mock: false } };

export function loadToken() {
  try { session.token = localStorage.getItem(TOKEN_KEY); } catch { session.token = null; }
}

export function saveToken(token) {
  session.token = token;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode: the session lasts as long as the tab */ }
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(method, path, body) {
  const headers = {};
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(t('err.network'), 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401 && session.token && !path.startsWith('/api/guest/login') && !path.startsWith('/api/guest/me/phone')) {
      saveToken(null);
      session.customer = null;
    }
    throw new ApiError(data?.error ?? t('err.generic'), res.status);
  }
  return data;
}
export const get = (path) => api('GET', path);
export const post = (path, body = {}) => api('POST', path, body);
export const patch = (path, body) => api('PATCH', path, body);

// ---------- UI primitives ----------

/** A modal sheet sits in the top layer above #toasts, so while one is open its own toast host is used. */
function toastHost() {
  const dlg = document.querySelector('dialog[open]');
  if (!dlg) return document.getElementById('toasts');
  let host = dlg.querySelector('.g-toasts');
  if (!host) {
    host = document.createElement('div');
    host.className = 'g-toasts';
    host.setAttribute('role', 'status');
    dlg.append(host);
  }
  return host;
}

export function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `g-toast g-toast--${kind}`;
  el.textContent = message;
  toastHost().append(el);
  setTimeout(() => el.remove(), TOAST_MS);
}
export const toastError = (e) => toast(e?.message || t('err.generic'), 'error');

/**
 * Bottom sheet dialog. `build(inner, close)` fills it and wires its own events. Resolves with whatever is passed to
 * close(value); dismissing (Esc, backdrop, close button) resolves undefined.
 */
export function sheet(title, build) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'g-sheet';
    dlg.setAttribute('aria-labelledby', 'sheet-title');
    setHtml(dlg, html`<div class="g-sheet__inner"><div class="g-sheet__head"><h2 id="sheet-title" class="g-sheet__title">${title}</h2>
      <button type="button" class="g-btn g-btn--small" data-close>${t('common.close')}</button></div><div data-body></div></div>`);
    let value;
    const close = (v) => { value = v; dlg.close(); };
    dlg.addEventListener('close', () => { dlg.remove(); resolve(value); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
    dlg.querySelector('[data-close]').addEventListener('click', () => close());
    document.body.append(dlg);
    build(dlg.querySelector('[data-body]'), close, dlg);
    dlg.showModal();
  });
}

/** Wraps an async handler: disables the button while it runs and shows failures as a toast. */
export function busy(button, fn) {
  return async (...args) => {
    if (button) button.disabled = true;
    try {
      return await fn(...args);
    } catch (e) {
      toastError(e);
      return undefined;
    } finally {
      if (button) button.disabled = false;
    }
  };
}

export const skeleton = (n = 3) => html`<div role="status" aria-label="${t('common.loading')}">${Array.from({ length: n }, () => html`<div class="g-skel"></div>`)}</div>`;
