#!/usr/bin/env node
/**
 * 红队（使用者视角）：黑箱乱序攻击。
 *
 * 与蓝队 mutate.js 的区别 —— 也是这套对抗系统成立的前提：
 *   蓝队看源码、改源码，验证「已知的门禁」能不能抓已知的 bug；
 *   红队不许看源码里的实现细节，只按「一个不守规矩的老师会怎么点」去乱按，
 *   然后只检查**用户能观察到的自洽性**（页面数字之间对不对得上、云端和页面对不对得上）。
 *
 * 为什么这个隔离是必要的：duty 的 e2e 断言和 duty 页代码出自同一个心智模型，
 * 所以 `i % (SLOTS-5)` 这种「每人次数没错、岗位却空了 5 格」的 bug 能全绿放行。
 * 红队用与实现无关的守恒律判定，就绕开了那个共享盲点。
 *
 * 红队只允许用的判定（守恒律，不涉及任何内部实现）：
 *   R1 页面显示的「已排人次」必须等于周表格子里人数之和
 *   R2 「本周没排到」人数 + 至少排到一次的人数 = 全班人数
 *   R3 同一天同一岗位不许出现同一个人两次
 *   R4 保存并回读后，云端条数必须等于页面已排人次（不多不少）
 *   R5 任何操作都不许让页面崩掉（week/overview 结构还在）
 *   R6 dirty 已清时，再点保存必须提示「没有改动」而不是继续写库
 *
 * ⚠️ 单个种子不可靠：实测注入「删掉同岗位重复检查」的 bug 后，SEED=7/99 抓到了，
 *    SEED=1337/2024 却全绿放行 —— 随机攻击的覆盖依赖种子。所以默认跑多轮多种子，
 *    只要任一轮抓到就算发现。要复现某轮失败用 SEED=xxx ROUNDS=1。
 *
 * schedule（课程表）另有一套守恒律，页面语义不同（一格一课，没有「人」的概念）：
 *   S1 overview.filled 必须等于周表格子里非空格子数之和
 *   S2 filled + empty = slots = 45（5 天 × 9 节含午间延时，格子总数是常量）
 *   S3 每日 w.filled 必须等于该日非空格子数（第二处独立计算，最容易漂）
 *   S4 结构恒为 5 天 × 8 节，任何乱按都不许让它塌
 *   S5 科目 class 名恒为纯小写 ASCII 且非空（中文进 class 会让整份 wxss 编译失败）
 *   S6 conflictList.length == overview.conflicts，且用页面数据复算一致
 *   S7 保存回读后：云端条数 = 页面 filled，无同格重复，无非法 weekday/period/科目
 *   S8 dirty 已清时再保存必须提示「没有改动」
 *   S9 跑完不许把课表留空（收尾要恢复）
 *
 * committee（班委名单）第三套，语义又不同（12 个岗、一岗最多两人、允许兼岗但 >2 要提醒）：
 *   C1 overview.filled == posts 里非空岗位数；未任职名单 == 全班 - 有岗的人
 *   C2 filled + empty == slots == 12
 *   C3 一岗最多两人：每个岗位 holders ≤ 2 且无同人重复
 *   C4 结构恒为 12 个岗位；任何动作不许抛异常
 *   C5 pcls 恒为纯小写 ASCII；不许出现枚举外岗位名
 *   C6 warnList.length == keyEmpty + multi，且与页面数据复算一致（key 不许重复）
 *   C7 保存回读：云端条数 == filled，无同岗重复，无非法 post / 孤儿 studentId
 *   C8 dirty 清后再保存必须提示「没有改动」
 *   C9 收尾必须恢复到 12 岗（门槛不写 >0：半空名单也是坏观感）
 *
 * 用法: node tools/redteam.js              # 默认 duty+schedule+committee 各 4 轮 × 40 步
 *      TARGET=schedule node tools/redteam.js      # 只攻课程表
 *      TARGET=duty node tools/redteam.js          # 只攻值日表
 *      TARGET=committee node tools/redteam.js     # 只攻班委名单
 *      node tools/redteam.js 60           # 4 轮 × 60 步
 *      ROUNDS=8 node tools/redteam.js     # 8 轮，覆盖更狠
 *      SEED=7 ROUNDS=1 node tools/redteam.js 30   # 复现某次失败
 */
const { connectOrLaunch, sleep, evalRetry } = require('./mp.js');

// 等页面保存真正结束（_busy 回落）再校验。固定 sleep(9000) 在弱网重试时会读到
// 迁移中途态（云端 41 条/集合还在缩小），把环境抖动误判成业务 bug；真死锁时
// 也不能无限等，上限 60s 后按当前态判（大概率真有保存卡死，值得报出来）。
async function waitSaved(mp, maxMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    const busy = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      return pg ? !!pg._busy : false;
    }).catch(() => false);
    if (!busy) return;
    if (Date.now() - t0 > maxMs) { console.log('  ⚠️ 等待保存结束超时 60s，按当前态判定'); return; }
    await sleep(500);
  }
}

const STEPS = Number(process.argv[2] || 40);
const ROUNDS = Number(process.env.ROUNDS || (process.env.SEED ? 1 : 4));
const BASE_SEED = Number(process.env.SEED || Date.now() % 100000);

// 可复现的伪随机（失败时能用 SEED=xxx ROUNDS=1 原样重放，否则乱序测试等于不可调试）
let _s = BASE_SEED;
const reseed = v => { _s = v; };
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const pick = a => a[Math.floor(rnd() * a.length)];
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));

const findings = [];
let SEED = BASE_SEED;      // 当轮种子，报告里要能指出是哪一轮抓到的
const record = (rule, detail, ctx) => {
  const key = rule + '|' + detail;
  if (findings.some(f => f.key === key)) return;      // 同一类只报一次，避免刷屏
  findings.push({ key, rule, detail, ctx, seed: SEED });
  console.log(`  ❌ [${rule}] ${detail}` + (ctx ? '\n       上下文: ' + JSON.stringify(ctx) : ''));
};

// 红队的「操作库」：全部走页面事件处理器，参数故意包含非法值 —— 用户能点到的、
// 以及恶意/误触能造出的，都要试。绝不直接改 this.assign（那是内部状态，越界了）。
const ACTIONS = [
  { name: 'openDay-legal', run: 'pg.onOpenDay({currentTarget:{dataset:{d:D}}})', arg: () => ({ D: ri(1, 5) }) },
  { name: 'openDay-illegal', run: 'pg.onOpenDay({currentTarget:{dataset:{d:D}}})', arg: () => ({ D: pick([0, 6, -1, 99, NaN]) }) },
  { name: 'backToWeek', run: 'pg.onBackToWeek()', arg: () => ({}) },
  { name: 'pick-random', run: 'var p=pg.data.pool||[];if(p.length)pg.onPickStudent({currentTarget:{dataset:{id:p[Math.floor(R*p.length)]._id}}})', arg: () => ({ R: rnd() }) },
  { name: 'pick-ghost', run: "pg.onPickStudent({currentTarget:{dataset:{id:'GHOST_NOT_EXIST'}}})", arg: () => ({}) },
  { name: 'assign-legal', run: 'var J=pg.data.dayJobs||[];if(J.length)pg.onAssignJob({currentTarget:{dataset:{job:J[Math.floor(R*J.length)].job}}})', arg: () => ({ R: rnd() }) },
  { name: 'assign-illegal-job', run: "pg.onAssignJob({currentTarget:{dataset:{job:'搬砖'}}})", arg: () => ({}) },
  // 定向攻击「同岗位重复排同人」：挑一个人 → 排进某岗位 → 再挑同一个人 → 再排同一岗位。
  // 这是 R3 唯一能被触发的路径，靠纯随机撞不到（首跑就漏过一个真 bug）。
  {
    name: 'assign-same-twice',
    run: `var P=pg.data.pool||[], J=pg.data.dayJobs||[];
          if(P.length&&J.length){var s=P[Math.floor(R*P.length)], j=J[Math.floor(R2*J.length)];
            pg.onPickStudent({currentTarget:{dataset:{id:s._id}}});
            pg.onAssignJob({currentTarget:{dataset:{job:j.job}}});
            pg.onPickStudent({currentTarget:{dataset:{id:s._id}}});
            pg.onAssignJob({currentTarget:{dataset:{job:j.job}}});}`,
    arg: () => ({ R: rnd(), R2: rnd() })
  },
  { name: 'assign-without-pick', run: "pg.setData({pickedId:'',pickedName:''});var J=pg.data.dayJobs||[];if(J.length)pg.onAssignJob({currentTarget:{dataset:{job:J[0].job}}})", arg: () => ({}) },
  { name: 'remove-random', run: 'var J=(pg.data.dayJobs||[]).filter(function(j){return j.people.length});if(J.length){var j=J[Math.floor(R*J.length)];pg.onRemovePerson({currentTarget:{dataset:{job:j.job,id:j.people[0]._id}}})}', arg: () => ({ R: rnd() }) },
  { name: 'remove-ghost', run: "var J=pg.data.dayJobs||[];if(J.length)pg.onRemovePerson({currentTarget:{dataset:{job:J[0].job,id:'GHOST'}}})", arg: () => ({}) },
  { name: 'rotate', run: 'pg.onRotate()', arg: () => ({}) },
  { name: 'shuffle', run: 'pg.onShuffleRotate()', arg: () => ({}) },
  { name: 'clearAll', run: 'var o=wx.showModal;wx.showModal=function(x){x.success&&x.success({confirm:true})};pg.onBackToWeek();pg.onClearAll();wx.showModal=o', arg: () => ({}), weight: 0.35 },
  { name: 'clearAll-cancel', run: 'var o=wx.showModal;wx.showModal=function(x){x.success&&x.success({confirm:false})};pg.onClearAll();wx.showModal=o', arg: () => ({}) }
];

