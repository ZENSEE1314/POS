// Sign-in sheet (WeChat / Alipay / Douyin / phone + SMS code / phone + password) and phone verification.
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

/** A password input with a show/hide button. */
const passwordField = (id, name, label, autocomplete, hint = '') => html`<div class="g-field"><label for="${id}">${label}</label>
  <div class="g-pw"><input id="${id}" name="${name}" type="password" autocomplete="${autocomplete}" maxlength="72" required>
    <button type="button" class="g-pw__toggle" data-toggle-pw="${id}" aria-controls="${id}" aria-pressed="false">${t('pw.show')}</button></div>
  ${hint && html`<p class="g-hint">${hint}</p>`}</div>`;

function wirePasswordToggles(root) {
  root.querySelectorAll('[data-toggle-pw]').forEach((b) => b.addEventListener('click', () => {
    const input = root.querySelector(`#${b.dataset.togglePw}`);
    const isShown = input.type === 'text';
    input.type = isShown ? 'password' : 'text';
    b.setAttribute('aria-pressed', String(!isShown));
    b.textContent = t(isShown ? 'pw.show' : 'pw.hide');
  }));
}

/** Sign in, register, or set a new password with a reset code. Calls onDone(result) with the new session. */
function passwordForm(root, onDone) {
  let mode = 'login';
  const hasSms = Boolean(session.config.login.phone);
  const render = () => {
    const isRegister = mode === 'register';
    const isReset = mode === 'reset';
    setHtml(root, html`<form novalidate>
      ${isReset
        ? html`<h3 class="g-card__title">${t('pw.resetTitle')}</h3><p class="g-muted g-lead">${t(hasSms ? 'pw.resetWhySms' : 'pw.resetWhy')}</p>`
        : html`<div class="g-seg" role="group" aria-label="${t('pw.title')}">
          <button type="button" aria-pressed="${String(!isRegister)}" data-mode="login">${t('pw.signIn')}</button>
          <button type="button" aria-pressed="${String(isRegister)}" data-mode="register">${t('pw.register')}</button></div>`}
      ${isRegister && html`<div class="g-field"><label for="pwname">${t('pw.name')}</label>
        <input id="pwname" name="name" autocomplete="nickname" maxlength="40"></div>`}
      <div class="g-row">
        <div class="g-field"><label for="pwphone">${t('phone.label')}</label>
          <input id="pwphone" name="phone" type="tel" inputmode="numeric" autocomplete="username" maxlength="16" placeholder="${t('phone.ph')}" required></div>
        ${isReset && hasSms && html`<div class="g-field g-field--fit"><button type="button" class="g-btn" data-send>${t('phone.send')}</button></div>`}
      </div>
      ${isReset && html`<div class="g-field"><label for="pwcode">${t(hasSms ? 'pw.codeSms' : 'pw.code')}</label>
        <input id="pwcode" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required></div>
        <p class="g-hint" data-dev hidden></p>`}
      ${passwordField('pw', 'password', t(isReset ? 'pw.new' : 'pw.password'), mode === 'login' ? 'current-password' : 'new-password', mode === 'login' ? '' : t('pw.rule'))}
      ${mode !== 'login' && passwordField('pw2', 'password2', t('pw.again'), 'new-password')}
      <p class="g-error" role="alert" hidden></p>
      <button type="submit" class="g-btn g-btn--primary g-btn--block">${t(isReset ? 'pw.setNew' : isRegister ? 'pw.create' : 'pw.signIn')}</button>
      ${mode === 'login' && html`<button type="button" class="g-link g-gap" data-mode="reset">${t('pw.forgot')}</button>`}
      ${isReset && html`<button type="button" class="g-link g-gap" data-mode="login">${t('pw.back')}</button>`}
    </form>`);
    const form = root.querySelector('form');
    const errorEl = root.querySelector('.g-error');
    const showError = (msg) => { errorEl.textContent = msg; errorEl.hidden = !msg; };
    wirePasswordToggles(root);
    root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.mode; render(); }));
    root.querySelector('[data-send]')?.addEventListener('click', async (e) => {
      showError('');
      try {
        const r = await post('/api/guest/otp', { phone: form.elements.phone.value });
        toast(t('phone.sent'), 'success');
        const devEl = root.querySelector('[data-dev]');
        if (r.devCode) { devEl.textContent = t('phone.devCode', { code: r.devCode }); devEl.hidden = false; }
        e.target.disabled = true;
      } catch (err) {
        showError(err.message);
      }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError('');
      const f = form.elements;
      if (mode !== 'login' && f.password.value !== f.password2.value) { showError(t('pw.mismatch')); return; }
      const button = form.querySelector('[type=submit]');
      button.disabled = true;
      try {
        let r;
        if (isRegister) r = await post('/api/guest/register', { phone: f.phone.value, password: f.password.value, name: f.name.value });
        else if (isReset) r = await post('/api/guest/password/reset', { phone: f.phone.value, code: f.code.value.trim(), password: f.password.value });
        else r = await post('/api/guest/login/password', { phone: f.phone.value, password: f.password.value });
        if (isReset) toast(t('pw.changed'), 'success');
        onDone(r);
      } catch (err) {
        showError(err.message);
      } finally {
        button.disabled = false;
      }
    });
    form.elements[isRegister ? 'name' : 'phone'].focus();
  };
  render();
}

/** Opens the sign-in sheet. Resolves true when signed in here (phone); provider sign-in leaves the page and comes back. */
export async function signIn() {
  const { login } = session.config;
  const ok = await sheet(t('login.title'), (body, close) => {
    const social = PROVIDERS.filter((p) => login[p.id]);
    setHtml(body, html`<p class="g-muted g-lead">${t('login.why')}</p>
      ${!social.length && !login.phone && !login.password && html`<p class="g-empty">${t('login.none')}</p>`}
      <div class="g-logins">${social.map((p) => html`<button type="button" class="g-login g-login--${p.id}" data-provider="${p.id}">
        <span class="g-login__mark" aria-hidden="true">${p.mark}</span>${t(`login.${p.id}`)}</button>`)}</div>
      ${login.wechat && !isWechatBrowser() && !session.config.mock && html`<p class="g-hint g-gap">${t('login.wechatOutside')}</p>`}
      ${login.phone && html`${social.length ? html`<p class="g-or">${t('login.or')}</p>` : ''}
        <div data-phone><button type="button" class="g-login g-login--phone" data-usephone><span class="g-login__mark" aria-hidden="true">☎</span>${t('login.phone')}</button></div>`}
      ${login.password && html`${(social.length || login.phone) ? html`<p class="g-or">${t('login.or')}</p>` : ''}<div data-password></div>`}`);
    const pwRoot = body.querySelector('[data-password]');
    if (pwRoot) {
      passwordForm(pwRoot, (r) => {
        saveToken(r.token);
        session.customer = r.customer;
        close(true);
      });
    }
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
  const handoff = params.get('mpLogin');
  if (handoff) {
    history.replaceState(null, '', location.pathname + location.search);
    // The mini program already signed this WeChat user in; take over its session. On failure the stored session stays.
    try {
      const r = await post('/api/guest/mp/session', { code: handoff });
      saveToken(r.token);
      session.customer = r.customer;
    } catch { /* expired (the page was reopened from history): keep whatever session this web-view has */ }
    return;
  }
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
