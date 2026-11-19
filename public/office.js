// Office tab (办公): my requests, my customers, and for managers the approval inbox, join approval, departments
// with their join codes, and handing customers to sales reps.
import { t, tOr } from './i18n.js';
import { get, post, patch, put, can } from './session.js';
import { html, setHtml, fmtMoney, fmtDateTime, fmtDate, toDateInput, dayRange, toYuanInput } from './util.js';
import { delegate, formDialog, confirmDialog, dataTable, badge, skeleton, toast, notifyError, pressed } from './ui.js';
import { academy } from './lessons.js';

const REQUEST_KINDS = ['leave', 'missed_clock', 'expense', 'purchase', 'other', 'resign'];
const JOINABLE_ROLES = ['host', 'waiter', 'cashier', 'manager'];
const DORMANT_DAYS = [14, 30, 60, 90];
const STATUS_TONE = { pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'neutral' };

const SECTIONS = [
  { id: 'requests' },
  { id: 'customers' },
  { id: 'academy' },
  { id: 'approvals', perm: 'admin.write' },
  { id: 'joins', perm: 'admin.write' },
  { id: 'departments', perm: 'admin.write' },
  { id: 'assign', perm: 'admin.write' },
  { id: 'performance', perm: 'audit.read' },
  { id: 'comps', perm: 'admin.write' },
  { id: 'tips', perm: 'audit.read' },
];

let active = 'requests';
const state = { requests: [], approvals: [], done: [], joins: [], departments: [], staff: [], customers: [], dormantDays: 30, showDormant: false, found: [] };

const statusBadge = (s) => badge(t(`office.status.${s}`), STATUS_TONE[s] ?? 'neutral', '●');
const kindLabel = (k) => t(`office.kind.${k}`);
const roleLabel = (r) => tOr(`role.${r}`, r);

function requestWhen(r) {
  if (r.startAt && r.endAt) return `${fmtDateTime(r.startAt)} – ${fmtDateTime(r.endAt)}`;
  return '';
}

const requestSummary = (r) => html`<strong>${kindLabel(r.kind)}</strong>${r.amount ? html` · ${fmtMoney(r.amount)}` : ''}
  ${r.detail && html`<br>${r.detail}`}${requestWhen(r) && html`<br><span class="muted">${requestWhen(r)}</span>`}`;

// ---------- my requests ----------

async function requests(el) {
  state.requests = await get('/api/requests/mine');
  setHtml(el, html`<div class="row"><button type="button" class="btn btn--primary" data-action="newRequest">${t('office.newRequest')}</button></div>
    <p class="hint">${t('office.requestsHint')}</p>
    <div class="panel">${dataTable({ caption: t('office.requests'), empty: t('office.noRequests'), rows: state.requests, cols: [
      { label: t('office.request'), cell: requestSummary },
      { label: t('office.asked'), cell: (r) => fmtDateTime(r.createdAt) },
      { label: t('common.status'), cell: (r) => html`${statusBadge(r.status)}${r.decisionNote && html`<br><span class="muted">${r.decisionNote}</span>`}` },
      { label: t('common.actions'), cell: (r) => (r.status === 'pending'
        ? html`<button type="button" class="btn btn--small btn--ghost" data-action="cancelRequest" data-id="${r.id}">${t('office.cancel')}</button>` : '') },
    ] })}</div>`);
}

function newRequest(reload) {
  return formDialog({
    title: t('office.newRequest'), intro: t('office.newRequestIntro'),
    fields: [
      { name: 'kind', label: t('office.kind'), type: 'select', value: 'leave', options: REQUEST_KINDS.map((k) => ({ value: k, label: kindLabel(k) })) },
      { name: 'detail', label: t('office.detail'), type: 'textarea', hint: t('office.detailHint') },
      { name: 'startAt', label: t('office.start'), type: 'datetime', hint: t('office.startHint') },
      { name: 'endAt', label: t('office.end'), type: 'datetime' },
      { name: 'amount', label: t('office.amount'), type: 'money', hint: t('office.amountHint') },
    ],
    submit: 'office.send',
    onSubmit: async (v) => {
      await post('/api/requests', { ...v, amount: v.amount ?? 0 });
      toast(t('office.sent'), 'success');
      await reload();
    },
  });
}

