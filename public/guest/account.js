// "My account" at one venue company (profile, wallet, stored bottles, bookings, orders) and the booking form.
import { t, getLang } from './i18n.js';
import { html, setHtml, fmtMoney, fmtBottles, fmtDate, fmtDateTime, session, get, post, patch, saveToken, sheet, toast, busy, skeleton } from './core.js';
import { ensureSignedIn, verifyPhone } from './login.js';
import { ordersHtml } from './table.js';

const BOOKING_TONE = { submitted: 'pending', confirmed: 'ok', checked_in: 'ok', redeemed: 'neutral', cancelled: 'neutral', no_show: 'bad' };
const DEFAULT_PARTY = 4;
const MAX_PARTY = 50;
const DEFAULT_LEAD_MS = 3 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function signedOutCard(root, onSignedIn) {
  setHtml(root, html`<div class="g-card"><p class="g-muted g-lead">${t('login.why')}</p>
    <button type="button" class="g-btn g-btn--primary g-btn--block" data-signin>${t('login.title')}</button></div>`);
  root.querySelector('[data-signin]').addEventListener('click', async () => { if (await ensureSignedIn()) onSignedIn(); });
}

export async function mountAccount(root, { company, navigate }) {
  const load = async () => {
    if (!session.customer) { signedOutCard(root, load); return; }
    setHtml(root, skeleton(4));
    const a = await get(`/api/guest/account/${encodeURIComponent(company)}`);
    const c = session.customer;
    const providers = [...c.providers.map((p) => t(`provider.${p}`)), ...(c.phone && !c.providers.length ? [t('provider.phone')] : [])];
    setHtml(root, html`
      <div class="g-hero"><p class="g-hero__eyebrow">${a.company.name}</p><h1 class="g-hero__title">${t('account.hello', { name: c.name || t('account.guest') })}</h1>
        ${providers.length > 0 && html`<p class="g-hero__text">${t('account.signedVia', { list: providers.join(' · ') })}</p>`}</div>
      <section class="g-card" aria-labelledby="w-title"><h2 id="w-title" class="g-card__title">${t('account.wallet')}</h2>
        ${!a.phoneVerified
          ? html`<p class="g-muted g-lead">${t('account.walletNeedsPhone')}</p><button type="button" class="g-btn g-btn--primary g-btn--block" data-verify>${t('account.verify')}</button>`
          : a.wallet
            ? html`<p class="g-balance g-num">${fmtMoney(a.wallet.balance)}</p>
              ${a.wallet.ledger.length > 0 && html`<h3 class="g-muted g-gap">${t('account.history')}</h3><ul class="g-lines">${a.wallet.ledger.map((l) =>
                html`<li><span>${fmtDate(l.ts)}<br><span class="g-hint">${t(l.delta > 0 ? 'account.topUp' : 'account.spent')}</span></span><span class="g-num">${l.delta > 0 ? '+' : ''}${fmtMoney(l.delta)}</span></li>`)}</ul>`}`
            : html`<p class="g-muted">${t('account.noWallet')}</p>`}
      </section>
      ${a.phoneVerified && html`<section class="g-card" aria-labelledby="s-title"><h2 id="s-title" class="g-card__title">${t('account.stash')}</h2>
        ${a.stash.length ? html`<ul class="g-lines">${a.stash.map((s) => html`<li><span><strong>${s.name}</strong><br>
          <span class="g-hint">${s.storeName} · ${t('account.stashCode', { code: s.code })}</span></span>
          <span class="g-num g-right">${t('account.stashLeft', { n: fmtBottles(s.leftMilli) })}<br><span class="g-hint">${t('account.expires', { date: fmtDate(s.expiresAt) })}</span></span></li>`)}</ul>`
          : html`<p class="g-muted">${t('account.noStash')}</p>`}</section>`}
      <section class="g-card" aria-labelledby="b-title"><h2 id="b-title" class="g-card__title">${t('account.bookings')}</h2>
        ${a.bookings.length ? html`<ul class="g-lines">${a.bookings.map((b) => html`<li><span><strong>${fmtDateTime(b.eta)}</strong><br>
          <span class="g-hint">${b.storeName} · ${t('book.party.n', { n: b.partySize })}${b.tableName ? ` · ${b.tableName}` : ''}</span>
          ${['submitted', 'confirmed'].includes(b.status) && b.eta > Date.now() && html`<br><button type="button" class="g-link" data-cancel-booking="${b.id}">${t('book.cancel')}</button>`}</span>
          <span class="g-badge g-badge--${BOOKING_TONE[b.status] ?? 'neutral'}">${t(`bookingStatus.${b.status}`)}</span></li>`)}</ul>`
          : html`<p class="g-muted">${t('account.noBookings')}</p>`}</section>
      <section aria-labelledby="o-title"><h2 id="o-title" class="g-cat">${t('account.orders')}</h2>
        ${a.orders.length ? ordersHtml(a.orders) : html`<p class="g-empty">${t('account.noOrders')}</p>`}</section>
      <section class="g-card"><dl class="g-sum"><dt>${t('account.phone')}</dt><dd>${c.phone ?? t('account.noPhone')}</dd></dl>
        <div class="g-paybtns"><button type="button" class="g-btn" data-verify>${t('account.verify')}</button>
          <button type="button" class="g-btn" data-rename>${t('account.rename')}</button>
          <button type="button" class="g-btn g-btn--danger" data-logout>${t('account.logout')}</button></div></section>`);
  };

  root.addEventListener('click', async (e) => {
    const el = e.target.closest('button');
    if (!el) return;
    if (el.dataset.verify !== undefined) { if (await verifyPhone()) await load(); }
    else if (el.dataset.rename !== undefined) await rename(load);
    else if (el.dataset.logout !== undefined) {
      await busy(el, async () => { await post('/api/guest/logout'); })();
      saveToken(null);
      session.customer = null;
      navigate(`/g/${company}`);
    } else if (el.dataset.cancelBooking) {
      await busy(el, async () => { await post(`/api/guest/bookings/${el.dataset.cancelBooking}/cancel`); toast(t('book.cancelled')); await load(); })();
    } else if (el.dataset.cancelOrder) {
      await busy(el, async () => { await post(`/api/guest/orders/${el.dataset.cancelOrder}/cancel`); toast(t('orders.cancelled.toast')); await load(); })();
    }
  });
  await load();
}

