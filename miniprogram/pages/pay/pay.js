const api = require('../../utils/api');
const { isAppPath, isPayPath, withPaid } = require('../../utils/paths');

const POLL_TRIES = 10;
const POLL_MS = 1000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * WeChat Pay for the customer app. The web-view cannot call wx.requestPayment, so it sends the guest here with the
 * pay endpoint, the amount (fen) and the page to return to.
 */
Page({
  data: { amountText: '', state: 'loading', error: '' },

  onLoad(q) {
    this.payPath = decodeURIComponent(q.path || '');
    this.back = decodeURIComponent(q.back || '');
    this.amount = Number(q.amount);
    if (!isPayPath(this.payPath) || !isAppPath(this.back) || !(this.amount > 0)) {
      this.setData({ state: 'failed', error: '付款信息有误，请返回重试。' });
      return;
    }
    this.setData({ amountText: `¥${(this.amount / 100).toFixed(2)}` });
    this.start();
  },

  async start() {
    this.setData({ state: 'loading', error: '' });
    try {
      const r = await api.request('POST', this.payPath, { method: 'wechat', channel: 'miniprogram', amount: this.amount, returnPath: this.back });
      this.outTradeNo = r.outTradeNo;
      // Development server: no real WeChat Pay, simulate it.
      if (r.kind === 'mock') { this.setData({ state: 'mock' }); return; }
      if (r.kind !== 'jsapi') throw new Error('暂不支持此付款方式');
      this.requestPayment(r.params);
    } catch (e) {
      this.setData({ state: 'failed', error: e.message });
    }
  },

  requestPayment(p) {
    wx.requestPayment({
      timeStamp: p.timeStamp,
      nonceStr: p.nonceStr,
      package: p.package,
      signType: p.signType,
      paySign: p.paySign,
      success: () => this.confirm(),
      fail: (e) => this.setData({ state: 'failed', error: /cancel/.test(e.errMsg || '') ? '已取消付款' : '付款失败，请重试' }),
    });
  },

  async mockPay() {
    try {
      await api.request('POST', `/api/guest/payments/${encodeURIComponent(this.outTradeNo)}/mock-pay`);
      this.finish();
    } catch (e) {
      this.setData({ state: 'failed', error: e.message });
    }
  },

  /** WeChat's notify usually lands within a second; the customer app re-checks with ?paid= anyway. */
  async confirm() {
    this.setData({ state: 'confirming' });
    for (let i = 0; i < POLL_TRIES; i += 1) {
      try {
        const s = await api.request('GET', `/api/guest/payments/${encodeURIComponent(this.outTradeNo)}`);
        if (s.status === 'paid') break;
      } catch (e) { /* keep waiting */ }
      await wait(POLL_MS);
    }
    this.finish();
  },

  finish() {
    // A fresh stack, so "back" does not show the bill as it was before paying.
    wx.reLaunch({ url: `/pages/web/web?path=${encodeURIComponent(withPaid(this.back, this.outTradeNo))}` });
  },

  goBack() {
    wx.navigateBack();
  },
});
