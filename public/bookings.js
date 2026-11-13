// Bookings view: list, manual create, confirm, cancel / no-show, open table from booking.
import { t, tOr } from './i18n.js';
import { get, post, can } from './session.js';
import { html, setHtml, fmtDateTime, byId } from './util.js';
import { delegate, formDialog, confirmDialog, dataTable, badge, skeleton, notifyError } from './ui.js';
import { repField } from './reps.js';
import { navigate } from './nav.js';
import { selectBillOnMount } from './floor-state.js';

const DEFAULT_PARTY = 2;
const STATUS_TONE = { submitted: 'warning', confirmed: 'success' };
const HOUR_MS = 60 * 60 * 1000;

export function mountBookings(root) {
  const state = { bookings: [], tables: [], staff: [] };

  const tableOptions = (tables, placeholder) => [{ value: '', label: placeholder }, ...tables.map((x) => ({ value: x.id, label: x.name }))];
  const freeTables = () => state.tables.filter((x) => x.status === 'free');

  function actions(b) {
    const buttons = [];
    if (can('booking.create') && b.status === 'submitted') buttons.push(['confirm', 'bookings.confirm', 'btn--primary']);
    if (can('table.open')) buttons.push(['openTable', 'bookings.openTable', 'btn--primary']);
    if (can('booking.create')) buttons.push(['cancel', 'bookings.cancel', 'btn--ghost'], ['noShow', 'bookings.noShow', 'btn--ghost']);
    return html`<div class="row">${buttons.map(([action, label, cls]) =>
      html`<button type="button" class="btn btn--small ${cls}" data-action="${action}" data-id="${b.id}">${t(label)}</button>`)}</div>`;
  }

  function render() {
    const tables = byId(state.tables);
    const cols = [
      { label: t('bookings.eta'), cell: (b) => fmtDateTime(b.eta) },
      { label: t('bookings.guest'), cell: (b) => html`<strong>${b.name || '-'}</strong><br><span class="muted">${b.phone}</span>${b.note && html`<br><span class="muted">“${b.note}”</span>`}` },
      { label: t('bookings.party'), cell: (b) => b.party_size, num: true },
      { label: t('bookings.source'), cell: (b) => tOr(`source.${b.source}`, b.source) },
      { label: t('bookings.table'), cell: (b) => tables.get(b.table_id)?.name ?? '-' },
      { label: t('bookings.status'), cell: (b) => badge(tOr(`bookingStatus.${b.status}`, b.status), STATUS_TONE[b.status] ?? 'neutral') },
      { label: t('common.actions'), cell: actions },
    ];
    setHtml(root, html`<section aria-labelledby="bk-title">
      <div class="view-bar"><h2 id="bk-title" class="view-title">${t('nav.bookings')}</h2>
        ${can('booking.create') && html`<button type="button" class="btn btn--primary" data-action="create">${t('bookings.create')}</button>`}</div>
      <div class="panel">${dataTable({ cols, rows: state.bookings, empty: t('bookings.empty'), caption: t('nav.bookings') })}</div></section>`);
  }

  async function load() {
    const loads = [get('/api/bookings'), get('/api/tables')];
    loads.push(get('/api/reps'));
    [state.bookings, state.tables, state.staff = []] = await Promise.all(loads);
    render();
  }

  const find = (el) => state.bookings.find((b) => b.id === Number(el.dataset.id));
  const nullable = (v) => (v ? Number(v) : undefined);

  const create = () => formDialog({
    title: t('bookings.create'),
    fields: [
      { name: 'phone', label: t('floor.phone'), type: 'tel', required: true },
      { name: 'name', label: t('bookings.name'), type: 'text' },
      { name: 'partySize', label: t('bookings.party'), type: 'int', min: 1, value: DEFAULT_PARTY },
      { name: 'eta', label: t('bookings.eta'), type: 'datetime', required: true, value: Date.now() + HOUR_MS },
      { name: 'tableId', label: t('bookings.table'), type: 'select', options: tableOptions(state.tables, t('bookings.noTable')) },
      repField(state.staff, { required: false }),
    ],
    submit: 'common.create',
    onSubmit: async (v) => {
      await post('/api/bookings', { phone: v.phone, name: v.name, partySize: v.partySize ?? DEFAULT_PARTY, eta: v.eta, tableId: nullable(v.tableId), repId: nullable(v.rep) });
      await load();
    },
  });

  const confirm = (el) => {
    const b = find(el);
    return formDialog({
      title: t('bookings.confirm'),
      fields: [
        { name: 'tableId', label: t('bookings.table'), type: 'select', required: true, value: b.table_id ?? '', options: tableOptions(freeTables(), t('bookings.chooseTable')) },
        repField(state.staff, { value: b.rep_id ?? '' }),
      ],
      submit: 'bookings.confirm',
      onSubmit: async (v) => { await post(`/api/bookings/${b.id}/confirm`, { tableId: Number(v.tableId), repId: Number(v.rep) }); await load(); },
    });
  };

  async function openTable(el) {
    const b = find(el);
    let billId = null;
    const ok = await formDialog({
      title: t('bookings.openTable'),
      fields: [
        { name: 'tableId', label: t('bookings.table'), type: 'select', required: true, value: b.table_id ?? '', options: tableOptions(freeTables().concat(state.tables.filter((x) => x.id === b.table_id && x.status !== 'free')), t('bookings.chooseTable')) },
        repField(state.staff, { value: b.rep_id ?? '' }),
      ],
      submit: 'floor.open',
      onSubmit: async (v) => { ({ billId } = await post('/api/bills', { tableId: Number(v.tableId), repId: nullable(v.rep), bookingId: b.id })); },
    });
    if (!ok) return;
    selectBillOnMount(billId);
    navigate('floor');
  }

  const cancel = (noShow) => async (el) => {
    const b = find(el);
    const key = noShow ? 'bookings.noShow' : 'bookings.cancel';
    if (!await confirmDialog({ title: t(key), message: t('bookings.cancelAsk', { name: b.name || b.phone }), danger: true, submit: key })) return;
    await post(`/api/bookings/${b.id}/cancel`, { noShow });
    await load();
  };

  setHtml(root, skeleton(5));
  load().catch(notifyError);
  delegate(root, { click: { create, confirm, openTable, cancel: cancel(false), noShow: cancel(true) } });
}
