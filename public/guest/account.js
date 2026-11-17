// The booking form (book a table, an appointment or a visit).
import { t, getLang } from './i18n.js';
import { html, setHtml, session, get, post, toast } from './core.js';
import { ensureSignedIn, verifyPhone } from './login.js';

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

export async function mountBooking(root, { company, store, stores, navigate }) {
  const eventId = Number(new URLSearchParams(location.search).get('event')) || null;
  let event = null;
  if (eventId) {
    try { event = (await get(`/api/guest/events/${encodeURIComponent(company)}`)).find((e) => e.id === eventId) ?? null; } catch { /* book without the event */ }
  }
  const render = () => {
    if (!session.customer) { signedOutCard(root, render); return; }
    if (!session.customer.phone && !session.customer.loginPhone) {
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
