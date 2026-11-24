// Admin section: distribution (分销). Turn it on with a commission rate, approve or pause distributors, give one a
// personal rate, and pay out what they ask for (finance pays them in WeChat, Alipay or by bank, then marks it paid).
import { t, addStrings } from './i18n.js';
import { get, post, patch, can } from './session.js';
import { html, fmtMoney, fmtDateTime, toYuanInput } from './util.js';
import { formDialog, confirmDialog, dataTable, badge, toast } from './ui.js';

const BPS_PER_PERCENT = 100;
const MAX_PERCENT = 50;
const STATUS_TONE = { pending: 'warning', active: 'success', stopped: 'neutral' };
const PAYOUT_TONE = { requested: 'warning', paid: 'success', rejected: 'neutral' };

addStrings({
  en: {
    'admin.distribution': 'Distribution',
    'dsa.off': 'Distribution is off. Guests do not see it.', 'dsa.on': 'Distribution is on: guests can apply from the customer app.',
    'dsa.settings': 'Settings', 'dsa.enabled': 'Turn on distribution', 'dsa.rate': 'Commission (% of what their team pays in the app)',
    'dsa.min': 'Smallest payout (¥)', 'dsa.minShort': 'Smallest payout','dsa.auto': 'Approve new distributors automatically', 'dsa.saved': 'Distribution settings saved.',
    'dsa.badRate': 'Enter a percentage from 0 to {max}.',
    'dsa.people': 'Distributors', 'dsa.payouts': 'Payout requests', 'dsa.noPeople': 'Nobody has applied yet.', 'dsa.noPayouts': 'No payout requests.',
    'dsa.name': 'Guest', 'dsa.code': 'Code', 'dsa.team': 'Team', 'dsa.earned': 'Earned', 'dsa.balance': 'Balance', 'dsa.rateCol': 'Rate',
    'dsa.companyRate': 'company rate', 'dsa.st.pending': 'Waiting', 'dsa.st.active': 'Active', 'dsa.st.stopped': 'Paused',
    'dsa.approve': 'Approve', 'dsa.stop': 'Pause', 'dsa.resume': 'Resume', 'dsa.setRate': 'Rate',
    'dsa.rateTitle': 'Personal rate for {name}', 'dsa.rateHint': 'Leave empty to use the company rate.',
    'dsa.amount': 'Amount', 'dsa.account': 'Send to', 'dsa.asked': 'Asked', 'dsa.pay.requested': 'To pay', 'dsa.pay.paid': 'Paid', 'dsa.pay.rejected': 'Returned',
    'dsa.markPaid': 'Mark paid', 'dsa.reject': 'Return', 'dsa.paidAsk': 'Have you sent {amount} to {account}?',
    'dsa.rejectTitle': 'Return this payout to their balance', 'dsa.note': 'Reason (the guest sees it)', 'dsa.financeOnly': 'Only finance or the owner can pay out.',
    'dsa.how': 'Commission is paid on money a guest pays through the customer app (WeChat, Alipay, member wallet) after joining a distributor\'s team. Cash at the till does not count.',
  },
  zh: {
    'admin.distribution': '分销管理',
    'dsa.off': '分销未开启，顾客端不可见。', 'dsa.on': '分销已开启：顾客可在顾客端申请成为分销员。',
    'dsa.settings': '分销设置', 'dsa.enabled': '开启分销', 'dsa.rate': '佣金比例（团队在应用内付款金额的 %）',
    'dsa.min': '最低提现金额（元）', 'dsa.minShort': '最低提现','dsa.auto': '自动通过分销员申请', 'dsa.saved': '分销设置已保存。',
    'dsa.badRate': '请输入 0 到 {max} 之间的百分比。',
    'dsa.people': '分销员', 'dsa.payouts': '提现申请', 'dsa.noPeople': '暂无申请。', 'dsa.noPayouts': '暂无提现申请。',
    'dsa.name': '顾客', 'dsa.code': '分销码', 'dsa.team': '团队', 'dsa.earned': '累计佣金', 'dsa.balance': '可提现', 'dsa.rateCol': '比例',
    'dsa.companyRate': '默认比例', 'dsa.st.pending': '待审核', 'dsa.st.active': '正常', 'dsa.st.stopped': '已暂停',
    'dsa.approve': '通过', 'dsa.stop': '暂停', 'dsa.resume': '恢复', 'dsa.setRate': '比例',
    'dsa.rateTitle': '{name} 的专属比例', 'dsa.rateHint': '留空则使用默认比例。',
    'dsa.amount': '金额', 'dsa.account': '收款方式', 'dsa.asked': '申请时间', 'dsa.pay.requested': '待打款', 'dsa.pay.paid': '已打款', 'dsa.pay.rejected': '已退回',
    'dsa.markPaid': '标记已打款', 'dsa.reject': '退回', 'dsa.paidAsk': '确认已向 {account} 转账 {amount}？',
    'dsa.rejectTitle': '退回提现到对方余额', 'dsa.note': '原因（顾客可见）', 'dsa.financeOnly': '仅财务或老板可以处理提现。',
    'dsa.how': '顾客加入分销员团队后，在顾客端付款（微信、支付宝、会员钱包）的金额才计佣金；前台现金收款不计。',
  },
});

