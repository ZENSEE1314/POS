const api = require('./api');
const { isAppPath } = require('./paths');

/** Points a web-view page at a customer-app path, signed in as this WeChat user. */
async function showWeb(page, path) {
  if (!isAppPath(path)) {
    page.setData({ error: '无法打开这个页面' });
    return;
  }
  page.setData({ src: await api.webUrl(path), error: '' });
}

module.exports = { showWeb };
