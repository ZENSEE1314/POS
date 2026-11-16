// Admin sections: business type and module switches (owner), and promotions.
import { t } from './i18n.js';
import { app, get, post, patch } from './session.js';
import { html, fmtMoney, fmtDateTime, productName, toYuanInput, byId } from './util.js';
import { formDialog, dataTable, badge, toast } from './ui.js';
import { categoryLabel } from './bill-view.js';
import { BUSINESS_TYPES, MODULES, BUSINESS_CHANGED, hasModule } from './business.js';

const SCALE_MODES = ['price', 'weight'];
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const MILLI_PER_PERCENT = 1000;

const onOff = (on) => (on ? badge(t('ga.on'), 'success', '✓') : badge(t('ga.off'), 'neutral', '—'));
const editBtn = (id) => html`<button type="button" class="btn btn--small btn--ghost" data-action="edit" data-id="${id}">${t('common.edit')}</button>`;

export function businessAdminSections(reload) {
  let biz = null;
  let products = [];

  const appliesTo = (x) => {
    if (x.productId) return productName(byId(products).get(x.productId) ?? { name: `#${x.productId}` });
    return x.category ? categoryLabel(x.category) : t('promo.everything');
  };

  return {
    business: {
      load: async () => { biz = await get('/api/business'); return []; },
      add: 'biz.edit',
      view: () => html`<p class="muted">${t('biz.intro')}</p>${dataTable({ caption: t('biz.section'), empty: '', rows: [
        { label: t('biz.type'), value: t(`biz.type.${biz.type}`) },
        ...MODULES.map((m) => ({ label: t(`biz.mod.${m}`), value: onOff(biz.modules[m]) })),
        ...(biz.modules.barcode ? [{ label: t('biz.scale'), value: t(`biz.scale.${biz.scaleMode}`) }] : []),
      ], cols: [{ label: t('ga.setting'), cell: (x) => x.label }, { label: t('ga.value'), cell: (x) => x.value, num: true }] })}`,
      dialog: () => formDialog({
        title: t('biz.section'), intro: t('biz.typeChangeHint'),
        fields: [
          { name: 'type', label: t('biz.type'), type: 'select', value: biz.type, options: BUSINESS_TYPES.map((x) => ({ value: x, label: t(`biz.type.${x}`) })) },
          ...MODULES.map((m) => ({ name: m, label: t(`biz.mod.${m}`), type: 'checkbox', value: biz.modules[m] })),
          { name: 'scaleMode', label: t('biz.scale'), type: 'select', value: biz.scaleMode, hint: t('biz.scaleHint'), options: SCALE_MODES.map((x) => ({ value: x, label: t(`biz.scale.${x}`) })) },
          { name: 'applyGuestPreset', label: t('biz.applyGuest'), type: 'checkbox', value: false },
        ],
        onSubmit: async (v) => {
          const typeChanged = v.type !== biz.type;
          // A new type starts from its own preset, so the checkboxes (still showing the old set) are not sent with it.
          const next = await patch('/api/business', {
            type: v.type, scaleMode: v.scaleMode, applyGuestPreset: v.applyGuestPreset,
            ...(typeChanged ? {} : { modules: Object.fromEntries(MODULES.map((m) => [m, v[m]])) }),
          });
          app.business = next;
          toast(t('biz.saved'), 'success');
          window.dispatchEvent(new Event(BUSINESS_CHANGED));
        },
      }),
    },
    promotions: {
      load: async () => {
        products = await get('/api/products?all=1');
        return get('/api/promotions');
      },
      add: 'promo.add',
      view: (rows) => html`<p class="muted">${t('promo.intro')}</p>${dataTable({ caption: t('promo.section'), empty: t('common.noData'), rows, cols: [
        { label: t('promo.name'), cell: (x) => x.name }, { label: t('promo.appliesTo'), cell: appliesTo },
        { label: t('promo.offer'), cell: (x) => (x.kind === 'percent' ? `-${x.value}%` : fmtMoney(x.value)), num: true },
        { label: t('promo.starts'), cell: (x) => fmtDateTime(x.startsAt) }, { label: t('promo.ends'), cell: (x) => fmtDateTime(x.endsAt) },
        { label: t('common.status'), cell: (x) => html`${onOff(x.active && x.endsAt > Date.now())} ${x.membersOnly && badge(t('promo.membersOnly'), 'warning')}` },
        { label: t('common.actions'), cell: (x) => editBtn(x.id) }] })}`,
      dialog: (x) => {
        const categories = [...new Set(products.map((p) => p.category).filter(Boolean))];
        const now = Date.now();
        return formDialog({
          title: x ? t('common.edit') : t('promo.add'), intro: t('promo.pickOne'),
          fields: [
            { name: 'name', label: t('promo.name'), required: true, value: x?.name },
            { name: 'productId', label: t('promo.product'), type: 'select', value: x?.productId ?? '', options: [{ value: '', label: '-' }, ...products.map((p) => ({ value: p.id, label: productName(p) }))] },
            { name: 'category', label: t('promo.category'), type: 'select', value: x?.category ?? '', options: [{ value: '', label: '-' }, ...categories.map((c) => ({ value: c, label: categoryLabel(c) }))] },
            { name: 'kind', label: t('promo.kind'), type: 'select', value: x?.kind ?? 'percent', options: ['percent', 'price'].map((k) => ({ value: k, label: t(`promo.kind.${k}`) })) },
            { name: 'percent', label: t('promo.percent'), type: 'qty', value: x?.kind === 'percent' ? String(x.value) : '' },
            { name: 'price', label: t('promo.value'), type: 'money', value: x?.kind === 'price' ? toYuanInput(x.value) : '' },
            { name: 'membersOnly', label: t('promo.membersOnly'), type: 'checkbox', value: x?.membersOnly ?? false },
            { name: 'startsAt', label: t('promo.starts'), type: 'datetime', required: true, value: x?.startsAt ?? now },
            { name: 'endsAt', label: t('promo.ends'), type: 'datetime', required: true, value: x?.endsAt ?? now + WEEK_MS },
            ...(x ? [{ name: 'active', label: t('common.active'), type: 'checkbox', value: x.active }] : []),
          ],
          onSubmit: async (v) => {
            const value = v.kind === 'percent' ? Math.round((v.percent ?? 0) / MILLI_PER_PERCENT) : v.price ?? 0;
            const body = {
              name: v.name, kind: v.kind, value, membersOnly: v.membersOnly, startsAt: v.startsAt, endsAt: v.endsAt,
              productId: v.productId ? Number(v.productId) : null, category: v.category || null,
              ...(x ? { active: v.active } : {}),
            };
            if (x) await patch(`/api/promotions/${x.id}`, body); else await post('/api/promotions', body);
            await reload();
          },
        });
      },
    },
  };
}

/** Which admin sections this company sees, given its modules and the signed-in role. */
export function visibleSectionIds(all, canWriteHq) {
  const need = { tables: 'tables', rules: 'reps', promotions: 'promotions', guestApp: 'guestApp', guestPasswords: 'guestApp', events: 'guestApp', rewards: 'guestApp', prizes: 'guestApp' };
  // Business type and location details are company-wide, so only those who can edit the whole company see them.
  return all.filter((id) => (id === 'business' || id === 'locations' ? canWriteHq : !need[id] || hasModule(need[id])));
}
