const { BASE_URL, COMPANY } = require('../../config');
const { pathFromScan, homePath } = require('../../utils/paths');
const { showWeb } = require('../../utils/web-page');

Page({
  data: { src: '', error: '' },

  onLoad(options) {
    // Opened by scanning a table QR with the WeChat camera (扫普通链接二维码打开小程序): q is the scanned URL.
    const scanned = options.q ? pathFromScan(decodeURIComponent(options.q), BASE_URL) : null;
    showWeb(this, scanned || homePath(COMPANY));
  },

  onShareAppMessage() {
    return { title: '夜场会员', path: '/pages/home/home' };
  },
});
