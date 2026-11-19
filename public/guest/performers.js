// Customer app home: tonight's singers and other performers (今晚驻唱). The card stays hidden when nobody is on.
import { t, addStrings } from './i18n.js';
import { html, setHtml, get } from './core.js';
import { icon } from './icons.js';

const TIME = { hour: '2-digit', minute: '2-digit', hour12: false };

addStrings({
  en: {
    'pf.tonight': 'Live tonight', 'pf.onNow': 'On stage now',
    'pf.kind.singer': 'Singer', 'pf.kind.dj': 'DJ', 'pf.kind.band': 'Band', 'pf.kind.dancer': 'Dancer', 'pf.kind.mc': 'MC',
  },
  zh: {
    'pf.tonight': '今晚驻唱', 'pf.onNow': '正在演出',
    'pf.kind.singer': '歌手', 'pf.kind.dj': 'DJ', 'pf.kind.band': '乐队', 'pf.kind.dancer': '舞者', 'pf.kind.mc': 'MC',
  },
});

const timeOf = (ms) => new Date(ms).toLocaleTimeString([], TIME);

const performerRow = (p, showStore) => html`<li class="g-perf">
  ${icon('music', 'g-perf__icon')}
  <span class="g-perf__body"><strong>${p.name}</strong> <span class="g-hint">${t(`pf.kind.${p.kind}`)}</span>
    ${p.bio && html`<span class="g-perf__bio">${p.bio}</span>`}
    <span class="g-hint">${timeOf(p.startsAt)} – ${timeOf(p.endsAt)}${showStore ? ` · ${p.storeName}` : ''}</span></span>
  ${p.onNow && html`<span class="g-badge g-badge--ok"><span aria-hidden="true">●</span> ${t('pf.onNow')}</span>`}</li>`;

/** Fills `el` with the line-up, or leaves it empty. Failures are quiet: the rest of the home page matters more. */
export async function showPerformers(el, company, multiStore) {
  let line = [];
  try { line = await get(`/api/guest/performers/${encodeURIComponent(company)}`); } catch { return; }
  if (!line.length) return;
  setHtml(el, html`<section class="g-card g-gap" aria-labelledby="g-perf-title">
    <h2 id="g-perf-title" class="g-card__title">${t('pf.tonight')}</h2>
    <ul class="g-perfs">${line.map((p) => performerRow(p, multiStore))}</ul></section>`);
}
