// Office tab section: staff academy (员工学院). Managers write short lessons (service rules, drink knowledge, safety),
// mark some as required, and see who has not read them yet; staff read each one and confirm "I have studied this".
import { t, addStrings } from './i18n.js';
import { can, get, post, patch } from './session.js';
import { html, setHtml, fmtDate } from './util.js';
import { delegate, formDialog, infoDialog, badge, emptyState, toast, notifyError } from './ui.js';

addStrings({
  en: {
    'office.academy': 'Academy',
    'lesson.add': 'New lesson', 'lesson.edit': 'Edit lesson', 'lesson.title': 'Title', 'lesson.category': 'Category', 'lesson.categoryHint': 'e.g. Service, Drinks, Safety.',
    'lesson.body': 'Lesson text', 'lesson.video': 'Video link (optional)', 'lesson.videoHint': 'Must start with https://', 'lesson.required': 'Required for all staff',
    'lesson.active': 'Visible to staff', 'lesson.read': 'Read', 'lesson.done': 'I have studied this', 'lesson.doneToast': 'Marked as studied.',
    'lesson.readAt': 'Studied {date}', 'lesson.todo': 'Not studied yet', 'lesson.requiredBadge': 'Required', 'lesson.hidden': 'Hidden',
    'lesson.readers': '{n} staff studied', 'lesson.watch': 'Watch the video', 'lesson.none': 'No lessons yet.',
    'lesson.noneHint': 'Managers can add lessons for the team here.', 'lesson.progress': 'Who still has to study',
    'lesson.allRead': 'Everyone has studied every required lesson.', 'lesson.general': 'General', 'lesson.opensNew': '(opens in a new window)',
  },
  zh: {
    'office.academy': '员工学院',
    'lesson.add': '新建课程', 'lesson.edit': '编辑课程', 'lesson.title': '标题', 'lesson.category': '分类', 'lesson.categoryHint': '例如：服务、酒水知识、安全。',
    'lesson.body': '课程内容', 'lesson.video': '视频链接（选填）', 'lesson.videoHint': '必须以 https:// 开头', 'lesson.required': '全员必修',
    'lesson.active': '对员工可见', 'lesson.read': '学习', 'lesson.done': '我已学习', 'lesson.doneToast': '已记录学习。',
    'lesson.readAt': '{date} 已学习', 'lesson.todo': '未学习', 'lesson.requiredBadge': '必修', 'lesson.hidden': '已隐藏',
    'lesson.readers': '{n} 人已学习', 'lesson.watch': '观看视频', 'lesson.none': '暂无课程。',
    'lesson.noneHint': '店长可以在这里为团队添加课程。', 'lesson.progress': '未完成必修的员工',
    'lesson.allRead': '所有员工都已完成必修课程。', 'lesson.general': '通用', 'lesson.opensNew': '（在新窗口打开）',
  },
});

const lessonFields = (x) => [
  { name: 'title', label: t('lesson.title'), required: true, value: x?.title },
  { name: 'category', label: t('lesson.category'), value: x?.category, hint: t('lesson.categoryHint') },
  { name: 'body', label: t('lesson.body'), type: 'textarea', value: x?.body },
  { name: 'videoUrl', label: t('lesson.video'), type: 'url', value: x?.videoUrl, hint: t('lesson.videoHint') },
  { name: 'required', label: t('lesson.required'), type: 'checkbox', value: x?.required ?? false },
  { name: 'active', label: t('lesson.active'), type: 'checkbox', value: x?.active ?? true },
];

function lessonCard(x, isManager) {
  return html`<article class="lesson-card">
    <h4 class="lesson-card__title">${x.title}</h4>
    <p class="row">${x.required && badge(t('lesson.requiredBadge'), 'warning', '!')}
      ${x.readAt ? badge(t('lesson.readAt', { date: fmtDate(x.readAt) }), 'success', '✓') : badge(t('lesson.todo'), 'neutral', '○')}
      ${isManager && !x.active && badge(t('lesson.hidden'), 'neutral', '—')}
      ${isManager && html`<span class="muted">${t('lesson.readers', { n: x.readers })}</span>`}</p>
    <div class="row"><button type="button" class="btn btn--small btn--primary" data-action="lessonOpen" data-id="${x.id}">${t('lesson.read')}</button>
      ${isManager && html`<button type="button" class="btn btn--small btn--ghost" data-action="lessonEdit" data-id="${x.id}">${t('common.edit')}</button>`}</div>
  </article>`;
}

const progressHtml = (progress) => html`<section class="panel" aria-labelledby="lesson-progress-title">
  <h3 id="lesson-progress-title" class="section-title">${t('lesson.progress')}</h3>
  ${progress.length ? html`<ul class="lesson-progress">${progress.map((p) => html`<li><b>${p.title}</b>: ${p.notRead.join('、')}</li>`)}</ul>`
    : html`<p class="muted">${t('lesson.allRead')}</p>`}</section>`;

/** Office loader: (el) renders the academy into a fresh child of el and wires its own buttons. */
export async function academy(el) {
  setHtml(el, html`<div></div>`);
  const host = el.firstElementChild;
  const isManager = can('admin.write');
  let lessons = [];

  async function reload() {
    const [list, progress] = await Promise.all([get('/api/lessons'), isManager ? get('/api/training-progress') : null]);
    lessons = list;
    const groups = new Map();
    for (const x of lessons) groups.set(x.category || t('lesson.general'), [...(groups.get(x.category || t('lesson.general')) ?? []), x]);
    setHtml(host, html`${isManager && html`<div class="view-bar"><button type="button" class="btn btn--primary" data-action="lessonAdd">${t('lesson.add')}</button></div>`}
      ${isManager && progressHtml(progress)}
      ${lessons.length ? [...groups].map(([cat, list]) => html`<h3 class="section-title">${cat}</h3>
          <div class="lesson-grid">${list.map((x) => lessonCard(x, isManager))}</div>`)
        : html`<div class="panel">${emptyState(t('lesson.none'), isManager ? t('lesson.noneHint') : '')}</div>`}`);
  }

  const find = (b) => lessons.find((x) => x.id === Number(b.dataset.id));

  function openLesson(x) {
    infoDialog(x.title, html`<div class="lesson-body">${x.body}</div>
      ${x.videoUrl && html`<p><a href="${x.videoUrl}" target="_blank" rel="noopener">${t('lesson.watch')}</a> <span class="sr-only">${t('lesson.opensNew')}</span></p>`}
      ${!x.readAt && x.active && html`<button type="button" class="btn btn--primary btn--block" data-lesson-done>${t('lesson.done')}</button>`}`);
    document.querySelector('dialog[open] [data-lesson-done]')?.addEventListener('click', async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      try {
        await post(`/api/lessons/${x.id}/read`);
        toast(t('lesson.doneToast'), 'success');
        button.closest('dialog').close();
        await reload();
      } catch (err) {
        button.disabled = false;
        notifyError(err);
      }
    });
  }

  const saveDialog = (x) => formDialog({
    title: x ? t('lesson.edit') : t('lesson.add'), fields: lessonFields(x),
    onSubmit: async (v) => {
      if (x) await patch(`/api/lessons/${x.id}`, v); else await post('/api/lessons', v);
      await reload();
    },
  });

  delegate(host, {
    click: {
      lessonAdd: () => saveDialog(null),
      lessonEdit: (b) => saveDialog(find(b)),
      lessonOpen: (b) => openLesson(find(b)),
    },
  });
  await reload();
}
