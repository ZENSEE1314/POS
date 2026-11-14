// Stock view: items below their reorder level, purchase orders (draft -> ordered -> received) and suppliers.
import { t } from './i18n.js';
import { get, post, patch } from './session.js';
import { html, setHtml, fmtMoney, fmtDateTime, productName, toYuanInput } from './util.js';
import { delegate, formDialog, confirmDialog, dataTable, badge, skeleton, notifyError, pressed, toast } from './ui.js';
import { isWeighed, fmtStock, fmtKg } from './business.js';

const SECTIONS = ['low', 'orders', 'suppliers'];
const PO_ROWS = 8;
const MILLI = 1000;
const STATUS_TONE = { draft: 'neutral', ordered: 'warning', received: 'success', cancelled: 'neutral' };
let active = 'low';

const btn = (action, id, label, cls = 'btn--ghost') => html`<button type="button" class="btn btn--small ${cls}" data-action="${action}" data-id="${id}">${label}</button>`;

/** The dialog's qty field reads thousandths: grams for items by weight, so pieces are that value / 1000. */
const toQty = (product, milli) => (isWeighed(product) ? milli : Math.round(milli / MILLI));
const qtyInput = (product, qty) => (isWeighed(product) ? fmtKg(qty) : String(qty));
const fmtQty = (unit, qty) => (unit === 'kg' ? `${fmtKg(qty)} kg` : String(qty));

