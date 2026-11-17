// HQ view: per-store roll-up with presets, plus owner tools (create store / staff, copy catalog).
import { t, tOr } from './i18n.js';
import { get, post, can } from './session.js';
import { html, setHtml, fmtMoney, startOfDay, daysAgo, DAY } from './util.js';
import { delegate, formDialog, dataTable, skeleton, notifyError, toast, pressed } from './ui.js';

const PRESETS = { today: 0, week: 6, month: 29 };
const STAFF_ROLES = ['host', 'waiter', 'cashier', 'manager', 'finance', 'owner'];
const TENANT_WIDE_ROLES = ['finance', 'owner'];
const NO_STORE = '';
let preset = 'today';

const storeOptions = (stores) => stores.map((s) => ({ value: s.id, label: `${s.name} (${s.code})` }));

export function mountHq(root) {
  let stores = [];

  async function loadSummary() {
    const body = root.querySelector('#hq-body');
    setHtml(body, skeleton(4));
    const from = daysAgo(PRESETS[preset]);
    const r = await get(`/api/hq/summary?from=${from}&to=${startOfDay() + DAY}`);
    const num = (key) => ({ label: t(`hq.${key}`), cell: (x) => x[key], num: true });
    const cols = [
      { label: t('reports.store'), cell: (x) => html`<strong>${x.name}</strong>` }, num('bills'),
      { label: t('reports.revenue'), cell: (x) => fmtMoney(x.revenue), num: true },
      { label: t('hq.credit'), cell: (x) => fmtMoney(x.credit), num: true },
      { label: t('reports.commission'), cell: (x) => fmtMoney(x.commission), num: true },
      num('openBills'), num('stashItems'),
    ];
    const tot = r.totals;
    setHtml(body, html`<div class="panel">${dataTable({ cols, rows: r.stores, empty: t('common.noData'), caption: t('nav.hq'),
      foot: [t('reports.total'), tot.bills, fmtMoney(tot.revenue), fmtMoney(tot.credit), fmtMoney(tot.commission), tot.openBills, ''] })}</div>`);
  }

  const createStore = () => formDialog({
    title: t('hq.createStore'),
    fields: [
      { name: 'name', label: t('admin.name'), required: true },
      { name: 'code', label: t('hq.storeCode'), required: true },
      { name: 'address', label: t('loc.address') },
      { name: 'city', label: t('loc.city') },
      { name: 'postalCode', label: t('loc.postal') },
      { name: 'douyinPoiId', label: t('hq.poi') },
      { name: 'copyFrom', label: t('hq.copyFrom'), type: 'select', options: [{ value: NO_STORE, label: t('hq.noCopy') }, ...storeOptions(stores)] },
    ],
    submit: 'common.create',
    onSubmit: async (v) => {
      await post('/api/hq/stores', { name: v.name, code: v.code, city: v.city ?? '', address: v.address ?? '', postalCode: v.postalCode ?? '', douyinPoiId: v.douyinPoiId || undefined, copyCatalogFrom: v.copyFrom ? Number(v.copyFrom) : undefined });
      await refresh();
    },
  });

  const createStaff = () => formDialog({
    title: t('hq.createStaff'),
    fields: [
      { name: 'name', label: t('admin.name'), required: true },
      { name: 'username', label: t('login.username'), required: true, hint: t('hq.usernameHint') },
      { name: 'role', label: t('reports.role'), type: 'select', options: STAFF_ROLES.map((r) => ({ value: r, label: tOr(`role.${r}`, r) })) },
      { name: 'pin', label: t('login.pin'), type: 'pin', required: true },
      { name: 'storeId', label: t('reports.store'), type: 'select', hint: t('hq.storeHint'), options: [{ value: NO_STORE, label: t('admin.allStores') }, ...storeOptions(stores)] },
    ],
    submit: 'common.create',
    onSubmit: async (v) => {
      const storeId = TENANT_WIDE_ROLES.includes(v.role) ? undefined : Number(v.storeId);
      await post('/api/hq/staff', { name: v.name, username: v.username, role: v.role, pin: v.pin, storeId });
      toast(t('hq.staffCreated', { name: v.name }), 'success');
    },
  });

  const copyCatalog = () => formDialog({
    title: t('hq.copyCatalog'),
    intro: t('hq.copyHint'),
    fields: [
      { name: 'from', label: t('hq.copyFrom'), type: 'select', required: true, options: storeOptions(stores) },
      { name: 'to', label: t('hq.copyTo'), type: 'checks', options: storeOptions(stores) },
    ],
    submit: 'hq.copy',
    onSubmit: async (v) => {
      if (!v.to.length) throw new Error(t('hq.pickStores'));
      const r = await post('/api/hq/catalog/copy', { fromStoreId: Number(v.from), toStoreIds: v.to.map(Number) });
      toast(t('hq.copied', { products: r.products, stores: r.stores }), 'success');
    },
  });

  async function refresh() {
    stores = await get('/api/hq/stores');
    await loadSummary();
  }

  setHtml(root, html`<section aria-labelledby="hq-title">
    <div class="view-bar"><h2 id="hq-title" class="view-title">${t('nav.hq')}</h2>
      ${can('hq.write') && html`<div class="row">
        <button type="button" class="btn btn--primary" data-action="createStore">${t('hq.createStore')}</button>
        <button type="button" class="btn btn--ghost" data-action="createStaff">${t('hq.createStaff')}</button>
        <button type="button" class="btn btn--ghost" data-action="copyCatalog">${t('hq.copyCatalog')}</button></div>`}</div>
    <div class="chips" role="group" aria-label="${t('hq.range')}">${Object.keys(PRESETS).map((p) =>
      html`<button type="button" class="chip" data-action="preset" data-id="${p}" aria-pressed="${pressed(p === preset)}">${t(`hq.${p}`)}</button>`)}</div>
    <div id="hq-body"></div></section>`);
  refresh().catch(notifyError);

  delegate(root, {
    click: {
      preset: (el) => {
        preset = el.dataset.id;
        root.querySelectorAll('[data-action=preset]').forEach((b) => b.setAttribute('aria-pressed', pressed(b === el)));
        return loadSummary();
      },
      createStore, createStaff, copyCatalog,
    },
  });
}
