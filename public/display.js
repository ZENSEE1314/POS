// Bar / kitchen display tab (出品台): open orders as big touch cards for a screen behind the bar. Tap an item when it is
// made; a "just served" strip keeps the last ones so a wrong tap can be put back.
import { t, addStrings } from './i18n.js';
import { get, post } from './session.js';
import { html, setHtml, fmtTime } from './util.js';
import { delegate, skeleton, emptyState, notifyError, pressed } from './ui.js';

const REFRESH_MS = 5_000;
const MINUTE_MS = 60_000;
const WARN_MINUTES = 10;
const LATE_MINUTES = 20;
const STATIONS = ['all', 'bar', 'kitchen'];
const STATION_KEY = 'nightpos.kds.station';

addStrings({
  en: {
    'nav.display': 'Bar display',
    'kds.station': 'Station', 'kds.station.all': 'All', 'kds.station.bar': 'Bar', 'kds.station.kitchen': 'Kitchen',
    'kds.fullscreen': 'Full screen', 'kds.exitFullscreen': 'Exit full screen', 'kds.serveAll': 'All served',
    'kds.waiting': '{n} min', 'kds.warn': 'Slow', 'kds.late': 'Overdue', 'kds.gift': 'Gift', 'kds.by': 'by {name}',
    'kds.none': 'Nothing to make. New orders appear here by themselves.', 'kds.recent': 'Just served', 'kds.undo': 'Put back',
    'kds.noRecent': 'Nothing served in the last 30 minutes.', 'kds.updated': 'Updated {time} · {n} tickets',
    'kds.tapHint': 'Tap an item when it is made.', 'kds.itemLabel': 'Mark {qty} × {name} as made',
  },
  zh: {
    'nav.display': '出品台',
    'kds.station': '出品站', 'kds.station.all': '全部', 'kds.station.bar': '吧台', 'kds.station.kitchen': '厨房',
    'kds.fullscreen': '全屏', 'kds.exitFullscreen': '退出全屏', 'kds.serveAll': '全部出品',
    'kds.waiting': '{n} 分钟', 'kds.warn': '较慢', 'kds.late': '超时', 'kds.gift': '赠送', 'kds.by': '{name} 下单',
    'kds.none': '暂无待出品。新单会自动出现在这里。', 'kds.recent': '刚出品', 'kds.undo': '撤回',
    'kds.noRecent': '最近 30 分钟没有出品。', 'kds.updated': '更新于 {time} · {n} 单',
    'kds.tapHint': '做好后点一下该商品即可出品。', 'kds.itemLabel': '{qty} × {name} 已出品',
  },
});

function readStation() {
  try {
    const saved = localStorage.getItem(STATION_KEY);
    return STATIONS.includes(saved) ? saved : 'all';
  } catch { return 'all'; }
}

function saveStation(station) {
  try { localStorage.setItem(STATION_KEY, station); } catch { /* storage blocked: the choice lasts until reload */ }
}

const minutesSince = (since, now) => Math.max(0, Math.floor((now - since) / MINUTE_MS));

function urgency(minutes) {
  if (minutes > LATE_MINUTES) return 'late';
  if (minutes > WARN_MINUTES) return 'warn';
  return 'ok';
}

const itemButton = (it) => html`<li><button type="button" class="kds-item" data-action="serve" data-id="${it.id}"
    aria-label="${t('kds.itemLabel', { qty: it.qty, name: it.name })}">
  <span class="kds-item__qty">${it.qty} ×</span><span class="kds-item__name">${it.name}</span>
  ${it.gift && html`<span class="badge badge--warning">${t('kds.gift')}</span>`}
  ${it.waiter && html`<span class="kds-item__by">${t('kds.by', { name: it.waiter })}</span>`}</button></li>`;

