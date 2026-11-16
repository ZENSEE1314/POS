// Order ahead from a shop (pickup or delivery), and "My orders" with each order's progress and paying for it.
import { t, addStrings } from './i18n.js';
import { html, setHtml, fmtMoney, fmtDateTime, productName, session, get, post, sheet, toast, toastError, busy, skeleton } from './core.js';
import { ensureSignedIn, verifyPhone } from './login.js';
import { menuHtml, loadCart, openPay } from './table.js';

const CART_PREFIX = 'nightpos.shopcart.';
const MAX_QTY = 99;
const STATUS_TONE = { pending: 'pending', accepted: 'ok', rejected: 'bad', cancelled: 'neutral' };
const enc = encodeURIComponent;

addStrings({
  en: {
    'shop.order': 'Order for pickup or delivery', 'shop.orderSub': 'Order now, collect or have it delivered',
    'shop.mine': 'My orders', 'shop.mineSub': 'Pickup and delivery orders, and paying for them',
    'shop.title': 'Order ahead', 'shop.how': 'How do you want it?', 'shop.mode.pickup': 'I\'ll pick it up', 'shop.mode.delivery': 'Deliver to me',
    'shop.address': 'Delivery address', 'shop.pickupAt': 'Pick up at (optional)', 'shop.note': 'Note for the shop',
    'shop.send': 'Send order', 'shop.sent': 'Order sent. The shop will confirm it.', 'shop.needPhone': 'The shop needs your phone number to reach you about the order.',
    'shop.after': 'After the shop confirms your order you can pay for it here.', 'shop.empty': 'No pickup or delivery orders yet.',
    'shop.pay': 'Pay', 'shop.paid': 'Paid', 'shop.toPay': 'To pay: {amount}', 'shop.payAtShop': 'Pay in the app now, or when you collect.',
    'shop.step.ready': 'Ready for pickup', 'shop.step.out': 'On its way', 'shop.step.done': 'Done', 'shop.deliverTo': 'Deliver to: {address}',
    'shop.pickupWhen': 'Pickup: {when}', 'shop.mode': '{mode} · {store}', 'menu.perKg': '{price}/kg', 'menu.weighInStore': 'Sold by weight, buy in store',
  },
  zh: {
    'shop.order': '自提或外送下单', 'shop.orderSub': '现在下单，到店自提或送货上门',
    'shop.mine': '我的订单', 'shop.mineSub': '自提和外送订单，以及在线付款',
    'shop.title': '提前下单', 'shop.how': '取货方式', 'shop.mode.pickup': '到店自提', 'shop.mode.delivery': '送货上门',
    'shop.address': '送货地址', 'shop.pickupAt': '自提时间（可选）', 'shop.note': '给店家的备注',
    'shop.send': '提交订单', 'shop.sent': '订单已提交，等待店家确认。', 'shop.needPhone': '店家需要您的手机号来联系订单事宜。',
    'shop.after': '店家确认订单后，您可以在这里付款。', 'shop.empty': '还没有自提或外送订单。',
    'shop.pay': '付款', 'shop.paid': '已付款', 'shop.toPay': '待付：{amount}', 'shop.payAtShop': '可以现在在线付款，也可以取货时付款。',
    'shop.step.ready': '已备好，可自提', 'shop.step.out': '配送中', 'shop.step.done': '已完成', 'shop.deliverTo': '送至：{address}',
    'shop.pickupWhen': '自提：{when}', 'shop.mode': '{mode} · {store}', 'menu.perKg': '{price}/千克', 'menu.weighInStore': '称重商品，请到店购买',
  },
});

/** The guest needs to be signed in with a phone the shop can call (verified, or the one they registered with). */
async function readyToOrder() {
  if (!session.customer && !await ensureSignedIn()) return false;
  if (session.customer.phone || session.customer.loginPhone) return true;
  toast(t('shop.needPhone'));
  return Boolean(await verifyPhone()) && Boolean(session.customer?.phone);
}

