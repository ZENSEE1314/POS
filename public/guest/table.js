// Menu (browse or order at a table), cart, my orders at this table, the table's bill and paying it.
import { t, tOr } from './i18n.js';
import {
  html, raw, setHtml, fmtMoney, fmtBottles, parseFen, productName, productSubName, session, get, post, sheet, toast, toastError, busy, skeleton, isWechatBrowser,
} from './core.js';
import { ensureSignedIn, verifyPhone } from './login.js';
import { requestsHtml, onCancelRequest } from './extras.js';
import { qrSvg } from '/qr.js';

const ORDER_POLL_MS = 8000;
const PAY_POLL_MS = 2000;
const PAY_POLL_TRIES = 90;
const MAX_QTY = 99;
const CART_PREFIX = 'nightpos.cart.';
const RESUME_KEY = 'nightpos.resumeOrder';
const STATUS_TONE = { pending: 'pending', accepted: 'ok', rejected: 'bad', cancelled: 'neutral' };
const SERVICE_REASONS = ['waiter', 'ice', 'glasses', 'cleanup', 'bill', 'other'];

const categoryLabel = (c) => (c ? tOr(`cat.${c}`, c) : t('cat.none'));

// ---------- menu list (shared by browse and table modes) ----------

export function menuHtml(products, { cart, category }) {
  if (!products.length) return html`<p class="g-empty">${t('menu.empty')}</p>`;
  const cats = [...new Set(products.map((p) => p.category))];
  const shown = category ? products.filter((p) => p.category === category) : products;
  const groups = cats.filter((c) => !category || c === category).map((c) => [c, shown.filter((p) => p.category === c)]);
  return html`<div class="g-chips" role="group" aria-label="${t('table.tab.menu')}">
      <button type="button" class="g-chip" data-cat="" aria-pressed="${String(!category)}">${t('menu.all')}</button>
      ${cats.map((c) => html`<button type="button" class="g-chip" data-cat="${c}" aria-pressed="${String(c === category)}">${categoryLabel(c)}</button>`)}
    </div>
    ${groups.map(([c, list]) => html`<h2 class="g-cat">${categoryLabel(c)}</h2><ul class="g-items">${list.map((p) => {
      const qty = cart?.get(p.id) ?? 0;
      const name = productName(p);
      return html`<li class="g-item ${p.soldOut ? 'g-item--out' : ''}">
        <div class="g-item__body"><p class="g-item__name">${name}</p>${productSubName(p) && html`<span class="g-item__sub">${productSubName(p)}</span>`}
          <p class="g-item__price g-num">${p.soldOut ? t('menu.soldOut') : p.byWeight ? t('menu.perKg', { price: fmtMoney(p.price) }) : fmtMoney(p.price)}</p>
          ${cart && p.byWeight && html`<span class="g-item__sub">${t('menu.weighInStore')}</span>`}</div>
        ${cart && !p.soldOut && !p.byWeight && html`<div class="g-step">
          ${qty > 0 && html`<button type="button" data-dec="${p.id}" aria-label="${t('menu.remove', { name })}">−</button><output aria-live="polite">${qty}</output>`}
          <button type="button" class="g-step__add" data-inc="${p.id}" aria-label="${t('menu.add', { name })}" ${qty >= MAX_QTY ? 'disabled' : ''}>+</button></div>`}
      </li>`;
    })}</ul>`)}`;
}

/** Read-only menu for a store (no table): prices and availability. */
export async function mountMenuBrowse(root, { company, store }) {
  setHtml(root, skeleton(5));
  const data = await get(`/api/guest/venue/${encodeURIComponent(company)}/${encodeURIComponent(store)}/menu`);
  let category = '';
  const render = () => setHtml(root, html`<div class="g-tableban"><span class="g-muted">${t('menu.browseOnly')}</span></div>${menuHtml(data.products, { cart: null, category })}`);
  render();
  root.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cat]');
    if (chip) { category = chip.dataset.cat; render(); }
  });
  return { title: data.store.name, subtitle: data.company.name };
}

