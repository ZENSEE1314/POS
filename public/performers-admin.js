// Admin section: singers and other performers (驻唱) and their sets at this store. The customer app shows tonight's
// line-up on its home page, with "on stage now" while a set is running.
import { t, addStrings } from './i18n.js';
import { get, post, patch, del } from './session.js';
import { html, fmtDateTime } from './util.js';
import { formDialog, confirmDialog, dataTable, badge, toast } from './ui.js';

const KINDS = ['singer', 'dj', 'band', 'dancer', 'mc'];
const HOUR_MS = 3_600_000;
const DEFAULT_SET_HOURS = 2;

addStrings({
  en: {
    'admin.performers': 'Performers',
    'pf.add': 'Add performer', 'pf.edit': 'Edit performer', 'pf.name': 'Name', 'pf.kind': 'Type', 'pf.bio': 'Short intro (shown to guests)',
    'pf.kind.singer': 'Singer', 'pf.kind.dj': 'DJ', 'pf.kind.band': 'Band', 'pf.kind.dancer': 'Dancer', 'pf.kind.mc': 'MC',
    'pf.people': 'Performers', 'pf.sets': 'Upcoming sets at this store', 'pf.addSet': 'Schedule a set', 'pf.performer': 'Performer',
    'pf.starts': 'Starts', 'pf.ends': 'Ends', 'pf.removeSet': 'Remove', 'pf.removeAsk': 'Remove this set of {name}?', 'pf.noSets': 'No sets scheduled.',
    'pf.needActive': 'Add an active performer first.', 'pf.setAdded': 'Set scheduled.', 'pf.onNow': 'On stage now',
  },
  zh: {
    'admin.performers': '驻唱艺人',
    'pf.add': '添加艺人', 'pf.edit': '编辑艺人', 'pf.name': '艺名', 'pf.kind': '类型', 'pf.bio': '简介（顾客端可见）',
    'pf.kind.singer': '歌手', 'pf.kind.dj': 'DJ', 'pf.kind.band': '乐队', 'pf.kind.dancer': '舞者', 'pf.kind.mc': 'MC',
    'pf.people': '艺人', 'pf.sets': '本店即将演出', 'pf.addSet': '安排演出', 'pf.performer': '艺人',
    'pf.starts': '开始', 'pf.ends': '结束', 'pf.removeSet': '删除', 'pf.removeAsk': '删除 {name} 的这场演出？', 'pf.noSets': '暂无演出安排。',
    'pf.needActive': '请先添加一位在职艺人。', 'pf.setAdded': '演出已安排。', 'pf.onNow': '正在演出',
  },
});

const kindOptions = KINDS.map((k) => ({ value: k, label: t(`pf.kind.${k}`) }));
const activeBadge = (on) => (on ? badge(t('common.active'), 'success', '✓') : badge(t('common.inactive'), 'neutral', '—'));
const btn = (action, id, label, cls = 'btn--ghost') => html`<button type="button" class="btn btn--small ${cls}" data-action="${action}" data-id="${id}">${label}</button>`;

/** `reload` re-runs the admin section (load + view). */
export function performerSection(reload) {
  let data = { performers: [], sets: [] };
  const performerOf = (el) => data.performers.find((x) => x.id === Number(el.dataset.id));

  const performerDialog = (x) => formDialog({
    title: x ? t('pf.edit') : t('pf.add'),
    fields: [
      { name: 'name', label: t('pf.name'), required: true, value: x?.name },
      { name: 'kind', label: t('pf.kind'), type: 'select', value: x?.kind ?? 'singer', options: kindOptions },
      { name: 'bio', label: t('pf.bio'), type: 'textarea', value: x?.bio },
      ...(x ? [{ name: 'active', label: t('common.active'), type: 'checkbox', value: x.active }] : []),
    ],
    onSubmit: async (v) => {
      if (x) await patch(`/api/performers/${x.id}`, v); else await post('/api/performers', v);
      await reload();
    },
  });

  function setDialog(performerId) {
    const live = data.performers.filter((x) => x.active);
    if (!live.length) { toast(t('pf.needActive'), 'error'); return null; }
    const start = Date.now();
    return formDialog({
      title: t('pf.addSet'),
      fields: [
        { name: 'performerId', label: t('pf.performer'), type: 'select', value: performerId ?? live[0].id, options: live.map((x) => ({ value: x.id, label: x.name })) },
        { name: 'startsAt', label: t('pf.starts'), type: 'datetime', required: true, value: start },
        { name: 'endsAt', label: t('pf.ends'), type: 'datetime', required: true, value: start + DEFAULT_SET_HOURS * HOUR_MS },
      ],
      onSubmit: async (v) => {
        await post('/api/performer-sets', { performerId: Number(v.performerId), startsAt: v.startsAt, endsAt: v.endsAt });
        toast(t('pf.setAdded'), 'success');
        await reload();
      },
    });
  }

  const view = () => {
    const now = Date.now();
    return html`<div class="row"><button type="button" class="btn btn--ghost" data-action="pfAddSet">${t('pf.addSet')}</button></div>
      <h4 class="section-title">${t('pf.people')}</h4>
      ${dataTable({ caption: t('pf.people'), empty: t('common.noData'), rows: data.performers, cols: [
        { label: t('pf.name'), cell: (x) => x.name }, { label: t('pf.kind'), cell: (x) => t(`pf.kind.${x.kind}`) },
        { label: t('pf.bio'), cell: (x) => html`<span class="detail">${x.bio || '-'}</span>` }, { label: t('common.status'), cell: (x) => activeBadge(x.active) },
        { label: t('common.actions'), cell: (x) => html`<div class="row">${btn('pfEdit', x.id, t('common.edit'))}${x.active && btn('pfAddSet', x.id, t('pf.addSet'))}</div>` }] })}
      <h4 class="section-title">${t('pf.sets')}</h4>
      ${dataTable({ caption: t('pf.sets'), empty: t('pf.noSets'), rows: data.sets, cols: [
        { label: t('pf.performer'), cell: (s) => html`${s.name} ${s.startsAt <= now && badge(t('pf.onNow'), 'success', '●')}` },
        { label: t('pf.starts'), cell: (s) => fmtDateTime(s.startsAt) }, { label: t('pf.ends'), cell: (s) => fmtDateTime(s.endsAt) },
        { label: t('common.actions'), cell: (s) => btn('pfRemoveSet', s.id, t('pf.removeSet'), 'btn--danger') }] })}`;
  };

  return {
    performers: {
      load: async () => { data = await get('/api/performers'); return []; },
      add: 'pf.add',
      view,
      dialog: () => performerDialog(null),
      actions: {
        pfEdit: (el) => performerDialog(performerOf(el)),
        pfAddSet: (el) => setDialog(el.dataset.id ? Number(el.dataset.id) : null),
        pfRemoveSet: async (el) => {
          const set = data.sets.find((s) => s.id === Number(el.dataset.id));
          if (!await confirmDialog({ title: t('pf.removeSet'), message: t('pf.removeAsk', { name: set.name }), danger: true, submit: 'pf.removeSet' })) return;
          await del(`/api/performer-sets/${set.id}`);
          await reload();
        },
      },
    },
  };
}
