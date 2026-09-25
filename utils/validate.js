// 写库前的数值兜底校验（第二层防线）
// --------------------------------------------------------------------------
// 为什么要单独一层：页面校验只覆盖「老师手输」这一条路径，
// 但 scores 还有「拍照 OCR 回填」「粘贴文本批量填分」两条自动路径，
// 各自再写一遍校验必然漂移（rewards 页就是各写一遍，积分上限只在表单里拦）。
// 所以把范围规则收到 db.add/db.update 的入口上，任何路径写库都过同一把关。
// 实测动因（2026-09-06 真机探针）：满分字段允许填到 1000，于是 score=1000 合法入库。
//
// ⚠️ 这不是「服务端校验」—— 小程序端直连数据库，客户端一律可绕过。
//    真正的服务端兜底在 cloudfunctions/api/index.js（同一份规则，见 SCORE_MAX_FULL）。
//
// 2026-09-06 第二轮边界探针又抓到一类共性问题：**到处直接用 Number()**。
//   Number('   ')=0 / Number('007')=7 / Number('0x10')=16 / Number('+8')=8 / Number('1e5')=100000
//   → 纯空格能存成 0 分、十六进制能存成 16 分。所以数字入口统一走 strictInt/strictDec，
//     不再让 JS 的隐式转换替老师「猜」他想填什么。

// 单科满分的现实上限：150（语数外 150 制是国内最高的单科满分）。
// 不放到 1000：那不是「兼容总分」而是「关掉校验」——总分统计是另一个功能，不该借满分字段实现。
const SCORE_MAX_FULL = 150;
const REWARD_MAX_POINTS = 100;

// 小数位：成绩允许 .5（半分），不允许 9.99999 这种（探针实测能入库）
const SCORE_DECIMALS = 1;

// 文本长度上限（字符数）。上限来自「卡片能显示多少」而不是「数据库能存多少」：
// 探针实测公告标题 500 字 / 正文 20000 字 / 姓名 200 字都能入库，列表页直接被撑爆。
const TEXT_MAX = {
  studentName: 20,
  studentNo: 12,
  annTitle: 60,
  annContent: 2000,
  todoTitle: 60,
  hwTitle: 60,
  hwContent: 2000,
  reason: 200,
  health: 500,
  parent: 100,
  school: 30,
  className: 20,
  exam: 20,
  nickName: 20
};

// 截止日最远两年：探针实测能填 2999-12-31，卡片显示「还有 355497 天」。
const DUE_MAX_DAYS = 730;
// 出生年份合理区间（中小学生）
const BIRTH_MIN_YEAR = 1990;

// 严格十进制整数：拒绝 '' / '   ' / '007' / '+8' / '0x10' / '1e5' / '五' / 'Infinity'
// 返回 Number 或 null。允许负号（惩戒分在 db 层是负数）。
function strictInt(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!/^-?(0|[1-9]\d{0,8})$/.test(s)) return null;
  return Number(s);
}

// 严格十进制小数（整数位 ≤4，小数位 ≤decimals）：拒绝 '1e2' / '.5' / '5.' / '007.5'
function strictDec(v, decimals) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  const d = Math.max(0, Number(decimals) || 0);
  const re = d > 0
    ? new RegExp('^-?(0|[1-9]\\d{0,3})(\\.\\d{1,' + d + '})?$')
    : /^-?(0|[1-9]\d{0,3})$/;
  if (!re.test(s)) return null;
  return Number(s);
}

// 真实存在的日期：'2011-13-45' / '0000-00-00' / '2026-02-30' 都要拒（只验格式会放过）
function isRealDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// 抠手机号：必须两侧不挨数字，否则 '139000088888'（12 位）会匹配出前 11 位，
// 一键拨号就拨错人（探针实测）。不用 lookbehind —— iOS 16.4 以下基础库不支持。
function pickPhone(text) {
  const s = String(text || '');
  for (let i = 0; i + 11 <= s.length; i++) {
    if (i > 0 && s[i - 1] >= '0' && s[i - 1] <= '9') continue;
    const seg = s.slice(i, i + 11);
    if (!/^1[3-9]\d{9}$/.test(seg)) continue;
    const next = s[i + 11];
    if (next && next >= '0' && next <= '9') continue;
    return seg;
  }
  return '';
}

