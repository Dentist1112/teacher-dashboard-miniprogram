const db = require('../../utils/db.js');
const classinfo = require('../../utils/classinfo.js');
const profile = require('../../utils/profile.js');

Page({
  data: {
    form: { school: '', className: '', grade: '', semester: '', teacher: '' },
    saving: false,
    openid: '(未登录)',
    stats: { students: 0, attendance: 0, announcements: 0, rewards: 0 },
    me: { nickName: '', avatar: '' },
    meSaving: false,
    ai: { key: '', baseUrl: '', model: '' },
    aiPwd: false,
    aiSaved: false,
    aiSaving: false
  },

  onShow() {
    const app = getApp();
    this.setData({ openid: (app && app.globalData && app.globalData.openid) || '(未登录)' });
    this.loadMe();
    this.load();
    this.loadStats();
    this.loadAi();
  },

  // 云回包不许覆盖用户正在打的字：
  // 实测（2026-09-06 探针）onShow 触发的 load() 云请求 300ms 后返回，
  // 会把刚输入的「XX中学」整段刷回云端旧值 —— 用户看到的现象就是「输入框打不上字」。
  async load() {
    const info = await classinfo.get(true);
    if (this._dirty) return;               // 用户已经动过表单 → 本次回包丢弃
    this.setData({
      form: {
        school: info.school || '',
        className: info.className || '',
        grade: info.grade || '',
        semester: info.semester || '',
        teacher: info.teacher || ''
      }
    });
  },

  async loadStats() {
    if (!db.isCloudReady()) return;
    try {
      const [students, attendance, announcements, rewards] = await Promise.all([
        db.count('students'), db.count('attendance'),
        db.count('announcements'), db.count('rewards')
      ]);
      this.setData({ stats: { students, attendance, announcements, rewards } });
    } catch (e) {
      console.error('loadStats error', e);
    }
  },

  // ===== 教师身份（头像 + 昵称）=====
  // 和 form 一样受 _meDirty 保护：onShow 的云回包不许覆盖正在改的昵称
  loadMe() {
    const p = profile.getLocal();
    if (this._meDirty) return;
    this.setData({ me: { nickName: (p && p.nickName) || '', avatar: (p && p.avatar) || '' } });
  },

  onChooseAvatar(e) {
    const url = (e && e.detail && e.detail.avatarUrl) || '';
    if (!url) { wx.showToast({ title: '没取到头像', icon: 'none' }); return; }
    this._meDirty = true;
    this.setData({ 'me.avatar': url });
  },

  onNickInput(e) {
    const v = (e && e.detail && e.detail.value) || '';
    if (v === this.data.me.nickName) return;
    this._meDirty = true;
    this.setData({ 'me.nickName': v });
  },

  async onSaveMe() {
    if (this._busy) return;
    this._busy = true;
    const name = String(this.data.me.nickName || '').trim();
    if (name.length > 20) {
      wx.showToast({ title: '昵称最多 20 个字', icon: 'none' });
      this._busy = false;
      return;
    }
    this.setData({ meSaving: true });
    try {
      const { profile: saved, warn } = await profile.save({ nickName: name, avatarTemp: this.data.me.avatar });
      this._meDirty = false;
      this.setData({ me: { nickName: saved.nickName, avatar: saved.avatar } });
      wx.showToast({ title: warn || '身份已保存', icon: warn ? 'none' : 'success' });
    } catch (e) {
      wx.showToast({ title: '保存失败：' + (e.message || '未知错误'), icon: 'none' });
    } finally {
      this._busy = false;
      this.setData({ meSaving: false });
    }
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '只清除本机显示的头像昵称，班级数据不会删除，重新登录能拉回来。',
      confirmText: '退出',
      success: res => {
        if (!res.confirm) return;
        profile.logout();
        this._meDirty = false;
        this.setData({ me: { nickName: '', avatar: '' } });
        wx.reLaunch({ url: '/pages/login/login' });
      }
    });
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this._dirty = true;                    // 之后的云回包一律不覆盖
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  // ===== AI 识别密钥（存 aiConfig 集合，按 OPENID 隔离，仅本人可读写）=====
  // 注：小程序端查询/写入默认只作用于自己的 _openid 记录
  async loadAi() {
    if (!db.isCloudReady()) return;
    try {
      const ddb = wx.cloud.database();
      const r = await ddb.collection('aiConfig').limit(1).get().catch(() => ({ data: [] }));
      if (this._aiDirty) return;           // 同 load()：不覆盖用户正在填的密钥
      if (r.data.length && r.data[0].key) {
        this.setData({
          ai: { key: r.data[0].key, baseUrl: r.data[0].baseUrl || '', model: r.data[0].model || '' },
          aiSaved: true
        });
      } else {
        this.setData({ aiSaved: false });
      }
    } catch (e) {
      this.setData({ aiSaved: false });
    }
  },

  onAiInput(e) {
    const field = e.currentTarget.dataset.field;
    this._aiDirty = true;
    this.setData({ [`ai.${field}`]: e.detail.value });
  },

  toggleAiPwd() { this.setData({ aiPwd: !this.data.aiPwd }); },

  async onAiSave() {
    if (this._aiBusy) return;
    if (!db.isCloudReady()) {
      wx.showToast({ title: '请先配置云环境', icon: 'none' });
      return;
    }
    const key = String(this.data.ai.key || '').trim();
    if (!key) {
      wx.showToast({ title: '请先粘贴密钥', icon: 'none' });
      return;
    }
    this._aiBusy = true;
    this.setData({ aiSaving: true });
    try {
      const ddb = wx.cloud.database();
      const payload = {
        key,
        baseUrl: String(this.data.ai.baseUrl || '').trim(),
        model: String(this.data.ai.model || '').trim(),
        updatedAt: Date.now()
      };
      const exist = await ddb.collection('aiConfig').limit(1).get().catch(() => ({ data: [] }));
      if (exist.data.length) {
        await ddb.collection('aiConfig').doc(exist.data[0]._id).update({ data: payload });
      } else {
        await ddb.collection('aiConfig').add({ data: payload });
      }
      this.setData({ aiSaved: true });
      this._aiDirty = false;
      // ocrScore 云函数超时要 ≥20s（模型调用 5~15s，默认 3s 必超时）。
      // CLI 无法改函数配置（2026-09-05 实测 deploy 不应用 config.json 的 timeout），
      // 只能提醒老师去控制台改一次。
      wx.showModal({
        title: '密钥已保存',
        content: '还有一步：微信开发者工具 → 云开发 → 云函数 ocrScore → 配置 → 超时时间改成 20 秒（默认 3 秒识别会超时）。改完拍照就能自动识别了。',
        showCancel: false,
        confirmText: '知道了'
      });
    } catch (e) {
      console.error('save aiConfig error', e);
      wx.showToast({ title: '保存失败', icon: 'none' });
    } finally {
      this._aiBusy = false;
      this.setData({ aiSaving: false });
    }
  },

  async onSave() {
    if (this._busy) return;
    if (!db.isCloudReady()) {
      wx.showToast({ title: '请先配置云环境', icon: 'none' });
      return;
    }
    const { school, className } = this.data.form;
    if (!String(school || '').trim() && !String(className || '').trim()) {
      wx.showToast({ title: '至少填学校或班级', icon: 'none' });
      return;
    }
    this._busy = true;
    this.setData({ saving: true });
    try {
      await classinfo.save(this.data.form);
      classinfo.clearCache(); // 让其他页面 onShow 时重读
      this._dirty = false;    // 已落库，之后可以正常接受云端刷新
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (e) {
      console.error('save classInfo error', e);
      // db 层的长度校验抛 validation：把原因给老师（否则只看到笼统「保存失败」，
      // 探针实测 500 字学校名被拦住但老师不知道该改哪个字段）
      wx.showToast({ title: e && e.validation ? e.message : '保存失败', icon: 'none', duration: 2600 });
    } finally {
      this._busy = false;
      this.setData({ saving: false });
    }
  }
});
