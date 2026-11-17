// Host desk tab (咨客台): every table as a card for the person at the door. Open tables show the sales rep, department,
// guest, time open, spend and what is still short of the minimum; free tables can be held (locked) for a guest on the way.
import { t, tOr } from './i18n.js';
import { get, post, can } from './session.js';
import { html, setHtml, fmtMoney, fmtTime } from './util.js';
import { delegate, formDialog, infoDialog, skeleton, notifyError, pressed } from './ui.js';
import { navigate } from './nav.js';

const REFRESH_MS = 20_000;
const SORTS = ['name', 'spent', 'shortfall', 'opened'];
const ALL = '';

let zone = ALL;
let sort = 'name';
let desk = null;

const compare = {
  name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
  spent: (a, b) => (b.bill?.spent ?? -1) - (a.bill?.spent ?? -1),
  shortfall: (a, b) => (b.bill?.shortfall ?? -1) - (a.bill?.shortfall ?? -1),
  opened: (a, b) => (a.bill?.openedAt ?? Infinity) - (b.bill?.openedAt ?? Infinity),
};

const shortMoney = (fen) => fmtMoney(fen).replace(/\.00$/, '');

function cardBody(tb) {
  if (tb.bill) {
    const b = tb.bill;
    return html`<span class="hd-card__time">${fmtTime(b.openedAt)}</span>
      ${b.shortfall > 0 && html`<span class="hd-card__short">${t('host.short', { amount: shortMoney(b.shortfall) })}</span>`}
      <strong class="hd-card__spent">${shortMoney(b.spent)}</strong>
      ${b.guestName || b.guestPhone ? html`<span>${b.guestName ?? ''}${b.guestName && b.guestPhone ? ' / ' : ''}${b.guestPhone ?? ''}</span>` : ''}
      <span>${b.repName}</span>${b.departmentName && html`<span class="hd-card__muted">${b.departmentName}</span>`}`;
  }
  if (tb.lock) return html`<span class="hd-card__tag">${t('host.locked')}</span>${tb.lock.note && html`<span>${tb.lock.note}</span>`}<span class="hd-card__muted">${tb.lock.by ?? ''}</span>`;
  const next = tb.bookings[0];
  if (next) return html`<span class="hd-card__tag">${t('host.bookedAt', { time: fmtTime(next.eta) })}</span><span>${next.name || next.phone}</span>${next.repName && html`<span class="hd-card__muted">${next.repName}</span>`}`;
  return html`<span class="hd-card__muted">${tb.minSpend ? t('host.min', { amount: shortMoney(tb.minSpend) }) : t('host.noMin')}</span>`;
}

const card = (tb) => html`<button type="button" class="hd-card hd-card--${tb.state}" data-action="table" data-id="${tb.id}"
    aria-label="${tb.name} · ${t(`host.state.${tb.state}`)}">
  <span class="hd-card__name">${tb.name}</span>${cardBody(tb)}</button>`;

