// Customer app entry: boots the session and routes /g/... addresses to screens.
//   /g/                              enter a venue code
//   /g/<company>                     venue home (choose a location)
//   /g/<company>/account             my account at this company
//   /g/<company>/rewards|spin|events|games|pets|support   venue-wide extras
//   /g/<company>/<store>             location home
//   /g/<company>/<store>/menu        browse the menu
//   /g/<company>/<store>/book        book a table
//   /g/<company>/<store>/t/<token>   the table QR: order, my orders, bill and pay
import { t, getLang, setLang, loadLang, LANGS } from './i18n.js';
import { html, setHtml, session, get, loadToken, toastError, skeleton } from './core.js';
import { finishProviderLogin, loadCustomer } from './login.js';
import { mountMenuBrowse, mountTable, waitForPayment } from './table.js';
import { mountAccount, mountBooking } from './account.js';
import { captureReferral, claimPendingReferral, mountEvents, mountPets, mountRewards, mountSpin, mountSupport } from './extras.js';
import { mountGames } from './games.js';

/** Venue-wide screens; these words are never store codes. */
const EXTRAS = {
  rewards: (root, ctx) => mountRewards(root, ctx),
  spin: (root, ctx) => mountSpin(root, ctx),
  events: (root, ctx) => mountEvents(root, ctx),
  games: (root) => mountGames(root),
  pets: (root, ctx) => mountPets(root, ctx),
  support: (root, ctx) => mountSupport(root, ctx),
};

const appEl = document.getElementById('app');
const venueCache = new Map();
let cleanup = null;
let header = { title: '', subtitle: '', company: '' };

const enc = encodeURIComponent;
const parts = () => location.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent);

export function navigate(path) {
  history.pushState(null, '', path);
  void route();
}

async function venue(company) {
  if (!venueCache.has(company)) venueCache.set(company, get(`/api/guest/venue/${enc(company)}`));
  try {
    return await venueCache.get(company);
  } catch (e) {
    venueCache.delete(company);
    throw e;
  }
}

function frame() {
  const { title, subtitle, company } = header;
  setHtml(appEl, html`<header class="g-top">
      <a class="g-brand" href="${company ? `/g/${enc(company)}` : '/g/'}" data-link><span class="g-logo" aria-hidden="true">✦</span>
        <span><span class="g-brand__name">${title || t('app.name')}</span>${subtitle && html`<span class="g-brand__sub">${subtitle}</span>`}</span></a>
      <div class="g-top__tools">
        <div class="g-lang" role="group" aria-label="${t('lang.label')}">${LANGS.map((l) =>
          html`<button type="button" data-lang="${l}" aria-pressed="${String(getLang() === l)}" lang="${l === 'zh' ? 'zh-CN' : 'en'}">${t(`lang.${l}`)}</button>`)}</div>
        ${company && html`<a class="g-btn g-btn--small" href="/g/${enc(company)}/account" data-link aria-label="${t('venue.account')}">${session.customer ? '☺' : t('login.title')}</a>`}
      </div></header>
    <main id="main"></main>
    <p class="g-foot">${t('foot.text')}</p>`);
  return appEl.querySelector('#main');
}

const setHeader = (h) => {
  header = { ...header, ...h };
  const brand = appEl.querySelector('.g-brand');
  if (!brand) return;
  brand.querySelector('.g-brand__name').textContent = header.title || t('app.name');
};

function landing(root) {
  setHtml(root, html`<section class="g-hero"><p class="g-hero__eyebrow">${t('landing.eyebrow')}</p>
      <h1 class="g-hero__title">${t('landing.title')}</h1><p class="g-hero__text">${t('landing.text')}</p></section>
    <form class="g-card" novalidate><div class="g-field"><label for="vc">${t('landing.code')}</label>
      <input id="vc" name="code" autocapitalize="none" autocomplete="off" spellcheck="false" required></div>
      <p class="g-error" role="alert" hidden></p><button type="submit" class="g-btn g-btn--primary g-btn--block">${t('landing.go')}</button></form>`);
  const form = root.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = form.elements.code.value.trim();
    const errorEl = form.querySelector('.g-error');
    try {
      await venue(code);
      navigate(`/g/${enc(code)}`);
    } catch (err) {
      errorEl.textContent = err.status === 404 ? t('landing.notFound') : err.message;
      errorEl.hidden = false;
    }
  });
}

const tile = (href, mark, title, sub) => html`<a class="g-tile" href="${href}" data-link><span class="g-tile__mark" aria-hidden="true">${mark}</span>
  <span class="g-tile__text"><strong>${title}</strong><span>${sub}</span></span></a>`;

