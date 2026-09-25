// 蘑菇老师 · 班主任工作台小程序入口
const cloud = wx.cloud;
const profile = require('./utils/profile.js');

// 登录门禁：首次启动（既没设过昵称、也没点过「暂不设置」）跳登录页。
// 为什么不做强制拦截：本项目数据靠 _openid 行级隔离，微信打开小程序时身份已经确定，
// 「登录」只决定界面上显示谁 —— 不授权也必须能用，把老师堵在门外是更严重的问题。
// 判定只读 storage（同步），不查云：onLaunch 里等云回包会白屏一下。
const LOGIN_PAGE = '/pages/login/login';

// 云环境 ID：开源克隆默认占位 → 演示模式（界面可预览、数据为空）。
// 本地开发在根目录建 env.local.js（已 gitignore）：module.exports = { envId: '你的环境ID' }
let envId = 'YOUR_ENV_ID';
try { envId = require('./env.local.js').envId || envId; } catch (e) {}

App({
  globalData: {
    openid: '',
    classInfo: null,
    envId,
    cloudReady: false
  },

  onLaunch() {
    this.gateLogin();
    if (!cloud) {
      console.error('当前微信版本不支持云开发');
      return;
    }
    const envId = this.globalData.envId;
    // 未配置有效 envId → 演示模式（无云数据库），不报错
    if (!envId || envId === 'YOUR_ENV_ID') {
      console.warn('未配置云环境 envId，进入演示模式（数据为空，仅供界面预览）');
      this.globalData.cloudReady = false;
      return;
    }
    try {
      cloud.init({ env: envId, traceUser: true });
      this.globalData.cloudReady = true;
      this.bootstrap();
    } catch (e) {
      console.error('云环境初始化失败，进入演示模式：', e);
      this.globalData.cloudReady = false;
    }
  },

  // 未登录 → 跳登录页。放 onLaunch 而不是各页 onShow：只判一次，
  // 不会在每次切 tab 时重复计算，也不会和自动化脚本的导航反复抢栈顶。
  gateLogin() {
    try {
      if (profile.isLoggedIn()) return;
      this.globalData.needLogin = true;
      wx.reLaunch({ url: LOGIN_PAGE, fail: () => { /* 页面未注册时不阻断启动 */ } });
    } catch (e) {
      console.warn('登录门禁判定失败，按已登录放行', e);
    }
  },

  async bootstrap() {
    await this.login();
    await this.ensureDb();
    // 云端身份回填放在最后：换手机后头像昵称能跟过来，失败也不影响任何功能
    try { await profile.pull(); } catch (e) { /* 忽略 */ }
  },

  // 首次启动：建集合 + 灌示例数据。
  // initdb 幂等（已存在则跳过）；seed 内部先 count，已有学生就返回 skipped 不重复灌。
  //
  // ⚠️ 标记必须带版本号，不能用布尔值：
  //    2026-09-06 加 teacherProfile 集合时实测踩到 —— 老 storage 里 mpInited=1，
  //    ensureDb 直接 return，新集合永远不建，云端同步一路报
  //    "Db or Table not exist"。每次新增集合把 SCHEMA_VER +1 即可让老用户补建。
  async ensureDb() {
    const SCHEMA_VER = 3;   // 2 → 3：新增 todos（待办清单）
    if (Number(wx.getStorageSync('mpInited')) >= SCHEMA_VER) return;
    try {
      const init = await cloud.callFunction({ name: 'initdb' });
      console.log('[initdb]', init && init.result);
      const seeded = await cloud.callFunction({ name: 'seed' });
      console.log('[seed]', seeded && seeded.result);
      wx.setStorageSync('mpInited', SCHEMA_VER);
    } catch (e) {
      console.warn('首次初始化未完成（界面仍可用，下次启动会重试）', e);
    }
  },

  async login() {
    try {
      const res = await cloud.callFunction({ name: 'login' });
      this.globalData.openid = (res.result && res.result.openid) || '';
    } catch (e) {
      console.warn('login 云函数调用失败，OPENID 暂缺（不影响使用）', e);
    }
  }
});
