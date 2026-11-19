// Queue tab (排队叫号): numbers for guests waiting for a table. Staff take a number for walk-ins, call the next party
// (the screen speaks the number), then seat or skip it. Guests can also take a number themselves from the QR code.
import { t, addStrings } from './i18n.js';
import { app, get, post } from './session.js';
import { html, raw, setHtml, fmtTime } from './util.js';
import { delegate, formDialog, skeleton, emptyState, notifyError, toast, badge } from './ui.js';
import { qrSvg } from './qr.js';

const REFRESH_MS = 10_000;
const MINUTE_MS = 60_000;
const DEFAULT_PARTY = 2;
const MAX_PARTY = 99;
const SPEECH_LANG = 'zh-CN';
// The call is always spoken in Chinese: it is for the guests in the room, not for the staff member's UI language.
const speechText = (n) => `请 ${n} 号顾客到前台`;
const DONE_TONE = { seated: 'success', skipped: 'neutral', cancelled: 'neutral' };

addStrings({
  en: {
    'nav.queue': 'Queue',
    'queue.calling': 'Now calling', 'queue.nobody': 'Nobody called yet', 'queue.take': 'Take a number', 'queue.takeIntro': 'For a walk-in guest. Give them the number.',
    'queue.party': 'Party size', 'queue.name': 'Name (optional)', 'queue.phone': 'Phone (optional)', 'queue.taken': 'Number {n} taken.',
    'queue.waiting': 'Waiting ({n})', 'queue.none': 'Nobody is waiting.', 'queue.call': 'Call', 'queue.recall': 'Call again',
    'queue.seat': 'Seated', 'queue.skip': 'Skip', 'queue.people': '{n} people', 'queue.waited': 'waiting {n} min',
    'queue.status.waiting': 'Waiting', 'queue.status.called': 'Called', 'queue.status.seated': 'Seated', 'queue.status.skipped': 'Skipped',
    'queue.status.cancelled': 'Cancelled', 'queue.source.guest': 'Self', 'queue.source.staff': 'Desk', 'queue.done': 'Done today',
    'queue.qr': 'Guests take a number', 'queue.qrHint': 'Guests scan this to take a number on their phone and see when it is their turn.',
    'queue.number': 'No. {n}', 'queue.noSpeech': 'This device cannot speak; call the number out loud.',
  },
  zh: {
    'nav.queue': '排队',
    'queue.calling': '正在叫号', 'queue.nobody': '尚未叫号', 'queue.take': '取号', 'queue.takeIntro': '为现场客人取号，并告知号码。',
    'queue.party': '人数', 'queue.name': '称呼（选填）', 'queue.phone': '手机号（选填）', 'queue.taken': '已取号：{n} 号。',
    'queue.waiting': '等位中（{n}）', 'queue.none': '暂无排队。', 'queue.call': '叫号', 'queue.recall': '再次叫号',
    'queue.seat': '已入座', 'queue.skip': '过号', 'queue.people': '{n} 人', 'queue.waited': '已等 {n} 分钟',
    'queue.status.waiting': '等位中', 'queue.status.called': '已叫号', 'queue.status.seated': '已入座', 'queue.status.skipped': '已过号',
    'queue.status.cancelled': '已取消', 'queue.source.guest': '自助', 'queue.source.staff': '前台', 'queue.done': '今日已处理',
    'queue.qr': '扫码取号', 'queue.qrHint': '客人扫码即可在手机上取号，并实时查看排到第几位。',
    'queue.number': '{n} 号', 'queue.noSpeech': '此设备不支持语音播报，请人工叫号。',
  },
});

const queueUrl = () => `${location.origin}/g/${encodeURIComponent(app.company.code)}#queue`;

function speak(number) {
  if (!('speechSynthesis' in window)) { toast(t('queue.noSpeech')); return; }
  const say = new SpeechSynthesisUtterance(speechText(number));
  say.lang = SPEECH_LANG;
  speechSynthesis.cancel();
  speechSynthesis.speak(say);
}

const actionBtn = (action, id, label, cls = 'btn--ghost') =>
  html`<button type="button" class="btn ${cls}" data-action="${action}" data-id="${id}">${label}</button>`;

