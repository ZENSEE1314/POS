// Members view: search / balance lookup and wallet top-up with bonus (manager/owner).
import { t } from './i18n.js';
import { get, post, can } from './session.js';
import { html, setHtml, fmtMoney } from './util.js';
import { delegate, formDialog, dataTable, notifyError, skeleton, toast } from './ui.js';

export function mountMembers(root) {
  const state = { q: '', rows: null };

  function tableHtml() {
    if (state.rows === null) return skeleton(4);
    const cols = [
      { label: t('floor.phone'), cell: (m) => m.phone },
      { label: t('members.name'), cell: (m) => m.name || '-' },
      { label: t('members.balance'), cell: (m) => fmtMoney(m.balance), num: true },
      ...(can('admin.write') ? [{ label: t('common.actions'), cell: (m) => html`<button type="button" class="btn btn--small btn--primary" data-action="topup" data-phone="${m.phone}">${t('members.topup')}</button>` }] : []),
    ];
    return dataTable({ cols, rows: state.rows, empty: t('members.empty'), caption: t('nav.members') });
  }

  const renderTable = () => setHtml(root.querySelector('#members-table'), tableHtml());

  async function search(q = state.q) {
    state.q = q;
    state.rows = await get(`/api/members?q=${encodeURIComponent(q)}`);
    renderTable();
  }

  const topup = (phone = '') => formDialog({
    title: t('members.topup'),
    intro: t('members.topupIntro'),
    fields: [
      { name: 'phone', label: t('floor.phone'), type: 'tel', required: true, value: phone },
      { name: 'amount', label: t('members.amount'), type: 'money', required: true },
      { name: 'bonus', label: t('members.bonus'), type: 'money', value: '0', hint: t('members.bonusHint') },
    ],
    submit: 'members.topup',
    onSubmit: async (v) => {
      const m = await post('/api/members/topup', { phone: v.phone, amount: v.amount, bonus: v.bonus ?? 0 });
      toast(t('members.topupDone', { balance: fmtMoney(m.balance) }), 'success');
      await search(v.phone);
    },
  });

  setHtml(root, html`<section aria-labelledby="mb-title">
    <div class="view-bar"><h2 id="mb-title" class="view-title">${t('nav.members')}</h2>
      ${can('admin.write') && html`<button type="button" class="btn btn--primary" data-action="newTopup">${t('members.topup')}</button>`}</div>
    <form class="panel search-bar" data-form="search" role="search">
      <div class="field field--grow"><label for="member-q">${t('members.search')}</label>
        <input id="member-q" name="q" type="search" placeholder="${t('members.searchPlaceholder')}" autocomplete="off"></div>
      <button type="submit" class="btn btn--primary">${t('common.search')}</button>
    </form>
    <div class="panel" id="members-table">${tableHtml()}</div></section>`);
  search('').catch(notifyError);

  delegate(root, {
    click: { topup: (el) => topup(el.dataset.phone), newTopup: () => topup() },
    submit: { search: (form) => search(new FormData(form).get('q').trim()) },
  });
}
