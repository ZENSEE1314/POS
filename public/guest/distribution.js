// Customer app: distribution (分销). A guest signs up as a distributor, shares their link or QR code, sees what their
// team spent and what they earned, and asks the venue for a payout. A new guest opening /g/<company>?dist=CODE joins
// that distributor's team once signed in.
import { t, addStrings } from './i18n.js';
import { html, raw, setHtml, fmtMoney, fmtDateTime, parseFen, session, get, post, busy, sheet, skeleton, toast } from './core.js';
import { ensureSignedIn } from './login.js';
import { icon } from './icons.js';
import { qrSvg } from '/qr.js';

const enc = encodeURIComponent;
const DIST_KEY = 'nightpos.dist';
const BPS_PER_PERCENT = 100;
const FEN_PER_YUAN = 100;
const PAYOUT_TONE = { requested: 'pending', paid: 'ok', rejected: 'bad' };

addStrings({
  en: {
    'ds.title': 'Earn as a distributor', 'ds.home': 'Earn',
    'ds.pitch': 'Share your link. Friends who join through it are on your team, and you earn {rate}% of everything they pay through this app, every time.',
    'ds.apply': 'Become a distributor', 'ds.pending': 'Your application is waiting for the venue to approve it.',
    'ds.stopped': 'The venue has paused your distributor account. You can still take out what you earned.',
    'ds.balance': 'Balance', 'ds.earned': 'Earned in total', 'ds.team': 'Team', 'ds.rate': 'Your rate',
    'ds.share': 'Share my link', 'ds.copy': 'Copy link', 'ds.copied': 'Link copied', 'ds.qr': 'Your QR code', 'ds.qrHint': 'Friends scan this to join your team.',
    'ds.code': 'Your distributor code',
    'ds.recent': 'Recent earnings', 'ds.none': 'Nothing yet. Share your link to start earning.',
    'ds.kind.commission': '{guest} spent {amount}', 'ds.kind.payout': 'Payout requested', 'ds.kind.payout_back': 'Payout returned',
    'ds.payout': 'Take out money', 'ds.payoutMin': 'Smallest payout: {amount}', 'ds.amount': 'Amount (¥)',
    'ds.account': 'Where should the venue send it?', 'ds.accountHint': 'For example: WeChat ID, Alipay account or bank card.',
    'ds.send': 'Request payout', 'ds.sent': 'Payout requested. The venue will pay you and mark it paid.',
    'ds.badAmount': 'Enter an amount in yuan.', 'ds.payouts': 'Payouts',
    'ds.st.requested': 'Waiting', 'ds.st.paid': 'Paid', 'ds.st.rejected': 'Returned',
    'ds.join': 'Have a distributor code?', 'ds.joinPh': '8 letters or numbers', 'ds.joinBtn': 'Join their team',
    'ds.joined': 'You joined a distributor\'s team.', 'ds.inTeam': 'You are on a distributor\'s team here.',
    'ds.off': 'This venue does not run a distributor programme.',
  },
  zh: {
    'ds.title': '分销赚佣金', 'ds.home': '分销',
    'ds.pitch': '分享您的专属链接。好友通过链接加入后成为您的团队成员，他们之后每次在本应用付款，您都可获得 {rate}% 佣金。',
    'ds.apply': '申请成为分销员', 'ds.pending': '您的申请正在等待商家审核。',
    'ds.stopped': '商家已暂停您的分销资格，已赚取的佣金仍可提现。',
    'ds.balance': '可提现', 'ds.earned': '累计佣金', 'ds.team': '团队人数', 'ds.rate': '佣金比例',
    'ds.share': '分享链接', 'ds.copy': '复制链接', 'ds.copied': '链接已复制', 'ds.qr': '我的推广码', 'ds.qrHint': '好友扫码即可加入您的团队。',
    'ds.code': '分销码',
    'ds.recent': '最近收益', 'ds.none': '暂无收益，快去分享链接吧。',
    'ds.kind.commission': '{guest} 消费 {amount}', 'ds.kind.payout': '申请提现', 'ds.kind.payout_back': '提现退回',
    'ds.payout': '申请提现', 'ds.payoutMin': '最低提现：{amount}', 'ds.amount': '金额（元）',
    'ds.account': '收款方式', 'ds.accountHint': '例如：微信号、支付宝账号或银行卡。',
    'ds.send': '提交提现', 'ds.sent': '已提交提现，商家打款后会标记为已支付。',
    'ds.badAmount': '请输入金额（元）。', 'ds.payouts': '提现记录',
    'ds.st.requested': '待打款', 'ds.st.paid': '已打款', 'ds.st.rejected': '已退回',
    'ds.join': '有分销码？', 'ds.joinPh': '8 位字母或数字', 'ds.joinBtn': '加入团队',
    'ds.joined': '已加入分销团队。', 'ds.inTeam': '您已是本店分销团队成员。',
    'ds.off': '本店暂未开通分销。',
  },
});