// ---------- table mode ----------

export async function mountTable(root, { token, onTitle }) {
  setHtml(root, skeleton(5));
  let info;
  try {
    info = await get(`/api/guest/table/${encodeURIComponent(token)}`);
  } catch (e) {
    if (e.status !== 404) throw e;
    setHtml(root, html`<p class="g-empty">${t('table.notFound')}</p>`);
    return () => {};
  }
  onTitle?.({ title: info.store.name, subtitle: info.company.name, company: info.company.code, theme: info.theme });
  const menu = await get(`/api/guest/venue/${encodeURIComponent(info.company.code)}/${encodeURIComponent(info.store.code)}/menu`);
  const products = new Map(menu.products.map((p) => [p.id, p]));
  const cartKey = `${CART_PREFIX}${token}`;
  const features = info.features ?? {};
  const state = { tab: 'menu', category: '', cart: loadCart(cartKey, products), orders: [], requests: [], bill: undefined, timer: null, alive: true, barShown: false, justPaid: false };

  const saveCart = () => {
    try { sessionStorage.setItem(cartKey, JSON.stringify([...state.cart])); } catch { /* blocked storage: cart lives in memory */ }
  };

  const loadOrders = async () => {
    if (!session.customer) { state.orders = []; return; }
    const acct = await get(`/api/guest/account/${encodeURIComponent(info.company.code)}`);
    state.orders = acct.orders.filter((o) => o.tableName === info.table.name && o.storeName === info.store.name);
  };
  const loadRequests = async () => {
    if (!session.customer) { state.requests = []; return; }
    const list = await get(`/api/guest/requests/${encodeURIComponent(info.company.code)}`);
    state.requests = list.filter((r) => r.tableName === info.table.name && r.storeName === info.store.name);
  };
  const loadBill = async () => {
    state.bill = session.customer ? (await get(`/api/guest/table/${encodeURIComponent(token)}/bill`)).bill : null;
  };

  const cartCount = () => [...state.cart.values()].reduce((a, b) => a + b, 0);
  const cartTotal = () => [...state.cart].reduce((s, [id, q]) => s + (products.get(id)?.price ?? 0) * q, 0);
  const pendingCount = () => state.orders.filter((o) => o.status === 'pending').length;
  const pendingRequests = () => state.requests.filter((r) => r.status === 'pending').length;
  const hasServices = ['service', 'song', 'bottle', 'gift'].some((f) => features[f]);

  function render() {
    if (!state.alive) return;
    const tabs = [['menu', t('table.tab.menu'), 0], ['orders', t('table.tab.orders'), pendingCount()], ['bill', t('table.tab.bill'), 0],
      ...(hasServices ? [['more', t('table.tab.more'), pendingRequests()]] : [])];
    let body;
    if (state.tab === 'menu') body = menuHtml(menu.products, state);
    else if (state.tab === 'orders') body = ordersHtml(state.orders, session.customer);
    else if (state.tab === 'more') body = servicesHtml(features, state.requests, session.customer);
    else body = billHtml(state.bill, session.customer, state.justPaid);
    const n = cartCount();
    // The bar slides in once; re-renders on every tap must not replay the animation.
    const barClass = state.barShown ? 'g-cartbar g-cartbar--still' : 'g-cartbar';
    state.barShown = state.tab === 'menu' && n > 0;
    setHtml(root, html`<div class="g-tableban"><div><span class="g-muted">${t('table.at')}</span><br><strong>${info.table.name}</strong></div>
        <span class="g-muted">${info.store.name}</span></div>
      ${(info.gifts ?? []).map((g) => html`<div class="g-gift" role="status"><strong>🎁 ${t('gift.notice', { table: g.fromTable })}</strong><br>
        <span>${g.items}</span>${g.message && html`<br><span class="g-hint">“${g.message}”</span>`}</div>`)}
      <div class="g-seg" role="group">${tabs.map(([id, label, count]) =>
        html`<button type="button" data-tab="${id}" aria-pressed="${String(state.tab === id)}">${label}${count > 0 && html`<span class="g-count">${count}</span>`}</button>`)}</div>
      <div data-body aria-live="polite">${body}</div>
      ${state.tab === 'menu' && n > 0 && html`<div class="${barClass}"><span><strong>${t('cart.items', { n })}</strong> · <span class="g-num">${fmtMoney(cartTotal())}</span></span>
        <button type="button" class="g-btn g-btn--primary" data-review>${t('cart.review')}</button></div>`}`);
  }

  const refresh = async () => {
    try {
      await Promise.all([loadOrders(), loadBill(), loadRequests()]);
    } catch (e) {
      if (e.status !== 401) toastError(e);
    }
    render();
  };

  const reviewCart = (note = '', giftTables = []) => sheet(t('cart.title'), (body, close) => {
    const lines = [...state.cart].map(([id, qty]) => ({ p: products.get(id), qty })).filter((l) => l.p);
    setHtml(body, html`<ul class="g-lines">${lines.map((l) => html`<li><span>${productName(l.p)} × ${l.qty}</span><span class="g-num">${fmtMoney(l.p.price * l.qty)}</span></li>`)}</ul>
      <dl class="g-sum"><dt class="g-sum__due">${t('bill.total')}</dt><dd class="g-sum__due g-num">${fmtMoney(cartTotal())}</dd></dl>
      ${giftTables.length > 0 && html`<div class="g-field g-gap"><label for="gto">${t('gift.for')}</label><select id="gto">
        <option value="">${t('gift.ourTable')}</option>${giftTables.map((g) => html`<option value="${g.id}">${t('gift.toTable', { name: g.name })}</option>`)}</select>
        <p class="g-hint">${t('gift.charged')}</p></div>`}
      <div class="g-field g-gap"><label for="note">${t('cart.note')}</label><textarea id="note" maxlength="200" placeholder="${t('cart.notePh')}">${note}</textarea></div>
      <p class="g-hint g-lead">${t('cart.staffNote')}</p>
      <button type="button" class="g-btn g-btn--primary g-btn--block" data-send>${t('cart.send')}</button>`);
    const send = body.querySelector('[data-send]');
    send.addEventListener('click', busy(send, async () => {
      // WeChat/Alipay/Douyin sign-in leaves the page; remember to reopen this sheet (with the note) when the guest is back.
      writeSession(RESUME_KEY, JSON.stringify({ token, note: body.querySelector('#note').value }));
      const signedIn = await ensureSignedIn();
      if (!signedIn) return;
      writeSession(RESUME_KEY, null);
      const giftTo = body.querySelector('#gto')?.value;
      await post('/api/guest/orders', {
        qrToken: token, items: [...state.cart].map(([productId, qty]) => ({ productId, qty })), note: body.querySelector('#note').value,
        ...(giftTo ? { giftTo: Number(giftTo) } : {}),
      });
      state.cart.clear();
      saveCart();
      toast(giftTo ? t('gift.sent') : t('cart.sent'), 'success');
      close(true);
      state.tab = 'orders';
      await refresh();
    }));
  });

  const loadGiftTables = async () => {
    if (!features.gift || !session.customer) return [];
    try { return await get(`/api/guest/table/${encodeURIComponent(token)}/tables`); } catch { return []; }
  };

  const cancelOrder = async (id) => {
    await post(`/api/guest/orders/${id}/cancel`);
    toast(t('orders.cancelled.toast'));
    await refresh();
  };

  root.addEventListener('click', async (e) => {
    const el = e.target.closest('button');
    if (!el || !root.contains(el)) return;
    try {
      if (el.dataset.tab) {
        state.tab = el.dataset.tab;
        render();
        if (state.tab !== 'menu') {
          if (!session.customer && !await ensureSignedIn()) return;
          await refresh();
        }
      } else if (el.dataset.cat !== undefined) {
        state.category = el.dataset.cat;
        render();
      } else if (el.dataset.inc) {
        const id = Number(el.dataset.inc);
        state.cart.set(id, Math.min(MAX_QTY, (state.cart.get(id) ?? 0) + 1));
        saveCart();
        render();
      } else if (el.dataset.dec) {
        const id = Number(el.dataset.dec);
        const q = (state.cart.get(id) ?? 0) - 1;
        if (q > 0) state.cart.set(id, q); else state.cart.delete(id);
        saveCart();
        render();
      } else if (el.dataset.review !== undefined) {
        await reviewCart('', await loadGiftTables());
        render();
      } else if (el.dataset.cancelOrder) {
        await busy(el, () => cancelOrder(el.dataset.cancelOrder))();
      } else if (el.dataset.signin !== undefined) {
        if (await ensureSignedIn()) await refresh();
      } else if (el.dataset.service !== undefined) {
        await askService(token, el.dataset.service);
        await refresh();
      } else if (el.dataset.song !== undefined) {
        await askSong(token);
        await refresh();
      } else if (el.dataset.bottle !== undefined) {
        await askBottle(token, info);
        await refresh();
      } else if (el.dataset.giftstart !== undefined) {
        state.tab = 'menu';
        render();
      } else if (el.dataset.pay !== undefined) {
        await openPay(`/api/guest/table/${encodeURIComponent(token)}/pay`, state.bill?.totals.due ?? 0, info.company.code, async () => { state.justPaid = true; await refresh(); });
      }
    } catch (err) {
      toastError(err);
    }
  });

  onCancelRequest(root, refresh);
  render();
  if (session.customer) await refresh();
  const resume = readResume();
  if (resume?.token === token) {
    writeSession(RESUME_KEY, null);
    if (session.customer && state.cart.size) void reviewCart(resume.note).then(render);
  }
  // Staff decisions and other guests' payments change what this table sees; poll gently while the page is open.
  state.timer = setInterval(() => {
    if (document.visibilityState === 'visible' && session.customer && state.tab !== 'menu') void refresh();
    else if (document.visibilityState === 'visible' && session.customer && pendingCount() > 0) void loadOrders().then(render).catch(() => {});
  }, ORDER_POLL_MS);
  return () => { state.alive = false; clearInterval(state.timer); };
}