function ticketCard(tk, now) {
  const minutes = minutesSince(tk.since, now);
  const level = urgency(minutes);
  return html`<article class="kds-ticket kds-ticket--${level}" aria-labelledby="kds-t${tk.billId}">
    <header class="kds-ticket__head"><h3 id="kds-t${tk.billId}" class="kds-ticket__place">${tk.place}</h3>
      <span class="kds-ticket__wait">${t('kds.waiting', { n: minutes })}
        ${level !== 'ok' && html`<span class="badge badge--${level === 'late' ? 'danger' : 'warning'}"><span aria-hidden="true">!</span>${t(`kds.${level}`)}</span>`}</span></header>
    <ul class="kds-ticket__items">${tk.items.map(itemButton)}</ul>
    <button type="button" class="btn btn--primary btn--block" data-action="serveAll" data-id="${tk.billId}">${t('kds.serveAll')}</button>
  </article>`;
}

const recentStrip = (recent) => html`<section class="panel kds-recent" aria-labelledby="kds-recent-title">
  <h3 id="kds-recent-title" class="section-title">${t('kds.recent')}</h3>
  ${recent.length ? html`<ul class="kds-recent__list">${recent.map((it) => html`<li class="kds-recent__item">
      <span><b>${it.qty} × ${it.name}</b> <span class="muted">${it.place} · ${fmtTime(it.servedAt)}</span></span>
      <button type="button" class="btn btn--small btn--ghost" data-action="unserve" data-id="${it.id}">${t('kds.undo')}</button></li>`)}</ul>`
    : html`<p class="muted">${t('kds.noRecent')}</p>`}</section>`;

const fullscreenLabel = () => t(document.fullscreenElement ? 'kds.exitFullscreen' : 'kds.fullscreen');

function toggleFullscreen() {
  if (document.fullscreenElement) return document.exitFullscreen();
  return document.documentElement.requestFullscreen?.();
}

export function mountDisplay(root) {
  let station = readStation();
  let data = null;

  const render = () => {
    setHtml(root.querySelector('#kds-status'), html`${t('kds.updated', { time: fmtTime(data.at), n: data.tickets.length })}`);
    setHtml(root.querySelector('#kds-body'), html`
      ${data.tickets.length
        ? html`<p class="hint">${t('kds.tapHint')}</p><div class="kds-grid">${data.tickets.map((tk) => ticketCard(tk, data.at))}</div>`
        : html`<div class="panel">${emptyState(t('kds.none'))}</div>`}
      ${recentStrip(data.recent)}`);
  };

  const load = async () => {
    try {
      data = await get(`/api/kds?station=${station}`);
      render();
    } catch (e) { notifyError(e); }
  };

  const markServed = async (lineIds, served) => {
    await post('/api/kds/served', { lineIds, served });
    await load();
  };

  setHtml(root, html`<section aria-labelledby="kds-title">
    <div class="view-bar"><h2 id="kds-title" class="view-title">${t('nav.display')}</h2>
      <button type="button" class="btn btn--ghost" data-action="fullscreen">${fullscreenLabel()}</button></div>
    <div class="chips" role="group" aria-label="${t('kds.station')}">${STATIONS.map((s) =>
      html`<button type="button" class="chip" data-action="station" data-id="${s}" aria-pressed="${pressed(s === station)}">${t(`kds.station.${s}`)}</button>`)}</div>
    <p id="kds-status" class="muted" role="status" aria-live="polite"></p>
    <div id="kds-body">${skeleton(4)}</div></section>`);
  void load();
  const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, REFRESH_MS);
  const onFullscreen = () => { root.querySelector('[data-action=fullscreen]').textContent = fullscreenLabel(); };
  document.addEventListener('fullscreenchange', onFullscreen);

  delegate(root, {
    click: {
      station: (el) => {
        station = el.dataset.id;
        saveStation(station);
        root.querySelectorAll('[data-action=station]').forEach((b) => b.setAttribute('aria-pressed', pressed(b === el)));
        return load();
      },
      serve: (el) => markServed([Number(el.dataset.id)], true),
      serveAll: (el) => {
        const tk = data.tickets.find((x) => x.billId === Number(el.dataset.id));
        return markServed(tk.items.map((it) => it.id), true);
      },
      unserve: (el) => markServed([Number(el.dataset.id)], false),
      fullscreen: toggleFullscreen,
    },
  });
  return () => {
    clearInterval(timer);
    document.removeEventListener('fullscreenchange', onFullscreen);
  };
}
