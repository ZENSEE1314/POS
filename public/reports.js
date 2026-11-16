// Reports view: daily report, commission, attendance, salary, shifts, receivables (with collection) and activity log.
import { t, tOr } from './i18n.js';
import { get, post, can } from './session.js';
import { html, setHtml, fmtMoney, fmtDateTime, toDateInput, dayRange, daysAgo } from './util.js';
import { delegate, formDialog, dataTable, badge, skeleton, notifyError, toast, pressed } from './ui.js';
import { peopleSections, peopleLoaders, peopleActions } from './people-reports.js';

const WEEK_DAYS = 7;
const COLLECT_METHODS = ['cash', 'wechat', 'alipay', 'transfer'];
const methodLabel = (m) => tOr(`pay.${m}`, m);
const rangeForm = (from, to, extra = '') => html`<form class="panel search-bar" data-form="range">
  <div class="field"><label for="r-from">${t(to === null ? 'reports.date' : 'reports.from')}</label><input id="r-from" name="from" type="date" value="${from}" required></div>
  ${to !== null && html`<div class="field"><label for="r-to">${t('reports.to')}</label><input id="r-to" name="to" type="date" value="${to}" required></div>`}
  ${extra}<button type="submit" class="btn btn--primary">${t('common.refresh')}</button></form>`;

const stat = (label, value) => html`<div class="stat"><span class="stat__label">${label}</span><strong class="stat__value">${value}</strong></div>`;

const SECTIONS = [
  { id: 'daily', perm: 'audit.read' },
  { id: 'payroll', perm: 'payroll.read' },
  ...peopleSections,
  { id: 'shifts', perm: 'audit.read' },
  { id: 'receivables', perm: 'payroll.read' },
  { id: 'audit', perm: 'audit.read' },
];

