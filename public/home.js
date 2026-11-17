// Home tab (工作台): today's numbers for the person signed in, then every job they can do as big tiles, grouped the way
// a night venue works: everyday jobs, the floor, bottles and money, the office. Tiles only show what the role may do.
import { t } from './i18n.js';
import { app, get, post, can } from './session.js';
import { html, raw, setHtml, fmtMoney, fmtDateTime } from './util.js';
import { delegate, formDialog, confirmDialog, dataTable, skeleton, toast, notifyError } from './ui.js';
import { navigate } from './nav.js';
import { hasModule } from './business.js';

const METHODS = ['cash', 'wechat', 'alipay', 'card', 'other'];

// Line icons: 24px grid, currentColor, decorative (every tile has a text label).
const PATHS = {
  order: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2Z"/><path d="M9 8h6M9 12h6"/>',
  host: '<rect x="3.5" y="4" width="7" height="7" rx="1.5"/><rect x="13.5" y="4" width="7" height="7" rx="1.5"/><rect x="3.5" y="14" width="7" height="7" rx="1.5"/><rect x="13.5" y="14" width="7" height="7" rx="1.5"/>',
  gift: '<rect x="3.5" y="8" width="17" height="4.5" rx="1"/><path d="M5 12.5V21h14v-8.5M12 8v13"/><path d="M12 8c-1.5-3-5.5-3.5-5.5-1S9.5 8 12 8c2.5 0 5.5.5 5.5-1s-4-2-5.5 1Z"/>',
  deposit: '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3"/><rect x="4" y="8" width="16.5" height="12" rx="2.5"/><path d="M16 14h2"/>',
  tip: '<circle cx="12" cy="12" r="8.5"/><path d="M14.5 9.2c-.6-.8-1.5-1.2-2.5-1.2-1.4 0-2.5.8-2.5 2s1.1 1.6 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1 0-2-.4-2.6-1.2M12 6.5v11"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="m7 15 4-4 3 3 5-6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  ticket: '<path d="M3.5 8.5V6h17v2.5a2.5 2.5 0 0 0 0 5V16h-17v-2.5a2.5 2.5 0 0 0 0-5Z"/><path d="M14 6v10" stroke-dasharray="2 2"/>',
  bottle: '<path d="M10 3h4v4l2 3v10.5a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5V10l2-3Z"/><path d="M8 13h8"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  briefcase: '<rect x="3.5" y="7" width="17" height="13" rx="2"/><path d="M9 7V5h6v2M3.5 12.5h17"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.3-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c1.8.8 3 2.6 3.5 5.2"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  box: '<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5Z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>',
  people: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.2-4 4.3-6 8-6s6.8 2 8 6"/>',
  check: '<path d="M12 3 5 6v5.5c0 4.3 2.9 8 7 9.5 4.1-1.5 7-5.2 7-9.5V6Z"/><path d="m9 12 2 2 4-4"/>',
};
const icon = (name) => raw(`<svg class="hm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`);

let today = null;
let onShift = null;

/** Each tile: label key, icon, and either a tab to open or an action; `show` hides what the role or modules do not allow. */
function groups() {
  const tables = hasModule('tables');
  return [
    { id: 'daily', tiles: [
      { id: 'order', icon: 'order', tab: tables ? 'floor' : 'counter', show: can('order.add') },
      { id: 'host', icon: 'host', tab: 'host', show: tables && can('table.open') },
      { id: 'comp', icon: 'gift', action: 'myComps', show: can('order.add') },
      { id: 'deposit', icon: 'deposit', action: 'deposits', show: can('booking.create') },
      { id: 'tip', icon: 'tip', action: 'tip', show: can('order.add') },
      { id: 'clock', icon: 'clock', action: onShift ? 'clockOut' : 'clockIn', show: true, label: onShift ? 'home.tile.clockOut' : 'home.tile.clockIn' },
      { id: 'analysis', icon: 'chart', tab: 'reports', show: can('audit.read') },
    ] },
    { id: 'floor', tiles: [
      { id: 'bookings', icon: 'calendar', tab: 'bookings', show: hasModule('bookings') },
      { id: 'voucher', icon: 'ticket', tab: 'bookings', show: hasModule('bookings') && can('booking.create') },
      { id: 'guestOrders', icon: 'music', tab: 'orders', show: hasModule('guestApp') && can('order.add') },
      { id: 'stash', icon: 'bottle', tab: 'stash', show: hasModule('stash') },
      { id: 'stock', icon: 'box', tab: 'stock', show: hasModule('purchasing') && can('admin.write') },
    ] },
    { id: 'office', tiles: [
      { id: 'office', icon: 'briefcase', tab: 'office', show: true },
      { id: 'customers', icon: 'people', tab: 'office', show: true },
      { id: 'members', icon: 'users', tab: 'members', show: true },
      { id: 'approvals', icon: 'check', tab: 'office', show: can('admin.write') },
    ] },
  ].map((g) => ({ ...g, tiles: g.tiles.filter((x) => x.show) })).filter((g) => g.tiles.length);
}

