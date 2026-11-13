// Guest orders view: orders customers send from the table QR page; staff accept (onto the table's bill) or reject.
import { t } from './i18n.js';
import { get, post } from './session.js';
import { html, setHtml, fmtMoney, fmtTime, fmtDateTime } from './util.js';
import { delegate, formDialog, emptyState, skeleton, notifyError, toast, badge, pressed } from './ui.js';
import { repField } from './reps.js';
import { navigate } from './nav.js';
import { selectBillOnMount } from './floor-state.js';
import { queueTicketLine } from './print/hooks.js';

const STATUSES = ['pending', 'accepted', 'rejected'];
/** Fired after this view reloads, so the tab's waiting-count badge updates at once. */
export const GUEST_ORDERS_CHANGED = 'nightpos:guest-orders';
const POLL_MS = 10_000;
const TONE = { pending: 'warning', accepted: 'success', rejected: 'danger', cancelled: 'neutral' };

const itemName = (i) => (i.nameEn ? html`${i.name} <span class="muted">${i.nameEn}</span>` : i.name);

export function mountGuestOrders(root) {
  const state = { status: 'pending', orders: [], reps: null };

  function card(o) {
    const total = o.items.reduce((s, i) => s + i.qty * i.unitPrice, 0);
    return html`<article class="panel guest-order">
      <div class="guest-order__head"><div><h3 class="section-title">${t('guestOrders.table', { name: o.tableName })}</h3>
        <p class="muted">${fmtDateTime(o.createdAt)} · ${o.guestName || t('guestOrders.guest')}${o.guestPhone ? ` · ${o.guestPhone}` : ''}</p></div>
        ${badge(t(`guestOrders.status.${o.status}`), TONE[o.status])}</div>
      <ul class="guest-order__items">${o.items.map((i) => html`<li><span>${itemName(i)} × ${i.qty}</span><span class="num">${fmtMoney(i.qty * i.unitPrice)}</span></li>`)}</ul>
      <p class="guest-order__total"><span>${t('floor.total')}</span><strong class="num">${fmtMoney(total)}</strong></p>
      ${o.note && html`<p class="guest-order__note">${t('guestOrders.note')}: ${o.note}</p>`}
      ${o.rejectReason && html`<p class="muted">${t('guestOrders.reason')}: ${o.rejectReason}</p>`}
      ${o.status === 'pending' && html`<p class="muted">${o.openBillId ? t('guestOrders.addsToBill', { id: o.openBillId }) : t('guestOrders.opensTable')}</p>
        <div class="row"><button type="button" class="btn btn--primary" data-action="accept" data-id="${o.id}">${t('guestOrders.accept')}</button>
        <button type="button" class="btn btn--danger" data-action="reject" data-id="${o.id}">${t('guestOrders.reject')}</button></div>`}
      ${o.status === 'accepted' && o.billId && html`<button type="button" class="btn btn--small btn--ghost" data-action="openBill" data-id="${o.billId}">${t('guestOrders.openBill')} · ${fmtTime(o.decidedAt)}</button>`}
    </article>`;
  }

  function render() {
    setHtml(root, html`<section aria-labelledby="go-title">
      <div class="view-bar"><h2 id="go-title" class="view-title">${t('nav.orders')}</h2>
        <button type="button" class="btn btn--ghost" data-action="refresh">${t('common.refresh')}</button></div>
      <p class="muted">${t('guestOrders.intro')}</p>
      <div class="chips" role="group" aria-label="${t('common.status')}">${STATUSES.map((s) =>
        html`<button type="button" class="chip" data-action="status" data-id="${s}" aria-pressed="${pressed(state.status === s)}">${t(`guestOrders.status.${s}`)}</button>`)}</div>
      <div class="guest-orders" aria-live="polite">${state.orders.length ? state.orders.map(card) : emptyState(t(`guestOrders.empty.${state.status}`), state.status === 'pending' ? t('guestOrders.emptyHint') : '')}</div>
    </section>`);
  }

  const load = async () => {
    state.orders = await get(`/api/guest-orders?status=${state.status}`);
    render();
    window.dispatchEvent(new Event(GUEST_ORDERS_CHANGED));
  };
  const find = (el) => state.orders.find((o) => o.id === Number(el.dataset.id));

  async function accept(el) {
    const o = find(el);
    let result = null;
    const send = async (repId) => {
      result = await post(`/api/guest-orders/${o.id}/accept`, repId ? { repId } : {});
    };
    if (o.openBillId) {
      el.disabled = true;
      try { await send(); } finally { el.disabled = false; }
    } else {
      state.reps ??= await get('/api/reps');
      const ok = await formDialog({
        title: t('guestOrders.openTitle', { name: o.tableName }),
        intro: t('guestOrders.openIntro'),
        fields: [repField(state.reps)],
        submit: 'guestOrders.accept',
        onSubmit: async (v) => send(Number(v.rep)),
      });
      if (!ok) return;
    }
    // Kitchen/bar tickets print exactly as if staff had keyed the items in.
    for (const i of o.items) queueTicketLine({ billId: result.billId, product: { id: i.productId, name: i.name, name_en: i.nameEn, station: i.station }, qty: i.qty, table: o.tableName });
    toast(t('guestOrders.accepted', { name: o.tableName }), 'success');
    await load();
  }

  const reject = (el) => {
    const o = find(el);
    return formDialog({
      title: t('guestOrders.reject'),
      intro: t('guestOrders.rejectIntro'),
      fields: [{ name: 'reason', label: t('guestOrders.reason'), required: true, placeholder: t('guestOrders.reasonPh') }],
      submit: 'guestOrders.reject',
      danger: true,
      onSubmit: async (v) => { await post(`/api/guest-orders/${o.id}/reject`, { reason: v.reason }); await load(); },
    });
  };

  setHtml(root, skeleton(4));
  load().catch(notifyError);
  const timer = setInterval(() => {
    if (state.status === 'pending' && document.visibilityState === 'visible' && !document.querySelector('dialog[open]')) load().catch(() => {});
  }, POLL_MS);
  delegate(root, {
    click: {
      status: (el) => { state.status = el.dataset.id; return load(); },
      refresh: load,
      accept,
      reject,
      openBill: (el) => { selectBillOnMount(Number(el.dataset.id)); navigate('floor'); },
    },
  });
  return () => clearInterval(timer);
}
