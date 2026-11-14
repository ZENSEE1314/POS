// Checkout view: quick counter sales without a table (shops, takeaway, salons). Open sales stay listed so one can be held
// while the next customer is served; pickup and delivery orders accepted from the customer app show up here too.
import { t } from './i18n.js';
import { get, post, can } from './session.js';
import { html, setHtml, fmtMoney, fmtTime } from './util.js';
import { delegate, emptyState, skeleton, pressed, notifyError } from './ui.js';
import { S } from './floor-state.js';
import { billHtml, productTiles } from './bill-view.js';
import { createBillActions } from './bill-actions.js';
import { shiftHtml, loadShift, openShiftDialog, closeShiftDialog } from './shift.js';
import { SYNCED_EVENT, realBillId } from './offline/index.js';

const REFRESH_MS = 10000;
const WIDE_QUERY = '(min-width: 1024px)';

function saleCard(b) {
  return html`<button type="button" class="table table--occupied" data-action="pickSale" data-id="${b.id}" aria-pressed="${pressed(b.id === S.billId)}">
    <span class="table__name">${t(`channel.${b.channel}`)}${b.id > 0 ? ` #${b.id}` : ''}</span>
    <span class="table__meta">${fmtTime(b.openedAt)} · ${t('counter.lines', { n: b.lines })}${b.memberPhone ? ` · ${b.memberPhone}` : ''}</span>
    <span class="table__money">${t('floor.billTotal')} <strong>${fmtMoney(b.total)}</strong></span>
  </button>`;
}

export function mountCounter(root) {
  setHtml(root, html`<div class="floor">
    <section class="floor__main" aria-labelledby="counter-title">
      <div class="floor__bar"><h2 id="counter-title" class="view-title">${t('counter.title')}</h2><div id="shift"></div></div>
      <div class="row counter__actions"><button type="button" class="btn btn--primary" data-action="newSale">${t('counter.new')}</button></div>
      <h3 class="section-title">${t('counter.open')}</h3>
      <div id="board">${skeleton(3)}</div>
    </section>
    <section class="floor__bill panel" id="billPanel" aria-label="${t('floor.billPanel')}"></section>
  </div>`);
  const boardEl = root.querySelector('#board');
  const billEl = root.querySelector('#billPanel');
  const shiftEl = root.querySelector('#shift');
  const wide = window.matchMedia(WIDE_QUERY);
  let sales = [];

  const renderBoard = () => setHtml(boardEl, sales.length ? html`<div class="board">${sales.map(saleCard)}</div>` : emptyState(t('counter.none')));
  const renderShift = () => { if (can('bill.settle')) setHtml(shiftEl, shiftHtml()); };
  const renderGrid = () => { const g = billEl.querySelector('#productGrid'); if (g) setHtml(g, productTiles(S)); };
  const renderBill = () => {
    const focused = document.activeElement?.id;
    setHtml(billEl, S.billId ? billHtml(S) : emptyState(t('counter.pick'), t('counter.pickHint')));
    if (focused) billEl.querySelector(`#${focused}`)?.focus();
  };

  async function loadBoard() {
    sales = await get('/api/counter-sales');
    renderBoard();
  }

  async function loadBill() {
    if (!S.billId) return;
    S.bill = await get(`/api/bills/${S.billId}`);
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
    billEl.querySelector('#scan')?.focus();
  }

  async function newSale() {
    const { billId } = await post('/api/counter-sales', {});
    await loadBoard();
    await selectBill(billId);
  }

  async function init() {
    const loads = [get('/api/products'), loadBoard(), get('/api/reps').then((s) => { S.staff = s; })];
    if (can('bill.settle')) loads.push(loadShift().catch(() => {}));
    const [products] = await Promise.all(loads);
    S.products = products;
    // A table bill selected on the floor does not belong on this screen.
    if (S.billId && !sales.some((b) => b.id === S.billId) && S.bill?.bill.table_id != null) { S.billId = null; S.bill = null; }
    renderShift();
    if (S.billId) await loadBill();
    renderBill();
    billEl.querySelector('#scan')?.focus();
  }

  const refreshShift = async () => { await loadShift(); renderShift(); };

  delegate(root, {
    click: {
      newSale,
      pickSale: (el) => selectBill(Number(el.dataset.id)),
      openShift: () => openShiftDialog(refreshShift),
      closeShift: () => closeShiftDialog(refreshShift),
      ...billActions.handlers.click,
    },
    input: billActions.handlers.input,
    change: billActions.handlers.change,
    submit: billActions.handlers.submit,
  });

  // Offline sales just reached the server: a sale started offline now has a real id, and totals may have changed.
  const onSynced = async () => {
    try {
      if (S.billId !== null && S.billId < 0) {
        S.billId = (await realBillId(S.billId)) ?? null;
        S.bill = null;
      }
      await loadBoard();
      if (S.billId) await loadBill();
      renderBill();
    } catch { /* the next refresh will retry */ }
  };

  init().catch(notifyError);
  const timer = setInterval(() => { if (!document.hidden) loadBoard().catch(() => {}); }, REFRESH_MS);
  window.addEventListener(SYNCED_EVENT, onSynced);
  return () => { clearInterval(timer); billActions.stopPolling(); window.removeEventListener(SYNCED_EVENT, onSynced); };
}
