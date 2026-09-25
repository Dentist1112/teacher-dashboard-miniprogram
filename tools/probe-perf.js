#!/usr/bin/env node
/**
 * 页面切换耗时探针（用户反馈「每个功能页面切换太慢」，2026-09-06）。
 *
 * ⚠️ 第一版把 mp.reLaunch() 的返回耗时当成页面切换耗时 —— 实测 14 个页面全是 3830ms ±20，
 *    那是 automator 自身的往返/等待开销，不是用户感知。教训：**测量点必须在被测系统内部**。
 *    本版所有计时都在小程序 runtime 里完成，automator 只负责发起和读结果。
 *
 * 量三个数：
 *   navMs   = wx.reLaunch/switchTab 调用 → success 回调（框架路由 + 新页面 onLoad 同步部分）
 *   readyMs = success 回调 → data.loading 变 false（首屏真正可看）
 *   dbN/dbMs= 这段时间内的云 get 次数与累计耗时（patch 在 Collection/Query 原型上，
 *             绕不过 utils/db.js 的 _db 单例缓存 —— 第一版 patch wx.cloud.database 抓到 0 次）
 *
 * 用法: node tools/probe-perf.js [轮数，默认 3]
 */
const { connectOrLaunch, sleep, evalRetry } = require('./mp.js');

const PAGES = [
  ['/pages/dashboard/dashboard', 1], ['/pages/roster/roster', 1], ['/pages/grades/grades', 1],
  ['/pages/attendance/attendance', 1], ['/pages/announcement/announcement', 1],
  ['/pages/schedule/schedule', 0], ['/pages/duty/duty', 0], ['/pages/seats/seats', 0],
  ['/pages/committee/committee', 0], ['/pages/homework/homework', 0], ['/pages/rewards/rewards', 0],
  ['/pages/profile/profile', 0], ['/pages/all/all', 0]
];

// utils/db.js 内部打点（globalThis.__dbperf），不再 patch wx.cloud.database：
// db.js 缓存 _db 单例，外层 patch 抓到 0 次（实测两版探针空转）
const HOOK = () => (globalThis.__dbperf ? 'db.js-perf-ready' : 'NO-HOOK: utils/db.js 未挂 __dbperf');

// 在小程序内部发起跳转并计时；返回后由外层轮询 loading
const GO = (url, isTab) => {
  if (globalThis.__dbperf) globalThis.__dbperf.reset();
  globalThis.__nav = { navMs: -1, t1: 0, done: 0, err: '' };
  const t0 = Date.now();
  const cb = {
    success: () => { globalThis.__nav.navMs = Date.now() - t0; globalThis.__nav.t1 = Date.now(); globalThis.__nav.done = 1; },
    fail: e => { globalThis.__nav.err = (e && e.errMsg) || 'fail'; globalThis.__nav.done = 1; }
  };
  if (isTab) wx.switchTab(Object.assign({ url }, cb));
  else if (globalThis.__perfNavMode === 'push') wx.navigateTo(Object.assign({ url }, cb));
  else wx.reLaunch(Object.assign({ url }, cb));
  return 'sent';
};

const READ = () => {
  const nav = globalThis.__nav || {};
  const pg = getCurrentPages().slice(-1)[0];
  const perf = globalThis.__dbperf ? globalThis.__dbperf.dump() : { n: 0, ms: 0, detail: [] };
  return {
    done: nav.done, navMs: nav.navMs, err: nav.err,
    route: pg ? pg.route : '',
    loading: pg ? pg.data.loading : undefined,
    readyMs: nav.t1 ? Date.now() - nav.t1 : -1,
    dbN: perf.n, dbMs: perf.ms, detail: perf.detail.join(' ')
  };
};

