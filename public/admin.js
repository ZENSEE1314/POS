// Admin view: tables, products + stock, commission rules, staff.
import { t, tOr } from './i18n.js';
import { get, post, patch, del, can, app } from './session.js';
import { html, setHtml, fmtMoney, toYuanInput, productName, byId } from './util.js';
import { delegate, formDialog, confirmDialog, dataTable, badge, skeleton, notifyError, pressed } from './ui.js';
import { categoryLabel } from './bill-view.js';
import { printersSection, printerActions } from './print/admin-section.js';
import { showTableQr, showVenueQr } from './table-qr.js';
import { guestAdminSections } from './guest-admin.js';
import { businessAdminSections, visibleSectionIds } from './business-admin.js';
import { hasModule, isWeighed, fmtStock, fmtKg } from './business.js';

const TABLE_KINDS = ['bar', 'booth', 'room'];
const RULE_ROLES = ['sales', 'waiter'];
const BPS_PER_PERCENT = 100;
const SECTION_IDS = ['business', 'tables', 'products', 'promotions', 'rules', 'staff', 'printers', 'guestApp', 'appDesign', 'locations', 'guestPasswords', 'events', 'rewards', 'prizes'];
const STATIONS = ['', 'bar', 'kitchen'];
const UNITS = ['each', 'kg'];
const SECTION_LABELS = { business: 'biz.section', promotions: 'promo.section' };
const MILLI = 1000;
const GRAMS_PER_KG = 1000;
let active = 'tables';

const activeBadge = (on) => (on ? badge(t('common.active'), 'success', '✓') : badge(t('common.inactive'), 'neutral', '—'));
const btn = (action, id, label, cls = 'btn--ghost') => html`<button type="button" class="btn btn--small ${cls}" data-action="${action}" data-id="${id}">${label}</button>`;
const options = (values, labelOf) => values.map((v) => ({ value: v, label: labelOf(v) }));

