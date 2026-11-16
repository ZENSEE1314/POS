// Reports sections about people: attendance (clock in/out), salary, and the activity log.
import { t, tOr } from './i18n.js';
import { get, post, put, patch, can, app } from './session.js';
import { html, setHtml, fmtMoney, fmtDateTime, toDateInput, dayRange, daysAgo, toYuanInput } from './util.js';
import { formDialog, dataTable, badge } from './ui.js';

const WEEK_DAYS = 7;
const HOUR_MS = 3_600_000;
const PAY_KINDS = ['hourly', 'monthly'];
/** Prefixes of audit actions people filter by; each matches every action that starts with it. */
const ACTION_GROUPS = ['order', 'bill', 'table', 'shift', 'attendance', 'staff', 'product', 'stock', 'member', 'booking', 'stash', 'broadcast', 'guest', 'receivable'];

const hours = (ms) => (ms / HOUR_MS).toFixed(2);
const allBox = (all) => (can('hq.read')
  ? html`<label class="check"><input type="checkbox" name="all" ${all ? 'checked' : ''}><span>${t('reports.allStores')}</span></label>` : '');
const dateField = (id, name, label, value) => html`<div class="field"><label for="${id}">${label}</label><input id="${id}" name="${name}" type="date" value="${value}" required></div>`;

// ---------- attendance ----------

const state = { attendance: [], salary: [], staff: [], activity: { rows: [], next: null, query: '' } };

async function attendance(el, form) {
  const from = form?.get('from') ?? toDateInput(daysAgo(WEEK_DAYS));
  const to = form?.get('to') ?? toDateInput(Date.now());
  const all = form ? form.get('all') === 'on' : false;
  const range = dayRange(from, to);
  state.attendance = await get(`/api/attendance?from=${range.from}&to=${range.to}${all ? '&all=1' : ''}`);
  const done = state.attendance.filter((r) => r.clockOut !== null);
  const total = done.reduce((a, r) => a + (r.clockOut - r.clockIn), 0);
  const manage = can('admin.write');
  setHtml(el, html`<form class="panel search-bar" data-form="range">${dateField('at-from', 'from', t('reports.from'), from)}${dateField('at-to', 'to', t('reports.to'), to)}
      ${allBox(all)}<button type="submit" class="btn btn--primary">${t('common.refresh')}</button>
      ${manage && html`<button type="button" class="btn btn--ghost" data-action="addShift">${t('att.add')}</button>`}</form>
    <p class="hint">${t('att.hint')}</p>
    <div class="panel">${dataTable({ caption: t('reports.attendance'), empty: t('att.none'), rows: state.attendance, cols: [
      { label: t('reports.employee'), cell: (r) => html`<strong>${r.name}</strong><br><span class="muted">${tOr(`role.${r.role}`, r.role)}</span>` },
      ...(all ? [{ label: t('reports.store'), cell: (r) => r.storeName }] : []),
      { label: t('att.in'), cell: (r) => fmtDateTime(r.clockIn) },
      { label: t('att.out'), cell: (r) => (r.clockOut === null ? badge(t('att.onShift'), 'warning', '●') : fmtDateTime(r.clockOut)) },
      { label: t('att.hours'), cell: (r) => (r.clockOut === null ? '-' : hours(r.clockOut - r.clockIn)), num: true },
      { label: t('att.note'), cell: (r) => html`${r.note || ''}${r.edited ? html` ${badge(t('att.edited'), 'neutral', '✎')}` : ''}` },
      ...(manage ? [{ label: t('common.actions'), cell: (r) => html`<button type="button" class="btn btn--small btn--ghost" data-action="editShift" data-id="${r.id}">${t('common.edit')}</button>` }] : []),
    ], foot: done.length ? [t('reports.total'), ...(all ? [''] : []), '', '', hours(total), '', ...(manage ? [''] : [])] : null })}</div>`);
}

const shiftFields = (r) => [
  { name: 'clockIn', label: t('att.in'), type: 'datetime', required: true, value: r?.clockIn ?? Date.now() - 8 * HOUR_MS },
  { name: 'clockOut', label: t('att.out'), type: 'datetime', required: true, value: r?.clockOut ?? Date.now() },
  { name: 'note', label: t('att.note'), value: r?.note ?? '', hint: t('att.noteHint') },
];

// ---------- salary ----------

const thisMonth = () => toDateInput(Date.now()).slice(0, 7);
function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  return { from: new Date(y, m - 1, 1).getTime(), to: new Date(y, m, 1).getTime() };
}