function writeSession(key, value) {
  try {
    if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value);
  } catch { /* blocked storage: the guest just reopens the order sheet themselves */ }
}

function readResume() {
  try { return JSON.parse(sessionStorage.getItem(RESUME_KEY) ?? 'null'); } catch { return null; }
}

export function loadCart(key, products) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? '[]');
    return new Map(saved.filter(([id, q]) => products.has(id) && !products.get(id).soldOut && !products.get(id).byWeight && Number.isInteger(q) && q > 0 && q <= MAX_QTY));
  } catch {
    return new Map();
  }
}

function signInPrompt() {
  return html`<div class="g-card"><p class="g-muted g-lead">${t('login.why')}</p>
    <button type="button" class="g-btn g-btn--primary g-btn--block" data-signin>${t('login.title')}</button></div>`;
}

export function ordersHtml(orders, signedIn = true) {
  if (!signedIn) return signInPrompt();
  if (!orders.length) return html`<p class="g-empty">${t('orders.empty')}</p>`;
  return html`<div class="g-card">${orders.map((o) => html`<article class="g-order">
    <div class="g-order__head"><span class="g-badge g-badge--${STATUS_TONE[o.status]}">${t(`orders.${o.status}`)}</span>
      <span class="g-num">${fmtMoney(o.total)}</span></div>
    ${o.toTableName && html`<p class="g-hint">🎁 ${t('orders.giftTo', { name: o.toTableName })}</p>`}
    <ul class="g-lines">${o.items.map((i) => html`<li><span>${productName(i)} × ${i.qty}</span></li>`)}</ul>
    ${o.note && html`<p class="g-hint">${o.note}</p>`}
    ${o.rejectReason && html`<p class="g-hint">${t('orders.reason', { reason: o.rejectReason })}</p>`}
    ${o.status === 'pending' && html`<button type="button" class="g-btn g-btn--small g-gap" data-cancel-order="${o.id}">${t('orders.cancel')}</button>`}
  </article>`)}</div>`;
}