async function snapshot(mp) {
  return evalRetry(mp, () => {
    const pg = getCurrentPages().slice(-1)[0];
    if (!pg || !pg.data || !pg.data.week) return { broken: true, route: pg && pg.route };
    const week = pg.data.week;
    const ov = pg.data.overview || {};
    // 只用页面上看得见的东西算守恒律
    let cellSum = 0;
    const dupInCell = [];
    const everyone = {};
    week.forEach(w => w.jobs.forEach(j => {
      cellSum += j.people.length;
      const seen = {};
      j.people.forEach(p => {
        if (seen[p._id]) dupInCell.push(w.d + '@' + j.job + '@' + p.name);
        seen[p._id] = 1;
        everyone[p._id] = (everyone[p._id] || 0) + 1;
      });
    }));
    return {
      broken: false,
      view: pg.data.view,
      days: week.length,
      jobsPerDay: week.map(w => w.jobs.length),
      cellSum,
      dupInCell,
      assigned: ov.assigned,
      missing: ov.missing,
      total: ov.total,
      slots: ov.slots,
      onDutyPeople: Object.keys(everyone).length,
      missingList: (pg.data.missingList || []).length,
      dirty: !!pg.dirty,
      students: (pg.students || []).length
    };
  });
}

function checkInvariants(s, ctx) {
  if (s.broken) { record('R5', '页面结构崩了（week 不见了）', s); return; }
  if (s.days !== 5 || s.jobsPerDay.some(n => n !== 5)) record('R5', `周表结构坏了 days=${s.days} jobs=${JSON.stringify(s.jobsPerDay)}`, ctx);
  if (s.assigned !== s.cellSum) record('R1', `已排人次 ${s.assigned} ≠ 周表格子求和 ${s.cellSum}`, ctx);
  if (s.missing + s.onDutyPeople !== s.students) record('R2', `没排到 ${s.missing} + 已排到 ${s.onDutyPeople} ≠ 全班 ${s.students}`, ctx);
  if (s.missingList !== s.missing) record('R2', `未排到名单长度 ${s.missingList} ≠ overview.missing ${s.missing}`, ctx);
  if (s.dupInCell.length) record('R3', `同天同岗重复排同人: ${s.dupInCell.slice(0, 3).join(', ')}`, ctx);
  if (s.total !== s.students) record('R5', `overview.total ${s.total} ≠ 学生数 ${s.students}`, ctx);
}

async function runRound(mp, seed) {
  SEED = seed;
  reseed(seed);
  console.log(`\n──── 第 ${seed} 号种子，${STEPS} 步 ────`);
  {
    // 页面栈重置（抽段/独立跑都是空降，栈里可能压着上轮的页面）
    for (let i = 0; i < 3; i++) {
      await mp.reLaunch('/pages/dashboard/dashboard').catch(() => 0);
      await sleep(1200);
      const d = await mp.evaluate(() => getCurrentPages().length).catch(() => -1);
      if (d === 1) break;
    }
    await mp.reLaunch('/pages/duty/duty');
    await sleep(4000);

    // ⚠️ 起始状态必须随机化。首跑时库里是排满的 31/31，于是「排入」动作全被
    //    「今天已排别的岗位」等前置条件吸收，`assign` 分支根本走不到重复检查那一行
    //    —— 注入「删掉重复检查」的 bug 后红队照样全绿（实测漏报）。
    //    所以先按种子决定清掉多少，让空位/半满/满表三种形态都有机会被攻击。
    const startMode = pick(['empty', 'half', 'full', 'asis']);
    console.log('  起始形态: ' + startMode);
    await evalRetry(mp, new Function('M', `const pg=getCurrentPages().slice(-1)[0];
      const _t=wx.showToast, _m=wx.showModal;
      wx.showToast=function(){}; wx.showModal=function(x){x.success&&x.success({confirm:true})};
      try {
        if (M === 'empty') { pg.onBackToWeek(); pg.onClearAll(); }
        else if (M === 'half') {
          pg.onBackToWeek(); pg.onClearAll(); pg.onRotate();
          // 清掉一半格子：制造「有人没排到 + 有空岗」的混合态
          const wk = pg.data.week;
          wk.forEach(function(w, i) { if (i % 2) w.jobs.forEach(function(j) {
            j.people.slice().forEach(function(p) { pg.onOpenDay({currentTarget:{dataset:{d:w.d}}});
              pg.onRemovePerson({currentTarget:{dataset:{job:j.job,id:p._id}}}); }); }); });
          pg.onBackToWeek();
        } else if (M === 'full') { pg.onRotate(); }
      } finally { wx.showToast=_t; wx.showModal=_m; }
      return 1;`), [startMode]);
    await sleep(2000);

    let s = await snapshot(mp);
    checkInvariants(s, { step: 0, action: 'init' });
    console.log(`  起始: 已排 ${s.assigned} / 全班 ${s.students} / 没排到 ${s.missing}`);

    const log = [];
    for (let i = 1; i <= STEPS; i++) {
      let act = pick(ACTIONS);
      // 有 weight 的动作按概率跳过（clearAll 太猛，每步都清就测不到别的）
      if (act.weight && rnd() > act.weight) act = ACTIONS[0];
      const args = act.arg();
      log.push(act.name);
      try {
        await evalRetry(mp, new Function('A', `const pg=getCurrentPages().slice(-1)[0];if(!pg)return 0;
          const D=A.D,R=A.R,R2=A.R2;
          const _t=wx.showToast; wx.showToast=function(){};      // 攻击期屏蔽 toast，别刷屏
          try { ${act.run} } finally { wx.showToast=_t; }
          return 1;`), [args]);
      } catch (e) {
        record('R5', `动作 ${act.name} 抛异常: ${(e.message || e).slice(0, 80)}`, { step: i, args });
      }
      s = await snapshot(mp);
      checkInvariants(s, { step: i, action: act.name, args, last5: log.slice(-5) });
      if (i % 15 === 0) console.log(`  …第 ${i}/${STEPS} 步（已排 ${s.assigned}，没排到 ${s.missing}，dirty=${s.dirty}）`);
    }

    // R4：乱按完保存，云端必须与页面一致
    console.log('  乱按结束，保存并回读校验云端一致性…');
    await evalRetry(mp, () => { const pg = getCurrentPages().slice(-1)[0]; pg.onSave(); return 1; });
    await waitSaved(mp);
    await sleep(1500);            // _busy 回落后给云端读视图收敛时间，避免读到迁移残影
    const after = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      if (!pg || !pg.data || !pg.data.overview) return { broken: true, route: pg && pg.route };
      const d = wx.cloud.database();
      return d.collection('dutySchedule').count().then(({ total }) => {
        const readAll = async (skip, out) => {
          const r = await d.collection('dutySchedule').skip(skip).limit(20).get();
          out.push(...r.data);
          return (r.data.length < 20 || out.length >= total) ? out : readAll(skip + 20, out);
        };
        return readAll(0, []).then(all => {
          const keys = all.map(x => `${x.weekday}@${x.job}@${x.studentId}`);
          const bad = all.filter(x => !(Number(x.weekday) >= 1 && Number(x.weekday) <= 5)
            || ['扫地', '擦黑板', '倒垃圾', '摆桌椅', '关窗锁门'].indexOf(x.job) < 0);
          return {
            cloud: total, fetched: all.length, uniq: new Set(keys).size,
            illegal: bad.length, page: pg.data.overview.assigned, dirty: !!pg.dirty,
            route: pg.route
          };
        });
      });
    });
    if (after.broken || after.route !== 'pages/duty/duty') record('R5', `保存回读时页面串路由或 overview 丢失：${after.route}`, after);
    if (after.cloud !== after.page) record('R4', `云端 ${after.cloud} 条 ≠ 页面已排 ${after.page} 人次`, after);
    if (after.uniq !== after.fetched) record('R4', `云端有 ${after.fetched - after.uniq} 条重复记录`, after);
    if (after.illegal) record('R4', `云端有 ${after.illegal} 条非法 weekday/岗位（乱按把脏数据写进去了）`, after);
    if (after.dirty) record('R6', '保存完成后 dirty 仍未清', after);

    // R6：再点一次保存，应该被「没有改动」拦住
    const noop = await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      let msg = '';
      const o = wx.showToast;
      wx.showToast = x => { msg = x.title; };
      pg.onSave();
      return new Promise(r => setTimeout(() => { wx.showToast = o; r({ msg }); }, 1200));
    });
    if (!/没有改动/.test(noop.msg)) record('R6', `无改动时未被拦住（toast="${noop.msg}"）`, noop);

    // 收尾：把值日表恢复成有数据的状态，别给用户留个空表。
    // ⚠️ 必须分两步 + 回读复核。写成同 tick 的 `onRotate(); onSave();` 时实测无效
    //    （云端仍 0 条）—— onSave 的 diff 依赖 render() 之后的状态。
    // 收尾条件不能只看 ===0：保存半失败可能留下 40+ 条重复/残表，照样是坏数据，
    // 必须与「轮排后应有」的页面人次一致才算恢复成功。
    const want = await evalRetry(mp, () => { const pg = getCurrentPages().slice(-1)[0]; return pg.data.overview.total; });
    let restored = after.cloud;
    for (let att = 0; att < 3 && restored !== want; att++) {
      await evalRetry(mp, () => { const pg = getCurrentPages().slice(-1)[0]; pg.onBackToWeek(); pg.onRotate(); return pg.data.overview.assigned; });
      await sleep(1200);
      await evalRetry(mp, () => { const pg = getCurrentPages().slice(-1)[0]; pg.onSave(); return 1; });
      await waitSaved(mp);
      await sleep(1000);
      restored = await evalRetry(mp, () => wx.cloud.database().collection('dutySchedule').count().then(c => c.total));
      console.log(`  收尾第 ${att + 1} 次：云端恢复到 ${restored} 条`);
    }
    if (restored !== want) record('R7', `红队跑完值日表未恢复（应轮排 ${want} 人次，实际 ${restored} 条），收尾失败`, { after });

    console.log(`  本轮结束：云端 ${restored} 条 / 页面 ${after.page} 人次`);
  }
}

