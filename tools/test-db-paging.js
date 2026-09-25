// 守护 utils/db.js 的分页与 watch 语义（2026-09-06 性能优化引入，必须有回归网）。
// 为什么用 Node mock 云：分页边界（恰好 20/40/60 条、limit 截断、并行批次顺序）
// 在真机上只表现为「名单少了几个人」，e2e 抓不到根因；这里用可控假数据穷举。
global.getApp = () => ({ globalData: { cloudReady: true } });

let calls = [];            // 记录每次 get 的 skip/limit，验证并行批次与提前收敛
let TOTAL = 0;             // 假集合总条数
let watchOpts = null;
let watchCalls = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let inflight = 0, maxInflight = 0;   // 并发观测：真并行时 >1
const LATENCY = 5;                  // 假云延迟，让并发窗口真实存在

function makeQuery(state) {
  const q = {
    where(w) { return makeQuery({ ...state, where: w }); },
    orderBy(f, d) { return makeQuery({ ...state, orders: (state.orders || []).concat([[f, d]]) }); },
    skip(n) { return makeQuery({ ...state, skip: n }); },
    limit(n) { return makeQuery({ ...state, limit: n }); },
    field() { return makeQuery(state); },
    count() { return Promise.resolve({ total: TOTAL }); },
    watch(o) { watchCalls.push(o); watchOpts = o; return { close() { o.closed = true; } }; },
    get() {
      const skip = state.skip || 0;
      const lim = state.limit == null ? 20 : state.limit;
      calls.push({ skip, limit: lim, orders: state.orders || [] });
      const data = [];
      for (let i = skip; i < Math.min(TOTAL, skip + lim); i++) data.push({ _id: 'id' + i, seq: i });
      // 并发计数：真并行时 inflight 会 >1；串行永远是 1。
      // ⚠️ 只看 skip 顺序抓不到串行（串行也是 0→20→40），必须量「同时在飞的请求数」——
      //    2026-09-06 实测 db-serial-paging 变异体因此 SURVIVED。
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      return new Promise(resolve => setTimeout(() => { inflight -= 1; resolve({ data }); }, LATENCY));
    }
  };
  return q;
}
global.wx = { cloud: { database: () => ({ command: {}, collection: () => makeQuery({}) }) } };

const DB_PATH = require('path').resolve(__dirname, '..', 'utils', 'db.js');
delete require.cache[DB_PATH];
const db = require(DB_PATH);

let pass = 0, fail = 0;
const ok = m => { pass++; console.log('  ✅ ' + m); };
const bad = m => { fail++; console.log('  ❌ ' + m); };

async function caseTotal(total, limit, label) {
  TOTAL = total; calls = [];
  const rows = await db.list('students', {}, limit, { orderBy: [['studentNo', 'asc']] });
  const expect = Math.min(total, limit);
  const seqOk = rows.every((r, i) => r.seq === i);          // 顺序不能被并行打乱
  const idsUniq = new Set(rows.map(r => r._id)).size === rows.length;
  if (rows.length === expect && seqOk && idsUniq) ok(`${label}: 总${total} limit${limit} → 取回 ${rows.length} 条，顺序正确无重复（${calls.length} 次 get）`);
  else bad(`${label}: 总${total} limit${limit} → 取回 ${rows.length}（期望 ${expect}）顺序ok=${seqOk} 唯一ok=${idsUniq} calls=${JSON.stringify(calls)}`);
  return calls.length;
}