function servicesHtml(features, requests, signedIn) {
  if (!signedIn) return signInPrompt();
  return html`${features.service && html`<section class="g-card" aria-labelledby="svc-t"><h2 id="svc-t" class="g-card__title">${t('svc.callTitle')}</h2>
      <div class="g-svcgrid">${SERVICE_REASONS.map((r) => html`<button type="button" class="g-btn" data-service="${r}">${t(`svc.reason.${r}`)}</button>`)}</div></section>`}
    <div class="g-actions">
      ${features.song && html`<button type="button" class="g-tile" data-song><span class="g-tile__mark" aria-hidden="true">♪</span><span class="g-tile__text"><strong>${t('song.title')}</strong></span></button>`}
      ${features.bottle && html`<button type="button" class="g-tile" data-bottle><span class="g-tile__mark" aria-hidden="true">⌂</span><span class="g-tile__text"><strong>${t('bottle.title')}</strong></span></button>`}
      ${features.gift && html`<button type="button" class="g-tile" data-giftstart><span class="g-tile__mark" aria-hidden="true">🎁</span><span class="g-tile__text"><strong>${t('gift.title')}</strong><span>${t('gift.text')}</span></span></button>`}
    </div>
    <section class="g-card g-gap" aria-labelledby="req-t"><h2 id="req-t" class="g-card__title">${t('req.mine')}</h2>${requestsHtml(requests)}</section>`;
}

