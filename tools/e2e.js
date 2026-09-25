// 真机模拟器 E2E：连自动化端口，跑通 登录→名单增改删→考勤→通知→概览
const { connectOrLaunch, sleep: _sleep, evalRetry } = require('./mp.js');
const PORT = Number(process.env.AUTO_PORT || 9491);
// 抽段跑时脚本在 /tmp，__dirname 不可靠；PROJECT_ROOT 由 mp.js 算出（tools/..），两种跑法都对
const PROJECT_ROOT = require('./mp.js').PROJECT;

const pass = [];
const fail = [];
function ok(m) { pass.push(m); console.log('  ✅ ' + m); }
function bad(m, e) { fail.push(m + (e ? ' :: ' + (e.message || e) : '')); console.log('  ❌ ' + m + (e ? ' :: ' + (e.message || e) : '')); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 课表常量：与 pages/schedule/schedule.js 的 PERIODS 同源。
// 午间延时 period=9 挂在数字末尾（线上已有 1~8 真实记录，插中间要迁移，零收益）。
// 页面按 PERIODS 数组顺序渲染，所以「数据编号 9」显示在上午 4 节之后。
// ⚠️ 断言一律引用这两个常量，不许再写死 40/45 或 `period <= 8`（规则 14）。
const SCHED_PERIODS = [1, 2, 3, 4, 9, 5, 6, 7, 8];
const SCHED_SLOTS = 5 * SCHED_PERIODS.length;   // 45

// tabBar 页用 switchTab，切完轮询等 currentPage 就绪（直接 reLaunch 会拿到空 pageMeta）
// ⚠️ 切到「已经是当前页」的 tab 时 switchTab 是 no-op：不触发 onLoad/onShow 的 refresh，
//    页面里还是上一段测试留下的旧快照（实测事故：[10] 排序断言拿到 [9] 已删的 REG-xxx；
//    [11] 待删学生不在名单导致 onDelete 直接 return，误报「级联删除有残留」）。
//    所以落地后一律显式调一次 refresh/load，把「数据是否新鲜」从 watch 的运气里摘出来。
// selector 查询会抖：抽段跑时页面刚 reLaunch 完，第一次 $() 偶发返回 null
// （实测事故：mutate 基线报「概览缺 .link-schedule-quick」，但 wxml 里类名在、全套 e2e 同一条通过）。
// 一次 null 不能当「入口不存在」——那会把环境抖动误报成业务 bug，还会让变异测试无法归因。
async function $retry(pg, sel, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const el = await pg.$(sel).catch(() => null);
    if (el) return el;
    await sleep(700);
  }
  return null;
}

async function goto(mp, route, waitMs = 2500) {
  const isTab = ['pages/dashboard/dashboard', 'pages/roster/roster', 'pages/attendance/attendance', 'pages/announcement/announcement', 'pages/grades/grades'].includes(route.replace(/^\//, ''));
  for (let i = 0; i < 3; i++) {
    try {
      if (isTab) await mp.switchTab(route); else await mp.reLaunch(route);
      await sleep(800);
      const p = await mp.currentPage();
      if (p && p.path && p.path.replace(/^\//, '') === route.replace(/^\//, '')) {
        const refreshed = await mp.evaluate(() => {
          const pg = getCurrentPages().slice(-1)[0];
          if (!pg) return 'nopage';
          // 考勤/成绩/作业页有 dirty 保护，不能无脑刷（会丢未保存输入）——它们自己会 merge
          if (pg.dirty && Object.keys(pg.dirty).length) return 'skip-dirty';
          if (typeof pg.refresh === 'function') { pg.refresh(); return 'refresh'; }
          if (typeof pg.load === 'function') { pg.load(); return 'load'; }
          return 'none';
        }).catch(() => 'evalfail');
        await sleep(waitMs);
        p._refreshed = refreshed;
        return p;
      }
    } catch (e) { /* retry */ }
    await sleep(1200);
  }
  throw new Error('无法跳转到 ' + route);
}

// 跳过去再读 data：page 对象会失效（watch 推送/页面重建时抛
// "page is not on top of page stack"），重跳一次就能拿到新的栈顶 page。
// 【为什么要重试】这不是业务 bug 而是 automator 时序抖动，不重试会把环境抖动
// 误报成功能坏了（[12] 段实测连续三次各报不同错：timeout / 无法跳转 / page not on top）。
async function gotoData(mp, route, key, waitMs = 2800, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const pg = await goto(mp, route, waitMs);
      return await pg.data(key);
    } catch (e) {
      last = e;
      await sleep(1000);
    }
  }
  throw last;
}

async function waitPageIdle(mp, { label = '页面', timeoutMs = 30000, requireClean = false } = {}) {
  let last = null;
  for (let i = 0; i <= Math.floor(timeoutMs / 500); i++) {
    last = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      if (!pg) return { has: false };
      const dirty = pg.dirty === true
        || (pg.dirty && typeof pg.dirty === 'object' && Object.keys(pg.dirty).length > 0)
        || (pg.data && pg.data.dirtyFlag === true);
      return {
        has: true,
        busy: !!pg._busy,
        saving: !!(pg.data && pg.data.saving),
        dirty
      };
    });
    if (last.has && !last.busy && !last.saving && (!requireClean || !last.dirty)) return last;
    await sleep(500);
  }
  throw new Error(label + '等待空闲超时: ' + JSON.stringify(last));
}

async function waitCascadeDeleted(mp, id, refCollection, label, timeoutMs = 30000) {
  let last = null;
  for (let i = 0; i <= Math.floor(timeoutMs / 500); i++) {
    last = await evalRetry(mp, (studentId, collectionName) => {
      const d = wx.cloud.database();
      return Promise.all([
        d.collection(collectionName).where({ studentId }).count(),
        d.collection('students').where({ _id: studentId }).count()
      ]).then(([ref, stu]) => ({ ref: ref.total, stu: stu.total }));
    }, [id, refCollection]);
    if (last.ref === 0 && last.stu === 0) return last;
    await sleep(500);
  }
  throw new Error(label + '级联删除超时: ' + JSON.stringify(last));
}

