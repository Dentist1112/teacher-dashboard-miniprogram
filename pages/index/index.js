const app = getApp();
const classinfo = require('../../utils/classinfo.js');

Page({
  data: { openid: '', envOk: false, classTitle: '' },
  onShow() {
    this.setData({
      openid: app.globalData.openid || '(待登录)',
      envOk: !!app.globalData.openid
    });
    classinfo.get().then(info => this.setData({ classTitle: classinfo.title(info) }));
  }
});
