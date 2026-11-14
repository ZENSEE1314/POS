// Shared UI building blocks: toasts, modal dialogs/forms, event delegation, tables, skeletons.
import { t, errorText } from './i18n.js';
import { html, parseFen, parseMilli, toDateTimeInput } from './util.js';

const TOAST_MS = 5000;
const TOAST_ERROR_MS = 9000;
let fieldSeq = 0;

export function toast(message, kind = 'info') {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  const mark = { error: '!', success: '✓', info: 'i' }[kind];
  el.innerHTML = html`<span class="toast__mark" aria-hidden="true">${mark}</span><span>${message}</span>`.text;
  host.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? TOAST_ERROR_MS : TOAST_MS);
}

export const notifyError = (e) => toast(errorText(e), 'error');

/** Wraps an async handler so failures surface as an error toast instead of an unhandled rejection. */
const guarded = (fn) => async (...args) => {
  try { await fn(...args); } catch (e) { notifyError(e); }
};

/**
 * Event delegation: one listener per event type on `root`. `handlers` is { click: { action: fn(el, event) } },
 * matched against the closest [data-action] (or [data-form] for submit).
 */
export function delegate(root, handlers) {
  for (const [type, map] of Object.entries(handlers)) {
    const attr = type === 'submit' ? 'form' : 'action';
    root.addEventListener(type, (event) => {
      const el = event.target.closest(`[data-${attr}]`);
      const fn = el && root.contains(el) ? map[el.dataset[attr]] : null;
      if (!fn) return;
      if (type === 'submit') event.preventDefault();
      guarded(fn)(el, event);
    });
  }
}

export const skeleton = (rows = 4) =>
  html`<div class="skeleton" role="status" aria-label="${t('common.loading')}">${Array.from({ length: rows }, () => html`<div class="skeleton__row"></div>`)}</div>`;

export const emptyState = (message, hint = '') =>
  html`<div class="empty"><span class="empty__mark" aria-hidden="true">✦</span><p>${message}</p>${hint && html`<p class="muted">${hint}</p>`}</div>`;

/** cols: [{ label, cell(row) -> text|html, num?: bool }]. Rows are responsive via horizontal scroll. */
export function dataTable({ cols, rows, empty, caption = '', foot = null }) {
  if (!rows.length) return emptyState(empty);
  return html`<div class="table-wrap" tabindex="0" role="region" aria-label="${caption}">
    <table class="data">
      <thead><tr>${cols.map((c) => html`<th scope="col" class="${c.num ? 'num' : ''}">${c.label}</th>`)}</tr></thead>
      <tbody>${rows.map((r) => html`<tr>${cols.map((c) => html`<td class="${c.num ? 'num' : ''}">${c.cell(r)}</td>`)}</tr>`)}</tbody>
      ${foot && html`<tfoot><tr>${foot.map((cell, i) => html`<td class="${cols[i].num ? 'num' : ''}">${cell}</td>`)}</tr></tfoot>`}
    </table></div>`;
}

export const badge = (text, tone = 'neutral', mark = '') =>
  html`<span class="badge badge--${tone}">${mark && html`<span aria-hidden="true">${mark}</span>`}${text}</span>`;

function inputHtml(f, id) {
  const common = html`id="${id}" name="${f.name}" ${f.required ? 'required' : ''} ${f.placeholder ? html`placeholder="${f.placeholder}"` : ''} autocomplete="off"`;
  const val = f.value ?? '';
  switch (f.type) {
    case 'select':
      return html`<select ${common}>${f.options.map((o) => html`<option value="${o.value}" ${String(o.value) === String(val) ? 'selected' : ''}>${o.label}</option>`)}</select>`;
    case 'textarea':
      return html`<textarea ${common} rows="3">${val}</textarea>`;
    case 'money':
    case 'qty':
      return html`<input ${common} type="text" inputmode="decimal" value="${val}">`;
    case 'int':
      return html`<input ${common} type="number" step="1" ${f.min !== undefined ? html`min="${f.min}"` : ''} ${f.max !== undefined ? html`max="${f.max}"` : ''} value="${val}">`;
    case 'pin':
      return html`<input ${common} type="password" inputmode="numeric" minlength="${f.min ?? 4}" value="${val}">`;
    case 'datetime':
      return html`<input ${common} type="datetime-local" value="${val ? toDateTimeInput(val) : ''}">`;
    default:
      return html`<input ${common} type="${f.type ?? 'text'}" value="${val}">`;
  }
}