/* ==================== 课程表（schedule）攻击段 ====================
 * 单独一套，不复用 duty 的 ACTIONS/snapshot —— 两页的守恒律语义完全不同
 * （duty 是「人 × 岗位」多对多，schedule 是「格子 → 一门课」一对一）。
 * 强行抽公共基类会把两套语义混在一起，反而给自己造盲点。 */
const OK_SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理', '体育', '音乐', '美术', '艺术', '信息', '自习'];
// 5 天 × 9 节（含午间延时 period=9）。改课表节次必须同步这里，否则 S2/S9 恒假绿。
const SCHED_SLOTS = 45;
// ⚠️ 节次编号不连续也不等于「1..N」：午间延时挂在数字末尾 period=9，显示位置在第 4 节之后。
//    所以一切校验/构造都必须用**集合**，不许写 `p <= 8` 或 `p <= 9` 这类区间判断。
const SCHED_PERIODS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const SCHED_PER_DAY = SCHED_PERIODS.length;               // 9
const BAD_PERIODS = [0, 10, -1, 99, NaN];                 // 用户点不到、只有脏 dataset 能造出来

const SCHED_ACTIONS = [
  { name: 'openDay-legal', run: 'pg.onOpenDay({currentTarget:{dataset:{d:D}}})', arg: () => ({ D: ri(1, 5) }) },
  { name: 'openDay-illegal', run: 'pg.onOpenDay({currentTarget:{dataset:{d:D}}})', arg: () => ({ D: pick([0, 6, -1, 99, NaN]) }) },
  { name: 'backToWeek', run: 'pg.onBackToWeek()', arg: () => ({}) },
  { name: 'pickSubject-legal', run: 'var S=pg.data.subjects||[];if(S.length)pg.onPickSubject({currentTarget:{dataset:{subject:S[Math.floor(R*S.length)]}}})', arg: () => ({ R: rnd() }) },
  { name: 'pickSubject-illegal', run: "pg.onPickSubject({currentTarget:{dataset:{subject:PICK}}})", arg: () => ({ PICK: pick(['搬砖', '', 'MATH', '语文 ', null]) }) },
  // 挑科目 → 点格子（正常填课路径）。onTapCell 填完会清选中，所以每次都要重新挑。
  {
    name: 'fill-cell',
    run: `var S=pg.data.subjects||[];
          if(S.length&&pg.data.view==='day'){
            pg.onPickSubject({currentTarget:{dataset:{subject:S[Math.floor(R*S.length)]}}});
            var CP=(pg.data.periods||[]).map(function(c){return c.p;});
            if(!CP.length)CP=[1,2,3,4,5,6,7,8,9];
            pg.onTapCell({currentTarget:{dataset:{p:CP[Math.floor(R2*CP.length)]}}});}`,
    // 节次从页面 data.periods 取（含 period=9 午间延时；dayCells 只在 day 视图有值）。不从外部传数组：动作模板只解构
    // D/R/R2/P/PICK 这几个标量，传数组会 Uncaught xxx is not defined（实测踩过）。
    arg: () => ({ R: rnd(), R2: rnd() })
  },
  // 不挑科目直接点格子：必须被拦（不许写进 plan）
  { name: 'tapCell-nopick', run: "pg.setData({pickedSubject:''});pg.onTapCell({currentTarget:{dataset:{p:P}}})", arg: () => ({ P: pick(SCHED_PERIODS) }) },
  // 非法节次：用户点不到，但脏 dataset 能造出来
  { name: 'tapCell-illegal-p', run: "var S=pg.data.subjects||[];if(S.length){pg.onPickSubject({currentTarget:{dataset:{subject:S[0]}}});pg.onTapCell({currentTarget:{dataset:{p:P}}})}", arg: () => ({ P: pick(BAD_PERIODS) }) },
  // 定向攻击 S6：把一整天前 5 节填成同一门主科 —— 同时触发「主科每天>3」和「连排 3 节」两类冲突。
  // 纯随机撞不到（实测 25 步 SEED=25256 下冲突恒为 0，注入 MAX_MAIN_PER_DAY=99 也全绿放行）。
  {
    name: 'stack-main-subject',
    run: `var main=['语文','数学','英语'][Math.floor(R*3)];
          pg.onOpenDay({currentTarget:{dataset:{d:Math.floor(R2*5)+1}}});
          for(var p=1;p<=5;p++){
            pg.onPickSubject({currentTarget:{dataset:{subject:main}}});
            pg.onTapCell({currentTarget:{dataset:{p:p}}});}`,
    arg: () => ({ R: rnd(), R2: rnd() })
  },
  { name: 'clearCell', run: 'pg.onClearCell({currentTarget:{dataset:{p:P}}})', arg: () => ({ P: pick(SCHED_PERIODS) }) },
  { name: 'clearCell-illegal', run: 'pg.onClearCell({currentTarget:{dataset:{p:P}}})', arg: () => ({ P: pick(BAD_PERIODS) }) },
  /* ---- 周表直接编排（2026-09-06 新增；此前红队完全没碰过 onCellPick，等于零覆盖）---- */
  // 周表两次点击 = 互换/移动。守恒律靠 snapshotSched 的「已排总数」把守：
  // 互换不许改总数，移动不许改总数，只有填/清才允许变。
  {
    name: 'week-swap',
    run: `pg.onBackToWeek();
          pg.setData({pickedSubject:'',swapFrom:''});
          var CP=(pg.data.periods||[]).map(function(c){return c.p;});
          if(!CP.length)CP=[1,2,3,4,5,6,7,8,9];
          pg.onCellPick({currentTarget:{dataset:{d:Math.floor(R*5)+1,p:CP[Math.floor(R2*CP.length)]}}});
          pg.onCellPick({currentTarget:{dataset:{d:Math.floor(R3*5)+1,p:CP[Math.floor(R4*CP.length)]}}});`,
    arg: () => ({ R: rnd(), R2: rnd(), R3: rnd(), R4: rnd() })
  },
  // 周表挑科目 → 点格子填入（省掉进 day 页那一跳的新路径）
  {
    name: 'week-fill',
    run: `pg.onBackToWeek();
          var S=pg.data.subjects||[];
          var CP=(pg.data.periods||[]).map(function(c){return c.p;});
          if(!CP.length)CP=[1,2,3,4,5,6,7,8,9];
          if(S.length){
            pg.onPickSubject({currentTarget:{dataset:{subject:S[Math.floor(R*S.length)]}}});
            pg.onCellPick({currentTarget:{dataset:{d:Math.floor(R2*5)+1,p:CP[Math.floor(R3*CP.length)]}}});}`,
    arg: () => ({ R: rnd(), R2: rnd(), R3: rnd() })
  },
  // 周表长按清空
  {
    name: 'week-clear',
    run: `pg.onBackToWeek();
          var CP=(pg.data.periods||[]).map(function(c){return c.p;});
          if(!CP.length)CP=[1,2,3,4,5,6,7,8,9];
          pg.onClearWeekCell({currentTarget:{dataset:{d:Math.floor(R*5)+1,p:CP[Math.floor(R2*CP.length)]}}});`,
    arg: () => ({ R: rnd(), R2: rnd() })
  },
  // 非法格子：脏 dataset（用户点不到，但恶意调用/数据错乱能造出来）
  {
    name: 'week-illegal',
    run: `pg.onBackToWeek();
          pg.onCellPick({currentTarget:{dataset:{d:D,p:P}}});
          pg.onClearWeekCell({currentTarget:{dataset:{d:D,p:P}}});`,
    arg: () => ({ D: pick([0, 6, -1, 99, NaN]), P: pick(BAD_PERIODS) })
  },
  // 半途切换模式：选中一格待交换后立刻挑科目（两种模式必须互斥，不许把「换」变成「填」）
  {
    name: 'week-mode-switch',
    run: `pg.onBackToWeek();
          pg.setData({pickedSubject:'',swapFrom:''});
          var S=pg.data.subjects||[];
          var CP=(pg.data.periods||[]).map(function(c){return c.p;});
          if(!CP.length)CP=[1,2,3,4,5,6,7,8,9];
          pg.onCellPick({currentTarget:{dataset:{d:Math.floor(R*5)+1,p:CP[Math.floor(R2*CP.length)]}}});
          if(S.length)pg.onPickSubject({currentTarget:{dataset:{subject:S[Math.floor(R3*S.length)]}}});
          pg.onCellPick({currentTarget:{dataset:{d:Math.floor(R4*5)+1,p:CP[Math.floor(R2*CP.length)]}}});`,
    arg: () => ({ R: rnd(), R2: rnd(), R3: rnd(), R4: rnd() })
  },
  { name: 'applyTemplate', run: 'pg.onApplyTemplate()', arg: () => ({}), weight: 0.4 },
  { name: 'clearAll', run: 'var o=wx.showModal;wx.showModal=function(x){x.success&&x.success({confirm:true})};pg.onBackToWeek();pg.onClearAll();wx.showModal=o', arg: () => ({}), weight: 0.3 },
  { name: 'clearAll-cancel', run: 'var o=wx.showModal;wx.showModal=function(x){x.success&&x.success({confirm:false})};pg.onClearAll();wx.showModal=o', arg: () => ({}) }
];

