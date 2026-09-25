// 登录页：微信头像 + 昵称。
// 不做「不登录就不给用」——数据本来就按 _openid 隔离，身份只影响界面显示谁。
// 老师不愿授权时点「暂不设置」直接进（把人堵在门外是更严重的问题）。
const profile = require('../../utils/profile.js');
const kb = require('../../utils/kb.js');

const HOME = '/pages/dashboard/dashboard';

Page({
  data: {
    avatar: '',        // 临时路径或 cloud://
    nickName: '',
    saving: false,
    kbH: 0
  },

  onLoad() {
    kb.bind(this);
    // 已登录过的老师被 onShareAppMessage/手动导航带回来 → 回填，不清空
    const p = profile.getLocal();
    if (p) this.setData({ avatar: p.avatar || '', nickName: p.nickName || '' });
  },

  onUnload() {
    kb.unbind(this);
  },

  // chooseAvatar 只在真机/新版模拟器触发；e.detail.avatarUrl 是 wxfile:// 临时路径
  onChooseAvatar(e) {
    const url = (e && e.detail && e.detail.avatarUrl) || '';
    if (!url) {
      wx.showToast({ title: '没取到头像，可跳过', icon: 'none' });
      return;
    }
    this.setData({ avatar: url });
  },

  // type="nickname" 的输入框：用户点「使用微信昵称」时走 bindinput，
  // 手打时也走 bindinput；bindblur 再兜一次（部分机型选昵称只触发 blur，实测口径）
  onNickInput(e) {
    const v = (e && e.detail && e.detail.value) || '';
    if (v === this.data.nickName) return;
    this.setData({ nickName: v });
  },

  async onConfirm() {
    if (this._busy) return;
    const name = String(this.data.nickName || '').trim();
    if (!name) {
      wx.showToast({ title: '请填昵称，或点「暂不设置」', icon: 'none' });
      return;
    }
    if (name.length > 20) {
      wx.showToast({ title: '昵称最多 20 个字', icon: 'none' });
      return;
    }
    this._busy = true;
    this.setData({ saving: true });
    try {
      const { warn } = await profile.save({ nickName: name, avatarTemp: this.data.avatar });
      if (warn) wx.showToast({ title: warn, icon: 'none' });
      this.enter();
    } catch (e) {
      wx.showToast({ title: '保存失败：' + (e.message || '未知错误'), icon: 'none' });
    } finally {
      this._busy = false;
      this.setData({ saving: false });
    }
  },

  onSkip() {
    profile.skip();
    this.enter();
  },

  // 首页是 tabBar 页，必须 switchTab；reLaunch 到 tab 页在部分基础库下会丢 tabBar 选中态
  enter() {
    wx.switchTab({
      url: HOME,
      fail: () => wx.reLaunch({ url: HOME })
    });
  }
});