const tileHtml = (x) => html`<button type="button" class="hm-tile" ${x.tab ? html`data-action="go" data-tab="${x.tab}"` : html`data-action="${x.action}"`}>
  <span class="hm-tile__icon">${icon(x.icon)}</span><span>${t(x.label ?? `home.tile.${x.id}`)}</span></button>`;

function statsHtml() {
  if (!today) return skeleton(1);
  const c = today.comps;
  const stat = (label, value) => html`<div class="hm-stat"><b>${value}</b><span>${label}</span></div>`;
  return html`<div class="hm-stats">
    ${stat(t('home.sales'), fmtMoney(today.sales))}${stat(t('home.commission'), fmtMoney(today.commission))}
    ${stat(t('home.tables'), `${today.tables}${today.openTables ? ` + ${today.openTables}` : ''}`)}${stat(t('home.tips'), fmtMoney(today.tips))}
    ${stat(t('home.bookings'), String(today.bookings))}${stat(t('home.comps'), c.unlimited ? fmtMoney(c.used) : `${fmtMoney(c.used)} / ${fmtMoney(c.allowance)}`)}
  </div><p class="hm-note">${t('home.since', { time: fmtDateTime(today.from) })}</p>`;
}

function render(root) {
  const a = app.actor;
  setHtml(root, html`<section aria-labelledby="hm-title" class="hm">
    <div class="hm-hero"><div><p class="hm-hello">${t('home.hello', { name: a.name })}</p>
      <h2 id="hm-title" class="view-title">${t('home.today')}</h2></div>
      <span class="badge badge--neutral">${t(`role.${a.role}`)}</span></div>
    <div class="panel hm-today" aria-live="polite">${statsHtml()}</div>
    ${groups().map((g) => html`<h3 class="section-title">${t(`home.group.${g.id}`)}</h3><div class="hm-grid">${g.tiles.map(tileHtml)}</div>`)}
  </section>`);
}

// ---------- dialogs ----------

async function staffChoices() {
  const people = await get('/api/reps').catch(() => []);
  return people.map((p) => ({ value: p.id, label: p.name }));
}

async function tablesWithBills() {
  if (!hasModule('tables')) return [];
  const tables = await get('/api/tables');
  return tables.filter((x) => x.active !== false).map((x) => ({ value: x.id, label: `${x.name}${x.bill_id ? ' ●' : ''}` }));
}

async function tipDialog(reload) {
  const [people, tables] = await Promise.all([staffChoices(), tablesWithBills()]);
  return formDialog({
    title: t('home.tile.tip'), intro: t('home.tipIntro'),
    fields: [
      { name: 'employeeId', label: t('home.tipFor'), type: 'select', options: people },
      { name: 'kind', label: t('home.tipKind'), type: 'select', value: 'tip', options: [{ value: 'tip', label: t('home.kind.tip') }, { value: 'reward', label: t('home.kind.reward') }] },
      { name: 'amount', label: t('home.amount'), type: 'money', required: true },
      { name: 'method', label: t('home.method'), type: 'select', value: 'wechat', options: METHODS.map((m) => ({ value: m, label: t(`home.method.${m}`) })) },
      ...(tables.length ? [{ name: 'tableId', label: t('home.table'), type: 'select', options: [{ value: '', label: '—' }, ...tables] }] : []),
      { name: 'note', label: t('home.note') },
    ],
    onSubmit: async (v) => {
      await post('/api/tips', { ...v, employeeId: Number(v.employeeId), tableId: v.tableId ? Number(v.tableId) : null });
      toast(t('home.tipDone'), 'success');
      await reload();
    },
  });
}

async function takeDeposit(reload) {
  const tables = await tablesWithBills();
  return formDialog({
    title: t('home.newDeposit'), intro: t('home.depositIntro'),
    fields: [
      { name: 'name', label: t('home.guest') },
      { name: 'phone', label: t('home.phone'), type: 'tel' },
      { name: 'amount', label: t('home.amount'), type: 'money', required: true },
      { name: 'method', label: t('home.method'), type: 'select', value: 'wechat', options: METHODS.map((m) => ({ value: m, label: t(`home.method.${m}`) })) },
      ...(tables.length ? [{ name: 'tableId', label: t('home.table'), type: 'select', options: [{ value: '', label: '—' }, ...tables] }] : []),
      { name: 'note', label: t('home.note') },
    ],
    onSubmit: async (v) => {
      await post('/api/deposits', { ...v, tableId: v.tableId ? Number(v.tableId) : null });
      toast(t('home.depositDone'), 'success');
      await reload();
    },
  });
}