async function snapshotSched(mp) {
  // ⚠️ 枚举一律用参数注入，不许在 evaluate 函数体里手抄一份 —— 实测事故：加「艺术」课后
  //    body 里的手抄副本没跟着改，红队把合法科目报成 S5「枚举外科目」（假红，浪费一轮）。
  return evalRetry(mp, (OKS) => {
    const pg = getCurrentPages().slice(-1)[0];
    if (!pg || !pg.data || !pg.data.week) return { broken: true, route: pg && pg.route };
    const week = pg.data.week;
    const ov = pg.data.overview || {};
    let cellSum = 0;
    const badCls = [];
    const dayMismatch = [];
    const badSub = [];
    week.forEach(w => {
      let n = 0;
      w.cells.forEach(c => {
        if (c.empty) return;
        n++;
        if (!/^[a-z]+$/.test(String(c.scls || ''))) badCls.push(c.subject + '->' + c.scls);
        if (OKS.indexOf(c.subject) < 0) badSub.push(w.d + '@' + c.p + ':' + c.subject);
      });
      cellSum += n;
      if (w.filled !== n) dayMismatch.push(w.d + ': ' + w.filled + '!=' + n);
    });
    // 冲突复算（与页面实现无关：只用格子数据按「主科每天>3」「同科连排3」两条规则算）
    const MAIN = ['语文', '数学', '英语'];
    let expect = 0;
    week.forEach(w => {
      const per = {};
      w.cells.forEach(c => { if (!c.empty) per[c.subject] = (per[c.subject] || 0) + 1; });
      Object.keys(per).forEach(sub => { if (MAIN.indexOf(sub) >= 0 && per[sub] > 3) expect++; });
      for (let i = 0; i + 2 < w.cells.length; i++) {
        const a = w.cells[i], b = w.cells[i + 1], c = w.cells[i + 2];
        if (!a.empty && a.subject === b.subject && b.subject === c.subject) expect++;
      }
    });
    return {
      broken: false,
      view: pg.data.view,
      days: week.length,
      cellsPerDay: week.map(w => w.cells.length),
      cellSum, badCls, badSub, dayMismatch,
      filled: ov.filled, empty: ov.empty, slots: ov.slots, conflicts: ov.conflicts,
      conflictList: (pg.data.conflictList || []).length,
      expectConflicts: expect,
      subjectsStat: (pg.data.subjectStat || []).length,
      ovSubjects: ov.subjects,
      picked: pg.data.pickedSubject,
      dirty: !!pg.dirty
    };
  }, [OK_SUBJECTS]);
}

function checkSchedInvariants(s, ctx) {
  if (s.broken) { record('S4', '页面结构崩了（week 不见了）', s); return; }
  if (s.days !== 5 || s.cellsPerDay.some(n => n !== SCHED_PER_DAY)) record('S4', `周表结构坏了 days=${s.days} cells=${JSON.stringify(s.cellsPerDay)}（每天应 ${SCHED_PER_DAY} 格）`, ctx);
  if (s.filled !== s.cellSum) record('S1', `已排 ${s.filled} ≠ 周表格子求和 ${s.cellSum}`, ctx);
  if (s.slots !== SCHED_SLOTS || s.filled + s.empty !== s.slots) record('S2', `格子总数不闭合 slots=${s.slots} filled=${s.filled} empty=${s.empty}`, ctx);
  if (s.dayMismatch.length) record('S3', `每日已排数漂移: ${s.dayMismatch.slice(0, 3).join(', ')}`, ctx);
  if (s.badCls.length) record('S5', `科目类名非 ASCII: ${s.badCls.slice(0, 3).join(', ')}`, ctx);
  if (s.badSub.length) record('S5', `格子里出现枚举外科目: ${s.badSub.slice(0, 3).join(', ')}`, ctx);
  if (s.conflictList !== s.conflicts) record('S6', `冲突清单 ${s.conflictList} ≠ overview.conflicts ${s.conflicts}`, ctx);
  if (s.conflicts !== s.expectConflicts) record('S6', `冲突数与复算不一致: 页面 ${s.conflicts} 复算 ${s.expectConflicts}`, ctx);
  if (s.subjectsStat !== s.ovSubjects) record('S6', `科目数不一致: 统计表 ${s.subjectsStat} ≠ overview.subjects ${s.ovSubjects}`, ctx);
  if (s.picked && OK_SUBJECTS.indexOf(s.picked) < 0) record('S5', `选中了枚举外科目「${s.picked}」`, ctx);
}

