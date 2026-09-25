// 守护 utils/profile.js：教师身份（微信头像 + 昵称）。
// 为什么必须 Node 单测：
//   ① chooseAvatar / type="nickname" 在模拟器里点不出真数据，e2e 只能验界面在不在；
//   ② 门禁判定（isLoggedIn）决定「首启跳不跳登录页」，判错就是白屏或永远进不去；
//   ③ 头像上传失败、云端为空、storage 写满这些分支，真机上撞不到，只能模拟。

let storage = {};
let uploaded = [];
let uploadShouldFail = false;

global.wx = {
  getStorageSync: k => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => { storage[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: k => { delete storage[k]; },
  cloud: {
    uploadFile: async ({ cloudPath, filePath }) => {
      if (uploadShouldFail) throw new Error('upload fail');
      uploaded.push({ cloudPath, filePath });
      return { fileID: 'cloud://env.abc/' + cloudPath };
    }
  }
};

// db.js 的替身：只实现 profile.js 用到的四个方法
let cloudReady = true;
let cloudRows = [];
let cloudOps = [];
let cloudShouldFail = false;
const dbStub = {
  isCloudReady: () => cloudReady,
  list: async () => { if (cloudShouldFail) throw new Error('list fail'); return cloudRows.slice(); },
  add: async (c, d) => { if (cloudShouldFail) throw new Error('add fail'); cloudOps.push(['add', c, d]); cloudRows = [{ _id: 'ID1', ...d }]; return 'ID1'; },
  update: async (c, id, d) => { if (cloudShouldFail) throw new Error('update fail'); cloudOps.push(['update', c, id, d]); cloudRows = [{ ...cloudRows[0], ...d }]; return 1; }
};

const path = require('path');
const DBP = path.resolve(__dirname, '..', 'utils', 'db.js');
const PP = path.resolve(__dirname, '..', 'utils', 'profile.js');
require.cache[DBP] = { id: DBP, filename: DBP, loaded: true, exports: dbStub };
delete require.cache[PP];
global.getApp = () => ({ globalData: { openid: 'oABC123', cloudReady } });
const profile = require(PP);

let pass = 0, fail = 0;
const ok = m => { pass++; console.log('  ✅ ' + m); };
const bad = m => { fail++; console.log('  ❌ ' + m); };
const reset = () => { storage = {}; uploaded = []; cloudRows = []; cloudOps = []; cloudReady = true; uploadShouldFail = false; cloudShouldFail = false; };

// ---------- 门禁判定 ----------
reset();
profile.isLoggedIn() === false ? ok('全新用户 isLoggedIn=false（会跳登录页）') : bad('全新用户被判成已登录 → 登录页永远不出现');
profile.getLocal() === null ? ok('无记录时 getLocal 返回 null') : bad('getLocal 应返回 null: ' + JSON.stringify(profile.getLocal()));
profile.displayName() === '未登录' ? ok('displayName 无记录 → 未登录') : bad('displayName: ' + profile.displayName());

reset();
profile.setLocal({ nickName: '胡老师' });
profile.isLoggedIn() === true ? ok('设过昵称 → isLoggedIn=true') : bad('设过昵称仍判未登录');
profile.displayName() === '胡老师' ? ok('displayName=胡老师') : bad('displayName: ' + profile.displayName());

reset();
profile.skip();
profile.isLoggedIn() === true ? ok('点过「暂不设置」也算过门（不许把老师堵在门外）') : bad('skip 后仍跳登录页 → 死循环进不去');
profile.displayName() === '未设置昵称' ? ok('skip 后 displayName=未设置昵称') : bad('displayName: ' + profile.displayName());

// storage 里是脏数据（字符串/数字）不能崩
reset();
storage[profile.KEY] = 'not-an-object';
profile.getLocal() === null ? ok('storage 脏数据（字符串）→ 当无记录，不崩') : bad('脏数据未兜底: ' + JSON.stringify(profile.getLocal()));
storage[profile.KEY] = { nickName: 123, avatar: null, skipped: 'yes' };
const dirty = profile.getLocal();
(dirty.nickName === '123' && dirty.avatar === '' && dirty.skipped === true)
  ? ok('storage 字段类型异常 → 强制归一（数字转串、null 转空）')
  : bad('归一失败: ' + JSON.stringify(dirty));

// ---------- 头像上传 ----------
(async () => {
  reset();
  const fid = await profile.uploadAvatar('wxfile://tmp_avatar.png');
  fid.indexOf('cloud://') === 0 ? ok('临时路径上传后换成 cloud:// fileID') : bad('未换成 cloud://: ' + fid);
  // ⚠️ 必须先判 uploaded 非空再取 [0]：变异体「跳过上传」会让数组为空，
  //    直接取属性会抛 TypeError → 整个单测进程崩溃，mutate 判成 NO_RUN 而不是 KILLED
  //    （2026-09-06 实测踩到，变异体 login-avatar-temp 因此漏杀）。
  uploaded.length === 1
    ? (/teacher-avatar\/oABC123-\d+\.png$/.test(uploaded[0].cloudPath)
        ? ok('云路径含 openid + 时间戳（防 CDN 缓存旧头像）: ' + uploaded[0].cloudPath)
        : bad('云路径不对: ' + uploaded[0].cloudPath))
    : bad('头像没上传到云存储（uploaded 为空）→ 临时路径重启后裂图');

  reset();
  const already = await profile.uploadAvatar('cloud://env.abc/x.png');
  (already === 'cloud://env.abc/x.png' && uploaded.length === 0)
    ? ok('已是 cloud:// 的头像不重复上传') : bad('重复上传了 ' + uploaded.length + ' 次');

  reset();
  (await profile.uploadAvatar('')) === '' ? ok('空路径返回空串，不发请求') : bad('空路径处理错');

  reset();
  cloudReady = false;
  const demo = await profile.uploadAvatar('wxfile://tmp.png');
  (demo === 'wxfile://tmp.png' && uploaded.length === 0)
    ? ok('演示模式（云未就绪）原样返回临时路径，不报错') : bad('演示模式处理错: ' + demo);

  // ---------- save 全链路 ----------
  reset();
  const r1 = await profile.save({ nickName: '  胡老师  ', avatarTemp: 'wxfile://a.png' });
  r1.profile.nickName === '胡老师' ? ok('save 去掉昵称首尾空格') : bad('未 trim: [' + r1.profile.nickName + ']');
  r1.profile.avatar.indexOf('cloud://') === 0 ? ok('save 后本地存的是 cloud:// 地址') : bad('本地存了临时路径: ' + r1.profile.avatar);
  !r1.warn ? ok('一切正常时无警告') : bad('意外警告: ' + r1.warn);
  cloudOps.some(o => o[0] === 'add' && o[1] === 'teacherProfile')
    ? ok('首次 save 走 add，集合名 teacherProfile') : bad('云写入不对: ' + JSON.stringify(cloudOps));
  // ⚠️ 这里必须从「已跳过」状态出发才测得出来：reset() 后 storage 为空，
  //    setLocal 默认 skipped=false，不传 skipped 也是 false —— 变异体因此 SURVIVED
  //    （2026-09-06 实测）。真实场景是「先点跳过，后来在设置页补了真昵称」。
  reset();
  profile.skip();
  profile.getLocal().skipped === true ? ok('前置：先点「暂不设置」，skipped=true') : bad('前置失败');
  await profile.save({ nickName: '补填老师', avatarTemp: '' });
  const afterFix = profile.getLocal();
  (afterFix.skipped === false && afterFix.nickName === '补填老师')
    ? ok('跳过后再补填真昵称 → skipped 复位为 false（状态不再卡在"跳过"）')
    : bad('skipped 未复位: ' + JSON.stringify(afterFix));

  // 第二次 save 必须 update 不是 add（否则云端每次多一条，单文档集合被撑成流水）
  cloudOps = [];
  await profile.save({ nickName: '胡老师2', avatarTemp: '' });
  (cloudOps.length === 1 && cloudOps[0][0] === 'update')
    ? ok('已有记录时 save 走 update（单文档集合不许追加）') : bad('第二次写入不对: ' + JSON.stringify(cloudOps));

  // 头像上传失败：昵称必须保住
  reset();
  uploadShouldFail = true;
  const r2 = await profile.save({ nickName: '张老师', avatarTemp: 'wxfile://x.png' });
  (r2.profile.nickName === '张老师' && /头像上传失败/.test(r2.warn || ''))
    ? ok('头像上传失败 → 昵称仍保存 + 明确告知（不让老师白填）') : bad('失败处理不对: ' + JSON.stringify(r2));
  r2.profile.avatar === '' ? ok('上传失败不把临时路径当持久值存下来（重启会裂图）') : bad('存了临时路径: ' + r2.profile.avatar);

  // 云端写入失败：本地必须已保存
  reset();
  cloudShouldFail = true;
  const r3 = await profile.save({ nickName: '李老师', avatarTemp: '' });
  (profile.getLocal().nickName === '李老师' && /本机|稍后/.test(r3.warn || ''))
    ? ok('云端失败 → 本地已存 + 提示稍后同步（离线可用）') : bad('云失败处理不对: ' + JSON.stringify(r3) + ' local=' + JSON.stringify(profile.getLocal()));
  profile.isLoggedIn() === true ? ok('云端失败也算登录成功（不许卡在登录页）') : bad('云失败导致进不去');

  // ---------- pull 回填 ----------
  reset();
  cloudRows = [{ _id: 'ID1', nickName: '云端老师', avatar: 'cloud://env/y.png' }];
  const p1 = await profile.pull();
  (p1.nickName === '云端老师' && p1.avatar === 'cloud://env/y.png')
    ? ok('pull 把云端身份回填本地（换手机能跟过来）') : bad('pull 回填失败: ' + JSON.stringify(p1));

  // 云端为空不许把本地覆盖成空（真实事故形态：换手机第一次启动云还没写就被清空）
  reset();
  profile.setLocal({ nickName: '本机老师' });
  cloudRows = [{ _id: 'ID1', nickName: '', avatar: '' }];
  const p2 = await profile.pull();
  p2.nickName === '本机老师' ? ok('云端为空不覆盖本地昵称') : bad('本地被空值覆盖: ' + JSON.stringify(p2));

  reset();
  profile.setLocal({ nickName: '本机老师' });
  cloudShouldFail = true;
  const p3 = await profile.pull();
  p3.nickName === '本机老师' ? ok('pull 失败返回本地值，不抛错') : bad('pull 失败处理不对: ' + JSON.stringify(p3));

  reset();
  cloudReady = false;
  profile.setLocal({ nickName: '演示老师' });
  (await profile.pull()).nickName === '演示老师' ? ok('演示模式 pull 直接返回本地') : bad('演示模式 pull 不对');

  // ---------- logout ----------
  reset();
  profile.setLocal({ nickName: '胡老师', avatar: 'cloud://x' });
  profile.logout();
  (profile.getLocal() === null && profile.isLoggedIn() === false)
    ? ok('logout 清本地并回到未登录（云端记录保留，重登能拉回）') : bad('logout 没清干净');

  console.log(`\nprofile: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