export function mountAdmin(root) {
  const state = { rows: [], products: [], stores: [] };
  const sectionIds = visibleSectionIds(SECTION_IDS, can('hq.write'));
  if (!sectionIds.includes(active)) active = sectionIds.includes('products') ? 'products' : sectionIds[0];

  const sections = {
    tables: {
      load: () => get('/api/tables?all=1'),
      add: 'admin.addTable',
      view: (rows) => dataTable({ caption: t('admin.tables'), empty: t('common.noData'), rows, cols: [
        { label: t('admin.name'), cell: (x) => x.name }, { label: t('admin.zone'), cell: (x) => x.zone || '-' },
        { label: t('admin.kind'), cell: (x) => tOr(`kind.${x.kind}`, x.kind) }, { label: t('admin.capacity'), cell: (x) => x.capacity, num: true },
        ...(hasModule('minSpend') ? [{ label: t('floor.minSpend'), cell: (x) => fmtMoney(x.min_spend), num: true }, { label: t('floor.tableFee'), cell: (x) => fmtMoney(x.table_fee), num: true }] : []),
        { label: t('common.status'), cell: (x) => activeBadge(x.active) },
        { label: t('common.actions'), cell: (x) => html`<div class="row">${btn('edit', x.id, t('common.edit'))}${x.active && btn('tableQr', x.id, t('admin.qr'))}</div>` }] }),
      dialog: (x) => tableDialog(x),
    },
    products: {
      load: () => get('/api/products?all=1'),
      add: 'admin.addProduct',
      view: (rows) => dataTable({ caption: t('admin.products'), empty: t('common.noData'), rows, cols: [
        { label: t('admin.name'), cell: (x) => html`<strong>${x.name}</strong>${x.name_en && html`<br><span class="muted">${x.name_en}</span>`}` },
        { label: t('admin.category'), cell: (x) => categoryLabel(x.category) },
        ...(hasModule('kitchen') ? [{ label: t('admin.station'), cell: (x) => t(`station.${x.station || 'none'}`) }] : []),
        ...(hasModule('barcode') ? [{ label: t('prod.barcode'), cell: (x) => x.barcode || '-' }] : []),
        { label: t('admin.price'), cell: (x) => (isWeighed(x) ? t('price.perKg', { price: fmtMoney(x.price) }) : fmtMoney(x.price)), num: true },
        { label: t('prod.memberPrice'), cell: (x) => (x.member_price != null ? fmtMoney(x.member_price) : '-'), num: true },
        { label: t('admin.stock'), cell: (x) => (x.track_stock ? fmtStock(x) : '∞'), num: true }, { label: t('common.status'), cell: (x) => activeBadge(x.active) },
        { label: t('common.actions'), cell: (x) => html`<div class="row">${btn('edit', x.id, t('common.edit'))}${x.track_stock && btn('stock', x.id, t('admin.adjustStock'))}</div>` }] }),
      dialog: (x) => productDialog(x),
    },
    rules: {
      load: () => get('/api/commission-rules'),
      add: 'admin.addRule',
      view: (rows) => {
        const products = byId(state.products);
        return dataTable({ caption: t('admin.rules'), empty: t('common.noData'), rows, cols: [
          { label: t('reports.role'), cell: (x) => tOr(`commRole.${x.role}`, x.role) },
          { label: t('admin.appliesTo'), cell: (x) => (x.product_id ? productName(products.get(x.product_id) ?? { name: `#${x.product_id}` }) : x.category ? categoryLabel(x.category) : t('common.all')) },
          { label: t('admin.rate'), cell: (x) => `${x.bps / BPS_PER_PERCENT}%`, num: true }, { label: t('admin.fixed'), cell: (x) => fmtMoney(x.fixed), num: true },
          { label: t('common.actions'), cell: (x) => btn('deleteRule', x.id, t('common.delete'), 'btn--danger') }] });
      },
      dialog: () => ruleDialog(),
    },
    staff: {
      load: () => get('/api/staff'),
      add: null,
      view: (rows) => {
        const stores = byId(state.stores);
        return dataTable({ caption: t('admin.staff'), empty: t('common.noData'), rows, cols: [
          { label: t('admin.name'), cell: (x) => x.name }, { label: t('login.username'), cell: (x) => x.username },
          { label: t('reports.role'), cell: (x) => tOr(`role.${x.role}`, x.role) },
          { label: t('reports.store'), cell: (x) => (x.storeId === null ? t('admin.allStores') : stores.get(x.storeId)?.name ?? (x.storeId === app.actor.storeId ? app.store.name : `#${x.storeId}`)) },
          { label: t('common.status'), cell: (x) => activeBadge(x.active) },
          ...(can('hq.write') ? [{ label: t('common.actions'), cell: (x) => html`<div class="row">${btn('toggleStaff', x.id, x.active ? t('admin.deactivate') : t('admin.activate'), x.active ? 'btn--danger' : 'btn--ghost')}${btn('resetPin', x.id, t('admin.resetPin'))}</div>` }] : [])] });
      },
      dialog: null,
    },
    printers: printersSection(() => reload()),
    ...guestAdminSections(() => reload()),
    ...businessAdminSections(() => reload()),
  };

  const reload = async () => {
    const sec = sections[active];
    state.rows = await sec.load();
    if (active === 'rules') state.products = await get('/api/products?all=1');
    if (active === 'staff' && can('hq.read')) state.stores = await get('/api/hq/stores');
    renderBody();
  };

  function renderBody() {
    const sec = sections[active];
    setHtml(root.querySelector('#ad-body'), html`<div class="view-bar"><h3 class="section-title">${t(SECTION_LABELS[active] ?? `admin.${active}`)}</h3>
      <div class="row">${active === 'tables' && html`<button type="button" class="btn btn--ghost" data-action="venueQr">${t('admin.venueQr')}</button>`}
      ${sec.add && html`<button type="button" class="btn btn--primary" data-action="add">${t(sec.add)}</button>`}</div></div>
      <div class="panel">${sec.view(state.rows)}</div>`);
  }

  const tableDialog = (x) => formDialog({
    title: x ? t('common.edit') : t('admin.addTable'),
    fields: [
      { name: 'name', label: t('admin.name'), required: true, value: x?.name },
      { name: 'zone', label: t('admin.zone'), value: x?.zone },
      ...(x ? [] : [{ name: 'kind', label: t('admin.kind'), type: 'select', options: options(TABLE_KINDS, (k) => t(`kind.${k}`)) }]),
      { name: 'capacity', label: t('admin.capacity'), type: 'int', min: 1, value: x?.capacity ?? 4 },
      ...(hasModule('minSpend') ? [
        { name: 'minSpend', label: t('floor.minSpend'), type: 'money', value: toYuanInput(x?.min_spend ?? 0) },
        { name: 'tableFee', label: t('floor.tableFee'), type: 'money', value: toYuanInput(x?.table_fee ?? 0) }] : []),
      ...(x ? [{ name: 'active', label: t('common.active'), type: 'checkbox', value: x.active }] : []),
    ],
    onSubmit: async (v) => {
      const body = { ...v, minSpend: v.minSpend ?? 0, tableFee: v.tableFee ?? 0 };
      if (x) await patch(`/api/tables/${x.id}`, body); else await post('/api/tables', body);
      await reload();
    },
  });

  /** Quantities typed in the dialog arrive as thousandths: grams for items by weight, pieces x 1000 otherwise. */
  const fromMilli = (unit, milli) => (milli == null ? 0 : unit === 'kg' ? milli : Math.round(milli / MILLI));
  const toQtyInput = (p, n) => (isWeighed(p) ? fmtKg(n) : String(n));

  const productDialog = (x) => formDialog({
    title: x ? t('common.edit') : t('admin.addProduct'),
    fields: [
      { name: 'name', label: t('admin.name'), required: true, value: x?.name },
      { name: 'nameEn', label: t('admin.nameEn'), value: x?.name_en },
      { name: 'category', label: t('admin.category'), value: x?.category, hint: t('admin.categoryHint') },
      ...(hasModule('kitchen') ? [{ name: 'station', label: t('admin.station'), type: 'select', value: x?.station ?? '', hint: t('admin.stationHint'), options: options(STATIONS, (s) => t(`station.${s || 'none'}`)) }] : []),
      ...(hasModule('barcode') ? [
        { name: 'barcode', label: t('prod.barcode'), value: x?.barcode ?? '', hint: t('prod.barcodeHint') },
        { name: 'unit', label: t('prod.unit'), type: 'select', value: x?.unit ?? 'each', hint: x ? t('prod.unitLocked') : '', options: options(UNITS, (u) => t(`unit.${u}`)) }] : []),
      { name: 'price', label: t('admin.price'), type: 'money', required: true, value: x ? toYuanInput(x.price) : '' },
      { name: 'memberPrice', label: t('prod.memberPrice'), type: 'money', hint: t('prod.memberPriceHint'), value: x?.member_price != null ? toYuanInput(x.member_price) : '' },
      ...(hasModule('purchasing') ? [
        { name: 'cost', label: t('prod.cost'), type: 'money', value: toYuanInput(x?.cost ?? 0) },
        { name: 'reorderLevel', label: t('prod.reorder'), type: 'qty', hint: t('prod.reorderHint'), value: x ? toQtyInput(x, x.reorder_level) : '0' }] : []),
      ...(x ? [] : [{ name: 'stock', label: hasModule('barcode') ? t('prod.stockKg') : t('admin.stock'), type: 'qty', value: '0' }]),
      { name: 'trackStock', label: t('admin.trackStock'), type: 'checkbox', value: x?.track_stock ?? true },
      ...(x ? [{ name: 'active', label: t('common.active'), type: 'checkbox', value: x.active }] : []),
    ],
    onSubmit: async (v) => {
      const unit = v.unit ?? x?.unit ?? 'each';
      const body = { ...v, memberPrice: v.memberPrice ?? null };
      if (v.reorderLevel !== undefined) body.reorderLevel = fromMilli(unit, v.reorderLevel);
      if (v.stock !== undefined) body.stock = fromMilli(unit, v.stock);
      if (x) await patch(`/api/products/${x.id}`, body); else await post('/api/products', body);
      await reload();
    },
  });

  const ruleDialog = () => {
    const categories = [...new Set(state.products.map((p) => p.category).filter(Boolean))];
    return formDialog({
      title: t('admin.addRule'),
      intro: t('admin.ruleHint'),
      fields: [
        { name: 'role', label: t('reports.role'), type: 'select', options: options(RULE_ROLES, (r) => t(`commRole.${r}`)) },
        { name: 'category', label: t('admin.category'), type: 'select', options: [{ value: '', label: t('common.all') }, ...options(categories, categoryLabel)] },
        { name: 'productId', label: t('admin.product'), type: 'select', options: [{ value: '', label: t('common.all') }, ...state.products.map((p) => ({ value: p.id, label: productName(p) }))] },
        { name: 'percent', label: t('admin.ratePercent'), type: 'qty', value: '0', hint: t('admin.ratePercentHint') },
        { name: 'fixed', label: t('admin.fixed'), type: 'money', value: '0' },
      ],
      onSubmit: async (v) => {
        await post('/api/commission-rules', {
          role: v.role, category: v.category || undefined, productId: v.productId ? Number(v.productId) : undefined,
          // the 'qty' field yields thousandths of the typed percent
          bps: Math.round((v.percent / 1000) * BPS_PER_PERCENT), fixed: v.fixed ?? 0,
        });
        await reload();
      },
    });
  };

  const stockDialog = (x) => formDialog({
    title: t('admin.stockTitle', { name: productName(x) }),
    intro: t('admin.stockNow', { n: fmtStock(x) }),
    // Items by weight: kg with decimals (kept as grams); others: whole pieces.
    fields: [{ name: 'delta', label: isWeighed(x) ? `${t('admin.delta')} (kg)` : t('admin.delta'), type: isWeighed(x) ? 'text' : 'int', required: true, hint: t('admin.deltaHint') },
      { name: 'reason', label: t('floor.reason'), required: true }],
    submit: 'admin.adjustStock',
    onSubmit: async (v) => {
      const delta = isWeighed(x) ? Math.round(Number(v.delta) * GRAMS_PER_KG) : v.delta;
      if (!Number.isFinite(delta)) throw new Error(t('err.badQty'));
      await post(`/api/products/${x.id}/stock`, { delta, reason: v.reason });
      await reload();
    },
  });

  const rowOf = (el) => state.rows.find((r) => r.id === Number(el.dataset.id));

  const staffToggle = async (el) => {
    const s = rowOf(el);
    if (s.active && !await confirmDialog({ title: t('admin.deactivate'), message: t('admin.deactivateAsk', { name: s.name }), danger: true, submit: 'admin.deactivate' })) return;
    await patch(`/api/staff/${s.id}`, { active: !s.active });
    await reload();
  };

  const resetPin = (el) => {
    const s = rowOf(el);
    return formDialog({
      title: t('admin.resetPin'), intro: s.name, submit: 'admin.resetPin',
      fields: [{ name: 'pin', label: t('admin.newPin'), type: 'pin', required: true }],
      onSubmit: async (v) => { await patch(`/api/staff/${s.id}`, { pin: v.pin }); },
    });
  };

  setHtml(root, html`<section aria-labelledby="ad-title"><h2 id="ad-title" class="view-title">${t('nav.admin')}</h2>
    <div class="chips" role="group" aria-label="${t('nav.admin')}">${sectionIds.map((id) =>
      html`<button type="button" class="chip" data-action="section" data-id="${id}" aria-pressed="${pressed(id === active)}">${t(SECTION_LABELS[id] ?? `admin.${id}`)}</button>`)}</div>
    <div id="ad-body" aria-live="polite">${skeleton(5)}</div></section>`);
  reload().catch(notifyError);

  delegate(root, {
    click: {
      section: (el) => {
        active = el.dataset.id;
        root.querySelectorAll('[data-action=section]').forEach((b) => b.setAttribute('aria-pressed', pressed(b === el)));
        setHtml(root.querySelector('#ad-body'), skeleton(5));
        return reload();
      },
      add: () => sections[active].dialog(),
      edit: (el) => sections[active].dialog(rowOf(el)),
      stock: (el) => stockDialog(rowOf(el)),
      deleteRule: async (el) => {
        if (!await confirmDialog({ title: t('common.delete'), message: t('admin.deleteRuleAsk'), danger: true, submit: 'common.delete' })) return;
        await del(`/api/commission-rules/${el.dataset.id}`);
        await reload();
      },
      tableQr: (el) => showTableQr(rowOf(el), reload),
      venueQr: showVenueQr,
      toggleStaff: staffToggle,
      resetPin,
      ...printerActions({ rowOf, reload }),
      // Sections may bring their own buttons (App design: upload or remove the logo and cover).
      ...Object.assign({}, ...Object.values(sections).map((s) => s.actions ?? {})),
    },
  });
}
