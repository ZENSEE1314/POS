// Customer app entry: boots the session and routes /g/... addresses to screens.
//   /g/                              enter a venue code
//   /g/<company>                     member dashboard (points, wallet, quick actions, recent activity)
//   /g/<company>/me                  profile and settings (/account is the old address)
//   /g/<company>/wallet|history|activity|songs|invite      member pages
//   /g/<company>/rewards|spin|events|games|pets|support   venue-wide extras
//   /g/<company>/queue (or /g/<company>#queue, the staff QR) take a queue number and watch it
//   /g/<company>/<store>             the dashboard with that location chosen
//   /g/<company>/<store>/menu        browse the menu
//   /g/<company>/<store>/book        book a table
//   /g/<company>/<store>/t/<token>   the table QR: order, my orders, bill and pay
import { t, tOr, getLang, setLang, loadLang, LANGS } from './i18n.js';
import { html, raw, setHtml, session, get, loadToken, toastError, skeleton } from './core.js';
import { finishProviderLogin, loadCustomer } from './login.js';
import { mountMenuBrowse, mountTable, waitForPayment } from './table.js';
import { mountBooking } from './account.js';
import { captureReferral, claimPendingReferral, mountEvents, mountInvite, mountPets, mountRewards, mountSpin, mountSupport } from './extras.js';
import { mountGames } from './games.js';
import { mountShopOrder } from './shop.js';
import { mountActivity, mountBottles, mountDashboard, mountHistory, mountMe, mountSongs, mountWallet, pickedStore, rememberStore } from './dashboard.js';
import { applyTheme } from './themes.js';
import { mountQueue } from './queue.js';
import { icon } from './icons.js';

/** Venue-wide screens; these words are never store codes. */
const EXTRAS = {
  me: (root, ctx) => mountMe(root, ctx),
  account: (root, ctx) => mountMe(root, ctx),
  wallet: (root, ctx) => mountWallet(root, ctx),
  history: (root, ctx) => mountHistory(root, ctx),
  orders: (root, ctx) => mountHistory(root, ctx),
  activity: (root, ctx) => mountActivity(root, ctx),
  songs: (root, ctx) => mountSongs(root, ctx),
  bottles: (root, ctx) => mountBottles(root, ctx),
  invite: (root, ctx) => mountInvite(root, ctx),
  rewards: (root, ctx) => mountRewards(root, ctx),
  spin: (root, ctx) => mountSpin(root, ctx),
  events: (root, ctx) => mountEvents(root, ctx),
  games: (root, ctx) => mountGames(root, { spinHref: ctx.features.loyalty && ctx.features.spin ? `/g/${enc(ctx.company)}/spin` : null }),
  pets: (root, ctx) => mountPets(root, ctx),
  support: (root, ctx) => mountSupport(root, ctx),
  queue: (root, ctx) => mountQueue(root, ctx),
};
const QUEUE_HASH = '#queue';

const appEl = document.getElementById('app');
const venueCache = new Map();
let cleanup = null;
let header = { title: '', subtitle: '', company: '', nav: null, logo: null };
const MAX_TABS = 5;

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

/**
 * Bottom menu bar for a venue: Home, Order (or Menu), Rewards (or Games), History, Me, keeping only what the venue has
 * switched on. `store` is the location Order opens at.
 */
function tabsFor(v, store = pickedStore(v)) {
  const company = enc(v.company.code);
  const f = v.features ?? {};
  const at = store && `/g/${company}/${enc(store.code)}`;
  const optional = [
    store && (v.orderAhead ? { href: `${at}/order`, icon: 'bag', label: t('db.order') } : { href: `${at}/menu`, icon: 'menu', label: t('db.menu') }),
    f.loyalty ? { href: `/g/${company}/rewards`, icon: 'gift', label: t('venue.rewards') } : f.games && { href: `/g/${company}/games`, icon: 'dice', label: t('nav.games') },
    { href: `/g/${company}/history`, icon: 'clock', label: t('db.history') },
  ].filter(Boolean);
  return [
    { href: `/g/${company}`, icon: 'home', label: t('nav.home') },
    ...optional.slice(0, MAX_TABS - 2),
    { href: `/g/${company}/me`, icon: 'user', label: t('nav.account') },
  ];
}

const tabBar = (tabs) => html`<nav class="g-tabbar" aria-label="${t('nav.label')}">${tabs.map((tab) =>
  html`<a href="${tab.href}" data-link ${raw(location.pathname === tab.href ? 'aria-current="page"' : '')}>
    ${icon(tab.icon, 'g-tabbar__icon')}<span>${tab.label}</span></a>`)}</nav>`;

