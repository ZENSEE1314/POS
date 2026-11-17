// Admin > Auto-reply: the FAQ the bot answers from (in the customer app's Contact page and on WeChat), questions it could
// not answer, and linking the company's WeChat Official Account.
import { t } from './i18n.js';
import { get, post, patch, put } from './session.js';
import { html, fmtDateTime } from './util.js';
import { formDialog, confirmDialog, dataTable, badge, toast } from './ui.js';

const faqFields = (f = {}) => [
  { name: 'question', label: t('bot.question'), type: 'textarea', value: f.question ?? '', hint: t('bot.questionHint') },
  { name: 'answer', label: t('bot.answer'), type: 'textarea', value: f.answer ?? '' },
  { name: 'questionEn', label: t('bot.questionEn'), type: 'textarea', value: f.questionEn ?? '' },
  { name: 'answerEn', label: t('bot.answerEn'), type: 'textarea', value: f.answerEn ?? '' },
  { name: 'active', label: t('bot.active'), type: 'checkbox', value: f.active ?? true },
];
const faqBody = (v) => ({ question: v.question ?? '', answer: v.answer ?? '', questionEn: v.questionEn ?? '', answerEn: v.answerEn ?? '', active: Boolean(v.active) });

export function botSection(reload) {
  let questions = [];
  let wechat = { url: '', appId: '', hasToken: false };
  let faqs = [];
  return {
    bot: {
      load: async () => {
        [faqs, questions, wechat] = await Promise.all([get('/api/bot/faqs'), get('/api/bot/questions'), get('/api/bot/wechat')]);
        return faqs;
      },
      add: 'bot.newFaq',
      view: (rows) => html`<p class="muted">${t('bot.intro')}</p>
        <section class="panel"><h4 class="section-title">${t('bot.wechat')}</h4>
          <p>${wechat.hasToken ? badge(t('bot.linked'), 'success', '●') : badge(t('bot.notLinked'), 'neutral', '○')}${wechat.appId && html` <span class="muted">${wechat.appId}</span>`}</p>
          <p class="muted">${t('bot.wechatHow')}</p><p><code>${wechat.url}</code></p>
          <div class="row"><button type="button" class="btn btn--small" data-action="linkWechat">${wechat.hasToken ? t('bot.changeLink') : t('bot.link')}</button>
            ${wechat.hasToken && html`<button type="button" class="btn btn--small btn--danger" data-action="unlinkWechat">${t('bot.unlink')}</button>`}</div></section>
        ${dataTable({ caption: t('bot.open'), empty: t('bot.noOpen'), rows: questions, cols: [
          { label: t('bot.asked'), cell: (q) => q.text },
          { label: t('bot.channel'), cell: (q) => t(`bot.channel.${q.channel}`) },
          { label: t('bot.when'), cell: (q) => fmtDateTime(q.createdAt) },
          { label: t('common.actions'), cell: (q) => html`<div class="row"><button type="button" class="btn btn--small" data-action="answerQuestion" data-id="${q.id}">${t('bot.answerIt')}</button>
            <button type="button" class="btn btn--small btn--ghost" data-action="dismissQuestion" data-id="${q.id}">${t('bot.dismiss')}</button></div>` },
        ] })}
        ${dataTable({ caption: t('bot.faqs'), empty: t('bot.noFaqs'), rows, cols: [
          { label: t('bot.question'), cell: (f) => html`${f.question}${f.questionEn && html`<br><span class="muted">${f.questionEn}</span>`}` },
          { label: t('bot.answer'), cell: (f) => html`${f.answer}${f.answerEn && html`<br><span class="muted">${f.answerEn}</span>`}` },
          { label: t('common.status'), cell: (f) => (f.active ? badge(t('bot.active'), 'success', '●') : badge(t('bot.off'), 'neutral', '○')) },
          { label: t('common.actions'), cell: (f) => html`<button type="button" class="btn btn--small btn--ghost" data-action="edit" data-id="${f.id}">${t('common.edit')}</button>` },
        ] })}`,
      dialog: (f) => formDialog({
        title: f ? t('bot.editFaq') : t('bot.newFaq'), intro: t('bot.faqIntro'), fields: faqFields(f),
        onSubmit: async (v) => {
          if (f) await patch(`/api/bot/faqs/${f.id}`, faqBody(v)); else await post('/api/bot/faqs', faqBody(v));
          await reload();
        },
      }),
      actions: {
        answerQuestion: (el) => {
          const q = questions.find((x) => x.id === Number(el.dataset.id));
          const cjk = /[㐀-鿿]/.test(q.text);
          return formDialog({
            title: t('bot.answerIt'), intro: t('bot.answerIntro'), fields: faqFields(cjk ? { question: q.text } : { questionEn: q.text }),
            onSubmit: async (v) => {
              await post('/api/bot/faqs', { ...faqBody(v), fromQuestion: q.id });
              await reload();
            },
          });
        },
        dismissQuestion: async (el) => {
          await post(`/api/bot/questions/${el.dataset.id}/dismiss`);
          await reload();
        },
        linkWechat: () => formDialog({
          title: t('bot.link'), intro: t('bot.linkIntro'),
          fields: [
            { name: 'appId', label: 'AppID', value: wechat.appId, hint: t('bot.appIdHint') },
            { name: 'token', label: 'Token', required: true, hint: t('bot.tokenHint') },
          ],
          onSubmit: async (v) => {
            await put('/api/bot/wechat', { appId: v.appId ?? '', token: v.token });
            toast(t('bot.saved'), 'success');
            await reload();
          },
        }),
        unlinkWechat: async () => {
          if (!await confirmDialog({ title: t('bot.unlink'), message: t('bot.unlinkAsk'), danger: true, submit: 'bot.unlink' })) return;
          await put('/api/bot/wechat', { token: '' });
          await reload();
        },
      },
    },
  };
}