const payLabel = (r) => (r.payKind ? t(`sal.kind.${r.payKind}.rate`, { amount: fmtMoney(r.rate) }) : badge(t('sal.notSet'), 'neutral', '—'));

async function salary(el, form) {
  const month = form?.get('month') || thisMonth();
  const all = form ? form.get('all') === 'on' : false;
  const { from, to } = monthRange(month);
  state.salary = await get(`/api/salary?from=${from}&to=${to}${all ? '&all=1' : ''}`);
  const sum = (k) => state.salary.reduce((a, r) => a + r[k], 0);
  const edit = can('payroll.write');
  setHtml(el, html`<form class="panel search-bar" data-form="range"><div class="field"><label for="sal-month">${t('sal.month')}</label>
      <input id="sal-month" name="month" type="month" value="${month}" required></div>${allBox(all)}
      <button type="submit" class="btn btn--primary">${t('common.refresh')}</button></form>
    <p class="hint">${t('sal.hint')}</p>
    <div class="panel">${dataTable({ caption: t('reports.salary'), empty: t('common.noData'), rows: state.salary, cols: [
      { label: t('reports.employee'), cell: (r) => html`<strong>${r.name}</strong>${!r.active ? html` ${badge(t('common.inactive'), 'neutral', '—')}` : ''}<br><span class="muted">${tOr(`role.${r.role}`, r.role)}</span>` },
      { label: t('sal.rate'), cell: payLabel },
      { label: t('sal.shifts'), cell: (r) => html`${r.shifts}${r.stillClockedIn ? html` ${badge(t('att.onShift'), 'warning', '●')}` : ''}`, num: true },
      { label: t('att.hours'), cell: (r) => hours(r.workedMs), num: true },
      { label: t('sal.base'), cell: (r) => fmtMoney(r.basePay), num: true },
      { label: t('reports.commission'), cell: (r) => fmtMoney(r.commission), num: true },
      { label: t('sal.total'), cell: (r) => html`<strong>${fmtMoney(r.total)}</strong>`, num: true },
      ...(edit ? [{ label: t('common.actions'), cell: (r) => html`<button type="button" class="btn btn--small btn--ghost" data-action="setPay" data-id="${r.employeeId}">${t('sal.set')}</button>` }] : []),
    ], foot: state.salary.length ? [t('reports.total'), '', '', hours(sum('workedMs')), fmtMoney(sum('basePay')), fmtMoney(sum('commission')), fmtMoney(sum('total')), ...(edit ? [''] : [])] : null })}</div>`);
}

// ---------- activity log ----------

const actionLabel = (action) => tOr(`act.${action}`, action);

const TIME_KEYS = new Set(['clockIn', 'clockOut', 'eta']);
const MONEY_KEYS = new Set(['rate', 'amount', 'bonus', 'price', 'discount', 'openingCash', 'countedCash', 'expected', 'variance']);

function detailValue(key, v) {
  if (v && typeof v === 'object') return `{ ${detailText(v, ', ')} }`;
  if (typeof v === 'number' && TIME_KEYS.has(key)) return fmtDateTime(v);
  if (typeof v === 'number' && MONEY_KEYS.has(key)) return fmtMoney(v);
  return String(v);
}

function detailText(detail, sep = ' · ') {
  if (detail === null || detail === undefined) return '';
  if (typeof detail !== 'object') return String(detail);
  return Object.entries(detail).filter(([, v]) => v !== null && v !== '' && v !== undefined)
    .map(([k, v]) => `${k}: ${detailValue(k, v)}`).join(sep);
}

const activityTable = (rows, all) => dataTable({ caption: t('reports.audit'), empty: t('common.noData'), rows, cols: [
  { label: t('reports.time'), cell: (a) => fmtDateTime(a.ts) },
  { label: t('reports.actor'), cell: (a) => a.staffName ?? (a.staffId ? `#${a.staffId}` : t('log.system')) },
  ...(all ? [{ label: t('reports.store'), cell: (a) => a.storeName ?? '-' }] : []),
  { label: t('reports.action'), cell: (a) => html`${actionLabel(a.action)}<br><code class="muted">${a.action}</code>` },
  { label: t('reports.entity'), cell: (a) => `${tOr(`ent.${a.entity}`, a.entity)} #${a.entityId ?? ''}` },
  { label: t('reports.detail'), cell: (a) => html`<span class="detail">${detailText(a.detail)}</span>` },
] });

