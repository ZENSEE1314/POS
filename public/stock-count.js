// Stock tab sections: stocktakes (盘点: count the shelf, then stock moves by counted − expected) and transfers
// between stores (调拨: stock leaves here at once and arrives when the other store confirms it).
import { t, addStrings } from './i18n.js';
import { app, get, post, patch } from './session.js';
import { html, setHtml, fmtMoney, fmtDateTime, productName } from './util.js';
import { delegate, formDialog, confirmDialog, dataTable, badge, skeleton, toast } from './ui.js';

const TRANSFER_ROWS = 6;
const STATUS_TONE = { open: 'warning', closed: 'success', cancelled: 'neutral', sent: 'warning', received: 'success' };
const WHOLE_NUMBER = /^\d+$/;

addStrings({
  en: {
    'stock.stocktake': 'Stocktake', 'stock.transfers': 'Transfers',
    'stk.start': 'Start a stocktake', 'stk.startIntro': 'Takes a snapshot of every tracked item. Sales during the count are kept: stock moves by counted − expected.',
    'stk.note': 'Note (optional)', 'stk.continue': 'Continue the open stocktake', 'stk.open': 'Open', 'stk.view': 'View', 'stk.id': 'No.',
    'stk.created': 'Started', 'stk.by': 'By', 'stk.lines': 'Items', 'stk.differences': 'Differences', 'stk.none': 'No stocktakes yet.',
    'stk.status.open': 'Counting', 'stk.status.closed': 'Done', 'stk.status.cancelled': 'Cancelled',
    'stk.back': 'All stocktakes', 'stk.sheet': 'Stocktake #{id}', 'stk.search': 'Find an item', 'stk.searchPh': 'Name or category',
    'stk.item': 'Item', 'stk.expected': 'Expected', 'stk.counted': 'Counted', 'stk.diff': 'Difference', 'stk.costDiff': 'Cost difference',
    'stk.grams': 'grams', 'stk.pieces': 'pcs', 'stk.countLabel': 'Counted {name} ({unit})', 'stk.save': 'Save counts', 'stk.saved': 'Counts saved.',
    'stk.close': 'Finish stocktake', 'stk.cancel': 'Cancel stocktake', 'stk.cancelAsk': 'Throw this stocktake away? Stock is not changed.',
    'stk.closeAsk': '{counted} of {total} items counted, {n} with a difference. Cost difference {cost}. Stock is adjusted for counted items only and this cannot be undone.',
    'stk.closed': 'Stocktake finished: {n} items adjusted.', 'stk.badCount': 'Enter a whole number (0 or more), or leave it empty.',
    'stk.summary': '{counted} / {total} counted · {n} differences · cost {cost}', 'stk.uncategorised': 'Other', 'stk.kgHint': 'Items sold by weight are counted in grams.',
    'stk.noMatch': 'No items match.',
    'tr.send': 'Send stock', 'tr.sendIntro': 'Stock leaves this store now and is added to the other store when they confirm receipt.',
    'tr.to': 'To store',
    'tr.line': 'Item {n}', 'tr.qty': 'Quantity {n}', 'tr.qtyHint': 'Whole pieces; items by weight in grams.', 'tr.none': '—', 'tr.note': 'Note (optional)',
    'tr.needLine': 'Add at least one item with a quantity.', 'tr.sent': 'Transfer sent.', 'tr.id': 'No.', 'tr.route': 'From → to', 'tr.items': 'Items',
    'tr.created': 'Sent', 'tr.receive': 'Receive', 'tr.cancel': 'Take back', 'tr.received': 'Stock received.',
    'tr.receiveAsk': 'Confirm that these items arrived? They are added to this store\'s stock.', 'tr.cancelAsk': 'Take this transfer back? The stock returns to this store.',
    'tr.status.sent': 'On the way', 'tr.status.received': 'Received', 'tr.status.cancelled': 'Taken back', 'tr.incoming': 'Incoming', 'tr.outgoing': 'Outgoing',
    'tr.empty': 'No transfers yet.',
  },
  zh: {
    'stock.stocktake': '盘点', 'stock.transfers': '调拨',
    'stk.start': '开始盘点', 'stk.startIntro': '系统会记录所有计库存商品的当前数量。盘点期间的销售不受影响：库存按“实盘 − 账面”调整。',
    'stk.note': '备注（选填）', 'stk.continue': '继续进行中的盘点', 'stk.open': '继续', 'stk.view': '查看', 'stk.id': '单号',
    'stk.created': '开始时间', 'stk.by': '操作人', 'stk.lines': '商品数', 'stk.differences': '差异数', 'stk.none': '还没有盘点记录。',
    'stk.status.open': '盘点中', 'stk.status.closed': '已完成', 'stk.status.cancelled': '已取消',
    'stk.back': '全部盘点单', 'stk.sheet': '盘点单 #{id}', 'stk.search': '查找商品', 'stk.searchPh': '名称或分类',
    'stk.item': '商品', 'stk.expected': '账面', 'stk.counted': '实盘', 'stk.diff': '差异', 'stk.costDiff': '成本差额',
    'stk.grams': '克', 'stk.pieces': '件', 'stk.countLabel': '{name} 实盘（{unit}）', 'stk.save': '保存', 'stk.saved': '已保存。',
    'stk.close': '完成盘点', 'stk.cancel': '取消盘点', 'stk.cancelAsk': '确定作废这次盘点？库存不会改变。',
    'stk.closeAsk': '已盘 {counted} / {total} 个商品，其中 {n} 个有差异，成本差额 {cost}。只调整已盘商品的库存，完成后无法撤销。',
    'stk.closed': '盘点完成：已调整 {n} 个商品。', 'stk.badCount': '请输入 0 或正整数，或留空。',
    'stk.summary': '已盘 {counted} / {total} · 差异 {n} 个 · 成本 {cost}', 'stk.uncategorised': '其他', 'stk.kgHint': '称重商品按克盘点。',
    'stk.noMatch': '没有匹配的商品。',
    'tr.send': '发起调拨', 'tr.sendIntro': '库存立即从本店扣除，对方门店确认收货后入库。',
    'tr.to': '调入门店',
    'tr.line': '商品 {n}', 'tr.qty': '数量 {n}', 'tr.qtyHint': '按件填写；称重商品按克填写。', 'tr.none': '—', 'tr.note': '备注（选填）',
    'tr.needLine': '请至少填写一个商品和数量。', 'tr.sent': '调拨单已发出。', 'tr.id': '单号', 'tr.route': '调出 → 调入', 'tr.items': '商品',
    'tr.created': '发出时间', 'tr.receive': '确认收货', 'tr.cancel': '撤回', 'tr.received': '已收货入库。',
    'tr.receiveAsk': '确认这些商品已到店？将计入本店库存。', 'tr.cancelAsk': '撤回这张调拨单？库存将退回本店。',
    'tr.status.sent': '在途', 'tr.status.received': '已收货', 'tr.status.cancelled': '已撤回', 'tr.incoming': '调入', 'tr.outgoing': '调出',
    'tr.empty': '还没有调拨记录。',
  },
});