async function runSchedRound(mp, seed) {
  SEED = seed;
  reseed(seed);
  console.log(`\n──── [课程表] 第 ${seed} 号种子，${STEPS} 步 ────`);
  for (let i = 0; i < 3; i++) {
    await mp.reLaunch('/pages/dashboard/dashboard').catch(() => 0);
    await sleep(1200);
    const d = await mp.evaluate(() => getCurrentPages().length).catch(() => -1);
    if (d === 1) break;
  }
  await mp.reLaunch('/pages/schedule/schedule');
  await sleep(4000);

  // 起始形态随机化：满表时「填课」分支会被「这一节已经是X」吸收，空表时又测不到覆盖，
  // 所以三种形态都要有机会（duty 段实测过：不随机化会漏报真 bug）
  const startMode = pick(['empty', 'template', 'half', 'asis']);
  console.log('  起始形态: ' + startMode);
  await evalRetry(mp, new Function('M', `const pg=getCurrentPages().slice(-1)[0];
    const _t=wx.showToast, _m=wx.showModal;
    wx.showToast=function(){}; wx.showModal=function(x){x.success&&x.success({confirm:true})};
    try {
      if (M === 'empty') { pg.onBackToWeek(); pg.onClearAll(); }
      else if (M === 'template') { pg.onApplyTemplate(); }
      else if (M === 'half') {
        pg.onApplyTemplate();
        // 抠掉一半的天，制造「有空格 + 有已排」的混合态
        // ⚠️ 节次要从页面自己的 cells 里取（午间延时是 period=9，写 p<=8 会漏清一格 → 起始
        //    注：本函数体是模板字符串，注释里不许出现反引号，否则提前终止模板 → SyntaxError。
        //    形态与预期不符，S2/S6 的归因跟着错）。先把 d/p 快照出来再动，避免边遍历边 setData。
        var plan = pg.data.week.map(function(w) { return { d: w.d, ps: w.cells.map(function(c){ return c.p; }) }; });
        plan.forEach(function(t, i) {
          if (i % 2) { pg.onOpenDay({currentTarget:{dataset:{d:t.d}}});
            t.ps.forEach(function(p){ pg.onClearCell({currentTarget:{dataset:{p:p}}}); }); }
        });
        pg.onBackToWeek();
      }
    } finally { wx.showToast=_t; wx.showModal=_m; }
    return 1;`), [startMode]);
  await sleep(1500);

  let s = await snapshotSched(mp);
  checkSchedInvariants(s, { step: 0, action: 'init' });
  console.log(`  起始: 已排 ${s.filled}/${s.slots} / 冲突 ${s.conflicts}`);

  const log = [];
  for (let i = 1; i <= STEPS; i++) {
    let act = pick(SCHED_ACTIONS);
    if (act.weight && rnd() > act.weight) act = SCHED_ACTIONS[0];
    const args = act.arg();
    log.push(act.name);
    try {
      await evalRetry(mp, new Function('A', `const pg=getCurrentPages().slice(-1)[0];if(!pg)return 0;
        const D=A.D,R=A.R,R2=A.R2,R3=A.R3,R4=A.R4,P=A.P,PICK=A.PICK;   // 新增动作要用的标量必须在这里解构，否则 Uncaught R3 is not defined
        const _t=wx.showToast; wx.showToast=function(){};
        try { ${act.run} } finally { wx.showToast=_t; }
        return 1;`), [args]);
    } catch (e) {
      record('S4', `动作 ${act.name} 抛异常: ${(e.message || e).slice(0, 80)}`, { step: i, args });
    }
    s = await snapshotSched(mp);
    checkSchedInvariants(s, { step: i, action: act.name, args, last5: log.slice(-5) });
    if (i % 15 === 0) console.log(`  …第 ${i}/${STEPS} 步（已排 ${s.filled}，冲突 ${s.conflicts}，dirty=${s.dirty}）`);
  }

  // S7：乱按完保存，云端必须与页面逐项对得上
  console.log('  乱按结束，保存并回读校验云端一致性…');
  await evalRetry(mp, () => { const pg = getCurrentPages().slice(-1)[0]; pg.onSave(); return 1; });
  await waitSaved(mp);
  await sleep(1500);            // _busy 回落后给云端读视图收敛时间，避免读到迁移残影
  const after = await evalRetry(mp, (OKS, PDS) => {
    const pg = getCurrentPages().slice(-1)[0];
    if (!pg || !pg.data || !pg.data.overview) return { broken: true, route: pg && pg.route };
    const d = wx.cloud.database();
    return d.collection('schedule').count().then(({ total }) => {
      const readAll = async (skip, out) => {
        const r = await d.collection('schedule').skip(skip).limit(20).get();
        out.push(...r.data);
        return (r.data.length < 20 || out.length >= total) ? out : readAll(skip + 20, out);
      };
      return readAll(0, []).then(all => {
        const keys = all.map(x => `${x.weekday}@${x.period}`);
        const bad = all.filter(x => !(Number.isInteger(x.weekday) && x.weekday >= 1 && x.weekday <= 5)
          || PDS.indexOf(x.period) < 0
          || OKS.indexOf(x.subject) < 0);
        return {
          cloud: total, fetched: all.length, uniq: new Set(keys).size,
          illegal: bad.length,
          // 带上样本：只报条数时无法区分「业务真写脏了」和「红队自己的枚举没同步」（实测踩过）
          illegalSample: bad.slice(0, 3).map(x => x.weekday + '@' + x.period + ':' + x.subject),
          page: pg.data.overview.filled, dirty: !!pg.dirty, route: pg.route
        };
      });
    });
  }, [OK_SUBJECTS, SCHED_PERIODS]);
  if (after.broken || after.route !== 'pages/schedule/schedule') record('S4', `保存回读时页面串路由或 overview 丢失：${after.route}`, after);
  if (after.cloud !== after.page) record('S7', `云端 ${after.cloud} 条 ≠ 页面已排 ${after.page} 节`, after);
  if (after.uniq !== after.fetched) record('S7', `云端有 ${after.fetched - after.uniq} 条同格重复（一格一课破了）`, after);
  if (after.illegal) record('S7', `云端有 ${after.illegal} 条非法 weekday/period/科目: ${JSON.stringify(after.illegalSample)}`, after);
  if (after.dirty) record('S8', '保存完成后 dirty 仍未清', after);

  // S8：再保存一次应被「没有改动」拦住
  const noop = await evalRetry(mp, () => {
    const pg = getCurrentPages().slice(-1)[0];
    let msg = '';
    const o = wx.showToast;
    wx.showToast = x => { msg = x.title; };
    pg.onSave();
    return new Promise(r => setTimeout(() => { wx.showToast = o; r({ msg }); }, 1200));
  });
  if (!/没有改动/.test(noop.msg)) record('S8', `无改动时未被拦住（toast="${noop.msg}"）`, noop);

  // 收尾：不许给用户留个空课表。分两步 + 回读复核（同 tick 套模板+保存实测无效）
  // 门槛用 SCHED_SLOTS（套模板的应有值）不用 0：乱按常留下十几节的半残课表，虽然不空，用户打开也是「表坏了」的观感
  let restored = after.cloud;
  for (let att = 0; att < 3 && restored < SCHED_SLOTS; att++) {
    await evalRetry(mp, () => { const pg = getCurrentPages().slice(-1)[0]; pg.onBackToWeek(); pg.onApplyTemplate(); return pg.data.overview.filled; });
    await sleep(1200);
    await evalRetry(mp, () => { const pg = getCurrentPages().slice(-1)[0]; pg.onSave(); return 1; });
    await waitSaved(mp);
    await sleep(1000);
    restored = await evalRetry(mp, () => wx.cloud.database().collection('schedule').count().then(c => c.total));
    console.log(`  收尾第 ${att + 1} 次：云端恢复到 ${restored} 条`);
  }
  if (restored < SCHED_SLOTS) record('S9', `红队跑完课表只剩 ${restored} 节（应 ${SCHED_SLOTS}），收尾恢复失败（用户会看到残表）`, { after });

  console.log(`  本轮结束：云端 ${restored} 条 / 页面 ${after.page} 节`);
}


