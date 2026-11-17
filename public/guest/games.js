// Party games played on one phone at the table. Entirely in the browser: nothing is sent, stored or bet.
import { t, getLang } from './i18n.js';
import { html, setHtml } from './core.js';
import { icon } from './icons.js';

const DICE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const DEFAULT_DICE = 5;
const MIN_DICE = 1;
const MAX_DICE = 6;
const SHAKE_MS = 600;
const PICK_STEPS = 14;
const PICK_STEP_MS = 70;

const CARDS = {
  truth: {
    en: ['What is the most embarrassing song on your phone?', 'Who here would you call at 3 am?', 'What was your worst date?',
      'What is a secret talent nobody here knows about?', 'What is the last lie you told?', 'Which person here do you know the longest?',
      'What would you do with one free day and no phone?', 'What is your most-used emoji?', 'What was your first impression of the person on your left?',
      'What is the silliest thing you have cried at?', 'If you could swap lives with someone here for a day, who?', 'What is your guilty pleasure TV show?'],
    zh: ['你手机里最尴尬的一首歌是什么？', '凌晨三点你会打给在座的哪一位？', '你经历过最糟糕的约会是怎样的？',
      '说一个在座的人都不知道的隐藏技能。', '你最近说的一个谎是什么？', '在座的人里你认识最久的是谁？',
      '如果有一天完全没有手机，你会做什么？', '你最常用的表情是哪个？', '你对左边这位的第一印象是什么？',
      '你哭过最傻的一次是因为什么？', '如果可以和在座的人互换一天人生，你选谁？', '你偷偷爱看的综艺或剧是什么？'],
  },
  dare: {
    en: ['Sing the chorus of the next song that plays.', 'Do your best impression of someone at this table.', 'Speak only in questions until your next turn.',
      'Show the last photo in your gallery.', 'Dance for 15 seconds, no music needed.', 'Let the person on your right post a nice comment on your social feed.',
      'Talk like a news reporter until your next turn.', 'Give everyone at the table a compliment.', 'Make up a toast for the table, right now.',
      'Swap seats with the person opposite you.', 'Tell a joke. If nobody laughs, tell another.', 'Do 10 squats.'],
    zh: ['下一首歌响起时唱副歌。', '模仿在座的一位，让大家猜是谁。', '直到下一轮之前，只能用问句说话。',
      '给大家看你相册里的最后一张照片。', '原地跳舞 15 秒。', '让右边的人用你的账号发一条夸人的评论。',
      '用新闻主播的语气说话，直到下一轮。', '夸一夸在座的每一位。', '现在为这一桌即兴说一段祝酒词。',
      '和对面的人换座位。', '讲一个笑话，没人笑就再讲一个。', '做 10 个深蹲。'],
  },
};

const pickRandom = (list) => list[crypto.getRandomValues(new Uint32Array(1))[0] % list.length];
const rollDie = () => crypto.getRandomValues(new Uint32Array(1))[0] % DICE_FACES.length;

const tile = (game, mark, title, sub) => html`<button type="button" class="g-tile" data-game="${game}"><span class="g-tile__mark g-tile__mark--glyph" aria-hidden="true">${mark}</span>
  <span class="g-tile__text"><strong>${title}</strong><span>${sub}</span></span></button>`;

