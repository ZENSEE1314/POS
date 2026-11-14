// Event handlers for the bill panel (add/void/discount/transfer/pay/online pay/voucher).
import { t, tOr } from './i18n.js';
import { post } from './session.js';
import { parseFen, fmtMoney } from './util.js';
import { formDialog, confirmDialog, toast } from './ui.js';
import { S } from './floor-state.js';
import { printReceiptAuto, printReceiptManual, queueTicketLine } from './print/hooks.js';
import { isWeighed } from './business.js';
import { productName } from './util.js';

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

  /** Asks for the weight of an item sold by weight; resolves grams, or null when cancelled. */
  async function askWeight(product) {
    let grams = null;
    const ok = await formDialog({
      title: t('weigh.title', { name: productName(product) }), intro: t('weigh.hint', { price: fmtMoney(product.price) }), submit: 'weigh.add',
      fields: [{ name: 'kg', label: t('weigh.kg'), type: 'qty', required: true }],
      onSubmit: async (v) => {
        if (!(v.kg > 0)) throw new Error(t('err.badQty'));
        grams = v.kg;
      },
    });
    return ok ? grams : null;
  }

  async function addLine(productId, qty, gift) {
    const product = S.products.find((p) => p.id === productId);
    const body = { productId, qty };
    if (isWeighed(product)) {
      const grams = await askWeight(product);
      if (grams === null) return;
      Object.assign(body, { qty: 1, weightG: grams });
    }
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
    queueTicketLine({ billId: S.billId, product, qty: body.qty, gift });
    S.qty = 1;
    S.gift = false;
    await afterChange();
  }

  async function settleResult(r) {
    const settledText = S.bill?.bill.table_id == null ? t('counter.settled') : t('floor.settledToast');
    toast(r.settled ? settledText : t('floor.paidToast', { amount: fmtMoney(r.paid ?? r.amount) }), 'success');
    await afterChange(true);
  }

  const amountInput = () => {
    const raw = document.getElementById('payAmount').value;
    const fen = parseFen(raw);
    if (Number.isNaN(fen) || (fen !== null && fen <= 0)) throw new Error(t('err.badAmount'));
    return fen === null ? undefined : fen;
  };

  async function scan(form) {
    const input = form.elements.code;
    const code = input.value.trim();
    if (!code) return;
    input.value = '';
    const qty = clampQty(S.qty);
    const r = await post(billPath('/scan'), { code, qty });
    if (r.needsWeight) {
      input.blur();
      const grams = await askWeight({ ...r.product, name_en: r.product.nameEn });
      if (grams === null) return;
      await post(billPath('/lines'), { productId: r.product.id, qty: 1, weightG: grams });
    }
    const product = S.products.find((p) => p.id === (r.productId ?? r.product.id));
    if (product) queueTicketLine({ billId: S.billId, product, qty: isWeighed(product) ? 1 : qty, gift: false });
    S.qty = 1;
    await afterChange();
    document.getElementById('scan')?.focus();
  }

  return {
    stopPolling,
    handlers: {
      submit: { scan },
      click: {
        addItem: (el) => addLine(Number(el.dataset.id), clampQty(S.qty), S.gift),
        plusLine: (el) => addLine(Number(el.dataset.id), 1, false),
        setCategory: (el) => { S.category = el.dataset.cat; ctx.renderBill(); },
        printReceipt: printReceiptManual,
        backToBoard: () => document.getElementById('board')?.scrollIntoView({ behavior: 'smooth' }),
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
        attachMember: () => formDialog({
          title: t('counter.memberTitle'), intro: t('counter.memberHint'), submit: 'common.save',
          fields: [{ name: 'phone', label: t('floor.phone'), type: 'tel', required: true }],
          onSubmit: async (v) => { await post(billPath('/member'), { phone: v.phone }); await afterChange(true); },
        }),
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