const loaders = {
  async daily(el, form) {
    const day = form?.get('from') ?? toDateInput(Date.now());
    const { from, to } = dayRange(day);
    const r = await get(`/api/reports/daily?from=${from}&to=${to}`);
    setHtml(el, html`${rangeForm(day, null)}
      <div class="stats">${stat(t('reports.bills'), r.bills)}${stat(t('reports.revenue'), fmtMoney(r.revenue))}
        ${stat(t('reports.voids'), r.voids)}${stat(t('reports.gifts'), r.gifts)}${stat(t('reports.discounts'), r.discounts)}</div>
      <div class="split">
        <div class="panel"><h3 class="section-title">${t('reports.byMethod')}</h3>${dataTable({ caption: t('reports.byMethod'), empty: t('common.noData'), rows: r.byMethod,
          cols: [{ label: t('reports.method'), cell: (x) => methodLabel(x.method) }, { label: t('reports.count'), cell: (x) => x.n, num: true }, { label: t('reports.amount'), cell: (x) => fmtMoney(x.amount), num: true }] })}</div>
        <div class="panel"><h3 class="section-title">${t('reports.topItems')}</h3>${dataTable({ caption: t('reports.topItems'), empty: t('common.noData'), rows: r.topItems,
          cols: [{ label: t('stash.item'), cell: (x) => x.name }, { label: t('floor.qty'), cell: (x) => x.qty, num: true }, { label: t('reports.amount'), cell: (x) => fmtMoney(x.amount), num: true }] })}</div>
      </div>`);
  },

  async payroll(el, form) {
    const from = form?.get('from') ?? toDateInput(daysAgo(WEEK_DAYS));
    const to = form?.get('to') ?? toDateInput(Date.now());
    const all = form ? form.get('all') === 'on' : false;
    const range = dayRange(from, to);
    const [rows, stores] = await Promise.all([get(`/api/payroll?from=${range.from}&to=${range.to}${all ? '&all=1' : ''}`), get('/api/hq/stores')]);
    const storeName = (id) => stores.find((s) => s.id === id)?.name ?? `#${id}`;
    const allBox = html`<label class="check"><input type="checkbox" name="all" ${all ? 'checked' : ''}><span>${t('reports.allStores')}</span></label>`;
    setHtml(el, html`${rangeForm(from, to, allBox)}<div class="panel">${dataTable({ caption: t('reports.payroll'), empty: t('common.noData'), rows,
      cols: [{ label: t('reports.employee'), cell: (x) => x.name }, { label: t('reports.role'), cell: (x) => tOr(`commRole.${x.role}`, x.role) },
        { label: t('reports.store'), cell: (x) => storeName(x.storeId) }, { label: t('reports.bills'), cell: (x) => x.bills, num: true },
        { label: t('reports.commission'), cell: (x) => fmtMoney(x.commission), num: true }],
      foot: rows.length ? [t('reports.total'), '', '', rows.reduce((a, x) => a + x.bills, 0), fmtMoney(rows.reduce((a, x) => a + x.commission, 0))] : null })}</div>`);
  },

  async shifts(el) {
    const rows = await get('/api/shifts');
    const variance = (s) => (s.variance === null ? '-' : html`${fmtMoney(s.variance)} ${s.variance === 0 ? t('shift.balanced') : s.variance > 0 ? t('shift.over') : t('shift.short')}`);
    setHtml(el, html`<div class="panel">${dataTable({ caption: t('reports.shifts'), empty: t('common.noData'), rows,
      cols: [{ label: t('reports.cashier'), cell: (s) => s.cashier }, { label: t('reports.opened'), cell: (s) => fmtDateTime(s.opened_at) },
        { label: t('reports.closed'), cell: (s) => (s.closed_at ? fmtDateTime(s.closed_at) : badge(t('shift.stillOpen'), 'warning', '●')) },
        { label: t('shift.openingCash'), cell: (s) => fmtMoney(s.opening_cash), num: true },
        { label: t('shift.expected'), cell: (s) => (s.expected_cash === null ? '-' : fmtMoney(s.expected_cash)), num: true },
        { label: t('shift.counted'), cell: (s) => (s.counted_cash === null ? '-' : fmtMoney(s.counted_cash)), num: true },
        { label: t('shift.variance'), cell: variance, num: true }] })}</div>`);
  },

  async receivables(el) {
    const rows = await get('/api/receivables');
    const outstanding = (r) => r.amount - r.collected;
    setHtml(el, html`<div class="panel">${dataTable({ caption: t('reports.receivables'), empty: t('common.noData'), rows,
      cols: [{ label: t('reports.bill'), cell: (r) => `#${r.billId}` }, { label: t('floor.phone'), cell: (r) => r.phone ?? '-' },
        { label: t('reports.opened'), cell: (r) => fmtDateTime(r.createdAt) },
        { label: t('reports.amount'), cell: (r) => fmtMoney(r.amount), num: true }, { label: t('reports.collected'), cell: (r) => fmtMoney(r.collected), num: true },
        { label: t('reports.outstanding'), cell: (r) => fmtMoney(outstanding(r)), num: true },
        { label: t('common.actions'), cell: (r) => (outstanding(r) > 0
          ? html`<button type="button" class="btn btn--small btn--primary" data-action="collect" data-id="${r.paymentId}" data-due="${outstanding(r)}">${t('reports.collect')}</button>`
          : badge(t('reports.cleared'), 'success', '✓')) }] })}</div>`);
  },
  ...peopleLoaders,
};

let active = null;

export function mountReports(root) {
  const sections = SECTIONS.filter((s) => can(s.perm));
  if (!sections.some((s) => s.id === active)) active = sections[0]?.id;

  setHtml(root, html`<section aria-labelledby="rp-title"><h2 id="rp-title" class="view-title">${t('nav.reports')}</h2>
    <div class="chips" role="group" aria-label="${t('nav.reports')}">${sections.map((s) =>
      html`<button type="button" class="chip" data-action="section" data-id="${s.id}" aria-pressed="${pressed(s.id === active)}">${t(`reports.${s.id}`)}</button>`)}</div>
    <div id="rp-body" aria-live="polite">${skeleton(5)}</div></section>`);
  const body = root.querySelector('#rp-body');

  const load = (form) => loaders[active](body, form).catch((e) => { setHtml(body, html``); notifyError(e); });
  // After an edit, redraw with the filters still on screen.
  const reload = () => {
    const form = body.querySelector('form[data-form=range]');
    return load(form ? new FormData(form) : undefined);
  };
  load();

  delegate(root, {
    click: {
      ...peopleActions(body, reload),
      section: (el) => {
        active = el.dataset.id;
        root.querySelectorAll('[data-action=section]').forEach((b) => b.setAttribute('aria-pressed', pressed(b === el)));
        setHtml(body, skeleton(5));
        return load();
      },
      collect: (el) => formDialog({
        title: t('reports.collect'),
        fields: [
          { name: 'amount', label: t('reports.amount'), type: 'money', required: true, value: (Number(el.dataset.due) / 100).toFixed(2) },
          { name: 'method', label: t('reports.method'), type: 'select', options: COLLECT_METHODS.map((m) => ({ value: m, label: tOr(`collect.${m}`, m) })) },
        ],
        submit: 'reports.collect',
        onSubmit: async (v) => {
          const r = await post(`/api/receivables/${el.dataset.id}/collect`, { amount: v.amount, method: v.method });
          toast(t('reports.leftToast', { amount: fmtMoney(r.outstanding) }), 'success');
          await load();
        },
      }),
    },
    submit: { range: (form) => load(new FormData(form)) },
  });
}
