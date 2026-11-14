// Pure rendering of the bill side panel. No network, no DOM access.
import { t, tOr } from './i18n.js';
import { app, can } from './session.js';
import { html, fmtMoney, fmtDateTime, productName, byId, raw } from './util.js';
import { emptyState, skeleton, badge, pressed } from './ui.js';
import { qrSvg } from './qr.js';
import { syncState } from './offline/index.js';
import { hasModule, isWeighed, fmtKg, fmtStock } from './business.js';

const ONLINE_METHODS = ['wechat', 'alipay'];
const INSTANT_METHODS = ['cash', 'member', 'credit'];

const methodLabel = (m) => tOr(`pay.${m}`, m);

export const categoryLabel = (c) => (c ? tOr(`cat.${c}`, c) : t('cat.none'));

export function productTiles(S) {
  const q = S.query.trim().toLowerCase();
  const list = S.products.filter((p) =>
    (S.category === 'all' || p.category === S.category)
    && (!q || `${p.name} ${p.name_en ?? ''}`.toLowerCase().includes(q)));
  if (!list.length) return emptyState(t('floor.noProducts'));
  return html`${list.map((p) => {
    const soldOut = p.track_stock && p.stock <= 0;
    return html`<button type="button" class="product" data-action="addItem" data-id="${p.id}" ${soldOut ? 'disabled' : ''}>
      <span class="product__name">${productName(p)}</span>
      <span class="product__price">${isWeighed(p) ? t('price.perKg', { price: fmtMoney(p.price) }) : fmtMoney(p.price)}</span>
      <span class="product__stock">${soldOut ? t('floor.soldOut') : p.track_stock ? t('floor.stock', { n: fmtStock(p) }) : ''}</span>
    </button>`;
  })}`;
}



function addPanel(S) {
  const categories = [...new Set(S.products.map((p) => p.category))];
  return html`<section class="bill__section" aria-labelledby="add-title">
    <h3 id="add-title" class="section-title">${t('floor.addItems')}</h3>
    ${hasModule('barcode') && html`<form class="scan-bar" data-form="scan" novalidate>
      <div class="field field--grow"><label for="scan">${t('counter.scan')}</label>
        <input id="scan" name="code" data-action="scanField" inputmode="numeric" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="done"></div>
      <button type="submit" class="btn btn--primary">${t('counter.scanGo')}</button></form>`}
    <div class="add-bar">
      <div class="field field--qty"><label for="qty">${t('floor.qty')}</label>
        <input id="qty" type="number" min="1" max="99" step="1" value="${S.qty}" data-action="setQty"></div>
      ${can('order.gift') && html`<label class="check"><input type="checkbox" data-action="setGift" ${S.gift ? 'checked' : ''}><span>${t('floor.gift')}</span></label>`}
      <div class="field field--grow"><label for="search">${t('floor.search')}</label>
        <input id="search" type="search" value="${S.query}" placeholder="${t('floor.searchPlaceholder')}" data-action="setQuery"></div>
    </div>
    <div class="chips" role="group" aria-label="${t('floor.category')}">
      ${['all', ...categories].map((c) => html`<button type="button" class="chip" data-action="setCategory" data-cat="${c}" aria-pressed="${pressed(S.category === c)}">${c === 'all' ? t('common.all') : categoryLabel(c)}</button>`)}
    </div>
    <div id="productGrid" class="products">${productTiles(S)}</div>
  </section>`;
}

const priceNote = (note) => {
  if (!note) return '';
  if (note.startsWith('promo:')) return badge(t('note.promo', { name: note.slice('promo:'.length) }), 'success', '%');
  return badge(tOr(`note.${note}`, note), 'success', '');
};

