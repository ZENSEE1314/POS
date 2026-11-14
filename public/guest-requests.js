// Requests from the customer app (calls for service, songs, stored bottles, messages, pet care) and the voucher checker.
import { t } from './i18n.js';
import { get, post } from './session.js';
import { html, fmtDate, fmtDateTime } from './util.js';
import { formDialog, emptyState, badge, toast } from './ui.js';

const MILLI_PER_BOTTLE = 1000;
const KIND_TONE = { service: 'warning', song: 'busy', bottle: 'success', support: 'neutral', pet: 'free' };
const STATUS_TONE = { pending: 'warning', done: 'success', declined: 'danger', cancelled: 'neutral' };
export const REQUEST_STATUSES = ['pending', 'done', 'declined'];

function detailHtml(r) {
  const d = r.detail;
  switch (r.kind) {
    case 'service': return html`<p><strong>${t(`gr.reason.${d.reason}`)}</strong>${d.note && html` · ${d.note}`}</p>`;
    case 'song': return html`<p><strong>“${d.title}”</strong>${d.artist && html` · ${d.artist}`}</p>${d.note && html`<p class="muted">${d.note}</p>`}`;
    case 'bottle': return html`<p><strong>${t('gr.bottle', { name: d.name, code: d.code, left: (d.leftMilli / MILLI_PER_BOTTLE).toFixed(2) })}</strong></p>${d.note && html`<p class="muted">${d.note}</p>`}`;
    case 'support': return html`<p class="guest-order__note">${d.message}</p>`;
    case 'pet': return html`<p><strong>${d.pet.name}</strong> (${t(`gr.species.${d.pet.species}`)}${d.pet.breed ? ` · ${d.pet.breed}` : ''}) · ${t(`gr.pet.${d.service}`)}</p>
      <p>${t('gr.when', { when: fmtDateTime(d.when) })}</p>${d.pet.notes && html`<p class="muted">${t('gr.notes', { notes: d.pet.notes })}</p>`}${d.note && html`<p class="muted">${d.note}</p>`}`;
    default: return '';
  }
}

export function requestCard(r) {
  const where = r.tableName ? t('guestOrders.table', { name: r.tableName }) : t('gr.at', { store: r.storeName });
  return html`<article class="panel guest-order">
    <div class="guest-order__head"><div><h3 class="section-title">${badge(t(`gr.kind.${r.kind}`), KIND_TONE[r.kind])} ${where}</h3>
      <p class="muted">${fmtDateTime(r.createdAt)} · ${r.guestName || t('guestOrders.guest')}${r.guestPhone ? ` · ${r.guestPhone}` : ''}</p></div>
      ${badge(t(`gr.status.${r.status}`), STATUS_TONE[r.status])}</div>
    ${detailHtml(r)}
    ${r.reply && html`<p class="muted">${t('gr.staffReply', { reply: r.reply })}</p>`}
    ${r.status === 'pending' && html`<div class="row"><button type="button" class="btn btn--primary" data-action="reqDone" data-id="${r.id}">${t('gr.done')}</button>
      <button type="button" class="btn btn--danger" data-action="reqDecline" data-id="${r.id}">${t('gr.decline')}</button></div>`}
  </article>`;
}

export const requestsList = (list) => (list.length ? list.map(requestCard) : emptyState(t('gr.empty')));

/** A reply is offered for messages and pet care, where the guest is waiting for an answer; a quick call is just done. */
export async function markDone(r, reload) {
  if (r.kind === 'support' || r.kind === 'pet') {
    await formDialog({
      title: t('gr.done'), submit: 'gr.done',
      fields: [{ name: 'reply', label: t('gr.reply'), type: 'textarea', hint: t('gr.replyHint') }],
      onSubmit: async (v) => { await post(`/api/guest-requests/${r.id}/done`, { reply: v.reply }); await reload(); },
    });
    return;
  }
  await post(`/api/guest-requests/${r.id}/done`, {});
  toast(t('gr.doneToast'), 'success');
  await reload();
}

export const decline = (r, reload) => formDialog({
  title: t('gr.decline'), intro: t('gr.declineIntro'), submit: 'gr.decline', danger: true,
  fields: [{ name: 'reply', label: t('guestOrders.reason'), required: true, type: 'textarea' }],
  onSubmit: async (v) => { await post(`/api/guest-requests/${r.id}/decline`, { reply: v.reply }); await reload(); },
});

/** Staff type the code the guest shows, see what it is for, then mark it used. */
export async function checkVoucher() {
  let found = null;
  const ok = await formDialog({
    title: t('voucher.check'), submit: 'voucher.check',
    fields: [{ name: 'code', label: t('voucher.code'), required: true, placeholder: 'ABCD2345' }],
    onSubmit: async (v) => { found = await get(`/api/vouchers/${encodeURIComponent(v.code.toUpperCase())}`); },
  });
  if (!ok || !found) return;
  const state = found.status === 'used' ? t('voucher.used', { date: fmtDate(found.usedAt) })
    : found.expired ? t('voucher.expired', { date: fmtDate(found.expiresAt) }) : t('voucher.valid', { date: fmtDate(found.expiresAt) });
  const usable = found.status === 'issued' && !found.expired;
  await formDialog({
    title: t('voucher.title', { code: found.code }),
    intro: `${found.title} · ${found.guestName || t('guestOrders.guest')}${found.guestPhone ? ` · ${found.guestPhone}` : ''} · ${state}${usable ? ` · ${t('voucher.intro')}` : ''}`,
    submit: usable ? 'voucher.use' : 'common.close',
    onSubmit: async () => {
      if (!usable) return;
      const used = await post(`/api/vouchers/${encodeURIComponent(found.code)}/use`, {});
      toast(t('voucher.usedToast', { title: used.title }), 'success');
    },
  });
}
