// Customer app entry: boots the session and routes /g/... addresses to screens.
//   /g/                              enter a venue code
//   /g/<company>                     venue home (choose a location)
//   /g/<company>/account             my account at this company
//   /g/<company>/rewards|spin|events|games|pets|support   venue-wide extras
//   /g/<company>/<store>             location home
//   /g/<company>/<store>/menu        browse the menu
//   /g/<company>/<store>/book        book a table
//   /g/<company>/<store>/t/<token>   the table QR: order, my orders, bill and pay
import { t, tOr, getLang, setLang, loadLang, LANGS, addStrings } from './i18n.js';
import { html, raw, setHtml, session, get, loadToken, toastError, skeleton } from './core.js';
import { finishProviderLogin, loadCustomer } from './login.js';
import { mountMenuBrowse, mountTable, waitForPayment } from './table.js';
import { mountAccount, mountBooking } from './account.js';
import { captureReferral, claimPendingReferral, mountEvents, mountPets, mountRewards, mountSpin, mountSupport } from './extras.js';
import { mountGames } from './games.js';
import { mountShopOrder, mountMyOrders } from './shop.js';
import { applyTheme } from './themes.js';
import { icon } from './icons.js';

addStrings({
  en: {
    'venue.menu.other': 'Menu', 'venue.menuSub.other': 'What we have and prices',
    'venue.menu.retail': 'Products', 'venue.menuSub.retail': 'What is in stock and prices', 'venue.menu.pet': 'Products and services', 'venue.menuSub.pet': 'Food, treats, care and prices',
    'venue.menu.salon': 'Services', 'venue.menuSub.salon': 'Treatments and prices',
    'venue.book.other': 'Book a table', 'venue.bookSub.other': 'Reserve for today or another day',
    'venue.eventsSub.other': 'Events, offers and special days', 'venue.accountSub.other': 'Wallet balance, orders and bookings',
    'venue.book.salon': 'Book an appointment', 'venue.bookSub.salon': 'Pick a day and time', 'venue.book.pet': 'Book a visit', 'venue.bookSub.pet': 'Cafe visit, grooming or care',
  },
  zh: {
    'venue.menu.other': '菜单', 'venue.menuSub.other': '品类与价格',
    'venue.menu.retail': '商品', 'venue.menuSub.retail': '在售商品与价格', 'venue.menu.pet': '商品与服务', 'venue.menuSub.pet': '主粮、零食、护理与价格',
    'venue.menu.salon': '服务项目', 'venue.menuSub.salon': '项目与价格',
    'venue.book.other': '预订座位', 'venue.bookSub.other': '今天或其他日期',
    'venue.eventsSub.other': '活动、优惠与特别日子', 'venue.accountSub.other': '储值余额、订单与预约',
    'venue.book.salon': '预约', 'venue.bookSub.salon': '选择日期和时间', 'venue.book.pet': '预约到店', 'venue.bookSub.pet': '咖啡馆、洗护或寄养',
  },
});

/** Venue-wide screens; these words are never store codes. */
const EXTRAS = {
  rewards: (root, ctx) => mountRewards(root, ctx),
  spin: (root, ctx) => mountSpin(root, ctx),
  events: (root, ctx) => mountEvents(root, ctx),
  games: (root) => mountGames(root),
  pets: (root, ctx) => mountPets(root, ctx),
  support: (root, ctx) => mountSupport(root, ctx),
  orders: (root, ctx) => mountMyOrders(root, ctx),
};

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
 * Bottom menu bar for a venue: Home, Book, Rewards, Games, then Events/Contact, Account, keeping only what the venue has
 * switched on. `store` is the location to book at (the booking screen lets the guest pick another).
 */
