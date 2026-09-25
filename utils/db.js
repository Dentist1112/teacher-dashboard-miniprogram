// 云数据库封装（按 _openid 自动隔离）
// 设计目标：在未配置云环境（如测试号、尚未填 envId）时优雅降级为「演示模式」，
// 不抛错、不崩页，返回空数据并在 UI 上提示，待配置真实 AppID + envId 后自动生效。

const validate = require('./validate.js');

// 写库前统一过一遍数值范围校验：页面/OCR/粘贴 三条路径共用同一把关，
// 各自再写一遍必然漂移（实测：满分字段能填 1000 → score=1000 合法入库）。
function assertValid(name, data) {
  const why = validate.check(name, data);
  if (why) {
    const e = new Error(why);
    e.validation = true;      // 页面可据此直接 toast 原因，而不是笼统「保存失败」
    throw e;
  }
}

function isCloudReady() {
  const app = getApp();
  return !!(app && app.globalData && app.globalData.cloudReady);
}

// 占位命令：云未就绪时让 _.neq(...) 这类写法不报错（返回透传条件）
function placeholderCmd() {
  return new Proxy({}, {
    get(_t, prop) {
      return (val) => ({ [prop]: val });
    }
  });
}

let _db = null;
let _cmd = null;

function getDb() {
  if (!_db) _db = wx.cloud.database();
  return _db;
}

function getCmd() {
  if (_cmd) return _cmd;
  try {
    _cmd = wx.cloud.database().command;
  } catch (e) {
    _cmd = placeholderCmd();
  }
  return _cmd;
}

// 小程序端单次 get 最多返回 20 条（云函数端 100），.limit(100) 会被静默截断，
// 所以必须分页循环取，否则 30 人的班级只显示 20 个。
const PAGE = 20;

// 性能打点：list() 的调用次数/耗时/返回条数。
// 为什么打在这里而不是 hook wx.cloud.database：db.js 缓存了 _db 单例，
// 探针在外层 patch 抓到 0 次（2026-09-06 实测两版探针都空转，白跑 2 分钟）。
const perf = { n: 0, ms: 0, detail: [] };
function perfReset() { perf.n = 0; perf.ms = 0; perf.detail = []; }
function perfDump() { return { n: perf.n, ms: perf.ms, detail: perf.detail.slice() }; }
// 挂到全局：automator 的 evaluate 跑在小程序 runtime 里，拿不到 require 出来的模块引用。
// 只暴露读/清两个纯函数，不暴露内部对象（避免测试脚本反过来篡改业务状态）。
try { globalThis.__dbperf = { reset: perfReset, dump: perfDump }; } catch (e) { /* 环境无 globalThis 时忽略 */ }

// IDE 模拟器的云调用偶发把应答体丢成 undefined，内部 JSON.parse 报
// 「"undefined" is not valid JSON」。探针实测 db.count() 跑 6 次撞 1 次（~17%）。
// 真机不触发，但本地 e2e 一撞就级联全红，把环境抖动伪装成业务 bug。
// 只重试这一类传输层错误；权限/校验/集合不存在等真错一律直接抛。
const TRANSIENT = /is not valid JSON|Timeout|^undefined$/i;
async function retry(make, label, tries = 4) {
  let last = null;
  for (let i = 1; i <= tries; i++) {
    try { return await make(); }
    catch (e) {
      last = e;
      const msg = String((e && (e.errMsg || e.message)) || e);
      if (!TRANSIENT.test(msg)) throw e;
      if (i === tries) break;
      await new Promise(r => setTimeout(r, i * 600));
    }
  }
  throw last;
}

