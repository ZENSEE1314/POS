// App shell: bootstrap, login/signup, header, role-aware navigation, language toggle.
import { t, getLang, setLang, loadLang, LANGS, errorText } from './i18n.js';
import { app, can, api, get, post, loadToken, saveToken, setUnauthorizedHandler, readStore, writeStore } from './session.js';
import { html, setHtml } from './util.js';
import { delegate, formDialog, confirmDialog, toast, notifyError, pressed } from './ui.js';
import { startSky } from './starfield.js';
import { setNavigator } from './nav.js';
import { resetFloorState } from './floor-state.js';
import { mountFloor } from './floor.js';
import { mountBookings } from './bookings.js';
import { mountStash } from './stash.js';
import { mountMembers } from './members.js';
import { mountReports } from './reports.js';
import { mountAdmin } from './admin.js';
import { mountHq } from './hq.js';
import { mountGuestOrders, GUEST_ORDERS_CHANGED } from './guest-orders.js';
import { mountCounter } from './counter.js';
import { mountStock } from './stock.js';
import { hasModule, BUSINESS_TYPES, BUSINESS_CHANGED } from './business.js';
import { initOffline, syncPillHtml, mountSyncPill, openSyncPanel, syncState, syncNow, forgetEverything, offlineSignedIn } from './offline/index.js';
import { openPrintDialog } from './print/dialog.js';
import { clearPrintData } from './print/log.js';

const COMPANY_KEY = 'nightpos.company';
const SIGNUP_PIN_MIN = 6;
// `module`: the tab only shows when the company has that module switched on.
const TABS = [
  { id: 'floor', mount: mountFloor, module: 'tables' },
  { id: 'counter', mount: mountCounter, perm: 'order.add', module: 'counter' },
  { id: 'orders', mount: mountGuestOrders, perm: 'order.add', module: 'guestApp' },
  { id: 'bookings', mount: mountBookings, module: 'bookings' },
  { id: 'stash', mount: mountStash, module: 'stash' },
  { id: 'stock', mount: mountStock, perm: 'admin.write', module: 'purchasing' },
  { id: 'members', mount: mountMembers },
  { id: 'reports', mount: mountReports, perm: 'audit.read' },
  { id: 'admin', mount: mountAdmin, perm: 'admin.write' },
  { id: 'hq', mount: mountHq, perm: 'hq.read' },
];

const appEl = document.getElementById('app');
let unmountView = null;
let unmountSyncPill = null;
let stores = [];

const visibleTabs = () => TABS.filter((tab) => (!tab.perm || can(tab.perm)) && (!tab.module || hasModule(tab.module)));
const currentTabId = () => {
  const id = location.hash.slice(1);
  const tabs = visibleTabs();
  return tabs.some((x) => x.id === id) ? id : tabs[0].id;
};

const langToggle = () => html`<div class="lang" role="group" aria-label="${t('lang.label')}">
  ${LANGS.map((l) => html`<button type="button" class="lang__btn" lang="${l === 'zh' ? 'zh-CN' : 'en'}" data-action="lang" data-lang="${l}" aria-pressed="${pressed(getLang() === l)}">${t(`lang.${l}`)}</button>`)}
</div>`;

// ---------- login ----------

function renderLogin(prefill = {}) {
  unmountView?.();
  unmountView = null;
  setHtml(appEl, html`<main class="login" id="main">
    <div class="login__lang">${langToggle()}</div>
    <section class="login__card panel" aria-labelledby="login-title">
      <p class="login__eyebrow">${t('app.tagline')}</p>
      <h1 id="login-title" class="login__title">${t('app.name')}</h1>
      <form data-form="login" novalidate>
        <div class="field"><label for="company">${t('login.company')}</label>
          <input id="company" name="company" required autocomplete="organization" autocapitalize="none" spellcheck="false" value="${prefill.company ?? ''}"></div>
        <div class="field"><label for="username">${t('login.username')}</label>
          <input id="username" name="username" required autocomplete="username" autocapitalize="none" spellcheck="false" value="${prefill.username ?? ''}"></div>
        <div class="field"><label for="pin">${t('login.pin')}</label>
          <input id="pin" name="pin" type="password" inputmode="numeric" required autocomplete="current-password"></div>
        <p id="login-error" class="form-error" role="alert" hidden></p>
        <button type="submit" class="btn btn--primary btn--block">${t('login.submit')}</button>
      </form>
      ${app.config.signupOpen && html`<p class="login__alt"><button type="button" class="link" data-action="signup">${t('login.createCompany')}</button></p>`}
    </section></main>`);
  document.getElementById(prefill.company ? 'pin' : 'company').focus();
}

