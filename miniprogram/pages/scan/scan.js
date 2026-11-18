const { BASE_URL } = require('../../config');
const { pathFromScan } = require('../../utils/paths');

Page({
  data: { error: '' },

  scan() {
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode'],
      success: ({ result }) => {
        const path = pathFromScan(result, BASE_URL);
        if (!path) {
          this.setData({ error: '这不是本店的台位码，请扫描桌上的二维码。' });
          return;
        }
        this.setData({ error: '' });
        wx.navigateTo({ url: `/pages/web/web?path=${encodeURIComponent(path)}` });
      },
    });
  },
});