// ---------- my customers ----------

async function customers(el) {
  state.customers = state.showDormant
    ? await get(`/api/customers/dormant?days=${state.dormantDays}`)
    : await get('/api/customers/mine');
  setHtml(el, html`<div class="chips" role="group" aria-label="${t('office.customers')}">
      <button type="button" class="chip" data-action="dormant" data-on="0" aria-pressed="${pressed(!state.showDormant)}">${t('office.mine')}</button>
      ${DORMANT_DAYS.map((d) => html`<button type="button" class="chip" data-action="dormant" data-on="1" data-days="${d}"
        aria-pressed="${pressed(state.showDormant && state.dormantDays === d)}">${t('office.dormantFor', { n: d })}</button>`)}</div>
    <p class="hint">${state.showDormant ? t('office.dormantHint') : t('office.mineHint')}</p>
    <div class="panel">${dataTable({ caption: t('office.customers'), empty: t('office.noCustomers'), rows: state.customers, cols: [
      { label: t('office.customer'), cell: (c) => html`<strong>${c.name || '—'}</strong><br><a href="tel:${c.phone}">${c.phone}</a>` },
      { label: t('office.visits'), cell: (c) => String(c.visits), num: true },
      { label: t('office.lastVisit'), cell: (c) => (c.lastVisit ? fmtDate(c.lastVisit) : badge(t('office.never'), 'neutral', '—')) },
      { label: t('office.wallet'), cell: (c) => fmtMoney(c.balance), num: true },
      ...(state.showDormant && can('admin.write') ? [{ label: t('office.owner'), cell: (c) => c.ownerName ?? '—' }] : []),
    ] })}</div>`);
}

// ---------- approvals ----------

async function approvals(el) {
  [state.approvals, state.done] = await Promise.all([get('/api/approvals'), get('/api/approvals?status=done')]);
  const cols = (pending) => [
    { label: t('office.who'), cell: (r) => html`<strong>${r.employeeName}</strong><br><span class="muted">${fmtDateTime(r.createdAt)}</span>` },
    { label: t('office.request'), cell: requestSummary },
    pending
      ? { label: t('common.actions'), cell: (r) => html`<div class="row">
          <button type="button" class="btn btn--small btn--primary" data-action="decide" data-id="${r.id}" data-approve="1">${t('office.approve')}</button>
          <button type="button" class="btn btn--small btn--ghost" data-action="decide" data-id="${r.id}" data-approve="0">${t('office.reject')}</button></div>` }
      : { label: t('common.status'), cell: (r) => html`${statusBadge(r.status)}<br><span class="muted">${r.deciderName ?? ''} ${r.decidedAt ? fmtDateTime(r.decidedAt) : ''}</span>${r.decisionNote && html`<br>${r.decisionNote}`}` },
  ];
  setHtml(el, html`<p class="hint">${t('office.approvalsHint')}</p>
    <div class="panel">${dataTable({ caption: t('office.pending'), empty: t('office.noPending'), rows: state.approvals, cols: cols(true) })}</div>
    <div class="panel">${dataTable({ caption: t('office.decided'), empty: t('common.noData'), rows: state.done, cols: cols(false) })}</div>`);
}

function decide(el, reload) {
  const r = state.approvals.find((x) => x.id === Number(el.dataset.id));
  const approve = el.dataset.approve === '1';
  return formDialog({
    title: approve ? t('office.approveTitle', { name: r.employeeName }) : t('office.rejectTitle', { name: r.employeeName }),
    intro: approve ? t(`office.approveEffect.${r.kind}`) : '',
    fields: [{ name: 'note', label: t('office.note'), hint: t('office.noteHint') }],
    submit: approve ? 'office.approve' : 'office.reject', danger: !approve,
    onSubmit: async (v) => {
      await post(`/api/approvals/${r.id}`, { approve, note: v.note });
      await reload();
    },
  });
}

// ---------- joins ----------

