const { BASE_URL } = require('./config');

let loginPromise = null;

/** 统一请求封装：带 Authorization，401 时重新登录并重试一次 */
function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${BASE_URL}${path}`,
      method: options.method || 'GET',
      data: options.data,
      timeout: options.timeout || 20000,
      header: Object.assign(
        { 'content-type': 'application/json' },
        wx.getStorageSync('token') ? { authorization: `Bearer ${wx.getStorageSync('token')}` } : {},
        options.header || {},
      ),
      success: (res) => {
        if (res.statusCode === 401 && !options._retried) {
          ensureLogin(true)
            .then(() => request(path, Object.assign({}, options, { _retried: true })))
            .then(resolve)
            .catch(reject);
          return;
        }
        if (res.statusCode >= 400) {
          reject(Object.assign(new Error((res.data && res.data.message) || `HTTP ${res.statusCode}`), { res }));
          return;
        }
        resolve(res.data);
      },
      fail: reject,
    });
  });
}

/** 小程序登录：wx.login → /auth/wechat；本地开发时后端会走 /auth/dev 兜底 */
function ensureLogin(force = false) {
  if (!force && wx.getStorageSync('token')) return Promise.resolve(wx.getStorageSync('token'));
  if (loginPromise) return loginPromise;

  loginPromise = new Promise((resolve, reject) => {
    wx.login({
      success: async ({ code }) => {
        try {
          let data;
          try {
            data = await request('/auth/wechat', { method: 'POST', data: { code } });
          } catch (err) {
            // 503 = 服务端没配微信 appid，开发期用 dev 登录
            data = await request('/auth/dev', { method: 'POST', data: {} });
          }
          wx.setStorageSync('token', data.token);
          wx.setStorageSync('userId', data.userId);
          resolve(data.token);
        } catch (err) {
          reject(err);
        } finally {
          loginPromise = null;
        }
      },
      fail: (err) => {
        loginPromise = null;
        reject(err);
      },
    });
  });

  return loginPromise;
}

module.exports = { request, ensureLogin, BASE_URL };
