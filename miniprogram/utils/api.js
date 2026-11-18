const { BASE_URL } = require('../config');

const TOKEN_KEY = 'guestToken';
const HTTP_UNAUTHORIZED = 401;

function rawRequest(method, path, data, token) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE_URL + path,
      method,
      data,
      header: token ? { Authorization: `Bearer ${token}` } : {},
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data);
        else reject(Object.assign(new Error((res.data && res.data.error) || `HTTP ${res.statusCode}`), { status: res.statusCode }));
      },
      fail: (e) => reject(new Error(e.errMsg || '网络错误')),
    });
  });
}

/** wx.login code -> our server -> a guest session for this WeChat user. */
function login() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: async ({ code }) => {
        try {
          const r = await rawRequest('POST', '/api/guest/mp/login', { code });
          wx.setStorageSync(TOKEN_KEY, r.token);
          resolve(r.token);
        } catch (e) {
          reject(e);
        }
      },
      fail: (e) => reject(new Error(e.errMsg || '微信登录失败')),
    });
  });
}

async function ensureLogin() {
  return wx.getStorageSync(TOKEN_KEY) || login();
}

/** Signed-in call; an expired session signs in again once. */
async function request(method, path, data) {
  try {
    return await rawRequest(method, path, data, await ensureLogin());
  } catch (e) {
    if (e.status !== HTTP_UNAUTHORIZED) throw e;
    wx.removeStorageSync(TOKEN_KEY);
    return rawRequest(method, path, data, await login());
  }
}

/** URL for the web-view, carrying a one-time code so the customer app signs in as this WeChat user. */
async function webUrl(path) {
  try {
    const { code } = await request('POST', '/api/guest/mp/handoff');
    return `${BASE_URL}${path}#mpLogin=${code}`;
  } catch (e) {
    // Server unreachable or sign-in off: the page still opens, the guest can sign in there.
    return BASE_URL + path;
  }
}

module.exports = { request, ensureLogin, webUrl };