async function joins(el) {
  state.joins = await get('/api/joins');
  setHtml(el, html`<p class="hint">${t('office.joinsHint')}</p>
    <div class="panel">${dataTable({ caption: t('office.joins'), empty: t('office.noJoins'), rows: state.joins, cols: [
      { label: t('office.who'), cell: (j) => html`<strong>${j.name}</strong><br><span class="muted">${j.username} · ${j.phone}</span>` },
      { label: t('office.department'), cell: (j) => html`${j.department}<br><span class="muted">${j.storeName}</span>` },
      { label: t('office.asked'), cell: (j) => fmtDateTime(j.createdAt) },
      { label: t('common.actions'), cell: (j) => html`<div class="row">
        <button type="button" class="btn btn--small btn--primary" data-action="approveJoin" data-id="${j.id}">${t('office.approve')}</button>
        <button type="button" class="btn btn--small btn--ghost" data-action="rejectJoin" data-id="${j.id}">${t('office.reject')}</button></div>` },
    ] })}</div>`);
}

function approveJoin(el, reload) {
  const j = state.joins.find((x) => x.id === Number(el.dataset.id));
  return formDialog({
    title: t('office.approveTitle', { name: j.name }), intro: t('office.approveJoinIntro'),
    fields: [{ name: 'role', label: t('office.role'), type: 'select', value: j.defaultRole, options: JOINABLE_ROLES.map((r) => ({ value: r, label: roleLabel(r) })) }],
    submit: 'office.approve',
    onSubmit: async (v) => {
      await post(`/api/joins/${j.id}/approve`, { role: v.role });
      toast(t('office.joinApproved', { name: j.name, username: j.username }), 'success');
      await reload();
    },
  });
}

// ---------- departments ----------

async function departments(el) {
  [state.departments, state.staff] = await Promise.all([get('/api/departments'), get('/api/staff')]);
  const deptName = new Map(state.departments.map((d) => [d.id, d.name]));
  const people = state.staff.filter((s) => s.active && s.storeId !== null);
  setHtml(el, html`<div class="row"><button type="button" class="btn btn--primary" data-action="newDepartment">${t('office.newDepartment')}</button></div>
    <p class="hint">${t('office.departmentsHint')}</p>
    <div class="panel">${dataTable({ caption: t('office.departments'), empty: t('office.noDepartments'), rows: state.departments, cols: [
      { label: t('office.department'), cell: (d) => html`<strong>${d.name}</strong>${!d.active ? html` ${badge(t('common.inactive'), 'neutral', '—')}` : ''}<br><span class="muted">${d.storeName}</span>` },
      { label: t('office.joinCode'), cell: (d) => html`<code class="join-code">${d.joinCode}</code>` },
      { label: t('office.defaultRole'), cell: (d) => roleLabel(d.defaultRole) },
      { label: t('office.staffCount'), cell: (d) => String(d.staff), num: true },
      { label: t('common.actions'), cell: (d) => html`<div class="row">
        <button type="button" class="btn btn--small btn--ghost" data-action="editDepartment" data-id="${d.id}">${t('common.edit')}</button>
        <button type="button" class="btn btn--small btn--ghost" data-action="newCode" data-id="${d.id}">${t('office.newCode')}</button></div>` },
    ] })}</div>
    <div class="panel">${dataTable({ caption: t('office.staffDepartments'), empty: t('common.noData'), rows: people, cols: [
      { label: t('office.who'), cell: (s) => html`<strong>${s.name}</strong><br><span class="muted">${roleLabel(s.role)}</span>` },
      { label: t('office.department'), cell: (s) => deptName.get(s.departmentId) ?? '—' },
      { label: t('common.actions'), cell: (s) => html`<button type="button" class="btn btn--small btn--ghost" data-action="moveStaff" data-id="${s.id}">${t('office.move')}</button>` },
    ] })}</div>`);
}

const departmentFields = (d = {}) => [
  { name: 'name', label: t('office.departmentName'), required: true, value: d.name ?? '', hint: t('office.departmentNameHint') },
  { name: 'defaultRole', label: t('office.defaultRole'), type: 'select', value: d.defaultRole ?? 'waiter', options: JOINABLE_ROLES.map((r) => ({ value: r, label: roleLabel(r) })) },
  ...(d.id ? [{ name: 'active', label: t('office.departmentActive'), type: 'checkbox', value: d.active }] : []),
];

