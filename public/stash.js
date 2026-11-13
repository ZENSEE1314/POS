// Stash (wine storage): search, store, retrieve to an open bill, transfer between stores.
import { t, tOr } from './i18n.js';
import { get, post, can, app } from './session.js';
import { html, setHtml, fmtDate, fmtBottles, productName, DAY } from './util.js';
import { delegate, formDialog, dataTable, badge, emptyState, notifyError, toast } from './ui.js';
import { printStashSlip } from './print/hooks.js';

export function mountStash(root) {
  const state = { q: '', results: null, products: [], tables: [], stores: [] };

  const expiry = (s) => {
    const days = Math.ceil((s.expires_at - Date.now()) / DAY);
    return days < 0
      ? badge(t('stash.expired'), 'danger', '✕')
      : html`${fmtDate(s.expires_at)} ${badge(t('stash.daysLeft', { n: days }), days <= 7 ? 'warning' : 'success', days <= 7 ? '!' : '✓')}`;
  };

  function actions(s) {
    return html`<div class="row">
      ${can('stash.write') && html`<button type="button" class="btn btn--small btn--primary" data-action="retrieve" data-id="${s.id}">${t('stash.retrieve')}</button>`}
      <button type="button" class="btn btn--small btn--ghost" data-action="printStash" data-id="${s.id}">${t('print.slip')}</button>
      ${can('admin.write') && html`<button type="button" class="btn btn--small btn--ghost" data-action="transfer" data-id="${s.id}">${t('stash.transfer')}</button>`}
    </div>`;
  }

  function resultsHtml() {
    if (state.results === null) return emptyState(t('stash.searchHint'));
    const cols = [
      { label: t('stash.code'), cell: (s) => html`<code>${s.code}</code>` },
      { label: t('stash.item'), cell: (s) => s.name },
      { label: t('floor.phone'), cell: (s) => s.phone },
      { label: t('stash.left'), cell: (s) => `${fmtBottles(s.left_milli)} / ${fmtBottles(s.qty_milli)}`, num: true },
      { label: t('stash.kind'), cell: (s) => tOr(`stashKind.${s.kind}`, s.kind) },
      { label: t('stash.expires'), cell: expiry },
      { label: t('common.actions'), cell: actions },
    ];
    return dataTable({ cols, rows: state.results, empty: t('stash.none'), caption: t('nav.stash') });
  }

  function render() {
    setHtml(root, html`<section aria-labelledby="st-title">
      <div class="view-bar"><h2 id="st-title" class="view-title">${t('nav.stash')}</h2>
        ${can('stash.write') && html`<button type="button" class="btn btn--primary" data-action="store">${t('stash.store')}</button>`}</div>
      <form class="panel search-bar" data-form="search" role="search">
        <div class="field field--grow"><label for="stash-q">${t('stash.search')}</label>
          <input id="stash-q" name="q" type="search" value="${state.q}" placeholder="${t('stash.searchPlaceholder')}" autocomplete="off"></div>
        <button type="submit" class="btn btn--primary">${t('common.search')}</button>
      </form>
      <div class="panel" id="stash-results">${resultsHtml()}</div></section>`);
  }

  async function search(q = state.q) {
    state.q = q;
    state.results = q ? await get(`/api/stash?q=${encodeURIComponent(q)}`) : null;
    setHtml(root.querySelector('#stash-results'), resultsHtml());
  }

  const find = (el) => state.results.find((s) => s.id === Number(el.dataset.id));

  const store = () => formDialog({
    title: t('stash.store'),
    fields: [
      { name: 'phone', label: t('floor.phone'), type: 'tel', required: true },
      { name: 'productId', label: t('stash.item'), type: 'select', required: true, options: state.products.map((p) => ({ value: p.id, label: productName(p) })) },
      { name: 'qty', label: t('stash.bottles'), type: 'qty', required: true, value: '1', hint: t('stash.bottlesHint') },
      { name: 'kind', label: t('stash.kind'), type: 'select', options: ['purchased', 'free'].map((k) => ({ value: k, label: tOr(`stashKind.${k}`, k) })) },
      { name: 'days', label: t('stash.days'), type: 'int', min: 1, hint: t('stash.daysHint') },
    ],
    submit: 'stash.store',
    onSubmit: async (v) => {
      const r = await post('/api/stash', { phone: v.phone, productId: Number(v.productId), qtyMilli: v.qty, kind: v.kind, days: v.days ?? undefined });
      toast(t('stash.stored', { code: r.code }), 'success');
      state.q = v.phone;
      render();
      await search(v.phone);
      const stored = state.results?.find((s) => s.code === r.code);
      if (stored) printStashSlip(stored, state.products, true);
    },
  });

  function retrieve(el) {
    const s = find(el);
    const bills = state.tables.filter((x) => x.bill_id);
    return formDialog({
      title: t('stash.retrieveTitle', { name: s.name }),
      intro: bills.length ? '' : t('stash.noOpenBills'),
      fields: [
        { name: 'qty', label: t('stash.bottles'), type: 'qty', required: true, value: fmtBottles(s.left_milli) },
        { name: 'billId', label: t('stash.toBill'), type: 'select', required: true, options: bills.map((x) => ({ value: x.bill_id, label: x.name })) },
      ],
      submit: 'stash.retrieve',
      onSubmit: async (v) => { await post(`/api/stash/${s.id}/retrieve`, { qtyMilli: v.qty, billId: Number(v.billId) }); await search(); },
    });
  }

  function transfer(el) {
    const s = find(el);
    const others = state.stores.filter((x) => x.active && x.id !== app.actor.storeId);
    const dest = others.length
      ? { name: 'to', label: t('stash.toStore'), type: 'select', required: true, options: others.map((x) => ({ value: x.id, label: x.name })) }
      : { name: 'to', label: t('stash.toStoreId'), type: 'int', required: true, min: 1 };
    return formDialog({
      title: t('stash.transfer'), submit: 'stash.transfer', fields: [dest],
      onSubmit: async (v) => { await post(`/api/stash/${s.id}/transfer`, { toStoreId: Number(v.to) }); await search(); },
    });
  }

  render();
  const loads = [get('/api/products'), get('/api/tables')];
  if (can('hq.read')) loads.push(get('/api/hq/stores'));
  Promise.all(loads).then(([products, tables, stores = []]) => {
    Object.assign(state, { products, tables, stores });
  }).catch(notifyError);

  delegate(root, {
    click: { store, retrieve, transfer, printStash: (el) => printStashSlip(find(el), state.products, false) },
    submit: { search: (form) => search(new FormData(form).get('q').trim()) },
  });
}
