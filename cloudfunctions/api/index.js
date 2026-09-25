// ==========================================================================
// api 云函数 · 统一数据接口 v1
// --------------------------------------------------------------------------
// 设计：
//   1) 单入口 action 路由：客户端只调这一个函数，传 { action, payload }
//   2) 统一信封：{ code, message, data }
//      code = 0 成功；非 0 见下方错误码表
//   3) 鉴权：云函数绕过了小程序端的行级隔离，必须自己做——
//      每次写操作校验目标记录的 _openid === 调用者 OPENID，不匹配即 1002
//   4) 分页/排序/筛选：list 统一支持 page/pageSize(≤50)/orderBy/where
//   5) 与旧 db.js 客户端直连方案并存，页面可逐页迁移，出问题随时切回
//
// 错误码表（utils/api.js 与 docs/API.md 同步维护）：
//   0    成功
//   1001 参数缺失或非法（message 里带具体字段；含成绩/积分范围越界）
//   1002 未授权：只能操作自己的数据
//   1003 记录不存在
//   2001 集合名非法（只允许白名单内的集合）
//   5000 服务器内部错误（message 已脱敏，详情看云函数日志）
// ==========================================================================
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 集合白名单：与 initdb 云函数创建的 21+1 个集合保持一致
const COLLECTIONS = new Set([
  'students', 'attendance', 'announcements', 'homework', 'homeworkSubmit', 'todos',
  'rewards', 'grades', 'examPapers', 'examAnswers', 'profiles',
  'seats', 'dutySchedule', 'schedule', 'committee', 'classInfo', 'settings',
]);

// ---- 数值范围兜底（与 utils/validate.js 同一份规则，客户端可绕过所以服务端必须再拦一次）----
// 云函数不能 require 小程序端的 utils/，所以规则在这里复述一遍。
// 改动纪律：任一侧改了上限，tools/check.js 的 SCORE_MAX_FULL 一致性检查会报红。
const SCORE_MAX_FULL = 150;
const REWARD_MAX_POINTS = 100;
const SCORE_DECIMALS = 1;

function decimalsOf(n) {
  const s = String(n);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

// 严格十进制解析：Number('  ')=0 / Number('0x10')=16 / Number('1e5')=100000 会让垃圾值入库
// （2026-09-06 端侧探针实测：积分栏填 '0x10' 存成 16 分、'   ' 存成 0 分）。
// 这份规则必须与 utils/validate.js 逐条对齐 —— 端上能绕过，服务端是最后一道。
function strictInt(v) {
  const t = String(v === undefined || v === null ? '' : v).trim();
  if (!/^-?(0|[1-9]\d{0,8})$/.test(t)) return null;
  return Number(t);
}
function strictDec(v, dec) {
  const t = String(v === undefined || v === null ? '' : v).trim();
  const d = Math.max(0, Number(dec) || 0);
  const re = d > 0
    ? new RegExp('^-?(0|[1-9]\\d{0,3})(\\.\\d{1,' + d + '})?$')
    : /^-?(0|[1-9]\d{0,3})$/;
  return re.test(t) ? Number(t) : null;
}
function isRealDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), day = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, day));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === day;
}
function pickPhone(text) {
  const t = String(text || '');
  for (let i = 0; i + 11 <= t.length; i++) {
    if (i > 0 && t[i - 1] >= '0' && t[i - 1] <= '9') continue;
    const seg = t.slice(i, i + 11);
    if (!/^1[3-9]\d{9}$/.test(seg)) continue;
    const nx = t[i + 11];
    if (nx && nx >= '0' && nx <= '9') continue;
    return seg;
  }
  return '';
}

// 文本长度上限，与 utils/validate.js 的 TEXT_MAX 同源
const TEXT_MAX = {
  studentName: 20, studentNo: 12, annTitle: 60, annContent: 2000, todoTitle: 60,
  hwTitle: 60, hwContent: 2000, reason: 200, health: 500, parent: 100,
  school: 30, className: 20, exam: 20
};
const DUE_MAX_DAYS = 730;
const BIRTH_MIN_YEAR = 1990;

