// 教师身份（登录）：微信头像 + 昵称。
// --------------------------------------------------------------------------
// 为什么不用 wx.getUserProfile：微信 2022-10-25 起回收了该接口的真实数据，
// 现在调用只返回灰色默认头像和「微信用户」四个字。官方替代方案是
//   <button open-type="chooseAvatar">  拿头像（临时路径）
//   <input type="nickname">            拿昵称（键盘上方出现「使用微信昵称」）
// 两者都要基础库 2.21.2+（本项目 project.config.json libVersion 3.0.0，满足）。
//
// 为什么头像必须上传云存储：chooseAvatar 返回的是 wxfile:// 临时路径，
// 小程序重启后文件被清理 → 头像变裂图。所以保存时上传到云存储换成 cloud:// fileID，
// <image> 组件能直接渲染 cloud:// （基础库 2.2.3+ 且已开云开发）。
//
// 身份不是权限：本项目数据靠 _openid 行级隔离，登录只影响「界面上显示谁」，
// 不登录也能用（老师不愿授权时必须放行，把人堵在门外是更严重的问题）。

const db = require('./db.js');

const KEY = 'teacherProfile';        // storage key，同时也是云集合名
const AVATAR_DIR = 'teacher-avatar'; // 云存储目录

// 本地读取（同步，页面首屏直接用，不等云）
function getLocal() {
  try {
    const v = wx.getStorageSync(KEY);
    if (!v || typeof v !== 'object') return null;
    return {
      nickName: String(v.nickName || ''),
      avatar: String(v.avatar || ''),
      skipped: !!v.skipped,
      ts: Number(v.ts) || 0
    };
  } catch (e) {
    return null;
  }
}

// 门禁判定：设置过昵称，或明确选择了「暂不设置」→ 都算过门。
// 只认 storage 不查云：门禁跑在 onLoad 首屏，等云回包会白屏一下。
function isLoggedIn() {
  const p = getLocal();
  return !!(p && (p.nickName || p.skipped));
}

function displayName(p) {
  const q = p || getLocal();
  if (!q) return '未登录';
  return q.nickName || '未设置昵称';
}

function setLocal(patch) {
  const cur = getLocal() || { nickName: '', avatar: '', skipped: false, ts: 0 };
  const next = {
    nickName: patch.nickName !== undefined ? String(patch.nickName || '') : cur.nickName,
    avatar: patch.avatar !== undefined ? String(patch.avatar || '') : cur.avatar,
    skipped: patch.skipped !== undefined ? !!patch.skipped : cur.skipped,
    ts: Date.now()
  };
  try { wx.setStorageSync(KEY, next); } catch (e) { /* 存储满时忽略，内存里仍可用 */ }
  return next;
}

// 头像上传：wxfile:// 临时路径 → cloud:// fileID。
// 云未就绪（演示模式）时原样返回临时路径 —— 本次会话能看，重启会裂，但不报错。
async function uploadAvatar(tempPath) {
  const p = String(tempPath || '');
  if (!p) return '';
  if (p.indexOf('cloud://') === 0) return p;    // 已经是云文件，不重复上传
  if (!db.isCloudReady()) return p;
  const app = getApp();
  const openid = (app && app.globalData && app.globalData.openid) || 'anon';
  // 文件名带时间戳：同名覆盖在部分环境下会命中 CDN 缓存，换了头像还显示旧图
  const ext = (p.match(/\.(png|jpe?g|webp)$/i) || [, 'png'])[1].toLowerCase();
  const cloudPath = AVATAR_DIR + '/' + openid + '-' + Date.now() + '.' + ext;
  const res = await wx.cloud.uploadFile({ cloudPath, filePath: p });
  return (res && res.fileID) || p;
}

// 保存到云（teacherProfile 是单文档集合，按 _openid 隔离，和 classInfo 同一套写法）
async function saveCloud(data) {
  if (!db.isCloudReady()) return null;
  const rows = await db.list(KEY, {}, 1);
  const payload = {
    nickName: String(data.nickName || '').trim(),
    avatar: String(data.avatar || ''),
    updatedAt: Date.now()
  };
  if (rows.length && rows[0]._id) {
    await db.update(KEY, rows[0]._id, payload);
    return { ...rows[0], ...payload };
  }
  const id = await db.add(KEY, payload);
  return { _id: id, ...payload };
}

// 完整保存：上传头像 → 写云 → 写本地。任一步失败都不许丢掉本地（老师白填一遍最恼人）。
async function save({ nickName, avatarTemp }) {
  const name = String(nickName || '').trim();
  let avatar = '';
  let warn = '';
  if (avatarTemp) {
    try {
      avatar = await uploadAvatar(avatarTemp);
    } catch (e) {
      avatar = '';
      warn = '头像上传失败，昵称已保存';
    }
  }
  const local = setLocal({ nickName: name, avatar, skipped: false });
  try {
    await saveCloud({ nickName: name, avatar });
  } catch (e) {
    warn = warn || '已保存在本机，云端同步稍后重试';
  }
  return { profile: local, warn };
}

// 云端拉取并回填本地（换手机后头像昵称能跟过来）
async function pull() {
  if (!db.isCloudReady()) return getLocal();
  try {
    const rows = await db.list(KEY, {}, 1);
    if (!rows.length) return getLocal();
    const r = rows[0];
    const cur = getLocal();
    // 本地已有昵称且云端为空 → 不要用空值把本地覆盖掉
    if (!r.nickName && cur && cur.nickName) return cur;
    return setLocal({ nickName: r.nickName || '', avatar: r.avatar || '' });
  } catch (e) {
    return getLocal();
  }
}

// 「暂不设置」：过门禁但不算真登录，设置页仍提示可以补
function skip() {
  return setLocal({ skipped: true });
}

// 退出：清本地（云端记录保留，重新登录能拉回来）
function logout() {
  try { wx.removeStorageSync(KEY); } catch (e) { /* ignore */ }
}

module.exports = { KEY, getLocal, isLoggedIn, displayName, save, pull, skip, logout, uploadAvatar, setLocal };