// opts.orderBy: [[字段, 'asc'|'desc'], ...]
// ⚠️ 想取「最新 N 条」必须传 orderBy：云端 limit 不保证顺序，
//    无序时 limit(3) 返回的是任意 3 条，前端再排序也救不回来（已实测踩过）。
async function list(name, where = {}, limit = 500, opts = {}) {
  if (!isCloudReady()) return [];
  const orders = opts.orderBy || [];
  const build = () => {
    let q = getDb().collection(name).where(where || {});
    for (const [field, dir] of orders) q = q.orderBy(field, dir || 'asc');
    return q;
  };
  const t0 = Date.now();
  let calls = 0;
  const out = [];
  // 分页「一批 3 页并行」而不是逐页串行：单次 get 约 300ms，30 人名单串行要 600ms、
  // 59 条成绩要 3 轮 ~1000ms（2026-09-06 探针实测）。并行后一批只花一次往返。
  // 取舍：数据不足时会多发最多 2 个空请求（云读次数 ↑，延迟 ↓）——
  //      班级数据量固定在百条内，免费额度绰绰有余，延迟才是老师能感觉到的。
  const BATCH = 3;
  let done = false;
  while (!done && out.length < limit) {
    const reqs = [];
    for (let i = 0; i < BATCH && out.length + i * PAGE < limit; i++) {
      const skip = out.length + i * PAGE;
      const size = Math.min(PAGE, limit - skip);
      if (size <= 0) break;
      reqs.push(retry(() => build().skip(skip).limit(size).get(), 'list:' + name));
    }
    if (!reqs.length) break;
    const res = await Promise.all(reqs);
    calls += reqs.length;
    for (const r of res) {
      const data = (r && r.data) || [];
      out.push(...data);
      // 某一页没取满 → 后面的页只会更空，本批之后不必再发（顺序追加保证 orderBy 不乱）
      if (data.length < PAGE) { done = true; break; }
    }
  }
  // 性能打点（tools/probe-perf.js 读它定位「页面切换慢」的真凶）。
  // 只累加计数，不做任何 IO：探针关掉时开销约等于 0。
  perf.n += calls; perf.ms += Date.now() - t0;
  perf.detail.push(name + ':' + calls + 'x' + (Date.now() - t0) + 'ms:' + out.length + '条');
  if (perf.detail.length > 200) perf.detail.shift();
  return out;
}

// 级联删除：删主记录 + 所有引用它的从记录，避免孤儿数据让 UI 显示 undefined
// refs: [{ collection, field }]
async function removeCascade(name, id, refs = []) {
  if (!isCloudReady()) throw new Error('云环境未就绪');
  for (const { collection, field } of refs) {
    for (let i = 0; i < 25; i++) {
      const { data } = await retry(() => getDb().collection(collection).where({ [field]: id }).limit(PAGE).get(), 'casc:' + collection);
      if (!data.length) break;
      await Promise.all(data.map(d => remove(collection, d._id)));
      if (data.length < PAGE) break;
    }
  }
  await remove(name, id);
}

async function count(name, where = {}) {
  if (!isCloudReady()) return 0;
  const { total } = await retry(() => getDb().collection(name).where(where || {}).count(), 'count:' + name);
  return total;
}

async function add(name, data) {
  if (!isCloudReady()) throw new Error('云环境未就绪');
  assertValid(name, data);
  // ⚠️ add 不幂等，不能像 get/update 那样直接 retry：IDE 传输层「已写入但响应丢失」
  // 时重发会双写（实测事故：SORT-4 通知出现两条）。
  // 正确做法：传输错误后先按完整 data 查重，已写进去就复用那条的 _id，确认没写才重发。
  const pack = () => ({ data: { ...data, updatedAt: Date.now() } });
  try {
    const { _id } = await getDb().collection(name).add(pack());
    return _id;
  } catch (e) {
    const msg = String((e && (e.errMsg || e.message)) || e);
    if (!TRANSIENT.test(msg)) throw e;
  }
  let last = null;
  for (let i = 1; i <= 3; i++) {
    await new Promise(r => setTimeout(r, i * 600));
    try {
      // 查重和重发都可能再撞传输错误，所以整个循环体都在 try 里
      const dup = await getDb().collection(name).where(data).limit(1).get();
      if (dup.data.length) return dup.data[0]._id;
      const { _id } = await getDb().collection(name).add(pack());
      return _id;
    } catch (e) {
      last = e;
      const msg = String((e && (e.errMsg || e.message)) || e);
      if (!TRANSIENT.test(msg)) throw e;
    }
  }
  throw last;
}

async function update(name, id, data) {
  if (!isCloudReady()) throw new Error('云环境未就绪');
  assertValid(name, data);
  await retry(() => getDb().collection(name).doc(id).update({ data: { ...data, updatedAt: Date.now() } }), 'update:' + name);
}

