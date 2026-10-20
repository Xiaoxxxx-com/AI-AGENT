const { ensureLogin } = require('./utils/request');

App({
  globalData: {
    userId: null,
  },
  onLaunch() {
    ensureLogin().catch((err) => {
      wx.showToast({ title: '登录失败，请检查后端', icon: 'none' });
      console.error('[app] login failed', err);
    });
  },
});