const percent = (bps) => bps / BPS_PER_PERCENT;
const shareLink = (company, code) => `${location.origin}/g/${enc(company)}?dist=${code}`;

// ---------- links ----------

/** /g/<company>?dist=CODE: keep the code until the guest has signed in, then use it once. */
export function captureDistributor(company) {
  const code = new URLSearchParams(location.search).get('dist');
  if (!code || !company) return;
  try { localStorage.setItem(DIST_KEY, JSON.stringify({ company, code })); } catch { /* no storage: the guest can type the code */ }
  history.replaceState(null, '', location.pathname);
}

export async function joinPendingDistributor(company) {
  if (!session.customer) return;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(DIST_KEY) ?? 'null'); } catch { return; }
  if (!saved || saved.company.toLowerCase() !== String(company).toLowerCase()) return;
  try { localStorage.removeItem(DIST_KEY); } catch { /* ignore */ }
  try {
    await post(`/api/guest/distribution/${enc(saved.company)}/join`, { code: saved.code });
    toast(t('ds.joined'), 'success');
  } catch { /* switched off, own code, or the guest has paid here before: nothing to tell them */ }
}

// ---------- page ----------

const joinForm = (d) => (d.joined ? html`<p class="g-hint g-gap">${t('ds.inTeam')}</p>` : html`<form class="g-card" data-join novalidate>
  <div class="g-field"><label for="ds-code">${t('ds.join')}</label>
    <input id="ds-code" maxlength="8" autocapitalize="characters" autocomplete="off" placeholder="${t('ds.joinPh')}" required></div>
  <button type="submit" class="g-btn g-btn--block">${t('ds.joinBtn')}</button></form>`);

const lineText = (r) => (r.kind === 'commission' ? t('ds.kind.commission', { guest: r.guest, amount: fmtMoney(r.spentFen) }) : t(`ds.kind.${r.kind}`));

function memberHtml(d, company) {
  const me = d.me;
  const link = shareLink(company, me.code);
  return html`
    ${me.status === 'stopped' && html`<p class="g-card g-muted">${t('ds.stopped')}</p>`}
    <section class="g-balancecard" aria-labelledby="ds-bal"><span id="ds-bal" class="g-balancecard__label">${icon('wallet')}${t('ds.balance')}</span>
      <strong class="g-balancecard__value g-num">${fmtMoney(me.balanceFen)}</strong>
      <p class="g-balancecard__hint">${t('ds.payoutMin', { amount: fmtMoney(d.minPayoutFen) })}</p></section>
    <div class="g-statrow"><div class="g-statbox"><strong class="g-num">${me.team}</strong><span>${t('ds.team')}</span></div>
      <div class="g-statbox"><strong class="g-num">${fmtMoney(me.earnedFen)}</strong><span>${t('ds.earned')}</span></div>
      <div class="g-statbox"><strong class="g-num">${percent(me.rateBps)}%</strong><span>${t('ds.rate')}</span></div></div>
    ${me.status === 'active' && html`<section class="g-invite g-gap"><h2 class="g-invite__title">${t('ds.qr')}</h2>
      <div class="g-qr">${raw(qrSvg(link, t('ds.qr')) ?? '')}</div><p class="g-hint">${t('ds.qrHint')}</p>
      <p class="g-hint">${t('ds.code')}</p><p class="g-invite__code g-num">${me.code}</p>
      <div class="g-invite__btns"><button type="button" class="g-btn g-btn--primary" data-share="${link}">${t('ds.share')}</button>
        <button type="button" class="g-btn" data-copy="${link}">${t('ds.copy')}</button></div></section>`}
    <button type="button" class="g-btn g-btn--primary g-btn--block g-gap" data-payout ${me.balanceFen < Math.max(d.minPayoutFen, 1) ? 'disabled' : ''}>${t('ds.payout')}</button>
    <section class="g-card g-gap" aria-labelledby="ds-recent"><h2 id="ds-recent" class="g-card__title">${t('ds.recent')}</h2>
      ${me.recent.length ? html`<ul class="g-lines">${me.recent.map((r) => html`<li><span>${lineText(r)}<br><span class="g-hint">${fmtDateTime(r.ts)}</span></span>
        <span class="g-num">${r.deltaFen > 0 ? '+' : '-'}${fmtMoney(Math.abs(r.deltaFen))}</span></li>`)}</ul>` : html`<p class="g-muted">${t('ds.none')}</p>`}</section>
    ${me.payouts.length > 0 && html`<section class="g-card" aria-labelledby="ds-pay"><h2 id="ds-pay" class="g-card__title">${t('ds.payouts')}</h2>
      <ul class="g-lines">${me.payouts.map((p) => html`<li><span>${p.account}<br><span class="g-hint">${fmtDateTime(p.createdAt)}${p.note && ` · ${p.note}`}</span></span>
        <span><span class="g-num">${fmtMoney(p.amountFen)}</span> <span class="g-badge g-badge--${PAYOUT_TONE[p.status]}">${t(`ds.st.${p.status}`)}</span></span></li>`)}</ul></section>`}`;
}

