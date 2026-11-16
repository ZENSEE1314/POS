// Admin > Broadcast: messages to staff (a banner on every till) or to customers (news on the customer app).
import { t } from './i18n.js';
import { get, post } from './session.js';
import { html, fmtDateTime } from './util.js';
import { formDialog, confirmDialog, dataTable, badge } from './ui.js';
import { hasModule } from './business.js';

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;

const audiences = () => (hasModule('guestApp') ? ['staff', 'guests'] : ['staff']);

function statusBadge(b) {
  if (b.stopped) return badge(t('bc.stopped'), 'neutral', '—');
  if (b.expiresAt <= Date.now()) return badge(t('bc.ended'), 'neutral', '—');
  return badge(t('bc.live'), 'success', '●');
}

export function broadcastSection(reload) {
  let rows = [];
  return {
    broadcasts: {
      load: async () => { rows = await get('/api/broadcasts'); return rows; },
      add: 'bc.new',
      view: (list) => dataTable({ caption: t('admin.broadcasts'), empty: t('bc.none'), rows: list, cols: [
        { label: t('bc.to'), cell: (b) => t(`bc.audience.${b.audience}`) },
        { label: t('bc.message'), cell: (b) => html`<strong>${b.title}</strong>${b.body && html`<br><span class="muted">${b.body}</span>`}` },
        { label: t('reports.store'), cell: (b) => b.storeName ?? t('admin.allStores') },
        { label: t('bc.by'), cell: (b) => b.author ?? '-' },
        { label: t('bc.sent'), cell: (b) => fmtDateTime(b.createdAt) },
        { label: t('bc.until'), cell: (b) => fmtDateTime(b.expiresAt) },
        { label: t('common.status'), cell: statusBadge },
        { label: t('common.actions'), cell: (b) => (!b.stopped && b.expiresAt > Date.now()
          ? html`<button type="button" class="btn btn--small btn--danger" data-action="stopBroadcast" data-id="${b.id}">${t('bc.stop')}</button>` : '') },
      ] }),
      dialog: () => formDialog({
        title: t('bc.new'), intro: t('bc.intro'), submit: 'bc.send',
        fields: [
          { name: 'audience', label: t('bc.to'), type: 'select', options: audiences().map((a) => ({ value: a, label: t(`bc.audience.${a}`) })) },
          { name: 'title', label: t('bc.title'), required: true, hint: t('bc.titleHint') },
          { name: 'body', label: t('bc.body'), type: 'textarea' },
          { name: 'days', label: t('bc.days'), type: 'int', min: 1, max: MAX_DAYS, value: DEFAULT_DAYS },
        ],
        onSubmit: async (v) => {
          await post('/api/broadcasts', { ...v, days: v.days ?? DEFAULT_DAYS });
          await reload();
        },
      }),
      actions: {
        stopBroadcast: async (el) => {
          const b = rows.find((x) => x.id === Number(el.dataset.id));
          if (!await confirmDialog({ title: t('bc.stop'), message: t('bc.stopAsk', { title: b.title }), danger: true, submit: 'bc.stop' })) return;
          await post(`/api/broadcasts/${b.id}/stop`);
          await reload();
        },
      },
    },
  };
}