// ---------- assign customers ----------

async function assign(el, form) {
  const q = form?.get('q') ?? '';
  [state.found, state.staff] = await Promise.all([get(`/api/customers?q=${encodeURIComponent(q)}`), state.staff.length ? state.staff : get('/api/staff')]);
  const reps = state.staff.filter((s) => s.active);
  setHtml(el, html`<form class="panel search-bar" data-form="search"><div class="field"><label for="as-q">${t('office.search')}</label>
      <input id="as-q" name="q" value="${q}" placeholder="${t('office.searchHint')}"></div>
      <button type="submit" class="btn btn--primary">${t('common.search')}</button></form>
    <form class="panel" data-form="assign">
      <div class="search-bar"><div class="field"><label for="as-rep">${t('office.giveTo')}</label><select id="as-rep" name="ownerId">
        <option value="">${t('office.venue')}</option>${reps.map((s) => html`<option value="${s.id}">${s.name} · ${roleLabel(s.role)}</option>`)}</select></div>
        <button type="submit" class="btn btn--primary">${t('office.assign')}</button></div>
      ${dataTable({ caption: t('office.customers'), empty: t('office.noCustomers'), rows: state.found, cols: [
        { label: html`<span class="sr-only">${t('office.pick')}</span>`, cell: (c) => html`<input type="checkbox" name="memberId" value="${c.id}" aria-label="${c.name || c.phone}">` },
        { label: t('office.customer'), cell: (c) => html`<strong>${c.name || '—'}</strong><br>${c.phone}` },
        { label: t('office.owner'), cell: (c) => c.ownerName ?? html`<span class="muted">${t('office.venue')}</span>` },
        { label: t('office.lastVisit'), cell: (c) => (c.lastVisit ? fmtDate(c.lastVisit) : '—') },
      ] })}</form>`);
}

// ---------- performance, comp allowances, tips ----------

const rangeForm = (from, to) => html`<form class="panel search-bar" data-form="range">
  <div class="field"><label for="pf-from">${t('reports.from')}</label><input id="pf-from" name="from" type="date" value="${from}" required></div>
  <div class="field"><label for="pf-to">${t('reports.to')}</label><input id="pf-to" name="to" type="date" value="${to}" required></div>
  ${can('hq.read') ? html`<label class="check"><input type="checkbox" name="all"><span>${t('reports.allStores')}</span></label>` : ''}
  <button type="submit" class="btn btn--primary">${t('common.refresh')}</button></form>`;

function rangeOf(form) {
  const from = form?.get('from') ?? toDateInput(Date.now());
  const to = form?.get('to') ?? toDateInput(Date.now());
  return { from, to, all: form?.get('all') === 'on', range: dayRange(from, to) };
}

async function performance(el, form) {
  const r = rangeOf(form);
  const p = await get(`/api/performance?from=${r.range.from}&to=${r.range.to}${r.all ? '&all=1' : ''}`);
  const money = (k) => ({ label: t(`office.perf.${k}`), cell: (x) => fmtMoney(x[k]), num: true });
  setHtml(el, html`${rangeForm(r.from, r.to)}
    <div class="hd-summary"><span><b>${fmtMoney(p.total.sales)}</b> ${t('office.perf.sales')}</span><span><b>${p.total.tables}</b> ${t('office.perf.tables')}</span>
      <span><b>${fmtMoney(p.total.commission)}</b> ${t('office.perf.commission')}</span><span><b>${fmtMoney(p.total.tips)}</b> ${t('office.perf.tips')}</span></div>
    <div class="panel">${dataTable({ caption: t('office.perf.byDept'), empty: t('common.noData'), rows: p.departments, cols: [
      { label: t('office.department'), cell: (d) => d.name ?? t('office.noDept') }, { label: t('office.perf.people'), cell: (d) => String(d.people), num: true },
      money('sales'), { label: t('office.perf.tables'), cell: (d) => String(d.tables), num: true }, money('commission'), money('tips'),
    ] })}</div>
    <div class="panel">${dataTable({ caption: t('office.perf.ranking'), empty: t('common.noData'), rows: p.staff, cols: [
      { label: '#', cell: (x) => String(p.staff.indexOf(x) + 1), num: true },
      { label: t('office.who'), cell: (x) => html`<strong>${x.name}</strong><br><span class="muted">${x.departmentName ?? ''}</span>` },
      money('sales'), { label: t('office.perf.tables'), cell: (x) => String(x.tables), num: true }, money('comps'), money('commission'), money('tips'),
    ] })}</div>`);
}