export async function mountShopOrder(root, { company, store, navigate }) {
  setHtml(root, skeleton(5));
  const menu = await get(`/api/guest/venue/${enc(company)}/${enc(store)}/menu`);
  const products = new Map(menu.products.map((p) => [p.id, p]));
  const cartKey = `${CART_PREFIX}${company}/${store}`;
  const state = { cart: loadCart(cartKey, products), category: '' };
  const saveCart = () => {
    try { sessionStorage.setItem(cartKey, JSON.stringify([...state.cart])); } catch { /* blocked storage: cart lives in memory */ }
  };
  const count = () => [...state.cart.values()].reduce((a, b) => a + b, 0);
  const total = () => [...state.cart].reduce((s, [id, q]) => s + (products.get(id)?.price ?? 0) * q, 0);

  const render = () => {
    const n = count();
    setHtml(root, html`<div class="g-tableban"><strong>${t('shop.title')}</strong><span class="g-muted">${menu.store.name}</span></div>
      ${menuHtml(menu.products, state)}
      ${n > 0 && html`<div class="g-cartbar g-cartbar--still"><span><strong>${t('cart.items', { n })}</strong> · <span class="g-num">${fmtMoney(total())}</span></span>
        <button type="button" class="g-btn g-btn--primary" data-review>${t('cart.review')}</button></div>`}`);
  };

  const review = () => sheet(t('cart.title'), (body, close) => {
    const lines = [...state.cart].map(([id, qty]) => ({ p: products.get(id), qty })).filter((l) => l.p);
    setHtml(body, html`<ul class="g-lines">${lines.map((l) => html`<li><span>${productName(l.p)} × ${l.qty}</span><span class="g-num">${fmtMoney(l.p.price * l.qty)}</span></li>`)}</ul>
      <dl class="g-sum"><dt class="g-sum__due">${t('bill.total')}</dt><dd class="g-sum__due g-num">${fmtMoney(total())}</dd></dl>
      <form novalidate>
        <p class="g-hint g-gap">${t('shop.how')}</p>
        <div class="g-seg" role="group" aria-label="${t('shop.how')}">${['pickup', 'delivery'].map((m) =>
          html`<button type="button" data-mode="${m}" aria-pressed="${String(m === 'pickup')}">${t(`shop.mode.${m}`)}</button>`)}</div>
        <div class="g-field" data-for="delivery" hidden><label for="addr">${t('shop.address')}</label><textarea id="addr" name="address" maxlength="300"></textarea></div>
        <div class="g-field" data-for="pickup"><label for="when">${t('shop.pickupAt')}</label><input id="when" name="when" type="datetime-local"></div>
        <div class="g-field"><label for="note">${t('shop.note')}</label><textarea id="note" name="note" maxlength="200"></textarea></div>
        <p class="g-hint g-lead">${t('shop.after')}</p>
        <p class="g-error" role="alert" hidden></p>
        <button type="submit" class="g-btn g-btn--primary g-btn--block">${t('shop.send')}</button></form>`);
    const form = body.querySelector('form');
    let mode = 'pickup';
    form.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      mode = b.dataset.mode;
      form.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      body.querySelectorAll('[data-for]').forEach((el) => { el.hidden = el.dataset.for !== mode; });
    }));
    const submit = form.querySelector('[type=submit]');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void busy(submit, async () => {
        const err = form.querySelector('.g-error');
        err.hidden = true;
        if (!await readyToOrder()) return;
        const when = form.elements.when.value;
        try {
          await post('/api/guest/shop-orders', {
            company, store, mode, items: [...state.cart].map(([productId, qty]) => ({ productId, qty })), note: form.elements.note.value,
            ...(mode === 'delivery' ? { address: form.elements.address.value } : {}),
            ...(mode === 'pickup' && when ? { pickupAt: new Date(when).getTime() } : {}),
          });
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
          return;
        }
        state.cart.clear();
        saveCart();
        toast(t('shop.sent'), 'success');
        close(true);
        navigate(`/g/${enc(company)}/orders`);
      })();
    });
  });

  const onClick = async (e) => {
    const el = e.target.closest('button');
    if (!el || !root.contains(el)) return;
    try {
      if (el.dataset.cat !== undefined) state.category = el.dataset.cat;
      else if (el.dataset.inc) state.cart.set(Number(el.dataset.inc), Math.min(MAX_QTY, (state.cart.get(Number(el.dataset.inc)) ?? 0) + 1));
      else if (el.dataset.dec) {
        const id = Number(el.dataset.dec);
        const q = (state.cart.get(id) ?? 0) - 1;
        if (q > 0) state.cart.set(id, q); else state.cart.delete(id);
      } else if (el.dataset.review !== undefined) await review();
      saveCart();
      render();
    } catch (err) {
      toastError(err);
    }
  };
  root.addEventListener('click', onClick);
  render();
  return () => root.removeEventListener('click', onClick);
}