const percentText = (bps) => `${bps / BPS_PER_PERCENT}%`;
const btn = (action, id, label, cls = 'btn--ghost') => html`<button type="button" class="btn btn--small ${cls}" data-action="${action}" data-id="${id}">${label}</button>`;

/** "5" or "2.5" -> basis points; null when empty and allowed, else throws a message the dialog shows. */
function toBps(text, allowEmpty) {
  const s = String(text ?? '').trim().replace('%', '');
  if (!s && allowEmpty) return null;
  const pct = Number(s);
  if (!s || !Number.isFinite(pct) || pct < 0 || pct > MAX_PERCENT) throw new Error(t('dsa.badRate', { max: MAX_PERCENT }));
  return Math.round(pct * BPS_PER_PERCENT);
}

/** `reload` re-runs the admin section (load + view). */
export function distributionSection(reload) {
  let data = { settings: null, distributors: [], payouts: [] };
  const personOf = (el) => data.distributors.find((d) => d.id === Number(el.dataset.id));
  const payoutOf = (el) => data.payouts.find((p) => p.id === Number(el.dataset.id));

  const settingsDialog = () => {
    const s = data.settings;
    return formDialog({
      title: t('dsa.settings'),
      intro: t('dsa.how'),
      fields: [
        { name: 'enabled', label: t('dsa.enabled'), type: 'checkbox', value: s.enabled },
        { name: 'rate', label: t('dsa.rate'), required: true, value: String(s.rateBps / BPS_PER_PERCENT) },
        { name: 'min', label: t('dsa.min'), type: 'money', required: true, value: toYuanInput(s.minPayoutFen) },
        { name: 'autoApprove', label: t('dsa.auto'), type: 'checkbox', value: s.autoApprove },
      ],
      onSubmit: async (v) => {
        await patch('/api/distribution', { enabled: v.enabled, rateBps: toBps(v.rate, false), minPayoutFen: v.min, autoApprove: v.autoApprove });
        toast(t('dsa.saved'), 'success');
        await reload();
      },
    });
  };

  const rateDialog = (d) => formDialog({
    title: t('dsa.rateTitle', { name: d.name }),
    fields: [{ name: 'rate', label: t('dsa.rateCol'), value: d.rateBps === null ? '' : String(d.rateBps / BPS_PER_PERCENT), hint: t('dsa.rateHint') }],
    onSubmit: async (v) => {
      await patch(`/api/distributors/${d.id}`, { rateBps: toBps(v.rate, true) });
      await reload();
    },
  });

  const rejectDialog = (p) => formDialog({
    title: t('dsa.rejectTitle'),
    fields: [{ name: 'note', label: t('dsa.note'), type: 'textarea' }],
    submit: 'dsa.reject',
    danger: true,
    onSubmit: async (v) => {
      await post(`/api/distributor-payouts/${p.id}/reject`, { note: v.note });
      await reload();
    },
  });

  const personActions = (d) => html`<div class="row">
    ${d.status === 'pending' && btn('dsDecide', d.id, t('dsa.approve'), 'btn--primary')}
    ${d.status === 'active' && btn('dsStop', d.id, t('dsa.stop'), 'btn--danger')}
    ${d.status === 'stopped' && btn('dsDecide', d.id, t('dsa.resume'))}
    ${btn('dsRate', d.id, t('dsa.setRate'))}</div>`;

  const payoutActions = (p) => (p.status !== 'requested' ? '' : can('payroll.write')
    ? html`<div class="row">${btn('dsPaid', p.id, t('dsa.markPaid'), 'btn--primary')}${btn('dsReject', p.id, t('dsa.reject'), 'btn--danger')}</div>`
    : html`<span class="muted">${t('dsa.financeOnly')}</span>`);

  const view = () => {
    const s = data.settings;
    return html`<p class="${s.enabled ? '' : 'muted'}">${s.enabled ? t('dsa.on') : t('dsa.off')}
        ${s.enabled && html` ${t('dsa.rateCol')}: <strong>${percentText(s.rateBps)}</strong> · ${t('dsa.minShort')}: <strong>${fmtMoney(s.minPayoutFen)}</strong>`}</p>
      <p class="muted">${t('dsa.how')}</p>
      <h4 class="section-title">${t('dsa.payouts')}</h4>
      ${dataTable({ caption: t('dsa.payouts'), empty: t('dsa.noPayouts'), rows: data.payouts, cols: [
        { label: t('dsa.name'), cell: (p) => html`${p.name}${p.phone && html`<br><span class="muted">${p.phone}</span>`}` },
        { label: t('dsa.amount'), cell: (p) => fmtMoney(p.amountFen), num: true }, { label: t('dsa.account'), cell: (p) => p.account },
        { label: t('dsa.asked'), cell: (p) => fmtDateTime(p.createdAt) },
        { label: t('common.status'), cell: (p) => html`${badge(t(`dsa.pay.${p.status}`), PAYOUT_TONE[p.status])}${p.note && html`<br><span class="muted">${p.note}</span>`}` },
        { label: t('common.actions'), cell: payoutActions }] })}
      <h4 class="section-title">${t('dsa.people')}</h4>
      ${dataTable({ caption: t('dsa.people'), empty: t('dsa.noPeople'), rows: data.distributors, cols: [
        { label: t('dsa.name'), cell: (d) => html`${d.name}${d.phone && html`<br><span class="muted">${d.phone}</span>`}` },
        { label: t('dsa.code'), cell: (d) => d.code }, { label: t('common.status'), cell: (d) => badge(t(`dsa.st.${d.status}`), STATUS_TONE[d.status]) },
        { label: t('dsa.rateCol'), cell: (d) => (d.rateBps === null ? html`<span class="muted">${t('dsa.companyRate')}</span>` : percentText(d.rateBps)), num: true },
        { label: t('dsa.team'), cell: (d) => d.team, num: true }, { label: t('dsa.earned'), cell: (d) => fmtMoney(d.earnedFen), num: true },
        { label: t('dsa.balance'), cell: (d) => fmtMoney(d.balanceFen), num: true }, { label: t('common.actions'), cell: personActions }] })}`;
  };

  const decide = async (el, action) => {
    await post(`/api/distributors/${el.dataset.id}/${action}`);
    await reload();
  };

  return {
    distribution: {
      load: async () => { data = await get('/api/distribution'); return []; },
      add: 'dsa.settings',
      view,
      dialog: settingsDialog,
      actions: {
        dsDecide: (el) => decide(el, personOf(el).status === 'pending' ? 'approve' : 'resume'),
        dsStop: (el) => decide(el, 'stop'),
        dsRate: (el) => rateDialog(personOf(el)),
        dsPaid: async (el) => {
          const p = payoutOf(el);
          if (!await confirmDialog({ title: t('dsa.markPaid'), message: t('dsa.paidAsk', { amount: fmtMoney(p.amountFen), account: p.account }), submit: 'dsa.markPaid' })) return;
          await post(`/api/distributor-payouts/${p.id}/paid`);
          await reload();
        },
        dsReject: (el) => rejectDialog(payoutOf(el)),
      },
    },
  };
}