async function comps(el) {
  state.comps = await get('/api/comps');
  setHtml(el, html`<p class="hint">${t('office.compsHint')}</p>
    <div class="panel">${dataTable({ caption: t('office.comps'), empty: t('common.noData'), rows: state.comps, cols: [
      { label: t('office.who'), cell: (c) => html`<strong>${c.name}</strong><br><span class="muted">${roleLabel(c.role)}</span>` },
      { label: t('office.allowance'), cell: (c) => (c.unlimited ? t('office.unlimited') : fmtMoney(c.allowance)), num: true },
      { label: t('office.usedMonth'), cell: (c) => fmtMoney(c.used), num: true },
      { label: t('common.actions'), cell: (c) => (c.unlimited ? '' : html`<button type="button" class="btn btn--small btn--ghost" data-action="setAllowance" data-id="${c.employeeId}">${t('common.edit')}</button>`) },
    ] })}</div>`);
}

async function tips(el, form) {
  const r = rangeOf(form);
  const rows = await get(`/api/tips?from=${r.range.from}&to=${r.range.to}`);
  const total = rows.reduce((a, x) => a + x.amount, 0);
  setHtml(el, html`${rangeForm(r.from, r.to)}
    <div class="panel">${dataTable({ caption: t('office.tips'), empty: t('common.noData'), rows, cols: [
      { label: t('reports.time'), cell: (x) => fmtDateTime(x.createdAt) },
      { label: t('office.who'), cell: (x) => html`<strong>${x.employeeName}</strong><br><span class="muted">${t(`home.kind.${x.kind}`)}</span>` },
      { label: t('home.table'), cell: (x) => x.tableName ?? '—' },
      { label: t('home.method'), cell: (x) => html`${t(`home.method.${x.method}`)}<br><span class="muted">${x.byName}</span>` },
      { label: t('home.amount'), cell: (x) => fmtMoney(x.amount), num: true },
    ], foot: rows.length ? [t('reports.total'), '', '', '', fmtMoney(total)] : null })}</div>`);
}

// ---------- mount ----------

const loaders = { requests, customers, academy, approvals, joins, departments, assign, performance, comps, tips };