/* ================= committee（班委名单）第三套守恒律 =================
 * 语义与 duty/schedule 都不同：12 个岗位、一岗最多两人、允许一人跨岗兼职（但 >2 要提醒）。
 * 所以不复用前两套的 snapshot/checkInvariants —— 复用只会逼着写「兼容两种语义」的
 * 松断言，那等于不测（duty→schedule 时已经立过这个规矩）。
 *   C1 overview.filled == posts 里非空岗位数
 *   C2 filled + empty == slots == 12
 *   C3 一岗最多两人：每个岗位 holders ≤ 2 且无同人重复，且最多一个 studentId
 *   C4 结构恒为 12 个岗位；任何动作都不许抛异常 / 让页面塌
 *   C5 pcls 恒为纯小写 ASCII；不许出现枚举外岗位名（中文进 class = wxss 全废）
 *   C6 warnList.length == keyEmpty + multi，且与页面数据复算一致
 *   C7 保存回读：云端条数 == filled，无同岗重复，无非法 post / 空 studentId
 *   C8 dirty 清后再保存必须提示「没有改动」
 *   C9 收尾必须恢复到 12 岗（门槛不写 ===0，schedule 的 S9 踩过：残表也是坏观感）
 */
const OK_POSTS = ['班长', '副班长', '学习委员', '纪律委员', '劳动委员', '文艺委员',
  '体育委员', '宣传委员', '生活委员', '语文科代表', '数学科代表', '英语科代表'];
const KEY3 = ['班长', '副班长', '学习委员'];
const COMM_MAX_HOLD = 2;      // 与页面 MAX_POSTS_PER_PERSON 同值，但这里是**独立复算**用

const COMM_ACTIONS = [
  { name: 'openPost-legal', run: 'var P=pg.data.posts||[];if(P.length)pg.onOpenPost({currentTarget:{dataset:{post:P[Math.floor(R*P.length)].post}}})', arg: () => ({ R: rnd() }) },
  { name: 'openPost-illegal', run: 'pg.onOpenPost({currentTarget:{dataset:{post:PICK}}})', arg: () => ({ PICK: pick(['扫地委员', '', '班长 ', 'MONITOR', null]) }) },
  { name: 'backToList', run: 'pg.onBackToList()', arg: () => ({}) },
  // 正常任命路径：进一个岗 → 点一个候选
  {
    name: 'assign-legal',
    run: `var P=pg.data.posts||[];
          if(P.length){pg.onOpenPost({currentTarget:{dataset:{post:P[Math.floor(R*P.length)].post}}});
            var C=pg.data.pool||[];
            if(C.length)pg.onAssign({currentTarget:{dataset:{id:C[Math.floor(R2*C.length)]._id}}});}`,
    arg: () => ({ R: rnd(), R2: rnd() })
  },
  { name: 'assign-ghost', run: "var P=pg.data.posts||[];if(P.length){pg.onOpenPost({currentTarget:{dataset:{post:P[0].post}}});pg.onAssign({currentTarget:{dataset:{id:'GHOST_NOT_EXIST'}}})}", arg: () => ({}) },
  /* 【红队不许越界】第一版写的是 `pg.setData({currentPost:''})` 再 onAssign —— 实测误报 C5：
   * 直接改内部渲染状态会造出「view=pick 但 currentPost 为空」这种**合法路径造不出**的形态
   * （onBackToList / onAssign 成功都会同时把 view 改回 list），等于自己造了个假 bug。
   * 改成用真实可达路径：点返回后重放一次任命（脏 dataset / 连点能造出来）。 */
  { name: 'assign-after-back', run: "pg.onBackToList();pg.onAssign({currentTarget:{dataset:{id:(pg.students&&pg.students[0]||{})._id}}})", arg: () => ({}) },
  { name: 'vacate', run: 'var F=(pg.data.posts||[]).filter(function(p){return !p.empty});if(F.length)pg.onVacate({currentTarget:{dataset:{post:F[Math.floor(R*F.length)].post}}})', arg: () => ({ R: rnd() }) },
  { name: 'vacate-empty', run: 'var E=(pg.data.posts||[]).filter(function(p){return p.empty});if(E.length)pg.onVacate({currentTarget:{dataset:{post:E[0].post}}})', arg: () => ({}) },
  { name: 'vacate-illegal', run: "pg.onVacate({currentTarget:{dataset:{post:'扫地委员'}}})", arg: () => ({}) },
  // 定向攻击 C3-超编：给同一个岗位连塞 3 个不同学生（第 3 人必须被拦，holders 恒 ≤ 2）
  {
    name: 'overfill-one-post',
    run: `var S=pg.students||[], P=pg.data.posts||[];
          if(S.length>=3&&P.length){var t=P[Math.floor(R*P.length)];
            pg.onBackToList(); pg.onVacate({currentTarget:{dataset:{post:t.post}}});
            var used={};
            for(var k=0;k<3;k++){var pool=S.filter(function(x){return !used[x._id]});
              var cand=pool[Math.floor(R2*pool.length)]||pool[0];
              used[cand._id]=1;
              pg.onOpenPost({currentTarget:{dataset:{post:t.post}}});
              pg.onAssign({currentTarget:{dataset:{id:cand._id}}});}}`,
    arg: () => ({ R: rnd(), R2: rnd() })
  },
  // 定向攻击 C3-同人重复：同一个人连续两次任命到同一岗位（第二次必须被拦）
  {
    name: 'dup-same-post',
    run: `var S=pg.students||[], P=pg.data.posts||[];
          if(S.length&&P.length){var t=P[Math.floor(R*P.length)], sid=S[Math.floor(R2*S.length)]._id;
            pg.onOpenPost({currentTarget:{dataset:{post:t.post}}});
            pg.onAssign({currentTarget:{dataset:{id:sid}}});
            pg.onOpenPost({currentTarget:{dataset:{post:t.post}}});
            pg.onAssign({currentTarget:{dataset:{id:sid}}});}`,
    arg: () => ({ R: rnd(), R2: rnd() })
  },
  { name: 'toggleFilter', run: 'pg.onToggleFilter()', arg: () => ({}) },
  { name: 'recommend', run: 'pg.onRecommend()', arg: () => ({}), weight: 0.4 },
  // 定向攻击 C6-兼岗告警：把同一个人塞进 3 个岗位。纯随机撞不出来
  // （30 个学生 × 12 个岗位，随机任命几乎不会让同一人拿到 3 个岗），
  // 而 comm-warn-off 这类「告警阈值被改坏」的 bug 只有在这个形态下才可观测。
  {
    name: 'stack-multi-post',
    run: `var S=pg.students||[], P=pg.data.posts||[];
          if(S.length&&P.length>=3){var sid=S[Math.floor(R*S.length)]._id;
            for(var k=0;k<3;k++){var t=P[(Math.floor(R2*P.length)+k)%P.length];
              pg.onVacate({currentTarget:{dataset:{post:t.post}}});
              pg.onOpenPost({currentTarget:{dataset:{post:t.post}}});
              pg.onAssign({currentTarget:{dataset:{id:sid}}});}}`,
    arg: () => ({ R: rnd(), R2: rnd() })
  },
  // 定向攻击 C6-核心岗告警：把 3 个核心岗全撤掉（keyEmpty 应该变 3）
  {
    name: 'vacate-key-posts',
    run: `pg.onBackToList();
          ['班长','副班长','学习委员'].forEach(function(x){
            pg.onVacate({currentTarget:{dataset:{post:x}}});});`,
    arg: () => ({}), weight: 0.3
  },
  { name: 'clearAll', run: 'var o=wx.showModal;wx.showModal=function(x){x.success&&x.success({confirm:true})};pg.onBackToList();pg.onClearAll();wx.showModal=o', arg: () => ({}), weight: 0.3 },
  { name: 'clearAll-cancel', run: 'var o=wx.showModal;wx.showModal=function(x){x.success&&x.success({confirm:false})};pg.onClearAll();wx.showModal=o', arg: () => ({}) }
];