async function loginWith(company, username, pin) {
  const r = await post('/api/login', { company, username, pin });
  saveToken(r.token);
  app.actor = r.actor;
  writeStore(localStorage, COMPANY_KEY, company);
  await enterApp();
}

async function submitLogin(form) {
  const data = new FormData(form);
  const errorEl = document.getElementById('login-error');
  const required = ['company', 'username', 'pin'].some((k) => !String(data.get(k)).trim());
  errorEl.hidden = !required;
  if (required) { errorEl.textContent = t('login.required'); return; }
  const button = form.querySelector('[type=submit]');
  button.disabled = true;
  try {
    await loginWith(String(data.get('company')).trim(), String(data.get('username')).trim(), String(data.get('pin')).trim());
  } catch (e) {
    errorEl.textContent = errorText(e);
    errorEl.hidden = false;
    button.disabled = false;
  }
}

const openSignup = () => formDialog({
  title: t('signup.title'),
  intro: t('signup.intro'),
  fields: [
    { name: 'name', label: t('signup.company'), required: true },
    { name: 'businessType', label: t('biz.signupType'), type: 'select', value: 'bar', options: BUSINESS_TYPES.map((x) => ({ value: x, label: t(`biz.type.${x}`) })) },
    { name: 'code', label: t('signup.code'), required: true, hint: t('signup.codeHint') },
    { name: 'storeName', label: t('signup.store'), required: true },
    { name: 'ownerName', label: t('signup.ownerName'), required: true },
    { name: 'ownerUsername', label: t('login.username'), required: true },
    { name: 'ownerPin', label: t('login.pin'), type: 'pin', required: true, min: SIGNUP_PIN_MIN, hint: t('signup.pinHint') },
  ],
  submit: 'signup.submit',
  onSubmit: async (v) => {
    await post('/api/signup', v);
    await loginWith(v.code, v.ownerUsername, v.ownerPin);
  },
});

// ---------- shell ----------

async function loadSession() {
  const me = await get('/api/me');
  Object.assign(app, { actor: me.actor, store: me.store, company: me.company, business: me.business });
  // Head-office data is online-only; an owner who reloads while offline still gets the floor, just without the store switcher.
  stores = can('hq.read') ? await get('/api/hq/stores').catch((e) => { if (e.status === 0) return []; throw e; }) : [];
}

function headerHtml() {
  const { actor, store, company } = app;
  const storeControl = stores.length > 1
    ? html`<div class="field field--inline"><label for="store-switch">${t('shell.store')}</label>
        <select id="store-switch" data-action="switchStore">${stores.filter((s) => s.active).map((s) => html`<option value="${s.id}" ${s.id === actor.storeId ? 'selected' : ''}>${s.name}</option>`)}</select></div>`
    : html`<span class="chrome__store">${store.name}</span>`;
  return html`<a class="skip" href="#main">${t('a11y.skip')}</a>
    <header class="chrome">
      <div class="chrome__brand"><span class="chrome__logo" aria-hidden="true">✦</span>
        <div><p class="chrome__name">${t('app.name')}</p><p class="chrome__company">${company.name}</p></div></div>
      <div class="chrome__tools">
        ${storeControl}
        ${syncPillHtml()}
        <p class="chrome__user"><strong>${actor.name}</strong> <span class="badge badge--neutral">${t(`role.${actor.role}`)}</span></p>
        ${langToggle()}
        <button type="button" class="btn btn--small btn--ghost" data-action="printSettings">${t('print.header')}</button>
        <button type="button" class="btn btn--small btn--ghost" data-action="logout">${t('shell.logout')}</button>
      </div>
    </header>
    <nav class="tabs" aria-label="${t('shell.nav')}">${visibleTabs().map((tab) =>
      html`<a class="tab" href="#${tab.id}" data-tab="${tab.id}">${t(`nav.${tab.id}`)}</a>`)}</nav>
    <main id="main" class="view" tabindex="-1"></main>`;
}