async function activity(el, form, more = false) {
  if (!more) {
    const from = form?.get('from') ?? toDateInput(daysAgo(WEEK_DAYS));
    const to = form?.get('to') ?? toDateInput(Date.now());
    const action = form?.get('action') ?? '';
    const staff = form?.get('staff') ?? '';
    const all = form ? form.get('all') === 'on' : false;
    const range = dayRange(from, to);
    state.activity = { rows: [], next: null, all, filters: { from, to, action, staff },
      query: `from=${range.from}&to=${range.to}${action ? `&action=${encodeURIComponent(action)}` : ''}${staff ? `&staff=${staff}` : ''}${all ? '&all=1' : ''}` };
  }
  const a = state.activity;
  const page = await get(`/api/activity?${a.query}${more && a.next ? `&before=${a.next}` : ''}`);
  a.rows = more ? [...a.rows, ...page.rows] : page.rows;
  a.next = page.next;
  if (!more) a.people = [...new Map(page.rows.filter((r) => r.staffId).map((r) => [r.staffId, r.staffName])).entries()];
  const f = a.filters;
  const people = a.people ?? [];
  setHtml(el, html`<form class="panel search-bar" data-form="range">${dateField('lg-from', 'from', t('reports.from'), f.from)}${dateField('lg-to', 'to', t('reports.to'), f.to)}
      <div class="field"><label for="lg-action">${t('log.what')}</label><select id="lg-action" name="action">
        <option value="">${t('common.all')}</option>${ACTION_GROUPS.map((g) => html`<option value="${g}." ${f.action === `${g}.` ? 'selected' : ''}>${t(`log.group.${g}`)}</option>`)}</select></div>
      <div class="field"><label for="lg-staff">${t('reports.actor')}</label><select id="lg-staff" name="staff">
        <option value="">${t('common.all')}</option>${people.map(([id, name]) => html`<option value="${id}" ${String(id) === f.staff ? 'selected' : ''}>${name ?? `#${id}`}</option>`)}</select></div>
      ${allBox(a.all)}<button type="submit" class="btn btn--primary">${t('common.refresh')}</button></form>
    <div class="panel">${activityTable(a.rows, a.all)}
      ${a.next && html`<div class="row row--center"><button type="button" class="btn btn--ghost" data-action="moreActivity">${t('log.more')}</button></div>`}</div>`);
}

// ---------- exports for reports.js ----------

export const peopleSections = [
  { id: 'attendance', perm: 'audit.read' },
  { id: 'salary', perm: 'payroll.read' },
];

export const peopleLoaders = { attendance, salary, audit: activity };

/** Buttons inside these sections. `reload(form?)` redraws the active section. */
export function peopleActions(body, reload) {
  const rowOf = (list, id) => list.find((r) => r.id === Number(id));
  return {
    addShift: async () => {
      // A store manager records shifts for their own store's staff only (the server enforces the same).
      if (!state.staff.length) state.staff = (await get('/api/staff')).filter((s) => s.active && (can('hq.read') || s.storeId === app.actor.storeId));
      return formDialog({
        title: t('att.add'), intro: t('att.addIntro'), submit: 'common.save',
        fields: [{ name: 'employeeId', label: t('reports.employee'), type: 'select', options: state.staff.map((s) => ({ value: s.id, label: s.name })) }, ...shiftFields(null)],
        onSubmit: async (v) => {
          await post('/api/attendance', { ...v, employeeId: Number(v.employeeId) });
          await reload();
        },
      });
    },
    editShift: (el) => {
      const r = rowOf(state.attendance, el.dataset.id);
      return formDialog({
        title: t('att.edit', { name: r.name }), intro: t('att.editIntro'),
        fields: shiftFields(r),
        onSubmit: async (v) => {
          await patch(`/api/attendance/${r.id}`, v);
          await reload();
        },
      });
    },
    setPay: (el) => {
      const r = state.salary.find((x) => x.employeeId === Number(el.dataset.id));
      return formDialog({
        title: t('sal.setFor', { name: r.name }),
        fields: [
          { name: 'kind', label: t('sal.kind'), type: 'select', value: r.payKind ?? 'monthly', options: PAY_KINDS.map((k) => ({ value: k, label: t(`sal.kind.${k}`) })) },
          { name: 'rate', label: t('sal.amount'), type: 'money', required: true, value: r.rate !== null ? toYuanInput(r.rate) : '', hint: t('sal.amountHint') },
        ],
        onSubmit: async (v) => {
          await put(`/api/staff-pay/${r.employeeId}`, { kind: v.kind, rate: v.rate });
          await reload();
        },
      });
    },
    moreActivity: () => activity(body, null, true),
  };
}
