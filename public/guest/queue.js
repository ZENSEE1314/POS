// Customer app: take a queue number for a table (排队取号) and watch it on the phone until the venue calls it.
import { t, addStrings } from './i18n.js';
import { html, setHtml, get, post, busy, sheet, skeleton, toast } from './core.js';

const POLL_MS = 10_000;
const VIBRATE_PATTERN = [300, 150, 300];
const DEFAULT_PARTY = 2;
const MAX_PARTY = 99;
const STORAGE_PREFIX = 'nightpos.queue.';
const OPEN = ['waiting', 'called'];

addStrings({
  en: {
    'qu.title': 'Queue for a table', 'qu.text': 'Take a number and wait where you like. This page tells you when it is your turn.',
    'qu.party': 'Number of people', 'qu.name': 'Your name (optional)', 'qu.phone': 'Phone number', 'qu.phoneHint': 'So the staff can find you.',
    'qu.location': 'Location', 'qu.take': 'Take a number', 'qu.yourNumber': 'Your number', 'qu.ahead': '{n} parties ahead of you',
    'qu.next': 'You are next', 'qu.nowCalling': 'Now calling: No. {n}', 'qu.nobodyCalled': 'Nobody called yet',
    'qu.called': 'It is your turn! Please come to the front desk.', 'qu.cancel': 'Cancel my number', 'qu.cancelled': 'Your number was cancelled.',
    'qu.done.seated': 'You have been seated. Enjoy!', 'qu.done.skipped': 'Your number was passed. Please ask the front desk.',
    'qu.done.cancelled': 'This number was cancelled.', 'qu.again': 'Take a new number', 'qu.party.n': '{n} people', 'qu.live': 'Updates by itself every few seconds.',
    'qu.home': 'Queue', 'qu.cancelAsk': 'Cancel your queue number?', 'qu.keep': 'Keep my number',
  },
  zh: {
    'qu.title': '排队取号', 'qu.text': '取号后可随意走动，轮到您时本页面会提醒。',
    'qu.party': '用餐人数', 'qu.name': '称呼（选填）', 'qu.phone': '手机号', 'qu.phoneHint': '方便服务员找到您。',
    'qu.location': '门店', 'qu.take': '立即取号', 'qu.yourNumber': '您的号码', 'qu.ahead': '前面还有 {n} 桌',
    'qu.next': '下一位就是您', 'qu.nowCalling': '正在叫号：{n} 号', 'qu.nobodyCalled': '尚未开始叫号',
    'qu.called': '轮到您了！请到前台。', 'qu.cancel': '取消排队', 'qu.cancelled': '已取消排队。',
    'qu.done.seated': '您已入座，祝您愉快！', 'qu.done.skipped': '您的号码已过号，请联系前台。',
    'qu.done.cancelled': '该号码已取消。', 'qu.again': '重新取号', 'qu.party.n': '{n} 人', 'qu.live': '页面会自动刷新。',
    'qu.home': '排队', 'qu.cancelAsk': '确定取消排队吗？', 'qu.keep': '继续排队',
  },
});

const enc = encodeURIComponent;
const storageKey = (company) => `${STORAGE_PREFIX}${company.toLowerCase()}`;

function readCode(company) {
  try { return localStorage.getItem(storageKey(company)); } catch { return null; }
}

function writeCode(company, code) {
  try {
    if (code) localStorage.setItem(storageKey(company), code); else localStorage.removeItem(storageKey(company));
  } catch { /* private mode: the ticket shows until the page is closed */ }
}

const formHtml = (stores) => html`<div class="g-hero"><h1 class="g-hero__title">${t('qu.title')}</h1><p class="g-hero__text">${t('qu.text')}</p></div>
  <form class="g-card" data-queue-form novalidate>
    ${stores.length > 1 && html`<div class="g-field"><label for="qu-store">${t('qu.location')}</label>
      <select id="qu-store" name="storeCode">${stores.map((s) => html`<option value="${s.code}">${s.name}</option>`)}</select></div>`}
    <div class="g-field"><label for="qu-party">${t('qu.party')}</label>
      <input id="qu-party" name="partySize" type="number" inputmode="numeric" min="1" max="${MAX_PARTY}" value="${DEFAULT_PARTY}" required></div>
    <div class="g-field"><label for="qu-name">${t('qu.name')}</label><input id="qu-name" name="name" autocomplete="name" maxlength="40"></div>
    <div class="g-field"><label for="qu-phone">${t('qu.phone')}</label>
      <input id="qu-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required aria-describedby="qu-phone-hint">
      <p id="qu-phone-hint" class="g-hint">${t('qu.phoneHint')}</p></div>
    <button type="submit" class="g-btn g-btn--primary g-btn--block">${t('qu.take')}</button>
  </form>`;

