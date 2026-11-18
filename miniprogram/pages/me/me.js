const { COMPANY } = require('../../config');
const { mePath } = require('../../utils/paths');
const { showWeb } = require('../../utils/web-page');

Page({
  data: { src: '', error: '' },

  onLoad() {
    showWeb(this, mePath(COMPANY));
  },
});
