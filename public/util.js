// Escaping, formatting and small pure helpers shared by every view.
import { getLang } from './i18n.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const FEN_PER_YUAN = 100;
const MILLI_PER_BOTTLE = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOCALES = { en: 'en-GB', zh: 'zh-CN' };

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

class SafeHtml {
  constructor(text) { this.text = text; }

  toString() { return this.text; }
}

const renderValue = (v) => {
  if (v instanceof SafeHtml) return v.text;
  if (Array.isArray(v)) return v.map(renderValue).join('');
  if (v === false || v === null || v === undefined) return '';
  return esc(v);
};

/** Tagged template: every interpolation is escaped unless it is itself the result of html`` (or raw()). */
export const html = (strings, ...values) =>
  new SafeHtml(strings.reduce((out, s, i) => out + s + (i < values.length ? renderValue(values[i]) : ''), ''));

export const raw = (text) => new SafeHtml(text);

export const setHtml = (el, safe) => { el.innerHTML = safe.text; };

const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fmtMoney(fen) {
  const n = Number(fen ?? 0) / FEN_PER_YUAN;
  return `${n < 0 ? '-' : ''}¥${money.format(Math.abs(n))}`;
}

/** Parses a yuan amount typed by a human into integer fen. Returns null when empty, NaN when invalid. */
export function parseFen(text) {
  const s = String(text ?? '').trim().replace(/[¥,\s]/g, '');
  if (s === '') return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(Number(s) * FEN_PER_YUAN);
}

/** Bottles (decimal) to milli-bottles. */
export function parseMilli(text) {
  const s = String(text ?? '').trim();
  if (!/^\d+(\.\d{1,3})?$/.test(s)) return NaN;
  return Math.round(Number(s) * MILLI_PER_BOTTLE);
}

export const fmtBottles = (milli) => (Number(milli) / MILLI_PER_BOTTLE).toFixed(milli % 100 === 0 ? 1 : 2);

const dateTime = (opts) => (ms) => (ms ? new Intl.DateTimeFormat(LOCALES[getLang()], opts).format(new Date(Number(ms))) : '');
export const fmtDateTime = (ms) => dateTime({ month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })(ms);
export const fmtDate = (ms) => dateTime({ year: 'numeric', month: '2-digit', day: '2-digit' })(ms);
export const fmtTime = (ms) => dateTime({ hour: '2-digit', minute: '2-digit', hour12: false })(ms);

const pad = (n) => String(n).padStart(2, '0');
export const toDateInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const toDateTimeInput = (ms) => `${toDateInput(ms)}T${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;

export function startOfDay(ms = Date.now()) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** [from, to) in ms for a yyyy-mm-dd input value covering whole local days. */
export function dayRange(fromValue, toValue = fromValue) {
  const from = new Date(`${fromValue}T00:00:00`).getTime();
  const to = new Date(`${toValue}T00:00:00`).getTime() + DAY_MS;
  return { from, to };
}

export const daysAgo = (days) => startOfDay() - days * DAY_MS;
export const DAY = DAY_MS;

export const productName = (p) => (getLang() === 'en' && p.name_en ? p.name_en : p.name);

export const byId = (list) => new Map(list.map((x) => [x.id, x]));

export const toYuanInput = (fen) => (Number(fen) / FEN_PER_YUAN).toFixed(2);