function lineHtml(l, products, open) {
  const p = products.get(l.product_id);
  const name = p ? productName(p) : l.name;
  const isVoid = l.status !== 'active';
  const tags = [
    l.kind === 'gift' && badge(t('floor.giftTag'), 'warning', '♥'),
    isVoid && badge(t('floor.voidTag'), 'danger', '✕'),
    priceNote(l.price_note),
  ];
  const qtyText = l.weight_g ? `${fmtKg(l.weight_g)} kg` : `${l.qty} × ${fmtMoney(l.unit_price)}`;
  return html`<li class="line ${isVoid ? 'line--void' : ''}">
    <div class="line__main"><span class="line__name">${name}</span> ${tags}
      ${l.reason && html`<span class="muted line__reason">${l.reason}</span>`}</div>
    <div class="line__nums"><span>${qtyText}</span><strong>${fmtMoney(l.kind === 'gift' ? 0 : l.qty * l.unit_price)}</strong></div>
    ${open && !isVoid && html`<div class="line__tools">
      ${can('order.add') && l.kind === 'sale' && !l.weight_g && html`<button type="button" class="btn btn--small btn--ghost" data-action="plusLine" data-id="${l.product_id}" aria-label="${t('floor.addOne', { name })}">+1</button>`}
      ${can('order.void') && html`<button type="button" class="btn btn--small btn--ghost" data-action="voidLine" data-id="${l.id}" aria-label="${t('floor.void')} ${name}">${t('floor.void')}</button>`}
    </div>`}
  </li>`;
}

function totalsHtml(tot, bill) {
  const row = (label, value, cls = '') => html`<div class="totals__row ${cls}"><dt>${label}</dt><dd>${value}</dd></div>`;
  return html`<dl class="totals">
    ${row(t('floor.subtotal'), fmtMoney(tot.subtotal))}
    ${tot.minSpendTopUp > 0 && row(t('floor.topUp', { min: fmtMoney(bill.min_spend) }), fmtMoney(tot.minSpendTopUp))}
    ${tot.tableFee > 0 && row(t('floor.tableFee'), fmtMoney(tot.tableFee))}
    ${tot.discount > 0 && row(t('floor.discount'), `-${fmtMoney(tot.discount)}`)}
    ${row(t('floor.total'), fmtMoney(tot.total), 'totals__row--strong')}
    ${row(t('floor.paid'), fmtMoney(tot.paid))}
    ${row(t('floor.due'), fmtMoney(tot.due), 'totals__row--due')}
  </dl>`;
}

function paymentsHtml(payments) {
  if (!payments.length) return '';
  return html`<ul class="pay-list" aria-label="${t('floor.payments')}">${payments.map((p) => html`<li>
    <span>${methodLabel(p.method)}</span>
    ${badge(tOr(`payStatus.${p.status}`, p.status), p.status === 'paid' ? 'success' : 'warning', p.status === 'paid' ? '✓' : '…')}
    <strong>${fmtMoney(p.amount)}</strong></li>`)}</ul>`;
}

function pendingHtml(pending) {
  if (!pending) return '';
  const label = methodLabel(pending.method);
  if (pending.paid) {
    return html`<div class="pending pending--paid" role="status"><p class="pending__title">✓ ${t('floor.onlinePaid', { method: label, amount: fmtMoney(pending.amount) })}</p>
      <button type="button" class="btn btn--small btn--ghost" data-action="dismissPending">${t('common.close')}</button></div>`;
  }
  const svg = qrSvg(pending.qrContent, t('floor.qrLabel', { method: label }));
  return html`<div class="pending" role="status">
    <p class="pending__title">${t('floor.scanToPay', { method: label, amount: fmtMoney(pending.amount) })}</p>
    ${svg ? html`<div class="qr-box">${raw(svg)}</div>` : ''}
    <p class="muted">${t('floor.waiting')}</p>
    <p class="pending__link"><code>${pending.qrContent}</code></p>
    <div class="row">
      ${app.config.mock && html`<button type="button" class="btn btn--primary" data-action="simulate">${t('floor.simulate')}</button>`}
      <button type="button" class="btn btn--ghost" data-action="dismissPending">${t('floor.hideQr')}</button>
    </div></div>`;
}

