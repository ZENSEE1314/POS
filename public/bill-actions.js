// Event handlers for the bill panel (add/void/discount/transfer/pay/online pay/voucher).
import { t, tOr } from './i18n.js';
import { post } from './session.js';
import { parseFen, fmtMoney } from './util.js';
import { formDialog, confirmDialog, toast } from './ui.js';
import { S } from './floor-state.js';
import { printReceiptAuto, printReceiptManual, queueTicketLine } from './print/hooks.js';

const POLL_MS = 2000;
const MAX_QTY = 99;
const reasonField = (label) => ({ name: 'reason', label, type: 'text', required: true });
const billPath = (suffix) => `/api/bills/${S.billId}${suffix}`;

/** ctx: { reloadBill, reloadBoard, renderBill, renderGrid } supplied by the floor view. */
export function createBillActions(ctx) {
  let pollTimer = null;

  const stopPolling = () => { clearInterval(pollTimer); pollTimer = null; };

  async function pollPending() {
    const pending = S.pending;
    if (!pending || pending.paid) return stopPolling();
    await ctx.reloadBill();
    const done = S.bill.payments.find((p) => p.id === pending.paymentId)?.status === 'paid';
    if (!done) return;
    stopPolling();
    S.pending = { ...pending, paid: true };
    toast(t('floor.onlinePaid', { method: tOr(`pay.${pending.method}`, pending.method), amount: fmtMoney(pending.amount) }), 'success');
    await ctx.reloadBoard();
    ctx.renderBill();
    printReceiptAuto();
  }

  const startPolling = () => {
    stopPolling();
    pollTimer = setInterval(() => pollPending().catch(() => {}), POLL_MS);
  };

  const afterChange = async (full = false) => {
    const wasOpen = S.bill?.bill.status === 'open';
    await ctx.reloadBill();
    // Any action that settles the bill (payment, voucher, a void or discount that lands on the paid amount) prints the receipt.
    if (wasOpen) printReceiptAuto();
    if (full) await ctx.reloadBoard();
    ctx.renderBill();
  };

  async function addLine(productId, qty, gift) {
    const body = { productId, qty };
    if (gift) {
      let reason = '';
      const ok = await formDialog({
        title: t('floor.giftTitle'), fields: [reasonField(t('floor.reason'))], submit: 'floor.gift',
        onSubmit: async (v) => { reason = v.reason; },
      });
      if (!ok) return;
      Object.assign(body, { gift: true, reason });
    }
    await post(billPath('/lines'), body);
    queueTicketLine({ billId: S.billId, product: S.products.find((p) => p.id === productId), qty, gift });
    S.qty = 1;
    S.gift = false;
    await afterChange();
  }

  async function settleResult(r) {
    toast(r.settled ? t('floor.settledToast') : t('floor.paidToast', { amount: fmtMoney(r.paid ?? r.amount) }), 'success');
    await afterChange(true);
  }

  const amountInput = () => {
    const raw = document.getElementById('payAmount').value;
    const fen = parseFen(raw);
    if (Number.isNaN(fen) || (fen !== null && fen <= 0)) throw new Error(t('err.badAmount'));
    return fen === null ? undefined : fen;
  };

  return {
    stopPolling,
    handlers: {
      click: {
        addItem: (el) => addLine(Number(el.dataset.id), clampQty(S.qty), S.gift),
        plusLine: (el) => addLine(Number(el.dataset.id), 1, false),
        setCategory: (el) => { S.category = el.dataset.cat; ctx.renderBill(); },
        printReceipt: printReceiptManual,
        backToBoard: () => document.getElementById('board').scrollIntoView({ behavior: 'smooth' }),
        voidLine: (el) => formDialog({
          title: t('floor.void'), fields: [reasonField(t('floor.reason'))], submit: 'floor.void', danger: true,
          onSubmit: async (v) => { await post(billPath(`/lines/${el.dataset.id}/void`), { reason: v.reason }); await afterChange(); },
        }),
        discount: () => formDialog({
          title: t('floor.setDiscount'), submit: 'common.save',
          fields: [{ name: 'amount', label: t('floor.discountAmount'), type: 'money', required: true }, reasonField(t('floor.reason'))],
          onSubmit: async (v) => { await post(billPath('/discount'), { amount: v.amount, reason: v.reason }); await afterChange(); },
        }),
        transfer: () => {
          const free = S.tables.filter((x) => x.status === 'free' && !x.bill_id);
          return formDialog({
            title: t('floor.transfer'), submit: 'floor.transfer',
            intro: free.length ? '' : t('floor.noFreeTables'),
            fields: [{ name: 'to', label: t('floor.toTable'), type: 'select', required: true, options: free.map((x) => ({ value: x.id, label: x.name })) }],
            onSubmit: async (v) => { await post(billPath('/transfer'), { toTableId: Number(v.to) }); await afterChange(true); },
          });
        },
        pay: async (el) => {
          const amount = amountInput();
          if (el.dataset.method === 'credit' && !await confirmDialog({ title: t('pay.credit'), message: t('floor.creditConfirm'), submit: 'common.confirm' })) return;
          await settleResult(await post(billPath('/pay'), { method: el.dataset.method, amount }));
        },
        payOnline: async (el) => {
          const method = el.dataset.method;
          const r = await post(billPath('/pay-online'), { method, amount: amountInput() });
          S.pending = { ...r, method, paid: false };
          await afterChange();
          startPolling();
        },
        simulate: async () => {
          await post('/dev/mock-pay', { outTradeNo: S.pending.outTradeNo });
          await pollPending();
        },
        dismissPending: () => { stopPolling(); S.pending = null; ctx.renderBill(); },
        redeem: () => formDialog({
          title: t('floor.redeem'), submit: 'floor.redeemGo',
          fields: [{ name: 'code', label: t('floor.voucherCode'), type: 'text', required: true }],
          onSubmit: async (v) => {
            const r = await post(billPath('/redeem'), { code: v.code });
            toast(t('floor.voucherOk', { amount: fmtMoney(r.amount) }), 'success');
            await afterChange(true);
          },
        }),
      },
      input: {
        setQuery: (el) => { S.query = el.value; ctx.renderGrid(); },
        setQty: (el) => { S.qty = Number(el.value) || 1; },
      },
      change: {
        setGift: (el) => { S.gift = el.checked; },
      },
    },
  };
}

function clampQty(q) {
  return Math.min(MAX_QTY, Math.max(1, Math.trunc(q)));
}