function waitingRow(x, now) {
  const minutes = Math.max(0, Math.floor((now - x.createdAt) / MINUTE_MS));
  return html`<li class="queue-row ${x.status === 'called' ? 'queue-row--called' : ''}">
    <span class="queue-row__num">${x.number}</span>
    <span class="queue-row__who"><b>${t('queue.people', { n: x.partySize })}</b>${x.name && html` · ${x.name}`}${x.phone && html` · ${x.phone}`}
      <span class="muted">${t('queue.waited', { n: minutes })} · ${t(`queue.source.${x.source}`)}</span>
      ${x.status === 'called' && badge(t('queue.status.called'), 'warning', '!')}</span>
    <span class="row">${actionBtn('call', x.id, t(x.status === 'called' ? 'queue.recall' : 'queue.call'), 'btn--primary')}
      ${actionBtn('seat', x.id, t('queue.seat'))}${actionBtn('skip', x.id, t('queue.skip'), 'btn--danger')}</span></li>`;
}

function bodyHtml(q) {
  const now = Date.now();
  return html`<div class="queue-layout">
    <div>
      <div class="panel queue-now" role="status" aria-live="polite">
        <p class="stat__label">${t('queue.calling')}</p>
        ${q.calling ? html`<p class="queue-now__num">${q.calling.number}</p><p class="muted">${t('queue.people', { n: q.calling.partySize })}${q.calling.name && html` · ${q.calling.name}`}</p>`
          : html`<p class="queue-now__none">${t('queue.nobody')}</p>`}
      </div>
      <h3 class="section-title">${t('queue.waiting', { n: q.waiting.length })}</h3>
      <div class="panel">${q.waiting.length ? html`<ul class="queue-list">${q.waiting.map((x) => waitingRow(x, now))}</ul>` : emptyState(t('queue.none'))}</div>
      ${q.done.length > 0 && html`<h3 class="section-title">${t('queue.done')}</h3><div class="panel"><ul class="queue-done">${[...q.done].reverse().map((x) =>
        html`<li><b>${t('queue.number', { n: x.number })}</b> ${t('queue.people', { n: x.partySize })} <span class="muted">${fmtTime(x.createdAt)}</span>
          ${badge(t(`queue.status.${x.status}`), DONE_TONE[x.status] ?? 'neutral')}</li>`)}</ul></div>`}
    </div>
    <aside class="panel table-qr queue-qr"><h3 class="section-title">${t('queue.qr')}</h3>${raw(qrSvg(queueUrl(), t('queue.qr')) ?? '')}
      <p class="hint">${t('queue.qrHint')}</p><p class="table-qr__link"><a href="${queueUrl()}" target="_blank" rel="noopener">${queueUrl()}</a></p></aside>
  </div>`;
}

export function mountQueue(root) {
  let queue = null;
  setHtml(root, html`<section aria-labelledby="qu-title">
    <div class="view-bar"><h2 id="qu-title" class="view-title">${t('nav.queue')}</h2>
      <button type="button" class="btn btn--primary" data-action="take">${t('queue.take')}</button></div>
    <div id="qu-body">${skeleton(4)}</div></section>`);

  const load = async () => {
    try {
      queue = await get('/api/queue');
      setHtml(root.querySelector('#qu-body'), bodyHtml(queue));
    } catch (e) { notifyError(e); }
  };
  void load();
  const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, REFRESH_MS);

  const move = async (el, step) => {
    await post(`/api/queue/${el.dataset.id}/${step}`);
    if (step === 'call') speak(queue.waiting.find((x) => x.id === Number(el.dataset.id)).number);
    await load();
  };

  delegate(root, {
    click: {
      take: () => formDialog({
        title: t('queue.take'), intro: t('queue.takeIntro'), submit: 'queue.take',
        fields: [
          { name: 'partySize', label: t('queue.party'), type: 'int', min: 1, max: MAX_PARTY, required: true, value: DEFAULT_PARTY },
          { name: 'name', label: t('queue.name') },
          { name: 'phone', label: t('queue.phone'), type: 'tel' },
        ],
        onSubmit: async (v) => {
          const ticket = await post('/api/queue', v);
          toast(t('queue.taken', { n: ticket.number }), 'success');
          await load();
        },
      }),
      call: (el) => move(el, 'call'),
      seat: (el) => move(el, 'seat'),
      skip: (el) => move(el, 'skip'),
    },
  });
  return () => clearInterval(timer);
}
