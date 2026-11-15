// Admin sections for the customer app: feature switches and point settings, events, loyalty rewards and the prize wheel.
import { t } from './i18n.js';
import { get, post, patch } from './session.js';
import { html, fmtDateTime } from './util.js';
import { formDialog, dataTable, badge, toast, infoDialog } from './ui.js';

const FEATURES = ['service', 'song', 'bottle', 'gift', 'loyalty', 'referral', 'spin', 'events', 'games', 'support', 'pets'];
const PRIZE_KINDS = ['none', 'points', 'voucher'];
const PERCENT = 100;

const onOff = (on) => (on ? badge(t('ga.on'), 'success', '✓') : badge(t('ga.off'), 'neutral', '—'));
const activeBadge = (on) => (on ? badge(t('common.active'), 'success', '✓') : badge(t('common.inactive'), 'neutral', '—'));
const editBtn = (id) => html`<button type="button" class="btn btn--small btn--ghost" data-action="edit" data-id="${id}">${t('common.edit')}</button>`;
const both = (zh, en) => (en ? html`${zh}<br><span class="muted">${en}</span>` : zh);

/** Section objects in the shape admin.js uses: load rows, an add button, a table view and an add/edit dialog. */
export function guestAdminSections(reload) {
  let settings = null;
  let prizeInfo = { usingDefaults: false, defaults: [] };

  const settingsRows = () => [
    ...FEATURES.map((f) => ({ id: f, label: t(`ga.feature.${f}`), value: onOff(settings.features[f]) })),
    { id: 'ppy', label: t('ga.pointsPerYuan'), value: settings.pointsPerYuan },
    { id: 'ref', label: t('ga.referralPoints'), value: settings.referralPoints },
    { id: 'spin', label: t('ga.spinCost'), value: settings.spinCost },
  ];

  const prizeTable = (rows, caption) => {
    const total = rows.filter((p) => p.active !== false).reduce((s, p) => s + p.weight, 0) || 1;
    return dataTable({ caption, empty: t('common.noData'), rows, cols: [
      { label: t('pz.label'), cell: (x) => both(x.label, x.labelEn) }, { label: t('pz.kind'), cell: (x) => t(`pz.kind.${x.kind}`) },
      { label: t('pz.points'), cell: (x) => (x.kind === 'points' ? x.points : '-'), num: true },
      { label: t('pz.chance'), cell: (x) => (x.active === false ? '-' : `${((x.weight / total) * PERCENT).toFixed(1)}%`), num: true },
      ...(rows[0]?.id ? [{ label: t('common.status'), cell: (x) => activeBadge(x.active) }, { label: t('common.actions'), cell: (x) => editBtn(x.id) }] : [])] });
  };

  return {
    guestApp: {
      load: async () => { settings = await get('/api/guest-settings'); return []; },
      add: 'ga.edit',
      view: () => html`<p class="muted">${t('ga.intro')}</p>${dataTable({ caption: t('admin.guestApp'), empty: '', rows: settingsRows(), cols: [
        { label: t('ga.setting'), cell: (x) => x.label }, { label: t('ga.value'), cell: (x) => x.value, num: true }] })}`,
      dialog: () => formDialog({
        title: t('admin.guestApp'), intro: t('ga.intro'),
        fields: [
          ...FEATURES.map((f) => ({ name: f, label: t(`ga.feature.${f}`), type: 'checkbox', value: settings.features[f] })),
          { name: 'pointsPerYuan', label: t('ga.pointsPerYuan'), type: 'int', min: 0, max: 100, value: settings.pointsPerYuan },
          { name: 'referralPoints', label: t('ga.referralPoints'), type: 'int', min: 0, value: settings.referralPoints },
          { name: 'spinCost', label: t('ga.spinCost'), type: 'int', min: 1, value: settings.spinCost },
        ],
        onSubmit: async (v) => {
          await patch('/api/guest-settings', {
            features: Object.fromEntries(FEATURES.map((f) => [f, v[f]])),
            pointsPerYuan: v.pointsPerYuan ?? 0, referralPoints: v.referralPoints ?? 0, spinCost: v.spinCost ?? 1,
          });
          toast(t('ga.saved'), 'success');
          await reload();
        },
      }),
    },
    guestPasswords: {
      load: async () => [],
      add: 'gp.issue',
      view: () => html`<p>${t('gp.intro')}</p><p class="muted">${t('gp.only')}</p>`,
      dialog: () => formDialog({
        title: t('gp.issue'), intro: t('gp.intro'),
        fields: [{ name: 'phone', label: t('gp.phone'), required: true }],
        submit: 'gp.issue',
        onSubmit: async (v) => {
          const r = await post('/api/guest-password-resets', { phone: v.phone });
          // Shown after the form dialog has closed, so the code stays on screen until staff close it.
          setTimeout(() => infoDialog(t('gp.codeFor', { phone: r.phone }),
            html`<p class="reset-code">${r.code}</p><p>${t('gp.tell', { time: fmtDateTime(r.expiresAt) })}</p>`));
        },
      }),
    },
    events: {
      load: () => get('/api/venue-events'),
      add: 'ev.add',
      view: (rows) => dataTable({ caption: t('admin.events'), empty: t('common.noData'), rows, cols: [
        { label: t('ev.title'), cell: (x) => both(x.title, x.titleEn) }, { label: t('ev.starts'), cell: (x) => fmtDateTime(x.startsAt) },
        { label: t('ev.ends'), cell: (x) => fmtDateTime(x.endsAt) }, { label: t('common.status'), cell: (x) => activeBadge(x.active) },
        { label: t('common.actions'), cell: (x) => editBtn(x.id) }] }),
      dialog: (x) => formDialog({
        title: x ? t('common.edit') : t('ev.add'),
        fields: [
          { name: 'title', label: t('ev.title'), required: true, value: x?.title },
          { name: 'titleEn', label: t('ev.titleEn'), value: x?.titleEn },
          { name: 'description', label: t('ev.description'), type: 'textarea', value: x?.description },
          { name: 'startsAt', label: t('ev.starts'), type: 'datetime', required: true, value: x?.startsAt },
          { name: 'endsAt', label: t('ev.ends'), type: 'datetime', required: true, value: x?.endsAt },
          ...(x ? [{ name: 'active', label: t('common.active'), type: 'checkbox', value: x.active }] : []),
        ],
        onSubmit: async (v) => {
          if (x) await patch(`/api/venue-events/${x.id}`, v); else await post('/api/venue-events', v);
          await reload();
        },
      }),
    },
    rewards: {
      load: () => get('/api/loyalty-rewards'),
      add: 'rw.add',
      view: (rows) => dataTable({ caption: t('admin.rewards'), empty: t('common.noData'), rows, cols: [
        { label: t('rw.name'), cell: (x) => both(x.name, x.nameEn) }, { label: t('rw.cost'), cell: (x) => x.cost, num: true },
        { label: t('common.status'), cell: (x) => activeBadge(x.active) }, { label: t('common.actions'), cell: (x) => editBtn(x.id) }] }),
      dialog: (x) => formDialog({
        title: x ? t('common.edit') : t('rw.add'),
        fields: [
          { name: 'name', label: t('rw.name'), required: true, value: x?.name },
          { name: 'nameEn', label: t('rw.nameEn'), value: x?.nameEn },
          { name: 'cost', label: t('rw.cost'), type: 'int', min: 1, required: true, value: x?.cost },
          ...(x ? [{ name: 'active', label: t('common.active'), type: 'checkbox', value: x.active }] : []),
        ],
        onSubmit: async (v) => {
          if (x) await patch(`/api/loyalty-rewards/${x.id}`, v); else await post('/api/loyalty-rewards', v);
          await reload();
        },
      }),
    },
    prizes: {
      load: async () => { const r = await get('/api/spin-prizes'); prizeInfo = r; return r.prizes; },
      add: 'pz.add',
      view: (rows) => html`${prizeTable(rows, t('admin.prizes'))}
        ${prizeInfo.usingDefaults && html`<p class="muted">${t('pz.defaults')}</p>${prizeTable(prizeInfo.defaults, t('admin.prizes'))}`}`,
      dialog: (x) => formDialog({
        title: x ? t('common.edit') : t('pz.add'),
        fields: [
          { name: 'label', label: t('pz.label'), required: true, value: x?.label },
          { name: 'labelEn', label: t('pz.labelEn'), value: x?.labelEn },
          { name: 'kind', label: t('pz.kind'), type: 'select', value: x?.kind ?? 'points', options: PRIZE_KINDS.map((k) => ({ value: k, label: t(`pz.kind.${k}`) })) },
          { name: 'points', label: t('pz.points'), type: 'int', min: 0, value: x?.points ?? 0 },
          { name: 'weight', label: t('pz.weight'), type: 'int', min: 1, required: true, value: x?.weight ?? 10, hint: t('pz.weightHint') },
          ...(x ? [{ name: 'active', label: t('common.active'), type: 'checkbox', value: x.active }] : []),
        ],
        onSubmit: async (v) => {
          if (x) await patch(`/api/spin-prizes/${x.id}`, v); else await post('/api/spin-prizes', v);
          await reload();
        },
      }),
    },
  };
}