async function snapshotComm(mp) {
  return evalRetry(mp, () => {
    const pg = getCurrentPages().slice(-1)[0];
    if (!pg || !pg.data || !pg.data.posts) return { broken: true, route: pg && pg.route };
    const posts = pg.data.posts;
    const ov = pg.data.overview || {};
    const OKP = ['班长', '副班长', '学习委员', '纪律委员', '劳动委员', '文艺委员',
      '体育委员', '宣传委员', '生活委员', '语文科代表', '数学科代表', '英语科代表'];
    const K3 = ['班长', '副班长', '学习委员'];
    const stuIds = {};
    (pg.students || []).forEach(s => { stuIds[s._id] = s; });

    let cellSum = 0;
    const badCls = [];
    const badPost = [];
    const ghost = [];
    const hold = {};
    const nameSeen = {};
    const overfill = [];      // 某岗 holders > 2
    const dupInPost = [];     // 同岗内重复 studentId
    let pairSum = 0;
    posts.forEach(p => {
      if (!/^[a-z]+$/.test(String(p.pcls || ''))) badCls.push(p.post + '->' + p.pcls);
      if (OKP.indexOf(p.post) < 0) badPost.push(String(p.post));
      nameSeen[p.post] = (nameSeen[p.post] || 0) + 1;
      const hs = Array.isArray(p.holders) ? p.holders : [];
      const ids = hs.map(h => h.studentId);
      if (ids.length > 2) overfill.push(p.post + '×' + ids.length);
      if (new Set(ids).size !== ids.length) dupInPost.push(p.post);
      // 渲染口径自洽：empty/full/count 必须和 holders 长度一致
      if (p.empty !== (ids.length === 0)) ghost.push('FLAG:' + p.post);
      pairSum += ids.length;
      if (!ids.length) return;
      cellSum += 1;
      ids.forEach(id => {
        if (!stuIds[id]) ghost.push(p.post + '@' + id);
        hold[id] = (hold[id] || 0) + 1;   // 跨岗计数（同岗内不应有重复，见 dupInPost）
      });
    });
    // 告警复算（与页面实现无关：只用 posts 数据按两条规则算）
    const keyEmptyReal = posts.filter(p => p.empty && K3.indexOf(p.post) >= 0).length;
    const multiReal = Object.keys(hold).filter(k => hold[k] > 2).length;

    return {
      broken: false,
      view: pg.data.view,
      nPosts: posts.length,
      dupPostRows: Object.keys(nameSeen).filter(k => nameSeen[k] > 1),
      cellSum, pairSum, overfill, dupInPost, badCls, badPost, ghost,
      filled: ov.filled, empty: ov.empty, slots: ov.slots,
      keyEmpty: ov.keyEmpty, multi: ov.multi,
      warns: (pg.data.warnList || []).length,
      warnKeys: (pg.data.warnList || []).map(w => w.key),
      keyEmptyReal, multiReal,
      idle: (pg.data.idleList || []).length,
      students: (pg.students || []).length,
      holders: Object.keys(hold).length,
      curPost: pg.data.currentPost,
      pool: (pg.data.pool || []).length,
      dirty: !!pg.dirty
    };
  });
}

function checkCommInvariants(s, ctx) {
  if (s.broken) { record('C4', '页面结构崩了（posts 不见了）', s); return; }
  if (s.nPosts !== 12) record('C4', `岗位数坏了 nPosts=${s.nPosts}`, ctx);
  if (s.dupPostRows.length) record('C4', `同一岗位出现多行: ${s.dupPostRows.join(',')}`, ctx);
  if (s.overfill.length) record('C3', `岗位超过 2 人: ${s.overfill.join(',')}`, ctx);
  if (s.dupInPost.length) record('C3', `同岗内重复任命同一人: ${s.dupInPost.join(',')}`, ctx);
  if (s.filled !== s.cellSum) record('C1', `已定 ${s.filled} ≠ 岗位求和 ${s.cellSum}`, ctx);
  if (s.slots !== 12 || s.filled + s.empty !== s.slots) record('C2', `口径不闭合 slots=${s.slots} filled=${s.filled} empty=${s.empty}`, ctx);
  if (s.badCls.length) record('C5', `岗位类名非 ASCII: ${s.badCls.slice(0, 3).join(', ')}`, ctx);
  if (s.badPost.length) record('C5', `出现枚举外岗位: ${s.badPost.slice(0, 3).join(', ')}`, ctx);
  if (s.ghost.length) record('C7', `岗位上挂着不存在的学生: ${s.ghost.slice(0, 3).join(', ')}`, ctx);
  if (s.warns !== s.keyEmpty + s.multi) record('C6', `告警清单 ${s.warns} ≠ keyEmpty ${s.keyEmpty} + multi ${s.multi}`, ctx);
  if (s.keyEmpty !== s.keyEmptyReal) record('C6', `核心岗空缺计数漂移: 页面 ${s.keyEmpty} 复算 ${s.keyEmptyReal}`, ctx);
  if (s.multi !== s.multiReal) record('C6', `兼岗告警计数漂移: 页面 ${s.multi} 复算 ${s.multiReal}`, ctx);
  if (new Set(s.warnKeys).size !== s.warnKeys.length) record('C6', `告警 key 重复（wx:key 会渲染错位）: ${s.warnKeys.join(',')}`, ctx);
  // 未任职名单必须等于「全班 - 有岗的人数」（兼岗的人只算一次）
  if (s.idle !== s.students - s.holders) record('C1', `未任职名单不闭合 idle=${s.idle} 全班=${s.students} 任职=${s.holders}`, ctx);
  if (s.view === 'pick' && OK_POSTS.indexOf(s.curPost) < 0) record('C5', `挑人视图停在枚举外岗位「${s.curPost}」`, ctx);
}