/** A small form sheet that posts one request; resolves true once sent. */
function requestSheet(title, fieldsHtml, toBody, sentKey) {
  return sheet(title, (body, close) => {
    setHtml(body, html`<form novalidate>${fieldsHtml}<p class="g-error" role="alert" hidden></p>
      <button type="submit" class="g-btn g-btn--primary g-btn--block">${t('svc.send')}</button></form>`);
    const form = body.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = form.querySelector('.g-error');
      try {
        await post('/api/guest/requests', toBody(form.elements));
        toast(t(sentKey), 'success');
        close(true);
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      }
    });
  });
}

const askService = (token, reason) => requestSheet(t(`svc.reason.${reason}`),
  html`<div class="g-field"><label for="sn">${t('svc.note')}</label><input id="sn" name="note" maxlength="200"></div>`,
  (f) => ({ kind: 'service', qrToken: token, reason, note: f.note.value }), 'svc.sent');

const askSong = (token) => requestSheet(t('song.title'),
  html`<div class="g-field"><label for="st">${t('song.song')}</label><input id="st" name="title" maxlength="100" required></div>
    <div class="g-field"><label for="sa">${t('song.artist')}</label><input id="sa" name="artist" maxlength="100"></div>
    <div class="g-field"><label for="sm">${t('song.note')}</label><input id="sm" name="note" maxlength="200"></div>`,
  (f) => ({ kind: 'song', qrToken: token, title: f.title.value, artist: f.artist.value, note: f.note.value }), 'song.sent');

async function askBottle(token, info) {
  if (!session.customer.phone) {
    toast(t('bottle.needPhone'));
    await verifyPhone();
    if (!session.customer?.phone) return;
  }
  const acct = await get(`/api/guest/account/${encodeURIComponent(info.company.code)}`);
  const here = acct.stash.filter((x) => x.storeName === info.store.name);
  await sheet(t('bottle.title'), (body, close) => {
    if (!here.length) { setHtml(body, html`<p class="g-muted">${t('bottle.none')}</p>`); return; }
    setHtml(body, html`<ul class="g-lines">${here.map((x) => html`<li><span><strong>${x.name}</strong><br><span class="g-hint">${t('account.stashLeft', { n: fmtBottles(x.leftMilli) })}</span></span>
      <button type="button" class="g-btn g-btn--small g-btn--primary" data-code="${x.code}">${t('bottle.ask')}</button></li>`)}</ul>`);
    body.querySelectorAll('[data-code]').forEach((b) => b.addEventListener('click', busy(b, async () => {
      await post('/api/guest/requests', { kind: 'bottle', qrToken: token, code: b.dataset.code });
      toast(t('bottle.sent'), 'success');
      close(true);
    })));
  });
}

