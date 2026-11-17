// Member dashboard for one company: home (points, wallet, quick actions, recent activity), Me (profile and settings),
// wallet, history (orders and bookings), activity, song requests, and switching to another merchant.
import { t, getLang, LANGS, addStrings } from './i18n.js';
import { html, setHtml, productName, fmtMoney, fmtBottles, fmtDate, fmtDateTime, session, get, post, patch, saveToken, sheet, toast, toastError, busy, skeleton } from './core.js';
import { ensureSignedIn, verifyPhone } from './login.js';
import { requestsHtml, requestSummary, onCancelRequest } from './extras.js';
import { orderCard } from './shop.js';
import { openPay, lastTable } from './table.js';
import { icon } from './icons.js';

addStrings({
  en: {
    'db.hi': 'Hi, {name}', 'db.member': 'Member at {company}', 'db.points': 'Points', 'db.wallet': 'Wallet', 'db.vouchers': 'Vouchers',
    'db.walletLocked': 'Verify', 'db.nextReward': '{n} more points for {reward}', 'db.canRedeem': 'You can redeem {reward} now',
    'db.join': 'Join {company}', 'db.joinText': 'Collect points, keep your wallet and bottles, book and order ahead, and request songs.',
    'db.joinBtn': 'Sign in or create an account', 'db.quick': 'Quick actions', 'db.recent': 'Recent activity', 'db.seeAll': 'See all',
    'db.noActivity': 'Nothing yet. Your orders, points and requests will show here.', 'db.upcoming': 'Your next booking',
    'db.order': 'Order', 'db.menu': 'Menu', 'db.book': 'Book', 'db.songs': 'Songs', 'db.games': 'Games', 'db.spin': 'Prize wheel',
    'db.rewards': 'Rewards', 'db.invite': 'Invite', 'db.events': 'Events', 'db.history': 'History', 'db.pets': 'Pets', 'db.support': 'Contact',
    'db.activity': 'Activity', 'db.location': 'Location', 'db.switch': 'Switch merchant', 'db.switchSub': 'Your other places, or find a new one',
    'db.current': 'Current', 'db.findMore': 'Find more places', 'db.noPlaces': 'You have not visited any other place yet.',
    'db.map': 'Map', 'db.orderAt': 'Order · {store}', 'db.voucherGot': 'Voucher', 'db.atTable': 'Table {table} · {store}',
    'me.title': 'Me', 'me.account': 'My account', 'me.settings': 'Settings', 'me.walletSub': 'Balance, top-ups and stored bottles',
    'me.historySub': 'Past orders and bookings', 'me.activitySub': 'Points, payments and requests', 'me.rewardsSub': 'Points, vouchers and prize wheel',
    'me.inviteSub': 'Share your code and earn points', 'me.songsSub': 'Request a song and see the queue',
    'me.name': 'Name', 'me.phone': 'Phone', 'me.language': 'Language', 'me.verified': 'Verified', 'me.signin': 'Sign-in',
    'wl.title': 'Wallet', 'wl.balance': 'Balance', 'wl.topUpHint': 'Top up at the counter. Ask the staff about top-up offers.',
    'wl.history': 'Wallet history', 'wl.noHistory': 'No wallet activity yet.',
    'hist.title': 'History', 'hist.orders': 'Orders', 'hist.bookings': 'Bookings', 'hist.noOrders': 'No orders yet.', 'hist.bookAgain': 'Book again',
    'act.title': 'Activity', 'act.all': 'All', 'act.points': 'Points', 'act.wallet': 'Wallet', 'act.orders': 'Orders', 'act.requests': 'Requests',
    'sg.title': 'Song requests', 'sg.text': 'Ask the DJ for a song. The staff see your request straight away.',
    'sg.table': 'Sending from table {table}', 'sg.noTable': 'Not at a table? Choose the location you are at.', 'sg.mine': 'My song requests',
    'sg.none': 'No song requests yet.', 'sg.off': 'Song requests are not available here.', 'sg.queue': '{n} waiting',
  },
  zh: {
    'db.hi': '您好，{name}', 'db.member': '{company} 会员', 'db.points': '积分', 'db.wallet': '储值', 'db.vouchers': '兑换券',
    'db.walletLocked': '去验证', 'db.nextReward': '再得 {n} 积分可兑换 {reward}', 'db.canRedeem': '现在可兑换 {reward}',
    'db.join': '加入 {company}', 'db.joinText': '累积积分、查看储值与存酒、预订和提前下单，还能点歌。',
    'db.joinBtn': '登录或注册', 'db.quick': '常用功能', 'db.recent': '最近动态', 'db.seeAll': '查看全部',
    'db.noActivity': '暂无动态。您的订单、积分和请求会显示在这里。', 'db.upcoming': '即将到来的预订',
    'db.order': '点单', 'db.menu': '菜单', 'db.book': '预订', 'db.songs': '点歌', 'db.games': '游戏', 'db.spin': '幸运转盘',
    'db.rewards': '积分福利', 'db.invite': '邀请', 'db.events': '活动', 'db.history': '记录', 'db.pets': '宠物', 'db.support': '联系门店',
    'db.activity': '动态', 'db.location': '门店', 'db.switch': '切换商家', 'db.switchSub': '去过的其他商家，或发现新商家',
    'db.current': '当前', 'db.findMore': '发现更多商家', 'db.noPlaces': '您还没有去过其他商家。',
    'db.map': '导航', 'db.orderAt': '订单 · {store}', 'db.voucherGot': '兑换券', 'db.atTable': '{table} 桌 · {store}',
    'me.title': '我的', 'me.account': '我的账户', 'me.settings': '设置', 'me.walletSub': '余额、充值与存酒',
    'me.historySub': '历史订单与预订', 'me.activitySub': '积分、付款与服务请求', 'me.rewardsSub': '积分、兑换券与幸运转盘',
    'me.inviteSub': '分享邀请码赚积分', 'me.songsSub': '点歌并查看排队',
    'me.name': '称呼', 'me.phone': '手机号', 'me.language': '语言', 'me.verified': '已验证', 'me.signin': '登录方式',
    'wl.title': '我的储值', 'wl.balance': '余额', 'wl.topUpHint': '请到前台充值，可向服务员咨询充值优惠。',
    'wl.history': '储值记录', 'wl.noHistory': '暂无储值记录。',
    'hist.title': '历史记录', 'hist.orders': '订单', 'hist.bookings': '预订', 'hist.noOrders': '暂无订单。', 'hist.bookAgain': '再次预订',
    'act.title': '我的动态', 'act.all': '全部', 'act.points': '积分', 'act.wallet': '储值', 'act.orders': '订单', 'act.requests': '请求',
    'sg.title': '点歌', 'sg.text': '告诉 DJ 您想听的歌，服务员会第一时间收到。',
    'sg.table': '从 {table} 桌点歌', 'sg.noTable': '还没入座？请选择您所在的门店。', 'sg.mine': '我的点歌',
    'sg.none': '暂无点歌记录。', 'sg.off': '本门店暂未开通点歌。', 'sg.queue': '{n} 首等待中',
  },
});

