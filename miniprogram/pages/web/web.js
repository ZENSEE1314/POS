const { COMPANY } = require('../../config');
const { homePath } = require('../../utils/paths');
const { showWeb } = require('../../utils/web-page');

/** Any customer-app page: a scanned table, or the page the pay page returns to with ?paid=. */
Page({
  data: { src: '', error: '' },

  onLoad(options) {
    showWeb(this, options.path ? decodeURIComponent(options.path) : homePath(COMPANY));
  },
});