// 文本清洗 + 长度判定：返回 { text, why }
function checkText(kind, v, required) {
  const max = TEXT_MAX[kind] || 200;
  const t = String(v === undefined || v === null ? '' : v).trim();
  if (!t) return { text: '', why: required ? '不能为空' : null };
  if (t.length > max) return { text: t, why: `最多 ${max} 个字（当前 ${t.length}）` };
  return { text: t, why: null };
}

function decimalsOf(n) {
  const s = String(n);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

// 返回 null = 通过；返回字符串 = 拒绝理由（可直接 toast）
function checkScore(data) {
  const full = Number(data.full);
  if (!Number.isFinite(full) || full <= 0 || full > SCORE_MAX_FULL) {
    return `满分只能是 1-${SCORE_MAX_FULL}`;
  }
  // score 允许缺省（清空成绩走的是 remove，不会带 score 进来）
  if (data.score === undefined || data.score === null || data.score === '') return null;
  // strictDec 一次挡掉 '1e2'（探针实测写成 100）/ '  ' / '007' / '88.888'
  const score = strictDec(data.score, SCORE_DECIMALS);
  if (score === null) {
    const raw = Number(data.score);
    if (!Number.isFinite(raw)) return '分数必须是数字';
    if (raw < 0) return '分数不能是负数';
    if (decimalsOf(raw) > SCORE_DECIMALS) return `分数最多保留 ${SCORE_DECIMALS} 位小数`;
    return '分数请填 0-' + Math.min(SCORE_MAX_FULL, Number(data.full) || SCORE_MAX_FULL) + ' 的数字';
  }
  if (score < 0) return '分数不能是负数';
  if (score > full) return `分数 ${score} 超出满分 ${full}`;
  if (decimalsOf(score) > SCORE_DECIMALS) return `分数最多保留 ${SCORE_DECIMALS} 位小数`;
  return null;
}

function checkReward(data) {
  if (data.points === undefined || data.points === null || data.points === '') return null;
  // 严格解析：Number('   ')=0、Number('0x10')=16 都会被 strictInt 拒掉（探针实测这两个能入库）
  const p = strictInt(data.points);
  if (p === null) return '积分必须是整数';
  if (p === 0) return '积分不能是 0';   // 0 分记录既不是奖励也不是惩戒，只会污染统计
  if (Math.abs(p) > REWARD_MAX_POINTS) return `积分绝对值不能超过 ${REWARD_MAX_POINTS}`;
  const reason = checkText('reason', data.reason, false);
  if (reason.why) return '事由' + reason.why;
  return null;
}

// 学生：姓名/学号长度。学号必须允许前导零（'007' 是合法学号），所以按字符串规则判，
// 不能用 strictInt —— 但要挡住 200 位纯数字学号（探针实测：它会把 AI 名单的起始学号
// 变成 '1e+200'，后续分配出 '1200' 这种错号）。
function checkStudent(data) {
  if (data.name !== undefined) {
    const n = checkText('studentName', data.name, true);
    if (n.why) return '姓名' + n.why;
  }
  if (data.studentNo !== undefined) {
    const no = String(data.studentNo || '').trim();
    if (!no) return '学号不能为空';
    if (no.length > TEXT_MAX.studentNo) return `学号最多 ${TEXT_MAX.studentNo} 位（当前 ${no.length}）`;
    // 允许连字符（'3-1-05' 这种班级+序号的学号很常见），但不许以它开头 ——
    // '-1' 看着像负数，进 AI 名单起号/排序时会被当成异常值（探针实测 '-1' 能入库）
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(no)) return '学号要以字母或数字开头，只能用字母、数字、- 和 _';
  }
  if (data.birth) {
    if (!isRealDate(data.birth)) return '出生日期要填真实日期，如 2011-01-01';
    const y = Number(String(data.birth).slice(0, 4));
    const nowY = new Date().getFullYear();
    if (y < BIRTH_MIN_YEAR || y > nowY) return `出生年份要在 ${BIRTH_MIN_YEAR}-${nowY} 之间`;
  }
  if (data.parent !== undefined) {
    const p = checkText('parent', data.parent, false);
    if (p.why) return '家长信息' + p.why;
    if (p.text && !pickPhone(p.text)) return '家长信息里要含 11 位手机号';
  }
  if (data.health !== undefined) {
    const h = checkText('health', data.health, false);
    if (h.why) return '健康状况' + h.why;
  }
  return null;
}

function checkAnnouncement(data) {
  const t = checkText('annTitle', data.title, true);
  if (t.why) return '标题' + t.why;
  const c = checkText('annContent', data.content, true);
  if (c.why) return '内容' + c.why;
  return null;
}

