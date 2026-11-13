// Cashier shift widget: open with float, close with counted cash and variance.
import { t, tOr } from './i18n.js';
import { get, post } from './session.js';
import { html, fmtMoney, fmtTime } from './util.js';
import { formDialog, infoDialog } from './ui.js';
import { S } from './floor-state.js';

export const loadShift = async () => { S.shift = await get('/api/shifts/current'); };

export function shiftHtml() {
  const s = S.shift;
  if (!s) {
    return html`<div class="shift"><span class="shift__state"><span aria-hidden="true">○</span> ${t('shift.none')}</span>
      <button type="button" class="btn btn--small btn--primary" data-action="openShift">${t('shift.open')}</button></div>`;
  }
  return html`<div class="shift shift--open"><span class="shift__state"><span aria-hidden="true">●</span> ${t('shift.openSince', { time: fmtTime(s.opened_at) })}</span>
    <span class="shift__cash">${t('shift.expected')}: <strong>${fmtMoney(s.expectedCash)}</strong></span>
    <button type="button" class="btn btn--small btn--ghost" data-action="closeShift">${t('shift.close')}</button></div>`;
}

export const openShiftDialog = (onDone) => formDialog({
  title: t('shift.open'),
  fields: [{ name: 'cash', label: t('shift.openingCash'), type: 'money', required: true, value: '0' }],
  submit: 'shift.open',
  onSubmit: async ({ cash }) => { await post('/api/shifts/open', { openingCash: cash }); await onDone(); },
});

function closeSummary(r) {
  const tone = r.variance === 0 ? 'balanced' : r.variance > 0 ? 'over' : 'short';
  return html`<dl class="totals">
    <div class="totals__row"><dt>${t('shift.expected')}</dt><dd>${fmtMoney(r.expectedCash)}</dd></div>
    <div class="totals__row"><dt>${t('shift.counted')}</dt><dd>${fmtMoney(r.countedCash)}</dd></div>
    <div class="totals__row totals__row--strong"><dt>${t('shift.variance')}</dt><dd>${fmtMoney(r.variance)} (${t(`shift.${tone}`)})</dd></div>
    ${r.byMethod.map((m) => html`<div class="totals__row"><dt>${tOr(`pay.${m.method}`, m.method)}</dt><dd>${fmtMoney(m.amount)}</dd></div>`)}
  </dl>`;
}

export const closeShiftDialog = (onDone) => {
  let result = null;
  return formDialog({
    title: t('shift.close'),
    intro: t('shift.closeIntro', { expected: fmtMoney(S.shift.expectedCash) }),
    fields: [{ name: 'cash', label: t('shift.counted'), type: 'money', required: true }],
    submit: 'shift.close',
    onSubmit: async ({ cash }) => { result = await post('/api/shifts/close', { countedCash: cash }); },
  }).then(async (ok) => {
    if (!ok) return;
    await onDone();
    infoDialog(t('shift.closed'), closeSummary(result));
  });
};