function billHtml(bill, signedIn, justPaid) {
  if (!signedIn) return signInPrompt();
  if (bill === undefined) return skeleton(3);
  // Paying the last of it settles the bill and frees the table, so "no open bill" right after paying means "all paid".
  if (!bill) return html`<p class="g-empty">${justPaid ? t('bill.allPaid') : t('bill.none')}</p>`;
  const tot = bill.totals;
  const row = (label, fen, cls = '') => html`<dt class="${cls}">${label}</dt><dd class="g-num ${cls}">${fmtMoney(fen)}</dd>`;
  return html`<div class="g-card">
    <ul class="g-lines">${bill.lines.map((l) => html`<li><span>${productName(l)} × ${l.qty}${l.kind === 'gift' ? html` <span class="g-badge g-badge--ok">${t('bill.gift')}</span>` : ''}</span>
      <span class="g-num">${l.kind === 'gift' ? fmtMoney(0) : fmtMoney(l.qty * l.unitPrice)}</span></li>`)}</ul>
    <dl class="g-sum">${row(t('bill.subtotal'), tot.subtotal)}${tot.minSpendTopUp > 0 && row(t('bill.topUp'), tot.minSpendTopUp)}
      ${tot.tableFee > 0 && row(t('bill.tableFee'), tot.tableFee)}${tot.discount > 0 && row(t('bill.discount'), -tot.discount)}
      ${row(t('bill.total'), tot.total)}${tot.paid > 0 && row(t('bill.paid'), tot.paid)}${row(t('bill.due'), tot.due, 'g-sum__due')}</dl>
    ${tot.due > 0
      ? html`<button type="button" class="g-btn g-btn--primary g-btn--block g-gap" data-pay>${t('pay.title')} · ${fmtMoney(tot.due)}</button>`
      : html`<p class="g-badge g-badge--ok g-gap">${t('bill.allPaid')}</p>`}
  </div>`;
}

// ---------- paying ----------

/** Pays `due` through payPath (a table's or an order's pay endpoint) with WeChat, Alipay or the member wallet. */
export async function openPay(payPath, due, company, onDone) {
  if (due <= 0) return;
  const { payments } = session.config;
  let wallet = null;
  if (session.customer?.phone) {
    try { wallet = (await get(`/api/guest/account/${encodeURIComponent(company)}`)).wallet; } catch { /* the wallet button just stays hidden */ }
  }
  const choice = await sheet(t('pay.title'), (body, close) => {
    const yuan = (due / 100).toFixed(2);
    setHtml(body, html`<div class="g-field"><label for="amt">${t('pay.amount')}</label>
        <input id="amt" inputmode="decimal" value="${yuan}"><p class="g-hint">${t('pay.amountHint')}</p></div>
      <p class="g-error" role="alert" hidden></p>
      <div class="g-paybtns">
        ${payments.wechat && html`<button type="button" class="g-btn g-btn--primary" data-method="wechat">${t('pay.wechat')}</button>`}
        ${payments.alipay && html`<button type="button" class="g-btn g-btn--primary" data-method="alipay">${t('pay.alipay')}</button>`}
        ${session.customer?.phone
          ? wallet && html`<button type="button" class="g-btn" data-method="member">${t('pay.wallet', { balance: fmtMoney(wallet.balance) })}</button>`
          : html`<button type="button" class="g-btn" data-verify>${t('pay.walletNoPhone')}</button>`}
      </div>
      ${!payments.wechat && !payments.alipay && html`<p class="g-hint g-gap">${t('pay.unavailable')}</p>`}
      ${payments.wechat && !isWechatBrowser() && !session.config.mock && html`<p class="g-hint g-gap">${t('pay.wechatOutside')}</p>`}`);
    const errorEl = body.querySelector('.g-error');
    body.querySelectorAll('[data-method]').forEach((b) => b.addEventListener('click', () => {
      const amount = parseFen(body.querySelector('#amt').value);
      if (Number.isNaN(amount)) { errorEl.textContent = t('pay.badAmount'); errorEl.hidden = false; return; }
      close({ method: b.dataset.method, amount: Math.min(amount, due) });
    }));
    body.querySelector('[data-verify]')?.addEventListener('click', () => close({ verify: true }));
  });
  if (!choice) return;
  if (choice.verify) {
    if (await verifyPhone()) await openPay(payPath, due, company, onDone);
    return;
  }
  const r = await post(payPath, { method: choice.method, amount: choice.amount, returnPath: location.pathname });
  if (r.kind === 'done') {
    toast(t('pay.done'), 'success');
    await onDone();
    return;
  }
  await completeCharge(r, choice.method);
  await onDone();
}

