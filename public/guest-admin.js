// Admin sections for the customer app: feature switches and point settings, location details for the app search,
// guest password resets, events, loyalty rewards and the prize wheel.
import { t } from './i18n.js';
import { app, get, post, patch, put, del } from './session.js';
import { html, fmtDateTime } from './util.js';
import { formDialog, dataTable, badge, toast, infoDialog, confirmDialog } from './ui.js';
import { PRESETS, PRESET_IDS, themeVars } from './guest/themes.js';

const LAYOUTS = ['list', 'grid'];
/** Longest side after the browser shrinks an upload; keeps files small enough for the server's limit. */
const IMAGE_EDGE = { logo: 400, cover: 1200 };
const JPEG_QUALITY = 0.82;
const PNG_MIME = 'image/png';

/** Shrinks a picked photo in the browser and returns a data: URL (logos keep transparency as PNG). */
async function shrinkImage(file, kind) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_EDGE[kind] / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return kind === 'logo' && file.type === PNG_MIME ? canvas.toDataURL(PNG_MIME) : canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

const pickFile = () => new Promise((resolve) => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp';
  input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
  input.click();
});

/** Inline custom properties so the preview below shows the company's theme without touching the staff app. */
const previewStyle = (theme) => Object.entries(themeVars(theme).vars).map(([k, v]) => `${k}:${v}`).join(';');

/** A small phone mock-up of the customer app home, drawn with the chosen theme. */
const designPreview = (theme, companyName) => html`<div class="design-preview" style="${previewStyle(theme)}" data-scheme="${themeVars(theme).scheme}" aria-label="${t('ds.preview')}">
  <div class="design-preview__top">${theme.logo ? html`<img src="${theme.logo}" alt="" width="24" height="24">` : html`<span class="design-preview__mark"></span>`}<strong>${companyName}</strong></div>
  <div class="design-preview__cover ${theme.cover ? 'design-preview__cover--photo' : ''}">
    ${theme.cover && html`<img src="${theme.cover}" alt="" width="300" height="150">`}
    <div><small>${t('ds.welcome')}</small><b>${theme.headline || companyName}</b><span>${theme.tagline || t('ds.taglineSample')}</span></div></div>
  <div class="design-preview__tiles ${theme.layout === 'grid' ? 'design-preview__tiles--grid' : ''}">
    ${['ds.sampleMenu', 'ds.sampleBook', 'ds.sampleRewards', 'ds.sampleGames'].map((k) => html`<div class="design-preview__tile"><i></i><span>${t(k)}</span></div>`)}</div>
  <div class="design-preview__btn">${t('ds.sampleButton')}</div></div>`;

const FEATURES = ['service', 'song', 'bottle', 'gift', 'loyalty', 'referral', 'spin', 'events', 'games', 'support', 'bot', 'pets'];
const PRIZE_KINDS = ['none', 'points', 'voucher'];
const PERCENT = 100;

const onOff = (on) => (on ? badge(t('ga.on'), 'success', '✓') : badge(t('ga.off'), 'neutral', '—'));
const activeBadge = (on) => (on ? badge(t('common.active'), 'success', '✓') : badge(t('common.inactive'), 'neutral', '—'));
const editBtn = (id) => html`<button type="button" class="btn btn--small btn--ghost" data-action="edit" data-id="${id}">${t('common.edit')}</button>`;
const both = (zh, en) => (en ? html`${zh}<br><span class="muted">${en}</span>` : zh);