function venueHome(root, v) {
  const company = v.company.code;
  setHtml(root, html`<section class="g-hero"><p class="g-hero__eyebrow">${t('venue.welcome')}</p><h1 class="g-hero__title">${v.company.name}</h1>
      <p class="g-hero__text">${t('venue.scanHint')}</p></section>
    ${v.stores.length > 1 && html`<h2 class="g-cat">${t('venue.pickStore')}</h2>`}
    <div class="g-actions">${v.stores.length > 1
      ? v.stores.map((s) => tile(`/g/${enc(company)}/${enc(s.code)}`, '✦', s.name, t('venue.storeSub')))
      : storeTiles(company, v.stores[0])}</div>
    <div class="g-actions">${extraTiles(company, v.features ?? {})}</div>`);
}

const storeTiles = (company, s) => [
  tile(`/g/${enc(company)}/${enc(s.code)}/menu`, '≡', t('venue.menu'), t('venue.menuSub')),
  tile(`/g/${enc(company)}/${enc(s.code)}/book`, '◷', t('venue.book'), t('venue.bookSub')),
];

const extraTiles = (company, f) => [
  f.events && tile(`/g/${enc(company)}/events`, '★', t('venue.events'), t('venue.eventsSub')),
  f.loyalty && tile(`/g/${enc(company)}/rewards`, '◆', t('venue.rewards'), t('venue.rewardsSub')),
  f.games && tile(`/g/${enc(company)}/games`, '⚄', t('venue.games'), t('venue.gamesSub')),
  f.pets && tile(`/g/${enc(company)}/pets`, '🐾', t('venue.pets'), t('venue.petsSub')),
  f.support && tile(`/g/${enc(company)}/support`, '✉', t('venue.support'), t('venue.supportSub')),
  tile(`/g/${enc(company)}/account`, '☺', t('venue.account'), t('venue.accountSub')),
];

function storeHome(root, v, store) {
  setHtml(root, html`<section class="g-hero"><p class="g-hero__eyebrow">${v.company.name}</p><h1 class="g-hero__title">${store.name}</h1>
    <p class="g-hero__text">${t('venue.scanHint')}</p></section><div class="g-actions">${storeTiles(v.company.code, store)}</div>
    <div class="g-actions">${extraTiles(v.company.code, v.features ?? {})}</div>`);
}

async function route() {
  cleanup?.();
  cleanup = null;
  const [company, second, third, fourth] = parts();
  header = { title: '', subtitle: '', company: company ?? '' };
  let root = frame();
  try {
    if (!company) { landing(root); return; }
    setHtml(root, skeleton(4));
    if (second === undefined || second === 'account' || EXTRAS[second]) {
      const v = await venue(company);
      header = { title: v.company.name, subtitle: '', company: v.company.code };
      root = frame();
      void claimPendingReferral(v.company.code);
      if (second === 'account') await mountAccount(root, { company: v.company.code, navigate });
      else if (EXTRAS[second]) await EXTRAS[second](root, { company: v.company.code, stores: v.stores, navigate });
      else venueHome(root, v);
      return;
    }
    if (third === 't' && fourth) {
      setHtml(root, skeleton(5));
      cleanup = await mountTable(root, {
        token: fourth,
        onTitle: (h) => { header = { ...h }; const r = frame(); r.replaceWith(root); },
      });
      return;
    }
    const v = await venue(company);
    const store = v.stores.find((s) => s.code.toLowerCase() === second.toLowerCase());
    if (!store) throw Object.assign(new Error(t('venue.notFound')), { status: 404 });
    header = { title: store.name, subtitle: v.company.name, company: v.company.code };
    root = frame();
    if (third === 'menu') await mountMenuBrowse(root, { company: v.company.code, store: store.code });
    else if (third === 'book') await mountBooking(root, { company: v.company.code, store: store.code, stores: v.stores, navigate });
    else storeHome(root, v, store);
  } catch (e) {
    if (e.status === 404) setHtml(root, html`<p class="g-empty">${t('venue.notFound')}</p>`);
    else {
      setHtml(root, html`<div class="g-empty"><p>${e.message}</p><button type="button" class="g-btn g-gap" data-retry>${t('common.retry')}</button></div>`);
      root.querySelector('[data-retry]').addEventListener('click', () => route());
    }
  }
}

/** Alipay (WAP) sends the guest back here with ?paid=<outTradeNo>; confirm it before showing the bill. */
async function finishReturnedPayment() {
  const params = new URLSearchParams(location.search);
  const outTradeNo = params.get('paid');
  if (!outTradeNo) return;
  history.replaceState(null, '', location.pathname);
  if (session.customer) await waitForPayment(outTradeNo);
}

async function boot() {
  loadLang();
  document.title = t('app.name');
  loadToken();
  captureReferral(parts()[0]);
  appEl.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      navigate(a.getAttribute('href'));
      return;
    }
    const lang = e.target.closest('[data-lang]');
    if (lang) {
      setLang(lang.dataset.lang);
      document.title = t('app.name');
      void route();
    }
  });
  window.addEventListener('popstate', () => void route());
  try {
    session.config = await get('/api/guest/config');
  } catch (e) {
    toastError(e);
  }
  await finishProviderLogin();
  await loadCustomer();
  void finishReturnedPayment().then(() => { if (parts()[2] === 't') void route(); });
  await route();
}

boot();
