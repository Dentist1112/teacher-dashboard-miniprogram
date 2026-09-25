// 班级信息单例：一份数据供所有页面显示，避免写死在各个 WXML 里（曾出现两处学校名写法不一致）
const db = require('./db.js');

const DEFAULT = { school: '', className: '', grade: '', semester: '', teacher: '', seatRows: 0, seatCols: 0 };
let cache = null;
let inflight = null;

function title(info) {
  const i = info || {};
  const parts = [i.school, i.className].filter(x => String(x || '').trim());
  return parts.length ? parts.join(' · ') : '未设置班级信息';
}

// 读取（带进程内缓存，多页面并发只打一次云）
async function get(force) {
  if (!force && cache) return cache;
  if (!db.isCloudReady()) return { ...DEFAULT, _id: '' };
  if (inflight && !force) return inflight;
  inflight = (async () => {
    try {
      const rows = await db.list('classInfo', {}, 1);
      cache = rows.length ? rows[0] : { ...DEFAULT, _id: '' };
    } catch (e) {
      console.error('classInfo 读取失败', e);
      cache = { ...DEFAULT, _id: '' };
    }
    inflight = null;
    return cache;
  })();
  return inflight;
}

// 保存：有 _id 则更新，否则新建（classInfo 是单文档集合）
// 长度上限交给 db 层的 validate（wxml 上的 maxlength 只挡键盘输入，
// 程序化 setData / 粘贴长文本能绕过 —— 探针实测 500 字学校名入库）
async function save(patch) {
  const cur = await get();
  const payload = {
    school: String(patch.school || '').trim(),
    className: String(patch.className || '').trim(),
    grade: String(patch.grade || '').trim(),
    semester: String(patch.semester || '').trim(),
    teacher: String(patch.teacher || '').trim()
  };
  // 座位行列是数字字段：设置页保存文字时不带它们，必须沿用现值，否则会把座位布局清零
  payload.seatRows = normLayout(patch.seatRows !== undefined ? patch.seatRows : (cur && cur.seatRows), 12);
  payload.seatCols = normLayout(patch.seatCols !== undefined ? patch.seatCols : (cur && cur.seatCols), 10);
  if (cur && cur._id) {
    await db.update('classInfo', cur._id, payload);
    cache = { ...cur, ...payload };
  } else {
    const id = await db.add('classInfo', payload);
    cache = { _id: id, ...payload };
  }
  return cache;
}

// 只存座位行列布局，不动学校/班级等文字字段（座位页 stepper 调用）
async function saveLayout(rows, cols) {
  const cur = await get();
  return save({
    school: cur.school, className: cur.className, grade: cur.grade,
    semester: cur.semester, teacher: cur.teacher,
    seatRows: rows, seatCols: cols
  });
}

// 0 = 未设置（自动）；其余夹紧到 1..max，非法值归零
function normLayout(v, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(1, Math.min(max, Math.round(n)));
}

function clearCache() { cache = null; }

module.exports = { get, save, saveLayout, title, clearCache, DEFAULT, normLayout };