function render(root) {
  const zones = [...new Set(desk.tables.map((x) => x.zone || '—'))];
  const shown = desk.tables.filter((x) => zone === ALL || (x.zone || '—') === zone).sort(compare[sort]);
  const byZone = new Map();
  for (const tb of shown) byZone.set(tb.zone || '—', [...(byZone.get(tb.zone || '—') ?? []), tb]);
  const s = desk.summary;
  setHtml(root.querySelector('#hd-body'), html`
    <div class="hd-summary" role="status">
      <span><b>${s.open}</b> ${t('host.state.open')}</span><span><b>${s.free}</b> ${t('host.state.free')}</span>
      <span><b>${s.booked}</b> ${t('host.state.booked')}</span><span><b>${s.locked}</b> ${t('host.state.locked')}</span>
      <span><b>${shortMoney(s.spent)}</b> ${t('host.spent')}</span>${s.shortfall > 0 && html`<span class="hd-summary__short"><b>${shortMoney(s.shortfall)}</b> ${t('host.shortTotal')}</span>`}
      <span class="muted">${t('host.updated', { time: fmtTime(s.at) })}</span></div>
    <div class="search-bar">
      <div class="chips" role="group" aria-label="${t('host.zone')}">
        <button type="button" class="chip" data-action="zone" data-zone="" aria-pressed="${pressed(zone === ALL)}">${t('common.all')}</button>
        ${zones.map((z) => html`<button type="button" class="chip" data-action="zone" data-zone="${z}" aria-pressed="${pressed(zone === z)}">${z}</button>`)}</div>
      <div class="field"><label for="hd-sort">${t('host.sort')}</label><select id="hd-sort" data-action="sort">
        ${SORTS.map((k) => html`<option value="${k}" ${k === sort ? 'selected' : ''}>${t(`host.sort.${k}`)}</option>`)}</select></div></div>
    ${desk.unassigned.length > 0 && html`<div class="panel"><h3 class="section-title">${t('host.unassigned')}</h3><ul class="hd-list">${desk.unassigned.map((k) =>
      html`<li><b>${fmtTime(k.eta)}</b> ${k.name || k.phone} · ${t('host.party', { n: k.partySize })}${k.repName && html` · ${k.repName}`}</li>`)}</ul></div>`}
    ${[...byZone].map(([z, list]) => html`<h3 class="section-title">${z} <span class="muted">${t('host.tables', { n: list.length })}</span></h3>
      <div class="hd-grid">${list.map(card)}</div>`)}
    <p class="hint">${t('host.legend')}</p>`);
}

function details(tb) {
  const b = tb.bill;
  const rows = [
    [t('host.rep'), `${b.repName}${b.departmentName ? ` · ${b.departmentName}` : ''}`],
    [t('host.guest'), `${b.guestName ?? ''} ${b.guestPhone ?? ''}`.trim() || '—'],
    [t('host.opened'), fmtTime(b.openedAt)],
    [t('host.spent'), fmtMoney(b.spent)],
    [t('host.minimum'), fmtMoney(tb.minSpend)],
    [t('host.shortTotal'), fmtMoney(b.shortfall)],
    [t('host.items'), String(b.items)],
  ];
  infoDialog(`${tb.name} · ${tOr(`host.state.${tb.state}`, tb.state)}`, html`<dl class="hd-details">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
    <p class="hint">${t('host.toFloor')}</p>`);
}

export function mountHostDesk(root) {
  setHtml(root, html`<section aria-labelledby="hd-title"><h2 id="hd-title" class="view-title">${t('nav.host')}</h2>
    <div id="hd-body" aria-live="polite">${skeleton(6)}</div></section>`);
  const load = async () => {
    try {
      desk = await get('/api/host-desk');
      render(root);
    } catch (e) { notifyError(e); }
  };
  void load();
  const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, REFRESH_MS);

  const tableOf = (el) => desk.tables.find((x) => x.id === Number(el.dataset.id));
  delegate(root, {
    click: {
      zone: (el) => { zone = el.dataset.zone; render(root); },
      table: async (el) => {
        const tb = tableOf(el);
        if (tb.bill) { details(tb); return; }
        if (!can('booking.create')) { navigate('floor'); return; }
        if (tb.lock) {
          if (await formDialog({ title: t('host.unlockTitle', { name: tb.name }), intro: t('host.unlockIntro'), submit: 'host.unlock', onSubmit: async () => {
            await post(`/api/tables/${tb.id}/lock`, { locked: false });
          } })) await load();
          return;
        }
        if (await formDialog({
          title: t('host.lockTitle', { name: tb.name }), intro: t('host.lockIntro'), submit: 'host.lock',
          fields: [{ name: 'note', label: t('host.lockNote'), hint: t('host.lockNoteHint') }],
          onSubmit: async (v) => { await post(`/api/tables/${tb.id}/lock`, { locked: true, note: v.note }); },
        })) await load();
      },
    },
    change: { sort: (el) => { sort = el.value; render(root); } },
  });
  return () => clearInterval(timer);
}