export function mountOffice(root) {
  const sections = SECTIONS.filter((s) => !s.perm || can(s.perm));
  if (!sections.some((s) => s.id === active)) active = sections[0].id;
  setHtml(root, html`<section aria-labelledby="of-title"><h2 id="of-title" class="view-title">${t('nav.office')}</h2>
    <div class="chips" role="group" aria-label="${t('nav.office')}">${sections.map((s) =>
      html`<button type="button" class="chip" data-action="section" data-id="${s.id}" aria-pressed="${pressed(s.id === active)}">${t(`office.${s.id}`)}</button>`)}</div>
    <div id="of-body" aria-live="polite">${skeleton(5)}</div></section>`);
  const body = root.querySelector('#of-body');
  const load = (form) => loaders[active](body, form).catch((e) => { setHtml(body, html``); notifyError(e); });
  const reload = () => load();
  load();

  const byId = (list, el) => list.find((x) => x.id === Number(el.dataset.id));
  delegate(root, {
    click: {
      section: (el) => {
        active = el.dataset.id;
        root.querySelectorAll('[data-action=section]').forEach((b) => b.setAttribute('aria-pressed', pressed(b === el)));
        setHtml(body, skeleton(5));
        return load();
      },
      newRequest: () => newRequest(reload),
      cancelRequest: async (el) => {
        await post(`/api/requests/${el.dataset.id}/cancel`);
        await reload();
      },
      dormant: (el) => {
        state.showDormant = el.dataset.on === '1';
        if (el.dataset.days) state.dormantDays = Number(el.dataset.days);
        return load();
      },
      decide: (el) => decide(el, reload),
      approveJoin: (el) => approveJoin(el, reload),
      rejectJoin: async (el) => {
        const j = byId(state.joins, el);
        if (!await confirmDialog({ title: t('office.rejectTitle', { name: j.name }), message: t('office.rejectJoinAsk'), submit: 'office.reject', danger: true })) return;
        await post(`/api/joins/${j.id}/reject`);
        await reload();
      },
      newDepartment: () => formDialog({
        title: t('office.newDepartment'), fields: departmentFields(),
        onSubmit: async (v) => {
          await post('/api/departments', v);
          await reload();
        },
      }),
      editDepartment: (el) => {
        const d = byId(state.departments, el);
        return formDialog({
          title: d.name, fields: departmentFields(d),
          onSubmit: async (v) => {
            await patch(`/api/departments/${d.id}`, v);
            await reload();
          },
        });
      },
      newCode: async (el) => {
        const d = byId(state.departments, el);
        if (!await confirmDialog({ title: t('office.newCode'), message: t('office.newCodeAsk', { name: d.name }), submit: 'office.newCode' })) return;
        const { joinCode } = await post(`/api/departments/${d.id}/code`);
        toast(t('office.newCodeDone', { code: joinCode }), 'success');
        await reload();
      },
      setAllowance: (el) => {
        const c = state.comps.find((x) => x.employeeId === Number(el.dataset.id));
        return formDialog({
          title: t('office.allowanceFor', { name: c.name }), intro: t('office.allowanceIntro'),
          fields: [{ name: 'allowance', label: t('office.allowance'), type: 'money', required: true, value: toYuanInput(c.allowance) }],
          onSubmit: async (v) => {
            await put(`/api/comps/${c.employeeId}`, { allowance: v.allowance ?? 0 });
            await reload();
          },
        });
      },
      moveStaff: (el) => {
        const s = byId(state.staff, el);
        return formDialog({
          title: t('office.moveTitle', { name: s.name }),
          fields: [{ name: 'departmentId', label: t('office.department'), type: 'select', value: s.departmentId ?? '',
            options: [{ value: '', label: '—' }, ...state.departments.filter((d) => d.active && d.storeId === s.storeId).map((d) => ({ value: d.id, label: d.name }))] }],
          onSubmit: async (v) => {
            await put(`/api/staff/${s.id}/department`, { departmentId: v.departmentId === '' ? null : Number(v.departmentId) });
            await reload();
          },
        });
      },
    },
    submit: {
      range: (form) => load(new FormData(form)),
      search: (form) => load(new FormData(form)),
      assign: async (form) => {
        const memberIds = [...form.querySelectorAll('input[name=memberId]:checked')].map((c) => Number(c.value));
        if (!memberIds.length) { toast(t('office.pickSome'), 'error'); return; }
        const ownerId = form.elements.ownerId.value ? Number(form.elements.ownerId.value) : null;
        const { changed } = await post('/api/customers/assign', { memberIds, ownerId });
        toast(t('office.assigned', { n: changed }), 'success');
        const search = body.querySelector('form[data-form=search]');
        await load(search ? new FormData(search) : undefined);
      },
    },
  });
}

/** "Join with a code" on the sign-in screen: staff sign themselves up and wait for a manager. */
export function openJoinDialog(company) {
  return formDialog({
    title: t('join.title'), intro: t('join.intro'),
    fields: [
      { name: 'company', label: t('login.company'), required: true, value: company ?? '' },
      { name: 'joinCode', label: t('join.code'), required: true, hint: t('join.codeHint') },
      { name: 'name', label: t('join.name'), required: true },
      { name: 'phone', label: t('join.phone'), type: 'tel', required: true },
      { name: 'username', label: t('login.username'), required: true, hint: t('join.usernameHint') },
      { name: 'pin', label: t('login.pin'), type: 'pin', required: true, hint: t('join.pinHint') },
    ],
    submit: 'join.submit',
    onSubmit: async (v) => {
      await post('/api/join', v);
      toast(t('join.sent'), 'success');
    },
  });
}

