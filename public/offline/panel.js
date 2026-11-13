// Header status pill and the "needs attention" panel.
import { t } from '../i18n.js';
import { html, setHtml, fmtTime } from '../util.js';
import { badge, delegate } from '../ui.js';
import { getState, subscribe, listMyOps, retryOp, dismissOp, syncNow, describeOp, explainOp } from './sync.js';
import { onChanged } from './store.js';

const PILL_HOST_ID = 'syncPillHost';

function pillParts(s) {
  if (s.attention > 0) return { tone: 'danger', mark: '!', text: t('sync.attention', { n: s.attention }) };
  if (s.syncing) return { tone: 'info', mark: '↻', text: t('sync.syncing') };
  if (!s.online) return { tone: 'warning', mark: '○', text: s.pending > 0 ? t('sync.offlinePending', { n: s.pending }) : t('sync.offline') };
  if (s.pending > 0) return { tone: 'warning', mark: '●', text: s.needsLogin ? t('sync.signIn', { n: s.pending }) : t('sync.pending', { n: s.pending }) };
  return { tone: 'success', mark: '●', text: t('sync.online') };
}

/** Markup for the header; mountSyncPill keeps it current. */
export function syncPillHtml() {
  return html`<span id="${PILL_HOST_ID}" class="sync-host" role="status" aria-live="polite">${pillButton(getState())}</span>`;
}

function pillButton(s) {
  const { tone, mark, text } = pillParts(s);
  return html`<button type="button" class="sync-pill sync-pill--${tone}" data-action="syncPanel" aria-label="${t('sync.openPanel')}: ${text}"><span aria-hidden="true">${mark}</span> ${text}</button>`;
}

/** Re-renders the pill whenever the connection or queue changes. Call after every header render; returns the unsubscribe. */
export function mountSyncPill() {
  const render = (s) => {
    const host = document.getElementById(PILL_HOST_ID);
    if (host) setHtml(host, pillButton(s));
  };
  render(getState());
  return subscribe(render);
}

function itemHtml(op) {
  const warning = op.result?.status === 'ok';
  const retryable = !warning;
  return html`<li class="sync-item sync-item--${warning ? 'warning' : 'danger'}">
    <p class="sync-item__what"><strong>${describeOp(op)}</strong> <span class="muted">${fmtTime(op.ts)}</span></p>
    <p class="sync-item__why">${explainOp(op)}</p>
    ${op.type === 'bill.pay' && !warning && html`<p class="sync-item__why">${t('sync.cashNote')}</p>`}
    <div class="row">
      ${retryable && html`<button type="button" class="btn btn--small btn--secondary" data-action="syncRetry" data-seq="${op.seq}">${t('sync.retry')}</button>`}
      <button type="button" class="btn btn--small btn--ghost" data-action="syncDismiss" data-seq="${op.seq}">${t('sync.dismiss')}</button>
    </div></li>`;
}

async function panelHtml() {
  const s = getState();
  const ops = await listMyOps();
  const attention = ops.filter((o) => o.status === 'attention');
  const pending = ops.filter((o) => o.status === 'pending');
  const { tone, text } = pillParts(s);
  return html`<div class="dialog__form">
    <p>${badge(text, tone)}</p>
    ${!s.online && html`<p class="dialog__intro">${t('sync.offlineHelp')}</p>`}
    ${s.foreign > 0 && html`<p class="dialog__intro">${t('sync.foreign', { n: s.foreign })}</p>`}
    ${attention.length > 0 && html`<h3 class="section-title">${t('sync.needsAttention')}</h3><ul class="sync-list">${attention.map(itemHtml)}</ul>`}
    ${pending.length > 0 && html`<h3 class="section-title">${t('sync.waiting', { n: pending.length })}</h3>
      <ul class="sync-list">${pending.map((o) => html`<li class="sync-item"><p class="sync-item__what">${describeOp(o)} <span class="muted">${fmtTime(o.ts)}</span></p></li>`)}</ul>`}
    ${!attention.length && !pending.length && html`<p class="muted">${t('sync.allClear')}</p>`}
    <div class="dialog__actions">
      ${s.online && pending.length > 0 && html`<button type="button" class="btn btn--primary" data-action="syncNow">${t('sync.syncNow')}</button>`}
      <button type="button" class="btn btn--ghost" data-close>${t('common.close')}</button>
    </div></div>`;
}

/** Modal listing what failed to sync, with Retry/Dismiss per operation. */
export async function openSyncPanel() {
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog';
  dlg.setAttribute('aria-labelledby', 'sync-title');
  document.body.append(dlg);
  const render = async () => {
    setHtml(dlg, html`<h2 id="sync-title" class="dialog__title">${t('sync.title')}</h2>${await panelHtml()}`);
  };
  await render();
  const stops = [subscribe(() => { void render(); }), onChanged(() => { void render(); })];
  dlg.addEventListener('close', () => { stops.forEach((stop) => stop()); dlg.remove(); });
  dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) dlg.close(); });
  delegate(dlg, {
    click: {
      syncRetry: (el) => retryOp(Number(el.dataset.seq)),
      syncDismiss: (el) => dismissOp(Number(el.dataset.seq)),
      syncNow: () => syncNow(),
    },
  });
  dlg.showModal();
}