const enc = encodeURIComponent;
const STORE_KEY = 'nightpos.store.';
const PREVIEW_ITEMS = 4;
const REQ_TONE = { pending: 'pending', done: 'ok', declined: 'bad', cancelled: 'neutral' };
const ORDER_TONE = { pending: 'pending', accepted: 'ok', rejected: 'bad', cancelled: 'neutral' };
const BOOKING_TONE = { submitted: 'pending', confirmed: 'ok', checked_in: 'ok', redeemed: 'neutral', cancelled: 'neutral', no_show: 'bad' };
const OPEN_BOOKING = ['submitted', 'confirmed'];
const KIND_ICON = { service: 'chat', song: 'music', bottle: 'gift', support: 'chat', pet: 'paw' };
const bi = (zh, en) => (getLang() === 'en' && en ? en : zh);
/** ¥688 rather than ¥688.00 where space is tight; keeps the cents when there are any. */
const shortMoney = (fen) => (fen % 100 === 0 ? `¥${(fen / 100).toLocaleString('en-US')}` : fmtMoney(fen));
const signed = (n, fmt = String) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n))}`;

// ---------- shared ----------

/** The location this guest last chose at a company, so Order, Menu and Book open there. */
export function pickedStore(v) {
  let code = null;
  try { code = localStorage.getItem(STORE_KEY + v.company.code); } catch { /* blocked storage: first location */ }
  return v.stores.find((s) => s.code === code) ?? v.stores[0];
}

export function rememberStore(v, store) {
  try { localStorage.setItem(STORE_KEY + v.company.code, store.code); } catch { /* blocked storage */ }
}

const initial = (name) => (name || '?').trim().slice(0, 1).toUpperCase();

function signInCard(root, again, v = null) {
  setHtml(root, html`<section class="g-join">
    <span class="g-join__icon">${icon('user')}</span>
    <h1 class="g-join__title">${v ? t('db.join', { company: v.company.name }) : t('login.title')}</h1>
    <p class="g-join__text">${v ? t('db.joinText') : t('login.why')}</p>
    <button type="button" class="g-btn g-btn--primary g-btn--block" data-signin>${t('db.joinBtn')}</button></section>`);
  root.querySelector('[data-signin]').addEventListener('click', async () => { if (await ensureSignedIn()) await again(); });
}

/** Everything the member screens show, loaded together. Loyalty is null when the company has it switched off. */
async function memberData(company) {
  const c = enc(company);
  const [account, loyalty, requests] = await Promise.all([
    get(`/api/guest/account/${c}`),
    get(`/api/guest/loyalty/${c}`).catch((e) => { if (e.status === 404) return null; throw e; }),
    get(`/api/guest/requests/${c}`),
  ]);
  return { account, loyalty, requests };
}

const pageHead = (title, sub = '') => html`<header class="g-pagehead"><h1 class="g-pagehead__title">${title}</h1>${sub && html`<p class="g-hint">${sub}</p>`}</header>`;

// ---------- activity feed ----------

function activityItems(d) {
  const items = [];
  for (const l of d.loyalty?.ledger ?? []) {
    items.push({ kind: 'points', ts: l.ts, icon: 'star', title: t(`rw.reason.${l.reason}`), sub: t('db.points'), amount: t('rw.pts', { n: signed(l.delta) }), up: l.delta > 0 });
  }
  for (const l of d.account.wallet?.ledger ?? []) {
    items.push({ kind: 'wallet', ts: l.ts, icon: 'wallet', title: t(l.delta > 0 ? 'account.topUp' : 'account.spent'), sub: t('db.wallet'), amount: signed(l.delta, fmtMoney), up: l.delta > 0 });
  }
  for (const v of d.loyalty?.vouchers ?? []) {
    items.push({ kind: 'points', ts: v.createdAt, icon: 'ticket', title: v.title, sub: t('db.voucherGot'), amount: v.code });
  }
  for (const o of d.account.orders) {
    items.push({ kind: 'orders', ts: o.createdAt, icon: 'receipt', title: t('db.orderAt', { store: o.storeName }), sub: o.items.map((i) => `${productName(i)} × ${i.qty}`).join(', '),
      amount: fmtMoney(o.total), badge: { tone: ORDER_TONE[o.status], text: t(`orders.${o.status}`) } });
  }
  for (const r of d.requests) {
    items.push({ kind: 'requests', ts: r.createdAt, icon: KIND_ICON[r.kind] ?? 'chat', title: t(`req.kind.${r.kind}`), sub: requestSummary(r),
      badge: { tone: REQ_TONE[r.status], text: t(`req.${r.status}`) } });
  }
  return items.sort((a, b) => b.ts - a.ts);
}

const feedHtml = (items) => (items.length
  ? html`<ul class="g-feed">${items.map((i) => html`<li class="g-feed__item">
      <span class="g-feed__icon g-feed__icon--${i.kind}">${icon(i.icon)}</span>
      <span class="g-feed__body"><strong>${i.title}</strong><span class="g-hint">${i.sub ? `${i.sub} · ` : ''}${fmtDateTime(i.ts)}</span></span>
      <span class="g-feed__end">${i.amount && html`<span class="g-num g-feed__amount ${i.up === true ? 'is-up' : ''}">${i.amount}</span>`}
        ${i.badge && html`<span class="g-badge g-badge--${i.badge.tone}">${i.badge.text}</span>`}</span></li>`)}</ul>`
  : html`<p class="g-empty">${t('db.noActivity')}</p>`);

// ---------- home dashboard ----------

/** Quick actions for this company, only the ones it has switched on. */
function quickActions(v, store) {
  const co = `/g/${enc(v.company.code)}`;
  const at = store ? `${co}/${enc(store.code)}` : co;
  const f = v.features ?? {};
  return [
    store && (v.orderAhead ? { href: `${at}/order`, icon: 'bag', label: t('db.order') } : { href: `${at}/menu`, icon: 'menu', label: t('db.menu') }),
    store && v.orderAhead && { href: `${at}/menu`, icon: 'menu', label: t('db.menu') },
    store && v.bookings !== false && { href: `${at}/book`, icon: 'calendar', label: t('db.book') },
    f.song && { href: `${co}/songs`, icon: 'music', label: t('db.songs') },
    (f.games || (f.loyalty && f.spin)) && { href: `${co}/games`, icon: 'dice', label: t('db.games') },
    f.loyalty && f.spin && { href: `${co}/spin`, icon: 'wheel', label: t('db.spin') },
    f.loyalty && { href: `${co}/rewards`, icon: 'gift', label: t('db.rewards') },
    f.loyalty && f.referral && { href: `${co}/invite`, icon: 'users', label: t('db.invite') },
    f.events && { href: `${co}/events`, icon: 'star', label: t('db.events') },
    { href: `${co}/history`, icon: 'clock', label: t('db.history') },
    f.pets && { href: `${co}/pets`, icon: 'paw', label: t('db.pets') },
    f.support && { href: `${co}/support`, icon: 'chat', label: t('db.support') },
  ].filter(Boolean);
}

const MAP_SEARCH = 'https://uri.amap.com/search';

/** Street, city and postal code with a button that opens the address in a map app (Amap in the browser or its app). */
function whereHtml(store) {
  if (!store?.address && !store?.city) return '';
  const line = [store.address, store.city, store.postalCode].filter(Boolean).join(', ');
  const query = [store.city, store.address].filter(Boolean).join(' ');
  return html`<div class="g-where">${icon('pin', 'g-where__icon')}<span class="g-where__text"><strong>${store.name}</strong><span>${line}</span></span>
    <a class="g-btn g-btn--small" href="${MAP_SEARCH}?keyword=${enc(query)}&src=nightpos" target="_blank" rel="noopener">${t('db.map')}</a></div>`;
}

const quickGrid = (actions) => html`<nav class="g-quick" aria-label="${t('db.quick')}">${actions.map((a) =>
  html`<a class="g-quick__item" href="${a.href}" data-link><span class="g-quick__icon">${icon(a.icon)}</span><span class="g-quick__label">${a.label}</span></a>`)}</nav>`;

function switcherHtml(v, store) {
  const logo = v.theme?.logo;
  return html`<div class="g-switchbar">
    <button type="button" class="g-switch" data-switch aria-haspopup="dialog">
      ${logo ? html`<img class="g-switch__logo" src="${logo}" alt="" width="32" height="32">` : html`<span class="g-switch__logo g-switch__logo--mark">${icon('store')}</span>`}
      <span class="g-switch__text"><span class="g-hint">${t('db.switch')}</span><strong>${v.company.name}</strong></span>${icon('down', 'g-switch__chev')}</button>
  </div>
  ${v.stores.length > 1 && html`<div class="g-chips" role="group" aria-label="${t('db.location')}">${v.stores.map((s) =>
    html`<button type="button" class="g-chip" data-store="${s.code}" aria-pressed="${String(s.code === store?.code)}">${s.name}</button>`)}</div>`}
  </div>`;
}

function memberCardHtml(v, d) {
  const c = session.customer;
  const co = `/g/${enc(v.company.code)}`;
  const l = d.loyalty;
  const a = d.account;
  const openVouchers = (l?.vouchers ?? []).filter((x) => x.status === 'issued' && x.expiresAt >= Date.now()).length;
  const walletValue = a.wallet ? shortMoney(a.wallet.balance) : a.phoneVerified ? shortMoney(0) : t('db.walletLocked');
  const next = l?.rewards.find((r) => r.cost > l.balance);
  const best = l ? [...l.rewards].reverse().find((r) => r.cost <= l.balance) : null;
  const progress = next ? Math.max(4, Math.round((l.balance / next.cost) * 100)) : 100;
  return html`<section class="g-member" aria-label="${t('db.member', { company: v.company.name })}">
    <div class="g-member__top">
      <div><p class="g-member__hi">${t('db.hi', { name: c.name || t('account.guest') })}</p><p class="g-member__sub">${t('db.member', { company: v.company.name })}</p></div>
      <a class="g-avatar" href="${co}/me" data-link aria-label="${t('me.title')}">${initial(c.name)}</a></div>
    <div class="g-member__stats">
      ${l && html`<a class="g-stat" href="${co}/rewards" data-link><span class="g-stat__label">${t('db.points')}</span><strong class="g-stat__value g-num">${l.balance}</strong></a>`}
      <a class="g-stat" href="${co}/wallet" data-link><span class="g-stat__label">${t('db.wallet')}</span><strong class="g-stat__value g-num">${walletValue}</strong></a>
      ${l ? html`<a class="g-stat" href="${co}/rewards" data-link><span class="g-stat__label">${t('db.vouchers')}</span><strong class="g-stat__value g-num">${openVouchers}</strong></a>`
        : html`<a class="g-stat" href="${co}/history" data-link><span class="g-stat__label">${t('hist.orders')}</span><strong class="g-stat__value g-num">${a.orders.length}</strong></a>`}
    </div>
    ${l && (next || best) && html`<a class="g-member__goal" href="${co}/rewards" data-link>
      <span>${next ? t('db.nextReward', { n: next.cost - l.balance, reward: bi(next.name, next.nameEn) }) : t('db.canRedeem', { reward: bi(best.name, best.nameEn) })}</span>
      <span class="g-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style="width:${progress}%"></span></span></a>`}
  </section>`;
}

function upcomingHtml(v, a) {
  const b = a.bookings.filter((x) => OPEN_BOOKING.includes(x.status) && x.eta > Date.now()).sort((x, y) => x.eta - y.eta)[0];
  if (!b) return '';
  return html`<a class="g-upnext" href="/g/${enc(v.company.code)}/history?tab=bookings" data-link>
    <span class="g-feed__icon">${icon('calendar')}</span>
    <span class="g-feed__body"><span class="g-hint">${t('db.upcoming')}</span><strong>${fmtDateTime(b.eta)}</strong>
      <span class="g-hint">${b.storeName} · ${t('book.party.n', { n: b.partySize })}${b.tableName ? ` · ${b.tableName}` : ''}</span></span>
    <span class="g-badge g-badge--${BOOKING_TONE[b.status]}">${t(`bookingStatus.${b.status}`)}</span></a>`;
}

/**
 * The company's home: merchant switcher, member card with points and wallet, quick actions, news and recent activity.
 * Signed-out guests see a join card in place of the member card.
 */
export async function mountDashboard(root, v, { store, navigate, newsHtml, coverHtml }) {
  const co = `/g/${enc(v.company.code)}`;
  setHtml(root, html`${switcherHtml(v, store)}
    ${!session.customer && coverHtml}
    <div data-member>${session.customer ? html`<div class="g-skel g-skel--card"></div>` : ''}</div>
    ${whereHtml(store)}
    <h2 class="g-cat">${t('db.quick')}</h2>${quickGrid(quickActions(v, store))}
    ${newsHtml}
    <div data-recent></div>`);
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-switch]')) { void chooseMerchant(v.company.code, navigate); return; }
    const chip = e.target.closest('[data-store]');
    if (!chip || chip.dataset.store === store?.code) return;
    const next = v.stores.find((s) => s.code === chip.dataset.store);
    rememberStore(v, next);
    navigate(`${co}/${enc(next.code)}`);
  });
  const memberEl = root.querySelector('[data-member]');
  if (!session.customer) {
    const join = document.createElement('div');
    memberEl.append(join);
    signInCard(join, () => navigate(location.pathname), v);
    return;
  }
  try {
    const d = await memberData(v.company.code);
    setHtml(memberEl, html`${memberCardHtml(v, d)}${upcomingHtml(v, d.account)}`);
    const items = activityItems(d).slice(0, PREVIEW_ITEMS);
    setHtml(root.querySelector('[data-recent]'), html`<div class="g-cathead"><h2 class="g-cat">${t('db.recent')}</h2>
      <a class="g-cathead__link" href="${co}/activity" data-link>${t('db.seeAll')}</a></div>${feedHtml(items)}`);
  } catch (e) {
    setHtml(memberEl, html`<p class="g-empty">${e.message}</p>`);
  }
}

// ---------- switch merchant ----------

function chooseMerchant(current, navigate) {
  return sheet(t('db.switch'), async (body, close) => {
    setHtml(body, skeleton(2));
    let places = [];
    if (session.customer) {
      try { places = await get('/api/guest/me/places'); } catch { /* the "find more" link still works */ }
    }
    const others = places.filter((p) => p.company.code.toLowerCase() !== current.toLowerCase());
    const mine = places.find((p) => p.company.code.toLowerCase() === current.toLowerCase());
    const row = (p, isCurrent) => html`<a class="g-tile g-tile--place" href="/g/${enc(p.company.code)}" data-go>
      ${p.company.logo ? html`<img class="g-tile__logo" src="${p.company.logo}" alt="" width="48" height="48" loading="lazy">` : html`<span class="g-tile__mark">${icon('store')}</span>`}
      <span class="g-tile__text"><strong>${p.company.name}</strong><span>${[...new Set(p.stores.map((s) => s.city).filter(Boolean))].join(' · ')}</span></span>
      ${isCurrent ? html`<span class="g-badge g-badge--ok">${t('db.current')}</span>` : icon('chevron', 'g-tile__chevron')}</a>`;
    setHtml(body, html`<p class="g-hint">${t('db.switchSub')}</p><div class="g-actions">
      ${mine && row(mine, true)}${others.map((p) => row(p, false))}
      ${!others.length && html`<p class="g-muted">${t('db.noPlaces')}</p>`}
      <a class="g-btn g-btn--primary g-btn--block" href="/g/" data-go>${icon('search')}${t('db.findMore')}</a></div>`);
    body.addEventListener('click', (e) => {
      const a = e.target.closest('[data-go]');
      if (!a) return;
      e.preventDefault();
      close();
      navigate(a.getAttribute('href'));
    });
  });
}

// ---------- Me: profile and settings ----------

const menuRow = ({ href, icon: name, label, sub = '', data = '', end = '' }) => (href
  ? html`<a class="g-menu__row" href="${href}" data-link><span class="g-menu__icon">${icon(name)}</span>
      <span class="g-menu__text"><strong>${label}</strong>${sub && html`<span>${sub}</span>`}</span>${end || icon('chevron', 'g-tile__chevron')}</a>`
  : html`<button type="button" class="g-menu__row" data-act="${data}"><span class="g-menu__icon">${icon(name)}</span>
      <span class="g-menu__text"><strong>${label}</strong>${sub && html`<span>${sub}</span>`}</span>${end || icon('chevron', 'g-tile__chevron')}</button>`);

export async function mountMe(root, { company, features = {}, navigate }) {
  const co = `/g/${enc(company)}`;
  const load = async () => {
    if (!session.customer) { signInCard(root, load); return; }
    setHtml(root, skeleton(4));
    const d = await memberData(company);
    const c = session.customer;
    const canVerify = Boolean(session.config.login.phone);
    const providers = [...c.providers.map((p) => t(`provider.${p}`)), ...(c.loginPhone ? [t('provider.password')] : [])];
    const l = d.loyalty;
    setHtml(root, html`<section class="g-profile">
        <span class="g-avatar g-avatar--big">${initial(c.name)}</span>
        <div class="g-profile__text"><h1 class="g-profile__name">${c.name || t('account.guest')}</h1>
          <p class="g-hint">${c.phone ?? c.loginPhone ?? t('account.noPhone')}${c.phone ? html` · <span class="g-verified">${icon('shield')}${t('me.verified')}</span>` : ''}</p>
          ${providers.length > 0 && html`<p class="g-hint">${t('account.signedVia', { list: providers.join(' · ') })}</p>`}</div>
        <button type="button" class="g-iconbtn" data-act="rename" aria-label="${t('account.rename')}">${icon('edit')}</button></section>
      <div class="g-statrow">
        ${l && html`<a class="g-statbox" href="${co}/rewards" data-link><strong class="g-num">${l.balance}</strong><span>${t('db.points')}</span></a>`}
        <a class="g-statbox" href="${co}/wallet" data-link><strong class="g-num">${d.account.wallet ? fmtMoney(d.account.wallet.balance) : '—'}</strong><span>${t('db.wallet')}</span></a>
        <a class="g-statbox" href="${co}/history" data-link><strong class="g-num">${d.account.orders.length}</strong><span>${t('hist.orders')}</span></a></div>
      <h2 class="g-cat">${t('me.account')}</h2><div class="g-menu">
        ${menuRow({ href: `${co}/wallet`, icon: 'wallet', label: t('wl.title'), sub: t('me.walletSub') })}
        ${menuRow({ href: `${co}/history`, icon: 'clock', label: t('hist.title'), sub: t('me.historySub') })}
        ${menuRow({ href: `${co}/activity`, icon: 'pulse', label: t('act.title'), sub: t('me.activitySub') })}
        ${l && menuRow({ href: `${co}/rewards`, icon: 'gift', label: t('rw.title'), sub: t('me.rewardsSub') })}
        ${l?.referral && menuRow({ href: `${co}/invite`, icon: 'users', label: t('ref.title'), sub: t('me.inviteSub') })}
        ${features.song && menuRow({ href: `${co}/songs`, icon: 'music', label: t('sg.title'), sub: t('me.songsSub') })}</div>
      <h2 class="g-cat">${t('me.settings')}</h2><div class="g-menu">
        ${menuRow({ data: 'rename', icon: 'user', label: t('me.name'), end: html`<span class="g-menu__value">${c.name || '—'}</span>` })}
        ${canVerify && !c.phone && menuRow({ data: 'verify', icon: 'phone', label: t('account.verify'), sub: t('account.walletNeedsPhone') })}
        <div class="g-menu__row"><span class="g-menu__icon">${icon('globe')}</span><span class="g-menu__text"><strong>${t('me.language')}</strong></span>
          <span class="g-lang" role="group" aria-label="${t('lang.label')}">${LANGS.map((x) =>
            html`<button type="button" data-lang="${x}" aria-pressed="${String(getLang() === x)}">${t(`lang.${x}`)}</button>`)}</span></div>
        ${menuRow({ data: 'switch', icon: 'swap', label: t('db.switch'), sub: t('db.switchSub') })}
        ${menuRow({ data: 'logout', icon: 'logout', label: t('account.logout'), end: ' ' })}</div>`);
  };
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'rename') await rename(load);
    else if (act === 'verify') { if (await verifyPhone()) await load(); }
    else if (act === 'switch') await chooseMerchant(company, navigate);
    else if (act === 'logout') {
      await busy(b, async () => { await post('/api/guest/logout'); })();
      saveToken(null);
      session.customer = null;
      navigate(co);
    }
  });
  await load();
}

function rename(after) {
  return sheet(t('account.rename'), (body, close) => {
    setHtml(body, html`<form novalidate><div class="g-field"><label for="nm">${t('account.name')}</label>
      <input id="nm" maxlength="40" required value="${session.customer.name}"></div>
      <button type="submit" class="g-btn g-btn--primary g-btn--block">${t('account.save')}</button></form>`);
    const form = body.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await busy(form.querySelector('button'), async () => {
        session.customer = await patch('/api/guest/me', { name: form.elements[0].value });
        toast(t('account.saved'), 'success');
        close();
        await after();
      })();
    });
  });
}

// ---------- wallet ----------

export async function mountWallet(root, { company }) {
  const load = async () => {
    if (!session.customer) { signInCard(root, load); return; }
    setHtml(root, skeleton(3));
    const a = await get(`/api/guest/account/${enc(company)}`);
    const canVerify = Boolean(session.config.login.phone);
    if (!a.phoneVerified) {
      setHtml(root, html`${pageHead(t('wl.title'))}<section class="g-card"><p class="g-muted g-lead">${canVerify ? t('account.walletNeedsPhone') : t('account.walletAskStaff')}</p>
        ${canVerify && html`<button type="button" class="g-btn g-btn--primary g-btn--block" data-verify>${t('account.verify')}</button>`}</section>`);
      root.querySelector('[data-verify]')?.addEventListener('click', async () => { if (await verifyPhone()) await load(); });
      return;
    }
    const ledger = a.wallet?.ledger ?? [];
    setHtml(root, html`${pageHead(t('wl.title'))}
      <section class="g-balancecard"><span class="g-balancecard__label">${icon('wallet')}${t('wl.balance')}</span>
        <strong class="g-balancecard__value g-num">${fmtMoney(a.wallet?.balance ?? 0)}</strong>
        <p class="g-balancecard__hint">${a.wallet ? t('wl.topUpHint') : t('account.noWallet')}</p></section>
      <h2 class="g-cat">${t('account.stash')}</h2>
      ${a.stash.length ? html`<div class="g-actions">${a.stash.map((s) => html`<div class="g-tile">
        <span class="g-tile__mark">${icon('gift')}</span><span class="g-tile__text"><strong>${s.name}</strong>
        <span>${s.storeName} · ${t('account.stashCode', { code: s.code })} · ${t('account.expires', { date: fmtDate(s.expiresAt) })}</span></span>
        <span class="g-num g-badge g-badge--ok">${t('account.stashLeft', { n: fmtBottles(s.leftMilli) })}</span></div>`)}</div>`
        : html`<p class="g-empty">${t('account.noStash')}</p>`}
      <h2 class="g-cat">${t('wl.history')}</h2>
      ${feedHtml(ledger.map((l) => ({ kind: 'wallet', ts: l.ts, icon: 'wallet', title: t(l.delta > 0 ? 'account.topUp' : 'account.spent'), amount: signed(l.delta, fmtMoney), up: l.delta > 0 })))}`);
  };
  await load();
}

// ---------- history: orders and bookings ----------

export async function mountHistory(root, { company, stores, navigate }) {
  const co = `/g/${enc(company)}`;
  let tab = new URLSearchParams(location.search).get('tab') === 'bookings' ? 'bookings' : 'orders';
  let account = null;
  const render = () => {
    const seg = html`<div class="g-seg" role="group">${[['orders', t('hist.orders')], ['bookings', t('hist.bookings')]].map(([id, label]) =>
      html`<button type="button" data-tab="${id}" aria-pressed="${String(tab === id)}">${label}</button>`)}</div>`;
    let body;
    if (tab === 'orders') {
      body = account.orders.length ? html`<div class="g-card">${account.orders.map(orderCard)}</div>` : html`<p class="g-empty">${t('hist.noOrders')}</p>`;
    } else {
      body = account.bookings.length ? html`<div class="g-actions">${account.bookings.map((b) => html`<article class="g-tile g-tile--top">
          <span class="g-tile__mark">${icon('calendar')}</span>
          <span class="g-tile__text"><strong>${fmtDateTime(b.eta)}</strong><span>${b.storeName} · ${t('book.party.n', { n: b.partySize })}${b.tableName ? ` · ${b.tableName}` : ''}</span>
            ${OPEN_BOOKING.includes(b.status) && b.eta > Date.now() && html`<button type="button" class="g-link" data-cancel-booking="${b.id}">${t('book.cancel')}</button>`}</span>
          <span class="g-badge g-badge--${BOOKING_TONE[b.status] ?? 'neutral'}">${t(`bookingStatus.${b.status}`)}</span></article>`)}</div>`
        : html`<p class="g-empty">${t('account.noBookings')}</p>`;
      body = html`${body}${stores.length > 0 && html`<a class="g-btn g-btn--block g-gap" href="${co}/${enc(stores[0].code)}/book" data-link>${icon('calendar')}${t('hist.bookAgain')}</a>`}`;
    }
    setHtml(root, html`${pageHead(t('hist.title'))}${seg}<div class="g-gap">${body}</div>`);
  };
  const load = async () => {
    if (!session.customer) { signInCard(root, load); return; }
    setHtml(root, skeleton(4));
    account = await get(`/api/guest/account/${enc(company)}`);
    render();
  };
  root.addEventListener('click', async (e) => {
    const el = e.target.closest('button');
    if (!el) return;
    try {
      if (el.dataset.tab) { tab = el.dataset.tab; history.replaceState(null, '', `${location.pathname}?tab=${tab}`); render(); }
      else if (el.dataset.cancel) { await post(`/api/guest/orders/${el.dataset.cancel}/cancel`); toast(t('orders.cancelled.toast')); await load(); }
      else if (el.dataset.pay) await openPay(`/api/guest/orders/${el.dataset.pay}/pay`, Number(el.dataset.due), company, load);
      else if (el.dataset.cancelBooking) {
        await busy(el, async () => { await post(`/api/guest/bookings/${el.dataset.cancelBooking}/cancel`); toast(t('book.cancelled')); await load(); })();
      }
    } catch (err) {
      toastError(err);
    }
  });
  void navigate;
  await load();
}

// ---------- activity ----------

const ACTIVITY_FILTERS = ['all', 'points', 'wallet', 'orders', 'requests'];

export async function mountActivity(root, { company }) {
  let filter = 'all';
  let items = [];
  const render = () => {
    const shown = filter === 'all' ? items : items.filter((i) => i.kind === filter);
    setHtml(root, html`${pageHead(t('act.title'))}
      <div class="g-chips" role="group">${ACTIVITY_FILTERS.map((f) => html`<button type="button" class="g-chip" data-filter="${f}" aria-pressed="${String(f === filter)}">${t(`act.${f}`)}</button>`)}</div>
      <div class="g-gap">${feedHtml(shown)}</div>`);
  };
  const load = async () => {
    if (!session.customer) { signInCard(root, load); return; }
    setHtml(root, skeleton(5));
    items = activityItems(await memberData(company));
    render();
  };
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    filter = b.dataset.filter;
    render();
  });
  await load();
}

// ---------- song requests ----------

export async function mountSongs(root, { company, stores, features = {} }) {
  if (!features.song) { setHtml(root, html`${pageHead(t('sg.title'))}<p class="g-empty">${t('sg.off')}</p>`); return; }
  const table = lastTable(company);
  const here = stores.length ? pickedStore({ company: { code: company }, stores }) : null;
  const load = async () => {
    if (!session.customer) { signInCard(root, load); return; }
    setHtml(root, skeleton(3));
    const mine = (await get(`/api/guest/requests/${enc(company)}`)).filter((r) => r.kind === 'song');
    const waiting = mine.filter((r) => r.status === 'pending').length;
    setHtml(root, html`<section class="g-songhero"><span class="g-songhero__icon">${icon('music')}</span>
        <h1 class="g-songhero__title">${t('sg.title')}</h1><p class="g-songhero__text">${t('sg.text')}</p></section>
      <form class="g-card" data-song novalidate>
        ${table ? html`<p class="g-pill">${icon('pin')}${t('sg.table', { table: table.tableName })}</p>`
          : stores.length > 1 ? html`<div class="g-field"><label for="ss">${t('sup.store')}</label><select id="ss" name="store">${stores.map((s) =>
            html`<option value="${s.code}" ${s.code === here?.code ? 'selected' : ''}>${s.name}</option>`)}</select><span class="g-hint">${t('sg.noTable')}</span></div>` : ''}
        <div class="g-field"><label for="st">${t('song.song')}</label><input id="st" name="title" maxlength="100" required></div>
        <div class="g-field"><label for="sa">${t('song.artist')}</label><input id="sa" name="artist" maxlength="100"></div>
        <div class="g-field"><label for="sm">${t('song.note')}</label><input id="sm" name="note" maxlength="200"></div>
        <p class="g-error" role="alert" hidden></p>
        <button type="submit" class="g-btn g-btn--primary g-btn--block">${icon('music')}${t('song.send')}</button></form>
      <div class="g-cathead"><h2 class="g-cat">${t('sg.mine')}</h2>${waiting > 0 && html`<span class="g-badge g-badge--pending">${t('sg.queue', { n: waiting })}</span>`}</div>
      <section class="g-card">${mine.length ? requestsHtml(mine) : html`<p class="g-muted">${t('sg.none')}</p>`}</section>`);
  };
  root.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-song]');
    if (!form) return;
    e.preventDefault();
    const err = form.querySelector('.g-error');
    err.hidden = true;
    const f = form.elements;
    const where = table ? { qrToken: table.token } : { company, store: f.store ? f.store.value : stores[0]?.code };
    try {
      await post('/api/guest/requests', { kind: 'song', ...where, title: f.title.value, artist: f.artist.value, note: f.note.value });
      toast(t('song.sent'), 'success');
      await load();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
  onCancelRequest(root, load);
  await load();
}