/** The company logo when it has one, else a neutral mark. */
const brandMark = (logo) => (logo
  ? html`<img class="g-logo g-logo--img" src="${logo}" alt="" width="36" height="36">`
  : html`<span class="g-logo" aria-hidden="true">${icon('store')}</span>`);

function frame() {
  const { title, subtitle, company, nav, logo } = header;
  appEl.classList.toggle('has-tabbar', Boolean(nav));
  setHtml(appEl, html`<header class="g-top">
      <a class="g-brand" href="${company ? `/g/${enc(company)}` : '/g/'}" data-link>${brandMark(logo)}
        <span><span class="g-brand__name">${title || t('app.name')}</span>${subtitle && html`<span class="g-brand__sub">${subtitle}</span>`}</span></a>
      <div class="g-top__tools">
        <div class="g-lang" role="group" aria-label="${t('lang.label')}">${LANGS.map((l) =>
          html`<button type="button" data-lang="${l}" aria-pressed="${String(getLang() === l)}" lang="${l === 'zh' ? 'zh-CN' : 'en'}">${t(`lang.${l}`)}</button>`)}</div>
        ${company && html`<a class="g-btn g-btn--small" href="/g/${enc(company)}/me" data-link aria-label="${t('venue.account')}">${session.customer ? icon('user') : t('login.title')}</a>`}
      </div></header>
    <main id="main"></main>
    <p class="g-foot">${t('foot.text')}</p>
    ${nav && tabBar(nav)}`);
  return appEl.querySelector('#main');
}

const setHeader = (h) => {
  header = { ...header, ...h };
  const brand = appEl.querySelector('.g-brand');
  if (!brand) return;
  brand.querySelector('.g-brand__name').textContent = header.title || t('app.name');
};

const SEARCH_DELAY_MS = 250;

const placeCard = (e) => {
  const cities = [...new Set(e.stores.map((s) => s.city).filter(Boolean))];
  const kindAndCity = [tOr(`biz.${e.company.business}`, ''), ...cities].filter(Boolean).join(' · ');
  const detail = e.stores.length === 1 ? e.stores[0].address : t('dir.locations', { n: e.stores.length });
  return html`<a class="g-tile g-tile--place" href="/g/${enc(e.company.code)}" data-link>
    ${e.company.logo ? html`<img class="g-tile__logo" src="${e.company.logo}" alt="" width="48" height="48" loading="lazy">` : html`<span class="g-tile__mark">${icon('store')}</span>`}
    <span class="g-tile__text"><strong>${e.company.name}</strong>
      <span>${kindAndCity}${kindAndCity && detail && html`<br>`}${detail}</span></span>${icon('chevron', 'g-tile__chevron')}</a>`;
};

/** Every listed business on the platform in one place: search by name, city or address, plus the guest's own places. */
function landing(root) {
  let city = '';
  let timer = null;
  let seq = 0;
  setHtml(root, html`<section class="g-hero"><p class="g-hero__eyebrow">${t('landing.eyebrow')}</p>
      <h1 class="g-hero__title">${t('dir.title')}</h1><p class="g-hero__text">${t('dir.text')}</p></section>
    <form class="g-search" role="search" novalidate><label class="sr-only" for="q">${t('dir.search')}</label>
      ${icon('search', 'g-search__icon')}<input id="q" name="q" type="search" placeholder="${t('dir.placeholder')}" autocomplete="off" enterkeyhint="search"></form>
    <div data-cities></div><div data-mine></div><h2 class="g-cat" data-results-title>${t('dir.all')}</h2>
    <div class="g-actions" data-results aria-live="polite">${skeleton(3)}</div>`);
  const input = root.querySelector('#q');
  const resultsEl = root.querySelector('[data-results]');
  const citiesEl = root.querySelector('[data-cities]');

  const renderCities = (cities) => {
    if (!cities.length) { setHtml(citiesEl, html``); return; }
    setHtml(citiesEl, html`<div class="g-chips" role="group" aria-label="${t('dir.city')}">
      ${['', ...cities].map((c) => html`<button type="button" class="g-chip" data-city="${c}" aria-pressed="${String(c === city)}">${c || t('dir.anyCity')}</button>`)}</div>`);
  };

  const search = async () => {
    const mine = ++seq;
    root.querySelector('[data-results-title]').textContent = input.value.trim() || city ? t('dir.found') : t('dir.all');
    try {
      const r = await get(`/api/guest/directory?q=${enc(input.value.trim())}&city=${enc(city)}`);
      if (mine !== seq) return;
      renderCities(r.cities);
      setHtml(resultsEl, r.results.length ? html`${r.results.map(placeCard)}` : html`<p class="g-empty">${t('dir.none')}</p>`);
    } catch (e) {
      if (mine === seq) setHtml(resultsEl, html`<p class="g-empty">${e.message}</p>`);
    }
  };

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, SEARCH_DELAY_MS); });
  root.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(timer); void search(); });
  citiesEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-city]');
    if (!b) return;
    city = b.dataset.city;
    void search();
  });
  void search();
  if (session.customer) {
    get('/api/guest/me/places').then((places) => {
      if (!places.length) return;
      setHtml(root.querySelector('[data-mine]'), html`<h2 class="g-cat">${t('dir.mine')}</h2><div class="g-actions">${places.map(placeCard)}</div>`);
    }).catch(() => { /* the search still works without "my places" */ });
  }
}

