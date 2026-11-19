// Stash tab, managers only: bottles past their keep-until date that nobody collected (过期存酒), which the venue takes
// back (充公). Full bottles can go back on the shelf as stock; opened ones are only written off.
import { t, addStrings } from './i18n.js';
import { get, post } from './session.js';
import { html, setHtml, fmtDate, fmtBottles } from './util.js';
import { delegate, confirmDialog, emptyState, skeleton, toast } from './ui.js';

addStrings({
  en: {
    'forfeit.title': 'Expired bottles', 'forfeit.intro': 'Bottles past their keep-until date that nobody collected. Forfeiting them cannot be undone.',
    'forfeit.none': 'No expired bottles.', 'forfeit.all': 'Select all', 'forfeit.pick': 'Select {code}', 'forfeit.toStock': 'Put full bottles back into stock',
    'forfeit.toStockHint': 'Opened bottles are written off either way.', 'forfeit.go': 'Forfeit selected ({n})', 'forfeit.expired': 'Expired',
    'forfeit.ask': 'Forfeit {n} bottles? The guests lose them and this cannot be undone.', 'forfeit.askStock': 'Full bottles go back into stock.',
    'forfeit.done': '{n} forfeited, {r} returned to stock.', 'forfeit.needPick': 'Select at least one bottle.', 'forfeit.confirm': 'Forfeit',
  },
  zh: {
    'forfeit.title': '过期存酒 / 充公', 'forfeit.intro': '已过保管期且无人取走的存酒。充公后无法撤销。',
    'forfeit.none': '没有过期存酒。', 'forfeit.all': '全选', 'forfeit.pick': '选择 {code}', 'forfeit.toStock': '整瓶放回库存',
    'forfeit.toStockHint': '已开瓶的酒只做报损。', 'forfeit.go': '充公所选（{n}）', 'forfeit.expired': '过期日',
    'forfeit.ask': '确定充公 {n} 瓶存酒？客人将失去这些存酒，且无法撤销。', 'forfeit.askStock': '未开瓶的整瓶会放回库存。',
    'forfeit.done': '已充公 {n} 瓶，放回库存 {r} 瓶。', 'forfeit.needPick': '请至少选择一瓶。', 'forfeit.confirm': '充公',
  },
});

const row = (s) => html`<tr>
  <td><label class="check"><input type="checkbox" name="forfeitId" value="${s.id}" aria-label="${t('forfeit.pick', { code: s.code })}"></label></td>
  <td><code>${s.code}</code></td><td>${s.name}</td><td>${s.phone}</td>
  <td class="num">${fmtBottles(s.leftMilli)} / ${fmtBottles(s.qtyMilli)}</td><td>${fmtDate(s.expiredAt)}</td></tr>`;

function listHtml(rows) {
  if (!rows.length) return emptyState(t('forfeit.none'));
  return html`<div class="table-wrap" tabindex="0" role="region" aria-label="${t('forfeit.title')}"><table class="data">
    <thead><tr><th scope="col"><label class="check"><input type="checkbox" data-action="forfeitAll"><span>${t('forfeit.all')}</span></label></th>
      <th scope="col">${t('stash.code')}</th><th scope="col">${t('stash.item')}</th><th scope="col">${t('floor.phone')}</th>
      <th scope="col" class="num">${t('stash.left')}</th><th scope="col">${t('forfeit.expired')}</th></tr></thead>
    <tbody>${rows.map(row)}</tbody></table></div>
    <div class="row forfeit-bar"><label class="check"><input type="checkbox" name="toStock" checked><span>${t('forfeit.toStock')}</span></label>
      <span class="hint">${t('forfeit.toStockHint')}</span>
      <button type="button" class="btn btn--danger" data-action="forfeit">${t('forfeit.go', { n: 0 })}</button></div>`;
}

export async function mountForfeit(el) {
  setHtml(el, html`<section class="panel" aria-labelledby="forfeit-title"><h3 id="forfeit-title" class="section-title">${t('forfeit.title')}</h3>
    <p class="hint">${t('forfeit.intro')}</p><div data-list>${skeleton(2)}</div></section>`);
  const list = el.querySelector('[data-list]');
  const picked = () => [...list.querySelectorAll('input[name=forfeitId]:checked')].map((c) => Number(c.value));
  const updateCount = () => {
    const button = list.querySelector('[data-action=forfeit]');
    if (button) button.textContent = t('forfeit.go', { n: picked().length });
  };

  const load = async () => setHtml(list, listHtml(await get('/api/stash/expired')));

  delegate(el, {
    click: {
      forfeit: async () => {
        const ids = picked();
        if (!ids.length) { toast(t('forfeit.needPick'), 'error'); return; }
        const toStock = list.querySelector('input[name=toStock]').checked;
        const message = `${t('forfeit.ask', { n: ids.length })}${toStock ? ` ${t('forfeit.askStock')}` : ''}`;
        if (!await confirmDialog({ title: t('forfeit.title'), message, submit: 'forfeit.confirm', danger: true })) return;
        const r = await post('/api/stash/forfeit', { ids, toStock });
        toast(t('forfeit.done', { n: r.forfeited, r: r.restocked }), 'success');
        await load();
      },
    },
    change: {
      forfeitAll: (box) => {
        list.querySelectorAll('input[name=forfeitId]').forEach((c) => { c.checked = box.checked; });
        updateCount();
      },
    },
  });
  // Row checkboxes carry no data-action (their name is the form value), so count changes are caught here.
  list.addEventListener('change', (e) => { if (e.target.name === 'forfeitId') updateCount(); });
  await load();
}