function pageHtml(d, company) {
  const head = html`<header class="g-pagehead"><h1 class="g-pagehead__title">${t('ds.title')}</h1></header>`;
  if (d.me?.status === 'active' || d.me?.status === 'stopped') return html`${head}${memberHtml(d, company)}`;
  return html`${head}<section class="g-invite"><span class="g-invite__icon">${icon('users')}</span>
      <p class="g-invite__text">${t('ds.pitch', { rate: percent(d.rateBps) })}</p>
      ${d.me?.status === 'pending' ? html`<p class="g-hint g-gap">${t('ds.pending')}</p>`
        : html`<button type="button" class="g-btn g-btn--primary g-btn--block g-gap" data-apply>${t('ds.apply')}</button>`}</section>
    ${joinForm(d)}`;
}

const payoutSheet = (company, d, reload) => sheet(t('ds.payout'), (body, close) => {
  setHtml(body, html`<form novalidate><p class="g-hint">${t('ds.payoutMin', { amount: fmtMoney(d.minPayoutFen) })}</p>
    <div class="g-field"><label for="ds-amt">${t('ds.amount')}</label>
      <input id="ds-amt" inputmode="decimal" required value="${(d.me.balanceFen / FEN_PER_YUAN).toFixed(2)}"></div>
    <div class="g-field"><label for="ds-acc">${t('ds.account')}</label>
      <input id="ds-acc" maxlength="80" required aria-describedby="ds-acc-hint"><p id="ds-acc-hint" class="g-hint">${t('ds.accountHint')}</p></div>
    <button type="submit" class="g-btn g-btn--primary g-btn--block">${t('ds.send')}</button></form>`);
  const form = body.querySelector('form');
  form.addEventListener('submit', busy(form.querySelector('[type=submit]'), async (e) => {
    e.preventDefault();
    const amountFen = parseFen(form.querySelector('#ds-amt').value);
    if (Number.isNaN(amountFen)) { toast(t('ds.badAmount'), 'error'); return; }
    if (!form.checkValidity()) { form.reportValidity(); return; }
    await post(`/api/guest/distribution/${enc(company)}/payout`, { amountFen, account: form.querySelector('#ds-acc').value.trim() });
    close();
    toast(t('ds.sent'), 'success');
    await reload();
  }));
});

export async function mountDistribution(root, { company }) {
  let data = null;
  const load = async () => {
    try {
      data = await get(`/api/guest/distribution/${enc(company)}`);
    } catch (e) {
      if (e.status === 404) { setHtml(root, html`<p class="g-empty">${t('ds.off')}</p>`); return; }
      throw e;
    }
    setHtml(root, pageHtml(data, company));
  };

  root.addEventListener('click', async (e) => {
    const shareBtn = e.target.closest('[data-copy], [data-share]');
    if (shareBtn) {
      const link = shareBtn.dataset.copy ?? shareBtn.dataset.share;
      if (shareBtn.dataset.share && navigator.share) {
        try { await navigator.share({ title: t('ds.title'), url: link }); return; } catch { /* closed the share sheet: copy instead */ }
      }
      try { await navigator.clipboard.writeText(link); toast(t('ds.copied'), 'success'); } catch { toast(link); }
      return;
    }
    const apply = e.target.closest('[data-apply]');
    if (apply) {
      await busy(apply, async () => { await post(`/api/guest/distribution/${enc(company)}/apply`); await load(); })();
      return;
    }
    if (e.target.closest('[data-payout]')) void payoutSheet(company, data, load);
  });
  root.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-join]');
    if (!form) return;
    e.preventDefault();
    await busy(form.querySelector('button'), async () => {
      await post(`/api/guest/distribution/${enc(company)}/join`, { code: form.querySelector('input').value });
      toast(t('ds.joined'), 'success');
      await load();
    })();
  });

  const start = async () => {
    if (!session.customer) {
      setHtml(root, html`<div class="g-card"><p class="g-muted g-lead">${t('login.why')}</p>
        <button type="button" class="g-btn g-btn--primary g-btn--block" data-signin>${t('login.title')}</button></div>`);
      root.querySelector('[data-signin]').addEventListener('click', async () => { if (await ensureSignedIn()) await start(); });
      return;
    }
    setHtml(root, skeleton(4));
    await load();
  };
  await start();
}