/** Cover photo (or a brand-colour banner), the company's own headline and tagline, and its logo. */
function heroHtml(v, eyebrow, title, extra = '') {
  const th = v.theme ?? {};
  return html`<section class="g-cover ${th.cover ? 'g-cover--photo' : ''}">
    ${th.cover && html`<img class="g-cover__img" src="${th.cover}" alt="" width="1200" height="600">`}
    <div class="g-cover__body">
      ${th.logo && html`<img class="g-cover__logo" src="${th.logo}" alt="" width="64" height="64">`}
      <p class="g-hero__eyebrow">${eyebrow}</p><h1 class="g-hero__title">${title}</h1>
      <p class="g-hero__text">${th.tagline || heroHint(v)}</p>${extra}
    </div></section>`;
}

/** Announcements the company posted in Admin > Broadcast (newest first). */
function newsHtml(v, storeName = null) {
  const items = (v.news ?? []).filter((n) => !storeName || !n.store || n.store === storeName);
  if (!items.length) return '';
  return html`<section class="g-news" aria-labelledby="g-news-title"><h2 id="g-news-title" class="g-cat">${t('venue.news')}</h2>
    ${items.map((n) => html`<article class="g-news__item">${icon('star', 'g-news__icon')}<div>
      <h3 class="g-news__title">${n.title}</h3>${n.body && html`<p class="g-news__body">${n.body}</p>`}
      ${n.store && !storeName && html`<p class="g-hint">${n.store}</p>`}</div></article>`)}</section>`;
}

/** The dashboard at one location of a company (the one the guest chose last, unless the address names another). */
function home(root, v, store) {
  rememberStore(v, store);
  const cover = heroHtml(v, t('venue.welcome'), v.theme?.headline || v.company.name);
  return mountDashboard(root, v, { store, navigate, newsHtml: newsHtml(v, v.stores.length > 1 ? store.name : null), coverHtml: cover });
}

const heroHint = (v) => (v.tables === false ? '' : t('venue.scanHint'));

/** Sets the header and the company's theme together, so the page never shows one company's colours with another's name. */
function useVenue(v, h) {
  applyTheme(v.theme);
  header = { ...h, logo: v.theme?.logo ?? null };
}

async function route() {
  cleanup?.();
  cleanup = null;
  const [company, path2, third, fourth] = parts();
  const second = path2 ?? (location.hash === QUEUE_HASH ? 'queue' : undefined);
  header = { title: '', subtitle: '', company: company ?? '', nav: null, logo: null };
  if (!company) applyTheme(null);
  let root = frame();
  try {
    if (!company) { landing(root); return; }
    setHtml(root, skeleton(4));
    if (second === undefined || second === 'account' || EXTRAS[second]) {
      const v = await venue(company);
      useVenue(v, { title: v.company.name, subtitle: '', company: v.company.code, nav: tabsFor(v) });
      root = frame();
      void claimPendingReferral(v.company.code);
      if (EXTRAS[second]) {
        const stop = await EXTRAS[second](root, { company: v.company.code, stores: v.stores, features: v.features ?? {}, navigate });
        if (typeof stop === 'function') cleanup = stop;
      }
      else await home(root, v, pickedStore(v));
      return;
    }
    if (third === 't' && fourth) {
      setHtml(root, skeleton(5));
      cleanup = await mountTable(root, {
        token: fourth,
        onTitle: (h) => { useVenue({ theme: h.theme }, h); const r = frame(); r.replaceWith(root); },
      });
      return;
    }
    const v = await venue(company);
    const store = v.stores.find((s) => s.code.toLowerCase() === second.toLowerCase());
    if (!store) throw Object.assign(new Error(t('venue.notFound')), { status: 404 });
    useVenue(v, { title: store.name, subtitle: v.company.name, company: v.company.code, nav: tabsFor(v, store) });
    root = frame();
    if (third === 'menu') await mountMenuBrowse(root, { company: v.company.code, store: store.code });
    else if (third === 'order' && v.orderAhead) cleanup = await mountShopOrder(root, { company: v.company.code, store: store.code, navigate });
    else if (third === 'book') await mountBooking(root, { company: v.company.code, store: store.code, stores: v.stores, navigate });
    else await home(root, v, store);
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