const isKg = (line) => line.unit === 'kg';
const unitLabel = (line) => t(isKg(line) ? 'stk.grams' : 'stk.pieces');
const signed = (n) => (n > 0 ? `+${n}` : String(n));

/** Mounts into a fresh child of `el`, so its listeners go away with it when the Stock tab switches sections. */
function freshHost(el) {
  setHtml(el, html`<div></div>`);
  return el.firstElementChild;
}

// ---------- stocktakes ----------

export async function mountStocktakes(el) {
  const host = freshHost(el);
  let sheet = null;
  const edits = new Map();

  async function showList() {
    sheet = null;
    edits.clear();
    setHtml(host, skeleton(4));
    const list = await get('/api/stocktakes');
    const open = list.find((s) => s.status === 'open');
    setHtml(host, html`<div class="view-bar"><h3 class="section-title">${t('stock.stocktake')}</h3>
      <div class="row">${open
        ? html`<button type="button" class="btn btn--primary" data-action="stkOpen" data-id="${open.id}">${t('stk.continue')}</button>`
        : html`<button type="button" class="btn btn--primary" data-action="stkStart">${t('stk.start')}</button>`}</div></div>
      <div class="panel">${dataTable({ caption: t('stock.stocktake'), empty: t('stk.none'), rows: list, cols: [
        { label: t('stk.id'), cell: (s) => `#${s.id}` }, { label: t('stk.created'), cell: (s) => fmtDateTime(s.createdAt) },
        { label: t('stk.by'), cell: (s) => s.createdBy }, { label: t('stk.lines'), cell: (s) => s.lines, num: true },
        { label: t('stk.differences'), cell: (s) => s.differences, num: true }, { label: t('stk.note'), cell: (s) => s.note || '-' },
        { label: t('common.status'), cell: (s) => badge(t(`stk.status.${s.status}`), STATUS_TONE[s.status]) },
        { label: t('common.actions'), cell: (s) => html`<button type="button" class="btn btn--small btn--ghost" data-action="stkOpen" data-id="${s.id}">${t(s.status === 'open' ? 'stk.open' : 'stk.view')}</button>` }] })}</div>`);
  }

  const countedOf = (line) => (edits.has(line.productId) ? edits.get(line.productId) : line.counted);

  function summaryHtml() {
    const counted = sheet.lines.filter((l) => Number.isFinite(countedOf(l)));
    const differences = counted.filter((l) => countedOf(l) !== l.expected).length;
    return t('stk.summary', { counted: counted.length, total: sheet.lines.length, n: differences, cost: fmtMoney(sheet.costDiff) });
  }

  const diffHtml = (line) => {
    const counted = countedOf(line);
    if (counted === null || Number.isNaN(counted)) return html`<span class="muted">—</span>`;
    const diff = counted - line.expected;
    return html`<span class="st-diff ${diff < 0 ? 'st-diff--neg' : diff > 0 ? 'st-diff--pos' : ''}">${signed(diff)}</span>`;
  };

  function sheetRow(line, isOpen) {
    const counted = countedOf(line);
    const label = t('stk.countLabel', { name: line.name, unit: unitLabel(line) });
    return html`<tr data-row="${line.productId}" data-search="${`${line.name} ${line.category ?? ''}`.toLowerCase()}">
      <td>${line.name}</td><td class="num">${line.expected} <span class="muted">${unitLabel(line)}</span></td>
      <td class="num">${isOpen
        ? html`<input class="st-count" type="text" inputmode="numeric" aria-label="${label}" data-action="stkCount" data-id="${line.productId}" value="${counted ?? ''}" autocomplete="off">`
        : html`${counted ?? '—'}`}</td>
      <td class="num" data-diff>${diffHtml(line)}</td>
      <td class="num">${line.costDiff === null ? '—' : fmtMoney(line.costDiff)}</td></tr>`;
  }

  function sheetHtml() {
    const isOpen = sheet.status === 'open';
    const groups = new Map();
    for (const l of sheet.lines) {
      const cat = l.category || t('stk.uncategorised');
      groups.set(cat, [...(groups.get(cat) ?? []), l]);
    }
    return html`<div class="view-bar"><h3 class="section-title">${t('stk.sheet', { id: sheet.id })} ${badge(t(`stk.status.${sheet.status}`), STATUS_TONE[sheet.status])}</h3>
      <div class="row"><button type="button" class="btn btn--ghost" data-action="stkBack">${t('stk.back')}</button>
      ${isOpen && html`<button type="button" class="btn btn--ghost" data-action="stkSave">${t('stk.save')}</button>
        <button type="button" class="btn btn--primary" data-action="stkClose">${t('stk.close')}</button>
        <button type="button" class="btn btn--danger" data-action="stkCancel">${t('stk.cancel')}</button>`}</div></div>
      <p class="muted" id="stk-summary" role="status" aria-live="polite">${summaryHtml()}</p>
      ${sheet.lines.some(isKg) && html`<p class="hint">${t('stk.kgHint')}</p>`}
      <div class="panel"><div class="field"><label for="stk-q">${t('stk.search')}</label>
        <input id="stk-q" type="search" data-action="stkSearch" placeholder="${t('stk.searchPh')}" autocomplete="off"></div>
        <p class="muted" id="stk-nomatch" hidden>${t('stk.noMatch')}</p>
        <div class="table-wrap" tabindex="0" role="region" aria-label="${t('stk.sheet', { id: sheet.id })}"><table class="data">
          <thead><tr><th scope="col">${t('stk.item')}</th><th scope="col" class="num">${t('stk.expected')}</th><th scope="col" class="num">${t('stk.counted')}</th>
            <th scope="col" class="num">${t('stk.diff')}</th><th scope="col" class="num">${t('stk.costDiff')}</th></tr></thead>
          ${[...groups].map(([cat, lines]) => html`<tbody data-group><tr class="st-group"><th scope="rowgroup" colspan="5">${cat}</th></tr>
            ${lines.map((l) => sheetRow(l, isOpen))}</tbody>`)}
        </table></div></div>`;
  }

  async function showSheet(id) {
    setHtml(host, skeleton(6));
    sheet = await get(`/api/stocktakes/${id}`);
    edits.clear();
    setHtml(host, sheetHtml());
  }

  function readCount(input) {
    const text = input.value.trim();
    const valid = text === '' || WHOLE_NUMBER.test(text);
    input.setAttribute('aria-invalid', valid ? 'false' : 'true');
    input.title = valid ? '' : t('stk.badCount');
    if (!valid) return Number.NaN;
    return text === '' ? null : Number(text);
  }

  async function saveEdits() {
    if ([...edits.values()].some((v) => Number.isNaN(v))) throw new Error(t('stk.badCount'));
    if (edits.size) await patch(`/api/stocktakes/${sheet.id}`, { counts: Object.fromEntries(edits) });
    await showSheet(sheet.id);
  }

  function filterRows(query) {
    const q = query.trim().toLowerCase();
    let shown = 0;
    for (const group of host.querySelectorAll('[data-group]')) {
      let inGroup = 0;
      for (const row of group.querySelectorAll('[data-row]')) {
        row.hidden = Boolean(q) && !row.dataset.search.includes(q);
        if (!row.hidden) inGroup += 1;
      }
      group.hidden = inGroup === 0;
      shown += inGroup;
    }
    host.querySelector('#stk-nomatch').hidden = shown > 0;
  }

  delegate(host, {
    click: {
      stkStart: () => formDialog({
        title: t('stk.start'), intro: t('stk.startIntro'), submit: 'stk.start',
        fields: [{ name: 'note', label: t('stk.note') }],
        onSubmit: async (v) => {
          const { stocktakeId } = await post('/api/stocktakes', v);
          await showSheet(stocktakeId);
        },
      }),
      stkOpen: (b) => showSheet(Number(b.dataset.id)),
      stkBack: showList,
      stkSave: async () => { await saveEdits(); toast(t('stk.saved'), 'success'); },
      stkClose: async () => {
        await saveEdits();
        const counted = sheet.lines.filter((l) => l.counted !== null);
        const message = t('stk.closeAsk', {
          counted: counted.length, total: sheet.lines.length, n: counted.filter((l) => l.diff !== 0).length, cost: fmtMoney(sheet.costDiff),
        });
        if (!await confirmDialog({ title: t('stk.close'), message, submit: 'stk.close' })) return;
        const { adjusted } = await post(`/api/stocktakes/${sheet.id}/close`);
        toast(t('stk.closed', { n: adjusted }), 'success');
        await showList();
      },
      stkCancel: async () => {
        if (!await confirmDialog({ title: t('stk.cancel'), message: t('stk.cancelAsk'), submit: 'stk.cancel', danger: true })) return;
        await post(`/api/stocktakes/${sheet.id}/cancel`);
        await showList();
      },
    },
    input: {
      stkCount: (input) => {
        const line = sheet.lines.find((l) => l.productId === Number(input.dataset.id));
        edits.set(line.productId, readCount(input));
        setHtml(input.closest('tr').querySelector('[data-diff]'), diffHtml(line));
        host.querySelector('#stk-summary').textContent = summaryHtml();
      },
      stkSearch: (input) => filterRows(input.value),
    },
  });
  await showList();
}

// ---------- transfers ----------

/** Other stores of this company, to send stock to. */
export async function otherStores() {
  const stores = await get('/api/stores');
  return { count: stores.length, choices: stores.filter((s) => Number(s.id) !== app.actor.storeId) };
}

export async function mountTransfers(el) {
  const host = freshHost(el);
  let rows = [];

  async function reload() {
    rows = await get('/api/stock-transfers');
    setHtml(host, html`<div class="view-bar"><h3 class="section-title">${t('stock.transfers')}</h3>
      <div class="row"><button type="button" class="btn btn--primary" data-action="trSend">${t('tr.send')}</button></div></div>
      <div class="panel">${dataTable({ caption: t('stock.transfers'), empty: t('tr.empty'), rows, cols: [
        { label: t('tr.id'), cell: (x) => html`#${x.id} ${badge(t(x.incoming ? 'tr.incoming' : 'tr.outgoing'), 'neutral', x.incoming ? '↓' : '↑')}` },
        { label: t('tr.route'), cell: (x) => `${x.from.name} → ${x.to.name}` },
        { label: t('tr.items'), cell: (x) => x.items.map((i) => `${i.name} × ${i.qty}`).join(', ') },
        { label: t('tr.created'), cell: (x) => html`${fmtDateTime(x.createdAt)}<br><span class="muted">${x.createdBy}</span>` },
        { label: t('tr.note'), cell: (x) => x.note || '-' },
        { label: t('common.status'), cell: (x) => badge(t(`tr.status.${x.status}`), STATUS_TONE[x.status]) },
        { label: t('common.actions'), cell: (x) => (x.status !== 'sent' ? '' : x.incoming
          ? html`<button type="button" class="btn btn--small btn--primary" data-action="trReceive" data-id="${x.id}">${t('tr.receive')}</button>`
          : html`<button type="button" class="btn btn--small btn--danger" data-action="trCancel" data-id="${x.id}">${t('tr.cancel')}</button>`) }] })}</div>`);
  }

  async function sendDialog() {
    const [products, stores] = await Promise.all([get('/api/products?all=1'), otherStores()]);
    const stocked = products.filter((p) => p.active && p.track_stock);
    const productOptions = [{ value: '', label: t('tr.none') }, ...stocked.map((p) => ({ value: p.id, label: productName(p) }))];
    const destination = { name: 'to', label: t('tr.to'), type: 'select', required: true, options: stores.choices.map((s) => ({ value: s.id, label: s.name })) };
    await formDialog({
      title: t('tr.send'), intro: t('tr.sendIntro'), submit: 'tr.send',
      fields: [
        destination,
        ...Array.from({ length: TRANSFER_ROWS }, (_, i) => [
          { name: `p${i}`, label: t('tr.line', { n: i + 1 }), type: 'select', options: productOptions },
          { name: `q${i}`, label: t('tr.qty', { n: i + 1 }), type: 'int', min: 1, hint: i === 0 ? t('tr.qtyHint') : '' },
        ]).flat(),
        { name: 'note', label: t('tr.note'), type: 'textarea' },
      ],
      onSubmit: async (v) => {
        const items = Array.from({ length: TRANSFER_ROWS }, (_, i) => ({ productId: Number(v[`p${i}`]), qty: v[`q${i}`] }))
          .filter((x) => x.productId && x.qty);
        if (!items.length) throw new Error(t('tr.needLine'));
        await post('/api/stock-transfers', { toStoreId: Number(v.to), items, note: v.note });
        toast(t('tr.sent'), 'success');
        await reload();
      },
    });
  }

  delegate(host, {
    click: {
      trSend: sendDialog,
      trReceive: async (b) => {
        if (!await confirmDialog({ title: t('tr.receive'), message: t('tr.receiveAsk'), submit: 'tr.receive' })) return;
        await post(`/api/stock-transfers/${b.dataset.id}/receive`);
        toast(t('tr.received'), 'success');
        await reload();
      },
      trCancel: async (b) => {
        if (!await confirmDialog({ title: t('tr.cancel'), message: t('tr.cancelAsk'), submit: 'tr.cancel', danger: true })) return;
        await post(`/api/stock-transfers/${b.dataset.id}/cancel`);
        await reload();
      },
    },
  });
  setHtml(host, skeleton(4));
  await reload();
}
