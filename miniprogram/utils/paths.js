// Pure helpers (no wx.*), so they can be tested in Node.

const APP_PATH = /^\/g(\/[A-Za-z0-9._~%-]*)*$/;
const PAY_PATH = /^\/api\/guest\/(table\/[A-Za-z0-9_-]+|orders\/\d+)\/pay$/;

/** The customer-app path a scanned code points to, or null if it is not one of our table/venue codes. */
function pathFromScan(scanned, baseUrl) {
  let url;
  try {
    url = new URL(String(scanned || '').trim());
  } catch (e) {
    return null;
  }
  if (url.origin !== new URL(baseUrl).origin || !APP_PATH.test(url.pathname)) return null;
  return url.pathname + url.search;
}

/** Only same-app customer pages are opened in the web-view. */
function isAppPath(path) {
  const [p] = String(path || '').split('?');
  return APP_PATH.test(p);
}

function homePath(company) {
  return company ? `/g/${encodeURIComponent(company)}` : '/g/';
}

function mePath(company) {
  return company ? `/g/${encodeURIComponent(company)}/me` : '/g/';
}

/** Only the customer app's own pay endpoints may be called from the pay page. */
function isPayPath(path) {
  return PAY_PATH.test(String(path || ''));
}

function withPaid(back, outTradeNo) {
  return `${back}?paid=${encodeURIComponent(outTradeNo)}`;
}

module.exports = { pathFromScan, isAppPath, homePath, mePath, isPayPath, withPaid };