// 待办：标题必填 ≤60 字；日期可空（无日期的想法也能记），填了必须是真实日期且 ≤730 天
// ⚠️ title 只在「传了」时校验：勾选完成走部分更新 update(id,{done})（与 checkStudent 同模式）。
//    add 的必填防线在页面 onAdd（checkText required）+ 云函数 api 的 actAdd（assertLen required）。
function checkTodo(data) {
  if (data.title !== undefined) {
    const t = checkText('todoTitle', data.title, true);
    if (t.why) return '待办' + t.why;
  }
  const due = String(data.dueDate || '').trim();
  if (due) {
    if (!isRealDate(due)) return '日期格式应为 2026-09-30';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
    const now = new Date();
    const days = Math.round((Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
      - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
    if (days > DUE_MAX_DAYS) return `日期最远 ${DUE_MAX_DAYS} 天内`;
  }
  if (data.done !== undefined && typeof data.done !== 'boolean') return '完成标记必须是布尔值';
  return null;
}

function checkHomework(data) {
  const t = checkText('hwTitle', data.title, true);
  if (t.why) return '标题' + t.why;
  const c = checkText('hwContent', data.content, false);
  if (c.why) return '内容' + c.why;
  const due = String(data.dueDate || '').trim();
  if (due) {
    // 探针实测：'2026-9-6' 能入库，卡片就不显示「还有 N 天」而是打印原始字符串
    if (!isRealDate(due)) return '截止日期格式应为 2026-09-30';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
    const t0 = new Date();
    const days = Math.round((Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
      - Date.UTC(t0.getFullYear(), t0.getMonth(), t0.getDate())) / 86400000);
    if (days > DUE_MAX_DAYS) return `截止日期最远 ${DUE_MAX_DAYS} 天内`;
  }
  if (data.assignDate && !isRealDate(data.assignDate)) return '布置日期格式应为 2026-09-30';
  return null;
}

// 教师身份：昵称长度 + 头像必须是可渲染的地址。
// 为什么校验头像：chooseAvatar 给的是 wxfile:// 临时路径，重启后文件被清理 → 头像裂图。
// 正常路径应该已上传成 cloud://，这里挡住把临时路径当持久值写进云端。
function checkTeacherProfile(data) {
  if (data.nickName !== undefined) {
    const n = checkText('nickName', data.nickName, false);
    if (n.why) return '昵称' + n.why;
  }
  if (data.avatar !== undefined) {
    const a = String(data.avatar || '').trim();
    if (a && !/^(cloud:\/\/|https:\/\/)/.test(a)) return '头像地址无效（临时文件不能存云端）';
    if (a.length > 500) return '头像地址过长';
  }
  return null;
}

function checkClassInfo(data) {
  for (const [k, label] of [['school', '学校'], ['className', '班级'], ['grade', '年级'], ['semester', '学期'], ['teacher', '教师']]) {
    if (data[k] === undefined) continue;
    const kind = k === 'school' ? 'school' : 'className';
    const r = checkText(kind, data[k], false);
    if (r.why) return label + r.why;
  }
  // 座位自定义行列：0=自动，行数 1-12，列数 1-10（教室现实上限）
  if (data.seatRows !== undefined) {
    const n = Number(data.seatRows);
    if (!Number.isInteger(n) || n < 0 || n > 12) return '座位行数需为 0-12 的整数';
  }
  if (data.seatCols !== undefined) {
    const n = Number(data.seatCols);
    if (!Number.isInteger(n) || n < 0 || n > 10) return '座位列数需为 0-10 的整数';
  }
  return null;
}

const RULES = {
  scores: checkScore,
  rewards: checkReward,
  students: checkStudent,
  announcements: checkAnnouncement,
  todos: checkTodo,
  homework: checkHomework,
  classInfo: checkClassInfo,
  teacherProfile: checkTeacherProfile
};

// collection 没有规则 = 直接通过（不做「未知集合一律拒绝」，那会挡住其余 19 个集合的正常写入）
function check(collection, data) {
  const fn = RULES[collection];
  if (!fn) return null;
  return fn(data || {});
}

module.exports = {
  check,
  SCORE_MAX_FULL, REWARD_MAX_POINTS, SCORE_DECIMALS,
  TEXT_MAX, DUE_MAX_DAYS, BIRTH_MIN_YEAR,
  strictInt, strictDec, isRealDate, pickPhone, checkText
};