async function remove(name, id) {
  if (!isCloudReady()) throw new Error('云环境未就绪');
  // ⚠️ remove 也不幂等：「已删除但响应丢失」时重发会报
  // 「cannot remove document ... please make sure that the document exists」，被误判成失败（实测事故）。
  // 传输错误后先 count 确认：真没了就是成功，还在才重发。
  try {
    await getDb().collection(name).doc(id).remove();
    return;
  } catch (e) {
    const msg = String((e && (e.errMsg || e.message)) || e);
    // 「文档不存在」也算成功：remove 的目标态就是「让它不存在」。
    // 并发清理（上一次脚本崩溃后小程序端循环还在跑）会正常报这个错，
    // 不当成功就会把「已达目标」误报成失败（2026-09-11 seed-demo 实测）。
    if (/cannot remove|not exist/i.test(msg)) return;
    if (!TRANSIENT.test(msg)) throw e;
  }
  let last = null;
  for (let i = 1; i <= 3; i++) {
    await new Promise(r => setTimeout(r, i * 600));
    try {
      const c = await getDb().collection(name).where({ _id: id }).count();
      if (c.total === 0) return;
      await getDb().collection(name).doc(id).remove();
      return;
    } catch (e) {
      last = e;
      const msg = String((e && (e.errMsg || e.message)) || e);
      if (!TRANSIENT.test(msg)) {
        // 重发报「不存在」= 上一次其实已经删成功了，当成功收尾
        if (/cannot remove|not exist/i.test(msg)) return;
        throw e;
      }
    }
  }
  throw last;
}

// watch 建连期/弱网偶发的瞬断错误码（真机实测 -402002：login 还在 INIT_LOGGING_IN
// 就建监听 → "ws connection not exists"，SDK 不会自动重连，多设备实时同步静默失效）。
const WATCH_TRANSIENT = /-402002|ws connection not exists|login fail|realtime listener init watch fail|connection/i;
const WATCH_RETRY_MAX = 5;
function watch(name, where, onChange, onError) {
  if (!isCloudReady()) {
    // 演示模式下不建立监听；仅在显式传入 onError 时回调一次告知
    if (onError) onError(new Error('云环境未就绪，未建立实时监听'));
    return null;
  }
  const cb = onChange || function () {};
  const report = onError || function () {};
  let inner = null;
  let closed = false;
  let attempts = 0;
  let retryTimer = null;
  let reportedFatal = false;
  let reconnecting = false;
  let connectSeq = 0;

  // 返回与 SDK watcher 同形（带 close()）的句柄；页面原有 this.watcher.close() 不用改
  const handle = {
    close() {
      closed = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      try { inner && inner.close(); } catch (e) {}
    }
  };

  function connect() {
    if (closed) return;
    const gen = ++connectSeq;
    const deliverReconnectInit = reconnecting;
    inner = getDb().collection(name).where(where || {}).watch({
      // 首次 init 已由页面 onLoad 的 refresh() 处理，必须吞掉避免双拉。
      // 断线重连后的 init 不能吞：断线期间可能错过 update，需要让页面重新拉全量。
      onChange: snapshot => {
        if (gen !== connectSeq) return;
        attempts = 0;
        if (snapshot && snapshot.type === 'init') {
          if (deliverReconnectInit) cb(snapshot);
          return;
        }
        cb(snapshot);
      },
      onError(err) {
        if (closed || gen !== connectSeq) return;
        const msg = String((err && (err.errMsg || err.message)) || err);
        if (WATCH_TRANSIENT.test(msg) && attempts < WATCH_RETRY_MAX) {
          attempts += 1;
          reconnecting = true;
          // 退避必须给 login/realtime 初始化留够时间：实测 100ms 线性退避 5 次只覆盖
          // ~1.5s，弱网下 INIT_LOGGING_IN 都没结束就把 5 次重连耗光，监听永久静默失效。
          retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 800 * attempts);
          return;
        }
        // 重连上限用完或非瞬断错误：只上报一次，页面 onUnload 的 close 不受影响
        if (!reportedFatal) { reportedFatal = true; report(err); }
      }
    });
  }
  connect();
  return handle;
}

module.exports = { isCloudReady, list, count, add, update, remove, removeCascade, watch, cmd: getCmd, validate, perfReset, perfDump, retry };
