// Sign-in sheet (WeChat / Alipay / Douyin / phone + SMS code) and phone verification.
import { t } from './i18n.js';
import { html, setHtml, session, post, get, saveToken, sheet, toast, toastError, isWechatBrowser } from './core.js';

const RESEND_SECONDS = 60;
const PROVIDERS = [
  { id: 'wechat', mark: '微' },
  { id: 'alipay', mark: '支' },
  { id: 'douyin', mark: '抖' },
];

/** Phone number + "send code" + code field; calls onCode(phone, code) when submitted. */
function phoneForm(root, { submitLabel, onCode }) {
  setHtml(root, html`<form novalidate>
    <div class="g-row">
      <div class="g-field"><label for="ph">${t('phone.label')}</label>
        <input id="ph" name="phone" type="tel" inputmode="numeric" autocomplete="tel-national" maxlength="16" placeholder="${t('phone.ph')}" required></div>
      <div class="g-field g-field--fit"><button type="button" class="g-btn" data-send>${t('phone.send')}</button></div>
    </div>
    <div class="g-field"><label for="code">${t('phone.code')}</label>
      <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></div>
    <p class="g-hint" data-dev hidden></p>
    <p class="g-error" role="alert" hidden></p>
    <button type="submit" class="g-btn g-btn--primary g-btn--block">${submitLabel}</button>
  </form>`);
  const form = root.querySelector('form');
  const sendBtn = root.querySelector('[data-send]');
  const errorEl = root.querySelector('.g-error');
  const devEl = root.querySelector('[data-dev]');
  const showError = (msg) => { errorEl.textContent = msg; errorEl.hidden = !msg; };
  let timer = null;

  const countdown = () => {
    let left = RESEND_SECONDS;
    sendBtn.disabled = true;
    sendBtn.textContent = t('phone.resend', { s: left });
    timer = setInterval(() => {
      left -= 1;
      if (left > 0) { sendBtn.textContent = t('phone.resend', { s: left }); return; }
      clearInterval(timer);
      sendBtn.disabled = false;
      sendBtn.textContent = t('phone.send');
    }, 1000);
  };

  sendBtn.addEventListener('click', async () => {
    showError('');
    sendBtn.disabled = true;
    try {
      const r = await post('/api/guest/otp', { phone: form.elements.phone.value });
      toast(t('phone.sent'), 'success');
      if (r.devCode) { devEl.textContent = t('phone.devCode', { code: r.devCode }); devEl.hidden = false; }
      countdown();
      form.elements.code.focus();
    } catch (e) {
      sendBtn.disabled = false;
      showError(e.message);
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    try {
      await onCode(form.elements.phone.value, form.elements.code.value.trim());
      clearInterval(timer);
    } catch (err) {
      showError(err.message);
    } finally {
      button.disabled = false;
    }
  });
  form.elements.phone.focus();
}

/** Opens the sign-in sheet. Resolves true when signed in here (phone); provider sign-in leaves the page and comes back. */
export async function signIn() {
  const { login } = session.config;
  const ok = await sheet(t('login.title'), (body, close) => {
    const social = PROVIDERS.filter((p) => login[p.id]);
    setHtml(body, html`<p class="g-muted g-lead">${t('login.why')}</p>
      ${!social.length && !login.phone && html`<p class="g-empty">${t('login.none')}</p>`}
      <div class="g-logins">${social.map((p) => html`<button type="button" class="g-login g-login--${p.id}" data-provider="${p.id}">
        <span class="g-login__mark" aria-hidden="true">${p.mark}</span>${t(`login.${p.id}`)}</button>`)}</div>
      ${login.wechat && !isWechatBrowser() && !session.config.mock && html`<p class="g-hint g-gap">${t('login.wechatOutside')}</p>`}
      ${login.phone && html`${social.length ? html`<p class="g-or">${t('login.or')}</p>` : ''}
        <div data-phone><button type="button" class="g-login g-login--phone" data-usephone><span class="g-login__mark" aria-hidden="true">☎</span>${t('login.phone')}</button></div>`}`);
    body.querySelectorAll('[data-provider]').forEach((b) => b.addEventListener('click', () => {
      // Keep the page address (venue, table) so the provider sends the guest straight back to it.
      location.href = `/api/guest/auth/${b.dataset.provider}/start?return=${encodeURIComponent(location.pathname)}`;
    }));
    body.querySelector('[data-usephone]')?.addEventListener('click', () => {
      phoneForm(body.querySelector('[data-phone]'), {
        submitLabel: t('phone.submit'),
        onCode: async (phone, code) => {
          const r = await post('/api/guest/login/phone', { phone, code });
          saveToken(r.token);
          session.customer = r.customer;
          close(true);
        },
      });
    });
  });
  if (ok) toast(t('login.done'), 'success');
  return Boolean(ok);
}

export async function ensureSignedIn() {
  return session.customer ? true : signIn();
}

/** Verify (or change) the signed-in guest's phone. Resolves true once verified. */
export async function verifyPhone() {
  const ok = await sheet(t('phone.title'), (body, close) => {
    setHtml(body, html`<p class="g-muted g-lead">${t('phone.why')}</p><div data-phone></div>`);
    phoneForm(body.querySelector('[data-phone]'), {
      submitLabel: t('phone.verify'),
      onCode: async (phone, code) => {
        session.customer = await post('/api/guest/me/phone', { phone, code });
        close(true);
      },
    });
  });
  if (ok) toast(t('phone.verified'), 'success');
  return Boolean(ok);
}

/** After a provider redirect the URL fragment carries a one-time code (or an error); swap it for a session. */
export async function finishProviderLogin() {
  const params = new URLSearchParams(location.hash.slice(1));
  const code = params.get('login');
  const error = params.get('loginError');
  if (!code && !error) return;
  history.replaceState(null, '', location.pathname + location.search);
  if (error) {
    toast(error === 'cancelled' ? t('login.cancelled') : t('login.failed', { reason: error }), 'error');
    return;
  }
  try {
    const r = await post('/api/guest/session', { code });
    saveToken(r.token);
    session.customer = r.customer;
    toast(t('login.done'), 'success');
  } catch (e) {
    toastError(e);
  }
}

export async function loadCustomer() {
  if (!session.token) return;
  try {
    session.customer = await get('/api/guest/me');
  } catch (e) {
    if (e.status === 401) saveToken(null);
  }
}