/** `spinHref` adds the venue's prize wheel (points-based) above the party games when the venue has it on. */
export function mountGames(root, { spinHref = null } = {}) {
  const state = { game: null, dice: [], count: DEFAULT_DICE, shown: false, card: null, names: '', picked: '' };

  const back = () => html`<button type="button" class="g-btn g-btn--small" data-game="">${t('gm.back')}</button>`;

  function render() {
    if (!state.game) {
      setHtml(root, html`<div class="g-hero"><h1 class="g-hero__title">${t('gm.title')}</h1><p class="g-hero__text">${t('gm.note')}</p></div>
        <div class="g-actions">${spinHref && html`<a class="g-tile" href="${spinHref}" data-link><span class="g-tile__mark">${icon('wheel')}</span>
          <span class="g-tile__text"><strong>${t('rw.spinTile')}</strong><span>${t('gm.spinSub')}</span></span>${icon('chevron', 'g-tile__chevron')}</a>`}${tile('dice', '⚄', t('gm.dice'), t('gm.diceSub'))}${tile('tod', '?', t('gm.tod'), t('gm.todSub'))}${tile('pick', '☝', t('gm.pick'), t('gm.pickSub'))}</div>`);
      return;
    }
    if (state.game === 'dice') {
      const total = state.dice.reduce((s, d) => s + d + 1, 0);
      setHtml(root, html`${back()}<section class="g-card g-gap"><h1 class="g-card__title">${t('gm.dice')}</h1>
        <div class="g-field"><label for="dn">${t('gm.diceN')}</label><select id="dn" data-dice-count>${Array.from({ length: MAX_DICE - MIN_DICE + 1 }, (_, i) => i + MIN_DICE).map((n) =>
          html`<option value="${n}" ${n === state.count ? 'selected' : ''}>${n}</option>`)}</select></div>
        <div class="g-dice" aria-live="polite">${state.dice.length === 0 ? ''
          : state.shown ? html`${state.dice.map((d) => html`<span class="g-die" role="img" aria-label="${d + 1}">${DICE_FACES[d]}</span>`)}<p class="g-center">${t('gm.total', { n: total })}</p>`
          : html`<span class="g-cup" aria-hidden="true">◓</span><p class="g-center g-hint">${t('gm.hidden')}</p>`}</div>
        <div class="g-paybtns"><button type="button" class="g-btn g-btn--primary" data-shake>${t('gm.shake')}</button>
          ${state.dice.length > 0 && html`<button type="button" class="g-btn" data-reveal>${state.shown ? t('gm.hide') : t('gm.reveal')}</button>`}</div></section>`);
      return;
    }
    if (state.game === 'tod') {
      setHtml(root, html`${back()}<section class="g-card g-gap"><h1 class="g-card__title">${t('gm.tod')}</h1>
        <p class="g-todcard ${state.card ? `g-todcard--${state.card.kind}` : ''}" aria-live="polite">${state.card ? state.card.text : t('gm.drawHint')}</p>
        <div class="g-paybtns"><button type="button" class="g-btn g-btn--primary" data-draw="truth">${t('gm.truth')}</button>
          <button type="button" class="g-btn g-btn--primary" data-draw="dare">${t('gm.dare')}</button></div></section>`);
      return;
    }
    setHtml(root, html`${back()}<section class="g-card g-gap"><h1 class="g-card__title">${t('gm.pick')}</h1>
      <div class="g-field"><label for="nm">${t('gm.names')}</label><textarea id="nm" rows="5" data-names>${state.names}</textarea></div>
      <p class="g-picked" aria-live="polite">${state.picked && t('gm.picked', { name: state.picked })}</p>
      <button type="button" class="g-btn g-btn--primary g-btn--block" data-pick>${t('gm.pickGo')}</button></section>`);
  }

  const shake = async (button) => {
    button.disabled = true;
    root.querySelector('.g-dice')?.classList.add('g-dice--shaking');
    await new Promise((r) => setTimeout(r, SHAKE_MS));
    state.dice = Array.from({ length: state.count }, rollDie);
    state.shown = false;
    render();
  };

  const pick = async (button) => {
    const names = state.names.split('\n').map((n) => n.trim()).filter(Boolean);
    const out = root.querySelector('.g-picked');
    if (names.length < 2) { out.textContent = t('gm.needNames'); return; }
    button.disabled = true;
    for (let i = 0; i < PICK_STEPS; i++) {
      out.textContent = names[i % names.length];
      await new Promise((r) => setTimeout(r, PICK_STEP_MS));
    }
    state.picked = pickRandom(names);
    render();
  };

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.game !== undefined) { state.game = b.dataset.game || null; render(); }
    else if (b.dataset.shake !== undefined) await shake(b);
    else if (b.dataset.reveal !== undefined) { state.shown = !state.shown; render(); }
    else if (b.dataset.draw) { state.card = { kind: b.dataset.draw, text: pickRandom(CARDS[b.dataset.draw][getLang()] ?? CARDS[b.dataset.draw].en) }; render(); }
    else if (b.dataset.pick !== undefined) await pick(b);
  });
  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-dice-count]')) { state.count = Number(e.target.value); state.dice = []; render(); }
  });
  root.addEventListener('input', (e) => {
    if (e.target.matches('[data-names]')) state.names = e.target.value;
  });
  render();
}