(async () => {
  // 边界：0 / 1 / 19 / 20（恰好一页）/ 21 / 40（恰好两页）/ 41 / 59（真实成绩条数）/ 60 / 61
  for (const n of [0, 1, 19, 20, 21, 40, 41, 59, 60, 61, 100]) await caseTotal(n, 500, '分页边界');
  // limit 必须真截断（老师页面只想要最新 3 条时不能多给）
  await caseTotal(100, 3, 'limit 截断');
  await caseTotal(100, 20, 'limit=一页');
  await caseTotal(100, 25, 'limit 跨页');

  // 并行分页要真的省往返：60 条串行需 3 个往返，并行批 3 只需 1 个
  TOTAL = 60; calls = []; maxInflight = 0; inflight = 0;
  const t0 = Date.now();
  await db.list('students', {}, 500, {});
  const wall = Date.now() - t0;
  const skips = calls.map(c => c.skip);
  skips.slice(0, 3).join() === '0,20,40'
    ? ok('首批发出 skip 0/20/40')
    : bad('分页 skip 序列错: ' + JSON.stringify(skips));
  // 关键断言：同时在飞的请求数必须 >1，否则就是退回串行（BATCH=1）
  maxInflight >= 3
    ? ok(`分页真并行：峰值并发 ${maxInflight} 个请求（总耗时 ${wall}ms）`)
    : bad(`未并行分页：峰值并发只有 ${maxInflight}（串行退化，每页多等一个往返；总耗时 ${wall}ms）`);

  // 提前收敛：总 25 条时不许无限发请求（一页没取满就停）
  TOTAL = 25; calls = [];
  await db.list('students', {}, 500, {});
  calls.length <= 3
    ? ok(`总 25 条只发 ${calls.length} 次 get（未取满即停）`)
    : bad(`请求过多: ${calls.length} 次 ${JSON.stringify(calls.map(c => c.skip))}`);

  // orderBy 必须传下去（云端 limit 无序时返回任意 N 条，本项目踩过）
  TOTAL = 5; calls = [];
  await db.list('scores', {}, 3, { orderBy: [['date', 'desc'], ['updatedAt', 'desc']] });
  calls.length && calls[0].orders.length === 2 && calls[0].orders[0][0] === 'date'
    ? ok('orderBy 传递到云端查询（2 个排序字段）')
    : bad('orderBy 丢失: ' + JSON.stringify(calls[0] && calls[0].orders));

  // 演示模式（云未就绪）必须返回空数组且不发请求
  global.getApp = () => ({ globalData: { cloudReady: false } });
  calls = [];
  const empty = await db.list('students', {}, 500, {});
  Array.isArray(empty) && empty.length === 0 && calls.length === 0
    ? ok('云未就绪：返回空数组且不发请求')
    : bad(`云未就绪异常: ${JSON.stringify(empty)} calls=${calls.length}`);
  global.getApp = () => ({ globalData: { cloudReady: true } });

  // watch：init 快照必须被吞掉（否则每次进页面数据拉两遍，实测慢一倍）
  let fired = [];
  db.watch('schedule', {}, s => fired.push(s.type || 'nostype'));
  watchOpts ? ok('watch 已建立') : bad('watch 未建立');
  watchOpts.onChange({ type: 'init', docs: [] });
  fired.length === 0 ? ok('init 快照被过滤（不触发页面重复刷新）') : bad('init 未过滤: ' + JSON.stringify(fired));
  watchOpts.onChange({ type: 'update', docChanges: [{}] });
  watchOpts.onChange({ docChanges: [{}] });                 // 无 type 的真实变更也要透传
  fired.length === 2 ? ok('真实变更正常透传（update + 无 type 各 1 次）') : bad('变更透传异常: ' + JSON.stringify(fired));

  // watch 瞬断自动重连：首次 init 吞掉，重连后的 init 必须透传，让页面补拉断线期间漏推的数据。
  const firstWatch = watchOpts;
  watchOpts.onError({ errMsg: 'watch fail -402002 ws connection not exists' });
  await sleep(950);                       // 生产退避是 800*attempts，测试不缩短生产等待，只把窗等够
  watchOpts !== firstWatch && watchCalls.length >= 2
    ? ok('watch -402002 瞬断后自动重建监听')
    : bad('watch 瞬断未重连: calls=' + watchCalls.length);
  watchOpts.onChange({ type: 'init', docs: [{ _id: 'reconnect' }] });
  fired.length === 3 && fired[2] === 'init'
    ? ok('重连 init 快照透传（补齐断线期间变更）')
    : bad('重连 init 被误吞: ' + JSON.stringify(fired));

  // 旧连接在新连接建立后迟到的回调必须被 connectSeq 忽略：
  // 否则旧 watcher 的 onChange 会在重连后多刷一次、旧 onError 还会多排一次重连，监听数失控。
  const firedBeforeStale = fired.length;
  const callsBeforeStale = watchCalls.length;
  firstWatch.onChange({ type: 'update', docChanges: [{ _id: 'stale' }] });
  firstWatch.onError({ errMsg: 'watch fail -402002 ws connection not exists' });
  await sleep(1000);
  fired.length === firedBeforeStale && watchCalls.length === callsBeforeStale
    ? ok('旧 watcher 迟到的 onChange/onError 已被忽略（connectSeq 生效）')
    : bad(`旧 watcher 回调污染: fired ${firedBeforeStale}→${fired.length}, calls ${callsBeforeStale}→${watchCalls.length}`);

  // close 后即使退避定时器已排队，也不许再建立监听。
  const beforeCloseWatchCount = watchCalls.length;
  const closable = db.watch('todos', {}, () => {}, () => {});
  watchOpts.onError({ errMsg: 'realtime listener init watch fail -402002' });
  closable.close();
  await sleep(950);                       // 必须等过 800ms 退避窗，才能证明排队重连真被 close 取消了
  watchCalls.length === beforeCloseWatchCount + 1
    ? ok('close 后排队重连已取消')
    : bad('close 后仍重连: ' + watchCalls.length);

  // watch 在演示模式下不建立，且 onError 被告知一次
  global.getApp = () => ({ globalData: { cloudReady: false } });
  let errN = 0;
  const w = db.watch('schedule', {}, () => {}, () => { errN += 1; });
  w === null && errN === 1 ? ok('云未就绪：watch 返回 null 且回调一次 onError') : bad(`云未就绪 watch 异常: w=${w} errN=${errN}`);
  global.getApp = () => ({ globalData: { cloudReady: true } });

  // 性能打点接口存在且可清零（probe-perf.js 依赖它）
  TOTAL = 30; db.perfReset();
  await db.list('students', {}, 500, {});
  const d1 = db.perfDump();
  d1.n >= 1 && d1.detail.length >= 1
    ? ok(`perfDump 记录到 ${d1.n} 次 get：${d1.detail[0]}`)
    : bad('perfDump 未记录: ' + JSON.stringify(d1));
  db.perfReset();
  db.perfDump().n === 0 ? ok('perfReset 清零') : bad('perfReset 未清零');
  globalThis.__dbperf && typeof globalThis.__dbperf.dump === 'function'
    ? ok('globalThis.__dbperf 已挂（探针可读）') : bad('__dbperf 未挂');

  console.log(`\ndb-paging: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
