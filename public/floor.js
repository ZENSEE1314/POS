// Floor (POS) view: tables board + bill panel (side by side on wide screens).
import { t, tOr } from './i18n.js';
import { get, post, can } from './session.js';
import { html, setHtml, fmtMoney } from './util.js';
import { delegate, formDialog, emptyState, skeleton, badge, pressed, notifyError, toast } from './ui.js';
import { S } from './floor-state.js';
import { billHtml, productTiles } from './bill-view.js';
import { createBillActions } from './bill-actions.js';
import { repField } from './reps.js';
import { shiftHtml, loadShift, openShiftDialog, closeShiftDialog } from './shift.js';

const BOARD_REFRESH_MS = 10000;
const WIDE_QUERY = '(min-width: 1024px)';

const focusSelector = (el) => {
  const d = el?.dataset;
  if (!d?.action) return null;
  return ['action', 'id', 'cat', 'method'].filter((k) => d[k] !== undefined).map((k) => `[data-${k}="${CSS.escape(d[k])}"]`).join('');
};

function tableCard(tb) {
  const occupied = tb.status === 'occupied' || Boolean(tb.bill_id);
  const selected = occupied && tb.bill_id === S.billId;
  const money = occupied
    ? html`<span class="table__money">${t('floor.billTotal')} <strong>${fmtMoney(S.totals.get(tb.bill_id) ?? 0)}</strong></span>`
    : tb.min_spend > 0 ? html`<span class="table__money">${t('floor.minSpend')} ${fmtMoney(tb.min_spend)}</span>` : html`<span class="table__money">&nbsp;</span>`;
  return html`<button type="button" class="table table--${occupied ? 'occupied' : 'free'}" data-action="table" data-id="${tb.id}" aria-pressed="${pressed(selected)}">
    <span class="table__name">${tb.name}</span>
    <span class="table__meta">${tOr(`kind.${tb.kind}`, tb.kind)} · ${t('floor.seats', { n: tb.capacity })}</span>
    ${occupied ? badge(t('floor.occupied'), 'busy', '●') : badge(t('floor.free'), 'free', '○')}
    ${money}
  </button>`;
}

function boardHtml() {
  if (!S.tables.length) return emptyState(t('floor.noTables'));
  const zones = [...new Set(S.tables.map((x) => x.zone))];
  return html`${zones.map((z) => html`<section class="zone" aria-label="${z || t('floor.zoneDefault')}">
    <h3 class="zone__title">${z || t('floor.zoneDefault')}</h3>
    <div class="board">${S.tables.filter((x) => x.zone === z).map(tableCard)}</div></section>`)}`;
}

export function mountFloor(root) {
  setHtml(root, html`<div class="floor">
    <section class="floor__main" aria-labelledby="floor-title">
      <div class="floor__bar"><h2 id="floor-title" class="view-title">${t('nav.floor')}</h2><div id="shift"></div></div>
      <div id="board">${skeleton(6)}</div>
    </section>
    <section class="floor__bill panel" id="billPanel" aria-label="${t('floor.billPanel')}"></section>
  </div>`);
  const boardEl = root.querySelector('#board');
  const billEl = root.querySelector('#billPanel');
  const shiftEl = root.querySelector('#shift');
  const wide = window.matchMedia(WIDE_QUERY);

  const renderBoard = () => setHtml(boardEl, boardHtml());
  const renderShift = () => { if (can('bill.settle')) setHtml(shiftEl, shiftHtml()); };
  const renderGrid = () => { const g = billEl.querySelector('#productGrid'); if (g) setHtml(g, productTiles(S)); };
  const renderBill = () => {
    const focus = focusSelector(document.activeElement);
    setHtml(billEl, billHtml(S));
    if (focus) billEl.querySelector(focus)?.focus();
  };

  async function loadBoard() {
    S.tables = await get('/api/tables');
    const occupied = S.tables.filter((x) => x.bill_id);
    const bills = await Promise.all(occupied.map((x) => get(`/api/bills/${x.bill_id}`)));
    S.totals = new Map(occupied.map((x, i) => [x.bill_id, bills[i].totals.total]));
    renderBoard();
  }

  async function loadBill() {
    if (!S.billId) return;
    S.bill = await get(`/api/bills/${S.billId}`);
    S.totals.set(S.billId, S.bill.totals.total);
  }

  const billActions = createBillActions({ reloadBill: loadBill, reloadBoard: loadBoard, renderBill, renderGrid });

  async function selectBill(id) {
    if (S.billId !== id) { billActions.stopPolling(); S.pending = null; }
    S.billId = id;
    S.bill = null;
    renderBill();
    renderBoard();
    if (!wide.matches) billEl.scrollIntoView({ behavior: 'smooth' });
    await loadBill();
    renderBill();
  }

  async function openTable(tableId) {
    const tb = S.tables.find((x) => x.id === tableId);
    let billId = null;
    const ok = await formDialog({
      title: t('floor.openTitle', { name: tb.name }),
      intro: tb.min_spend > 0 ? t('floor.openMinSpend', { amount: fmtMoney(tb.min_spend) }) : '',
      fields: [repField(S.staff), { name: 'phone', label: t('floor.phone'), type: 'tel', hint: t('floor.phoneHint') }],
      submit: 'floor.open',
      onSubmit: async (v) => {
        ({ billId } = await post('/api/bills', { tableId, repId: Number(v.rep), phone: v.phone || undefined }));
      },
    });
    if (!ok) return;
    await loadBoard();
    await selectBill(billId);
  }

  async function init() {
    const loads = [get('/api/products'), loadBoard()];
    loads.push(get('/api/reps').then((s) => { S.staff = s; }));
    if (can('bill.settle')) loads.push(loadShift());
    const [products] = await Promise.all(loads);
    S.products = products;
    renderShift();
    if (S.billId) { renderBill(); await loadBill(); }
    renderBill();
    renderBoard();
  }

  const refreshShift = async () => { await loadShift(); renderShift(); };

  delegate(root, {
    click: {
      table: (el) => {
        const tb = S.tables.find((x) => x.id === Number(el.dataset.id));
        if (tb.bill_id) return selectBill(tb.bill_id);
        if (!can('table.open')) return toast(t('floor.cannotOpen'), 'error');
        return openTable(tb.id);
      },
      openShift: () => openShiftDialog(refreshShift),
      closeShift: () => closeShiftDialog(refreshShift),
      ...billActions.handlers.click,
    },
    input: billActions.handlers.input,
    change: billActions.handlers.change,
  });

  init().catch(notifyError);
  const timer = setInterval(() => { if (!document.hidden) loadBoard().catch(() => {}); }, BOARD_REFRESH_MS);
  return () => { clearInterval(timer); billActions.stopPolling(); };
}
