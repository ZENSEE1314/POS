// "Printing" dialog reachable from the header: bridge address and token, automatic-print toggles, paper width,
// bridge connection test and the local print log with Reprint.
import { t, errorText } from '../i18n.js';
import { html, fmtDateTime } from '../util.js';
import { badge, toast } from '../ui.js';
import { PRINT_LANGS } from './labels.js';
import { checkBridge, reprint } from './printer.js';
import { getLog } from './log.js';
import { getSettings, isLocalBridgeUrl, saveSettings } from './settings.js';

const PAPER_WIDTHS = [58, 80];
const AUTO_TOGGLES = ['autoReceipt', 'autoTickets', 'autoStash', 'autoShift', 'fallback'];
const STATUS_TONE = { ok: 'success', failed: 'danger', fallback: 'warning', pending: 'neutral' };
const STATUS_MARK = { ok: '✓', failed: '✕', fallback: '↗', pending: '…' };

const option = (value, label, current) => html`<option value="${value}" ${String(value) === String(current) ? 'selected' : ''}>${label}</option>`;

function formHtml(s) {
  return html`<form class="dialog__form print-form" novalidate>
    <p class="dialog__intro">${t('print.intro')}</p>
    <div class="field"><label for="pr-url">${t('print.bridgeUrl')}</label>
      <input id="pr-url" name="bridgeUrl" type="text" autocomplete="off" spellcheck="false" value="${s.bridgeUrl}"></div>
    <div class="field"><label for="pr-token">${t('print.token')}</label>
      <input id="pr-token" name="token" type="password" autocomplete="off" spellcheck="false" value="${s.token}">
      <p class="hint">${t('print.tokenHint')}</p></div>
    <div class="row print-form__test"><button type="button" class="btn btn--small btn--ghost" data-act="test">${t('print.test')}</button>
      <p class="muted" id="pr-status" role="status" aria-live="polite"></p></div>
    <div class="field"><label for="pr-paper">${t('print.paper')}</label>
      <select id="pr-paper" name="paperMm">${PAPER_WIDTHS.map((w) => option(w, `${w} mm`, s.paperMm))}</select>
      <p class="hint">${t('print.paperHint')}</p></div>
    <div class="field"><label for="pr-lang">${t('print.lang')}</label>
      <select id="pr-lang" name="lang">${PRINT_LANGS.map((l) => option(l, t(`print.lang.${l}`), s.lang))}</select></div>
    <div class="field"><label for="pr-footer">${t('print.footer')}</label>
      <input id="pr-footer" name="footer" type="text" maxlength="120" autocomplete="off" value="${s.footer}"></div>
    <fieldset class="field"><legend>${t('print.autoTitle')}</legend><div class="checks print-form__checks">
      ${AUTO_TOGGLES.map((k) => html`<label class="check"><input type="checkbox" name="${k}" ${s[k] ? 'checked' : ''}><span>${t(`print.${k}`)}</span></label>`)}
    </div></fieldset>
    <p class="dialog__error" role="alert" hidden></p>
    <div class="dialog__actions">
      <button type="button" class="btn btn--ghost" data-act="close">${t('common.close')}</button>
      <button type="submit" class="btn btn--primary">${t('common.save')}</button>
    </div></form>`;
}

function logHtml() {
  const entries = getLog();
  return html`<section class="dialog__form print-log" aria-labelledby="pr-log-title">
    <h3 id="pr-log-title" class="section-title">${t('print.log')}</h3>
    ${entries.length
      ? html`<ul class="print-log__list">${entries.map((e) => html`<li class="print-log__item">
          <div class="print-log__main"><strong>${e.title}</strong> <span class="muted">${e.printerName ?? ''} · ${fmtDateTime(e.ts)}</span>
            ${e.error && html`<span class="print-log__error">${e.error}</span>`}</div>
          ${badge(t(`print.status.${e.status}`), STATUS_TONE[e.status] ?? 'neutral', STATUS_MARK[e.status] ?? '')}
          ${e.model && html`<button type="button" class="btn btn--small btn--ghost" data-act="reprint" data-id="${e.id}">${t('print.reprint')}</button>`}
        </li>`)}</ul>`
      : html`<p class="muted">${t('print.logEmpty')}</p>`}
  </section>`;
}

function readForm(form) {
  const data = new FormData(form);
  const patch = { bridgeUrl: String(data.get('bridgeUrl')).trim().replace(/\/+$/, ''), token: String(data.get('token')).trim(), paperMm: Number(data.get('paperMm')), lang: String(data.get('lang')), footer: String(data.get('footer')).trim() };
  for (const k of AUTO_TOGGLES) patch[k] = form.elements[k].checked;
  return patch;
}

export function openPrintDialog() {
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog dialog--wide';
  dlg.setAttribute('aria-labelledby', 'pr-title');
  dlg.innerHTML = html`<h2 id="pr-title" class="dialog__title">${t('print.title')}</h2>${formHtml(getSettings())}<div id="pr-log">${logHtml()}</div>`.text;
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  const form = dlg.querySelector('form');
  const statusEl = dlg.querySelector('#pr-status');
  const errorEl = dlg.querySelector('.dialog__error');
  const renderLog = () => { dlg.querySelector('#pr-log').innerHTML = logHtml().text; };

  async function testConnection() {
    const patch = readForm(form);
    if (!isLocalBridgeUrl(patch.bridgeUrl)) { statusEl.textContent = t('print.badUrl'); return; }
    statusEl.textContent = t('print.testing');
    try {
      const r = await checkBridge({ ...getSettings(), ...patch });
      statusEl.textContent = t('print.bridgeOk', { version: r.version, names: r.printers.join(', ') });
    } catch (e) {
      statusEl.textContent = errorText(e);
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const patch = readForm(form);
    if (!isLocalBridgeUrl(patch.bridgeUrl)) {
      errorEl.textContent = t('print.badUrl');
      errorEl.hidden = false;
      return;
    }
    saveSettings(patch);
    toast(t('print.saved'), 'success');
    dlg.close();
  });
  dlg.addEventListener('click', async (event) => {
    const el = event.target.closest('[data-act]');
    if (!el) return;
    if (el.dataset.act === 'close') dlg.close();
    if (el.dataset.act === 'test') await testConnection();
    if (el.dataset.act === 'reprint') {
      el.disabled = true;
      await reprint(el.dataset.id);
      renderLog();
    }
  });
  dlg.showModal();
}