function aheadText(tk) {
  if (tk.status === 'called') return t('qu.called');
  return tk.ahead === 0 ? t('qu.next') : t('qu.ahead', { n: tk.ahead });
}

const ticketHtml = (tk) => {
  const open = OPEN.includes(tk.status);
  return html`<div class="g-hero"><h1 class="g-hero__title">${t('qu.title')}</h1><p class="g-hero__text">${tk.storeName}</p></div>
    <section class="g-card g-queue ${tk.status === 'called' ? 'g-queue--called' : ''}" aria-live="assertive" aria-atomic="true">
      <p class="g-hint">${t('qu.yourNumber')} · ${t('qu.party.n', { n: tk.partySize })}</p>
      <p class="g-queue__num g-num">${tk.number}</p>
      <p class="g-queue__ahead">${open ? aheadText(tk) : t(`qu.done.${tk.status}`)}</p>
      ${open && html`<p class="g-hint">${tk.nowCalling === null ? t('qu.nobodyCalled') : t('qu.nowCalling', { n: tk.nowCalling })}</p>`}
    </section>
    ${open ? html`<p class="g-hint g-gap">${t('qu.live')}</p>
        <button type="button" class="g-btn g-btn--block g-gap" data-queue-cancel>${t('qu.cancel')}</button>`
      : html`<button type="button" class="g-btn g-btn--primary g-btn--block g-gap" data-queue-again>${t('qu.again')}</button>`}`;
};

const confirmCancel = () => sheet(t('qu.cancelAsk'), (body, close) => {
  setHtml(body, html`<div class="g-row"><button type="button" class="g-btn g-btn--block" data-no>${t('qu.keep')}</button>
    <button type="button" class="g-btn g-btn--primary g-btn--block" data-yes>${t('qu.cancel')}</button></div>`);
  body.querySelector('[data-no]').addEventListener('click', () => close(false));
  body.querySelector('[data-yes]').addEventListener('click', () => close(true));
});

/** Returns a cleanup function that stops polling when the guest leaves the page. */
export async function mountQueue(root, { company, stores }) {
  let timer = null;
  let lastStatus = null;

  const stop = () => { clearInterval(timer); timer = null; };

  function showForm() {
    stop();
    setHtml(root, formHtml(stores));
    const form = root.querySelector('[data-queue-form]');
    const button = form.querySelector('[type=submit]');
    form.addEventListener('submit', busy(button, async (e) => {
      e.preventDefault();
      if (!form.checkValidity()) { form.reportValidity(); return; }
      const data = new FormData(form);
      const ticket = await post(`/api/guest/queue/${enc(company)}`, {
        partySize: Number(data.get('partySize')), name: String(data.get('name') ?? '').trim(), phone: String(data.get('phone') ?? '').trim(),
        storeCode: String(data.get('storeCode') ?? stores[0]?.code ?? ''),
      });
      writeCode(company, ticket.code);
      await showTicket(ticket.code);
    }));
  }

  function render(tk) {
    if (tk.status === 'called' && lastStatus !== 'called') navigator.vibrate?.(VIBRATE_PATTERN);
    lastStatus = tk.status;
    setHtml(root, ticketHtml(tk));
    if (!OPEN.includes(tk.status)) stop();
  }

  async function showTicket(code) {
    setHtml(root, skeleton(2));
    try {
      render(await get(`/api/guest/queue-ticket/${enc(code)}`));
    } catch (e) {
      if (e.status === 404) { writeCode(company, null); showForm(); return; }
      throw e;
    }
    if (timer || !OPEN.includes(lastStatus)) return;
    timer = setInterval(async () => {
      if (!root.isConnected) { stop(); return; }
      if (document.visibilityState !== 'visible') return;
      try { render(await get(`/api/guest/queue-ticket/${enc(code)}`)); } catch { /* keep the last view; the next poll retries */ }
    }, POLL_MS);
  }

  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-queue-again]')) { writeCode(company, null); showForm(); return; }
    const cancel = e.target.closest('[data-queue-cancel]');
    if (!cancel || !await confirmCancel()) return;
    await busy(cancel, async () => {
      await post(`/api/guest/queue-ticket/${enc(readCode(company))}/cancel`);
      writeCode(company, null);
      toast(t('qu.cancelled'), 'success');
      showForm();
    })();
  });

  const code = readCode(company);
  if (code) await showTicket(code); else showForm();
  return stop;
}
