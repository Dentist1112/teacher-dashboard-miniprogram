async function getOpenId() {
  const app = getApp();
  if (app.globalData.openid) return app.globalData.openid;
  const res = await wx.cloud.callFunction({ name: 'login' });
  app.globalData.openid = res.result.openid;
  return app.globalData.openid;
}
module.exports = { getOpenId };