(async () => {
  const rounds = Number(process.argv[2] || 3);
  const { mp } = await connectOrLaunch();
  try {
    console.log('db hook:', await evalRetry(mp, HOOK));
    const mode = process.env.NAV_MODE === 'push' ? 'push' : 'relaunch';
    await evalRetry(mp, m => { globalThis.__perfNavMode = m; return m; }, [mode]);
    console.log('nav mode:', mode);
    const rows = [];
    for (let r = 1; r <= rounds; r++) {
      for (const [url, isTab] of PAGES) {
        await evalRetry(mp, GO, [url, !!isTab]);
        let st = null;
        const deadline = Date.now() + 15000;
        const target = url.split('/').slice(1).join('/');
        // ⚠️ 不能一看到 loading===false 就收工：新页 onLoad 里的 refresh() 是异步的，
        //    loading 被 setData 成 true 之前有一个窗口，此时 loading 仍是初始值 ——
        //    第一版就在这里抢跑，量出 ready=0ms / dbN=0 的假数据（2026-09-06 实测）。
        //    判定改成「到达目标页 + 云请求数连续 4 次不再增长」，把异步尾巴算进去。
        let stableN = 0, lastN = -1;
        for (;;) {
          st = await evalRetry(mp, READ);
          const arrived = st.done && st.route === target;
          if (arrived) {
            if (st.dbN === lastN) stableN += 1; else { stableN = 0; lastN = st.dbN; }
            if (stableN >= 4 && st.loading !== true) break;
          }
          if (st.err) break;
          if (Date.now() > deadline) { st.timeout = 1; break; }
          await sleep(60);
        }
        // readyMs 里含 4 轮稳定检测的轮询开销，扣掉，只留真实数据加载时间
        if (st.readyMs > 0) st.readyMs = Math.max(0, st.readyMs - 4 * 60);
        rows.push({ round: r, page: url, ...st });
        await sleep(250);
      }
    }
    const byPage = {};
    rows.forEach(x => { (byPage[x.page] = byPage[x.page] || []).push(x); });
    const med = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    console.log('\n页面切换耗时（小程序内部打点，ms）');
    console.log('page'.padEnd(34) + 'nav'.padStart(6) + 'ready'.padStart(7) + '总'.padStart(7) + 'dbN'.padStart(5) + 'dbMs'.padStart(7));
    const total = [];
    Object.keys(byPage).forEach(p => {
      const a = byPage[p];
      const nav = med(a.map(x => x.navMs));
      const ready = med(a.map(x => x.readyMs));
      const dbN = med(a.map(x => x.dbN || 0));
      const dbMs = med(a.map(x => x.dbMs || 0));
      total.push({ p, sum: nav + Math.max(ready, 0), nav, ready, dbN, dbMs });
      console.log(p.padEnd(34) + String(nav).padStart(6) + String(ready).padStart(7)
        + String(nav + Math.max(ready, 0)).padStart(7) + String(dbN).padStart(5) + String(dbMs).padStart(7));
    });
    // 自检：utils/db.js 是 util 模块，开发者工具改动后**不一定热更新**（本项目长期坑）。
    // 若整轮 dbN 全为 0，说明 globalThis.__dbperf 指向的是旧模块实例 —— 这批数字不可信，
    // 必须在 IDE 里手动「重新编译」后重跑，不许拿它当优化前后的对比证据。
    const allZero = rows.every(x => !x.dbN);
    if (allZero) {
      console.log('\n⚠️ 所有页面 dbN=0：db.js 打点未生效（IDE 未热更新 util 模块）。');
      console.log('   处理：开发者工具里点「编译」按钮 → 重跑本探针。本轮 ready 数字也可能因页面实例复用而偏低，不可作为结论。');
    }
    total.sort((a, b) => b.sum - a.sum);
    console.log('\n最慢 5 个：');
    total.slice(0, 5).forEach(x => console.log(`  ${x.p}  ${x.sum}ms（nav ${x.nav} + ready ${x.ready}；云 get ${x.dbN} 次 ${x.dbMs}ms）`));
    console.log('\n逐轮明细：');
    rows.forEach(x => console.log(`  r${x.round} ${x.page} nav=${x.navMs} ready=${x.readyMs} db=${x.dbN}/${x.dbMs}ms ${x.timeout ? 'TIMEOUT ' : ''}${x.err || ''} ${x.detail}`));
  } finally {
    await mp.disconnect();
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
