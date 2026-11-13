// Per-device print settings (this tablet / PC only). Kept in localStorage; every access is guarded because storage
// can be blocked, and printing must degrade rather than break the app.
import { readStore, writeStore } from '../session.js';

const SETTINGS_KEY = 'nightpos.print.settings';
export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:9101';
const LOCAL_URL = /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/;

export const DEFAULT_SETTINGS = {
  bridgeUrl: DEFAULT_BRIDGE_URL,
  token: '',
  autoReceipt: true,
  autoTickets: true,
  autoStash: true,
  autoShift: true,
  fallback: true,
  paperMm: 80,
  lang: 'both',
  footer: '',
};

export function getSettings() {
  let saved = {};
  try { saved = JSON.parse(readStore(localStorage, SETTINGS_KEY) ?? '{}') ?? {}; } catch { /* corrupt value: use defaults */ }
  return { ...DEFAULT_SETTINGS, ...saved };
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  writeStore(localStorage, SETTINGS_KEY, JSON.stringify(next));
  return next;
}

/** The bridge only ever lives on this machine; anything else would also be blocked by the page's CSP. */
export const isLocalBridgeUrl = (url) => LOCAL_URL.test(String(url ?? '').replace(/\/+$/, ''));

export const bridgeBase = (s) => String(s.bridgeUrl).replace(/\/+$/, '');

/** A device has opted into thermal printing once it has a token and a valid local bridge address. */
export const isBridgeConfigured = (s = getSettings()) => Boolean(s.token) && isLocalBridgeUrl(s.bridgeUrl);