async function runCommRound(mp, seed) {
  SEED = seed;
  reseed(seed);
  console.log(`\n──── [班委] 第 ${seed} 号种子，${STEPS} 步 ────`);
  for (let i = 0; i < 3; i++) {
    await mp.reLaunch('/pages/dashboard/dashboard').catch(() => 0);
    await sleep(1200);
    const d = await mp.evaluate(() => getCurrentPages().length).catch(() => -1);
    if (d === 1) break;
  }
  await mp.reLaunch('/pages/committee/committee');
  await sleep(4000);

  // 起始形态随机化：满岗时「任命」会被「已经是他/她了」吸收，空岗时又测不到覆盖/兼岗
  const startMode = pick(['empty', 'full', 'half', 'asis']);
  console.log('  起始形态: ' + startMode);
  await evalRetry(mp, new Function('M', `const pg=getCurrentPages().slice(-1)[0];
    const _t=wx.showToast, _m=wx.showModal;
    wx.showToast=function(){}; wx.showModal=function(x){x.success&&x.success({confirm:true})};
    try {
      if (M === 'empty') { pg.onBackToList(); pg.onClearAll(); }
      else if (M === 'full') { pg.onRecommend(); }
      else if (M === 'half') {
        pg.onBackToList(); pg.onClearAll(); pg.onRecommend();
        pg.data.posts.forEach(function(p, i) {
          if (i % 2) pg.onVacate({currentTarget:{dataset:{post:p.post}}});
        });
      }
    } finally { wx.showToast=_t; wx.showModal=_m; }
    return 1;`), [startMode]);
  await sleep(1500);

  let s = await snapshotComm(mp);
  checkCommInvariants(s, { step: 0, action: 'init' });
  console.log(`  起始: 已定 ${s.filled}/${s.slots} / 告警 ${s.warns}`);

  const log = [];
  let sawMulti = 0, sawKeyEmpty = 0;
  for (let i = 1; i <= STEPS; i++) {
    let act = pick(COMM_ACTIONS);
    if (act.weight && rnd() > act.weight) act = COMM_ACTIONS[0];
    const args = act.arg();
    log.push(act.name);
    try {
      await evalRetry(mp, new Function('A', `const pg=getCurrentPages().slice(-1)[0];if(!pg)return 0;
        const R=A.R,R2=A.R2,PICK=A.PICK;
        const _t=wx.showToast; wx.showToast=function(){};
        try { ${act.run} } finally { wx.showToast=_t; }
        return 1;`), [args]);
    } catch (e) {
      record('C4', `动作 ${act.name} 抛异常: ${(e.message || e).slice(0, 80)}`, { step: i, args });
    }
    s = await snapshotComm(mp);
    checkCommInvariants(s, { step: i, action: act.name, args, last5: log.slice(-5) });
    if (s.multi > 0) sawMulti++;
    if (s.keyEmpty > 0) sawKeyEmpty++;
    if (i % 10 === 0) console.log(`  …第 ${i}/${STEPS} 步（已定 ${s.filled}，告警 ${s.warns}，dirty=${s.dirty}）`);
  }
  // 覆盖自检：两类告警形态一次都没出现过，说明这轮的 C6 全是 0==0，等于没测
  if (!sawMulti || !sawKeyEmpty) {
    console.log(`  ⚠️ 覆盖不足：兼岗告警出现 ${sawMulti} 步 / 核心岗空缺出现 ${sawKeyEmpty} 步 —— C6 这轮判定力弱`);
  }

  // C7：乱按完保存，云端必须与页面逐项对得上
  console.log('  乱按结束，保存并回读校验云端一致性…');
  await evalRetry(mp, () => { const pg = getCurrentPages().slice(-1)[0]; pg.onSave(); return 1; });
  await waitSaved(mp);
  await sleep(1500);            // _busy 回落后给云端读视图收敛时间，避免读到迁移残影
  const after = await evalRetry(mp, () => {
    const pg = getCurrentPages().slice(-1)[0];
    if (!pg || !pg.data || !pg.data.overview) return { broken: true, route: pg && pg.route };
    const d = wx.cloud.database();
    return d.collection('committee').count().then(({ total }) => {
      const readAll = async (skip, out) => {
        const r = await d.collection('committee').skip(skip).limit(20).get();
        out.push(...r.data);
        return (r.data.length < 20 || out.length >= total) ? out : readAll(skip + 20, out);
      };
      return readAll(0, []).then(all => {
        const OKP = ['班长', '副班长', '学习委员', '纪律委员', '劳动委员', '文艺委员',
          '体育委员', '宣传委员', '生活委员', '语文科代表', '数学科代表', '英语科代表'];
        const stuIds = new Set((pg.students || []).map(x => x._id));
        const bad = all.filter(x => OKP.indexOf(String(x.post || '')) < 0
          || !String(x.studentId || '').trim() || !stuIds.has(x.studentId));
        // 一岗最多两人 + 同 post@sid 唯一
        const byPost = {};
        const pairSeen = {};
        const dupPairs = [];
        all.forEach(x => {
          const post = String(x.post || '');
          byPost[post] = (byPost[post] || 0) + 1;
          const k = post + '@' + x.studentId;
          if (pairSeen[k]) dupPairs.push(k);
          pairSeen[k] = 1;
        });
        const overPosts = Object.keys(byPost).filter(k => byPost[k] > 2);
        // 页面目标：posts.holders 展平成 post@sid 集合
        const pagePairs = [];
        (pg.data.posts || []).forEach(p => (p.holders || []).forEach(h => pagePairs.push(p.post + '@' + h.studentId)));
        const cloudSet = new Set(all.map(x => String(x.post || '') + '@' + x.studentId));
        const pageSet = new Set(pagePairs);
        const mismatch = pagePairs.filter(k => !cloudSet.has(k)).length
          + all.filter(x => !pageSet.has(String(x.post || '') + '@' + x.studentId)).length;
        return {
          cloud: total, fetched: all.length,
          overPosts, dupPairs, illegal: bad.length, mismatch,
          page: pg.data.overview.filled, pagePairs: pagePairs.length,
          dirty: !!pg.dirty, route: pg.route
        };
      });
    });
  });
  if (after.broken || after.route !== 'pages/committee/committee') record('C4', `保存回读时页面串路由或 overview 丢失：${after.route}`, after);
  if (after.overPosts.length) record('C3', `云端这些岗位超过 2 人: ${after.overPosts.join(',')}`, after);
  if (after.dupPairs.length) record('C3', `云端有同 post@sid 重复: ${after.dupPairs.slice(0,3).join(',')}`, after);
  if (after.cloud !== after.pagePairs) record('C7', `云端 ${after.cloud} 条 ≠ 页面任职 ${after.pagePairs} 条`, after);
  if (after.mismatch) record('C7', `云端与页面任职对不一致（${after.mismatch} 处）`, after);
  if (after.illegal) record('C7', `云端有 ${after.illegal} 条非法 post / 空或孤儿 studentId`, after);
  if (after.dirty) record('C8', '保存完成后 dirty 仍未清', after);

  // C8：再保存一次应被「没有改动」拦住
  const noop = await evalRetry(mp, () => {
    const pg = getCurrentPages().slice(-1)[0];
    let msg = '';
    const o = wx.showToast;
    wx.showToast = x => { msg = x.title; };
    pg.onSave();
    return new Promise(r => setTimeout(() => { wx.showToast = o; r({ msg }); }, 1200));
  });
  if (!/没有改动/.test(noop.msg)) record('C8', `无改动时未被拦住（toast="${noop.msg}"）`, noop);

  // 收尾：恢复到标准形态——清空再推荐，云端必须恰好 12 条（一岗一人）。
  // 一岗最多两人后乱按可能留下 18+ 条，光「填空缺」不会回收多余的人，必须先清空。
  let restored = after.cloud;
  for (let att = 0; att < 3 && restored !== 12; att++) {
    await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      const _t = wx.showToast, _m = wx.showModal;
      wx.showToast = () => {}; wx.showModal = x => { x.success && x.success({ confirm: true }); };
      pg.onBackToList(); pg.onClearAll(); pg.onRecommend();
      wx.showToast = _t; wx.showModal = _m;
      return pg.data.overview.filled;
    });
    await sleep(1200);
    await evalRetry(mp, () => { const pg = getCurrentPages().slice(-1)[0]; pg.onSave(); return 1; });
    await waitSaved(mp);
    await sleep(1000);
    restored = await evalRetry(mp, () => wx.cloud.database().collection('committee').count().then(c => c.total));
    console.log(`  收尾第 ${att + 1} 次：云端恢复到 ${restored} 条`);
  }
  if (restored !== 12) record('C9', `红队跑完班委云端 ${restored} 条（标准态应为 12），收尾恢复失败`, { after });

  console.log(`  本轮结束：云端 ${restored} 条 / 页面 ${after.page} 岗`);
}

(async () => {
  const TARGET = process.env.TARGET || 'all';
  console.log(`红队乱序攻击：目标 ${TARGET}，${ROUNDS} 轮 × ${STEPS} 步，基准种子 ${BASE_SEED}`);
  const { mp } = await connectOrLaunch(Number(process.env.AUTO_PORT || 9491));
  let crashed = null;
  try {
    for (let r = 0; r < ROUNDS; r++) {
      // 每轮换种子：单种子覆盖不足会漏真 bug（实测 SEED=1337 漏、SEED=7 抓到）
      const seed = (BASE_SEED + r * 7919) % 100000;
      if (TARGET === 'all' || TARGET === 'duty') await runRound(mp, seed);
      if (TARGET === 'all' || TARGET === 'schedule') await runSchedRound(mp, seed);
      if (TARGET === 'all' || TARGET === 'committee') await runCommRound(mp, seed);
    }
  } catch (e) {
    crashed = e;
    console.error('FATAL', e.message || e);
  } finally {
    await mp.disconnect();     // 绝不 close()，会关掉用户的 IDE 窗口
  }

  console.log('\n================ 红队报告 ================');
  console.log(`目标 ${TARGET}，${ROUNDS} 轮 × ${STEPS} 步，基准种子 ${BASE_SEED}`);
  if (crashed) { console.log('❌ 中途崩溃: ' + (crashed.message || crashed)); process.exit(2); }
  if (!findings.length) { console.log('✅ 全部守恒律通过，没找到破绽'); process.exit(0); }
  console.log(`❌ 发现 ${findings.length} 类问题：`);
  findings.forEach(f => console.log(`  [${f.rule}] ${f.detail}\n       种子 ${f.seed} / ${JSON.stringify(f.ctx)}`));
  console.log(`\n复现: TARGET=${TARGET} SEED=${findings[0].seed} ROUNDS=1 node tools/redteam.js ${STEPS}`);
  process.exit(1);
})();