/** Section objects in the shape admin.js uses: load rows, an add button, a table view and an add/edit dialog. */
export function guestAdminSections(reload) {
  let settings = null;
  let theme = null;
  const company = () => app.company ?? { name: '', code: '' };

  const upload = (kind) => async () => {
    const file = await pickFile();
    if (!file) return;
    theme = await put(`/api/guest-theme/images/${kind}`, { dataUrl: await shrinkImage(file, kind) });
    toast(t('ds.uploaded'), 'success');
    await reload();
  };
  const remove = (kind) => async () => {
    if (!await confirmDialog({ title: t(`ds.remove.${kind}`), message: t('ds.removeAsk'), danger: true, submit: 'common.delete' })) return;
    theme = await del(`/api/guest-theme/images/${kind}`);
    await reload();
  };
  let prizeInfo = { usingDefaults: false, defaults: [] };

  const settingsRows = () => [
    { id: 'listed', label: t('ga.listed'), value: onOff(settings.listed) },
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
    appDesign: {
      load: async () => { theme = await get('/api/guest-theme'); return []; },
      add: 'ds.edit',
      actions: {
        dsLogo: upload('logo'), dsCover: upload('cover'), dsRemoveLogo: remove('logo'), dsRemoveCover: remove('cover'),
      },
      view: () => html`<p class="muted">${t('ds.intro')}</p>
        <div class="design">
          ${designPreview(theme, company().name)}
          <div class="design__side">
            ${dataTable({ caption: t('admin.appDesign'), empty: '', rows: [
              { label: t('ds.preset'), value: t(`ds.preset.${theme.preset}`) },
              { label: t('ds.accent'), value: html`<span class="swatch" style="background:${theme.accent || PRESETS[theme.preset]?.accent}"></span> ${theme.accent || t('ds.presetColour')}` },
              { label: t('ds.layout'), value: t(`ds.layout.${theme.layout}`) },
              { label: t('ds.headline'), value: theme.headline || '-' },
              { label: t('ds.tagline'), value: theme.tagline || '-' },
            ], cols: [{ label: t('ga.setting'), cell: (x) => x.label }, { label: t('ga.value'), cell: (x) => x.value }] })}
            <div class="row design__buttons">
              <button type="button" class="btn btn--ghost" data-action="dsLogo">${t(theme.logo ? 'ds.changeLogo' : 'ds.addLogo')}</button>
              ${theme.logo && html`<button type="button" class="btn btn--ghost btn--danger" data-action="dsRemoveLogo">${t('ds.remove.logo')}</button>`}
              <button type="button" class="btn btn--ghost" data-action="dsCover">${t(theme.cover ? 'ds.changeCover' : 'ds.addCover')}</button>
              ${theme.cover && html`<button type="button" class="btn btn--ghost btn--danger" data-action="dsRemoveCover">${t('ds.remove.cover')}</button>`}
              ${company().code && html`<a class="btn btn--ghost" href="/g/${encodeURIComponent(company().code)}" target="_blank" rel="noopener">${t('ds.open')}</a>`}
            </div>
            <p class="hint">${t('ds.imageHint')}</p>
          </div>
        </div>`,
      dialog: () => formDialog({
        title: t('admin.appDesign'), intro: t('ds.intro'),
        fields: [
          { name: 'preset', label: t('ds.preset'), type: 'select', value: theme.preset, options: PRESET_IDS.map((p) => ({ value: p, label: t(`ds.preset.${p}`) })) },
          { name: 'useAccent', label: t('ds.useAccent'), type: 'checkbox', value: Boolean(theme.accent) },
          { name: 'accent', label: t('ds.accent'), type: 'color', value: theme.accent || PRESETS[theme.preset]?.accent, hint: t('ds.accentHint') },
          { name: 'layout', label: t('ds.layout'), type: 'select', value: theme.layout, options: LAYOUTS.map((l) => ({ value: l, label: t(`ds.layout.${l}`) })) },
          { name: 'headline', label: t('ds.headline'), value: theme.headline, placeholder: company().name, hint: t('ds.headlineHint') },
          { name: 'tagline', label: t('ds.tagline'), type: 'textarea', value: theme.tagline, hint: t('ds.taglineHint') },
        ],
        onSubmit: async (v) => {
          theme = await patch('/api/guest-theme', {
            preset: v.preset, accent: v.useAccent ? v.accent : '', layout: v.layout, headline: v.headline, tagline: v.tagline,
          });
          toast(t('ds.saved'), 'success');
          await reload();
        },
      }),
    },
    guestApp: {
      load: async () => { settings = await get('/api/guest-settings'); return []; },
      add: 'ga.edit',
      view: () => html`<p class="muted">${t('ga.intro')}</p>${dataTable({ caption: t('admin.guestApp'), empty: '', rows: settingsRows(), cols: [
        { label: t('ga.setting'), cell: (x) => x.label }, { label: t('ga.value'), cell: (x) => x.value, num: true }] })}`,
      dialog: () => formDialog({
        title: t('admin.guestApp'), intro: t('ga.intro'),
        fields: [
          { name: 'listed', label: t('ga.listed'), type: 'checkbox', value: settings.listed, hint: t('ga.listedHint') },
          ...FEATURES.map((f) => ({ name: f, label: t(`ga.feature.${f}`), type: 'checkbox', value: settings.features[f] })),
          { name: 'pointsPerYuan', label: t('ga.pointsPerYuan'), type: 'int', min: 0, max: 100, value: settings.pointsPerYuan },
          { name: 'referralPoints', label: t('ga.referralPoints'), type: 'int', min: 0, value: settings.referralPoints },
          { name: 'spinCost', label: t('ga.spinCost'), type: 'int', min: 1, value: settings.spinCost },
        ],
        onSubmit: async (v) => {
          await patch('/api/guest-settings', {
            listed: v.listed,
            features: Object.fromEntries(FEATURES.map((f) => [f, v[f]])),
            pointsPerYuan: v.pointsPerYuan ?? 0, referralPoints: v.referralPoints ?? 0, spinCost: v.spinCost ?? 1,
          });
          toast(t('ga.saved'), 'success');
          await reload();
        },
      }),
    },
    locations: {
      load: () => get('/api/hq/stores'),
      add: null,
      view: (rows) => html`<p class="muted">${t('loc.intro')}</p>${dataTable({ caption: t('admin.locations'), empty: t('common.noData'), rows, cols: [
        { label: t('admin.name'), cell: (x) => x.name }, { label: t('loc.city'), cell: (x) => x.city || '-' },
        { label: t('loc.address'), cell: (x) => x.address || '-' }, { label: t('loc.postal'), cell: (x) => x.postalCode || '-' }, { label: t('common.actions'), cell: (x) => editBtn(x.id) }] })}`,
      dialog: (x) => formDialog({
        title: x.name,
        fields: [
          { name: 'city', label: t('loc.city'), value: x.city },
          { name: 'address', label: t('loc.address'), value: x.address },
          { name: 'postalCode', label: t('loc.postal'), value: x.postalCode },
          { name: 'wifiSsid', label: t('loc.wifi'), value: x.wifiSsid, hint: t('loc.wifiHint') },
          { name: 'wifiPassword', label: t('loc.wifiPassword'), value: x.wifiPassword },
        ],
        onSubmit: async (v) => {
          await patch(`/api/hq/stores/${x.id}/location`, { city: v.city ?? '', address: v.address ?? '', postalCode: v.postalCode ?? '', wifiSsid: v.wifiSsid ?? '', wifiPassword: v.wifiPassword ?? '' });
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