function tabsFor(v, store = v.stores[0]) {
  const company = enc(v.company.code);
  const f = v.features ?? {};
  const optional = [
    v.bookings !== false && store && { href: `/g/${company}/${enc(store.code)}/book`, icon: 'calendar', label: t('nav.book') },
    f.loyalty && { href: `/g/${company}/rewards`, icon: 'gift', label: t('venue.rewards') },
    f.games && { href: `/g/${company}/games`, icon: 'dice', label: t('nav.games') },
    f.events && { href: `/g/${company}/events`, icon: 'star', label: t('venue.events') },
    f.support && { href: `/g/${company}/support`, icon: 'chat', label: t('venue.support') },
  ].filter(Boolean);
  return [
    { href: `/g/${company}`, icon: 'home', label: t('nav.home') },
    ...optional.slice(0, MAX_TABS - 2),
    { href: `/g/${company}/account`, icon: 'user', label: t('nav.account') },
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
        ${company && html`<a class="g-btn g-btn--small" href="/g/${enc(company)}/account" data-link aria-label="${t('venue.account')}">${session.customer ? icon('user') : t('login.title')}</a>`}
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

const placeLine = (s) => [s.city, s.address].filter(Boolean).join(' · ');
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

const tile = (href, iconName, title, sub) => html`<a class="g-tile" href="${href}" data-link><span class="g-tile__mark">${icon(iconName)}</span>
  <span class="g-tile__text"><strong>${title}</strong><span>${sub}</span></span>${icon('chevron', 'g-tile__chevron')}</a>`;

/** Grid or list, as the company chose in Admin > App design. */
const actionsClass = (v) => (v.theme?.layout === 'grid' ? 'g-actions g-actions--grid' : 'g-actions');

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

function venueHome(root, v) {
  const company = v.company.code;
  const where = v.stores.length === 1 && placeLine(v.stores[0]);
  setHtml(root, html`<a class="g-back" href="/g/" data-link>${icon('back')}<span>${t('dir.allShort')}</span></a>
    ${heroHtml(v, t('venue.welcome'), v.theme?.headline || v.company.name, where ? html`<p class="g-cover__where">${icon('pin')}<span>${where}</span></p>` : '')}
    ${v.stores.length > 1 && html`<h2 class="g-cat">${t('venue.pickStore')}</h2>`}
    <div class="${actionsClass(v)}">${v.stores.length > 1
      ? v.stores.map((s) => tile(`/g/${enc(company)}/${enc(s.code)}`, 'pin', s.name, placeLine(s) || t('venue.storeSub')))
      : storeTiles(company, v.stores[0], v)}</div>
    <h2 class="g-cat">${t('venue.more')}</h2>
    <div class="${actionsClass(v)}">${extraTiles(company, v.features ?? {}, v)}</div>`);
}

/** Bars keep their own words; other businesses get wording for their kind (menu vs products, booking vs appointment). */
const word = (v, key) => (v.business && v.business !== 'bar' ? tOr(`${key}.${v.business}`, tOr(`${key}.other`, t(key))) : t(key));

const storeTiles = (company, s, v) => [
  v.orderAhead && tile(`/g/${enc(company)}/${enc(s.code)}/order`, 'bag', t('shop.order'), t('shop.orderSub')),
  tile(`/g/${enc(company)}/${enc(s.code)}/menu`, 'menu', word(v, 'venue.menu'), word(v, 'venue.menuSub')),
  v.bookings !== false && tile(`/g/${enc(company)}/${enc(s.code)}/book`, 'calendar', word(v, 'venue.book'), word(v, 'venue.bookSub')),
];
const heroHint = (v) => (v.tables === false ? '' : t('venue.scanHint'));

const extraTiles = (company, f, v) => [
  v.orderAhead && tile(`/g/${enc(company)}/orders`, 'receipt', t('shop.mine'), t('shop.mineSub')),
  f.events && tile(`/g/${enc(company)}/events`, 'star', t('venue.events'), word(v, 'venue.eventsSub')),
  f.loyalty && tile(`/g/${enc(company)}/rewards`, 'gift', t('venue.rewards'), t('venue.rewardsSub')),
  f.games && tile(`/g/${enc(company)}/games`, 'dice', t('venue.games'), t('venue.gamesSub')),
  f.pets && tile(`/g/${enc(company)}/pets`, 'paw', t('venue.pets'), t('venue.petsSub')),
  f.support && tile(`/g/${enc(company)}/support`, 'chat', t('venue.support'), t('venue.supportSub')),
  tile(`/g/${enc(company)}/account`, 'user', t('venue.account'), word(v, 'venue.accountSub')),
];

function storeHome(root, v, store) {
  const where = placeLine(store);
  setHtml(root, html`${heroHtml(v, v.company.name, store.name, where ? html`<p class="g-cover__where">${icon('pin')}<span>${where}</span></p>` : '')}
    <div class="${actionsClass(v)}">${storeTiles(v.company.code, store, v)}</div>
    <h2 class="g-cat">${t('venue.more')}</h2>
    <div class="${actionsClass(v)}">${extraTiles(v.company.code, v.features ?? {}, v)}</div>`);
}

/** Sets the header and the company's theme together, so the page never shows one company's colours with another's name. */
function useVenue(v, h) {
  applyTheme(v.theme);
  header = { ...h, logo: v.theme?.logo ?? null };
}

async function route() {
  cleanup?.();
  cleanup = null;
  const [company, second, third, fourth] = parts();
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
      if (second === 'account') await mountAccount(root, { company: v.company.code, navigate });
      else if (EXTRAS[second]) await EXTRAS[second](root, { company: v.company.code, stores: v.stores, navigate });
      else venueHome(root, v);
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
