// App shell: bootstrap, login/signup, header, role-aware navigation, language toggle.
import { t, getLang, setLang, loadLang, LANGS, errorText } from './i18n.js';
import { app, can, api, get, post, loadToken, saveToken, setUnauthorizedHandler, readStore, writeStore } from './session.js';
import { html, setHtml } from './util.js';
import { delegate, formDialog, toast, notifyError, pressed } from './ui.js';
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

const COMPANY_KEY = 'nightpos.company';
const DEFAULT_VIEW = 'floor';
const SIGNUP_PIN_MIN = 6;
const TABS = [
  { id: 'floor', mount: mountFloor },
  { id: 'bookings', mount: mountBookings },
  { id: 'stash', mount: mountStash },
  { id: 'members', mount: mountMembers },
  { id: 'reports', mount: mountReports, perm: 'audit.read' },
  { id: 'admin', mount: mountAdmin, perm: 'admin.write' },
  { id: 'hq', mount: mountHq, perm: 'hq.read' },
];

const appEl = document.getElementById('app');
let unmountView = null;
let stores = [];

const visibleTabs = () => TABS.filter((tab) => !tab.perm || can(tab.perm));
const currentTabId = () => {
  const id = location.hash.slice(1);
  return visibleTabs().some((x) => x.id === id) ? id : DEFAULT_VIEW;
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
  Object.assign(app, { actor: me.actor, store: me.store, company: me.company });
  stores = can('hq.read') ? await get('/api/hq/stores') : [];
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
        <p class="chrome__user"><strong>${actor.name}</strong> <span class="badge badge--neutral">${t(`role.${actor.role}`)}</span></p>
        ${langToggle()}
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
  mountCurrentView();
}

async function enterApp() {
  resetFloorState();
  await loadSession();
  renderShell();
}

function showLogin(prefill) {
  Object.assign(app, { actor: null, store: null, company: null });
  renderLogin({ company: readStore(localStorage, COMPANY_KEY) ?? '', ...prefill });
}

async function logout() {
  try { await api('POST', '/api/logout', {}); } catch { /* token may already be invalid */ }
  saveToken(null);
  resetFloorState();
  showLogin();
}

async function switchStore(el) {
  const r = await post('/api/switch-store', { storeId: Number(el.value) });
  app.actor = r.actor;
  resetFloorState();
  await loadSession();
  renderShell();
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
  delegate(document.body, {
    click: { lang: changeLang, logout, signup: openSignup },
    change: { switchStore },
    submit: { login: submitLogin },
  });

  try { Object.assign(app.config, await get('/api/config')); } catch (e) { notifyError(e); }
  loadToken();
  if (!app.token) { showLogin(); return; }
  try { await enterApp(); } catch { saveToken(null); showLogin(); }
}

boot();