export function mountStock(root) {
  const state = { rows: [], products: [], suppliers: [] };

  const views = {
    low: () => dataTable({ caption: t('stock.low'), empty: t('stock.noLow'), rows: state.rows, cols: [
      { label: t('stock.item'), cell: (x) => productName({ name: x.name, name_en: x.nameEn }) },
      { label: t('stock.onHand'), cell: (x) => fmtStock(x), num: true },
      { label: t('stock.reorder'), cell: (x) => fmtStock(x, x.reorderLevel), num: true },
      { label: t('stock.suggest'), cell: (x) => fmtStock(x, x.suggest), num: true }] }),
    orders: () => dataTable({ caption: t('stock.orders'), empty: t('common.noData'), rows: state.rows, cols: [
      { label: t('po.id'), cell: (x) => `#${x.id}` }, { label: t('po.supplier'), cell: (x) => x.supplierName },
      { label: t('po.items'), cell: (x) => x.lines.map((l) => `${productName({ name: l.name, name_en: l.nameEn })} × ${fmtQty(l.unit, l.receivedQty ?? l.qty)}`).join(', ') },
      { label: t('po.total'), cell: (x) => fmtMoney(x.total), num: true }, { label: t('po.created'), cell: (x) => fmtDateTime(x.createdAt) },
      { label: t('common.status'), cell: (x) => badge(t(`po.status.${x.status}`), STATUS_TONE[x.status]) },
      { label: t('common.actions'), cell: (x) => html`<div class="row">
        ${x.status === 'draft' && btn('markOrdered', x.id, t('po.markOrdered'))}
        ${(x.status === 'draft' || x.status === 'ordered') && btn('receive', x.id, t('po.receive'), 'btn--primary')}
        ${(x.status === 'draft' || x.status === 'ordered') && btn('cancelPo', x.id, t('po.cancel'), 'btn--danger')}</div>` }] }),
    suppliers: () => dataTable({ caption: t('stock.suppliers'), empty: t('common.noData'), rows: state.rows, cols: [
      { label: t('sup.name'), cell: (x) => x.name }, { label: t('sup.contact'), cell: (x) => x.contact || '-' },
      { label: t('sup.phone'), cell: (x) => x.phone || '-' }, { label: t('sup.note'), cell: (x) => x.note || '-' },
      { label: t('common.status'), cell: (x) => (x.active ? badge(t('common.active'), 'success', '✓') : badge(t('common.inactive'), 'neutral', '—')) },
      { label: t('common.actions'), cell: (x) => btn('editSupplier', x.id, t('common.edit')) }] }),
  };
  const loaders = { low: () => get('/api/low-stock'), orders: () => get('/api/purchase-orders'), suppliers: () => get('/api/suppliers') };
  const addButtons = {
    low: html`<button type="button" class="btn btn--primary" data-action="orderLow">${t('stock.orderLow')}</button>`,
    orders: html`<button type="button" class="btn btn--primary" data-action="newPo">${t('po.new')}</button>`,
    suppliers: html`<button type="button" class="btn btn--primary" data-action="editSupplier">${t('sup.add')}</button>`,
  };

  async function reload() {
    state.rows = await loaders[active]();
    setHtml(root.querySelector('#st-body'), html`<div class="view-bar"><h3 class="section-title">${t(`stock.${active}`)}</h3>
      <div class="row">${addButtons[active]}</div></div><div class="panel">${views[active]()}</div>`);
  }

  const supplierDialog = (x) => formDialog({
    title: x ? t('common.edit') : t('sup.add'),
    fields: [
      { name: 'name', label: t('sup.name'), required: true, value: x?.name },
      { name: 'contact', label: t('sup.contact'), value: x?.contact },
      { name: 'phone', label: t('sup.phone'), type: 'tel', value: x?.phone },
      { name: 'note', label: t('sup.note'), type: 'textarea', value: x?.note },
      ...(x ? [{ name: 'active', label: t('common.active'), type: 'checkbox', value: x.active }] : []),
    ],
    onSubmit: async (v) => {
      if (x) await patch(`/api/suppliers/${x.id}`, v); else await post('/api/suppliers', v);
      await reload();
    },
  });

  /** prefill: [{ productId, qty, unitCost }] for the first rows (from low stock). */
  async function poDialog(prefill = []) {
    const [products, suppliers] = await Promise.all([get('/api/products?all=1'), get('/api/suppliers')]);
    const live = suppliers.filter((s) => s.active);
    if (!live.length) { toast(t('sup.none'), 'error'); return; }
    const byIdMap = new Map(products.map((p) => [p.id, p]));
    const productOptions = [{ value: '', label: t('po.none') }, ...products.filter((p) => p.track_stock).map((p) => ({ value: p.id, label: productName(p) }))];
    const rows = Math.max(PO_ROWS, prefill.length);
    const fields = [
      { name: 'supplierId', label: t('po.supplier'), type: 'select', required: true, options: live.map((s) => ({ value: s.id, label: s.name })) },
      ...Array.from({ length: rows }, (_, i) => {
        const pre = prefill[i];
        const p = pre && byIdMap.get(pre.productId);
        return [
          { name: `p${i}`, label: t('po.line', { n: i + 1 }), type: 'select', value: pre?.productId ?? '', options: productOptions },
          { name: `q${i}`, label: t('po.qty', { n: i + 1 }), type: 'qty', value: pre ? qtyInput(p, pre.qty) : '', hint: i === 0 ? t('po.qtyHint') : '' },
          { name: `c${i}`, label: t('po.cost', { n: i + 1 }), type: 'money', value: pre ? toYuanInput(pre.unitCost) : '' },
        ];
      }).flat(),
      { name: 'note', label: t('po.note'), type: 'textarea' },
    ];
    await formDialog({
      title: t('po.new'), fields, submit: 'common.create',
      onSubmit: async (v) => {
        const lines = [];
        for (let i = 0; i < rows; i += 1) {
          if (!v[`p${i}`]) continue;
          const p = byIdMap.get(Number(v[`p${i}`]));
          lines.push({ productId: p.id, qty: toQty(p, v[`q${i}`]), unitCost: v[`c${i}`] ?? p.cost ?? 0 });
        }
        if (!lines.length) throw new Error(t('po.needLine'));
        await post('/api/purchase-orders', { supplierId: Number(v.supplierId), note: v.note, lines });
        toast(t('po.createdToast'), 'success');
        active = 'orders';
        markActive();
        await reload();
      },
    });
  }

  const receiveDialog = (po) => formDialog({
    title: t('po.receiveTitle', { id: po.id }), intro: t('po.receiveIntro'), submit: 'po.receive',
    fields: po.lines.map((l) => ({ name: `l${l.id}`, label: t('po.got', { name: productName({ name: l.name, name_en: l.nameEn }), qty: fmtQty(l.unit, l.qty) }),
      type: 'qty', required: true, value: qtyInput(l, l.qty) })),
    onSubmit: async (v) => {
      const received = Object.fromEntries(po.lines.map((l) => [l.id, toQty(l, v[`l${l.id}`])]));
      await post(`/api/purchase-orders/${po.id}/receive`, { received });
      toast(t('po.received'), 'success');
      await reload();
    },
  });

  const rowOf = (el) => state.rows.find((r) => r.id === Number(el.dataset.id));
  const markActive = () => root.querySelectorAll('[data-action=section]').forEach((b) => b.setAttribute('aria-pressed', pressed(b.dataset.id === active)));

  setHtml(root, html`<section aria-labelledby="st-title"><h2 id="st-title" class="view-title">${t('stock.title')}</h2>
    <div class="chips" role="group" aria-label="${t('stock.title')}">${SECTIONS.map((id) =>
      html`<button type="button" class="chip" data-action="section" data-id="${id}" aria-pressed="${pressed(id === active)}">${t(`stock.${id}`)}</button>`)}</div>
    <div id="st-body" aria-live="polite">${skeleton(5)}</div></section>`);
  reload().catch(notifyError);

  delegate(root, {
    click: {
      section: (el) => {
        active = el.dataset.id;
        markActive();
        setHtml(root.querySelector('#st-body'), skeleton(5));
        return reload();
      },
      editSupplier: (el) => supplierDialog(el.dataset.id ? rowOf(el) : null),
      newPo: () => poDialog(),
      orderLow: () => poDialog(state.rows.map((r) => ({ productId: r.id, qty: r.suggest, unitCost: r.cost }))),
      markOrdered: async (el) => { await post(`/api/purchase-orders/${el.dataset.id}/order`); await reload(); },
      receive: (el) => receiveDialog(rowOf(el)),
      cancelPo: async (el) => {
        if (!await confirmDialog({ title: t('po.cancel'), message: t('po.cancelAsk'), danger: true, submit: 'po.cancel' })) return;
        await post(`/api/purchase-orders/${el.dataset.id}/cancel`);
        await reload();
      },
    },
  });
}