function orderCard(o) {
  const due = o.bill?.status === 'open' ? o.bill.due : 0;
  return html`<article class="g-order">
    <div class="g-order__head"><span class="g-badge g-badge--${STATUS_TONE[o.status]}">${t(`orders.${o.status}`)}</span>
      <span class="g-num">${fmtMoney(o.total)}</span></div>
    <p class="g-hint">${t('shop.mode', { mode: t(`shop.mode.${o.mode}`), store: o.storeName })} · ${fmtDateTime(o.createdAt)}</p>
    ${o.fulfilStatus && html`<p><span class="g-badge g-badge--ok">${t(`shop.step.${o.fulfilStatus}`)}</span></p>`}
    <ul class="g-lines">${o.items.map((i) => html`<li><span>${productName(i)} × ${i.qty}</span></li>`)}</ul>
    ${o.address && html`<p class="g-hint">${t('shop.deliverTo', { address: o.address })}</p>`}
    ${o.pickupAt && html`<p class="g-hint">${t('shop.pickupWhen', { when: fmtDateTime(o.pickupAt) })}</p>`}
    ${o.rejectReason && html`<p class="g-hint">${t('orders.reason', { reason: o.rejectReason })}</p>`}
    ${o.status === 'pending' && html`<button type="button" class="g-btn g-btn--small g-gap" data-cancel="${o.id}">${t('orders.cancel')}</button>`}
    ${due > 0 && html`<p class="g-hint">${t('shop.payAtShop')}</p>
      <button type="button" class="g-btn g-btn--primary g-gap" data-pay="${o.id}" data-due="${due}">${t('shop.pay')} · ${fmtMoney(due)}</button>`}
    ${o.bill?.status === 'settled' && html`<p class="g-badge g-badge--ok g-gap">${t('shop.paid')}</p>`}
  </article>`;
}

export async function mountMyOrders(root, { company }) {
  setHtml(root, skeleton(4));
  if (!session.customer && !await ensureSignedIn()) {
    setHtml(root, html`<p class="g-empty">${t('login.why')}</p>`);
    return;
  }
  const load = async () => {
    const acct = await get(`/api/guest/account/${enc(company)}`);
    const orders = acct.orders.filter((o) => o.mode && o.mode !== 'table');
    setHtml(root, html`<h1 class="g-cat">${t('shop.mine')}</h1>
      ${orders.length ? html`<div class="g-card">${orders.map(orderCard)}</div>` : html`<p class="g-empty">${t('shop.empty')}</p>`}`);
  };
  root.addEventListener('click', async (e) => {
    const el = e.target.closest('button');
    if (!el) return;
    try {
      if (el.dataset.cancel) {
        await post(`/api/guest/orders/${el.dataset.cancel}/cancel`);
        toast(t('orders.cancelled.toast'));
        await load();
      } else if (el.dataset.pay) {
        await openPay(`/api/guest/orders/${el.dataset.pay}/pay`, Number(el.dataset.due), company, load);
      }
    } catch (err) {
      toastError(err);
    }
  });
  await load();
}