function mountCurrentView() {
  unmountView?.();
  const id = currentTabId();
  document.querySelectorAll('.tab').forEach((a) => {
    if (a.dataset.tab === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  // A fresh node per mount drops the previous view's delegated listeners.
  const stale = document.getElementById('main');
  const main = stale.cloneNode(false);
  stale.replaceWith(main);
  unmountView = visibleTabs().find((x) => x.id === id).mount(main) ?? null;
}

function renderShell() {
  unmountView?.();
  unmountView = null;
  setHtml(appEl, headerHtml());
  unmountSyncPill?.();
  unmountSyncPill = mountSyncPill();
  mountCurrentView();
  startOrderBadge();
}

let stopOrderBadge = null;
const ORDER_BADGE_MS = 20_000;

/** Count of guest orders waiting, on the "Guest orders" tab, so staff on any view notice new QR orders. */
function startOrderBadge() {
  stopOrderBadge?.();
  stopOrderBadge = null;
  if (!can('order.add') || !hasModule('guestApp')) return;
  const tick = async () => {
    const tab = document.querySelector('.tab[data-tab=orders]');
    if (!tab || document.visibilityState !== 'visible' || !syncState().online) return;
    try {
      const { pending } = await get('/api/guest-orders/count');
      let count = tab.querySelector('.tab__count');
      if (!pending) { count?.remove(); return; }
      if (!count) {
        count = document.createElement('span');
        count.className = 'tab__count';
        tab.append(count);
      }
      count.textContent = String(pending);
      count.setAttribute('aria-label', t('guestOrders.badge', { n: pending }));
    } catch { /* offline or signed out: the badge keeps its last value */ }
  };
  void tick();
  const timer = setInterval(tick, ORDER_BADGE_MS);
  window.addEventListener(GUEST_ORDERS_CHANGED, tick);
  stopOrderBadge = () => {
    clearInterval(timer);
    window.removeEventListener(GUEST_ORDERS_CHANGED, tick);
  };
}

async function enterApp() {
  resetFloorState();
  await loadSession();
  renderShell();
  void offlineSignedIn();
}

function showLogin(prefill) {
  stopOrderBadge?.();
  stopOrderBadge = null;
  Object.assign(app, { actor: null, store: null, company: null, business: null });
  renderLogin({ company: readStore(localStorage, COMPANY_KEY) ?? '', ...prefill });
}

async function logout() {
  // Signing out wipes this device's offline data, so unsynced sales must not vanish silently.
  await syncNow();
  const s = syncState();
  const unsynced = s.pending + s.attention + s.foreign;
  if (unsynced > 0 && !await confirmDialog({ title: t('shell.logout'), message: t('offline.logoutPending', { n: unsynced }), submit: 'shell.logout', danger: true })) return;
  try { await api('POST', '/api/logout', {}); } catch { /* token may already be invalid, or we are offline */ }
  await forgetEverything();
  saveToken(null);
  clearPrintData();
  resetFloorState();
  showLogin();
}

async function switchStore(el) {
  const r = await post('/api/switch-store', { storeId: Number(el.value) });
  app.actor = r.actor;
  resetFloorState();
  await loadSession();
  renderShell();
  void offlineSignedIn();
}

function changeLang(el) {
  setLang(el.dataset.lang);
  document.title = t('app.title');
  if (app.actor) { renderShell(); return; }
  const form = document.querySelector('form[data-form=login]');
  renderLogin(form ? { company: form.elements.company.value, username: form.elements.username.value } : {});
}

async function boot() {
  loadLang();
  initOffline();
  document.title = t('app.title');
  startSky(document.getElementById('sky'));
  setNavigator((view) => { location.hash = view; });
  setUnauthorizedHandler(() => {
    saveToken(null);
    resetFloorState();
    showLogin();
    toast(t('login.expired'), 'error');
  });
  window.addEventListener('hashchange', () => { if (app.actor) mountCurrentView(); });
  // Modules changed in Admin: rebuild the tabs (a tab that just disappeared falls back to the first one).
  window.addEventListener(BUSINESS_CHANGED, () => { if (app.actor) renderShell(); });
  delegate(document.body, {
    click: { lang: changeLang, logout, signup: openSignup, syncPanel: openSyncPanel, printSettings: openPrintDialog },
    change: { switchStore },
    submit: { login: submitLogin },
  });

  try { Object.assign(app.config, await get('/api/config')); } catch (e) { notifyError(e); }
  loadToken();
  if (!app.token) { showLogin(); return; }
  try {
    await enterApp();
  } catch (e) {
    // Offline with nothing cached for this session: keep the token so a reload with a connection signs straight back in.
    if (e.status !== 0) saveToken(null);
    showLogin();
    if (e.status === 0) notifyError(e);
  }
}

boot();
