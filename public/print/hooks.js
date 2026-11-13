// Glue between the app's events (bill settled, line added, wine stored, shift closed) and the print pipeline.
// Every function here is fire-and-forget: it returns immediately and can never throw into the sale flow.
import { app } from '../session.js';
import { S } from '../floor-state.js';
import { printJob } from './printer.js';
import { getSettings, isBridgeConfigured } from './settings.js';
import { receiptModel, ticketModel, stashModel, shiftModel } from './templates.js';

const TICKET_BATCH_MS = 3000;
const pendingTickets = new Map();

/** Automatic prints only run on devices that have been paired with a bridge, and only for the toggles that are on. */
const autoEnabled = (toggle) => {
  const s = getSettings();
  return isBridgeConfigured(s) && s[toggle];
};

// ---- receipts --------------------------------------------------------------------------------------------

function receiptContext() {
  const { bill } = S.bill;
  return {
    company: app.company?.name,
    store: app.store?.name,
    table: S.tables.find((x) => x.id === bill.table_id)?.name,
    cashier: app.actor?.name,
    rep: S.staff.find((x) => x.id === bill.rep_id)?.name,
    footer: getSettings().footer,
    productNames: new Map(S.products.filter((p) => p.name_en).map((p) => [p.id, p.name_en])),
  };
}

function printCurrentBill(auto) {
  if (!S.bill) return;
  const data = S.bill;
  const ctx = receiptContext();
  void printJob({ kind: 'receipt', auto, title: `#${data.bill.id}`, build: ({ lang }) => receiptModel(data, ctx, { lang }) });
}

/** The Print button on any bill, open or settled. Works without a bridge through the browser's print dialog. */
export const printReceiptManual = () => printCurrentBill(false);

/** Called after a payment settles the bill. */
export function printReceiptAuto() {
  if (S.bill?.bill.status === 'settled' && autoEnabled('autoReceipt')) printCurrentBill(true);
}

// ---- kitchen / bar tickets ---------------------------------------------------------------------------------

function flushTickets(billId) {
  const entry = pendingTickets.get(billId);
  pendingTickets.delete(billId);
  if (!entry) return;
  for (const station of new Set(entry.lines.map((l) => l.station))) {
    const lines = entry.lines.filter((l) => l.station === station);
    const ticket = { station, table: entry.table, billId, waiter: entry.waiter, ts: entry.ts, lines };
    void printJob({ kind: station, auto: true, title: `${station} ${entry.table}`, build: ({ lang }) => ticketModel(ticket, { lang }) });
  }
}

export const flushAllTickets = () => [...pendingTickets.keys()].forEach(flushTickets);

/**
 * Queues the lines just added so one burst of taps becomes one ticket per station. Products with no station are
 * skipped. The same product added twice in the window is merged into one line with the summed quantity.
 */
export function queueTicketLine({ billId, product, qty, gift, table }) {
  if (!product?.station || !autoEnabled('autoTickets')) return;
  const entry = pendingTickets.get(billId) ?? {
    table: table ?? S.tables.find((x) => x.id === S.bill?.bill.table_id)?.name ?? `#${billId}`,
    waiter: app.actor?.name, ts: Date.now(), lines: [], timer: null,
  };
  const same = entry.lines.find((l) => l.productId === product.id && l.gift === Boolean(gift));
  if (same) same.qty += qty;
  else entry.lines.push({ productId: product.id, station: product.station, name: product.name, nameEn: product.name_en, qty, gift: Boolean(gift) });
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => flushTickets(billId), TICKET_BATCH_MS);
  pendingTickets.set(billId, entry);
}

window.addEventListener('pagehide', flushAllTickets);

// ---- stash slip ----------------------------------------------------------------------------------------------

/** row: a stash row as GET /api/stash returns it; products: the store's product list (for the English name). */
export function printStashSlip(row, products, auto) {
  if (auto && !autoEnabled('autoStash')) return;
  const nameEn = products.find((p) => p.id === row.product_id)?.name_en;
  const slip = {
    store: app.store?.name, code: row.code, phone: row.phone, name: row.name, nameEn, qtyMilli: row.qty_milli,
    leftMilli: row.left_milli, kind: row.kind, expiresAt: row.expires_at, createdAt: row.created_at,
  };
  void printJob({ kind: 'label', auto, title: slip.code, build: ({ lang }) => stashModel(slip, { lang }) });
}

// ---- shift report ----------------------------------------------------------------------------------------------

/** shift: the open shift row before closing; result: the POST /api/shifts/close response. */
export function printShiftReportAuto(shift, result) {
  if (!autoEnabled('autoShift')) return;
  const report = {
    store: app.store?.name, cashier: app.actor?.name, openedAt: shift.opened_at, closedAt: Date.now(), openingCash: shift.opening_cash,
    expectedCash: result.expectedCash, countedCash: result.countedCash, variance: result.variance, byMethod: result.byMethod,
  };
  void printJob({ kind: 'report', auto: true, title: `shift ${result.shiftId}`, build: ({ lang }) => shiftModel(report, { lang }) });
}