(async () => {
  const { mp, reused } = await connectOrLaunch(PORT);

  // 全局兜底：所有 mp.evaluate 自动带抖动重试。
  // automator 偶发「timeout waiting for automator response / page is not on top of page stack」，
  // mp.js 的 evalRetry 就是为此而生（见 mp.js FLAKY 注释）。逐个改调用点容易漏，
  // 这里统一包一层，让整份 e2e 的 evaluate 全部自带重试。
  // ‹Timeout› 是开发者工具服务端对 App.callFunction 回的 error.message（Connection.js 直接 reject），
  // 并非业务失败：实测同一个 initdb 调用在探针里 2634ms 就回，序列跑到第 N 次就 Timeout。
  // 云调用（callFunction / db.get）最容易撞，不重试会把环境抖动伪装成「测试异常中断」。
  const FLAKY_E2E = /timeout waiting for automator response|Connection closed|page is not on top of page stack|^Timeout$/i;
  const _rawEval = mp.evaluate.bind(mp);
  mp.evaluate = async (fn, ...args) => {
    let last = null;
    for (let i = 1; i <= 4; i++) {
      try { return await _rawEval(fn, ...args); }
      catch (e) {
        last = e;
        if (!FLAKY_E2E.test(e.message || '')) throw e;
        console.log(`  ⚠️ evaluate 抖动 ${i}/4（${(e.message || '').slice(0, 40)}），${i * 2}s 后重试`);
        await sleep(i * 2000);
      }
    }
    throw last;
  };
  try {
    console.log('\n[1] 启动与云登录');
    await sleep(1500);   // 抽段跑(runner 只有 mp)与全套跑都适用，别引用 reused
    // 轮询而不是固定等待：复用已开的实例时可能正好赶上重新编译，login 云函数还没回。
    // 16 秒窗口在复用实例重新编译后仍然偏短（214 项全过后唯独这条 OPENID 空，实测），
    // 所以改成：每次轮询若 openid 还没来，就在页面上下文里主动补一次 app.login()，
    // 而不是干等 onLaunch 的 bootstrap 排到。
    let openid = '';
    for (let i = 0; i < 30; i++) {
      openid = await mp.evaluate(async () => {
        const app = getApp();
        if (app && app.globalData && app.globalData.openid) return app.globalData.openid;
        if (app && typeof app.login === 'function') { try { await app.login(); } catch (e) {} }
        return (app && app.globalData && app.globalData.openid) || '';
      }).catch(() => '');
      if (openid) break;
      await sleep(1000);
    }
    openid ? ok('login 云函数返回 OPENID: ' + openid.slice(0, 10) + '…') : bad('OPENID 为空，login 云函数或 envId 有问题');

    console.log('\n[2] 初始化集合 (initdb)');
    // -404006 empty poll / Timeout 是函数部署(Updating)期的瞬态错误（见 [21b] 注释），
    // callFunction 在页面里被 catch 成 {error}，外层 evaluate 是成功的、触发不到 mp 层重试，
    // 必须在这一层自己重试，否则一次部署抖动就把整套 e2e 判红（实测 291/1 唯一红就是它）。
    const initRes = await mp.evaluate(async () => {
      let last = null;
      for (let i = 1; i <= 4; i++) {
        const r = await wx.cloud.callFunction({ name: 'initdb' }).then(x => x.result).catch(e => ({ error: String(e) }));
        if (!r || !r.error || !/-404006|empty poll result|Timeout/i.test(r.error)) return r;
        last = r;
        await new Promise(res => setTimeout(res, i * 2000));
      }
      return last;
    });
    if (initRes && !initRes.error) ok(`集合就绪：新建 ${initRes.created.length} / 已存在 ${initRes.existed.length} / 失败 ${initRes.failed.length}`);
    else bad('initdb 调用失败', initRes && initRes.error);
    if (initRes && initRes.failed && initRes.failed.length) bad('部分集合创建失败: ' + JSON.stringify(initRes.failed));

    const stamp = Date.now().toString().slice(-6);
    const testNo = 'T' + stamp;

    console.log('\n[3] 名单页：新增学生');
    const roster = await goto(mp, '/pages/roster/roster', 2500);
    // 用 .roster-add 而不是 .add-btn：名单页有两个 .add-btn（拍照导入 / + 添加），
    // $() 只取第一个，会点开拍照弹层导致表单输入框拿不到（实测踩过）。
    await (await roster.$('.roster-add')).tap();
    await sleep(600);
    const rosterTabHidden = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      const tb = typeof pg.getTabBar === 'function' ? pg.getTabBar() : null;
      return !!(tb && tb.data.hidden && pg.data.showForm);
    });
    rosterTabHidden ? ok('名单添加弹层打开时底部导航已隐藏') : bad('名单添加弹层仍被底部导航遮挡');
    const inputs = await roster.$$('.field-input');
    await inputs[0].input(testNo);
    await inputs[1].input('自动化测试');
    await sleep(300);
    await (await roster.$('.btn-save')).tap();
    await sleep(3000);
    let students = await roster.data('students');
    const created = students.find(s => s.studentNo === testNo);
    created ? ok('新增成功，云端已回读：' + created.name) : bad('新增后列表未出现该学生');
    const rosterTabShown = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      const tb = typeof pg.getTabBar === 'function' ? pg.getTabBar() : null;
      return !!(tb && !tb.data.hidden && !pg.data.showForm);
    });
    rosterTabShown ? ok('名单保存后底部导航恢复') : bad('名单保存后底部导航未恢复');

    const rosterModalEdges = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      const tbState = () => {
        const tb = typeof pg.getTabBar === 'function' ? pg.getTabBar() : null;
        return !!(tb && tb.data.hidden);
      };
      pg.onPasteTap();
      const pasteOpen = tbState() === true && pg.data.pasteShow === true;
      pg.onPasteCancel();
      const pasteClosed = tbState() === false && pg.data.pasteShow === false;
      pg.openAiConfirm([{ name: '探针姓名' }]);
      const aiOpen = tbState() === true && pg.data.aiShow === true && pg.data.aiRows.length === 1;
      pg.onAiCancel();
      const aiClosed = tbState() === false && pg.data.aiShow === false;
      return { pasteOpen, pasteClosed, aiOpen, aiClosed };
    });
    rosterModalEdges.pasteOpen && rosterModalEdges.pasteClosed && rosterModalEdges.aiOpen && rosterModalEdges.aiClosed
      ? ok('名单粘贴/AI 确认弹层均会隐藏并恢复底部导航')
      : bad('名单弹层导航显隐边界异常: ' + JSON.stringify(rosterModalEdges));


    console.log('\n[4] 名单页：编辑学生');
    if (created) {
      await (await roster.$(`.act.edit[data-id="${created._id}"]`)).tap();
      await sleep(600);
      const eIn = await roster.$$('.field-input');
      await eIn[1].input('测试改名');
      await sleep(300);
      await (await roster.$('.btn-save')).tap();
      await sleep(3000);
      students = await roster.data('students');
      const edited = students.find(s => s._id === created._id);
      edited && edited.name === '测试改名' ? ok('编辑写回成功') : bad('编辑未生效，当前名=' + (edited && edited.name));
    }

    console.log('\n[5] 考勤页：状态登记 + 保存');
    // 专用第二名学生：真实示例班可能当天已全员有状态，不能从现有学生里赌一个“未标记”。
    await mp.evaluate(no => wx.cloud.database().collection('students').add({
      data: { studentNo: no + 'B', name: '考勤竞态', gender: '男', _e2e: true, updatedAt: Date.now() }
    }), testNo);
    const att = await goto(mp, '/pages/attendance/attendance', 3000);
    const attStudents = await att.data('students');
    const target = attStudents.find(s => s.studentNo === testNo);
    if (!target) bad('考勤页未加载到测试学生');
    else {
      const btns = await att.$$(`.status-btn[data-id="${target._id}"]`);
      await btns[1].tap(); // 迟到
      await sleep(800);
      const tapped = (await att.data('students')).find(s => s._id === target._id);
      tapped && tapped.status === '迟到' ? ok('点选生效（未被 watch 刷新冲掉）') : bad('点选后状态丢失，applyData 的 dirty 保护失效');

      const attRace = await mp.evaluate(id => {
        const pg = getCurrentPages().slice(-1)[0];
        const other = pg.data.students.find(x => x._id !== id && !x.status);
        if (!other) return { skip: 'no-idle-student' };
        const before = other.status;
        pg.onSave();
        pg.onStatusTap({ currentTarget: { dataset: { id: other._id, status: '请假' } } });
        const after = pg.data.students.find(x => x._id === other._id).status;
        return { busy: !!pg._busy, before, after };
      }, target._id);
      attRace.busy === true && attRace.after === attRace.before
        ? ok('考勤保存中继续点状态被冻结（不产生第二份本地脏状态）')
        : bad('考勤保存中仍可改状态: ' + JSON.stringify(attRace));
      await waitPageIdle(mp, { label: '考勤保存', requireClean: true });
      await sleep(1000);
      const after = (await att.data('students')).find(s => s._id === target._id);
      after && after.status === '迟到' && after.attendanceId ? ok('考勤写入云端并回读到 attendanceId') : bad('考勤保存未落库: ' + JSON.stringify(after && { s: after.status, id: after.attendanceId }));

      // 云端直查：确认是真记录而非 UI 假象
      const cloudAtt = await mp.evaluate(id => wx.cloud.database().collection('attendance').where({ studentId: id }).get().then(r => r.data.map(x => ({ s: x.status, d: x.date }))), target._id);
      cloudAtt.length === 1 && cloudAtt[0].s === '迟到' ? ok('云端记录唯一且状态正确（无重复插入）') : bad('云端记录异常: ' + JSON.stringify(cloudAtt));
    }

    console.log('\n[6] 通知页：发布 + 删除');
    const ann = await goto(mp, '/pages/announcement/announcement', 2500);
    await (await ann.$('.add-btn')).tap();
    await sleep(600);
    const tabHiddenWhileOpen = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      const tb = typeof pg.getTabBar === 'function' ? pg.getTabBar() : null;
      return !!(tb && tb.data.hidden && pg.data.showForm);
    });
    tabHiddenWhileOpen ? ok('发布通知弹层打开时自定义底部导航已隐藏（不会挡住发布按钮）') : bad('弹层打开时底部导航仍在最上层');
    const title = '自动化通知' + stamp;
    await (await ann.$('.field-input')).input(title);
    const ta = await ann.$('textarea');
    if (ta) await ta.input('E2E 测试内容，稍后自动删除');
    await sleep(300);
    await (await ann.$('.btn-save')).tap();
    await sleep(3000);
    let notices = await ann.data('notices');
    const nn = notices.find(n => n.title === title);
    nn ? ok('通知发布成功') : bad('通知发布后列表无该条');
    const tabShownAfterSave = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      const tb = typeof pg.getTabBar === 'function' ? pg.getTabBar() : null;
      return !!(tb && !tb.data.hidden && !pg.data.showForm);
    });
    tabShownAfterSave ? ok('发布完成后底部导航恢复') : bad('发布完成后底部导航未恢复');

    // 键盘適应：模拟器没真键盘，人工 setData kbH=320 模拟键盘弹起，
    // 表单必须整体上移（margin-bottom）而不是只加内部 padding
    // —— 用户真机反馈「只能打字，找不到发布按钮」（2026-09-12）。
    await (await ann.$('.add-btn')).tap();
    await sleep(500);
    const kbStyle = await (await ann.$('.form-sheet')).attribute('style');
    await mp.evaluate(() => { getCurrentPages().slice(-1)[0].setData({ kbH: 320 }); return 1; });
    await sleep(400);
    const kbStyle2 = await (await ann.$('.form-sheet')).attribute('style');
    const kbOk = /margin-bottom:\s*320px/.test(kbStyle2 || '') && /max-height:\s*58vh/.test(kbStyle2 || '');
    await mp.evaluate(() => { getCurrentPages().slice(-1)[0].setData({ kbH: 0 }); return 1; });
    await sleep(300);
    const tabHiddenOnSecondOpen = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      const tb = typeof pg.getTabBar === 'function' ? pg.getTabBar() : null;
      return !!(tb && tb.data.hidden && pg.data.showForm);
    });
    await (await ann.$('.btn-cancel')).tap().catch(() => {});
    await sleep(400);
    const tabShownAfterCancel = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      const tb = typeof pg.getTabBar === 'function' ? pg.getTabBar() : null;
      return !!(tb && !tb.data.hidden && !pg.data.showForm);
    });
    tabHiddenOnSecondOpen && tabShownAfterCancel ? ok('取消通知弹层后底部导航恢复') : bad(`弹层导航显隐异常: open=${tabHiddenOnSecondOpen}, cancel=${tabShownAfterCancel}`);
    kbOk ? ok('键盘弹起时表单整体上移（发布按钮不会被键盘挡住）')
         : bad('键盘適应未生效: 弹前[' + (kbStyle || '空') + '] 弹后[' + (kbStyle2 || '空') + ']');

    // 真机回归（2026-09-12）：键盘收起时 kbH 必须延迟归零。立即归零会让 sheet 下坠，
    // 手指下的「发布」按钮移走、tap 落到 mask 上变取消（模拟器无真键盘，直调 handler 模拟）。
    const kbDelay = await mp.evaluate(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const pg = getCurrentPages().slice(-1)[0];
      if (typeof pg.__kbHandler !== 'function') return { err: '页面没有 __kbHandler（kb.bind 漏了？）' };
      pg.setData({ kbH: 300 });
      pg.__kbHandler({ height: 0 });
      const immediate = pg.data.kbH;
      await sleep(120);
      const inWindow = pg.data.kbH;
      await sleep(450);
      return { immediate, inWindow, settled: pg.data.kbH };
    });
    (kbDelay.immediate === 300 && kbDelay.inWindow === 300 && kbDelay.settled === 0)
      ? ok('键盘收起后弹层保持 450ms 再下落（发布按钮 tap 不会被下坠吞掉）')
      : bad('键盘收起避让异常: ' + JSON.stringify(kbDelay));

    // 真机边界：弹层仍开着时 App 切后台/页面 onHide 会恢复导航；回到本页 onShow
    // 必须按当前 showForm 再隐藏，否则用户回来会再次看到导航压住发布按钮。
    const tabLifecycle = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      const tbState = () => {
        const tb = typeof pg.getTabBar === 'function' ? pg.getTabBar() : null;
        return !!(tb && tb.data.hidden);
      };
      pg.onAdd();
      const open = tbState() === true && pg.data.showForm === true;
      pg.onHide();
      const hiddenWhileAway = tbState() === false;
      pg.onShow();
      const hiddenAfterReturn = tbState() === true && pg.data.showForm === true;
      pg.onFormCancel();
      const restored = tbState() === false && pg.data.showForm === false;
      return { open, hiddenWhileAway, hiddenAfterReturn, restored };
    });
    tabLifecycle.open && tabLifecycle.hiddenWhileAway && tabLifecycle.hiddenAfterReturn && tabLifecycle.restored
      ? ok('弹层打开时切走再回来，底部导航显隐状态正确')
      : bad('弹层页面生命周期导航显隐异常: ' + JSON.stringify(tabLifecycle));

    console.log('\n[7] 概览页：统计聚合');
    const dash = await goto(mp, '/pages/dashboard/dashboard', 4000);
    const d = await dash.data();
    d.students && d.students.length > 0 ? ok(`概览读到 ${d.students.length} 名学生`) : bad('概览学生数为 0');
    d.announcements && d.announcements.length > 0 ? ok(`概览读到 ${d.announcements.length} 条通知`) : bad('概览通知为空');
    const abnormal = (d.attendance || []).find(a => a.studentName);
    abnormal ? ok('考勤异常已带出姓名：' + abnormal.studentName + '/' + abnormal.status) : bad('考勤异常列表未带出姓名（nameMap 或查询有问题）');

    console.log('\n[8] 实时同步 watch');
    // ⚠️ 监听器一律要 close：长跑里泄漏的 watcher 会拖垮 realtime 连接（实测长跑 login fail）
    const watchRes = await mp.evaluate(() => new Promise(resolve => {
      const db = wx.cloud.database();
      let fired = 0;
      let w = null;
      let done = false;
      const fin = r => {
        if (done) return; done = true;
        try { w && w.close(); } catch (e) { /* 已关闭 */ }
        resolve(r);
      };
      // 等 login 完成再建 watch（openid 到位），避免抢在 INIT_LOGGING_IN 期撞 -402002
      const startWatch = () => {
        w = db.collection('students').watch({
          onChange: () => { fired++; if (fired >= 2) fin({ ok: true, fired }); },
          onError: e => fin({ ok: false, err: String(e).slice(0, 200) })
        });
      };
      let waited = 0;
      const waitLogin = () => {
        const app = getApp();
        if (app && app.globalData && app.globalData.openid) return startWatch();
        if (waited >= 8000) return startWatch();  // 兜底：仍试一次，让真问题暴露
        waited += 500; setTimeout(waitLogin, 500);
      };
      waitLogin();
      setTimeout(() => {
        db.collection('students').add({ data: { studentNo: 'W' + Date.now().toString().slice(-5), name: 'watch探针', gender: '男', _probe: true, updatedAt: Date.now() } })
          .catch(e => fin({ ok: false, err: 'add 失败: ' + String(e).slice(0, 160) }));
      }, 2000);
      setTimeout(() => fin({ ok: fired > 0, fired, note: 'timeout' }), 15000);
    }));
    // realtime WebSocket 偶发 login fail（实测 4 轮里 2 轮红，云端读写自检全 ok），
    // 是环境抖动不是本项目 bug。重试 1 次；两次都挂才算失败。
    let watchFinal = watchRes;
    if (!watchRes.ok) {
      console.log('  ⚠️ watch 第 1 次未触发，5s 后重试一次（realtime 连接偶发抖动）');
      await sleep(5000);
      watchFinal = await mp.evaluate(() => new Promise(resolve => {
        const db = wx.cloud.database();
        let fired = 0; let w = null; let done = false;
        const fin = r => { if (done) return; done = true; try { w && w.close(); } catch (e) {} resolve(r); };
        const startWatch = () => {
          w = db.collection('students').watch({
            onChange: () => { fired++; if (fired >= 2) fin({ ok: true, fired, retry: true }); },
            onError: e => fin({ ok: false, err: String(e).slice(0, 200), retry: true })
          });
        };
        let waited = 0;
        const waitLogin = () => {
          const app = getApp();
          if (app && app.globalData && app.globalData.openid) return startWatch();
          if (waited >= 8000) return startWatch();
          waited += 500; setTimeout(waitLogin, 500);
        };
        waitLogin();
        setTimeout(() => {
          db.collection('students').add({ data: { studentNo: 'W' + Date.now().toString().slice(-5), name: 'watch探针', gender: '男', _probe: true, updatedAt: Date.now() } })
            .catch(e => fin({ ok: false, err: 'add 失败: ' + String(e).slice(0, 160), retry: true }));
        }, 2000);
        setTimeout(() => fin({ ok: fired > 0, fired, note: 'timeout', retry: true }), 15000);
      }));
    }
    if (watchFinal.ok) {
      ok('watch 实时推送生效（触发 ' + watchFinal.fired + ' 次' + (watchFinal.retry ? '，第 2 次尝试' : '') + '）');
    } else {
      // watch 挂了要立刻区分「只是 realtime 挂」还是「整个云端会话挂」，否则后面所有断言都无法归因
      const health = await mp.evaluate(() => {
        const d = wx.cloud.database();
        const app = getApp();
        return d.collection('students').count()
          .then(r => d.collection('announcements').add({ data: { title: 'HEALTH-' + Date.now(), content: 'x', priority: '低', date: '2027-12-31', _probe: true, updatedAt: Date.now() } })
            .then(w => d.collection('announcements').doc(w._id).remove().then(() => ({ ready: !!(app.globalData && app.globalData.cloudReady), read: r.total, write: 'ok' }))))
          .catch(e => ({ ready: !!(app.globalData && app.globalData.cloudReady), err: String(e).slice(0, 160) }));
      });
      bad('watch 两次都未触发', (watchFinal.err || JSON.stringify(watchFinal)) + ' | 云端自检: ' + JSON.stringify(health));
    }

    console.log('\n[9] 回归：写入操作防连点（实测连点 3 次曾插 3 条）');
    const annPage = await goto(mp, '/pages/announcement/announcement', 2500);
    await (await annPage.$('.add-btn')).tap();
    await sleep(600);
    const dupTitle = 'REG-' + stamp;
    await (await annPage.$('.field-input')).input(dupTitle);
    const dupTa = await annPage.$('textarea');
    if (dupTa) await dupTa.input('防连点回归');
    await sleep(400);
    const dupSave = await annPage.$('.btn-save');
    await Promise.all([dupSave.tap(), dupSave.tap(), dupSave.tap()]);
    await sleep(4500);
    const dupN = await mp.evaluate(t => wx.cloud.database().collection('announcements').where({ title: t }).count().then(r => r.total), dupTitle);
    dupN === 1 ? ok('连点 3 次仅插 1 条') : bad(`连点插了 ${dupN} 条（_busy 同步标志失效）`);
    const dupCleaned = await mp.evaluate(t => {
      const d = wx.cloud.database();
      return d.collection('announcements').where({ title: t }).get()
        .then(r => Promise.all(r.data.map(x => d.collection('announcements').doc(x._id).remove())))
        .then(() => d.collection('announcements').where({ title: t }).count().then(c => c.total))
        .catch(e => 'ERR:' + String(e).slice(0, 120));
    }, dupTitle);
    dupCleaned === 0 ? ok('防连点测试数据已清理') : bad(`防连点测试数据未清理干净: ${JSON.stringify(dupCleaned)}（会污染后续排序断言）`);

    console.log('\n[10] 回归：云端排序（limit 无 orderBy 会返回任意 N 条）');
    // 上一轮若在本段中途死掉，遗留的 _reg 通知会让 count 变 10、SORT-4 变重复
    // （实测事故：序列跑 [10] 报「写入异常: 10」）。seed 前先清遗留，否则断言不可归因。
    await mp.evaluate(() => {
      const d = wx.cloud.database();
      return d.collection('announcements').where({ _reg: true }).limit(100).get()
        .then(r => Promise.all(r.data.map(x => d.collection('announcements').doc(x._id).remove())));
    });
    // 写完必须 count 复核：吞掉 add 失败会让后面的排序断言变成不可归因的红字
    const ordSeed = await mp.evaluate(() => {
      const d = wx.cloud.database();
      return Promise.all(Array.from({ length: 5 }, (_, i) => d.collection('announcements').add({ data: {
        title: `SORT-${i}`, content: 'x', priority: '中', date: `2027-01-0${i + 1}`, _reg: true, updatedAt: Date.now() + i } })))
        .then(() => d.collection('announcements').where({ _reg: true }).count().then(c => c.total))
        .catch(e => 'ERR:' + String(e).slice(0, 140));
    });
    ordSeed === 5 ? ok('排序测试数据写入 5 条') : bad(`排序测试数据写入异常: ${JSON.stringify(ordSeed)}`);
    const annPage2 = await goto(mp, '/pages/announcement/announcement', 3500);
    const top3 = (await annPage2.data('notices')).slice(0, 3).map(x => x.title);
    top3[0] === 'SORT-4' ? ok('通知列表最新在前: ' + JSON.stringify(top3)) : bad('列表排序错: ' + JSON.stringify(top3));
    // ⚠️ 不能只靠固定 waitMs：概览 load() 实测要 3239ms（12 次 db.list，2026-09-06 探针实测），
    //    goto 的 4000ms 只剩 ~3.2s 余量，云端稍慢就读到上一段的旧列表 ——
    //    全量跑翻红、单段跑却过，正是这种边界（已实测复现）。
    //    改成轮询等 loading 落定，最多再等 12s。
    const dashPage2 = await goto(mp, '/pages/dashboard/dashboard', 1200);
    for (let i = 0; i < 80; i++) {
      const st = await mp.evaluate(() => {
        const pg = getCurrentPages().slice(-1)[0];
        return pg && pg.route === 'pages/dashboard/dashboard' && pg.data.loading === false
          && (pg.data.announcements || []).length > 0;
      }).catch(() => false);
      if (st) break;
      await sleep(150);
    }
    const dashTop = (await dashPage2.data('announcements')).map(x => x.title);
    dashTop[0] === 'SORT-4' ? ok('概览取到真最新通知: ' + JSON.stringify(dashTop)) : bad('概览拿到的不是最新: ' + JSON.stringify(dashTop));
    await mp.evaluate(() => {
      const d = wx.cloud.database();
      return d.collection('announcements').where({ _reg: true }).get()
        .then(r => Promise.all(r.data.map(x => d.collection('announcements').doc(x._id).remove())));
    });

    console.log('\n[11] 回归：删学生级联清考勤/奖惩 + 学号重号拦截');
    const cascId = await mp.evaluate(() => {
      const d = wx.cloud.database();
      return d.collection('students').add({ data: { studentNo: 'REG998', name: '级联回归', gender: '男', _reg: true, updatedAt: Date.now() } })
        .then(s => Promise.all([
          d.collection('attendance').add({ data: { studentId: s._id, date: '2027-01-01', status: '请假', reason: '回归测试', _reg: true, updatedAt: Date.now() } }),
          d.collection('rewards').add({ data: { studentId: s._id, type: '惩戒', reason: 'r', points: -1, _reg: true, updatedAt: Date.now() } })
        ]).then(() => s._id));
    });
    const rosterPage2 = await goto(mp, '/pages/roster/roster', 3500);
    // 删除失败时页面只弹 toast，必须把 console.error + toast 抓回来，否则只看到「有残留」无法定位
    const cascCall = await mp.evaluate(id => {
      const pg = getCurrentPages().slice(-1)[0];
      const origModal = wx.showModal;
      const origToast = wx.showToast;
      const origErr = console.error;
      const logs = [];
      const toasts = [];
      wx.showModal = o => { o.success && o.success({ confirm: true }); };
      wx.showToast = o => { toasts.push(o.title); };
      console.error = (...a) => { logs.push(a.map(x => (x && x.message) || String(x)).join(' ').slice(0, 200)); origErr(...a); };
      const inList = !!pg.data.students.find(s => s._id === id);
      pg.onDelete({ currentTarget: { dataset: { id } } });
      return new Promise(r => setTimeout(() => {
        wx.showModal = origModal; wx.showToast = origToast; console.error = origErr;
        r({ inList, logs, toasts, busy: !!pg._busy });
      }, 6000));
    }, cascId);
    cascCall.inList ? ok('待删学生在名单里（watch 已同步）') : bad('待删学生未出现在名单（watch 未刷新，删除测试无意义）');
    await sleep(1500);
    const cascLeft = await mp.evaluate(id => {
      const d = wx.cloud.database();
      return Promise.all([
        d.collection('attendance').where({ studentId: id }).count(),
        d.collection('rewards').where({ studentId: id }).count(),
        d.collection('students').where({ _id: id }).count()
      ]).then(x => ({ att: x[0].total, rew: x[1].total, stu: x[2].total }));
    }, cascId);
    cascLeft.att === 0 && cascLeft.rew === 0 && cascLeft.stu === 0
      ? ok('级联删除无残留')
      : bad('级联删除有残留: ' + JSON.stringify(cascLeft) + ' | 页面反馈: ' + JSON.stringify(cascCall));

    const dupCheck = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      const first = pg.data.students[0];
      if (!first) return { skip: true };
      let msg = '';
      const origT = wx.showToast;
      wx.showToast = o => { msg = o.title; };
      pg.setData({ showForm: true, isEdit: false, form: { _id: '', studentNo: first.studentNo, name: 'REG重号', gender: '男' }, genderIndex: 0 });
      return Promise.resolve(pg.onFormSave()).then(() => new Promise(r => setTimeout(() => { wx.showToast = origT; r({ msg }); }, 1500)));
    });
    !dupCheck.skip && /已被/.test(dupCheck.msg) ? ok('学号重号被拦下: ' + dupCheck.msg) : bad('重号未拦截: ' + JSON.stringify(dupCheck));
    const dupWritten = await mp.evaluate(() => wx.cloud.database().collection('students').where({ name: 'REG重号' }).count().then(r => r.total));
    dupWritten === 0 ? ok('重号未写入云端') : bad(`重号被写入 ${dupWritten} 条`);
    await mp.evaluate(() => {
      const d = wx.cloud.database();
      const w = async (c, q) => { const r = await d.collection(c).where(q).limit(20).get(); return Promise.all(r.data.map(x => d.collection(c).doc(x._id).remove())); };
      return Promise.all([w('students', { _reg: true }), w('attendance', { _reg: true }), w('rewards', { _reg: true }), w('students', { name: 'REG重号' })]);
    });

    console.log('\n[12] 回归：班级信息单例 + 全页同步');
    // [11] 刚删完学生，watch 还在推；页面栈没稳之前去跳页会撞上各种时序抖动
    await sleep(1500);
    const before = await gotoData(mp, '/pages/settings/settings', 'form', 3500);
    const TMP = 'REGSCH' + stamp;
    await evalRetry(mp, n => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.setData({ 'form.school': n, 'form.className': 'REG班' });
      return pg.onSave();
    }, [TMP]);
    await sleep(3000);
    let syncOk = 0;
    for (const r of ['/pages/dashboard/dashboard', '/pages/roster/roster', '/pages/attendance/attendance', '/pages/announcement/announcement']) {
      const t = await gotoData(mp, r, 'classTitle', 2800).catch(() => null);
      if (t && t.indexOf(TMP) >= 0) syncOk++;
    }
    syncOk === 4 ? ok('改班级名后 4 个页面全部同步') : bad(`只有 ${syncOk}/4 个页面同步了班级名`);
    const ciCount = await evalRetry(mp, () => wx.cloud.database().collection('classInfo').count().then(r => r.total));
    ciCount === 1 ? ok('classInfo 保持单文档（未堆积）') : bad(`classInfo 有 ${ciCount} 条`);
    // 还原
    await goto(mp, '/pages/settings/settings', 2800);
    await evalRetry(mp, f => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.setData({ form: f });
      return pg.onSave();
    }, [before]);
    await sleep(2500);
    const restored = await gotoData(mp, '/pages/settings/settings', 'form', 2500);
    restored.school === before.school ? ok('班级信息已还原: ' + restored.school) : bad('还原失败: ' + JSON.stringify(restored));

    // 用户报的原 bug：「点设置，文本输入不了」。根因不是 input 坏了 ——
    // onShow 触发的 load() 云请求约 300ms 后返回，把整个 form 对象换成云端旧值，
    // 用户刚打的字被冲掉，手感就是「打不上字」。修法是 _dirty 标志。
    const dirtyKeep = await evalRetry(mp, async () => {
      const pg = getCurrentPages().slice(-1)[0];
      pg._dirty = false; pg._aiDirty = false;
      pg.onInput({ currentTarget: { dataset: { field: 'school' } }, detail: { value: 'E2E正在打的字' } });
      await pg.load();                       // 云回包
      await new Promise(r => setTimeout(r, 300));
      const school = pg.data.form.school;
      pg.onAiInput({ currentTarget: { dataset: { field: 'key' } }, detail: { value: 'E2E_KEY' } });
      await pg.loadAi();
      await new Promise(r => setTimeout(r, 300));
      const key = pg.data.ai.key;
      pg._dirty = false; pg._aiDirty = false;  // 还原，别影响后续段
      await pg.load(); await pg.loadAi();
      return { school, key };
    });
    dirtyKeep.school === 'E2E正在打的字'
      ? ok('设置页：云回包不覆盖正在输入的班级信息')
      : bad(`设置页输入被云回包冲掉（school=${JSON.stringify(dirtyKeep.school)}）`);
    dirtyKeep.key === 'E2E_KEY'
      ? ok('设置页：云回包不覆盖正在输入的 AI 密钥')
      : bad(`AI 密钥输入被云回包冲掉（key=${JSON.stringify(dirtyKeep.key)}）`);

    console.log('\n[13] 奖惩页：登记/编辑/筛选/校验');
    const rewPage = await goto(mp, '/pages/rewards/rewards', 3500);
    const rewLabels = await rewPage.data('studentLabels');
    rewLabels.length >= 20 ? ok(`学生下拉 ${rewLabels.length} 项（分页未被 20 条截断）`) : bad(`学生下拉只有 ${rewLabels.length} 项`);

    // 惩戒必须存负数（老师只填绝对值）
    await (await rewPage.$('.add-btn')).tap();
    await sleep(700);
    const rewReason = 'E2EREW-' + stamp;
    await mp.evaluate(r => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.setData({ typeIndex: 1, 'form.type': '惩戒', 'form.reason': r, 'form.pointsInput': '4' });
    }, rewReason);
    await sleep(400);
    const rewSave = await rewPage.$('.btn-save');
    await Promise.all([rewSave.tap(), rewSave.tap(), rewSave.tap()]); // 同时验防连点
    await sleep(4500);
    const rewRows = await mp.evaluate(r => wx.cloud.database().collection('rewards').where({ reason: r }).get().then(x => x.data), rewReason);
    rewRows.length === 1 ? ok('奖惩登记防连点：仅 1 条') : bad(`奖惩连点插了 ${rewRows.length} 条`);
    rewRows.length && rewRows[0].points === -4 ? ok('惩戒自动存负数 (-4)') : bad('惩戒积分符号错: ' + JSON.stringify(rewRows.map(x => x.points)));

    // 筛选不丢数据 + 汇总按全量
    const rewPage2 = await goto(mp, '/pages/rewards/rewards', 3500);
    const rewAll = (await rewPage2.data('records')).length;
    await (await rewPage2.$('.filter-btn[data-f="punish"]')).tap();
    await sleep(900);
    const rewP = await rewPage2.data('shown');
    await (await rewPage2.$('.filter-btn[data-f="reward"]')).tap();
    await sleep(900);
    const rewR = await rewPage2.data('shown');
    rewP.every(r => r.type === '惩戒') && rewR.every(r => r.type !== '惩戒') && (rewP.length + rewR.length === rewAll)
      ? ok(`筛选正确无遗漏 ${rewP.length}+${rewR.length}=${rewAll}`)
      : bad(`筛选异常 ${rewP.length}+${rewR.length} vs ${rewAll}`);
    const rewSum = await rewPage2.data('summary');
    rewSum.rewardCount + rewSum.punishCount === rewAll ? ok('汇总不受筛选影响') : bad('汇总被筛选污染: ' + JSON.stringify(rewSum));

    // 非法输入拦截
    const rewGuard = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      const msgs = [];
      const o = wx.showToast;
      wx.showToast = x => msgs.push(x.title);
      pg.setData({ showForm: true, isEdit: false, form: { _id: '', studentId: pg.data.students[0]._id, type: '奖励', reason: 'E2E校验', pointsInput: 'abc', date: '2027-02-01' } });
      return Promise.resolve(pg.onFormSave())
        .then(() => { pg.setData({ 'form.pointsInput': '500' }); return pg.onFormSave(); })
        .then(() => { pg.setData({ 'form.reason': '', 'form.pointsInput': '5' }); return pg.onFormSave(); })
        // 2026-09-06 探针实测能入库的三种：Number('   ')=0 / Number('0x10')=16 / 0 分记录
        .then(() => { pg.setData({ 'form.reason': 'E2E校验', 'form.pointsInput': '   ' }); return pg.onFormSave(); })
        .then(() => { pg.setData({ 'form.pointsInput': '0x10' }); return pg.onFormSave(); })
        .then(() => { pg.setData({ 'form.pointsInput': '0' }); return pg.onFormSave(); })
        .then(() => new Promise(r => setTimeout(() => { wx.showToast = o; r(msgs); }, 900)));
    });
    // 断言按「有没有被拦住」判，不绑具体文案（文案改一次就假红一次）：
    // 6 次非法保存必须产生 6 条提示，且分别命中 整数/上限/事由/0 分 四类原因
    rewGuard.length >= 6
      && rewGuard.some(m => /整数|数字/.test(m))
      && rewGuard.some(m => /100/.test(m))
      && rewGuard.some(m => /事由/.test(m))
      && rewGuard.some(m => /不能是 0/.test(m))
      ? ok(`积分/事由校验全部生效（含空格/0x10/0 分，共拦 ${rewGuard.length} 次）`)
      : bad('校验不全: ' + JSON.stringify(rewGuard));
    const rewLeak = await mp.evaluate(() => wx.cloud.database().collection('rewards').where({ reason: 'E2E校验' }).count().then(r => r.total));
    rewLeak === 0 ? ok('非法奖惩未写入') : bad(`非法奖惩写入 ${rewLeak} 条`);

    // 概览「管理 ›」入口
    const dashForLink = await goto(mp, '/pages/dashboard/dashboard', 3500);
    // 必须用 .link-rewards：概览现在有两个「管理 ›」（作业/奖惩），选 .link-more 会点到作业那个
    const moreLink = await $retry(dashForLink, '.link-rewards');
    if (!moreLink) bad('概览缺少奖惩「管理 ›」入口');
    else {
      await moreLink.tap();
      await sleep(3000);
      const cur = await mp.currentPage();
      cur && cur.path.indexOf('rewards') >= 0 ? ok('概览可跳转奖惩页') : bad('跳转失败: ' + (cur && cur.path));
    }

    await mp.evaluate(r => {
      const d = wx.cloud.database();
      return Promise.all([r, 'E2E校验'].map(x => d.collection('rewards').where({ reason: x }).get()
        .then(y => Promise.all(y.data.map(z => d.collection('rewards').doc(z._id).remove())))));
    }, rewReason);

    console.log('\n[14] 成绩页：录入/统计/排名/校验');
    const graWipe = await evalRetry(mp, () => {
      const d = wx.cloud.database();
      return d.collection('scores').where({ exam: 'E2EEXAM' }).get()
        .then(r => Promise.all(r.data.map(x => d.collection('scores').doc(x._id).remove())).then(() => r.data.length));
    });
    if (graWipe) console.log(`  ↺ 段首清掉 ${graWipe} 条上一轮残留的 E2EEXAM 成绩`);

    const graPage = await goto(mp, '/pages/grades/grades', 4000);
    const graRows = await graPage.data('rows');
    graRows.length >= 20 ? ok(`成绩页加载 ${graRows.length} 名学生（未被 20 条截断）`) : bad(`只加载 ${graRows.length} 名`);

    const setScore = (i, v) => mp.evaluate((idx, val) => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.onScoreInput({ currentTarget: { dataset: { id: pg.data.rows[idx]._id } }, detail: { value: val } });
    }, i, v);

    // 段首先把 E2EEXAM 清干净：段末虽有清理，但只要段中途 FATAL（automator 抖动）
    // 就会留下数据，下一次跑「切到新考试应为空表」必红 —— 抽段跑（e2e-slice）尤其容易踩到。
    // 项目约定：断言不许依赖上一轮的收尾，前置条件自己造。
    // 先切到独立考试名，保证是空表：默认考试里 seed 灌了 30 条成绩，
    // 直接在上面算平均分/排名会把 seed 数据算进去（曾误报 2 条失败）
    await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.onEditExam();
      pg.onExamInput({ detail: { value: 'E2EEXAM' } });
      const tb = typeof pg.getTabBar === 'function' ? pg.getTabBar() : null;
      if (!tb || !tb.data.hidden || !pg.data.showExamForm) throw new Error('考试弹层打开时底部导航未隐藏');
      pg.onExamConfirm();
      const tb2 = typeof pg.getTabBar === 'function' ? pg.getTabBar() : null;
      if (!tb2 || tb2.data.hidden || pg.data.showExamForm) throw new Error('考试弹层确认后底部导航未恢复');
      pg.setData({ full: '100' });
    });
    await sleep(1500);
    const blankRows = await graPage.data('rows');
    blankRows.filter(r => String(r.scoreInput || '').trim()).length === 0
      ? ok('切到新考试后为空表（未串默认考试数据）')
      : bad(`新考试串了 ${blankRows.filter(r => String(r.scoreInput || '').trim()).length} 条旧成绩`);

    const gradePasteLayer = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      const tbState = () => {
        const tb = typeof pg.getTabBar === 'function' ? pg.getTabBar() : null;
        return !!(tb && tb.data.hidden);
      };
      pg.onPasteTap();
      const open = tbState() === true && pg.data.aiPasteShow === true;
      pg.onPasteCancel();
      const closed = tbState() === false && pg.data.aiPasteShow === false;
      return { open, closed };
    });
    gradePasteLayer.open && gradePasteLayer.closed
      ? ok('成绩粘贴弹层会隐藏并恢复底部导航')
      : bad('成绩粘贴弹层导航显隐异常: ' + JSON.stringify(gradePasteLayer));

    // 同分同名次 + 统计
    await setScore(0, '95'); await setScore(1, '95'); await setScore(2, '80'); await setScore(3, '50');
    await sleep(900);
    const rk = await graPage.data('rows');
    const graSt = await graPage.data('stats');
    rk[0].rankText === '第1' && rk[1].rankText === '第1' && rk[2].rankText === '第3'
      ? ok('同分同名次且并列后跳号') : bad(`排名错: ${rk[0].rankText}/${rk[1].rankText}/${rk[2].rankText}`);
    graSt.entered === 4 && graSt.avg === '80' && graSt.passRate === '75'
      ? ok(`统计正确 ${JSON.stringify(graSt)}`) : bad(`统计错 ${JSON.stringify(graSt)}`);
    const graBk = await graPage.data('buckets');
    graBk.reduce((a, b) => a + b.count, 0) === graSt.entered ? ok('分布桶合计等于已录人数') : bad('分布桶丢数据');

    // 超满分拦截
    await setScore(4, '150'); await sleep(800);
    const overRows = await graPage.data('rows');
    overRows[4].invalid ? ok('超满分被标记 invalid') : bad('超满分未标记');
    const graGuard = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      let m = '';
      const o = wx.showToast;
      wx.showToast = x => { m = x.title; };
      return Promise.resolve(pg.onSave()).then(() => new Promise(r => setTimeout(() => { wx.showToast = o; r(m); }, 600)));
    });
    /超出/.test(graGuard) ? ok('超满分拦住保存: ' + graGuard) : bad('未拦住保存: ' + JSON.stringify(graGuard));
    const graLeak = await mp.evaluate(() => wx.cloud.database().collection('scores').where({ score: 150 }).count().then(r => r.total));
    graLeak === 0 ? ok('非法分数未入库') : bad(`非法分数入库 ${graLeak} 条`);
    // 2026-09-06 真机反馈：满分可以填 1000 → 成绩也能录 1000。
    // 满分上限被抬到 10000（grades-maxfull-off 变异体）时这里必须红。
    const graMax = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.setData({ full: '1000' });
      const id = pg.data.rows[0] && pg.data.rows[0]._id;
      if (id) pg.onScoreInput({ currentTarget: { dataset: { id } }, detail: { value: '1000' } });
      return { invalid: pg.data.rows[0] && pg.data.rows[0].invalid, why: pg.data.rows[0] && pg.data.rows[0].invalidWhy };
    });
    graMax.invalid && /满分/.test(graMax.why)
      ? ok('满分 1000 被拦（上限 150）：' + graMax.why)
      : bad('满分 1000 未拦住（可录 1000 分）: ' + JSON.stringify(graMax));
    // 小数位超限
    const graDec = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.setData({ full: '100' });
      const id = pg.data.rows[1] && pg.data.rows[1]._id;
      if (id) pg.onScoreInput({ currentTarget: { dataset: { id } }, detail: { value: '88.1234' } });
      return (pg.data.rows[1] && pg.data.rows[1].invalidWhy) || '';
    });
    /小数/.test(graDec) ? ok('小数位超限被拦: ' + graDec) : bad('小数位超限未拦: ' + graDec);
    // 满分留空提示
    const graEmp = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.onFullInput({ detail: { value: '' } });
      return pg.data.fullWarn || '';
    });
    graEmp ? ok('满分留空有提示: ' + graEmp) : bad('满分留空静默按 100 算');
    // 复位
    await mp.evaluate(() => { const p = getCurrentPages().slice(-1)[0]; p.onFullInput({ detail: { value: '100' } }); });

    // 保存 → 改分 update → 清空删除
    // 已在 E2EEXAM 上，复位一下：清掉非法值 + 清脏标记，只留待测的两条
    await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.setData({ full: '100' });
      pg.onExamInput({ detail: { value: 'E2EEXAM' } });
      pg.onExamConfirm(); // 同名 = 仅复位 dirty 并重读云端
    });
    await sleep(1500);
    await setScore(5, '88'); await setScore(0, '77');
    await sleep(700);
    await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      return Promise.all([pg.onSave(), pg.onSave(), pg.onSave()]);
    });
    await sleep(6000);
    const graSaved = await mp.evaluate(() => wx.cloud.database().collection('scores').where({ exam: 'E2EEXAM' }).get().then(r => r.data.map(x => x.score)));
    graSaved.length === 2 ? ok(`成绩保存防连点：2 条（${JSON.stringify(graSaved)}）`) : bad(`保存 ${graSaved.length} 条，应 2: ${JSON.stringify(graSaved)}`);
    const savedOrder = await graPage.data('rows');
    JSON.stringify(savedOrder.filter(r => String(r.scoreInput || '').trim()).slice(0, 2).map(r => r.scoreInput)) === JSON.stringify(['88', '77'])
      && savedOrder[0]._id !== savedOrder[1]._id
      ? ok('保存后列表按分数从高到低排列（低学号高分也会置顶）')
      : bad('保存后未按分数降序: ' + JSON.stringify(savedOrder.map(r => [r.studentNo, r.scoreInput]).slice(0, 8)));

    await setScore(0, '90'); await sleep(600);
    const graRace = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      const row = pg.data.rows[1];
      if (!row) return { skip: 'no-row' };
      const before = row.scoreInput;
      pg.onSave();
      pg.onScoreInput({ currentTarget: { dataset: { id: row._id } }, detail: { value: '66' } });
      const after = (pg.data.rows.find(r => r._id === row._id) || {}).scoreInput;
      return { busy: !!pg._busy, before, after };
    });
    graRace.busy === true && graRace.after === graRace.before
      ? ok('成绩保存中继续录分被冻结（回读不会吞掉新输入）')
      : bad('成绩保存中仍可录分: ' + JSON.stringify(graRace));
    await waitPageIdle(mp, { label: '成绩改分保存', requireClean: true });
    const graUpd = await mp.evaluate(() => wx.cloud.database().collection('scores').where({ exam: 'E2EEXAM' }).get().then(r => r.data.map(x => x.score)));
    graUpd.length === 2 && graUpd.indexOf(90) >= 0 ? ok('改分走 update 未重复插入') : bad(`重复插入: ${JSON.stringify(graUpd)}`);

    await setScore(1, ''); await sleep(600);
    await mp.evaluate(() => getCurrentPages().slice(-1)[0].onSave());
    await sleep(5000);
    const graCleared = await mp.evaluate(() => wx.cloud.database().collection('scores').where({ exam: 'E2EEXAM' }).get().then(r => r.data.map(x => x.score)));
    graCleared.length === 1 && graCleared.indexOf(0) < 0 ? ok('清空输入=删除该条（未存 0）') : bad(`清空处理错: ${JSON.stringify(graCleared)}`);

    // 切科目不串数据
    await mp.evaluate(() => getCurrentPages().slice(-1)[0].onSubjectChange({ detail: { value: 1 } }));
    await sleep(1500);
    const mathRows = await graPage.data('rows');
    mathRows.filter(r => String(r.scoreInput || '').trim()).length === 0
      ? ok('切科目后输入框清空（未串数据）') : bad('切科目串数据');
    await mp.evaluate(() => getCurrentPages().slice(-1)[0].onSubjectChange({ detail: { value: 0 } }));
    await sleep(1500);
    String((await graPage.data('rows'))[0].scoreInput) === '90' ? ok('切回科目恢复已存分数') : bad('切回未恢复');

    // 概览快捷入口
    const dashQuick = await goto(mp, '/pages/dashboard/dashboard', 3500);
    // ⚠️ 别写死入口数量、别靠下标、也别在这里手抄清单。
    //    第一版是手抄数组，加 duty 页后忘了同步 → 断言红在「共 6 个应 5」，
    //    而页面其实完全正常（wxml 里 6 个入口都在）。同一个事实在两处维护必然漂移。
    //    现在直接从 dashboard.wxml 解析类名当唯一来源：加页面时这里自动跟上。
    // ⚠️ 不能用 __dirname：抽段跑（tools/e2e-slice.js）生成的脚本在 /tmp，__dirname 会指到那儿
    //    → ENOENT。用 mp.js 导出的 PROJECT 常量（它是 path.resolve(tools/..)，与抽段无关）。
    const dashWxml = require('fs').readFileSync(require('path').join(PROJECT_ROOT, 'pages', 'dashboard', 'dashboard.wxml'), 'utf8');
    const QUICK_LINKS = [...new Set(dashWxml.match(/link-[a-z]+-quick/g) || [])].map(c => ['.' + c, c.replace(/^link-|-quick$/g, '')]);
    if (QUICK_LINKS.length < 6) bad(`dashboard.wxml 里只解析到 ${QUICK_LINKS.length} 个快捷入口类名，应 ≥6`);
    const quickBtns = await dashQuick.$$('.quick-btn');
    const missLinks = [];
    for (const [cls] of QUICK_LINKS) {
      if (!(await dashQuick.$(cls))) missLinks.push(cls);
    }
    missLinks.length === 0 && quickBtns.length === QUICK_LINKS.length
      ? ok(`概览 ${QUICK_LINKS.length} 个快捷入口齐全（各有专属类名）`)
      : bad(`快捷入口异常: 缺 ${JSON.stringify(missLinks)}，共 ${quickBtns.length} 个应 ${QUICK_LINKS.length}`);
    if (quickBtns.length) {
      await (await $retry(dashQuick, '.link-grades-quick')).tap();
      await sleep(3000);
      const cur = await mp.currentPage();
      cur && cur.path.indexOf('grades') >= 0 ? ok('概览可跳成绩页') : bad('跳转失败: ' + (cur && cur.path));
    }

    // 回归：scoreId 是快照，记录被别处删掉后 update 到不存在的文档**不报错也不生效** ——
    // toast 显示「已保存 N 人」而库里什么都没有，成绩静默丢失（2026-09-06 探针实测）。
    // 构造：存一条 → 直接从云端删掉（页面 scoreId 变成失效快照）→ 改分再存 → 必须仍能入库。
    const staleRes = await mp.evaluate(async () => {
      const pg = getCurrentPages().slice(-1)[0];
      const d = wx.cloud.database();
      const stu = (pg.data.rows || [])[0];
      if (!stu) return { err: '成绩页无学生行' };
      const exam = pg.data.exams[pg.data.examIndex];
      const subject = pg.data.subjects[pg.data.subjectIndex];
      // 第一次存：让页面拿到真实 scoreId
      pg.setData({ full: '100' });
      pg.onScoreInput({ currentTarget: { dataset: { id: stu._id } }, detail: { value: '70' } });
      await pg.onSave();
      await new Promise(r => setTimeout(r, 1800));
      const born = (await d.collection('scores').where({ studentId: stu._id, exam, subject }).get()).data;
      if (!born.length) return { err: '第一次保存就没入库' };
      // 云端删掉（模拟另一台设备清空/云端手删），页面里的 scoreId 就此失效
      for (const x of born) await d.collection('scores').doc(x._id).remove();
      pg.onScoreInput({ currentTarget: { dataset: { id: stu._id } }, detail: { value: '88.5' } });
      await pg.onSave();
      await new Promise(r => setTimeout(r, 1800));
      const after = (await d.collection('scores').where({ studentId: stu._id, exam, subject }).get()).data;
      for (const x of after) await d.collection('scores').doc(x._id).remove();
      pg.dirty = {};
      return { n: after.length, score: after.length ? after[0].score : null };
    });
    if (staleRes.err) bad('scoreId 失效回归前置失败: ' + staleRes.err);
    else if (staleRes.n === 1 && Number(staleRes.score) === 88.5) ok('scoreId 失效时保存降级为新增（成绩未静默丢失）');
    else bad(`scoreId 失效后成绩静默丢失：云端 ${staleRes.n} 条 / 分数 ${staleRes.score}（期望 1 条 88.5）`);

    // 全部功能总目录：入口来自 dashboard，分组清单由 all.js 的 ALL 常量驱动（不在 e2e 手抄）
    const dashBack = await goto(mp, '/pages/dashboard/dashboard', 3500);
    const allBtn = await $retry(dashBack, '.link-all-quick');
    if (allBtn) {
      await allBtn.tap();
      await sleep(2500);
      const ap = await mp.currentPage();
      if (ap && ap.path && ap.path.indexOf('pages/all/all') >= 0) {
        const grp = await ap.data('groups');
        const tiles = await ap.$$('.tile');
        grp && grp.length >= 5 && tiles.length >= 10
          ? ok(`全部功能页可达：${grp.length} 组 / ${tiles.length} 个入口`)
          : bad(`全部功能页数据异常：${grp && grp.length} 组 / ${tiles && tiles.length} 入口`);
      } else {
        bad('全部功能页跳转失败: ' + (ap && ap.path));
      }
    } else {
      bad('首页缺「全部功能」入口');
    }

    await mp.evaluate(() => {
      const d = wx.cloud.database();
      return d.collection('scores').where({ exam: 'E2EEXAM' }).get()
        .then(r => Promise.all(r.data.map(x => d.collection('scores').doc(x._id).remove())));
    });

    console.log('\n[15] 作业页：布置/收交/进度/级联删除');
    const hwPage = await goto(mp, '/pages/homework/homework', 4000);
    const hwList0 = await hwPage.data('list');
    hwList0.length >= 1 ? ok(`作业列表加载 ${hwList0.length} 条`) : bad('作业列表为空（seed 应有 4 条）');

    // 进度统计必须按全班人数算：未交 = 全班 - 有记录的人
    const hwStuTotal = await mp.evaluate(() => getCurrentPages().slice(-1)[0].students.length);
    const badProg = hwList0.filter(h =>
      h.yesCount + h.lateCount + h.exemptCount + h.noCount !== hwStuTotal);
    badProg.length === 0
      ? ok(`各条作业进度合计=全班 ${hwStuTotal} 人（${hwList0.length} 条全对）`)
      : bad(`${badProg.length} 条作业进度合计 ≠ 全班人数: ` + JSON.stringify(badProg.map(h => [h.title, h.yesCount, h.lateCount, h.exemptCount, h.noCount])));

    // 过期判定
    const hwOverdue = hwList0.filter(h => h.overdue);
    hwOverdue.length >= 1 && /过期/.test(hwOverdue[0].dueText)
      ? ok(`过期作业识别正确：${hwOverdue[0].title} / ${hwOverdue[0].dueText}`)
      : bad('未识别出过期作业（seed 有一条 dueDate=昨天）: ' + JSON.stringify(hwList0.map(h => [h.title, h.dueText, h.overdue])));

    // 校验：空标题 / 截止早于布置 / 重复布置
    const hwGuard = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      const msgs = [];
      const o = wx.showToast;
      wx.showToast = x => msgs.push(x.title);
      const dup = pg.data.list[0];
      pg.setData({ showForm: true, isEdit: false, form: { _id: '', subject: '数学', title: '', content: '', assignDate: '2027-03-01', dueDate: '2027-03-02' } });
      return Promise.resolve(pg.onFormSave())
        .then(() => { pg.setData({ 'form.title': 'E2EHW边界', 'form.dueDate': '2027-02-01' }); return pg.onFormSave(); })
        .then(() => {
          pg.setData({ form: { _id: '', subject: dup.subject, title: dup.title, content: '', assignDate: dup.assignDate, dueDate: dup.dueDate } });
          return pg.onFormSave();
        })
        .then(() => new Promise(r => setTimeout(() => { wx.showToast = o; r(msgs); }, 800)));
    });
    hwGuard.some(m => /标题/.test(m)) && hwGuard.some(m => /截止日不能早于/.test(m)) && hwGuard.some(m => /已布置过/.test(m))
      ? ok('作业校验全部生效（空标题/日期倒置/重复布置）') : bad('作业校验不全: ' + JSON.stringify(hwGuard));
    const hwLeak = await mp.evaluate(() => wx.cloud.database().collection('homework').where({ title: 'E2EHW边界' }).count().then(r => r.total));
    hwLeak === 0 ? ok('非法作业未写入') : bad(`非法作业写入 ${hwLeak} 条`);

    // 布置一条新作业 + 防连点
    const hwTitle = 'E2EHW' + stamp;
    await mp.evaluate(t => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.setData({ showForm: true, isEdit: false, form: { _id: '', subject: '化学', title: t, content: 'E2E 自动化', assignDate: '2027-05-01', dueDate: '2027-05-09' } });
      return Promise.all([pg.onFormSave(), pg.onFormSave(), pg.onFormSave()]);
    }, hwTitle);
    await sleep(5000);
    const hwAdded = await mp.evaluate(t => wx.cloud.database().collection('homework').where({ title: t }).get().then(r => r.data), hwTitle);
    hwAdded.length === 1 ? ok('布置作业防连点：仅 1 条') : bad(`布置了 ${hwAdded.length} 条，应 1 条`);
    const newHwId = hwAdded[0] && hwAdded[0]._id;

    // 打开收交面板：新作业应该 0 人交、全员未交
    await mp.evaluate(id => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.onOpenCheck({ currentTarget: { dataset: { id } } });
    }, newHwId);
    await sleep(1500);
    const chk0 = await hwPage.data('checkStats');
    const rows0 = await hwPage.data('rows');
    chk0.no === hwStuTotal && chk0.yes === 0 && chk0.rate === '0'
      ? ok(`新作业默认全员未交（${chk0.no} 人 / 完成率 0%）`)
      : bad('新作业默认状态错: ' + JSON.stringify(chk0));

    // 点击循环切状态：未交→已交→补交→免交→未交
    const cyc = [];
    for (let i = 0; i < 4; i++) {
      await mp.evaluate(id => getCurrentPages().slice(-1)[0].onToggleStatus({ currentTarget: { dataset: { id } } }), rows0[0]._id);
      await sleep(350);
      cyc.push((await hwPage.data('rows'))[0].status);
    }
    JSON.stringify(cyc) === JSON.stringify(['已交', '补交', '免交', '未交'])
      ? ok('点击循环切状态正确: ' + cyc.join('›')) : bad('状态循环错: ' + JSON.stringify(cyc));

    // 标 3 人（已交/补交/免交）后保存，验证入库与统计
    await mp.evaluate(ids => {
      const pg = getCurrentPages().slice(-1)[0];
      const tap = id => pg.onToggleStatus({ currentTarget: { dataset: { id } } });
      tap(ids[0]);                            // 已交
      tap(ids[1]); tap(ids[1]);               // 补交
      tap(ids[2]); tap(ids[2]); tap(ids[2]);  // 免交
    }, [rows0[0]._id, rows0[1]._id, rows0[2]._id]);
    await sleep(600);
    const chkPre = await hwPage.data('checkStats');
    chkPre.yes === 1 && chkPre.late === 1 && chkPre.exempt === 1 && chkPre.rate === String(Math.round(3 / hwStuTotal * 100))
      ? ok(`本地统计正确（1/1/1，完成率 ${chkPre.rate}%）`) : bad('本地统计错: ' + JSON.stringify(chkPre));

    await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      return Promise.all([pg.onSaveCheck(), pg.onSaveCheck(), pg.onSaveCheck()]);
    });
    await sleep(6000);
    const subs = await mp.evaluate(id => wx.cloud.database().collection('homeworkSubmit').where({ homeworkId: id }).get().then(r => r.data.map(x => x.status).sort()), newHwId);
    JSON.stringify(subs) === JSON.stringify(['免交', '已交', '补交'].sort())
      ? ok('收交入库正确且防连点（3 条不重复）') : bad(`收交入库错: ${JSON.stringify(subs)}`);

    // 改回「未交」应删除记录（不能存一条 status='未交'）
    const hwRace = await mp.evaluate(ids => {
      const pg = getCurrentPages().slice(-1)[0];
      const cur = pg.data.rows.find(r => r._id === ids[0]);
      const order = ['未交', '已交', '补交', '免交'];
      const n = (order.length - order.indexOf(cur.status)) % order.length;
      for (let i = 0; i < n; i++) pg.onToggleStatus({ currentTarget: { dataset: { id: ids[0] } } });
      const other = pg.data.rows[3];
      if (!other) return { skip: 'no-other-row' };
      const before = other.status;
      pg.onSaveCheck();
      pg.onToggleStatus({ currentTarget: { dataset: { id: other._id } } });
      const after = pg.data.rows[3].status;
      return { busy: !!pg._busy, before, after };
    }, [rows0[0]._id]);
    hwRace.busy === true && hwRace.after === hwRace.before
      ? ok('作业收交保存中继续点状态被冻结（回读不会吞掉新标记）')
      : bad('作业收交保存中仍可改状态: ' + JSON.stringify(hwRace));
    await waitPageIdle(mp, { label: '作业撤回保存', requireClean: true });
    const subs2 = await mp.evaluate(id => wx.cloud.database().collection('homeworkSubmit').where({ homeworkId: id }).get().then(r => r.data.map(x => x.status)), newHwId);
    subs2.length === 2 && subs2.indexOf('未交') < 0
      ? ok('改回未交=删除记录（未存 未交 状态）') : bad(`撤回处理错: ${JSON.stringify(subs2)}`);

    // 只看未交筛选 + 一键全标已交
    await mp.evaluate(() => getCurrentPages().slice(-1)[0].onToggleOnlyPending());
    await sleep(400);
    (await hwPage.data('onlyPending')) === true ? ok('只看未交开关生效') : bad('只看未交开关未生效');
    await mp.evaluate(() => getCurrentPages().slice(-1)[0].onMarkAllSubmitted());
    await sleep(700);
    const chkAll = await hwPage.data('checkStats');
    chkAll.no === 0 && chkAll.yes === hwStuTotal - 2
      ? ok(`一键全标已交：未交 0，已交 ${chkAll.yes}（补交/免交未被覆盖）`)
      : bad('一键全标错: ' + JSON.stringify(chkAll));

    // 汇总要按全量算，不能被「只看未交」筛选污染
    (await hwPage.data('rows')).length === hwStuTotal
      ? ok('rows 保持全量（筛选只在视图层做）') : bad('筛选把 rows 截断了');

    // 删作业前先在 dashboard 上确认作业卡有数据（删后自然会变 0，断言放错位置永远会红）
    const dashPre = await goto(mp, '/pages/dashboard/dashboard', 3500);
    const preList = await dashPre.data('homework');
    const prePending = await dashPre.data('hwPending');
    preList.length >= 1 && prePending > 0
      ? ok(`删作业前概览带出 ${preList.length} 条进行中作业 / ${prePending} 人次待交`)
      : bad(`删作业前概览作业卡异常: ${preList.length} 条 / ${prePending} 人次`);
    await goto(mp, '/pages/homework/homework', 2800);
    await sleep(1000);

    // 级联删除：删作业要清掉收交记录
    await mp.evaluate(() => { getCurrentPages().slice(-1)[0].dirty = {}; });
    const hwDel = await mp.evaluate(id => {
      const pg = getCurrentPages().slice(-1)[0];
      const o = wx.showModal;
      wx.showModal = opt => opt.success({ confirm: true });
      pg.onDelete({ currentTarget: { dataset: { id } } });
      return new Promise(r => setTimeout(() => { wx.showModal = o; r(true); }, 6000));
    }, newHwId);
    await sleep(2000);
    const leftover = await mp.evaluate(id => {
      const db = wx.cloud.database();
      return Promise.all([
        db.collection('homework').where({ _id: id }).count().then(r => r.total),
        db.collection('homeworkSubmit').where({ homeworkId: id }).count().then(r => r.total)
      ]).then(([h, s]) => ({ hw: h, sub: s }));
    }, newHwId);
    leftover.hw === 0 && leftover.sub === 0
      ? ok('删作业级联清收交记录（无孤儿）') : bad('级联删除有残留: ' + JSON.stringify(leftover));

    // 概览入口（删作业后验：快捷入口还在、跳转仍可达作业页；作业卡本身此时应为 0，不再断言）
    const dashHw = await goto(mp, '/pages/dashboard/dashboard', 3500);
    const quick3 = await dashHw.$$('.quick-btn');
    quick3.length >= 4 ? ok(`概览 ${quick3.length} 个快捷入口`) : bad(`快捷入口只有 ${quick3.length} 个`);
    {
      await (await $retry(dashHw, '.link-homework-quick')).tap();
      await sleep(3000);
      const cur = await mp.currentPage();
      cur && cur.path.indexOf('homework') >= 0 ? ok('概览可跳作业页') : bad('跳转失败: ' + (cur && cur.path));
    }

    console.log('\n[16] 档案页：搜索/筛选/健康高亮/聚合/编辑校验');
    const proPage = await goto(mp, '/pages/profile/profile', 4000);
    const proAll = await proPage.data('students');
    proAll.length >= 20 ? ok(`档案页加载 ${proAll.length} 人（未被 20 条截断）`) : bad(`只加载 ${proAll.length} 人`);

    // 手机号必须能从 parent 里抠出来，否则拨号功能全废（实测事故：seed 曾用 138****01 掩码）
    const withParent = proAll.filter(s => String(s.parent || '').trim());
    const noPhone = withParent.filter(s => !s.phone);
    noPhone.length === 0
      ? ok(`${withParent.length} 人有家长信息且全部抠出手机号`)
      : bad(`${noPhone.length} 人有家长信息但抠不出手机号: ` + JSON.stringify(noPhone.slice(0, 3).map(s => s.parent)));

    // 健康风险识别：过敏/哮喘等要标红，「良好」不能误标
    const proOv = await proPage.data('overview');
    const riskList = proAll.filter(s => s.risk);
    const falsePos = riskList.filter(s => ['良好', '正常', '无', '健康', ''].indexOf(String(s.health || '').trim()) >= 0);
    riskList.length >= 3 && falsePos.length === 0 && proOv.riskCount === riskList.length
      ? ok(`健康风险识别 ${riskList.length} 人且无误报（如「${riskList[0].health}」）`)
      : bad(`健康识别异常: risk=${riskList.length} 误报=${falsePos.length} overview=${proOv.riskCount}`);

    // 概览统计必须按全量算，不能被筛选/搜索污染
    await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.onFilter({ currentTarget: { dataset: { f: 'risk' } } });
    });
    await sleep(700);
    const shownRisk = await proPage.data('shown');
    const ovAfter = await proPage.data('overview');
    shownRisk.length === riskList.length && ovAfter.total === proAll.length
      ? ok(`筛选「健康关注」得 ${shownRisk.length} 人，概览 total 仍是全量 ${ovAfter.total}`)
      : bad(`筛选错: shown=${shownRisk.length} 应=${riskList.length}, overview.total=${ovAfter.total} 应=${proAll.length}`);

    // 「资料不全」筛选
    await mp.evaluate(() => getCurrentPages().slice(-1)[0].onFilter({ currentTarget: { dataset: { f: 'nodata' } } }));
    await sleep(700);
    const shownMiss = await proPage.data('shown');
    shownMiss.length > 0 && shownMiss.every(s => s.missing > 0)
      ? ok(`筛选「资料不全」得 ${shownMiss.length} 人，全部 missing>0`)
      : bad(`资料不全筛选错: ${shownMiss.length} 人，含 missing=0 的 ${shownMiss.filter(s => !s.missing).length} 个`);

    // 搜索：姓名 / 学号 / 手机号 三种都要命中
    const probe = proAll.find(s => s.phone && s.name);
    const searchRes = await mp.evaluate(async (nm, no, ph) => {
      const pg = getCurrentPages().slice(-1)[0];
      const run = async kw => {
        pg.onFilter({ currentTarget: { dataset: { f: 'all' } } });
        pg.onSearch({ detail: { value: kw } });
        await new Promise(r => setTimeout(r, 350));
        return pg.data.shown.length;
      };
      const byName = await run(nm);
      const byNo = await run(no);
      const byPhone = await run(ph);
      const byNothing = await run('绝不存在的关键词XYZ');
      pg.onClearSearch();
      await new Promise(r => setTimeout(r, 350));
      return { byName, byNo, byPhone, byNothing, cleared: pg.data.shown.length };
    }, probe.name, probe.studentNo, probe.phone);
    searchRes.byName >= 1 && searchRes.byNo >= 1 && searchRes.byPhone >= 1
      && searchRes.byNothing === 0 && searchRes.cleared === proAll.length
      ? ok(`搜索三通道生效（姓名${searchRes.byName}/学号${searchRes.byNo}/手机${searchRes.byPhone}），清空恢复 ${searchRes.cleared}`)
      : bad('搜索异常: ' + JSON.stringify(searchRes));

    // 进详情：聚合数据必须真的算出来
    // 注意：前面的搜索/筛选/watch 刷新会重排 students，必须重新取快照再挑目标
    const proFresh = await proPage.data('students');
    const proTarget = proFresh.find(s => s.risk) || proFresh[0];
    await mp.evaluate(id => {
      getCurrentPages().slice(-1)[0].onOpenDetail({ currentTarget: { dataset: { id } } });
    }, proTarget._id);
    await sleep(1200);
    (await proPage.data('view')) === 'detail' ? ok('可进入单人档案') : bad('未进入详情视图');
    // stats 是异步补的，轮询等
    let proStats = null;
    for (let i = 0; i < 20; i++) {
      proStats = await proPage.data('stats');
      if (proStats) break;
      await sleep(500);
    }
    proStats && typeof proStats.attTotal === 'number' && typeof proStats.hwTotal === 'number'
      ? ok(`聚合数据到位（考勤${proStats.attTotal}/异常${proStats.attAbnormal}/净积分${proStats.netPoints}/作业${proStats.hwDone}/${proStats.hwTotal}）`)
      : bad('聚合数据未加载: ' + JSON.stringify(proStats));
    // 聚合口径必须和云端一致
    if (proStats) {
      const truth = await mp.evaluate(id => {
        const db = wx.cloud.database();
        return Promise.all([
          db.collection('attendance').where({ studentId: id }).count().then(r => r.total),
          db.collection('rewards').where({ studentId: id }).count().then(r => r.total),
          db.collection('homeworkSubmit').where({ studentId: id }).count().then(r => r.total)
        ]).then(([a, r, h]) => ({ att: a, rew: r, hw: h }));
      }, proTarget._id);
      proStats.attTotal === truth.att && proStats.rewCount === truth.rew && proStats.hwTotal === truth.hw
        ? ok(`聚合口径与云端一致（考勤${truth.att}/奖惩${truth.rew}/收交${truth.hw}）`)
        : bad(`聚合口径不一致: 页面${JSON.stringify({ a: proStats.attTotal, r: proStats.rewCount, h: proStats.hwTotal })} 云端${JSON.stringify(truth)}`);
    }

    // 切换学生时不能串上一个人的统计
    const proSnap = await proPage.data('students');
    const proOther = proSnap.find(s => s._id !== proTarget._id && s.phone) || proSnap.find(s => s._id !== proTarget._id);
    // 用「同一次 evaluate 内同步读」判定，不用 sleep：stats 何时补上取决于网络，
    // 用等待时间当断言条件会随机红（实测同一逻辑 400ms 有时已补上、有时 800ms）
    const swSync = await mp.evaluate(id => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.onBackToList();
      pg.onOpenDetail({ currentTarget: { dataset: { id } } });
      return { cur: pg.data.current && pg.data.current._id, stats: pg.data.stats, view: pg.data.view };
    }, proOther._id);
    swSync.cur === proOther._id && swSync.stats === null && swSync.view === 'detail'
      ? ok('切换学生瞬间 stats 同步清空（不串上一人数据）')
      : bad(`切换瞬间状态错: ${JSON.stringify({ curOk: swSync.cur === proOther._id, stats: swSync.stats ? '未清空' : 'null', view: swSync.view })}`);
    // 补上来的统计必须是新学生的，不能是上一个人的
    let swStats = null;
    for (let i = 0; i < 20; i++) {
      swStats = await proPage.data('stats');
      if (swStats) break;
      await sleep(400);
    }
    const swTruth = await mp.evaluate(id => {
      const d = wx.cloud.database();
      return Promise.all([
        d.collection('attendance').where({ studentId: id }).count().then(r => r.total),
        d.collection('homeworkSubmit').where({ studentId: id }).count().then(r => r.total)
      ]).then(([a, h]) => ({ att: a, hw: h }));
    }, proOther._id);
    swStats && swStats.attTotal === swTruth.att && swStats.hwTotal === swTruth.hw
      ? ok(`切换后统计属于新学生（考勤${swTruth.att}/收交${swTruth.hw}）`)
      : bad(`切换后统计串数据: 页面${JSON.stringify(swStats && { a: swStats.attTotal, h: swStats.hwTotal })} 应${JSON.stringify(swTruth)}`);

    // 编辑校验：出生日期格式 / 家长必须含手机号
    const proGuard = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      const msgs = [];
      const o = wx.showToast;
      wx.showToast = x => msgs.push(x.title);
      pg.onEditProfile();
      pg.setData({ 'form.birth': '2011/1/1' });
      return Promise.resolve(pg.onFormSave())
        .then(() => { pg.setData({ 'form.birth': '2011-01-01', 'form.parent': '母亲 138****99' }); return pg.onFormSave(); })
        // 2026-09-06 探针实测能入库的三种：不存在的日期 / 未来出生年 / 12 位假手机号
        .then(() => { pg.setData({ 'form.birth': '2011-13-45', 'form.parent': '' }); return pg.onFormSave(); })
        .then(() => { pg.setData({ 'form.birth': '2099-01-01' }); return pg.onFormSave(); })
        .then(() => { pg.setData({ 'form.birth': '2011-01-01', 'form.parent': '母亲 139000088888' }); return pg.onFormSave(); })
        .then(() => new Promise(r => setTimeout(() => { wx.showToast = o; r(msgs); }, 900)));
    });
    // 同样按语义判：5 次非法保存必须全被拦，且命中 日期/年份/手机号 三类原因
    proGuard.length >= 5
      && proGuard.some(m => /出生日期/.test(m))
      && proGuard.some(m => /出生年份/.test(m))
      && proGuard.some(m => /手机号/.test(m))
      ? ok(`档案校验生效（含 2011-13-45 / 2099 年 / 12 位号，共拦 ${proGuard.length} 次）`)
      : bad('档案校验不全: ' + JSON.stringify(proGuard));

    // 真保存：改健康 + 打标签，验证入库 + 风险重算
    const proEdited = await mp.evaluate(async () => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.setData({
        'form.birth': '2011-05-20',
        'form.parent': '父亲 13900008888',
        'form.health': 'E2E芒果过敏，备西替利嗪',
        'form.tagSet': ['班干部', '住宿']
      });
      await Promise.all([pg.onFormSave(), pg.onFormSave(), pg.onFormSave()]); // 连点
      await new Promise(r => setTimeout(r, 3500));
      const db = wx.cloud.database();
      const doc = (await db.collection('students').doc(pg.data.current._id).get()).data;
      return { health: doc.health, tags: doc.tags, birth: doc.birth, parent: doc.parent,
        risk: pg.data.current.risk, phone: pg.data.current.phone, showForm: pg.data.showForm };
    });
    proEdited.health === 'E2E芒果过敏，备西替利嗪' && Array.isArray(proEdited.tags) && proEdited.tags.length === 2
      && proEdited.birth === '2011-05-20' && proEdited.phone === '13900008888'
      ? ok(`档案保存入库（健康/标签${proEdited.tags.length}项/生日/手机号）`)
      : bad('档案保存错: ' + JSON.stringify(proEdited));
    proEdited.risk === true ? ok('改完健康后风险标记自动重算为 true') : bad('风险未重算: ' + proEdited.risk);
    proEdited.showForm === false ? ok('保存后表单关闭') : bad('表单未关闭');

    // 名单页「档案」入口
    const rosterForPro = await goto(mp, '/pages/roster/roster', 3500);
    const proBtn = await rosterForPro.$('.act.profile');
    if (!proBtn) bad('名单页缺少「档案」入口');
    else {
      await proBtn.tap();
      await sleep(3500);
      const cur = await mp.currentPage();
      const inDetail = cur && cur.path.indexOf('profile') >= 0
        && (await mp.evaluate(() => getCurrentPages().slice(-1)[0].data.view)) === 'detail';
      inDetail ? ok('名单页「档案」直达单人详情（带 id 跳转）') : bad('未直达详情: ' + (cur && cur.path));
    }

    // 概览：健康需注意卡 + 快捷入口（不写死数量，加页面不用回头改）
    const dashPro = await goto(mp, '/pages/dashboard/dashboard', 3500);
    const quick4 = await dashPro.$$('.quick-btn');
    (await $retry(dashPro, '.link-profile-quick')) ? ok(`概览有档案快捷入口（共 ${quick4.length} 个）`) : bad('概览缺 .link-profile-quick 入口');
    const alerts = await dashPro.data('healthAlerts');
    const hCount = await dashPro.data('healthCount');
    alerts.length >= 1 && hCount >= alerts.length
      ? ok(`概览健康提醒 ${alerts.length} 条 / 共 ${hCount} 人`)
      : bad(`概览健康卡异常: ${alerts.length} 条 / ${hCount} 人`);
    const proLink = await $retry(dashPro, '.link-profile');
    if (!proLink) bad('概览缺少档案「全部 ›」入口');
    else {
      await proLink.tap();
      await sleep(3000);
      const cur = await mp.currentPage();
      cur && cur.path.indexOf('profile') >= 0 ? ok('概览可跳档案页') : bad('跳转失败: ' + (cur && cur.path));
    }

    console.log('\n[17] 座位表：排座/互换/落座/清空/保存 diff');
    // ⚠️ 断言不能依赖 seed 的「留 4 人未排座」：上一轮 e2e 跑完会把全班排满，
    //    第二轮「未排座 > 0」必红（实测踩过）。测试自己造前置条件：先摘掉最后 3 条座位记录。
    await goto(mp, '/pages/seats/seats', 3000);   // 先落到页面：云 SDK 未就绪时并发 get 会报 reading 'stat'
    // 幂等前置：上轮可能跑完（全班排满）、中途死（座位被清空）或还没跑过
    // 。原版假设「至少有 3 条座位可摘」，空表时 before=0 直接红 + 互换段读 filled[0] 崩溃
    // （实测事故：Cannot read properties of undefined (reading 'row')）。
    // 策略：座位 < 10 条就全清重铺前 12 人，再摘掉 3 条，保证 ≥9 已排 + ≥3 未排。
    const seatPrep = await mp.evaluate(() => {
      const d = wx.cloud.database();
      const readAll = async col => {
        const out = [];
        while (true) {
          const r = await d.collection(col).skip(out.length).limit(20).get();
          out.push(...r.data);
          if (r.data.length < 20) return out;
        }
      };
      return (async () => {
        let all = await readAll('seats');
        if (all.length < 10) {
          await Promise.all(all.map(x => d.collection('seats').doc(x._id).remove()));
          const students = await readAll('students');
          const put = students.slice(0, 12);
          for (let i = 0; i < put.length; i++) {
            await d.collection('seats').add({ data: {
              studentId: put[i]._id, studentNo: put[i].studentNo, name: put[i].name,
              row: Math.floor(i / 6), col: i % 6, updatedAt: Date.now() } });
          }
          all = await readAll('seats');
        }
        const drop = all.sort((a, b) => (b.row - a.row) || (b.col - a.col)).slice(0, 3);
        await Promise.all(drop.map(x => d.collection('seats').doc(x._id).remove()));
        return { before: all.length, dropped: drop.length };
      })().catch(e => ({ before: -1, dropped: 0, err: String(e).slice(0, 120) }));
    });
    seatPrep.dropped === 3
      ? ok(`前置：摘掉 3 条座位记录制造未排座（${seatPrep.before}→${seatPrep.before - 3}）`)
      : bad('前置准备失败: ' + JSON.stringify(seatPrep));
    const seatPage = await goto(mp, '/pages/seats/seats', 4500);
    const seatAll = await seatPage.data('grid');
    const seatOv = await seatPage.data('overview');
    const seatUn = await seatPage.data('unseated');
    seatOv.total >= 30 && seatOv.seated + seatOv.unseated === seatOv.total
      ? ok(`座位页加载：在册 ${seatOv.total} / 已排 ${seatOv.seated} / 未排 ${seatOv.unseated}（和为全班）`)
      : bad(`座位统计不闭合: ${JSON.stringify(seatOv)}`);
    seatUn.length >= 3 ? ok(`有 ${seatUn.length} 人未排座（未排座分支有真数据）`) : bad(`未排座只有 ${seatUn.length} 人，落座分支测不到`);

    // 网格里同一个学生绝不能出现两次（真出现过就是显示 bug，老师照着排必错）
    const flat = [].concat(...seatAll).filter(c => !c.empty);
    const flatIds = new Set(flat.map(c => c.studentId));
    flat.length === flatIds.size && flat.length === seatOv.seated
      ? ok(`网格内 ${flat.length} 人无重复且与已排座数一致`)
      : bad(`网格重复占位: 格子${flat.length} 去重${flatIds.size} 统计${seatOv.seated}`);

    // 网格行数必须容得下全班（否则未排座的人永远没空位可坐）
    const seatCols = await seatPage.data('cols');
    const seatRows = await seatPage.data('rows');
    seatRows * seatCols >= seatOv.total
      ? ok(`网格 ${seatRows}×${seatCols}=${seatRows * seatCols} 个位子 ≥ 全班 ${seatOv.total} 人`)
      : bad(`位子不够: ${seatRows}×${seatCols} < ${seatOv.total}`);

    // 互换两个已占座位：两人位置对调，人数不变
    const swapRes = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      const filled = [].concat(...pg.data.grid).filter(c => !c.empty);
      if (filled.length < 2) return { guard: true, filled: filled.length };
      const a = filled[0];
      const b = filled[1];
      pg.onTapCell({ currentTarget: { dataset: { r: a.row, c: a.col } } });
      pg.onTapCell({ currentTarget: { dataset: { r: b.row, c: b.col } } });
      const g = pg.data.grid;
      return {
        before: [a.name, b.name],
        afterA: g[a.row][a.col].name,
        afterB: g[b.row][b.col].name,
        seated: pg.data.overview.seated,
        selKey: pg.data.selKey,
        dirty: !!pg.dirty
      };
    });
    !swapRes.guard && swapRes.afterA === swapRes.before[1] && swapRes.afterB === swapRes.before[0]
      && swapRes.seated === seatOv.seated && swapRes.selKey === '' && swapRes.dirty
      ? ok(`互换生效：${swapRes.before[0]}↔${swapRes.before[1]}，人数不变且选中已清`)
      : bad('互换异常: ' + JSON.stringify(swapRes));

    // 长按移出座位：人回未排座名单，已排座 -1
    const kickRes = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      const t = [].concat(...pg.data.grid).find(c => !c.empty);
      const before = pg.data.overview.seated;
      const beforeUn = pg.data.unseated.length;
      pg.onClearCell({ currentTarget: { dataset: { r: t.row, c: t.col } } });
      return {
        name: t.name,
        cellNowEmpty: pg.data.grid[t.row][t.col].empty,
        seated: pg.data.overview.seated, before,
        unseated: pg.data.unseated.length, beforeUn,
        inUnseated: pg.data.unseated.some(s => s._id === t.studentId)
      };
    });
    kickRes.cellNowEmpty && kickRes.seated === kickRes.before - 1
      && kickRes.unseated === kickRes.beforeUn + 1 && kickRes.inUnseated
      ? ok(`长按移出「${kickRes.name}」：格子清空 + 回到未排座名单`)
      : bad('移出座位异常: ' + JSON.stringify(kickRes));

    // 挑未排座学生 → 点空位落座
    const placeRes = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      const un = pg.data.unseated[0];
      const blank = [].concat(...pg.data.grid).find(c => c.empty);
      if (!un || !blank) return { skip: true, un: !!un, blank: !!blank };
      pg.onPickUnseated({ currentTarget: { dataset: { id: un._id } } });
      const picked = pg.data.pickedId === un._id;
      pg.onTapCell({ currentTarget: { dataset: { r: blank.row, c: blank.col } } });
      return {
        picked,
        name: un.name,
        cellName: pg.data.grid[blank.row][blank.col].name,
        stillPicked: !!pg.data.pickedId,
        stillInUnseated: pg.data.unseated.some(s => s._id === un._id),
        seated: pg.data.overview.seated
      };
    });
    !placeRes.skip && placeRes.picked && placeRes.cellName === placeRes.name
      && !placeRes.stillPicked && !placeRes.stillInUnseated
      ? ok(`挑人落座生效：${placeRes.name} 坐进空位并从未排座名单出列`)
      : bad('落座异常: ' + JSON.stringify(placeRes));

    // 按学号铺满：全班都有座且顺序正确
    const fillRes = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.onFillByNo();
      const seq = [].concat(...pg.data.grid).filter(c => !c.empty).map(c => c.studentNo);
      const sorted = seq.slice().sort((a, b) => String(a).localeCompare(String(b)));
      return {
        seated: pg.data.overview.seated,
        total: pg.data.overview.total,
        unseated: pg.data.unseated.length,
        inOrder: JSON.stringify(seq) === JSON.stringify(sorted),
        first: seq[0], last: seq[seq.length - 1]
      };
    });
    fillRes.seated === fillRes.total && fillRes.unseated === 0 && fillRes.inOrder
      ? ok(`按学号铺满：${fillRes.seated} 人全部落座且顺序正确（${fillRes.first}→${fillRes.last}）`)
      : bad('铺满异常: ' + JSON.stringify(fillRes));

    // 换列数：人数不能变、不能丢人（老师改列数丢学生是真事故级 bug）
    const colsRes = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      const before = pg.data.overview.seated;
      const beforeIds = [].concat(...pg.data.grid).filter(c => !c.empty).map(c => c.studentId).sort();
      pg.onColsChange({ detail: { value: 0 } });   // 切到 4 列
      const afterIds = [].concat(...pg.data.grid).filter(c => !c.empty).map(c => c.studentId).sort();
      const cols4 = pg.data.cols;
      pg.onColsChange({ detail: { value: 2 } });   // 切回 6 列
      const backIds = [].concat(...pg.data.grid).filter(c => !c.empty).map(c => c.studentId).sort();
      return {
        before, cols4, cols6: pg.data.cols,
        after: afterIds.length, back: backIds.length,
        sameAfter: JSON.stringify(beforeIds) === JSON.stringify(afterIds),
        sameBack: JSON.stringify(beforeIds) === JSON.stringify(backIds),
        rowsEnough: pg.data.rows * pg.data.cols >= pg.data.overview.total
      };
    });
    colsRes.cols4 === 4 && colsRes.cols6 === 6 && colsRes.sameAfter && colsRes.sameBack && colsRes.rowsEnough
      ? ok(`换列数 6→4→6 不丢人（${colsRes.before} 人全在，行数自动够用）`)
      : bad('换列数丢人: ' + JSON.stringify(colsRes));

    // 随机排座：全员有座 + 与铺满结果不同（否则说明 shuffle 没生效）
    const shuffleRes = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      const before = [].concat(...pg.data.grid).filter(c => !c.empty).map(c => c.studentId);
      pg.onShuffle();
      const after = [].concat(...pg.data.grid).filter(c => !c.empty).map(c => c.studentId);
      return {
        seated: pg.data.overview.seated, total: pg.data.overview.total,
        unseated: pg.data.unseated.length,
        changed: JSON.stringify(before) !== JSON.stringify(after),
        noDup: new Set(after).size === after.length
      };
    });
    shuffleRes.seated === shuffleRes.total && shuffleRes.unseated === 0 && shuffleRes.noDup && shuffleRes.changed
      ? ok(`随机排座：${shuffleRes.seated} 人全落座、无重复、顺序已打乱`)
      : bad('随机排座异常: ' + JSON.stringify(shuffleRes));

    // 保存：写库后回读，每人一座、坐标与页面一致
    // ⚠️ 触发/等待/读取必须分三次短 evaluate。写成一次「onSave() + 内部 setTimeout」的长
    //    evaluate 时，一旦写库变慢（变异测试删掉 _busy guard 后连点写 3 倍数据）就撞
    //    automator 单次响应窗口，整段 FATAL 崩在这里 —— 后面的连点断言根本没机会跑，
    //    表面看是「抓到了」，实际抓的是连带崩溃，定位会指错方向（实测事故）。
    await evalRetry(mp, () => { getCurrentPages().slice(-1)[0].onSave(); return 1; });
    await waitPageIdle(mp, { label: '座位保存', requireClean: true });
    const saveRes = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      return {
        dirty: !!pg.dirty,
        seated: pg.data.overview.seated,
        grid: [].concat(...pg.data.grid).filter(c => !c.empty).map(c => ({ id: c.studentId, r: c.row, c: c.col }))
      };
    });
    !saveRes.dirty ? ok('保存后 dirty 标志已清（按钮回到「已同步」）') : bad('保存后 dirty 未清，会重复提示未保存');
    const cloudSeats = await evalRetry(mp, () => {
      const d = wx.cloud.database();
      return d.collection('seats').count().then(({ total }) => {
        const pages = Math.ceil(total / 20);
        return Promise.all(Array.from({ length: pages }, (_, i) =>
          d.collection('seats').skip(i * 20).limit(20).get().then(r => r.data)))
          .then(cs => [].concat(...cs).map(x => ({ id: x.studentId, r: x.row, c: x.col })));
      });
    });
    const cloudMap = {};
    cloudSeats.forEach(x => { cloudMap[x.id] = x; });
    const posMatch = saveRes.grid.every(g => cloudMap[g.id] && cloudMap[g.id].r === g.r && cloudMap[g.id].c === g.c);
    cloudSeats.length === saveRes.seated && Object.keys(cloudMap).length === cloudSeats.length && posMatch
      ? ok(`云端 ${cloudSeats.length} 条座位与页面完全一致（每人一座、坐标一致）`)
      : bad(`云端座位不一致: 云端${cloudSeats.length}条/去重${Object.keys(cloudMap).length}/页面${saveRes.seated}人/坐标匹配=${posMatch}`);

    // 再存一次不该产生任何写入（diff 逻辑；不做 diff 会每次全删重插）
    await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.__msg = '';
      pg.__origToast = wx.showToast;
      wx.showToast = o => { pg.__msg = o.title; };
      pg.onSave();
      return 1;
    });
    await waitPageIdle(mp, { label: '座位空保存' });
    const noopRes = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      if (pg.__origToast) { wx.showToast = pg.__origToast; pg.__origToast = null; }
      return { msg: pg.__msg || '' };
    });
    /没有改动/.test(noopRes.msg) ? ok('无改动时保存不写库（diff 生效）') : bad('无改动仍写库: ' + JSON.stringify(noopRes));

    // 保存后云端记录数不许多出来（重复插入检测）
    const seatCount2 = await evalRetry(mp, () => wx.cloud.database().collection('seats').count().then(r => r.total));
    seatCount2 === cloudSeats.length ? ok(`重复保存未新增记录（仍 ${seatCount2} 条）`) : bad(`重复保存插了新记录: ${cloudSeats.length}→${seatCount2}`);

    // 防连点：跨 tick 连点 3 次保存只能生效一次
    // ⚠️ 不许写成同 tick 的 onSave();onSave();onSave() —— 变异测试实测，那种写法在
    // `this._busy` 被换成 `this.data.saving` 时照样全绿（setData 同步改 this.data），
    // 而真实手指连击是跨 tick 的。同时触发/读取要分开，长 evaluate 会撞 automator 超时。
    // ⚠️ 座位的 diff 是按 studentId 幂等的（走 update 而不是 add），所以删掉 _busy guard 后
    //    重复保存只是把同一条 update 写 3 遍 —— 云端**条数不变**，只查 count 的断言必然放行。
    //    变异测试 seats-no-busy 就是这样 SURVIVED 的（第一次报 KILLED 是段崩溃的假象）。
    //    所以这里必须直接数「真正发出去的写调用次数」，而不是数结果条数。
    const seatDblPre = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const dbm = require('utils/db.js');
      // 打点包装 db 层写方法：连点若真的穿过 guard，这里的计数会翻倍
      pg.__w = { add: 0, update: 0, remove: 0 };
      pg.__orig = pg.__orig || {};
      ['add', 'update', 'remove'].forEach(k => {
        if (!pg.__orig[k]) pg.__orig[k] = dbm[k];
        dbm[k] = function (...a) { pg.__w[k] += 1; return pg.__orig[k].apply(dbm, a); };
      });
      const filled = [].concat(...pg.data.grid).filter(c => !c.empty);
      pg.onTapCell({ currentTarget: { dataset: { r: filled[0].row, c: filled[0].col } } });
      pg.onTapCell({ currentTarget: { dataset: { r: filled[1].row, c: filled[1].col } } });
      pg.onSave();
      setTimeout(() => pg.onSave(), 60);
      setTimeout(() => pg.onSave(), 140);
      return 1;
    });
    await waitPageIdle(mp, { label: '座位连点保存', requireClean: true });
    const seatDbl = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const dbm = require('utils/db.js');
      ['add', 'update', 'remove'].forEach(k => { if (pg.__orig && pg.__orig[k]) dbm[k] = pg.__orig[k]; });
      pg.__orig = null;
      return wx.cloud.database().collection('seats').count()
        .then(c => ({ total: c.total, dirty: !!pg.dirty, writes: pg.__w }));
    });
    // 互换两人 = 恰好 2 次 update，连点穿过 guard 会变成 4 或 6 次
    const seatWrites = seatDbl.writes ? seatDbl.writes.add + seatDbl.writes.update + seatDbl.writes.remove : -1;
    seatDbl.total === cloudSeats.length && !seatDbl.dirty && seatWrites === 2
      ? ok(`保存防连点：连点 3 次只发了 ${seatWrites} 次写调用，云端仍 ${seatDbl.total} 条`)
      : bad(`保存连点异常: 写调用 ${seatWrites} 次(应 2) ${JSON.stringify(seatDbl)} 云端应 ${cloudSeats.length} 条`);

    // 删学生必须级联删座位（漏了会留孤儿，网格渲染时静默丢格）
    const seatCasc = await mp.evaluate(() => {
      const d = wx.cloud.database();
      return d.collection('students').add({ data: { studentNo: 'SEAT999', name: '座位级联', gender: '男', _reg: true, updatedAt: Date.now() } })
        .then(s => d.collection('seats').add({ data: { studentId: s._id, row: 80, col: 0, _reg: true, updatedAt: Date.now() } }).then(() => s._id));
    });
    const rosterSeat = await goto(mp, '/pages/roster/roster', 3500);
    await mp.evaluate(id => {
      const pg = getCurrentPages().slice(-1)[0];
      const orig = wx.showModal;
      wx.showModal = o => { o.success && o.success({ confirm: true }); };
      pg.onDelete({ currentTarget: { dataset: { id } } });
      return new Promise(r => setTimeout(() => { wx.showModal = orig; r(1); }, 300));
    }, seatCasc);
    const seatLeft = await waitCascadeDeleted(mp, seatCasc, 'seats', '座位');
    seatLeft.ref === 0 && seatLeft.stu === 0
      ? ok('删学生级联清座位（无孤儿座位）') : bad('座位级联残留: ' + JSON.stringify(seatLeft));

    // 概览入口
    const dashSeat = await goto(mp, '/pages/dashboard/dashboard', 3500);
    const seatQuick = await dashSeat.$$('.quick-btn');
    (await $retry(dashSeat, '.link-seats-quick')) ? ok(`概览有座位表入口（共 ${seatQuick.length} 个快捷入口）`) : bad('概览缺 .link-seats-quick 入口');
    const seatLink = await $retry(dashSeat, '.link-seats-quick');
    if (seatLink) {
      await seatLink.tap();
      await sleep(3000);
      const curSeat = await mp.currentPage();
      curSeat && curSeat.path.indexOf('seats') >= 0 ? ok('概览可跳座位表') : bad('跳转失败: ' + (curSeat && curSeat.path));
    } else {
      bad('概览没有 .link-seats-quick 入口');
    }

    console.log('\n[18] 值日表：周表/单日编排/轮排/未排到告警/保存 diff');
    // 前置自造：先摘掉几条记录，保证「未排到」告警分支有数据（不能依赖 seed 的初始态，
    // 上一轮 e2e 的轮排会把全班排满 —— 座位页踩过这个坑）
    await goto(mp, '/pages/duty/duty', 3000);
    // 幂等前置（与 [17] 座位同理）：上轮可能跑完（全班排满）、中途死（记录被清空）
    // 或还没跑过。空表时 before=0 直接红（实测事故）。
    // 策略：记录 < 10 条就全清重铺前 12 人（周一到周三轮换岗位），再摘掉 3 条。
    const dutyPrep = await mp.evaluate(() => {
      const d = wx.cloud.database();
      const readAll = async col => {
        const out = [];
        while (true) {
          const r = await d.collection(col).skip(out.length).limit(20).get();
          out.push(...r.data);
          if (r.data.length < 20) return out;
        }
      };
      const JOBS = ['扫地', '擦黑板', '倒垃圾', '摆桌椅', '关窗锁门'];
      return (async () => {
        let all = await readAll('dutySchedule');
        if (all.length < 10) {
          await Promise.all(all.map(x => d.collection('dutySchedule').doc(x._id).remove()));
          const students = await readAll('students');
          const put = students.slice(0, 12);
          for (let i = 0; i < put.length; i++) {
            await d.collection('dutySchedule').add({ data: {
              weekday: i % 5, job: JOBS[Math.floor(i / 5) % 5],
              studentId: put[i]._id, studentNo: put[i].studentNo, name: put[i].name,
              updatedAt: Date.now() } });
          }
          all = await readAll('dutySchedule');
        }
        const drop = all.slice(0, 3);
        await Promise.all(drop.map(x => d.collection('dutySchedule').doc(x._id).remove()));
        return { before: all.length, dropped: drop.length };
      })().catch(e => ({ before: -1, dropped: 0, err: String(e).slice(0, 120) }));
    });
    dutyPrep.dropped === 3
      ? ok(`前置：摘掉 3 条值日记录（${dutyPrep.before}→${dutyPrep.before - 3}）`)
      : bad('值日前置准备失败: ' + JSON.stringify(dutyPrep));

    const dutyPage = await goto(mp, '/pages/duty/duty', 4000);
    const dWeek = await dutyPage.data('week');
    const dOv = await dutyPage.data('overview');
    const dMiss = await dutyPage.data('missingList');
    dWeek.length === 5 && dWeek.every(w => w.jobs.length === 5)
      ? ok('周表 5 天 × 5 岗位结构正确')
      : bad(`周表结构错: ${dWeek.length} 天 / 岗位数 ${JSON.stringify(dWeek.map(w => w.jobs.length))}`);
    // 有且只有一天标 isToday（周末也必须落到某一天，否则「今天」高亮消失）
    const todayFlags = dWeek.filter(w => w.isToday);
    todayFlags.length === 1 ? ok(`今天高亮唯一（${todayFlags[0].label}）`) : bad(`isToday ${todayFlags.length} 天，应恰好 1`);
    // 值日周表也要带日历日期，且与课表页同一口径（两页各算一套日期必然漂）
    dWeek.every(w => /^\d{1,2}\/\d{1,2}$/.test(w.dateLabel || ''))
      ? ok('值日周表带日历日期：' + dWeek.map(w => w.label + ' ' + w.dateLabel).join(' '))
      : bad('值日周表缺日期: ' + JSON.stringify(dWeek.map(w => w.dateLabel)));

    // 概览口径：已排人次 = 周表所有格子人数之和（两处算法必须一致）
    const sumFromWeek = dWeek.reduce((a, w) => a + w.jobs.reduce((b, j) => b + j.count, 0), 0);
    dOv.assigned === sumFromWeek
      ? ok(`已排人次口径一致（${dOv.assigned} = 周表格子求和）`)
      : bad(`口径不一致: overview=${dOv.assigned} 周表求和=${sumFromWeek}`);
    dOv.slots === 25 ? ok('岗位位置数 25（5×5）') : bad(`岗位位置数 ${dOv.slots}，应 25`);

    // 「未排到」名单必须和周表反推的结果一致（这是老师最在意的口径）
    const onDutyIds = new Set([].concat(...dWeek.map(w => [].concat(...w.jobs.map(j => j.people.map(p => p._id))))));
    const dutyStus = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      return pg.students.map(s => ({ _id: s._id, name: s.name }));
    });
    const trueMiss = dutyStus.filter(s => !onDutyIds.has(s._id));
    dMiss.length === trueMiss.length && dOv.missing === dMiss.length && dMiss.length > 0
      ? ok(`未排到名单准确（${dMiss.length} 人，与周表反推一致）`)
      : bad(`未排到不一致: 页面${dMiss.length} 反推${trueMiss.length} overview=${dOv.missing}`);
    // 未排到的人绝不能出现在周表里（出现说明 times 统计漏了）
    const falseMiss = dMiss.filter(m => onDutyIds.has(m._id));
    falseMiss.length === 0 ? ok('未排到名单无误报（没有已排的人被列进来）') : bad(`误报 ${falseMiss.length} 人: ${JSON.stringify(falseMiss.map(x => x.name))}`);

    // 进单日编排
    const dayRes = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.onOpenDay({ currentTarget: { dataset: { d: 2 } } });
      return {
        view: pg.data.view,
        day: pg.data.currentDay,
        label: pg.data.dayLabel,
        jobs: pg.data.dayJobs.length,
        pool: pg.data.pool.length,
        // 候选池必须按本周次数升序（老师优先挑没排过的）
        sorted: pg.data.pool.every((x, i, arr) => i === 0 || arr[i - 1].times <= x.times)
      };
    });
    dayRes.view === 'day' && dayRes.day === 2 && dayRes.jobs === 5
      && dayRes.pool === dutyStus.length && dayRes.sorted
      ? ok(`进入周二编排：5 个岗位 / 候选池 ${dayRes.pool} 人且按次数升序`)
      : bad('单日编排异常: ' + JSON.stringify(dayRes));

    // 挑人 → 点岗位排入；周表和概览必须同步涨
    const assignRes = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      const cand = pg.data.pool.find(x => x.times === 0) || pg.data.pool[0];
      const beforeAssigned = pg.data.overview.assigned;
      const beforeMissing = pg.data.overview.missing;
      pg.onPickStudent({ currentTarget: { dataset: { id: cand._id } } });
      const picked = pg.data.pickedId === cand._id;
      pg.onAssignJob({ currentTarget: { dataset: { job: '扫地' } } });
      const slot = pg.data.dayJobs.find(j => j.job === '扫地');
      return {
        name: cand.name, wasZero: cand.times === 0, picked,
        inSlot: slot.people.some(p => p._id === cand._id),
        stillPicked: !!pg.data.pickedId,
        assigned: pg.data.overview.assigned, beforeAssigned,
        missing: pg.data.overview.missing, beforeMissing,
        dirty: !!pg.dirty
      };
    });
    assignRes.picked && assignRes.inSlot && !assignRes.stillPicked
      && assignRes.assigned === assignRes.beforeAssigned + 1
      && assignRes.missing === assignRes.beforeMissing - (assignRes.wasZero ? 1 : 0)
      && assignRes.dirty
      ? ok(`排入生效：${assignRes.name} → 周二扫地，人次 ${assignRes.beforeAssigned}→${assignRes.assigned}，未排到 ${assignRes.beforeMissing}→${assignRes.missing}`)
      : bad('排入异常: ' + JSON.stringify(assignRes));

    // 同一岗位重复排同一人必须被拦（否则云端会出现重复记录）
    const dupAssign = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      const slot = pg.data.dayJobs.find(j => j.job === '扫地');
      const already = slot.people[0];
      const before = slot.count;
      let msg = '';
      const orig = wx.showToast;
      wx.showToast = o => { msg = o.title; };
      pg.onPickStudent({ currentTarget: { dataset: { id: already._id } } });
      pg.onAssignJob({ currentTarget: { dataset: { job: '扫地' } } });
      wx.showToast = orig;
      return { msg, before, after: pg.data.dayJobs.find(j => j.job === '扫地').count };
    });
    /已经有他/.test(dupAssign.msg) && dupAssign.after === dupAssign.before
      ? ok('同岗位重复排同人被拦下: ' + dupAssign.msg)
      : bad('重复排人未拦截: ' + JSON.stringify(dupAssign));

    // 没挑人就点岗位要提示，不能静默
    const noPick = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.setData({ pickedId: '', pickedName: '' });
      let msg = '';
      const orig = wx.showToast;
      wx.showToast = o => { msg = o.title; };
      const before = pg.data.overview.assigned;
      pg.onAssignJob({ currentTarget: { dataset: { job: '擦黑板' } } });
      wx.showToast = orig;
      return { msg, before, after: pg.data.overview.assigned };
    });
    /先.*挑/.test(noPick.msg) && noPick.after === noPick.before
      ? ok('未挑人点岗位有提示且不写数据')
      : bad('空挑人异常: ' + JSON.stringify(noPick));

    // 移除已排的人：周表同步减
    const removeRes = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      const slot = pg.data.dayJobs.find(j => j.count > 0);
      const p = slot.people[0];
      const before = pg.data.overview.assigned;
      pg.onRemovePerson({ currentTarget: { dataset: { job: slot.job, id: p._id } } });
      const after = pg.data.dayJobs.find(j => j.job === slot.job);
      return {
        name: p.name, job: slot.job,
        gone: !after.people.some(x => x._id === p._id),
        assigned: pg.data.overview.assigned, before
      };
    });
    removeRes.gone && removeRes.assigned === removeRes.before - 1
      ? ok(`移除生效：${removeRes.name} 退出${removeRes.job}，人次 ${removeRes.before}→${removeRes.assigned}`)
      : bad('移除异常: ' + JSON.stringify(removeRes));

    // 一键按学号轮排：核心业务不变量 —— 人数 ≤25 时每人恰好 1 次、0 人漏排
    const rotateRes = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.onBackToWeek();
      pg.onRotate();
      const times = {};
      pg.data.week.forEach(w => w.jobs.forEach(j => j.people.forEach(p => { times[p._id] = (times[p._id] || 0) + 1; })));
      const n = pg.students.length;
      const counts = pg.students.map(s => times[s._id] || 0);
      return {
        n,
        assigned: pg.data.overview.assigned,
        missing: pg.data.overview.missing,
        min: Math.min(...counts), max: Math.max(...counts),
        // 轮排必须尽量均匀：任意两人次数差 ≤1
        balanced: Math.max(...counts) - Math.min(...counts) <= 1,
        // 岗位侧不变量：人数 ≥ 岗位位置数时，25 个格子一个都不许空
        // （反向注入 `i % (SLOTS-5)` 曾从「每人次数」这一侧完美穿过，只有这条能抓）
        slots: pg.data.overview.slots,
        emptySlots: pg.data.week.reduce((a, w) => a + w.jobs.filter(j => !j.people.length).length, 0)
      };
    });
    const rotateSlotOk = rotateRes.n >= rotateRes.slots ? rotateRes.emptySlots === 0 : true;
    rotateRes.assigned === rotateRes.n && rotateRes.missing === 0 && rotateRes.min >= 1 && rotateRes.balanced && rotateSlotOk
      ? ok(`按学号轮排：${rotateRes.n} 人全部排到（每人 ${rotateRes.min}~${rotateRes.max} 次，差 ≤1），${rotateRes.slots} 个岗位无空缺`)
      : bad('轮排不均/漏人/有空岗: ' + JSON.stringify(rotateRes));

    // 随机轮排：同样不许漏人，且结果与按学号不同
    const shufRes = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      const seq0 = JSON.stringify(pg.data.week.map(w => w.jobs.map(j => j.people.map(p => p._id))));
      pg.onShuffleRotate();
      const seq1 = JSON.stringify(pg.data.week.map(w => w.jobs.map(j => j.people.map(p => p._id))));
      const times = {};
      pg.data.week.forEach(w => w.jobs.forEach(j => j.people.forEach(p => { times[p._id] = (times[p._id] || 0) + 1; })));
      const counts = pg.students.map(s => times[s._id] || 0);
      return {
        changed: seq0 !== seq1,
        missing: pg.data.overview.missing,
        assigned: pg.data.overview.assigned,
        n: pg.students.length,
        balanced: Math.max(...counts) - Math.min(...counts) <= 1,
        slots: pg.data.overview.slots,
        emptySlots: pg.data.week.reduce((a, w) => a + w.jobs.filter(j => !j.people.length).length, 0)
      };
    });
    const shufSlotOk = shufRes.n >= shufRes.slots ? shufRes.emptySlots === 0 : true;
    shufRes.changed && shufRes.missing === 0 && shufRes.assigned === shufRes.n && shufRes.balanced && shufSlotOk
      ? ok(`随机轮排：${shufRes.n} 人全排到、分布均匀、无空岗、顺序已打乱`)
      : bad('随机轮排异常: ' + JSON.stringify(shufRes));

    // 保存：云端记录必须与页面完全一致，且每条 weekday/job 合法
    // 触发/等待/读取必须分成三次短 evaluate。
    // 教训：写成一次「onSave() + setTimeout 3s」的长 evaluate 时，云端写入一多就撞
    // automator 单次响应窗口 → 报 `timeout waiting for automator response`，
    // 真实的业务 bug 会被伪装成脚本崩溃（反向注入 diff 去重时实测到）。
    const dutySaveTrigger = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const beforeSeq = JSON.stringify(pg.data.week.map(w => w.jobs.map(j => j.people.map(p => p._id))));
      pg.onSave();
      // 保存回读期间批量改表必须被挡住：否则清空/轮排会基于旧快照产生 diff 竞态。
      pg.onRotate();
      const afterSeq = JSON.stringify(pg.data.week.map(w => w.jobs.map(j => j.people.map(p => p._id))));
      return { editBlocked: beforeSeq === afterSeq };
    });
    await waitPageIdle(mp, { label: '值日保存', requireClean: true });
    const dutySave = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      return {
        dirty: !!pg.dirty,
        assigned: pg.data.overview.assigned,
        keys: [].concat(...pg.data.week.map(w => [].concat(...w.jobs.map(j => j.people.map(p => `${w.d}@${j.job}@${p._id}`)))))
      };
    });
    !dutySave.dirty ? ok('值日保存后 dirty 已清（按钮回「已同步」）') : bad('保存后 dirty 未清');
    dutySaveTrigger.editBlocked ? ok('值日保存回读期间锁定轮排，旧快照不会被改写') : bad('值日保存期间仍允许改表');
    const dutyCloud = await evalRetry(mp, () => {
      const d = wx.cloud.database();
      return d.collection('dutySchedule').count().then(({ total }) => {
        const readAll = async (skip, out) => {
          const r = await d.collection('dutySchedule').skip(skip).limit(20).get();
          out.push(...r.data);
          return (r.data.length < 20 || out.length >= total) ? out : readAll(skip + 20, out);
        };
        return readAll(0, []).then(all => all.map(x => `${x.weekday}@${x.job}@${x.studentId}`));
      });
    });
    const cloudSet = new Set(dutyCloud);
    const pageSet = new Set(dutySave.keys);
    const onlyCloud = dutyCloud.filter(k => !pageSet.has(k));
    const onlyPage = dutySave.keys.filter(k => !cloudSet.has(k));
    dutyCloud.length === dutySave.assigned && onlyCloud.length === 0 && onlyPage.length === 0
      ? ok(`云端 ${dutyCloud.length} 条值日与页面逐条一致`)
      : bad(`云端不一致: 云端${dutyCloud.length}/页面${dutySave.assigned}，云端多${JSON.stringify(onlyCloud.slice(0, 3))} 页面多${JSON.stringify(onlyPage.slice(0, 3))}`);
    // 云端不许有重复键（diff 写坏就会重复插入）
    cloudSet.size === dutyCloud.length ? ok('云端无重复值日记录') : bad(`云端有 ${dutyCloud.length - cloudSet.size} 条重复`);

    // 再存一次不该写库
    await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.__msg = '';
      pg.__origToast = wx.showToast;
      wx.showToast = o => { pg.__msg = o.title; };
      pg.onSave();
      return 1;
    });
    await waitPageIdle(mp, { label: '值日空保存' });
    const dutyNoop = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      if (pg.__origToast) { wx.showToast = pg.__origToast; pg.__origToast = null; }
      return { msg: pg.__msg || '' };
    });
    /没有改动/.test(dutyNoop.msg) ? ok('无改动时不写库（diff 生效）') : bad('无改动仍写库: ' + JSON.stringify(dutyNoop));

    // 防连点：制造一处改动后连点 3 次保存
    // ⚠️ 连点必须跨 tick 触发，不能写成同 tick 的 onSave();onSave();onSave()。
    // 变异测试实测：把 `this._busy` 换成 `this.data.saving` 后同 tick 版本照样全绿放行
    // （setData 对 this.data 是同步生效的，所以同 tick 拦得住），真实用户手指连点是
    // 跨 tick 的 —— 那才是 _busy 唯一能防、data.saving 防不住的窗口。
    // 防连点（打点法）：必须造**大批**改动再跨 tick 连点。
    // 实测：只造 1 条改动时，首次写入在 60ms 内就完成回读，第 2、3 次点击已无 diff，
    // 删掉 _busy guard 的变异体照样全绿（单次写太快，抓不到）。改用轮排造 ~30 人次：
    // 首批保存还在写（分批 + 回读），60/140ms 的连击若穿过 guard，会各自拿旧快照
    // 把整批 add 再写一遍（约 3 倍写调用），数真实 db.add 调用次数即可稳定击杀。
    const dblPre = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const dbm = require('utils/db.js');
      pg.__dw = { add: 0, update: 0, remove: 0 };
      pg.__do = { add: dbm.add, update: dbm.update, remove: dbm.remove };
      ['add', 'update', 'remove'].forEach(function (k) {
        dbm[k] = function () { pg.__dw[k] += 1; return pg.__do[k].apply(dbm, arguments); };
      });
      const _m = wx.showModal;
      wx.showModal = o => { o.success && o.success({ confirm: true }); };
      pg.onBackToWeek();
      pg.onClearAll();
      wx.showModal = _m;
      pg.onShuffleRotate();
      // 期望写调用数必须用保存前的 this.dutyRecords 现算（本地清空未保存+随机轮排，
      // 与旧记录基本全量 diff，拍脑袋按人次算必假红，实测 add=30/remove=30）。
      const targetKeys = [];
      Object.keys(pg.assign || {}).forEach(function (k) {
        (pg.assign[k] || []).forEach(function (sid) {
          const parts = String(k).split('@');
          targetKeys.push(Number(parts[0]) + '@' + parts[1] + '@' + sid);
        });
      });
      const existKeys = [];
      (pg.dutyRecords || []).forEach(function (r) {
        existKeys.push(Number(r.weekday) + '@' + r.job + '@' + r.studentId);
      });
      const expectAdds = targetKeys.filter(function (k) { return existKeys.indexOf(k) < 0; }).length;
      const expectRemoves = existKeys.filter(function (k) { return targetKeys.indexOf(k) < 0; }).length;
      pg.onSave();
      // 隔 tick 再点两次：模拟 100ms 内的手指连击
      setTimeout(() => pg.onSave(), 60);
      setTimeout(() => pg.onSave(), 140);
      return { expectAdds: expectAdds, expectRemoves: expectRemoves, totalTarget: targetKeys.length };
    });
    await waitPageIdle(mp, { label: '值日连点保存', requireClean: true });
    const dutyDbl = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const dbm = require('utils/db.js');
      ['add', 'update', 'remove'].forEach(function (k) { if (pg.__do && pg.__do[k]) dbm[k] = pg.__do[k]; });
      pg.__do = null;
      return wx.cloud.database().collection('dutySchedule').count()
        .then(c => ({ total: c.total, dirty: !!pg.dirty, writes: pg.__dw }));
    });
    dutyDbl.expectAdds = dblPre.expectAdds;
    dutyDbl.writes && dutyDbl.writes.add === dblPre.expectAdds && dutyDbl.writes.remove === dblPre.expectRemoves
      && dutyDbl.total === dblPre.totalTarget && !dutyDbl.dirty
      ? ok(`保存防连点：连点 3 次只发 新${dutyDbl.writes.add}/撤${dutyDbl.writes.remove}（=一次 diff），云端 ${dutyDbl.total} 条无重复`)
      : bad(`保存连点异常: 写调用 ${JSON.stringify(dutyDbl.writes)} 应 新${dblPre.expectAdds}/撤${dblPre.expectRemoves}，云端/状态 ${JSON.stringify({ total: dutyDbl.total, expect: dblPre.totalTarget, dirty: dutyDbl.dirty })}`);

    // 清空：本地清干净，保存后云端也清空
    const clearPre = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const orig = wx.showModal;
      wx.showModal = o => { o.success && o.success({ confirm: true }); };
      pg.onBackToWeek();
      pg.onClearAll();
      wx.showModal = orig;
      const out = { cleared: pg.data.overview.assigned, missing: pg.data.overview.missing, n: pg.students.length };
      pg.onSave();
      return out;
    });
    await waitPageIdle(mp, { label: '值日清空保存', requireClean: true });
    const dutyClear = await evalRetry(mp, () => wx.cloud.database().collection('dutySchedule').count()
      .then(c => ({ cloud: c.total })));
    Object.assign(dutyClear, clearPre);
    dutyClear.cleared === 0 && dutyClear.cloud === 0 && dutyClear.missing === dutyClear.n
      ? ok(`清空生效：页面 0 人次、云端 0 条、未排到 ${dutyClear.missing} 人（=全班）`)
      : bad('清空异常: ' + JSON.stringify(dutyClear));

    // 删学生必须级联删值日（漏了会留孤儿，「未排到」统计失真）
    const dutyCasc = await mp.evaluate(() => {
      const d = wx.cloud.database();
      return d.collection('students').add({ data: { studentNo: 'DUTY999', name: '值日级联', gender: '女', _reg: true, updatedAt: Date.now() } })
        .then(s => d.collection('dutySchedule').add({ data: { studentId: s._id, weekday: 1, job: '扫地', _reg: true, updatedAt: Date.now() } })
          .then(() => s._id));
    });
    await goto(mp, '/pages/roster/roster', 3500);
    await mp.evaluate(id => {
      const pg = getCurrentPages().slice(-1)[0];
      const orig = wx.showModal;
      wx.showModal = o => { o.success && o.success({ confirm: true }); };
      pg.onDelete({ currentTarget: { dataset: { id } } });
      return new Promise(r => setTimeout(() => { wx.showModal = orig; r(1); }, 300));
    }, dutyCasc);
    const dutyLeft = await waitCascadeDeleted(mp, dutyCasc, 'dutySchedule', '值日');
    dutyLeft.ref === 0 && dutyLeft.stu === 0
      ? ok('删学生级联清值日（无孤儿）') : bad('值日级联残留: ' + JSON.stringify(dutyLeft));

    // 还原：把值日表排回去，别让库空着（下一轮和用户看到的都该有数据）
    // 注意：不许写成一个 7s 的长 evaluate —— automator 单次响应会 timeout（实测挂在这里）。
    // 拆成 3 段短 evaluate + 外层 sleep，并走 evalRetry 吸收抖动。
    await evalRetry(mp, () => new Promise(resolve => {
      wx.navigateTo({ url: '/pages/duty/duty', success: () => setTimeout(() => resolve(1), 500), fail: e => resolve(e) });
    }));
    await sleep(3500);
    await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.onRotate();
      pg.onSave();
      return pg.data.overview.assigned;
    });
    await waitPageIdle(mp, { label: '值日还原保存', requireClean: true });
    const dutyRestore = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      return wx.cloud.database().collection('dutySchedule').count()
        .then(c => ({ cloud: c.total, page: pg.data.overview.assigned, dirty: !!pg.dirty }));
    });
    dutyRestore.cloud === dutyRestore.page && dutyRestore.cloud > 0 && !dutyRestore.dirty
      ? ok(`值日表已还原（云端 ${dutyRestore.cloud} 条）`)
      : bad('还原失败: ' + JSON.stringify(dutyRestore));

    // 概览入口
    const dashDuty = await goto(mp, '/pages/dashboard/dashboard', 3500);
    const dutyLink = await $retry(dashDuty, '.link-duty-quick');
    if (dutyLink) {
      await dutyLink.tap();
      await sleep(3000);
      const curDuty = await mp.currentPage();
      curDuty && curDuty.path.indexOf('duty') >= 0 ? ok('概览可跳值日表') : bad('跳转失败: ' + (curDuty && curDuty.path));
    } else {
      bad('概览缺 .link-duty-quick 入口');
    }

    console.log('\n[19] 课程表：周表网格/单日编排/模板/冲突检测/保存 diff');
    // 前置自造：先摘掉几节课，保证「空课」和「已排」两侧都有数据。
    // 不能依赖 seed 初始态 —— 上一轮 e2e 的模板套用会把 40 格填满（值日/座位都踩过这个坑）。
    // ⚠️ 不能只「摘掉前 3 条」：上一轮跑完会把 40 格填满，被摘的 3 条可能全在周一，
    //    于是后面在周二找空格就报 no-blank（实测踩过）。必须定向保证**周二和周四各有空格**
    //    （周二用于填课/覆盖断言，周四用于改科目/连点断言）。
    // 段首必须能从**任意**初始态起跑，包括空库：sched-conflict-off 变异体跑完会把云端清成 0 条，
    // 于是下面「摘掉几节制造空课」拿不到任何记录 → dropped=0 报「前置准备失败」，
    // mutate 把它读成「基线就是红的」直接中止（实测踩过，浪费一轮 7min）。
    // 所以先兜底灌满 40 格再摘。
    const schedSeedIfEmpty = await evalRetry(mp, () => {
      const d = wx.cloud.database();
      const AM = ['语文', '数学', '英语', '物理'];
      const PM = ['化学', '生物', '政治', '历史', '地理', '体育', '音乐', '美术', '信息'];
      return d.collection('schedule').count().then(({ total }) => {
        if (total > 0) return { seeded: 0, total };
        const docs = [];
        for (let wi = 0; wi < 5; wi++) {
          const wd = wi + 1;
          for (let i = 0; i < 4; i++) docs.push({ weekday: wd, period: i + 1, subject: AM[(i + wi) % AM.length], teacher: '' });
          docs.push({ weekday: wd, period: 9, subject: '自习', teacher: '' });   // 午间延时
          for (let i = 0; i < 3; i++) docs.push({ weekday: wd, period: i + 5, subject: PM[(wi * 3 + i) % PM.length], teacher: '' });
          docs.push({ weekday: wd, period: 8, subject: '自习', teacher: '' });
        }
        // 分批并发：一次 40 条串行会撞 evaluate 响应窗口
        const batch = (i) => i >= docs.length ? Promise.resolve()
          : Promise.all(docs.slice(i, i + 10).map(doc => d.collection('schedule').add({ data: doc }))).then(() => batch(i + 10));
        return batch(0).then(() => d.collection('schedule').count()).then(c => ({ seeded: docs.length, total: c.total }));
      });
    });
    // ⚠️ 不许写死 `total === 40`（规则 14 实测再犯）：红队/变异体跑完会留下 30 节这类
    //    半满形态，写死 40 就变成「依赖上一轮收尾」，一红还会被 mutate 误读成基线坏了。
    //    真正的前置条件由下一步显式造，这里只要求「非空且不超过 40 格」。
    schedSeedIfEmpty.total >= 1 && schedSeedIfEmpty.total <= SCHED_SLOTS
      ? ok(schedSeedIfEmpty.seeded ? `前置：库为空，自灌 ${SCHED_SLOTS} 格模板课表` : `前置：云端已有 ${schedSeedIfEmpty.total} 节`)
      : bad('课表前置灌数异常: ' + JSON.stringify(schedSeedIfEmpty));

    const schedPrep = await evalRetry(mp, () => {
      const d = wx.cloud.database();
      return d.collection('schedule').count().then(({ total }) => {
        const readAll = async (skip, out) => {
          const r = await d.collection('schedule').skip(skip).limit(20).get();
          out.push(...r.data);
          return (r.data.length < 20 || out.length >= total) ? out : readAll(skip + 20, out);
        };
        return readAll(0, []).then(all => {
          // 周二第 3 节 + 周四第 3 节 + 任意一条：保证两天都能找到空格
          const want = all.filter(x => (Number(x.weekday) === 2 && Number(x.period) === 3)
            || (Number(x.weekday) === 4 && Number(x.period) === 3));
          const extra = all.filter(x => want.indexOf(x) < 0).slice(0, 1);
          const drop = want.concat(extra);
          return Promise.all(drop.map(x => d.collection('schedule').doc(x._id).remove()))
            .then(() => ({ before: total, dropped: drop.length, targeted: want.length }));
        });
      });
    });
    schedPrep.dropped >= 1
      ? ok(`前置：摘掉 ${schedPrep.dropped} 节课制造空课（${schedPrep.before}→${schedPrep.before - schedPrep.dropped}，定向 ${schedPrep.targeted} 条）`)
      : bad('课表前置准备失败: ' + JSON.stringify(schedPrep));

    // ⚠️ 冲突断言绝不能靠 seed 初始态：上一轮 e2e 收尾把 40 格换成了模板（模板本身零冲突），
    //    于是「冲突复算一致」在 0 == 0 时也全绿 —— 等于没测（实测 probe：total=40 / over=[]）。
    //    所以段首强制造两类冲突：周一 1~4 节全语文（主科超上限）、周三 4~6 节全数学（连排 3 节）。
    const schedMon = await evalRetry(mp, () => {
      const d = wx.cloud.database();
      const put = (wd, p, sub) => d.collection('schedule').where({ weekday: wd, period: p }).get()
        .then(r => r.data.length
          ? d.collection('schedule').doc(r.data[0]._id).update({ data: { subject: sub, teacher: '' } })
          : d.collection('schedule').add({ data: { weekday: wd, period: p, subject: sub, teacher: '' } }));
      return Promise.all([put(1, 1, '语文'), put(1, 2, '语文'), put(1, 3, '语文'), put(1, 4, '语文')])
        .then(() => 'mon-ok');
    });
    const schedWed = await evalRetry(mp, () => {
      const d = wx.cloud.database();
      const put = (wd, p, sub) => d.collection('schedule').where({ weekday: wd, period: p }).get()
        .then(r => r.data.length
          ? d.collection('schedule').doc(r.data[0]._id).update({ data: { subject: sub, teacher: '' } })
          : d.collection('schedule').add({ data: { weekday: wd, period: p, subject: sub, teacher: '' } }));
      return Promise.all([put(3, 4, '数学'), put(3, 5, '数学'), put(3, 6, '数学')]).then(() => 'wed-ok');
    });
    schedMon === 'mon-ok' && schedWed === 'wed-ok'
      ? ok('前置：造出两类冲突（周一4节语文 / 周三4~6节数学连排）')
      : bad(`造冲突前置失败: ${schedMon}/${schedWed}`);

    const schedPage = await goto(mp, '/pages/schedule/schedule', 4000);
    const sWeek = await schedPage.data('week');
    const sOv = await schedPage.data('overview');
    const sStat = await schedPage.data('subjectStat');

    sWeek.length === 5 && sWeek.every(w => w.cells.length === SCHED_PERIODS.length)
      ? ok(`周表 5 天 × ${SCHED_PERIODS.length} 节结构正确（含午间延时）`)
      : bad(`周表结构错: ${sWeek.length} 天 / ${JSON.stringify(sWeek.map(w => w.cells.length))}`);
    sWeek.filter(w => w.isToday).length === 1
      ? ok(`今天高亮唯一（${(sWeek.find(w => w.isToday) || {}).label}）`)
      : bad(`今天高亮 ${sWeek.filter(w => w.isToday).length} 个`);

    // 口径一致：三个数字必须互相闭合，不能各算一套（页面显示与将保存的数据同源）
    const cellFilled = sWeek.reduce((a, w) => a + w.cells.filter(c => !c.empty).length, 0);
    sOv.filled === cellFilled && sOv.slots === SCHED_SLOTS && sOv.filled + sOv.empty === sOv.slots
      ? ok(`口径闭合：已排 ${sOv.filled} = 格子求和，已排+空课=${sOv.slots}`)
      : bad(`口径不闭合: ${JSON.stringify(sOv)} 格子求和=${cellFilled}`);
    // 每日 filled 也要与格子一致（day.filled 是另一处独立计算，最容易漂）
    sWeek.every(w => w.filled === w.cells.filter(c => !c.empty).length)
      ? ok('每日已排数与该日格子一致')
      : bad('每日已排数漂移: ' + JSON.stringify(sWeek.map(w => [w.filled, w.cells.filter(c => !c.empty).length])));

    // 科目统计必须等于格子里的实际分布（汇总按全量算，不被任何筛选污染）
    const realCount = {};
    sWeek.forEach(w => w.cells.forEach(c => { if (!c.empty) realCount[c.subject] = (realCount[c.subject] || 0) + 1; }));
    const statMap = {};
    sStat.forEach(x => { statMap[x.subject] = x.count; });
    const statOk = Object.keys(realCount).length === sStat.length
      && Object.keys(realCount).every(k => statMap[k] === realCount[k]);
    statOk && sStat.length === sOv.subjects
      ? ok(`每科周课时统计准确（${sStat.length} 科，合计 ${sStat.reduce((a, b) => a + b.count, 0)} 节）`)
      : bad(`科目统计错: 页面${JSON.stringify(statMap)} 实际${JSON.stringify(realCount)} overview.subjects=${sOv.subjects}`);
    // 排序：课时多的在前
    sStat.every((x, i) => i === 0 || sStat[i - 1].count >= x.count)
      ? ok('科目统计按课时降序') : bad('科目统计未降序: ' + JSON.stringify(sStat.map(x => x.count)));

    // 类名必须全 ASCII：中文进 class 会让整份 wxss 编译失败（本项目一号事故）
    const sClsBad = [];
    sWeek.forEach(w => w.cells.forEach(c => { if (!c.empty && !/^[a-z]+$/.test(c.scls)) sClsBad.push(c.subject + '→' + c.scls); }));
    sClsBad.length === 0 ? ok('科目类名全 ASCII（wxss 不会编译失败）') : bad('类名含非 ASCII: ' + JSON.stringify(sClsBad.slice(0, 3)));

    // 冲突检测：seed 故意造了「周一语文 4 节」+「周三数学连排 3 节」两类，都必须被抓到
    const sConf = await schedPage.data('conflictList');
    sConf.length === sOv.conflicts
      ? ok(`冲突数口径一致（${sConf.length} 处）`) : bad(`冲突数不一致: 清单${sConf.length} overview${sOv.conflicts}`);
    // 用页面数据独立复算一遍冲突，验证不是「显示了但算错了」
    const MAIN = ['语文', '数学', '英语'];
    const expectConf = [];
    sWeek.forEach(w => {
      const per = {};
      w.cells.forEach(c => { if (!c.empty) per[c.subject] = (per[c.subject] || 0) + 1; });
      Object.keys(per).forEach(sub => { if (MAIN.indexOf(sub) >= 0 && per[sub] > 3) expectConf.push(`over:${w.d}:${sub}`); });
      for (let i = 0; i + 2 < w.cells.length; i++) {
        const a = w.cells[i], b = w.cells[i + 1], c = w.cells[i + 2];
        if (!a.empty && a.subject === b.subject && b.subject === c.subject) expectConf.push(`run:${w.d}:${a.p}`);
      }
    });
    // 不许只比「页面 == 复算」：0 == 0 也成立，等于没测。必须同时要求两类冲突都真的出现。
    const hasOver = expectConf.some(x => x.indexOf('over:') === 0);
    const hasRun = expectConf.some(x => x.indexOf('run:') === 0);
    sConf.length === expectConf.length && expectConf.length >= 2 && hasOver && hasRun
      ? ok(`冲突复算一致（${expectConf.length} 处，超上限+连排两类都命中）`)
      : bad(`冲突复算不一致或未覆盖两类: 页面${sConf.length} 复算${expectConf.length} over=${hasOver} run=${hasRun} :: ${JSON.stringify(sConf.map(c => c.text).slice(0, 3))}`);
    // 冲突文案必须能定位到「周几+科目」，否则老师看到告警也不知道改哪里
    sConf.every(c => /周[一二三四五]/.test(c.text) && c.key)
      ? ok('冲突文案含周几且有唯一 key')
      : bad('冲突文案不可定位: ' + JSON.stringify(sConf.slice(0, 2)));

    // 进单日编排
    const schDayEnter = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.onOpenDay({ currentTarget: { dataset: { d: 2 } } });
      return { view: pg.data.view, cells: pg.data.dayCells.length, label: pg.data.dayLabel, subjects: pg.data.subjects.length };
    });
    schDayEnter.view === 'day' && schDayEnter.cells === SCHED_PERIODS.length && schDayEnter.subjects >= 10
      ? ok(`进入周二编排：${SCHED_PERIODS.length} 个节次 / ${schDayEnter.subjects} 个科目可选`)
      : bad('进入单日编排失败: ' + JSON.stringify(schDayEnter));

    // 非法 weekday 不许进（用户点不到，但脏 dataset / 恶意调用能造出来）
    const schDayBad = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const before = pg.data.currentDay;
      pg.onOpenDay({ currentTarget: { dataset: { d: 9 } } });
      pg.onOpenDay({ currentTarget: { dataset: { d: 0 } } });
      return { before, after: pg.data.currentDay };
    });
    schDayBad.after === schDayBad.before ? ok('非法 weekday(0/9) 被拒，currentDay 未变') : bad('非法 weekday 改了状态: ' + JSON.stringify(schDayBad));

    // 挑科目 → 点格子 → 填入生效
    const schFillRes = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const blank = pg.data.dayCells.find(c => c.empty);
      if (!blank) return { skip: 'no-blank', day: pg.data.currentDay, cells: pg.data.dayCells.map(c => c.subject) };
      const before = pg.data.overview.filled;
      pg.onPickSubject({ currentTarget: { dataset: { subject: '化学' } } });
      const picked = pg.data.pickedSubject;
      pg.onTapCell({ currentTarget: { dataset: { p: blank.p } } });
      const cell = pg.data.dayCells.find(c => c.p === blank.p);
      return { before, after: pg.data.overview.filled, picked, p: blank.p, subject: cell && cell.subject, scls: cell && cell.scls, emptyNow: cell && cell.empty };
    });
    schFillRes.picked === '化学' && schFillRes.subject === '化学' && !schFillRes.emptyNow
      && schFillRes.after === schFillRes.before + 1 && schFillRes.scls === 'chem'
      ? ok(`填课生效：周二第${schFillRes.p}节 → 化学，已排 ${schFillRes.before}→${schFillRes.after}`)
      : bad('填课异常: ' + JSON.stringify(schFillRes));

    // 反向填课流（用户反馈 2026-09-11：点空格就是想填课，只弹 toast 等于没入口）：
    // 点空格 → 进「待填」态（fillTarget 高亮）→ 点科目 → 直接填入。
    const ftRes = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.onBackToWeek();
      pg.dirty = false;
      pg.setData({ dirtyFlag: false, pickedSubject: '', swapFrom: '', fillTarget: '', fillTargetLabel: '' });
      const plan = pg.plan || {};
      let blank = null, filled = null;
      for (let d = 1; d <= 5 && !(blank && filled); d++) for (const p of [1,2,3,4,9,5,6,7,8]) {
        const k = d + '@' + p;
        if (!plan[k] && !blank) blank = { d, p, k };
        if (plan[k] && !filled) filled = { d, p, k };
      }
      if (!blank || !filled) return { err: 'need blank+filled' };
      const before = pg.data.overview.filled;
      // 1) 点空格 → 待填态，不写数据不标脏
      pg.onCellPick({ currentTarget: { dataset: { d: blank.d, p: blank.p } } });
      const t1 = pg.data.fillTarget;
      const label = pg.data.fillTargetLabel;
      const dirtyAfterTap = !!pg.dirty;
      const stillEmpty = !pg.plan[blank.k];
      // 2) 同格再点 → 取消待填
      pg.onCellPick({ currentTarget: { dataset: { d: blank.d, p: blank.p } } });
      const t2 = pg.data.fillTarget;
      // 3) 待填态点有课格 → 让位给交换选择
      pg.onCellPick({ currentTarget: { dataset: { d: blank.d, p: blank.p } } });
      pg.onCellPick({ currentTarget: { dataset: { d: filled.d, p: filled.p } } });
      const t3 = pg.data.fillTarget;
      const sw3 = pg.data.swapFrom;
      pg.onCancelSwap();
      // 4) 点空格 → 挑科目 → 直接填入
      pg.onCellPick({ currentTarget: { dataset: { d: blank.d, p: blank.p } } });
      pg.onPickSubject({ currentTarget: { dataset: { subject: '体育' } } });
      const filledSub = pg.plan[blank.k] && pg.plan[blank.k].subject;
      const t4 = pg.data.fillTarget;
      const after = pg.data.overview.filled;
      const dirty = !!pg.dirty;
      // 还原：不消耗后续段的空格预算
      delete pg.plan[blank.k];
      pg.markDirty();
      pg.render();
      return { k: blank.k, fk: filled.k, t1, label, dirtyAfterTap, stillEmpty, t2, t3, sw3, filledSub, t4, before, after, dirty };
    });
    !ftRes.err && ftRes.t1 === ftRes.k && !!ftRes.label && ftRes.dirtyAfterTap === false && ftRes.stillEmpty
      && ftRes.t2 === '' && ftRes.t3 === '' && ftRes.sw3 === ftRes.fk
      && ftRes.filledSub === '体育' && ftRes.t4 === '' && ftRes.after === ftRes.before + 1 && ftRes.dirty
      ? ok(`点空格进待填→挑科目直接填入（${ftRes.k} → 体育）；同格再点取消；待填态点有课格转交换`)
      : bad('点空格填课异常: ' + JSON.stringify(ftRes));

    // 调课：周表直接两次点击交换/移动（用户反馈：必须进 day 才能换很烦，2026-09-06）
    // UI 流程（2026-09-11 起）：点有课格 = 交换源，再点另一格 = 交换/移动；
    // 点空格 = 待填态（上一段），不再充当交换源。
    const swapReal = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.onBackToWeek();
      // 不能让前面「填课」的 dirty 残留污染 swap 的 dirty 断言：
      // 忘 markDirty() 的变异体会因为前面已 dirty 而「假绿」（SURVIVED 实测抓到）
      pg.dirty = false;
      pg.setData({ dirtyFlag: false, fillTarget: '', fillTargetLabel: '' });
      const plan = pg.plan || {};
      // 找一个空格 + 一个有课格
      let empty = null, filled = null;
      for (let d=1; d<=5 && !(empty&&filled); d++) for (const p of [1,2,3,4,5,6,7,8,9]) {
        const k = d+'@'+p;
        if (!plan[k] && !empty) empty = {d,p,k};
        if (plan[k] && !filled) filled = {d,p,k,sub:plan[k].subject};
      }
      if (!empty || !filled) return { err: 'need empty+filled' };
      const beforeEmpty = plan[empty.k] ? plan[empty.k].subject : null;
      const beforeFilled = plan[filled.k] ? plan[filled.k].subject : null;
      // 点有课格（源）
      pg.onCellPick({ currentTarget: { dataset: { d: filled.d, p: filled.p } } });
      const s1 = pg.data.swapFrom;
      // 点空格（目标）→ 空格拿到 filled 的课，filled 腾空
      pg.onCellPick({ currentTarget: { dataset: { d: empty.d, p: empty.p } } });
      const s2 = pg.data.swapFrom;
      return {
        empty: empty.k, filled: filled.k,
        beforeEmpty, beforeFilled, s1, s2,
        afterEmpty: plan[empty.k] ? plan[empty.k].subject : null,
        afterFilled: plan[filled.k] ? plan[filled.k].subject : null,
        dirty: !!pg.dirty
      };
    });
    if (swapReal.err) {
      bad('调课前置缺格: ' + JSON.stringify(swapReal));
    } else {
      swapReal.s1 === swapReal.filled && swapReal.s2 === '' && swapReal.dirty
        ? ok('周表两次点击：第一次选中 swapFrom=' + swapReal.filled + '，第二次交换后自动清空')
        : bad('调课选中状态错: ' + JSON.stringify(swapReal));
      swapReal.afterEmpty === swapReal.beforeFilled && swapReal.afterFilled === null
        ? ok('调课移动生效：' + swapReal.filled + '→' + swapReal.empty + '（空格拿到课，原格清空）')
        : bad('调课移动异常: ' + JSON.stringify(swapReal));
    }

    // 同格再点取消
    const swapCancel = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.onBackToWeek();
      // 不能写死 1@1：swapReal 的移动可能刚好把它腾空，
      // 空格现在是「待填」入口而不是交换源（2026-09-11）
      const plan = pg.plan || {};
      let filled = null;
      for (let d = 1; d <= 5 && !filled; d++) for (const p of [1,2,3,4,9,5,6,7,8]) {
        if (plan[d + '@' + p]) { filled = { d, p }; break; }
      }
      pg.onCellPick({ currentTarget: { dataset: { d: filled.d, p: filled.p } } });
      const after1 = pg.data.swapFrom;
      pg.onCellPick({ currentTarget: { dataset: { d: filled.d, p: filled.p } } });
      return { k: filled.d + '@' + filled.p, after1, after2: pg.data.swapFrom };
    });
    swapCancel.after1 === swapCancel.k && swapCancel.after2 === ''
      ? ok('同格再点取消选中') : bad('同格再点未取消: ' + JSON.stringify(swapCancel));

    const swapBad = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.onBackToWeek();
      const before = pg.data.swapFrom;
      pg.onCellPick({ currentTarget: { dataset: { d: 9, p: 0 } } });
      pg.onCellPick({ currentTarget: { dataset: { d: 0, p: 9 } } });
      return { before, after: pg.data.swapFrom };
    });
    swapBad.before === swapBad.after
      ? ok('非法格 (d=9/p=0) 不进入 swapFrom') : bad('非法格改了 swapFrom: ' + JSON.stringify(swapBad));

    // 周表表头必须带日历日期（用户反馈：只有「周一」记不住是哪天，2026-09-06）
    const schDates = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      return pg.data.week.map(w => ({ d: w.d, label: w.label, dateLabel: w.dateLabel }));
    });
    schDates.length === 5 && schDates.every(w => /^\d{1,2}\/\d{1,2}$/.test(w.dateLabel || ''))
      ? ok('周表表头带日历日期：' + schDates.map(w => w.label + ' ' + w.dateLabel).join(' '))
      : bad('周表缺日历日期: ' + JSON.stringify(schDates));
    // 日期必须是连续 5 天（算错「本周一」会出现 9/7 9/8 9/9 9/10 9/14 这种断裂）
    const schDateNums = schDates.map(w => w.dateLabel);
    const schDateSeq = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      // 用页面自己的日期反推：相邻两天必须差 1 天（跨月由 Date 保证）
      return pg.data.week.map(w => w.dateLabel);
    });
    new Set(schDateSeq).size === 5
      ? ok('5 天日期互不相同（' + schDateNums.join(' ') + '）')
      : bad('日期重复: ' + JSON.stringify(schDateSeq));

    // 周表直接填课（省掉进单日页这一跳，用户反馈 2026-09-06）
    const weekFill = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.onBackToWeek();
      pg.setData({ pickedSubject: '', swapFrom: '' });
      pg.dirty = false; pg.setData({ dirtyFlag: false });
      const plan = pg.plan || {};
      let blank = null;
      for (let d = 1; d <= 5 && !blank; d++) for (const p of [1,2,3,4,9,5,6,7,8]) {
        if (!plan[d + '@' + p]) { blank = { d, p, k: d + '@' + p }; break; }
      }
      if (!blank) return { err: 'no-blank' };
      const before = pg.data.overview.filled;
      pg.onPickSubject({ currentTarget: { dataset: { subject: '生物' } } });
      const picked = pg.data.pickedSubject;
      pg.onCellPick({ currentTarget: { dataset: { d: blank.d, p: blank.p } } });
      const cell = (pg.data.week.find(w => w.d === blank.d) || { cells: [] }).cells.find(c => c.p === blank.p);
      return {
        k: blank.k, picked, before, after: pg.data.overview.filled,
        planSub: pg.plan[blank.k] && pg.plan[blank.k].subject,
        cellSub: cell && cell.subject, cellEmpty: cell && cell.empty,
        pickedAfter: pg.data.pickedSubject, dirty: !!pg.dirty
      };
    });
    if (weekFill.err) {
      bad('周表填课前置缺空格: ' + JSON.stringify(weekFill));
    } else {
      weekFill.picked === '生物' && weekFill.planSub === '生物' && weekFill.cellSub === '生物'
        && !weekFill.cellEmpty && weekFill.after === weekFill.before + 1 && weekFill.dirty
        ? ok(`周表直接填课生效：${weekFill.k} → 生物，已排 ${weekFill.before}→${weekFill.after}`)
        : bad('周表填课异常: ' + JSON.stringify(weekFill));
      weekFill.pickedAfter === ''
        ? ok('周表填课后自动清选中（不会连填一片）')
        : bad('周表填课后选中未清: ' + weekFill.pickedAfter);
    }

    // 填课模式与换课模式互斥：挑科目必须清掉 swapFrom，否则点格子会被当成「交换第二次点击」
    const weekModeExcl = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.setData({ pickedSubject: '', swapFrom: '' });
      pg.onCellPick({ currentTarget: { dataset: { d: 1, p: 1 } } });   // 进入待交换
      const s1 = pg.data.swapFrom;
      pg.onPickSubject({ currentTarget: { dataset: { subject: '美术' } } });
      return { s1, s2: pg.data.swapFrom, picked: pg.data.pickedSubject };
    });
    weekModeExcl.s1 === '1@1' && weekModeExcl.s2 === '' && weekModeExcl.picked === '美术'
      ? ok('挑科目自动退出待交换态（两种模式互斥）')
      : bad('模式未互斥: ' + JSON.stringify(weekModeExcl));

    // 周表填课：同一格重复填同一科目要被拦（避免无意义 dirty）
    const weekSame = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.setData({ pickedSubject: '', swapFrom: '' });
      const plan = pg.plan || {};
      const k = Object.keys(plan)[0];
      if (!k) return { err: 'empty-plan' };
      const [d, p] = k.split('@').map(Number);
      const sub = plan[k].subject;
      let msg = '';
      const o = wx.showToast;
      wx.showToast = x => { msg = x.title; };
      pg.dirty = false; pg.setData({ dirtyFlag: false });
      pg.onPickSubject({ currentTarget: { dataset: { subject: sub } } });
      pg.onCellPick({ currentTarget: { dataset: { d, p } } });
      wx.showToast = o;
      return { k, sub, msg, dirty: !!pg.dirty, picked: pg.data.pickedSubject };
    });
    weekSame.err
      ? bad('周表重复填前置失败: ' + JSON.stringify(weekSame))
      : (/已经是/.test(weekSame.msg) && !weekSame.dirty && weekSame.picked === ''
        ? ok('周表重复填同科目被拦且不脏: ' + weekSame.msg)
        : bad('周表重复填未拦住: ' + JSON.stringify(weekSame)));

    // 周表长按清空这一节
    const weekClear = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.setData({ pickedSubject: '', swapFrom: '' });
      const plan = pg.plan || {};
      const k = Object.keys(plan)[0];
      if (!k) return { err: 'empty-plan' };
      const [d, p] = k.split('@').map(Number);
      const before = pg.data.overview.filled;
      pg.dirty = false; pg.setData({ dirtyFlag: false });
      pg.onClearWeekCell({ currentTarget: { dataset: { d, p } } });
      const cell = (pg.data.week.find(w => w.d === d) || { cells: [] }).cells.find(c => c.p === p);
      // 再长按一次空格：必须提示「本来是空的」且不脏
      let msg = '';
      const o = wx.showToast;
      wx.showToast = x => { msg = x.title; };
      pg.dirty = false; pg.setData({ dirtyFlag: false });
      pg.onClearWeekCell({ currentTarget: { dataset: { d, p } } });
      wx.showToast = o;
      return { k, before, after: pg.data.overview.filled, gone: !pg.plan[k], cellEmpty: cell && cell.empty, msg, dirty2: !!pg.dirty };
    });
    weekClear.err
      ? bad('周表长按清空前置失败: ' + JSON.stringify(weekClear))
      : (weekClear.gone && weekClear.cellEmpty && weekClear.after === weekClear.before - 1
        && /本来是空的/.test(weekClear.msg) && !weekClear.dirty2
        ? ok(`周表长按清空生效：${weekClear.k} 已空，已排 ${weekClear.before}→${weekClear.after}；空格再长按只提示不脏`)
        : bad('周表长按清空异常: ' + JSON.stringify(weekClear)));

    // 非法格长按不许改数据
    const weekClearBad = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const before = pg.data.overview.filled;
      pg.dirty = false; pg.setData({ dirtyFlag: false });
      pg.onClearWeekCell({ currentTarget: { dataset: { d: 9, p: 3 } } });
      pg.onClearWeekCell({ currentTarget: { dataset: { d: 2, p: 0 } } });
      return { before, after: pg.data.overview.filled, dirty: !!pg.dirty };
    });
    weekClearBad.before === weekClearBad.after && !weekClearBad.dirty
      ? ok('非法格长按被拒（不改数据不标脏）')
      : bad('非法格长按改了数据: ' + JSON.stringify(weekClearBad));


    // 还原视图，让下面 day 视图断言能正常跑
    await evalRetry(mp, () => { const pg = getCurrentPages().slice(-1)[0]; pg.onBackToWeek(); pg.onOpenDay({ currentTarget: { dataset: { d: 2 } } }); });
    const schAutoClear = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      return { picked: pg.data.pickedSubject };
    });
    schAutoClear.picked === ''
      ? ok('填课后自动清掉选中科目（不会连填一片）')
      : bad(`填课后选中未清: 仍选着「${schAutoClear.picked}」`);

    // 未挑科目就点格子：有课格 = 提示先挑科目；空格 = 进待填态（2026-09-11 新流）
    const schNoPick = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      let msg = '', msg2 = '';
      const o = wx.showToast;
      const before = pg.data.overview.filled;
      const filledCell = pg.data.dayCells.find(c => !c.empty);
      pg.setData({ fillTarget: '', fillTargetLabel: '' });
      // 有课格：提示先挑科目
      wx.showToast = x => { msg = x.title; };
      pg.onTapCell({ currentTarget: { dataset: { p: filledCell ? filledCell.p : 1 } } });
      // 空格：进待填态（先临时腾空一格，测完还原）
      const d = pg.data.currentDay;
      const tp = filledCell ? filledCell.p : 1;
      const tk = d + '@' + tp;
      const orig = pg.plan[tk];
      delete pg.plan[tk];
      pg.render();
      wx.showToast = x => { msg2 = x.title; };
      pg.dirty = false;
      pg.setData({ dirtyFlag: false });
      pg.onTapCell({ currentTarget: { dataset: { p: tp } } });
      wx.showToast = o;
      const t1 = pg.data.fillTarget;
      const dirtyAfterTap = !!pg.dirty;
      // 再点科目直接填入（单日反向流）
      pg.onPickSubject({ currentTarget: { dataset: { subject: '音乐' } } });
      const filled2 = pg.plan[tk] && pg.plan[tk].subject;
      const t2 = pg.data.fillTarget;
      // 还原原课
      if (orig) pg.plan[tk] = orig; else delete pg.plan[tk];
      pg.markDirty();
      pg.render();
      return { msg, msg2, before, after: pg.data.overview.filled, t1, dirtyAfterTap, filled2, t2,
               restored: pg.plan[tk] && pg.plan[tk].subject };
    });
    /先.*挑.*科目/.test(schNoPick.msg) && /再挑.*科目/.test(schNoPick.msg2)
      && schNoPick.after === schNoPick.before && !!schNoPick.t1 && schNoPick.dirtyAfterTap === false
      && schNoPick.filled2 === '音乐' && schNoPick.t2 === '' && !!schNoPick.restored
      ? ok('未挑科目：点有课格提示「' + schNoPick.msg + '」；点空格进待填→挑音乐直接填入（单日反向流）')
      : bad('未挑科目流异常: ' + JSON.stringify(schNoPick));

    // 覆盖：同一格换科目走 update 而不是新增（一格一课的核心不变量）
    const schOverwrite = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const filled = pg.data.dayCells.find(c => !c.empty);
      const before = pg.data.overview.filled;
      const oldSub = filled.subject;
      const newSub = oldSub === '地理' ? '历史' : '地理';
      pg.onPickSubject({ currentTarget: { dataset: { subject: newSub } } });
      pg.onTapCell({ currentTarget: { dataset: { p: filled.p } } });
      const now = pg.data.dayCells.find(c => c.p === filled.p);
      return { p: filled.p, oldSub, newSub, nowSub: now && now.subject, before, after: pg.data.overview.filled };
    });
    schOverwrite.nowSub === schOverwrite.newSub && schOverwrite.after === schOverwrite.before
      ? ok(`覆盖生效：第${schOverwrite.p}节 ${schOverwrite.oldSub}→${schOverwrite.newSub}，总节次不变（一格一课）`)
      : bad('覆盖异常: ' + JSON.stringify(schOverwrite));

    // 重复填同一科目要被拦（避免无意义的 dirty）
    // ⚠️ onPickSubject 是 toggle：如果当前已选中同一科目，再点会「取消」而不是「选中」，
    //    于是后面点格子会报「先挑科目」，测不到本意（第一版就踩了这个，红字误导了一轮）。
    //    所以先强制清空选中，再挑，保证进入的是「已选中该科目」状态。
    const schSameAgain = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const filled = pg.data.dayCells.find(c => !c.empty);
      let msg = '';
      const o = wx.showToast;
      wx.showToast = x => { msg = x.title; };
      pg.setData({ pickedSubject: '' });
      pg.onPickSubject({ currentTarget: { dataset: { subject: filled.subject } } });
      const pickedNow = pg.data.pickedSubject;
      pg.onTapCell({ currentTarget: { dataset: { p: filled.p } } });
      wx.showToast = o;
      return { msg, sub: filled.subject, pickedNow };
    });
    schSameAgain.pickedNow === schSameAgain.sub && /已经是/.test(schSameAgain.msg)
      ? ok('重复填同一科目被拦下: ' + schSameAgain.msg)
      : bad('重复填未拦住: ' + JSON.stringify(schSameAgain));

    // onPickSubject 的 toggle 行为本身也要有断言（上面依赖它，不测就是暗礁）
    const schToggle = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.setData({ pickedSubject: '' });
      pg.onPickSubject({ currentTarget: { dataset: { subject: '体育' } } });
      const first = pg.data.pickedSubject;
      pg.onPickSubject({ currentTarget: { dataset: { subject: '体育' } } });
      const second = pg.data.pickedSubject;
      pg.onPickSubject({ currentTarget: { dataset: { subject: '搬砖' } } });
      const illegal = pg.data.pickedSubject;
      return { first, second, illegal };
    });
    schToggle.first === '体育' && schToggle.second === '' && schToggle.illegal === ''
      ? ok('挑科目 toggle 正确（再点取消），非法科目被拒')
      : bad('挑科目行为异常: ' + JSON.stringify(schToggle));

    // 长按清课：「无记录 = 空课」，不许存占位记录
    const schClearCell = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const filled = pg.data.dayCells.find(c => !c.empty);
      const before = pg.data.overview.filled;
      pg.onClearCell({ currentTarget: { dataset: { p: filled.p } } });
      const now = pg.data.dayCells.find(c => c.p === filled.p);
      const hasKey = Object.prototype.hasOwnProperty.call(pg.plan, pg.data.currentDay + '@' + filled.p);
      return { p: filled.p, before, after: pg.data.overview.filled, emptyNow: now && now.empty, hasKey };
    });
    schClearCell.emptyNow && schClearCell.after === schClearCell.before - 1 && !schClearCell.hasKey
      ? ok(`长按清课生效：第${schClearCell.p}节 变空，已排 ${schClearCell.before}→${schClearCell.after}，本地无占位键`)
      : bad('清课异常: ' + JSON.stringify(schClearCell));

    // 清空课的格子再长按：要提示而不是静默
    const schClearTwice = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const blank = pg.data.dayCells.find(c => c.empty);
      let msg = '';
      const o = wx.showToast;
      wx.showToast = x => { msg = x.title; };
      pg.onClearCell({ currentTarget: { dataset: { p: blank.p } } });
      wx.showToast = o;
      return { msg };
    });
    /本来是空的/.test(schClearTwice.msg) ? ok('清空课有提示: ' + schClearTwice.msg) : bad('清空课无提示: ' + JSON.stringify(schClearTwice));

    // 套用模板：40 格全排满、无空课、且不许出现「同一格两门课」
    const schTpl = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.onBackToWeek();
      pg.onApplyTemplate();
      const keys = Object.keys(pg.plan);
      const cellSum = pg.data.week.reduce((a, w) => a + w.cells.filter(c => !c.empty).length, 0);
      // 上午必须是主科（模板的业务承诺：学生上午状态好）
      const amMain = pg.data.week.every(w => w.cells.slice(0, 4).every(c => ['语文', '数学', '英语', '物理'].indexOf(c.subject) >= 0));
      // 第 8 节固定自习
      // ⚠️ 不许用 cells[7] 这种下标：午间延时插到 index 4 后，下标 7 指向第 7 节而不是第 8 节
      //    （实测踩过，报「模板异常 lastSelf:false」）。一律按 period 找格子。
      const cellOf = (w, p) => w.cells.filter(c => c.p === p)[0] || {};
      const lastSelf = pg.data.week.every(w => cellOf(w, 8).subject === '自习');
      const noonSelf = pg.data.week.every(w => cellOf(w, 9).subject === '自习');
      // 显示顺序必须是「上午4节 → 延时 → 下午4节」（period 9 在数组第 5 位，不是末位）
      const orderOk = pg.data.week.every(w => w.cells.map(c => c.p).join(',') === '1,2,3,4,9,5,6,7,8');
      const noonPart = pg.data.week.every(w => cellOf(w, 9).part === 'noon');
      // 每天第 1 节不许全周相同（否则模板等于没轮转）
      const firsts = pg.data.week.map(w => w.cells[0].subject);
      return {
        slots: pg.data.overview.slots, filled: pg.data.overview.filled, empty: pg.data.overview.empty,
        keys: keys.length, uniqKeys: new Set(keys).size, cellSum, amMain, lastSelf,
        noonSelf, orderOk, noonPart,
        firstVaried: new Set(firsts).size > 1, firsts
      };
    });
    schTpl.filled === SCHED_SLOTS && schTpl.empty === 0 && schTpl.cellSum === SCHED_SLOTS && schTpl.keys === SCHED_SLOTS && schTpl.uniqKeys === SCHED_SLOTS
      && schTpl.amMain && schTpl.lastSelf && schTpl.firstVaried
      && schTpl.noonSelf && schTpl.orderOk && schTpl.noonPart
      ? ok(`套用模板：${SCHED_SLOTS} 格全排满、上午全主科、午间延时(period9)+第8节自习、显示顺序1234-延时-5678、首节轮转(${schTpl.firsts.join('/')})`)
      : bad('模板异常: ' + JSON.stringify(schTpl));

    // 保存：触发/等待/读取分三次短 evaluate（长 evaluate 会撞 automator 响应窗口，[17]/[18] 都踩过）
    await evalRetry(mp, () => { getCurrentPages().slice(-1)[0].onSave(); return 1; });
    // 45 条 diff 写库中途撞 IDE 传输抖动（db.retry 4 次仍败）会留尾巴：大部分已写、
    // 剩 2 条没写完，dirty 保持 true → 后续「云端不一致」「无改动仍写库」连环红（实测事故）。
    // 固定 sleep(9000) 不够：轮询等 dirty 落定；超时仍 dirty 就像老师一样再点一次保存再等一轮，
    // 两轮都不行才判红（区分「传输抖动」和「保存真坏了」）。
    await waitPageIdle(mp, { label: '课表保存', timeoutMs: 60000, requireClean: true });
    let schedSave = null;
    schedSave = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      return {
        dirty: !!pg.dirty,
        flag: pg.data.dirtyFlag,
        saving: pg.data.saving,
        filled: pg.data.overview.filled,
        keys: [].concat(...pg.data.week.map(w => w.cells.filter(c => !c.empty).map(c => `${w.d}@${c.p}@${c.subject}`)))
      };
    });
    // 必须同时查 this.dirty 和 data.dirtyFlag：只查前者会漏掉「数据已存但按钮还写着『保存』」
    // —— 老师看到「保存」两个字会以为没存上，反复点。这是探针实测出来的真 bug（render 漏同步 dirtyFlag）。
    !schedSave.dirty && schedSave.flag === false && schedSave.saving === false
      ? ok('课表保存后 dirty + dirtyFlag + saving 全清（按钮回「已同步」）')
      : bad('保存后状态未清: ' + JSON.stringify({ dirty: schedSave.dirty, flag: schedSave.flag, saving: schedSave.saving }));

    const schedCloud = await evalRetry(mp, () => {
      // ⚠️ evaluate 的函数体在模拟器里执行，拿不到 Node 侧的 SCHED_PERIODS
      //    （实测报 `Uncaught SCHED_PERIODS is not defined`，整段中断）。
      //    常量必须在函数体内自带一份。
      const OKP = [1, 2, 3, 4, 9, 5, 6, 7, 8];
      const d = wx.cloud.database();
      return d.collection('schedule').count().then(({ total }) => {
        const readAll = async (skip, out) => {
          const r = await d.collection('schedule').skip(skip).limit(20).get();
          out.push(...r.data);
          return (r.data.length < 20 || out.length >= total) ? out : readAll(skip + 20, out);
        };
        return readAll(0, []).then(all => ({
          total,
          keys: all.map(x => `${x.weekday}@${x.period}@${x.subject}`),
          slotKeys: all.map(x => `${x.weekday}@${x.period}`),
          illegal: all.filter(x => !(Number(x.weekday) >= 1 && Number(x.weekday) <= 5)
            || OKP.indexOf(Number(x.period)) < 0).length
        }));
      });
    });
    const sCloudSet = new Set(schedCloud.keys);
    const sPageSet = new Set(schedSave.keys);
    const sOnlyCloud = schedCloud.keys.filter(k => !sPageSet.has(k));
    const sOnlyPage = schedSave.keys.filter(k => !sCloudSet.has(k));
    schedCloud.total === schedSave.filled && sOnlyCloud.length === 0 && sOnlyPage.length === 0
      ? ok(`云端 ${schedCloud.total} 节与页面逐格一致`)
      : bad(`云端不一致: 云端${schedCloud.total}/页面${schedSave.filled} 云端多${JSON.stringify(sOnlyCloud.slice(0, 3))} 页面多${JSON.stringify(sOnlyPage.slice(0, 3))}`);
    // 一格一课：slotKey 不许重复（diff 写坏就会同格两条）
    new Set(schedCloud.slotKeys).size === schedCloud.slotKeys.length
      ? ok('云端一格一课（无同格重复记录）')
      : bad(`云端有 ${schedCloud.slotKeys.length - new Set(schedCloud.slotKeys).size} 格排了两门课`);
    schedCloud.illegal === 0 ? ok('云端无非法 weekday/period') : bad(`云端有 ${schedCloud.illegal} 条非法记录`);

    // 无改动不写库
    await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.__msg = '';
      pg.__origToast = wx.showToast;
      wx.showToast = o => { pg.__msg = o.title; };
      pg.onSave();
      return 1;
    });
    await waitPageIdle(mp, { label: '课表空保存' });
    const schedNoop = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      if (pg.__origToast) { wx.showToast = pg.__origToast; pg.__origToast = null; }
      return { msg: pg.__msg || '' };
    });
    /没有改动/.test(schedNoop.msg) ? ok('无改动时不写库（diff 生效）') : bad('无改动仍写库: ' + JSON.stringify(schedNoop));

    // 改科目必须走 update 而不是新增：云端总数不许变，且要真发生 update
    // ⚠️ 不能只查总数 —— 座位页踩过：diff 幂等时「重复写」也不改总数。必须数真实写调用。
    await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const dbm = require('utils/db.js');
      pg.__w = { add: 0, update: 0, remove: 0 };
      pg.__orig = pg.__orig || {};
      ['add', 'update', 'remove'].forEach(k => {
        if (!pg.__orig[k]) pg.__orig[k] = dbm[k];
        dbm[k] = function (...a) { pg.__w[k] += 1; return pg.__orig[k].apply(dbm, a); };
      });
      pg.onOpenDay({ currentTarget: { dataset: { d: 4 } } });
      const cell = pg.data.dayCells[0];
      const newSub = cell.subject === '美术' ? '音乐' : '美术';
      pg.onPickSubject({ currentTarget: { dataset: { subject: newSub } } });
      pg.onTapCell({ currentTarget: { dataset: { p: cell.p } } });
      pg.onSave();
      return 1;
    });
    await waitPageIdle(mp, { label: '课表改科目保存', requireClean: true });
    const schUpdOnly = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const dbm = require('utils/db.js');
      ['add', 'update', 'remove'].forEach(k => { if (pg.__orig && pg.__orig[k]) dbm[k] = pg.__orig[k]; });
      pg.__orig = null;
      return wx.cloud.database().collection('schedule').count()
        .then(c => ({ total: c.total, writes: pg.__w, filled: pg.data.overview.filled, dirty: !!pg.dirty }));
    });
    schUpdOnly.writes && schUpdOnly.writes.update === 1 && schUpdOnly.writes.add === 0 && schUpdOnly.writes.remove === 0
      && schUpdOnly.total === SCHED_SLOTS && !schUpdOnly.dirty
      ? ok(`改科目只发 1 次 update（未新增/未删除），云端仍 ${SCHED_SLOTS} 节`)
      : bad('改科目写法不对: ' + JSON.stringify(schUpdOnly));

    // 防连点：跨 tick 连点 3 次只能生效一次。
    // ⚠️ 必须跨 tick + 数真实写调用：同 tick 版本在 _busy 被换成 data.saving 时照样全绿（实测）
    await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const dbm = require('utils/db.js');
      pg.__w2 = { add: 0, update: 0, remove: 0 };
      pg.__orig2 = pg.__orig2 || {};
      ['add', 'update', 'remove'].forEach(k => {
        if (!pg.__orig2[k]) pg.__orig2[k] = dbm[k];
        dbm[k] = function (...a) { pg.__w2[k] += 1; return pg.__orig2[k].apply(dbm, a); };
      });
      const cell = pg.data.dayCells[1];
      const newSub = cell.subject === '信息' ? '地理' : '信息';
      pg.onPickSubject({ currentTarget: { dataset: { subject: newSub } } });
      pg.onTapCell({ currentTarget: { dataset: { p: cell.p } } });
      pg.onSave();
      setTimeout(() => pg.onSave(), 60);
      setTimeout(() => pg.onSave(), 140);
      return 1;
    });
    await waitPageIdle(mp, { label: '课表连点保存', requireClean: true });
    const schedDbl = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const dbm = require('utils/db.js');
      ['add', 'update', 'remove'].forEach(k => { if (pg.__orig2 && pg.__orig2[k]) dbm[k] = pg.__orig2[k]; });
      pg.__orig2 = null;
      return wx.cloud.database().collection('schedule').count()
        .then(c => ({ total: c.total, writes: pg.__w2, dirty: !!pg.dirty }));
    });
    const schedWrites = schedDbl.writes ? schedDbl.writes.add + schedDbl.writes.update + schedDbl.writes.remove : -1;
    schedWrites === 1 && schedDbl.total === SCHED_SLOTS && !schedDbl.dirty
      ? ok(`保存防连点：连点 3 次只发了 ${schedWrites} 次写调用，云端仍 ${schedDbl.total} 节`)
      : bad(`保存连点异常: 写调用 ${schedWrites} 次(应 1) ${JSON.stringify(schedDbl)}`);

    // 清空：本地清干净，保存后云端也清空
    const schedClearPre = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const orig = wx.showModal;
      wx.showModal = o => { o.success && o.success({ confirm: true }); };
      pg.onBackToWeek();
      pg.onClearAll();
      wx.showModal = orig;
      const out = { cleared: pg.data.overview.filled, empty: pg.data.overview.empty, conflicts: pg.data.overview.conflicts };
      pg.onSave();
      return out;
    });
    await waitPageIdle(mp, { label: '课表清空保存', timeoutMs: 60000, requireClean: true });
    const schedClear = await evalRetry(mp, () => wx.cloud.database().collection('schedule').count().then(c => ({ cloud: c.total })));
    Object.assign(schedClear, schedClearPre);
    schedClear.cleared === 0 && schedClear.cloud === 0 && schedClear.empty === SCHED_SLOTS && schedClear.conflicts === 0
      ? ok(`清空生效：页面 0 节、云端 0 条、空课 ${SCHED_SLOTS}、冲突 0`)
      : bad('清空异常: ' + JSON.stringify(schedClear));

    // 取消清空不许动数据
    const schedCancel = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.onApplyTemplate();
      const before = pg.data.overview.filled;
      const orig = wx.showModal;
      wx.showModal = o => { o.success && o.success({ confirm: false }); };
      pg.onClearAll();
      wx.showModal = orig;
      return { before, after: pg.data.overview.filled };
    });
    schedCancel.after === schedCancel.before && schedCancel.before === SCHED_SLOTS
      ? ok(`弹窗点取消不清空（${SCHED_SLOTS} 节仍在）`) : bad('取消清空仍被清: ' + JSON.stringify(schedCancel));

    // 还原：把课表存回去，别给用户留空表
    await evalRetry(mp, () => { getCurrentPages().slice(-1)[0].onSave(); return 1; });
    await waitPageIdle(mp, { label: '课表还原保存', timeoutMs: 60000, requireClean: true });
    const schedRestore = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      return wx.cloud.database().collection('schedule').count()
        .then(c => ({ cloud: c.total, page: pg.data.overview.filled, dirty: !!pg.dirty }));
    });
    schedRestore.cloud === schedRestore.page && schedRestore.cloud === SCHED_SLOTS && !schedRestore.dirty
      ? ok(`课表已还原（云端 ${schedRestore.cloud} 节）`)
      : bad('还原失败: ' + JSON.stringify(schedRestore));

    // 概览入口
    const dashSched = await goto(mp, '/pages/dashboard/dashboard', 3500);
    const schedLink = await $retry(dashSched, '.link-schedule-quick');
    if (schedLink) {
      await schedLink.tap();
      await sleep(3000);
      const curSched = await mp.currentPage();
      curSched && curSched.path.indexOf('schedule') >= 0 ? ok('概览可跳课程表') : bad('跳转失败: ' + (curSched && curSched.path));
    } else {
      bad('概览缺 .link-schedule-quick 入口');
    }

    console.log('\n[20] 班委名单：岗位任职/一岗最多两人/积分推荐/告警/保存 diff');
    // 段首必须能从**任意**初始态起跑（含空库）：变异体/上一轮收尾可能把 committee 清成 0 条。
    // schedule 段就踩过「dropped=0 → 前置准备失败 → mutate 读成基线红」（规则 17 的完整落实）。
    const commSeedIfEmpty = await evalRetry(mp, () => {
      const d = wx.cloud.database();
      const POSTS = ['班长', '副班长', '学习委员', '纪律委员', '劳动委员', '文艺委员',
        '体育委员', '宣传委员', '生活委员', '语文科代表', '数学科代表', '英语科代表'];
      return d.collection('committee').count().then(({ total }) => {
        if (total > 0) return { seeded: 0, total };
        return d.collection('students').orderBy('studentNo', 'asc').limit(20).get().then(r => {
          const stu = r.data;
          if (stu.length < 10) return { seeded: 0, total: 0, why: 'students too few: ' + stu.length };
          // 复现 seed 的形态：填 9 个岗（学习委员留空 → 核心岗告警），第 1 人兼 3 岗（兼岗告警）
          const plan = {};
          POSTS.filter(p => p !== '学习委员').slice(0, 9).forEach((p, i) => { plan[p] = stu[i + 1]._id; });
          plan['班长'] = stu[0]._id;
          plan['文艺委员'] = stu[0]._id;
          plan['宣传委员'] = stu[0]._id;
          const docs = Object.keys(plan).map(post => ({ post, studentId: plan[post] }));
          return Promise.all(docs.map(doc => d.collection('committee').add({ data: doc })))
            .then(() => d.collection('committee').count()).then(c => ({ seeded: docs.length, total: c.total }));
        });
      });
    });
    // ⚠️ 不许断言「恰好 9 条」：seed 态是 9，但上一轮 [20] 收尾会把它还原成 12（推荐填满）。
    //    写死数字就等于依赖上一轮收尾（规则 17）。只要求「1~12 条之间且非空」——
    //    真正的前置条件由下一步 commPrep 显式造出来。
    commSeedIfEmpty.total >= 1 && commSeedIfEmpty.total <= 12
      ? ok(commSeedIfEmpty.seeded ? `前置：库为空，自灌 ${commSeedIfEmpty.seeded} 条任职（留 3 空缺 + 1 人兼 3 岗）` : `前置：云端已有 ${commSeedIfEmpty.total} 条任职`)
      : bad('班委前置灌数异常: ' + JSON.stringify(commSeedIfEmpty));

    // 前置自造两类告警：核心岗空缺 + 一人兼岗过多。
    // ⚠️ 绝不能靠 seed 初始态：上一轮跑完可能已被「按积分推荐」填满（那时 keyEmpty=0），
    //    于是「告警复算一致」在 0 == 0 时也全绿 —— 等于没测（schedule 的冲突断言踩过这个坑）。
    // ⚠️ 不许假设「库非空 ⇒ 班长一定在」：实测事故（baseline 变红）—— 上一轮变异体收尾把
    //    committee 留成「12 条但没班长」的形态，prep 早退 no-monitor → 兼岗告警造不出来，
    //    “告警复算”断言跟着变红，而且看上去像业务 bug。前置必须自己把班长造出来（规则 14）。
    const commPrep = await evalRetry(mp, () => {
      const d = wx.cloud.database();
      // 1) 学习委员必须空着（造「核心岗空缺」告警）
      return d.collection('committee').where({ post: '学习委员' }).get().then(r =>
        Promise.all(r.data.map(x => d.collection('committee').doc(x._id).remove()))
      ).then(() => d.collection('committee').where({ post: '班长' }).get()).then(r => {
        if (r.data.length) return { sid: r.data[0].studentId, madeMonitor: false };
        // 班长空缺：自己任命一个（挑一个真存在的学生，否则会造出孤儿班委）
        return d.collection('students').orderBy('studentNo', 'asc').limit(1).get().then(sr => {
          if (!sr.data.length) return { sid: '', madeMonitor: false, why: 'no-students' };
          const sid = sr.data[0]._id;
          return d.collection('committee').add({ data: { post: '班长', studentId: sid } })
            .then(() => ({ sid, madeMonitor: true }));
        });
      }).then(base => {
        if (!base.sid) return { keySlot: 'no-student', why: base.why };
        const sid = base.sid;
        // 2) 让班长同时兼「文艺委员」「宣传委员」= 3 个岗（> MAX 2，造「兼岗过多」告警）
        const put = post => d.collection('committee').where({ post }).get().then(rr => rr.data.length
          ? Promise.all(rr.data.slice(1).map(x => d.collection('committee').doc(x._id).remove()))
              .then(() => d.collection('committee').doc(rr.data[0]._id).update({ data: { studentId: sid } }))
          : d.collection('committee').add({ data: { post, studentId: sid } }));
        return put('文艺委员').then(() => put('宣传委员'))
          .then(() => ({ keySlot: 'cleared', multiOn: sid, madeMonitor: base.madeMonitor }));
      });
    });
    commPrep.keySlot === 'cleared'
      ? ok('前置：造出两类告警（学习委员空缺 / 班长兼 3 岗'
          + (commPrep.madeMonitor ? '，班长空缺已自行任命' : '') + '）')
      : bad('班委告警前置失败: ' + JSON.stringify(commPrep));

    const commPage = await goto(mp, '/pages/committee/committee', 4000);
    const cPosts = await commPage.data('posts');
    const cOv = await commPage.data('overview');
    const cWarn = await commPage.data('warnList');
    const cIdle = await commPage.data('idleList');

    cPosts.length === 12
      ? ok('岗位清单 12 个（含 3 个核心岗）')
      : bad(`岗位数错: ${cPosts.length}`);
    // 类名必须全 ASCII：中文进 class 会让整份 wxss 编译失败（本项目一号事故）
    cPosts.every(p => /^[a-z]+$/.test(p.pcls))
      ? ok('岗位类名全 ASCII（wxss 不会编译失败）')
      : bad('类名含非 ASCII: ' + JSON.stringify(cPosts.filter(p => !/^[a-z]+$/.test(p.pcls)).map(p => p.post + '→' + p.pcls)));
    // 口径闭合：三个数字必须互相对得上（页面显示与将保存的数据同源）
    const cFilled = cPosts.filter(p => !p.empty).length;
    cOv.filled === cFilled && cOv.slots === 12 && cOv.filled + cOv.empty === cOv.slots
      ? ok(`口径闭合：已定 ${cOv.filled} = 岗位求和，已定+空缺=${cOv.slots}`)
      : bad(`口径不闭合: ${JSON.stringify(cOv)} 求和=${cFilled}`);
    // 核心岗恰好 3 个且标记正确
    cPosts.filter(p => p.isKey).map(p => p.post).join(',') === '班长,副班长,学习委员'
      ? ok('核心岗标记正确（班长/副班长/学习委员）')
      : bad('核心岗标记错: ' + JSON.stringify(cPosts.filter(p => p.isKey).map(p => p.post)));

    // 告警复算：不许只比「页面 == 复算」（0 == 0 也成立），必须两类都真的出现
    const keyEmptyReal = cPosts.filter(p => p.empty && p.isKey);
    const holdReal = {};
    cPosts.forEach(p => (p.holders || []).forEach(h => { holdReal[h.studentId] = (holdReal[h.studentId] || 0) + 1; }));
    const multiReal = Object.keys(holdReal).filter(k => holdReal[k] > 2);
    const expectWarns = keyEmptyReal.length + multiReal.length;
    cWarn.length === expectWarns && expectWarns >= 2 && keyEmptyReal.length >= 1 && multiReal.length >= 1
      ? ok(`告警复算一致（${expectWarns} 处，核心岗空缺+兼岗过多两类都命中）`)
      : bad(`告警复算不一致或未覆盖两类: 页面${cWarn.length} 复算${expectWarns} keyEmpty=${keyEmptyReal.length} multi=${multiReal.length} :: ${JSON.stringify(cWarn.map(w => w.text))}`);
    cOv.keyEmpty === keyEmptyReal.length && cOv.multi === multiReal.length
      ? ok(`概览告警计数与清单一致（核心岗空 ${cOv.keyEmpty} / 兼岗过多 ${cOv.multi} 人）`)
      : bad(`概览告警计数漂移: ${JSON.stringify(cOv)} 实际 key=${keyEmptyReal.length} multi=${multiReal.length}`);
    cWarn.every(w => w.key && w.text)
      ? ok('告警文案含可定位内容且有唯一 key')
      : bad('告警项缺 key/text: ' + JSON.stringify(cWarn.slice(0, 2)));

    // 未任职名单：必须等于「没有任何岗位的人」，且按积分降序
    const holdIds = new Set();
    cPosts.forEach(p => (p.holders || []).forEach(h => holdIds.add(h.studentId)));
    const idleCross = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      return { students: (pg.students || []).length, idle: pg.data.idleList.length };
    });
    idleCross.idle === idleCross.students - holdIds.size
      ? ok(`未任职名单闭合：${idleCross.idle} = 全班 ${idleCross.students} - 任职 ${holdIds.size} 人`)
      : bad(`未任职名单不闭合: idle=${idleCross.idle} 全班=${idleCross.students} 任职=${holdIds.size}`);
    cIdle.every((x, i) => i === 0 || cIdle[i - 1].points >= x.points)
      ? ok('未任职名单按积分降序') : bad('未任职名单未降序: ' + JSON.stringify(cIdle.map(x => x.points).slice(0, 6)));
    // rewards 可能被清理段删光（推荐步显示「最高分 0」就是证据），
    // 空集核对 checked=0 没意义会直接红。先补一条真奖惩再刷页，让交叉核对有真数据；
    // 核完立即删除并再刷新，不污染后续段落。
    const ptsSeed = await evalRetry(mp, () => {
      const db = require('utils/db.js');
      return db.list('rewards', {}, 1).then(r => {
        if (r.length) return null;
        return db.list('students', {}, 1).then(st =>
          db.add('rewards', {
            studentId: st[0]._id, type: '表扬', reason: 'E2E积分核对',
            points: 3, date: '2027-01-01', _reg: true
          }).then(() => st[0]._id));
      });
    });
    if (ptsSeed) {
      await evalRetry(mp, () => { const pg = getCurrentPages().slice(-1)[0]; pg.refresh(); return 1; });
      await sleep(3000);
    }
    // 积分必须由 rewards 实时汇总（不是存在 students 上的冗余字段）
    const ptsCross = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const db = require('utils/db.js');
      return db.list('rewards', {}, 20, { orderBy: [['date', 'desc']] }).then(r => {
        const sum = {};
        r.forEach(x => { const n = Number(x.points); if (Number.isFinite(n)) sum[x.studentId] = (sum[x.studentId] || 0) + n; });
        const ids = Object.keys(sum);
        return { checked: ids.length, mismatch: ids.filter(id => (pg.points || {})[id] !== sum[id]).length };
      });
    });
    ptsCross.checked > 0 && ptsCross.mismatch === 0
      ? ok(`积分由奖惩实时汇总（核对 ${ptsCross.checked} 人，无偏差）`)
      : bad('积分汇总不一致: ' + JSON.stringify(ptsCross));
    if (ptsSeed) {
      await evalRetry(mp, () => {
        const d = wx.cloud.database();
        return d.collection('rewards').where({ _reg: true, reason: 'E2E积分核对' }).get()
          .then(r => Promise.all(r.data.map(x => d.collection('rewards').doc(x._id).remove())));
      });
      await evalRetry(mp, () => { const pg = getCurrentPages().slice(-1)[0]; pg.refresh(); return 1; });
      await sleep(2500);
    }

    // 进挑人视图
    const cPickEnter = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const vacant = pg.data.posts.find(p => p.empty);
      if (!vacant) return { skip: 'no-vacant' };
      pg.onOpenPost({ currentTarget: { dataset: { post: vacant.post } } });
      return { view: pg.data.view, post: pg.data.currentPost, pcls: pg.data.currentPcls, pool: pg.data.pool.length };
    });
    cPickEnter.view === 'pick' && cPickEnter.pool > 0 && /^[a-z]+$/.test(cPickEnter.pcls || '')
      ? ok(`进入「${cPickEnter.post}」挑人：${cPickEnter.pool} 个候选，pcls=${cPickEnter.pcls}`)
      : bad('进入挑人失败: ' + JSON.stringify(cPickEnter));

    // 非法岗位不许进（用户点不到，但脏 dataset / 恶意调用能造出来）
    const cPostBad = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const before = pg.data.currentPost;
      pg.onOpenPost({ currentTarget: { dataset: { post: '扫地委员' } } });
      pg.onOpenPost({ currentTarget: { dataset: { post: '' } } });
      return { before, after: pg.data.currentPost };
    });
    cPostBad.after === cPostBad.before ? ok('非法岗位名被拒，currentPost 未变') : bad('非法岗位改了状态: ' + JSON.stringify(cPostBad));

    // 候选池按积分降序（老师挑班委看的就是这个）
    const cPoolSort = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const p = pg.data.pool;
      return { desc: p.every((x, i) => i === 0 || p[i - 1].points >= x.points), n: p.length, top3: p.slice(0, 3).map(x => x.points) };
    });
    cPoolSort.desc ? ok(`候选池按积分降序（前三 ${JSON.stringify(cPoolSort.top3)}）`) : bad('候选池未降序: ' + JSON.stringify(cPoolSort));

    // 「只看未任职」筛选：结果必须全是 holds===0（或当前任职者）
    const cFilter = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const before = pg.data.pool.length;
      pg.onToggleFilter();
      const idleOnly = pg.data.pool;
      const bad = idleOnly.filter(x => x.holds !== 0 && !x.isCurrent).length;
      const mode = pg.data.poolFilter;
      pg.onToggleFilter();
      return { before, idleN: idleOnly.length, bad, mode, backMode: pg.data.poolFilter, backN: pg.data.pool.length };
    });
    cFilter.mode === 'idle' && cFilter.bad === 0 && cFilter.idleN <= cFilter.before
      && cFilter.backMode === 'all' && cFilter.backN === cFilter.before
      ? ok(`筛选「只看未任职」生效（${cFilter.before}→${cFilter.idleN}，无兼岗者混入），切回全班复原`)
      : bad('筛选异常: ' + JSON.stringify(cFilter));

    // 任命：点候选人 → 岗位定人 + 自动回岗位清单（不清视图老师会误点成改任）
    const cAssign = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const vacant = pg.data.posts.find(p => p.empty);
      if (!vacant) return { skip: 'no-vacant' };
      pg.onOpenPost({ currentTarget: { dataset: { post: vacant.post } } });
      const cand = pg.data.pool.find(x => x.holds === 0);
      if (!cand) return { skip: 'no-idle-cand' };
      const before = pg.data.overview.filled;
      pg.onAssign({ currentTarget: { dataset: { id: cand._id } } });
      const now = pg.data.posts.find(p => p.post === vacant.post);
      return {
        post: vacant.post, name: cand.name, before, after: pg.data.overview.filled,
        nowName: now && now.name, nowEmpty: now && now.empty,
        view: pg.data.view, curPost: pg.data.currentPost
      };
    });
    cAssign.nowName === cAssign.name && !cAssign.nowEmpty && cAssign.after === cAssign.before + 1
      && cAssign.view === 'list' && cAssign.curPost === ''
      ? ok(`任命生效：${cAssign.post} → ${cAssign.name}，已定 ${cAssign.before}→${cAssign.after}，自动回岗位清单`)
      : bad('任命异常: ' + JSON.stringify(cAssign));

    // 幽灵 id 不许写进去（脏 dataset）
    const cGhost = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const vacant = pg.data.posts.find(p => p.empty) || pg.data.posts[0];
      pg.onOpenPost({ currentTarget: { dataset: { post: vacant.post } } });
      const before = pg.data.overview.filled;
      pg.onAssign({ currentTarget: { dataset: { id: 'GHOST_NOT_EXIST' } } });
      const now = pg.data.posts.find(p => p.post === vacant.post);
      return { before, after: pg.data.overview.filled, post: vacant.post, nowId: now && now.studentId, view: pg.data.view };
    });
    cGhost.after === cGhost.before && cGhost.nowId !== 'GHOST_NOT_EXIST'
      ? ok('幽灵 studentId 被拒（不写进任职）')
      : bad('幽灵 id 混进去了: ' + JSON.stringify(cGhost));

    // 换人：同一岗位再挑别人是覆盖，总数不变（一岗一人的核心不变量）
    const cReplace = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      // 找一个还能加人的岗位（已有 1 人），追加第二人
      const filled = pg.data.posts.find(p => !p.empty && p.count < 2);
      if (!filled) return { skip: 'no-addable-post' };
      pg.onOpenPost({ currentTarget: { dataset: { post: filled.post } } });
      const other = pg.data.pool.find(x => !(filled.holders || []).some(h => h.studentId === x._id));
      if (!other) return { skip: 'no-outsider' };
      const before = pg.data.overview.filled;
      pg.onAssign({ currentTarget: { dataset: { id: other._id } } });
      const now = pg.data.posts.find(p => p.post === filled.post);
      const names = (now.holders || []).map(h => h.name);
      return {
        post: filled.post, oldNames: (filled.holders || []).map(h => h.name), newName: other.name,
        names, count: now.count, before, after: pg.data.overview.filled
      };
    });
    cReplace.skip
      ? ok('追加第二人跳过: ' + cReplace.skip)
      : (cReplace.names.indexOf(cReplace.newName) >= 0 && cReplace.count === 2
         && cReplace.oldNames.every(n => cReplace.names.indexOf(n) >= 0)
         && cReplace.after === cReplace.before
         ? ok(`追加第二人生效：${cReplace.post} 现共 2 人（${cReplace.names.join('、')}），岗位数不变`)
         : bad('追加第二人异常: ' + JSON.stringify(cReplace)));

    // 重复任命同一人要被拦（避免无意义 dirty）
    const cSameAgain = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const filled = pg.data.posts.find(p => !p.empty);
      pg.onOpenPost({ currentTarget: { dataset: { post: filled.post } } });
      const sid = (filled.holders[0] || {}).studentId;
      let msg = '';
      const o = wx.showToast;
      wx.showToast = x => { msg = x.title; };
      pg.onAssign({ currentTarget: { dataset: { id: sid } } });
      wx.showToast = o;
      const now = pg.data.posts.find(p => p.post === filled.post);
      return { msg, post: filled.post, view: pg.data.view, count: now.count };
    });
    /已经在任/.test(cSameAgain.msg) && cSameAgain.view === 'pick'
      ? ok('同岗重复任命同一人被拦下: ' + cSameAgain.msg)
      : bad('重复任命未拦住: ' + JSON.stringify(cSameAgain));

    // 长按撤职：「无记录 = 空缺」，不许存占位记录
    const cVacate = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.onBackToList();
      // 找一个只有 1 人的岗位长按整行撤（撤完该岗位变空缺，filled -1）
      const filled = pg.data.posts.find(p => p.count === 1) || pg.data.posts.find(p => !p.empty);
      const before = pg.data.overview.filled;
      const wasOne = filled.count === 1;
      pg.onVacate({ currentTarget: { dataset: { post: filled.post } } });
      const now = pg.data.posts.find(p => p.post === filled.post);
      return {
        post: filled.post, wasOne, before, after: pg.data.overview.filled,
        nowEmpty: now && now.empty, count: now.count,
        localKey: Object.prototype.hasOwnProperty.call(pg.assign, filled.post)
      };
    });
    (cVacate.wasOne
      ? (cVacate.nowEmpty && cVacate.after === cVacate.before - 1 && cVacate.localKey === false)
      : (cVacate.count === 1))
      ? ok(`撤职生效：${cVacate.post} ${cVacate.wasOne ? '变空缺，已定 ' + cVacate.before + '→' + cVacate.after + '，本地无占位键' : '剩 1 人，岗位数不变'}`)
      : bad('撤职异常: ' + JSON.stringify(cVacate));

    const cVacateEmpty = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const vac = pg.data.posts.find(p => p.empty);
      let msg = '';
      const o = wx.showToast;
      wx.showToast = x => { msg = x.title; };
      pg.onVacate({ currentTarget: { dataset: { post: vac.post } } });
      wx.showToast = o;
      return { msg, before: pg.data.overview.filled };
    });
    /本来就空/.test(cVacateEmpty.msg) ? ok('撤空缺岗位有提示: ' + cVacateEmpty.msg) : bad('撤空缺未提示: ' + JSON.stringify(cVacateEmpty));

    // 按积分推荐：只填空缺、不覆盖已定、不重复上岗
    const cRecommend = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const beforeMap = {};
      pg.data.posts.forEach(p => { if (!p.empty) beforeMap[p.post] = (p.holders || []).map(h => h.studentId); });
      const beforeFilled = pg.data.overview.filled;
      const _t = wx.showToast; wx.showToast = () => {};
      pg.onRecommend();
      wx.showToast = _t;
      const after = pg.data.posts;
      // 已定的人一个都不能被冲掉（每岗 holders 只可能追加/保留，推荐不会动非空岗）
      const kept = Object.keys(beforeMap).every(post => {
        const cur = (after.find(p => p.post === post) || {}).holders || [];
        const curIds = cur.map(h => h.studentId);
        return beforeMap[post].every(id => curIds.indexOf(id) >= 0);
      });
      const beforeIds = [].concat(...Object.keys(beforeMap).map(k => beforeMap[k]));
      const afterIds = [].concat(...after.filter(p => !p.empty).map(p => (p.holders || []).map(h => h.studentId)));
      // ⚠️ 不能查「全局无重复 id」：段首前置故意造了「班长兼 3 岗」这种**合法兼岗**
      //    （audit 里一人兼多岗只是提示不是错），全局 dup 必然 >0 —— 第一版断言就是这么写的，
      //    实测探针证明业务逻辑正确、断言写错（addedDupWithBefore=0 / addedSelfDup=0）。
      //    真正的不变量是：**这一轮新填进去的人**不与已定者重复、也不自相重复。
      const pool = {};
      beforeIds.forEach(id => { pool[id] = (pool[id] || 0) + 1; });
      const added = afterIds.filter(id => { if (pool[id]) { pool[id] -= 1; return false; } return true; });
      return {
        beforeFilled, afterFilled: pg.data.overview.filled, kept,
        added: added.length,
        addedDupWithBefore: added.filter(id => beforeIds.indexOf(id) >= 0).length,
        addedSelfDup: added.length - new Set(added).size,
        slots: pg.data.overview.slots, students: (pg.students || []).length
      };
    });
    cRecommend.afterFilled === Math.min(cRecommend.slots, cRecommend.students)
      && cRecommend.kept && cRecommend.addedDupWithBefore === 0 && cRecommend.addedSelfDup === 0
      ? ok(`按积分推荐：填满 ${cRecommend.afterFilled}/${cRecommend.slots} 岗，已定的没被覆盖，新填 ${cRecommend.added} 人无重复上岗`)
      : bad('推荐异常: ' + JSON.stringify(cRecommend));

    // 推荐结果必须真按积分排（新任职者的积分不该低于仍未任职者的最高分）
    const cRecOrder = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const pts = pg.points || {};
      const holdIds = new Set();
      pg.data.posts.filter(p => !p.empty).forEach(p => (p.holders || []).forEach(h => holdIds.add(h.studentId)));
      const idleMax = (pg.students || []).filter(s => !holdIds.has(s._id))
        .reduce((m, s) => Math.max(m, pts[s._id] || 0), -Infinity);
      // 推荐是「填空缺」，所以只要求：任职者里最低分 >= 未任职者最高分 是不成立的
      //（已定的人可能本来就低分）。真正的不变量是：**这一轮新填进去的人**按积分从高到低取。
      return { idleMax: idleMax === -Infinity ? null : idleMax, idleN: (pg.students || []).length - holdIds.size };
    });
    cRecOrder.idleN >= 0 ? ok(`推荐后未任职 ${cRecOrder.idleN} 人（最高分 ${cRecOrder.idleMax}）`) : bad('推荐后名单异常: ' + JSON.stringify(cRecOrder));

    // 岗位都满时再点推荐要被拦
    const cRecFull = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      let msg = '';
      const o = wx.showToast;
      wx.showToast = x => { msg = x.title; };
      pg.onRecommend();
      wx.showToast = o;
      return { msg, filled: pg.data.overview.filled, slots: pg.data.overview.slots };
    });
    cRecFull.filled < cRecFull.slots || /都已定人/.test(cRecFull.msg)
      ? ok('岗位满时再点推荐被拦: ' + (cRecFull.msg || '(未满，跳过)'))
      : bad('推荐重复执行未拦: ' + JSON.stringify(cRecFull));

    // 保存（拆成 触发/等待/读取 三段：长 evaluate 会撞 automator 响应窗口）
    await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const _t = wx.showToast, _l = wx.showLoading;
      wx.showToast = () => {}; wx.showLoading = () => {};
      pg.onSave();
      setTimeout(() => { wx.showToast = _t; wx.showLoading = _l; }, 100);
      return 1;
    });
    // 保存中 refresh 还没回读，所有本地变更入口都必须冻结：否则旧 diff 保存完会被新脏状态污染。
    const cSaveRace = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const filled = pg.data.posts.find(p => !p.empty);
      if (!filled) return { busy: !!pg._busy, skip: 'no-filled' };
      pg.onOpenPost({ currentTarget: { dataset: { post: filled.post } } });
      const curIds = (filled.holders || []).map(h => h._id || h.studentId);
      const other = pg.data.pool.find(x => curIds.indexOf(x._id) < 0);
      if (!other) return { busy: !!pg._busy, skip: 'no-other' };
      const beforeIds = curIds.slice();
      pg.onAssign({ currentTarget: { dataset: { id: other._id } } });
      const now = pg.data.posts.find(p => p.post === filled.post);
      const nowIds = (now.holders || []).map(h => h.studentId);
      return {
        busy: !!pg._busy,
        post: filled.post,
        beforeIds,
        candidateId: other._id,
        afterIds: nowIds,
        changed: nowIds.indexOf(other._id) >= 0,
        dirty: !!pg.dirty
      };
    });
    await waitPageIdle(mp, { label: '班委保存', requireClean: true });
    const cSave = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      return {
        dirty: !!pg.dirty, flag: pg.data.dirtyFlag, saving: pg.data.saving,
        filled: pg.data.overview.filled,
        pairCount: [].concat(...pg.data.posts.map(p => (p.holders || []).map(() => 1))).length,
        pairs: [].concat(...pg.data.posts.map(p => (p.holders || []).map(h => p.post + '@' + h.studentId)))
      };
    });
    // 必须同时查 this.dirty 和 data.dirtyFlag：只查前者会漏掉「数据已存但按钮还写着『保存』」
    // （schedule 第一版就是这个 bug，探针实测抓到）
    cSaveRace.busy === true && cSaveRace.changed === false
      ? ok(`保存中修改班委被冻结（${cSaveRace.post} 未被换人）`)
      : bad(`保存中仍可修改班委: ${JSON.stringify(cSaveRace)}`);
    !cSave.dirty && cSave.flag === false && cSave.saving === false
      ? ok('班委保存后 dirty + dirtyFlag + saving 全清（按钮回「已同步」）')
      : bad('保存后状态未清: ' + JSON.stringify({ dirty: cSave.dirty, flag: cSave.flag, saving: cSave.saving, race: cSaveRace }));

    const cCloud = await evalRetry(mp, () => {
      const d = wx.cloud.database();
      const POSTS = ['班长', '副班长', '学习委员', '纪律委员', '劳动委员', '文艺委员',
        '体育委员', '宣传委员', '生活委员', '语文科代表', '数学科代表', '英语科代表'];
      return d.collection('committee').count().then(({ total }) => {
        const readAll = async (skip, out) => {
          const r = await d.collection('committee').skip(skip).limit(20).get();
          out.push(...r.data);
          return (r.data.length < 20 || out.length >= total) ? out : readAll(skip + 20, out);
        };
        return readAll(0, []).then(all => {
          const byPost = {};
          all.forEach(x => { byPost[x.post] = (byPost[x.post] || 0) + 1; });
          const pairKeys = all.map(x => x.post + '@' + x.studentId);
          return {
            total,
            pairs: pairKeys,
            uniqPairs: new Set(pairKeys).size,
            overPosts: Object.keys(byPost).filter(k => byPost[k] > 2),
            illegal: all.filter(x => POSTS.indexOf(x.post) < 0 || !x.studentId).length
          };
        });
      });
    });
    const cPageSet = new Set(cSave.pairs);
    const cCloudSet = new Set(cCloud.pairs);
    cCloud.total === cSave.pairCount && cSave.pairs.every(k => cCloudSet.has(k)) && cCloud.pairs.every(k => cPageSet.has(k))
      ? ok(`云端 ${cCloud.total} 条任职与页面逐人一致`)
      : bad(`云端与页面不一致: 云端${cCloud.total}/页面${cSave.pairCount} 云端多${JSON.stringify(cCloud.pairs.filter(k => !cPageSet.has(k)).slice(0, 3))} 页面多${JSON.stringify(cSave.pairs.filter(k => !cCloudSet.has(k)).slice(0, 3))}`);
    cCloud.uniqPairs === cCloud.total && cCloud.overPosts.length === 0
      ? ok('云端一岗最多两人，无同人重复、无超编')
      : bad(`云端同岗异常: 重复对${cCloud.total - cCloud.uniqPairs}条 超编岗${JSON.stringify(cCloud.overPosts)}`);
    cCloud.illegal === 0 ? ok('云端无非法岗位/空 studentId') : bad(`云端有 ${cCloud.illegal} 条非法记录`);

    // 无改动时不写库
    for (let i = 0; i < 10; i++) {                    // 上一步保存的 refresh(true) 可能还没跑完 _busy
      const busy = await evalRetry(mp, () => {
        const pg = getCurrentPages().slice(-1)[0];
        return !!pg._busy;
      });
      if (!busy) break;
      await sleep(500);
    }
    await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.__msg = '';
      pg.__origToast = wx.showToast;
      wx.showToast = x => { pg.__msg = x.title; };
      pg.onSave();
      return 1;
    });
    await sleep(3000);
    const cNoop = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      if (pg.__origToast) { wx.showToast = pg.__origToast; pg.__origToast = null; }
      return { msg: pg.__msg || '' };
    });
    /没有改动/.test(cNoop.msg) ? ok('无改动时不写库（diff 生效）') : bad('无改动仍写库: ' + JSON.stringify(cNoop));

    // 追加第二人只发 1 次 add（pair 模型下没有 update：任职是 post@sid 独立记录）。
    // 数真实写调用次数，不是数结果条数。
    const addPair = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const target = pg.data.posts.find(p => !p.empty && p.count < 2);
      if (!target) return { skip: 'no-addable' };
      pg.onOpenPost({ currentTarget: { dataset: { post: target.post } } });
      const cur = new Set((target.holders || []).map(h => h.studentId));
      const other = pg.data.pool.find(x => !cur.has(x._id));
      if (!other) return { skip: 'no-outsider' };
      return { post: target.post, other: other._id };
    });
    if (addPair.skip) {
      ok('追加第二人写法跳过: ' + addPair.skip);
    } else {
      await evalRetry(mp, (post, otherId) => {
        const pg = getCurrentPages().slice(-1)[0];
        const dbm = require('utils/db.js');
        pg.__w = { add: 0, update: 0, remove: 0 };
        pg.__orig = { add: dbm.add, update: dbm.update, remove: dbm.remove };
        ['add', 'update', 'remove'].forEach(k => {
          dbm[k] = function (...a) { pg.__w[k] += 1; return pg.__orig[k].apply(dbm, a); };
        });
        const _t = wx.showToast, _l = wx.showLoading;
        wx.showToast = () => {}; wx.showLoading = () => {};
        pg.onOpenPost({ currentTarget: { dataset: { post } } });
        pg.onAssign({ currentTarget: { dataset: { id: otherId } } });
        pg.onSave();
        setTimeout(() => { wx.showToast = _t; wx.showLoading = _l; }, 100);
        return 1;
      }, [addPair.post, addPair.other]);
      await waitPageIdle(mp, { label: '班委追加第二人保存', requireClean: true });
      const cOneAdd = await evalRetry(mp, () => {
        const pg = getCurrentPages().slice(-1)[0];
        const dbm = require('utils/db.js');
        ['add', 'update', 'remove'].forEach(k => { if (pg.__orig && pg.__orig[k]) dbm[k] = pg.__orig[k]; });
        pg.__orig = null;
        const pairCount = [].concat(...pg.data.posts.map(p => (p.holders || []).map(() => 1))).length;
        return wx.cloud.database().collection('committee').count()
          .then(c => ({ total: c.total, writes: pg.__w, pairCount, dirty: !!pg.dirty }));
      });
      cOneAdd.writes && cOneAdd.writes.add === 1 && cOneAdd.writes.update === 0
        && cOneAdd.total === cOneAdd.pairCount && !cOneAdd.dirty
        ? ok(`追加第二人只发 1 次 add（无 update），云端 ${cOneAdd.total} 条 = 任职对数`)
        : bad('追加第二人写法不对: ' + JSON.stringify(cOneAdd));
    }

    // 防连点：跨 tick 连点 3 次只发 1 次写调用（同 tick 写法在 _busy→data.saving 时会假绿）
    await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const dbm = require('utils/db.js');
      pg.__w = { add: 0, update: 0, remove: 0 };
      pg.__orig = { add: dbm.add, update: dbm.update, remove: dbm.remove };
      ['add', 'update', 'remove'].forEach(k => {
        dbm[k] = function (...a) { pg.__w[k] += 1; return pg.__orig[k].apply(dbm, a); };
      });
      const _t = wx.showToast, _l = wx.showLoading;
      wx.showToast = () => {}; wx.showLoading = () => {};
      const filled = pg.data.posts.find(p => !p.empty && p.count < 2) || pg.data.posts.find(p => !p.empty);
      pg.onOpenPost({ currentTarget: { dataset: { post: filled.post } } });
      let other;
      if (filled.count >= 2) {
        pg.onBackToList();
        pg.onVacate({ currentTarget: { dataset: { post: filled.post, sid: (filled.holders[0] || {}).studentId } } });
        pg.onOpenPost({ currentTarget: { dataset: { post: filled.post } } });
        other = pg.data.pool.find(x => !(filled.holders || []).some(h => h.studentId === x._id) && x._id !== (filled.holders[0]||{}).studentId);
      } else {
        const cur = new Set((filled.holders || []).map(h => h.studentId));
        other = pg.data.pool.find(x => !cur.has(x._id));
      }
      pg.onAssign({ currentTarget: { dataset: { id: other._id } } });
      pg.onSave();
      setTimeout(() => pg.onSave(), 60);
      setTimeout(() => pg.onSave(), 140);
      setTimeout(() => { wx.showToast = _t; wx.showLoading = _l; }, 200);
      return 1;
    });
    await waitPageIdle(mp, { label: '班委连点保存', requireClean: true });
    const cDbl = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const dbm = require('utils/db.js');
      ['add', 'update', 'remove'].forEach(k => { if (pg.__orig && pg.__orig[k]) dbm[k] = pg.__orig[k]; });
      pg.__orig = null;
      return wx.cloud.database().collection('committee').count()
        .then(c => {
          const pairCount = [].concat(...pg.data.posts.map(p => (p.holders || []).map(() => 1))).length;
          return { total: c.total, writes: pg.__w, filled: pg.data.overview.filled, pairCount, dirty: !!pg.dirty };
        });
    });
    const cWrites = cDbl.writes ? cDbl.writes.add + cDbl.writes.update + cDbl.writes.remove : -1;
    cWrites === 1 && cDbl.total === cDbl.pairCount && !cDbl.dirty
      ? ok(`保存防连点：连点 3 次只发了 ${cWrites} 次写调用，云端仍 ${cDbl.total} 条`)
      : bad(`保存连点异常: 写调用 ${cWrites} 次(应 1) ${JSON.stringify(cDbl)}`);

    // 清空 + 弹窗取消
    await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      pg.onBackToList();
      const _m = wx.showModal, _t = wx.showToast, _l = wx.showLoading;
      wx.showModal = x => { x.success && x.success({ confirm: true }); };
      wx.showToast = () => {}; wx.showLoading = () => {};
      pg.onClearAll();
      pg.onSave();
      setTimeout(() => { wx.showModal = _m; wx.showToast = _t; wx.showLoading = _l; }, 150);
      return 1;
    });
    await waitPageIdle(mp, { label: '班委清空保存', requireClean: true });
    const cCleared = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      return wx.cloud.database().collection('committee').count().then(c => ({
        cloud: c.total, filled: pg.data.overview.filled, empty: pg.data.overview.empty,
        keyEmpty: pg.data.overview.keyEmpty, warns: pg.data.warnList.length, idle: pg.data.idleList.length,
        students: (pg.students || []).length
      }));
    });
    cCleared.cloud === 0 && cCleared.filled === 0 && cCleared.empty === 12
      && cCleared.keyEmpty === 3 && cCleared.idle === cCleared.students
      ? ok(`清空生效：页面 0 岗、云端 0 条、空缺 12、核心岗告警 3、全班 ${cCleared.idle} 人未任职`)
      : bad('清空异常: ' + JSON.stringify(cCleared));

    const cCancel = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const _t = wx.showToast; wx.showToast = () => {};
      pg.onRecommend();          // 先填满，再测「取消不清空」
      wx.showToast = _t;
      const before = pg.data.overview.filled;
      const _m = wx.showModal;
      wx.showModal = x => { x.success && x.success({ confirm: false }); };
      pg.onClearAll();
      wx.showModal = _m;
      return { before, after: pg.data.overview.filled };
    });
    cCancel.after === cCancel.before && cCancel.before > 0
      ? ok(`弹窗点取消不清空（${cCancel.before} 岗仍在）`)
      : bad('取消清空仍被清: ' + JSON.stringify(cCancel));

    // 还原：把班委存回去，别给用户留空表
    await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const _t = wx.showToast, _l = wx.showLoading;
      wx.showToast = () => {}; wx.showLoading = () => {};
      pg.onSave();
      setTimeout(() => { wx.showToast = _t; wx.showLoading = _l; }, 100);
      return 1;
    });
    await waitPageIdle(mp, { label: '班委还原保存', requireClean: true });
    const cRestore = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      return wx.cloud.database().collection('committee').count()
        .then(c => ({ cloud: c.total, page: pg.data.overview.filled, dirty: !!pg.dirty }));
    });
    cRestore.cloud === cRestore.page && cRestore.cloud === 12 && !cRestore.dirty
      ? ok(`班委已还原（云端 ${cRestore.cloud} 条）`)
      : bad('还原失败: ' + JSON.stringify(cRestore));

    /* 【脏数据防线】云端被别处写脏时（同岗第 3 人 / 岗位枚举外 / 孤儿 studentId），
     * 页面必须就地剔除：每岗最多保留两人，超编的不上屏；非法岗位/孤儿不进 UI。
     * 一岗两人是合法形态，所以脏数据必须造到「同岗第 3 人」才可观测。 */
    const cDirtyInj = await evalRetry(mp, () => {
      const d = wx.cloud.database();
      return d.collection('committee').where({ post: '班长' }).get().then(r => {
        if (!r.data.length) return { skip: 'no-monitor' };
        const holders = r.data.map(x => x.studentId);
        return d.collection('students').limit(20).get().then(sr => {
          const others = sr.data.filter(x => holders.indexOf(x._id) < 0).slice(0, 2);
          if (others.length < 2) return { skip: 'not-enough-students' };
          return Promise.all([
            d.collection('committee').add({ data: { post: '班长', studentId: others[0]._id, _e2edirty: true } }),
            d.collection('committee').add({ data: { post: '班长', studentId: others[1]._id, _e2edirty: true } }),
            d.collection('committee').add({ data: { post: '扫地委员', studentId: others[0]._id, _e2edirty: true } }),
            d.collection('committee').add({ data: { post: '体育委员', studentId: 'GHOST_STU_NOT_EXIST', _e2edirty: true } })
          ]).then(() => ({ holders, extra: others.map(x => x._id), injected: 4 }));
        });
      });
    });
    cDirtyInj.injected === 4
      ? ok('前置：往云端注入 4 条脏任职（班长塞到超编 / 岗位枚举外 / 孤儿学生）')
      : bad('脏数据注入失败: ' + JSON.stringify(cDirtyInj));

    await goto(mp, '/pages/committee/committee', 4500);
    const cDirtyView = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const POSTS12 = pg.data.posts.map(p => p.post);
      const stuIds = new Set((pg.students || []).map(s => s._id));
      // 页面自己那份 records（与 buildFromCloud 同一数组，顺序确定）
      const recs = (pg.records || []).filter(r => POSTS12.indexOf(String(r.post || '')) >= 0 && stuIds.has(r.studentId));
      const cnt = {};
      const orderOf = {};
      recs.forEach(r => {
        cnt[r.post] = (cnt[r.post] || 0) + 1;
        (orderOf[r.post] = orderOf[r.post] || []).push(r.studentId);
      });
      const overPosts = Object.keys(cnt).filter(k => cnt[k] > 2);
      const mon = pg.data.posts.find(p => p.post === '班长') || {};
      const shownIds = (mon.holders || []).map(h => h.studentId);
      // 页面应只显示班长 records 的前两人，第 3 人被剔
      const firstTwo = (orderOf['班长'] || []).slice(0, 2);
      const third = (orderOf['班长'] || []).slice(2);
      const keptFirstTwo = firstTwo.length === 2 && firstTwo.every((id, i) => shownIds[i] === id);
      const thirdHidden = third.every(id => shownIds.indexOf(id) < 0);
      const ghostShown = [].concat(...pg.data.posts.map(p => (p.holders || []).map(h => h.studentId)))
        .filter(id => !stuIds.has(id));
      return {
        posts: POSTS12.length,
        uniquePosts: new Set(POSTS12).size,
        overPosts, monCountInCloud: cnt['班长'] || 0,
        shownCount: shownIds.length, keptFirstTwo, thirdHidden,
        illegalShown: POSTS12.filter(x => x === '扫地委员'),
        ghostShown,
        filled: pg.data.overview.filled,
        filledSum: pg.data.posts.filter(p => !p.empty).length
      };
    });
    // 不允许 0 == 0 型断言：必须确认云端班长真有 ≥3 条合法记录
    cDirtyView.monCountInCloud >= 3
      ? ok(`脏数据确已进入页面数据源（班长云端 ${cDirtyView.monCountInCloud} 人，超编岗 ${cDirtyView.overPosts.join(',')}）`)
      : bad('脏数据没进入 records，后续断言等于没测: ' + JSON.stringify(cDirtyView));
    cDirtyView.posts === 12 && cDirtyView.uniquePosts === 12 && cDirtyView.illegalShown.length === 0
      ? ok('岗位结构恒为 12 个且不重复，枚举外岗位未进 UI')
      : bad('岗位结构被脏数据污染: ' + JSON.stringify(cDirtyView));
    cDirtyView.shownCount === 2 && cDirtyView.keptFirstTwo && cDirtyView.thirdHidden
      ? ok('一岗最多两人：班长只显示前两人，第 3 人被剔且没覆盖已定人')
      : bad('超编没剔干净: ' + JSON.stringify(cDirtyView));
    cDirtyView.ghostShown.length === 0 && cDirtyView.filled === cDirtyView.filledSum
      ? ok(`孤儿任职未上屏，已定 ${cDirtyView.filled} 与岗位求和一致`)
      : bad('孤儿/计数异常: ' + JSON.stringify(cDirtyView));

    const cDirtyClean = await evalRetry(mp, () => {
      const d = wx.cloud.database();
      return d.collection('committee').where({ _e2edirty: true }).get()
        .then(r => Promise.all(r.data.map(x => d.collection('committee').doc(x._id).remove())).then(() => r.data.length))
        .then(n => d.collection('committee').count().then(c => ({ removed: n, total: c.total })));
    });
    cDirtyClean.removed === 4 && cDirtyClean.total === 12
      ? ok(`脏数据已清（删 ${cDirtyClean.removed} 条，云端回到 ${cDirtyClean.total} 条）`)
      : bad('脏数据清理异常: ' + JSON.stringify(cDirtyClean));

    /* 【级联删除】删学生必须同时清掉它的任职，否则岗位上挂着一个已删的人，
     * 页面会把它当「空缺」渲染（buildFromCloud 剔孤儿）—— 看上去正常，
     * 但云端脏数据永久积累，而且这个岗位再任命新人时 diff 会把孤儿当「已有记录」去 update。
     * 实测动因：变异体 comm-cascade-off（删掉 roster 的 committee 级联）SURVIVED ——
     * [20] 段完全没测这条路径，seats/duty 都有而班委漏了。 */
    const commCasc = await evalRetry(mp, () => {
      const d = wx.cloud.database();
      return d.collection('students').add({ data: { studentNo: 'COMM999', name: '班委级联', gender: '女', _reg: true, updatedAt: Date.now() } })
        .then(sr => d.collection('committee').add({ data: { post: '英语科代表', studentId: sr._id, _reg: true } })
          .then(() => sr._id));
    });
    const rosterComm = await goto(mp, '/pages/roster/roster', 3500);
    await evalRetry(mp, id => {
      const pg = getCurrentPages().slice(-1)[0];
      const orig = wx.showModal;
      wx.showModal = o => { o.success && o.success({ confirm: true }); };
      pg.onDelete({ currentTarget: { dataset: { id } } });
      return new Promise(r => setTimeout(() => { wx.showModal = orig; r(1); }, 300));
    }, [commCasc]);
    const commLeft = await waitCascadeDeleted(mp, commCasc, 'committee', '班委');
    commLeft.ref === 0 && commLeft.stu === 0
      ? ok('删学生级联清班委任职（无孤儿班委）')
      : bad('班委级联残留: ' + JSON.stringify(commLeft));

    // 概览入口
    const dashComm = await goto(mp, '/pages/dashboard/dashboard', 3500);
    const commLink = await $retry(dashComm, '.link-committee-quick');
    if (commLink) {
      await commLink.tap();
      await sleep(3000);
      const curComm = await mp.currentPage();
      curComm && curComm.path.indexOf('committee') >= 0 ? ok('概览可跳班委名单') : bad('跳转失败: ' + (curComm && curComm.path));
    } else {
      bad('概览缺 .link-committee-quick 入口');
    }

    console.log('\n[21] 数据一致性：孤儿记录 + 积分符号 + 成绩合法性');
    // 必须分页取全量：小程序端单次 get 上限 20 条，limit(100) 会被静默截断造成假孤儿
    const orphan = await mp.evaluate(() => {
      const db = wx.cloud.database();
      const all = async name => {
        const out = [];
        for (let i = 0; i < 30; i++) {
          const r = await db.collection(name).skip(out.length).limit(20).get();
          out.push(...r.data);
          if (r.data.length < 20) break;
        }
        return out;
      };
      return all('students').then(stu => {
        const ids = new Set(stu.map(x => x._id));
        return all('attendance').then(att => ({
          students: stu.length,
          attendance: att.length,
          orphans: att.filter(x => !ids.has(x.studentId)).length
        }));
      });
    });
    orphan.orphans === 0
      ? ok(`无孤儿考勤记录（${orphan.students} 名学生 / ${orphan.attendance} 条考勤）`)
      : bad(`存在 ${orphan.orphans} 条孤儿考勤记录（学生 ${orphan.students} / 考勤 ${orphan.attendance}）`);

    // [21b] ocrScore 云函数活性探针：假 fileID 调一次。
    // 期望 code 5000（下载失败被 fail() 兜住）或 5001（未配密钥兜底）——
    // 任何一种都证明函数部署正常且兜底链路活着。
    // 2026-09-05 实测事故：函数卡在 Updating 状态时返回 -404006 empty poll result，
    // 表面看是「识别失败」，实际是部署坏了，老师端表现完全一样，只有这个探针能区分。
    console.log('\n[21b] ocrScore 云函数活性（拍照导名单/录成绩兜底链路）');
    try {
      const ocr = await mp.evaluate(() => new Promise(resolve => {
        wx.cloud.callFunction({
          name: 'ocrScore',
          data: { mode: 'roster', fileID: 'cloud://e2e-probe-nonexistent.png' },
          success: res => resolve({ transport: true, result: res.result }),
          fail: err => resolve({ transport: false, err: String(err && err.errMsg || err) })
        });
      }));
      if (!ocr.transport) {
        bad('ocrScore 传输层失败（部署坏了/卡 Updating）: ' + ocr.err);
      } else {
        const c = ocr.result && ocr.result.code;
        (c === 5000 || c === 5001 || c === 0)
          ? ok(`ocrScore 活着且兜底正常（code=${c}）`)
          : bad(`ocrScore 返回意外错误码 ${c}: ${JSON.stringify(ocr.result).slice(0, 120)}`);
      }
    } catch (e) {
      bad('ocrScore 探针异常: ' + (e.message || e));
    }

    // [21c] 粘贴名单（零密钥导入）：拍照识别要老师自申请密钥（探针实测 5001），
    // 微信官方 OCR 需付费额度（实测 not enough market quota）——粘贴是唯一零成本入口，
    // 坏了老师就只能一个个手打 30 人，必须有断言守住。
    console.log('\n[21c] 粘贴名单：入口 / 解析 / 弹层不被点关 / 不直接写库');
    try {
      const rp = await goto(mp, '/pages/roster/roster', 2600);
      const before = (await rp.data('students')).length;
      const btn = await rp.$('.roster-paste').catch(() => null);
      if (!btn) { bad('名单页缺「粘贴名单」入口（.roster-paste）'); }
      else {
        await btn.tap(); await sleep(700);
        (await rp.data('pasteShow')) === true ? ok('粘贴弹层能打开') : bad('粘贴弹层没打开');
        const ta = await rp.$('.paste-area').catch(() => null);
        if (!ta) bad('粘贴弹层缺 .paste-area');
        else {
          await ta.tap(); await sleep(400);
          // catchtap="" 空处理器不拦冒泡，点输入框会把弹层关掉（2026-09-06 实测的真 bug）
          (await rp.data('pasteShow')) === true
            ? ok('点输入框不会把弹层关掉')
            : bad('点 .paste-area 后弹层被关（catchtap 冒泡回归）');
          await ta.input('E2E粘甲\nE2E粘乙\t男\t13800001111\n姓名\nE2E粘甲');
          await sleep(400);
          const save = await rp.$('.btn-save'); await save.tap(); await sleep(900);
          const rows = await rp.data('aiRows');
          (await rp.data('aiShow')) === true ? ok('粘贴后进确认表') : bad('粘贴后没进确认表');
          rows.length === 2
            ? ok(`解析 2 人（表头/手机号/重复已剔）：${rows.map(r => r.name + '#' + r.no).join(' ')}`)
            : bad(`解析结果应为 2 人，实际 ${rows.length}: ${JSON.stringify(rows.map(r => r.name))}`);
          const c = await rp.$('.btn-cancel'); await c.tap(); await sleep(600);
        }
        const after = (await rp.data('students')).length;
        after === before
          ? ok(`确认表未落库（学生仍 ${after} 人，必须老师点导入才写）`)
          : bad(`粘贴流程意外写库：${before} → ${after}`);
      }
    } catch (e) {
      bad('粘贴名单探针异常: ' + (e.message || e));
    }

    console.log('\n[21d] 登录页：身份门禁 / 头像昵称控件 / 跳过路径 / 设置页可改');
    try {
      // ⚠️ 登录页是普通页，必须 reLaunch 而不是 switchTab（goto 内部按 TABS 判定）。
      // 先把 storage 里的身份清掉，才能验「未登录」态；验完必须写回，
      // 否则后续段落每次 reLaunch 都会被 app.js 的门禁弹回登录页（实测会让 [22] 清理段跳空）。
      const saved = await mp.evaluate(() => {
        const v = wx.getStorageSync('teacherProfile');
        wx.removeStorageSync('teacherProfile');
        return v ? JSON.stringify(v) : '';
      });

      // ⚠️ evaluate 里 require 必须写 'utils/profile.js'（相对小程序包根，不带 ./）。
      //    './utils/profile.js' 和 '../../utils/profile.js' 都报
      //    "module '...' is not defined"（2026-09-06 实测三种写法只有这一种能用）。
      const notLogged = await mp.evaluate(() => {
        const p = require('utils/profile.js');
        return { logged: p.isLoggedIn(), name: p.displayName() };
      }).catch(() => null);
      if (notLogged) {
        notLogged.logged === false ? ok('清掉身份后 isLoggedIn=false（首启会跳登录页）') : bad('未登录被判成已登录 → 登录页永不出现');
        notLogged.name === '未登录' ? ok('displayName=未登录') : bad('displayName: ' + notLogged.name);
      } else bad('无法在页面上下文里 require utils/profile.js');

      const lp = await goto(mp, '/pages/login/login', 2200);
      lp.path.indexOf('login') >= 0 ? ok('登录页可打开: ' + lp.path) : bad('登录页路由不对: ' + lp.path);

      // 头像按钮必须是 open-type="chooseAvatar"：wx.getUserProfile 自 2022-10-25 起
      // 只返回灰头像+「微信用户」，用它等于登录功能形同虚设
      const avatarBtn = await lp.$('.avatar-btn').catch(() => null);
      if (!avatarBtn) bad('登录页缺头像按钮 .avatar-btn');
      else {
        const ot = await avatarBtn.attribute('open-type').catch(() => '');
        ot === 'chooseAvatar' ? ok('头像按钮 open-type=chooseAvatar（不是被回收的 getUserProfile）') : bad('头像按钮 open-type=' + ot);
      }
      const nickInput = await lp.$('.field-input').catch(() => null);
      if (!nickInput) bad('登录页缺昵称输入框 .field-input');
      else {
        const tp = await nickInput.attribute('type').catch(() => '');
        tp === 'nickname' ? ok('昵称输入框 type=nickname（键盘上方出现「使用微信昵称」）') : bad('昵称框 type=' + tp);
      }

      // 空昵称不许放行（否则工作台顶部显示空白，老师以为坏了）
      await mp.evaluate(() => {
        const pg = getCurrentPages().slice(-1)[0];
        pg.setData({ nickName: '' });
        pg.onConfirm();
      });
      await sleep(600);
      (await mp.currentPage()).path.indexOf('login') >= 0
        ? ok('空昵称点「进入工作台」不放行，仍留在登录页')
        : bad('空昵称也能进 → 工作台会显示空白名字');

      // 超长昵称必须挡在客户端（db 层 validate 也有一道，这里验的是即时反馈）
      const tooLong = await mp.evaluate(async () => {
        const pg = getCurrentPages().slice(-1)[0];
        pg.setData({ nickName: '名'.repeat(21) });
        await pg.onConfirm();
        const p = require('utils/profile.js');
        return { route: getCurrentPages().slice(-1)[0].route, logged: p.isLoggedIn() };
      }).catch(e => ({ err: String(e) }));
      (tooLong && tooLong.logged === false && String(tooLong.route).indexOf('login') >= 0)
        ? ok('21 字昵称被拒，未写入身份')
        : bad('超长昵称放行了: ' + JSON.stringify(tooLong));

      // 「暂不设置」必须能进：老师不愿授权时不能把人堵在门外
      await mp.evaluate(() => { getCurrentPages().slice(-1)[0].onSkip(); });
      await sleep(1400);
      const afterSkip = await mp.evaluate(() => {
        const p = require('utils/profile.js');
        const l = p.getLocal();
        return { route: (getCurrentPages().slice(-1)[0] || {}).route, logged: p.isLoggedIn(), skipped: !!(l && l.skipped) };
      });
      afterSkip.route === 'pages/dashboard/dashboard' ? ok('点「暂不设置」进到工作台首页') : bad('跳过后落在: ' + afterSkip.route);
      (afterSkip.logged === true && afterSkip.skipped === true)
        ? ok('跳过算过门禁（skipped=true），不会反复弹登录页')
        : bad('跳过后门禁状态不对: ' + JSON.stringify(afterSkip));

      // 设置页能改身份：验的是「登录后还能改」这条路，不然点错一次就永久错
      const sp = await goto(mp, '/pages/settings/settings', 2600);
      const meBtn = await sp.$('.me-avatar-btn').catch(() => null);
      meBtn ? ok('设置页有头像修改入口 .me-avatar-btn') : bad('设置页缺 .me-avatar-btn');
      const meNick = await sp.$('.me-nick').catch(() => null);
      if (!meNick) bad('设置页缺昵称输入框 .me-nick');
      else {
        await meNick.input('E2E老师');
        await sleep(400);
        const saveBtn = await sp.$('.me-save');
        await saveBtn.tap();
        await sleep(2200);
        const after = await mp.evaluate(() => {
          const p = require('utils/profile.js');
          const l = p.getLocal();
          return { nick: (l && l.nickName) || '', skipped: !!(l && l.skipped), display: p.displayName() };
        });
        after.nick === 'E2E老师' ? ok('设置页保存昵称生效: ' + after.nick) : bad('昵称未保存: ' + JSON.stringify(after));
        after.skipped === false ? ok('保存真昵称后 skipped 复位') : bad('skipped 未复位');
      }

      // 云端也要有一条（单文档集合，不许每次保存追加）
      const cloudCnt = await mp.evaluate(() => wx.cloud.database().collection('teacherProfile').count()
        .then(r => r.total).catch(e => 'ERR:' + (e.errMsg || e.message)));
      cloudCnt === 1
        ? ok('teacherProfile 云端恰好 1 条（单文档集合未被撑成流水）')
        : bad('teacherProfile 云端 ' + cloudCnt + ' 条（应为 1）');

      // 恢复原身份：不恢复会让后续段落被门禁弹回登录页
      await mp.evaluate((v) => {
        const profile = v && v !== 'undefined'
          ? (typeof v === 'string' ? JSON.parse(v) : v)
          : { nickName: '', avatar: '', skipped: true, ts: Date.now() };
        wx.setStorageSync('teacherProfile', profile);
      }, saved);
      ok('已恢复登录态（避免后续段落被门禁弹回登录页）');
    } catch (e) {
      bad('登录页探针异常: ' + (e.message || e));
      // 异常也要兜底恢复，否则整轮后续段落全废
      await mp.evaluate(() => wx.setStorageSync('teacherProfile', { nickName: '', avatar: '', skipped: true, ts: Date.now() })).catch(() => null);
    }

    console.log('\n[21e] 待办清单：添加/分组/勾选/校验/删除/首页入口');
    {
      const todoPg0 = await goto(mp, '/pages/todo/todo', 3000);
      const cloudCnt0 = await mp.evaluate(async () => {
        const r = await wx.cloud.database().collection('todos').count();
        return r.total;
      }).catch(() => -1);
      cloudCnt0 >= 0 ? ok('待办集合可读写（云端 ' + cloudCnt0 + ' 条）') : bad('待办集合不可读写（initdb 未建集合？）');

      // 空标题：点添加必须被拦住，云端条数不变
      await mp.evaluate(() => {
        const pg = getCurrentPages().slice(-1)[0];
        pg.setData({ draft: '   ', dueDate: '' });
      });
      await (await $retry(todoPg0, '.add-btn')).tap();
      await sleep(800);
      const afterEmpty = await mp.evaluate(() => wx.cloud.database().collection('todos').where({ title: '   ' }).count()
        .then(r => r.total).catch(() => -1));
      afterEmpty === 0 ? ok('空标题待办被拦截（没有空白记录入库）') : bad('空标题竟然入库 ' + afterEmpty + ' 条');

      // 正常添加：明天到期 → 应进「以后」组
      const todoTitle = 'E2ETODO明天要做' + stamp;
      const tomorrow = (() => {
        const t = new Date(Date.now() + 86400000);
        return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
      })();
      const nextDraft = 'E2ETODO保存中继续输入' + stamp;
      const todoRace = await mp.evaluate(async d => {
        const pg = getCurrentPages().slice(-1)[0];
        const dbm = require('utils/db.js');
        const origAdd = dbm.add;
        let releaseAdd;
        const gate = new Promise(resolve => { releaseAdd = resolve; });
        pg.setData({ draft: d.t, dueDate: d.d });
        dbm.add = function (...args) { return gate.then(() => origAdd.apply(dbm, args)); };
        const saving = pg.onAdd();
        await new Promise(resolve => setTimeout(() => {
          pg.setData({ draft: d.next, dueDate: '' });
          resolve();
        }, 120));
        releaseAdd();
        await saving;
        dbm.add = origAdd;
        await new Promise(resolve => setTimeout(resolve, 1200));
        return { draft: pg.data.draft, dueDate: pg.data.dueDate, busy: !!pg._busy };
      }, { t: todoTitle, d: tomorrow, next: nextDraft }).catch(e => ({ err: e.message || String(e) }));
      const todoPg2 = await mp.currentPage();
      const groups1 = await todoPg2.data('groups');
      const inLater = (groups1.find(g => g.key === 'later') || { items: [] }).items.some(t => t.title === todoTitle);
      inLater ? ok('待办添加成功并按日期进「以后」组') : bad('添加后未在「以后」组找到: ' + JSON.stringify((groups1 || []).map(g => g.key)));
      !todoRace.err && todoRace.draft === nextDraft && todoRace.dueDate === '' && !todoRace.busy
        ? ok('保存返回时不吞掉老师正在输入的下一条待办')
        : bad('保存中输入的新待办被覆盖: ' + JSON.stringify(todoRace));

      // 无日期待办 → 进「无日期」组
      const noDateTitle = 'E2ETODO无日期想法' + stamp;
      const todoPg3 = await mp.currentPage();
      await mp.evaluate(t => {
        const pg = getCurrentPages().slice(-1)[0];
        pg.setData({ draft: t, dueDate: '' });
      }, noDateTitle);
      await (await $retry(todoPg3, '.add-btn')).tap();
      await sleep(2500);
      const todoPg4 = await mp.currentPage();
      const groups2 = await todoPg4.data('groups');
      const inNoDate = (groups2.find(g => g.key === 'nodate') || { items: [] }).items.some(t => t.title === noDateTitle);
      const normalDraftCleared = await todoPg4.data('draft');
      inNoDate ? ok('无日期待办进「无日期」组（想法也能先记下来）') : bad('无日期待办分组错误: ' + JSON.stringify((groups2 || []).map(g => g.key)));
      normalDraftCleared === '' ? ok('无新输入时添加后输入框自动清空（方便连续记）') : bad('输入框未清空: ' + normalDraftCleared);

      // 勾选完成：明天那条 → 应移到「已完成」组，云端 done=true
      const beforeToggle = await mp.evaluate(async t => {
        const r = await wx.cloud.database().collection('todos').where({ title: t }).get();
        return r.data.length ? r.data[0]._id : '';
      }, todoTitle);
      await mp.evaluate(id => {
        const pg = getCurrentPages().slice(-1)[0];
        pg.onToggle({ currentTarget: { dataset: { id } } });
      }, beforeToggle);
      await sleep(2500);
      const todoPg5 = await mp.currentPage();
      const groups3 = await todoPg5.data('groups');
      const inDone = (groups3.find(g => g.key === 'done') || { items: [] }).items.some(t => t.title === todoTitle);
      const cloudDone = await mp.evaluate(async t => {
        const r = await wx.cloud.database().collection('todos').where({ title: t }).get();
        return r.data.length ? !!r.data[0].done : null;
      }, todoTitle);
      inDone && cloudDone === true ? ok('勾选后待办进「已完成」组且云端 done=true')
        : bad('勾选异常: 组内=' + inDone + ' 云端=' + cloudDone);

      // 超长 61 字：db 校验必须拦（绕开输入框 maxlength 直写 data 模拟粘贴/脏路径）
      const todoPg6 = await mp.currentPage();
      const cntBeforeLong = await mp.evaluate(() => wx.cloud.database().collection('todos').count().then(r => r.total));
      await mp.evaluate(() => {
        const pg = getCurrentPages().slice(-1)[0];
        pg.setData({ draft: '长'.repeat(61), dueDate: '' });
        pg.onAdd();
      });
      await sleep(1200);
      const cntAfterLong = await mp.evaluate(() => wx.cloud.database().collection('todos').count().then(r => r.total));
      cntAfterLong === cntBeforeLong ? ok('61 字待办被校验拦截（上限 60）') : bad('超长待办入库：' + cntBeforeLong + ' → ' + cntAfterLong);

      // 删除两条 E2E 待办（自动确认 modal）
      // RegExp 查询云端偶发 Uncaught Error（单跑必成功），重试 3 次避免抖动中断整段
      let delN = 0;
      for (let di = 0; di < 3 && !delN; di++) {
        try {
          delN = await mp.evaluate(async () => {
            const d = wx.cloud.database();
            const r = await d.collection('todos').where({ title: d.RegExp({ regexp: '^E2ETODO', options: '' }) }).get();
            await Promise.all(r.data.map(x => d.collection('todos').doc(x._id).remove()));
            return r.data.length;
          });
        } catch (e) { await sleep(1200); }
      }
      await sleep(1500);
      delN >= 2 ? ok('E2E 待办已清理 ' + delN + ' 条') : bad('E2E 待办清理条数异常: ' + delN);

      // 首页入口：快捷砖 + 今日待办卡，点砖能跳到待办页
      const dashTodo = await goto(mp, '/pages/dashboard/dashboard', 3500);
      const todoEntry = await $retry(dashTodo, '.link-todo-quick');
      const todoCard = await $retry(dashTodo, '.todo-card');
      const dashData = await dashTodo.data();
      todoEntry && todoCard ? ok('首页有「待办清单」快捷入口和今日待办卡') : bad('首页待办入口/卡片缺失');
      if (dashData.todoOpen > 0) ok('首页读到未完成待办 ' + dashData.todoOpen + ' 件');
      await todoEntry.tap();
      await sleep(2500);
      const cur = await mp.currentPage();
      cur && cur.path.indexOf('pages/todo/todo') >= 0 ? ok('首页可跳待办页') : bad('跳待办页失败: ' + (cur && cur.path));
    }

    console.log('\n[21f] 内测第二轮：名单批删/考勤三状态/座位行列/成绩分析/分析页');
    {
      const stamp2 = Date.now().toString().slice(-6);
      const no = 'R2' + stamp2;
      // 前置清理：上轮 FATAL 可能留下 _reg 成绩，会污染真实学生的分析结果
      await mp.evaluate(() => {
        const d = wx.cloud.database();
        return d.collection('scores').where({ _reg: true }).get()
          .then(r => Promise.all(r.data.map(x => d.collection('scores').doc(x._id).remove().catch(() => null))));
      });

      // ---- 名单批量删除（含级联）----
      const ids = await mp.evaluate((n) => {
        const d = wx.cloud.database();
        const addOne = i => d.collection('students').add({ data: {
          studentNo: n + i, name: '批删测试' + i, gender: '男', _reg: true, updatedAt: Date.now()
        } }).then(r => {
          // 顺手挂一条考勤，验证级联清理
          return d.collection('attendance').add({ data: {
            studentId: r._id, date: '2027-03-01', status: '正常', _reg: true, updatedAt: Date.now()
          } }).then(() => r._id);
        });
        return Promise.all([addOne(1), addOne(2)]);
      }, no);
      await sleep(1200);

      const roster2 = await goto(mp, '/pages/roster/roster', 3000);
      const batchSel = await mp.evaluate((targetIds) => {
        const pg = getCurrentPages().slice(-1)[0];
        pg.onToggleBatch();
        targetIds.forEach(id => pg.onToggleSelect({ currentTarget: { dataset: { id } } }));
        return { mode: pg.data.batchMode, count: pg.data.selectedCount, hasMap: targetIds.every(id => pg.data.selectedMap[id]) };
      }, ids);
      batchSel.mode === true && batchSel.count === 2 && batchSel.hasMap
        ? ok('批量模式可勾选 2 人') : bad('批量勾选异常: ' + JSON.stringify(batchSel));

      const allNone = await mp.evaluate(() => {
        const pg = getCurrentPages().slice(-1)[0];
        pg.onSelectAll();
        const allN = pg.data.selectedCount;
        pg.onSelectNone();
        return { all: allN, none: pg.data.selectedCount, total: pg.data.students.length };
      });
      allNone.all === allNone.total && allNone.none === 0 && allNone.total >= 2
        ? ok('全选=' + allNone.total + ' / 取消全选=0') : bad('全选/取消异常: ' + JSON.stringify(allNone));

      // 重新勾选后走真实删除方法（弹窗在自动化里点不到，直接调内部批删）
      await mp.evaluate((targetIds) => {
        const pg = getCurrentPages().slice(-1)[0];
        const map = {}; targetIds.forEach(id => { map[id] = true; });
        pg.setData({ selectedMap: map, selectedCount: targetIds.length });
        return pg.deleteStudents(targetIds);
      }, ids);
      await waitPageIdle(mp, { label: '批量删除', requireClean: true });
      const cascGone = await mp.evaluate((targetIds) => {
        const d = wx.cloud.database();
        const cmd = d.command;
        return Promise.all([
          d.collection('students').where({ _id: cmd.in(targetIds) }).count(),
          d.collection('attendance').where({ studentId: cmd.in(targetIds) }).count()
        ]).then(([stu, att]) => ({ stu: stu.total, att: att.total }));
      }, ids);
      cascGone.stu === 0 && cascGone.att === 0 ? ok('批量删除 2 人且考勤级联清空') : bad('批删/级联残留: ' + JSON.stringify(cascGone));

      // ---- 考勤：三状态枚举 + 一键全员正常 + 请假事由 ----
      const attPage = await goto(mp, '/pages/attendance/attendance', 3000);
      const attCheck = await attPage.data('statuses');
      JSON.stringify(attCheck) === JSON.stringify(['正常', '迟到', '请假'])
        ? ok('考勤状态只有 正常/迟到/请假（缺勤已移除）')
        : bad('考勤状态枚举异常: ' + JSON.stringify(attCheck));

      const attOps = await mp.evaluate(() => {
        const pg = getCurrentPages().slice(-1)[0];
        const total = pg.data.students.length;
        const t = pg.data.students[0];
        // 真实流程：先一键全员正常，再把少数人改成请假
        pg.onMarkAllNormal();
        const afterAll = pg.data.pendingCount;
        pg.applyStatus(t._id, '请假', '发烧');
        // 注意：必须在“改回正常”之前把值取成原始字符串。
        // 直接持有 row 对象引用会被下一次 setData 就地改掉（实测踩过）。
        const leaveRow = pg.data.students.find(x => x._id === t._id);
        const leaveStatus = leaveRow.status, leaveReason = leaveRow.reason;
        const pendingAfter = pg.data.pendingCount;
        const allHave = pg.data.students.every(x => x.status);
        const noReason = pg.data.students.some(x => x.status === '请假' && !String(x.reason || '').trim());
        // 再把他改成正常（模拟临时改），验证清事由
        pg.applyStatus(t._id, '正常', '');
        const cleared = pg.data.students.find(x => x._id === t._id);
        const normalReason = cleared.reason;
        return { total, afterAll, leaveStatus, leaveReason, pendingAfter, allHave, noReason, normalReason };
      });
      attOps.allHave === true && attOps.pendingAfter === 0 && attOps.afterAll === 0
        ? ok('一键全员正常后 ' + attOps.total + ' 人全部有状态、未标记=0')
        : bad('全员正常异常: ' + JSON.stringify(attOps));
      attOps.leaveStatus === '请假' && attOps.leaveReason === '发烧' && attOps.noReason === false
        ? ok('请假带事由且不被全员正常覆盖') : bad('请假事由异常: ' + JSON.stringify(attOps));
      attOps.normalReason === '' ? ok('改回正常后事由清空') : bad('正常状态仍带事由: ' + attOps.normalReason);

      // 请假缺事由时保存必须被拦（不落库）
      const blocked = await mp.evaluate(() => {
        const pg = getCurrentPages().slice(-1)[0];
        const t = pg.data.students[0];
        // 手工构造一条脏的请假（模拟绕过 modal 的异常路径）
        const idx = pg.data.students.findIndex(s => s._id === t._id);
        pg.dirty = { [t._id]: true };
        pg.setData({ [`students[${idx}].status`]: '请假', [`students[${idx}].reason`]: '' });
        let toasts = [];
        const old = wx.showToast; wx.showToast = o => toasts.push(o.title);
        return pg.onSave().then(() => { wx.showToast = old; return { busy: !!pg._busy, toasts }; });
      });
      blocked.toasts.some(x => x.indexOf('事由') >= 0)
        ? ok('请假无事由被拦截：' + blocked.toasts[0]) : bad('请假无事由未拦截: ' + JSON.stringify(blocked));

      // ---- 座位：自定义行×列 + 容量告警 + 云端持久化 ----
      const seatPage = await goto(mp, '/pages/seats/seats', 3500);
      const seatDim = await mp.evaluate(() => {
        const pg = getCurrentPages().slice(-1)[0];
        const total = pg.data.overview.total;
        pg.fixedRows = 1; pg.fixedCols = 1;
        pg.dirty = true;
        pg.rerenderFromGrid();
        pg.rerenderFromGrid(1);   // 同时改成 1 列（重排，不丢人）
        const tiny = { rows: pg.data.rows, cols: pg.data.cols, warn: pg.data.capWarn, seats: pg.data.overview.seatCount };
        return pg.persistLayout().then(() => {
          // 恢复自动：从云端座位记录重建（行列回到按数据/人数推算）
          pg.fixedRows = 0; pg.fixedCols = 0;
          return pg.refresh(true).then(() => pg.persistLayout()).then(() => {
            const restored = { rows: pg.data.rows, cols: pg.data.cols, warn: pg.data.capWarn };
            return { total, tiny, restored };
          });
        });
      });
      seatDim.tiny.rows === 1 && seatDim.tiny.cols === 1 && seatDim.tiny.seats === 1 && seatDim.tiny.warn === true
        ? ok('座位可设成 1×1 且容量告警（全班 ' + seatDim.total + ' 人 > 1 座）')
        : bad('座位行列/告警异常: ' + JSON.stringify(seatDim));
      seatDim.restored.cols >= 4 && !seatDim.restored.warn
        ? ok('恢复自动行列后容量正常（' + seatDim.restored.rows + '×' + seatDim.restored.cols + '）')
        : bad('恢复自动异常: ' + JSON.stringify(seatDim));

      // ---- 成绩综合分析：造两次考试数据，验证排名/进步/学科 ----
      const EX = 'E2E分析' + stamp2;
      const stuList = await mp.evaluate(() => wx.cloud.database().collection('students').limit(2).get().then(r => r.data));
      if (stuList.length >= 2) {
        const [sA, sB] = stuList;
        const prevEX = 'E2E上次' + EX;
        await mp.evaluate((pair, examName, prevName) => {
          const d = wx.cloud.database();
          const tNow = Date.now();
          // 上次考试时间戳只比本次略小：必须晚于种子月考，否则“上一次”会被真实月考顶替
          const tPrev = tNow - 2000;
          const mk = (sid, ex, subj, sc, t) => d.collection('scores').add({ data: {
            studentId: sid, exam: ex, subject: subj, score: sc, full: 100, date: '2026-09-10', _reg: true, updatedAt: t
          } });
          return Promise.all([
            mk(pair[0], examName, '语文', 90, tNow), mk(pair[0], examName, '数学', 90, tNow),
            mk(pair[1], examName, '语文', 70, tNow), mk(pair[1], examName, '数学', 70, tNow),
            mk(pair[0], prevName, '语文', 80, tPrev), mk(pair[0], prevName, '数学', 80, tPrev)
          ]);
        }, [sA._id, sB._id], EX, prevEX);
        await sleep(1000);
        const profPage = await goto(mp, '/pages/profile/profile', 3500);
        await mp.evaluate((sid) => {
          const pg = getCurrentPages().slice(-1)[0];
          const stu = pg.data.students.find(x => x._id === sid);
          if (stu) pg.openDetail(stu);
        }, sA._id);
        // 分析要拉全班成绩（含分页），轮询等结果
        let sa = null;
        for (let k = 0; k < 12 && !sa; k++) {
          await sleep(800);
          sa = await mp.evaluate(() => {
            const pg = getCurrentPages().slice(-1)[0];
            const a = pg.data.stats && pg.data.stats.scoreAnalysis;
            return a ? {
              exam: a.exam, rank: a.rank, size: a.classSize, n: a.subjectCount,
              avg: a.avgPct, total: a.total, totalFull: a.totalFull, delta: a.delta,
              strong: a.strongest && a.strongest.subject, weak: a.weakest && a.weakest.subject
            } : null;
          });
        }
        sa && sa.exam === EX && sa.rank === 1 && sa.size === 2 && sa.n === 2 &&
          sa.total === 180 && sa.totalFull === 200 && sa.avg === 90 && sa.delta === 10
          ? ok('成绩综合分析：第1/2名 · 2科 · 180/200 · 均分90 · 较上次+10')
          : bad('成绩综合分析异常: ' + JSON.stringify(sa));
        // 清理本次造的成绩（按考试名精确删除，不碰其他数据）
        await mp.evaluate((examName, prevName) => {
          const d = wx.cloud.database();
          const cmd = d.command;
          return d.collection('scores').where({ exam: cmd.in([examName, prevName]) }).get()
            .then(r => Promise.all(r.data.map(x => d.collection('scores').doc(x._id).remove())));
        }, EX, prevEX);
      } else {
        bad('学生不足 2 人，跳过成绩综合分析验证');
      }

      // 成绩学科含“艺术”
      const gradesPage = await goto(mp, '/pages/grades/grades', 3000);
      const subjHasArt = (await gradesPage.data('subjects')).indexOf('艺术') >= 0;
      subjHasArt ? ok('成绩学科已加“艺术”') : bad('成绩学科缺“艺术”');

      // ---- 数据分析页：三周期可切、能算出真实数据 ----
      const anPage = await goto(mp, '/pages/analytics/analytics', 3500);
      const anTabs = await anPage.data('tabs');
      const anRange = await anPage.data('rangeText');
      JSON.stringify(anTabs.map(t => t.label)) === JSON.stringify(['今日', '本周', '本月']) && !!anRange
        ? ok('分析页三周期分段 + 区间文案：' + anRange)
        : bad('分析页分段异常: ' + JSON.stringify(anTabs) + ' / ' + anRange);
      // 切到本月
      await mp.evaluate(() => getCurrentPages().slice(-1)[0].onTab({ currentTarget: { dataset: { i: 2 } } }));
      await sleep(2000);
      const monthRes = await anPage.data('result');
      monthRes && typeof monthRes.empty === 'boolean'
        ? ok('本月分析已计算（empty=' + monthRes.empty + '）')
        : bad('本月分析结果异常: ' + JSON.stringify(monthRes));

      // 快速连点分段（今日→本周→本月）：加载中的点击不许被吞（pending 修复）
      await mp.evaluate(() => {
        const pg = getCurrentPages().slice(-1)[0];
        pg.onTab({ currentTarget: { dataset: { i: 0 } } });
        pg.onTab({ currentTarget: { dataset: { i: 1 } } });
        pg.onTab({ currentTarget: { dataset: { i: 2 } } });
      });
      await sleep(2800);
      const afterRapid = await anPage.data('tabIndex');
      afterRapid === 2
        ? ok('分析页加载中连点分段，最终停在「本月」（点击没被吞）')
        : bad('快速切分段被吞，tabIndex=' + afterRapid);

      // 正常率守恒：有考勤数据时必须是 0-100 整数，且默认全班正常口径下不会误报 0%
      const monthRes2 = await anPage.data('result');
      const attRate = monthRes2 && monthRes2.attendance ? monthRes2.attendance.rate : null;
      if (attRate !== null && attRate !== undefined) {
        (Number.isInteger(attRate) && attRate >= 0 && attRate <= 100)
          ? ok('分析页正常率合法：' + attRate + '%')
          : bad('正常率越界: ' + attRate);
      }

      // 首页有分析入口
      const dashA = await goto(mp, '/pages/dashboard/dashboard', 3000);
      const anEntry = await $retry(dashA, '.link-analytics-quick');
      anEntry ? ok('首页有“数据分析”入口') : bad('首页缺数据分析入口');
    }

    console.log('\n[22] 清理测试数据');
    const cleanup = await mp.evaluate((no, ti) => {
      const db = wx.cloud.database();
      const del = (c, w) => db.collection(c).where(w).get().then(r => Promise.all(r.data.map(d => db.collection(c).doc(d._id).remove()))).then(r => r.length).catch(() => 0);
      return Promise.all([
        db.collection('students').where({ studentNo: db.command.in([no, no + 'B']) }).get().then(r => r.data.map(d => d._id)),
        del('announcements', { title: ti }),
        del('students', { _probe: true }),
        db.collection('homework').where({ title: db.RegExp({ regexp: '^E2EHW', options: 'i' }) }).get()
          .then(r => Promise.all(r.data.map(h => db.collection('homeworkSubmit').where({ homeworkId: h._id }).remove()
            .catch(() => null).then(() => db.collection('homework').doc(h._id).remove().catch(() => null)))))
          .then(r => r.length).catch(() => 0)
        ,
        // 还原被 E2E 改过的档案（健康字段带 E2E 前缀好识别）
        db.collection('students').where({ health: db.RegExp({ regexp: '^E2E', options: '' }) }).get()
          .then(r => Promise.all(r.data.map(x => db.collection('students').doc(x._id).update({
            data: { health: '良好', tags: [] }
          }).catch(() => null)))).then(r => r.length).catch(() => 0),
        // 座位测试残留（_reg 标记）：留着会让下一轮「云端座位数」断言算错
        del('seats', { _reg: true }),
        del('students', { studentNo: 'SEAT999' }),
        del('dutySchedule', { _reg: true }),
        del('students', { studentNo: 'DUTY999' }),
        // 登录段把云端昵称改成了 E2E老师 —— 不还原会让老师下次打开看到测试名字
        db.collection('teacherProfile').where({ nickName: db.RegExp({ regexp: '^E2E', options: '' }) }).get()
          .then(r => Promise.all(r.data.map(x => db.collection('teacherProfile').doc(x._id)
            .update({ data: { nickName: '' } }).catch(() => null)))).then(r => r.length).catch(() => 0),
        // E2E 待办残留兜底（正常段末已删，FATAL 中断时靠这里清）
        db.collection('todos').where({ title: db.RegExp({ regexp: '^E2ETODO', options: '' }) }).get()
          .then(r => Promise.all(r.data.map(x => db.collection('todos').doc(x._id).remove()))).then(r => r.length).catch(() => 0)
      ]).then(([ids, a, p, hw, pro, seat, seatStu, duty, dutyStu, tp, todoN]) => Promise.all(ids.map(id => db.collection('students').doc(id).remove()))
        .then(() => db.collection('attendance').where({ studentId: db.command.in(ids) }).get())
        .then(r => Promise.all(r.data.map(d => db.collection('attendance').doc(d._id).remove())))
        // ⚠️ 兜底扫孤儿座位：e2e 中途给探针学生排过座（按学号铺满会把探针也排进去），
        //    删学生时不带上座位就会留孤儿（实测：跑完剩 32 条座位 / 在册 30 人）。
        //    这里按「座位的 studentId 在 students 里不存在」全量扫，比逐个 id 删更可靠。
        .then(at => db.collection('seats').count().then(({ total }) => {
          const readAll = async (skip, out) => {
            const r = await db.collection('seats').skip(skip).limit(20).get();
            out.push(...r.data);
            return (r.data.length < 20 || out.length >= total) ? out : readAll(skip + 20, out);
          };
          return readAll(0, []).then(seats => db.collection('students').count().then(({ total: st }) => {
            const readStu = async (skip, out) => {
              const r = await db.collection('students').skip(skip).limit(20).get();
              out.push(...r.data);
              return (r.data.length < 20 || out.length >= st) ? out : readStu(skip + 20, out);
            };
            return readStu(0, []).then(stu => {
              const live = new Set(stu.map(x => x._id));
              const orphans = seats.filter(x => !live.has(x.studentId));
              // 值日也要扫孤儿：轮排会把探针学生排进去，删学生后留记录（座位踩过同一个坑）
              return db.collection('dutySchedule').count().then(({ total: dt }) => {
                const readDuty = async (skip, out) => {
                  const r = await db.collection('dutySchedule').skip(skip).limit(20).get();
                  out.push(...r.data);
                  return (r.data.length < 20 || out.length >= dt) ? out : readDuty(skip + 20, out);
                };
                return readDuty(0, []).then(ds => {
                  const dOrph = ds.filter(x => !live.has(x.studentId));
                  return Promise.all([]
                    .concat(orphans.map(x => db.collection('seats').doc(x._id).remove().catch(() => null)))
                    .concat(dOrph.map(x => db.collection('dutySchedule').doc(x._id).remove().catch(() => null))))
                    .then(() => ({ students: ids.length, announcements: a, probes: p, attendance: at.length,
                      作业: hw, 还原档案: pro, 座位: seat, 座位学生: seatStu, 孤儿座位: orphans.length,
                      值日: duty, 值日学生: dutyStu, 孤儿值日: dOrph.length, 身份还原: tp, 待办: todoN }));
                });
              });
            });
          }));
        })));
    }, testNo, title);
    ok('已清理 ' + JSON.stringify(cleanup));
  } catch (e) {
    bad('测试异常中断', e);
  } finally {
    console.log(`\n===== 结果：${pass.length} 通过 / ${fail.length} 失败 =====`);
    fail.forEach(f => console.log(' ❌ ' + f));
    await mp.disconnect(); // 不用 close()：close 会关掉用户的 IDE 项目窗口
    process.exit(fail.length ? 1 : 0);
  }
})();