function fieldHtml(f) {
  const id = `f${++fieldSeq}`;
  if (f.type === 'checkbox') {
    return html`<label class="check"><input type="checkbox" name="${f.name}" ${f.value ? 'checked' : ''}><span>${f.label}</span></label>`;
  }
  if (f.type === 'checks') {
    return html`<fieldset class="field"><legend>${f.label}</legend><div class="checks">${f.options.map((o) =>
      html`<label class="check"><input type="checkbox" name="${f.name}" value="${o.value}"><span>${o.label}</span></label>`)}</div></fieldset>`;
  }
  return html`<div class="field"><label for="${id}">${f.label}</label>${inputHtml(f, id)}${f.hint && html`<p class="hint">${f.hint}</p>`}</div>`;
}

function readField(form, f) {
  const el = form.elements[f.name];
  switch (f.type) {
    case 'checkbox': return el.checked;
    case 'checks': return [...form.querySelectorAll(`input[name="${f.name}"]:checked`)].map((c) => c.value);
    case 'money': {
      const v = parseFen(el.value);
      if (Number.isNaN(v)) throw new Error(t('err.badAmount'));
      return v;
    }
    case 'qty': {
      if (!el.value.trim()) return null;
      const v = parseMilli(el.value);
      if (Number.isNaN(v)) throw new Error(t('err.badQty'));
      return v;
    }
    case 'int': return el.value === '' ? null : Number(el.value);
    case 'datetime': return el.value ? new Date(el.value).getTime() : null;
    default: return el.value.trim();
  }
}

function openModal(title, bodyHtml) {
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog';
  dlg.setAttribute('aria-labelledby', 'dlg-title');
  dlg.innerHTML = html`<h2 id="dlg-title" class="dialog__title">${title}</h2>${bodyHtml}`.text;
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  return dlg;
}

/**
 * Modal form. `onSubmit(values)` may throw; the message is shown inside the dialog and it stays open.
 * Resolves true after a successful submit, false when dismissed.
 */
export function formDialog({ title, intro = '', fields = [], submit = 'common.save', danger = false, onSubmit }) {
  return new Promise((resolve) => {
    let done = false;
    const dlg = openModal(title, html`<form class="dialog__form" novalidate>
      ${intro && html`<p class="dialog__intro">${intro}</p>`}
      ${fields.map(fieldHtml)}
      <p class="dialog__error" role="alert" hidden></p>
      <div class="dialog__actions">
        <button type="button" class="btn btn--ghost" data-cancel>${t('common.cancel')}</button>
        <button type="submit" class="btn ${danger ? 'btn--danger' : 'btn--primary'}">${t(submit)}</button>
      </div></form>`);
    const form = dlg.querySelector('form');
    const errorEl = dlg.querySelector('.dialog__error');
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    dlg.addEventListener('close', () => finish(false));
    dlg.querySelector('[data-cancel]').addEventListener('click', () => dlg.close());
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!form.checkValidity()) { form.reportValidity(); return; }
      const button = form.querySelector('[type=submit]');
      button.disabled = true;
      errorEl.hidden = true;
      try {
        const values = Object.fromEntries(fields.map((f) => [f.name, readField(form, f)]));
        await onSubmit(values);
        finish(true);
        dlg.close();
      } catch (e) {
        errorEl.textContent = errorText(e);
        errorEl.hidden = false;
        button.disabled = false;
      }
    });
    form.querySelector('input:not([type=checkbox]), select, textarea, [type=submit]')?.focus();
  });
}

export const confirmDialog = ({ title, message, submit = 'common.confirm', danger = false }) =>
  formDialog({ title, intro: message, submit, danger, onSubmit: async () => {} });

export function infoDialog(title, bodyHtml) {
  const dlg = openModal(title, html`<div class="dialog__form">${bodyHtml}
    <div class="dialog__actions"><button type="button" class="btn btn--primary" data-close>${t('common.close')}</button></div></div>`);
  dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
  dlg.querySelector('[data-close]').focus();
}

/** Selected button state for segmented controls (aria-pressed). */
export const pressed = (on) => (on ? 'true' : 'false');

