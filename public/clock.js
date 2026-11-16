// Header widgets for every staff member: clock in / clock out, and messages from managers (broadcasts).
import { t } from './i18n.js';
import { get, post, readStore, writeStore } from './session.js';
import { html, setHtml, fmtTime, fmtDateTime } from './util.js';
import { confirmDialog, notifyError, toast } from './ui.js';

const SEEN_KEY = 'nightpos.newsSeen';
const SEEN_KEEP = 50;
let shift = null;

const seenIds = () => {
  try { return JSON.parse(readStore(localStorage, SEEN_KEY) ?? '[]'); } catch { return []; }
};

export const clockSlot = () => html`<span id="clock-slot"></span>`;
export const newsSlot = () => html`<div id="news-slot" aria-live="polite"></div>`;

function renderClock() {
  const slot = document.getElementById('clock-slot');
  if (!slot) return;
  setHtml(slot, shift
    ? html`<button type="button" class="btn btn--small btn--ghost clock clock--on" data-action="clockOut" title="${t('clock.outHint')}">
        <span class="clock__dot" aria-hidden="true"></span>${t('clock.since', { time: fmtTime(shift.clockIn) })} · ${t('clock.out')}</button>`
    : html`<button type="button" class="btn btn--small btn--primary clock" data-action="clockIn">${t('clock.in')}</button>`);
}

function renderNews(items) {
  const slot = document.getElementById('news-slot');
  if (!slot) return;
  const seen = new Set(seenIds());
  const fresh = items.filter((n) => !seen.has(n.id));
  setHtml(slot, html`${fresh.map((n) => html`<div class="news" role="status">
    <span class="news__mark" aria-hidden="true">✉</span>
    <div class="news__text"><strong>${n.title}</strong>${n.body && html`<p>${n.body}</p>`}
      <p class="news__meta">${n.author ?? ''} · ${fmtDateTime(n.createdAt)}</p></div>
    <button type="button" class="btn btn--small btn--ghost" data-action="newsSeen" data-id="${n.id}">${t('news.ok')}</button></div>`)}`);
}

/** Loads both widgets after the shell is drawn. Offline: they stay empty and the till keeps working. */
export async function refreshHeaderWidgets() {
  try {
    const [mine, news] = await Promise.all([get('/api/attendance/me'), get('/api/news')]);
    shift = mine;
    renderClock();
    renderNews(news);
  } catch { /* offline: nothing to show */ }
}

export const clockActions = {
  clockIn: async () => {
    try {
      shift = await post('/api/attendance/clock-in');
      renderClock();
      toast(t('clock.inDone', { time: fmtTime(shift.clockIn) }), 'success');
    } catch (e) { notifyError(e); }
  },
  clockOut: async () => {
    if (!await confirmDialog({ title: t('clock.out'), message: t('clock.outAsk', { time: fmtTime(shift.clockIn) }), submit: 'clock.out' })) return;
    try {
      const r = await post('/api/attendance/clock-out');
      shift = null;
      renderClock();
      toast(t('clock.outDone', { hours: ((r.clockOut - r.clockIn) / 3_600_000).toFixed(1) }), 'success');
    } catch (e) { notifyError(e); }
  },
  newsSeen: (el) => {
    writeStore(localStorage, SEEN_KEY, JSON.stringify([Number(el.dataset.id), ...seenIds()].slice(0, SEEN_KEEP)));
    el.closest('.news')?.remove();
  },
};