function assertLen(kind, v, label, required) {
  if (v === undefined) return '';
  const t = String(v === undefined || v === null ? '' : v).trim();
  if (!t) {
    if (required) throw { code: 1001, message: label + '不能为空' };
    return '';
  }
  const max = TEXT_MAX[kind] || 200;
  if (t.length > max) throw { code: 1001, message: `${label}最多 ${max} 个字（当前 ${t.length}）` };
  return t;
}

function assertRange(collection, data) {
  const d = data || {};
  if (collection === 'scores') {
    const full = Number(d.full);
    if (!Number.isFinite(full) || full <= 0 || full > SCORE_MAX_FULL) {
      throw { code: 1001, message: `满分只能是 1-${SCORE_MAX_FULL}` };
    }
    if (d.exam !== undefined) assertLen('exam', d.exam, '考试名称', false);
    if (d.score === undefined || d.score === null || d.score === '') return;
    const score = strictDec(d.score, SCORE_DECIMALS);
    if (score === null) {
      const raw = Number(d.score);
      if (!Number.isFinite(raw)) throw { code: 1001, message: '分数必须是数字' };
      if (raw < 0) throw { code: 1001, message: '分数不能是负数' };
      if (decimalsOf(raw) > SCORE_DECIMALS) throw { code: 1001, message: `分数最多保留 ${SCORE_DECIMALS} 位小数` };
      throw { code: 1001, message: '分数格式非法' };
    }
    if (score < 0) throw { code: 1001, message: '分数不能是负数' };
    if (score > full) throw { code: 1001, message: `分数 ${score} 超出满分 ${full}` };
    return;
  }
  if (collection === 'rewards') {
    assertLen('reason', d.reason, '事由', false);
    if (d.points === undefined || d.points === null || d.points === '') return;
    const p = strictInt(d.points);
    if (p === null) throw { code: 1001, message: '积分必须是整数' };
    if (p === 0) throw { code: 1001, message: '积分不能是 0' };
    if (Math.abs(p) > REWARD_MAX_POINTS) throw { code: 1001, message: `积分绝对值不能超过 ${REWARD_MAX_POINTS}` };
    return;
  }
  if (collection === 'students') {
    if (d.name !== undefined) assertLen('studentName', d.name, '姓名', true);
    if (d.studentNo !== undefined) {
      const no = assertLen('studentNo', d.studentNo, '学号', true);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(no)) throw { code: 1001, message: '学号要以字母或数字开头，只能用字母、数字、- 和 _' };
    }
    if (d.birth) {
      if (!isRealDate(d.birth)) throw { code: 1001, message: '出生日期要填真实日期，如 2011-01-01' };
      const y = Number(String(d.birth).slice(0, 4));
      const nowY = new Date().getFullYear();
      if (y < BIRTH_MIN_YEAR || y > nowY) throw { code: 1001, message: `出生年份要在 ${BIRTH_MIN_YEAR}-${nowY} 之间` };
    }
    if (d.parent !== undefined) {
      const p = assertLen('parent', d.parent, '家长信息', false);
      if (p && !pickPhone(p)) throw { code: 1001, message: '家长信息里要含 11 位手机号' };
    }
    if (d.health !== undefined) assertLen('health', d.health, '健康状况', false);
    return;
  }
  if (collection === 'announcements') {
    assertLen('annTitle', d.title, '标题', true);
    assertLen('annContent', d.content, '内容', true);
    return;
  }
  if (collection === 'todos') {
    assertLen('todoTitle', d.title, '待办内容', true);
    if (d.dueDate) {
      if (!isRealDate(d.dueDate)) throw { code: 1001, message: '日期格式应为 2026-09-30' };
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.dueDate);
      const now = new Date();
      const days = Math.round((Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
        - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
      if (days > 730) throw { code: 1001, message: '日期最远 730 天内' };
    }
    if (d.done !== undefined && typeof d.done !== 'boolean') throw { code: 1001, message: '完成标记必须是布尔值' };
    return;
  }
  if (collection === 'homework') {
    assertLen('hwTitle', d.title, '标题', true);
    assertLen('hwContent', d.content, '内容', false);
    const due = String(d.dueDate || '').trim();
    if (due) {
      if (!isRealDate(due)) throw { code: 1001, message: '截止日期格式应为 2026-09-30' };
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
      const now = new Date();
      const days = Math.round((Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
        - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
      if (days > DUE_MAX_DAYS) throw { code: 1001, message: `截止日期最远 ${DUE_MAX_DAYS} 天内` };
    }
    if (d.assignDate && !isRealDate(d.assignDate)) throw { code: 1001, message: '布置日期格式应为 2026-09-30' };
    return;
  }
  if (collection === 'classInfo') {
    assertLen('school', d.school, '学校', false);
    assertLen('className', d.className, '班级', false);
    assertLen('className', d.grade, '年级', false);
    assertLen('className', d.semester, '学期', false);
    assertLen('className', d.teacher, '教师', false);
    // 座位自定义行列：0=自动，行 1-12，列 1-10
    if (d.seatRows !== undefined && d.seatRows !== null) {
      const r = Number(d.seatRows);
      if (!Number.isInteger(r) || r < 0 || r > 12) throw { code: 1001, message: '座位行数需为 0-12 的整数' };
    }
    if (d.seatCols !== undefined && d.seatCols !== null) {
      const c = Number(d.seatCols);
      if (!Number.isInteger(c) || c < 0 || c > 10) throw { code: 1001, message: '座位列数需为 0-10 的整数' };
    }
  }
}

// 允许排序的字段白名单（防 NoSQL 注入式的 orderBy 注入）
const SORTABLE = new Set(['_id', 'createdAt', 'updatedAt', 'date', 'studentNo', 'score', 'priority']);

// 深校验 where：只允许普通对象 + 值为 基础类型/数组/普通对象，且键名不含点与 $ 开头
function sanitizeWhere(w) {
  if (w === undefined || w === null) return {};
  if (typeof w !== 'object' || Array.isArray(w)) throw { code: 1001, message: 'where 必须是普通对象' };
  const out = {};
  for (const k of Object.keys(w)) {
    if (k.includes('.') || k.startsWith('$')) throw { code: 1001, message: `where 字段名非法: ${k}` };
    const v = w[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = sanitizeWhere(v); // 允许 { age: { $gt: 10 } } 之外的一层嵌套（如 cmd 对象序列）
    } else {
      out[k] = v;
    }
  }
  return out;
}

function assertCollection(name) {
  if (!COLLECTIONS.has(name)) throw { code: 2001, message: `集合名非法: ${name}` };
}

function ok(data) { return { code: 0, message: 'ok', data }; }
function fail(e) {
  if (e && typeof e.code === 'number') return { code: e.code, message: e.message };
  console.error('[api] internal error:', e);
  return { code: 5000, message: '服务器开小差了，请稍后再试' };
}

// ---- 分页查询 ----
async function actList(payload) {
  assertCollection(payload.collection);
  const where = sanitizeWhere(payload.where);
  const pageSize = Math.min(Math.max(parseInt(payload.pageSize, 10) || 20, 1), 50);
  const page = Math.max(parseInt(payload.page, 10) || 1, 1);
  const orderBy = Array.isArray(payload.orderBy) ? payload.orderBy : [];
  let q = db.collection(payload.collection).where(where);
  for (const [field, dir] of orderBy) {
    if (!SORTABLE.has(field) || !['asc', 'desc'].includes(dir)) {
      throw { code: 1001, message: `排序参数非法: ${field} ${dir}` };
    }
    q = q.orderBy(field, dir);
  }
  const [listRes, countRes] = await Promise.all([
    q.skip((page - 1) * pageSize).limit(pageSize).get(),
    db.collection(payload.collection).where(where).count(),
  ]);
  return ok({
    list: listRes.data,
    total: countRes.total,
    page,
    pageSize,
    hasMore: page * pageSize < countRes.total,
  });
}

// ---- 单条查询 ----
async function actGet(payload) {
  assertCollection(payload.collection);
  if (!payload.id) throw { code: 1001, message: '缺少 id' };
  const res = await db.collection(payload.collection).doc(payload.id).get()
    .catch(() => ({ data: null }));
  if (!res.data) throw { code: 1003, message: '记录不存在' };
  return ok(res.data);
}

// ---- 新增 ----
async function actAdd(payload, openid) {
  assertCollection(payload.collection);
  const data = payload.data;
  if (!data || typeof data !== 'object') throw { code: 1001, message: '缺少 data' };
  assertRange(payload.collection, data);
  delete data._openid; // 防伪造
  const now = Date.now();
  const res = await db.collection(payload.collection).add({
    data: { ...data, _openid: openid, createdAt: now, updatedAt: now },
  });
  return ok({ id: res._id });
}

// ---- 更新（带所有权校验）----
async function actUpdate(payload, openid) {
  assertCollection(payload.collection);
  if (!payload.id) throw { code: 1001, message: '缺少 id' };
  const data = payload.data;
  if (!data || typeof data !== 'object') throw { code: 1001, message: '缺少 data' };
  const col = db.collection(payload.collection);
  const cur = await col.doc(payload.id).get().catch(() => ({ data: null }));
  if (!cur.data) throw { code: 1003, message: '记录不存在' };
  if (cur.data._openid !== openid) throw { code: 1002, message: '只能修改自己的数据' };
  // 局部更新（如只改 score 不带 full）必须与库里现值合并后再判范围，
  // 否则「单独把 score 改成 9999」这条路径能绕过校验
  assertRange(payload.collection, { ...cur.data, ...data });
  delete data._openid; delete data._id; delete data.createdAt;
  await col.doc(payload.id).update({ data: { ...data, updatedAt: Date.now() } });
  return ok({ updated: 1 });
}

// ---- 删除（带所有权校验 + 可选级联）----
async function actRemove(payload, openid) {
  assertCollection(payload.collection);
  if (!payload.id) throw { code: 1001, message: '缺少 id' };
  const col = db.collection(payload.collection);
  const cur = await col.doc(payload.id).get().catch(() => ({ data: null }));
  if (!cur.data) throw { code: 1003, message: '记录不存在' };
  if (cur.data._openid !== openid) throw { code: 1002, message: '只能删除自己的数据' };
  await col.doc(payload.id).remove();
  return ok({ removed: 1 });
}

// ---- 统计 ----
async function actCount(payload) {
  assertCollection(payload.collection);
  const where = sanitizeWhere(payload.where);
  const res = await db.collection(payload.collection).where(where).count();
  return ok({ total: res.total });
}

// ---- 批量写（同一集合多条 add，事务保证：要么全成要么全不进）----
async function actBatchAdd(payload, openid) {
  assertCollection(payload.collection);
  const items = payload.items;
  if (!Array.isArray(items) || !items.length) throw { code: 1001, message: '缺少 items 数组' };
  if (items.length > 50) throw { code: 1001, message: '单次批量上限 50 条' };
  const col = payload.collection;
  const now = Date.now();
  const result = await db.runTransaction(async (transaction) => {
    const ids = [];
    for (const item of items) {
      assertRange(col, item);
      delete item._openid;
      const r = await transaction.collection(col).add({
        data: { ...item, _openid: openid, createdAt: now, updatedAt: now },
      });
      ids.push(r._id);
    }
    return ids;
  });
  return ok({ ids: result, added: items.length });
}

const ACTIONS = {
  list: actList,
  get: actGet,
  add: actAdd,
  update: actUpdate,
  remove: actRemove,
  count: actCount,
  batchAdd: actBatchAdd,
};

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext();
    if (!OPENID) throw { code: 1002, message: '无法识别调用者身份' };
    const action = event.action;
    if (!ACTIONS[action]) {
      throw { code: 1001, message: `未知 action: ${action}（可用: ${Object.keys(ACTIONS).join('/')}）` };
    }
    return await ACTIONS[action](event.payload || {}, OPENID);
  } catch (e) {
    return fail(e);
  }
};