function rename(after) {
  return sheet(t('account.rename'), (body, close) => {
    setHtml(body, html`<form novalidate><div class="g-field"><label for="nm">${t('account.name')}</label>
      <input id="nm" maxlength="40" required value="${session.customer.name}"></div>
      <button type="submit" class="g-btn g-btn--primary g-btn--block">${t('account.save')}</button></form>`);
    const form = body.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await busy(form.querySelector('button'), async () => {
        session.customer = await patch('/api/guest/me', { name: form.elements[0].value });
        toast(t('account.saved'), 'success');
        close();
        await after();
      })();
    });
  });
}

export async function mountBooking(root, { company, store, stores, navigate }) {
  const eventId = Number(new URLSearchParams(location.search).get('event')) || null;
  let event = null;
  if (eventId) {
    try { event = (await get(`/api/guest/events/${encodeURIComponent(company)}`)).find((e) => e.id === eventId) ?? null; } catch { /* book without the event */ }
  }
  const render = () => {
    if (!session.customer) { signedOutCard(root, render); return; }
    if (!session.customer.phone) {
      setHtml(root, html`<div class="g-card"><p class="g-muted g-lead">${t('book.needPhone')}</p>
        <button type="button" class="g-btn g-btn--primary g-btn--block" data-verify>${t('account.verify')}</button></div>`);
      root.querySelector('[data-verify]').addEventListener('click', async () => { if (await verifyPhone()) render(); });
      return;
    }
    setHtml(root, html`<form class="g-card" novalidate><h1 class="g-card__title">${t('book.title')}</h1>
      ${event && html`<p class="g-lead"><span class="g-badge g-badge--ok">${t('book.event')}</span> <strong>${getLang() === 'en' && event.titleEn ? event.titleEn : event.title}</strong></p>`}
      ${stores.length > 1 && html`<div class="g-field"><label for="st">${t('book.store')}</label><select id="st" name="store">${stores.map((s) =>
        html`<option value="${s.code}" ${s.code.toLowerCase() === String(store).toLowerCase() ? 'selected' : ''}>${s.name}</option>`)}</select></div>`}
      <div class="g-field"><label for="eta">${t('book.when')}</label><input id="eta" name="eta" type="datetime-local" required value="${toLocalInput(event && event.startsAt > Date.now() ? event.startsAt : Date.now() + DEFAULT_LEAD_MS)}"></div>
      <div class="g-field"><label for="party">${t('book.party')}</label><input id="party" name="party" type="number" min="1" max="${MAX_PARTY}" step="1" required value="${DEFAULT_PARTY}"></div>
      <div class="g-field"><label for="bn">${t('book.name')}</label><input id="bn" name="name" maxlength="40" value="${session.customer.name}"></div>
      <div class="g-field"><label for="bnote">${t('book.note')}</label><textarea id="bnote" name="note" maxlength="200" placeholder="${t('book.notePh')}"></textarea></div>
      <p class="g-error" role="alert" hidden></p>
      <button type="submit" class="g-btn g-btn--primary g-btn--block">${t('book.submit')}</button></form>`);
    const form = root.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errorEl = form.querySelector('.g-error');
      errorEl.hidden = true;
      const f = form.elements;
      try {
        await post('/api/guest/bookings', {
          company, store: f.store ? f.store.value : store, eta: new Date(f.eta.value).getTime(), partySize: Number(f.party.value),
          name: f.name.value, note: f.note.value, ...(event ? { eventId: event.id } : {}),
        });
        toast(t('book.done'), 'success');
        navigate(`/g/${company}/account`);
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      }
    });
  };
  render();
}