/** Drives whatever the provider returned until the payment is confirmed (or the guest gives up). */
async function completeCharge(r, method) {
  if (r.kind === 'redirect') {
    location.href = r.url; // Alipay returns to this page with ?paid=<outTradeNo>
    return;
  }
  if (r.kind === 'jsapi') {
    const ok = await new Promise((resolve) => {
      const invoke = () => window.WeixinJSBridge.invoke('getBrandWCPayRequest', r.params, (res) => resolve(res?.err_msg === 'get_brand_wcpay_request:ok'));
      if (window.WeixinJSBridge) invoke(); else document.addEventListener('WeixinJSBridgeReady', invoke, { once: true });
    });
    if (!ok) { toast(t('pay.failed'), 'error'); return; }
    await waitForPayment(r.outTradeNo);
    return;
  }
  if (r.kind === 'qr') {
    let stop = false;
    const waiting = waitForPayment(r.outTradeNo, () => stop);
    await sheet(t('pay.qrTitle'), (body, close) => {
      setHtml(body, html`<div class="g-qr">${raw(qrSvg(r.qrContent, t('pay.qrTitle')) ?? '')}<p class="g-num">${fmtMoney(r.amount)}</p>
        <p class="g-hint">${t('pay.qrHint')}</p><p class="g-hint">${t('pay.waiting')}</p></div>`);
      void waiting.then(() => close());
    });
    stop = true;
    return;
  }
  if (r.kind === 'mock') {
    await sheet(t('pay.mockTitle'), (body, close) => {
      const amount = fmtMoney(r.amount);
      setHtml(body, html`<p class="g-muted g-lead">${t('pay.mockText', { method: t(`pay.${method}`), amount })}</p>
        <button type="button" class="g-btn g-btn--primary g-btn--block" data-mockpay>${t('pay.mockPay', { amount })}</button>`);
      const b = body.querySelector('[data-mockpay]');
      b.addEventListener('click', busy(b, async () => {
        await post(`/api/guest/payments/${encodeURIComponent(r.outTradeNo)}/mock-pay`);
        toast(t('pay.done'), 'success');
        close();
      }));
    });
  }
}

/** Polls a payment until paid or failed. Used after JSAPI, QR and when Alipay sends the guest back with ?paid=. */
export async function waitForPayment(outTradeNo, cancelled = () => false) {
  for (let i = 0; i < PAY_POLL_TRIES && !cancelled(); i++) {
    try {
      const s = await get(`/api/guest/payments/${encodeURIComponent(outTradeNo)}`);
      if (s.status === 'paid') { toast(t('pay.done'), 'success'); return true; }
      if (s.status === 'failed' || s.status === 'expired') { toast(t('pay.failed'), 'error'); return false; }
    } catch (e) {
      if (e.status === 404 || e.status === 401) return false;
    }
    await new Promise((r) => setTimeout(r, PAY_POLL_MS));
  }
  return false;
}