async function depositsDialog(reload) {
  const held = await get('/api/deposits');
  const settle = can('bill.settle');
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog dialog--wide';
  dlg.setAttribute('aria-labelledby', 'dep-title');
  dlg.innerHTML = html`<h2 id="dep-title" class="dialog__title">${t('home.tile.deposit')}</h2>
    <p class="dialog__intro">${t('home.depositsIntro')}</p>
    ${dataTable({ caption: t('home.held'), empty: t('home.noDeposits'), rows: held, cols: [
      { label: t('home.guest'), cell: (d) => html`<strong>${d.name || '—'}</strong><br><span class="muted">${d.phone}</span>` },
      { label: t('home.table'), cell: (d) => d.tableName ?? '—' },
      { label: t('home.amount'), cell: (d) => fmtMoney(d.amount), num: true },
      { label: t('home.taken'), cell: (d) => html`${fmtDateTime(d.createdAt)}<br><span class="muted">${d.byName} · ${t(`home.method.${d.method}`)}</span>` },
      ...(settle ? [{ label: t('common.actions'), cell: (d) => html`<div class="row">
        <button type="button" class="btn btn--small btn--primary" data-dep="apply" data-id="${d.id}">${t('home.apply')}</button>
        <button type="button" class="btn btn--small btn--ghost" data-dep="refund" data-id="${d.id}">${t('home.refund')}</button></div>` }] : []),
    ] })}
    <div class="dialog__actions"><button type="button" class="btn btn--ghost" data-dep="close">${t('common.close')}</button>
      <button type="button" class="btn btn--primary" data-dep="new">${t('home.newDeposit')}</button></div>`.text;
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-dep]');
    if (!el) return;
    const what = el.dataset.dep;
    try {
      if (what === 'close') { dlg.close(); return; }
      if (what === 'new') { dlg.close(); await takeDeposit(reload); return; }
      const d = held.find((x) => x.id === Number(el.dataset.id));
      if (what === 'apply') {
        dlg.close();
        if (!await confirmDialog({ title: t('home.apply'), message: t('home.applyAsk', { amount: fmtMoney(d.amount), table: d.tableName ?? '—' }), submit: 'home.apply' })) return;
        const r = await post(`/api/deposits/${d.id}/apply`, {});
        toast(t(r.settled ? 'home.appliedSettled' : 'home.applied', { amount: fmtMoney(r.applied) }), 'success');
      }
      if (what === 'refund') {
        dlg.close();
        await formDialog({
          title: t('home.refund'), intro: t('home.refundIntro', { amount: fmtMoney(d.amount) }), danger: true, submit: 'home.refund',
          fields: [{ name: 'reason', label: t('home.reason'), required: true }],
          onSubmit: async (v) => { await post(`/api/deposits/${d.id}/refund`, { reason: v.reason }); },
        });
      }
      await reload();
    } catch (err) { notifyError(err); }
  });
  dlg.showModal();
}

function compsDialog() {
  const c = today?.comps;
  if (!c) return;
  const message = c.unlimited ? t('home.compsUnlimited', { used: fmtMoney(c.used) })
    : c.allowance ? t('home.compsLeft', { left: fmtMoney(c.left), allowance: fmtMoney(c.allowance) }) : t('home.compsNone');
  return confirmDialog({ title: t('home.tile.comp'), message: `${message} ${t('home.compsHow')}`, submit: 'home.toFloor' })
    .then((go) => { if (go) navigate(hasModule('tables') ? 'floor' : 'counter'); });
}

// ---------- mount ----------

export function mountHome(root) {
  const load = async () => {
    try {
      [today, onShift] = await Promise.all([get('/api/me/today'), get('/api/attendance/me')]);
      app.compsLeft = today.comps.unlimited ? Infinity : today.comps.left;
    } catch (e) { if (e.status !== 0) notifyError(e); }
    render(root);
  };
  render(root);
  void load();
  delegate(root, {
    click: {
      go: (el) => navigate(el.dataset.tab),
      tip: () => tipDialog(load),
      deposits: () => depositsDialog(load),
      myComps: () => compsDialog(),
      // clockIn / clockOut are handled by the header's clock buttons (delegated on the page); refresh the tile after.
      clockIn: () => setTimeout(load, 800),
      clockOut: () => setTimeout(load, 1500),
    },
  });
}