function payPanel(S, tot) {
  if (!can('bill.settle')) return html`<p class="muted bill__note">${t('floor.cannotSettle')}</p>`;
  // QR payments need the provider: hide them while the till is offline instead of failing on tap.
  const online = syncState().online ? ONLINE_METHODS.filter((m) => app.config.payments?.[m]) : [];
  return html`<section class="bill__section" aria-labelledby="pay-title">
    <h3 id="pay-title" class="section-title">${t('floor.takePayment')}</h3>
    ${pendingHtml(S.pending)}
    <div class="field"><label for="payAmount">${t('floor.payAmount')}</label>
      <input id="payAmount" type="text" inputmode="decimal" placeholder="${(tot.due / 100).toFixed(2)}" autocomplete="off"></div>
    <div class="pay-grid">
      ${INSTANT_METHODS.map((m) => html`<button type="button" class="btn btn--primary" data-action="pay" data-method="${m}">${methodLabel(m)}</button>`)}
      ${online.map((m) => html`<button type="button" class="btn btn--secondary" data-action="payOnline" data-method="${m}">${methodLabel(m)}</button>`)}
    </div>
    <button type="button" class="btn btn--ghost btn--block" data-action="redeem">${t('floor.redeem')}</button>
  </section>`;
}

export function billHtml(S) {
  if (!S.billId) return emptyState(t('floor.pickTable'), t('floor.pickTableHint'));
  if (!S.bill) return skeleton(6);
  const { bill, lines, payments, totals } = S.bill;
  const open = bill.status === 'open';
  const table = S.tables.find((x) => x.id === bill.table_id);
  const rep = S.staff.find((s) => s.id === bill.rep_id);
  const products = byId(S.products);
  const onTable = bill.table_id != null;
  const title = onTable ? table?.name ?? `#${bill.table_id}` : `${t(`channel.${bill.channel}`)} #${bill.id}`;
  return html`<header class="bill__head">
      <button type="button" class="btn btn--small btn--ghost bill__back" data-action="backToBoard">↑ ${onTable ? t('floor.tables') : t('counter.open')}</button>
      <div><h2 class="bill__title">${title}</h2>
        ${bill.member_phone && html`<p class="muted">${t('counter.memberOn', { phone: bill.member_phone })}</p>`}
        <p class="muted">${t(bill.id < 0 ? 'floor.offlineBillMeta' : hasModule('reps') ? 'floor.billMeta' : 'counter.billMeta', { id: bill.id, time: fmtDateTime(bill.opened_at), rep: rep?.name ?? `#${bill.rep_id}` })}</p></div>
      ${open ? badge(t('floor.billOpen'), 'warning', '●') : badge(t('floor.billSettled'), 'success', '✓')}
    </header>
    <div class="row bill__tools">
      ${open && onTable && html`<button type="button" class="btn btn--small btn--ghost" data-action="transfer">${t('floor.transfer')}</button>`}
      ${open && !bill.member_id && can('order.add') && html`<button type="button" class="btn btn--small btn--ghost" data-action="attachMember">${t('counter.member')}</button>`}
      ${open && can('bill.discount') && html`<button type="button" class="btn btn--small btn--ghost" data-action="discount">${t('floor.setDiscount')}</button>`}
      <button type="button" class="btn btn--small btn--ghost" data-action="printReceipt">${t('print.receipt')}</button>
    </div>
    <section class="bill__section" aria-labelledby="lines-title">
      <h3 id="lines-title" class="section-title">${t('floor.items')}</h3>
      ${lines.length ? html`<ul class="lines">${lines.map((l) => lineHtml(l, products, open))}</ul>` : emptyState(t('floor.noLines'))}
    </section>
    ${totalsHtml(totals, bill)}
    ${paymentsHtml(payments)}
    ${!open && S.pending?.paid && pendingHtml(S.pending)}
    ${open && can('order.add') && addPanel(S)}
    ${open && payPanel(S, totals)}`;
}
