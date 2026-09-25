#!/usr/bin/env node
/**
 * 真机边界探针（连开发者工具自动化端口，跑在真实模拟器 + 真实云库上）。
 *
 * 与 tools/test-boundary.js 的分工：
 *   test-boundary.js  纯 Node 直调 utils/validate.js —— 验「规则本身对不对」，<0.1s，进 ship 门禁
 *   probe-boundary.js 真机跑页面事件 + 读云库回读 —— 验「页面到底走没走那条规则」，约 2min
 *
 * 为什么必须两个都有（2026-09-06 实测教训）：
 *   grades 页的 `1e2` 在 validate 里是被拒的，但页面先 `Number(raw)` 转成 100 再送校验，
 *   规则单测全绿、真机照样入库。**规则对 ≠ 页面用了规则。**
 *
 * 判定标准是「库里到底存了什么」，不是「页面提示了什么」：
 *   每条用例都 触发保存 → 读云端 → 立刻清理，toast 只当辅助信息（劫持 wx.showToast 取得）。
 *
 * 用法: node tools/probe-boundary.js [模块名...]
 *   模块: rewards announcement roster grades profile homework attendance duty settings
 *   不传 = 全跑。exit 1 = 有用例的实际行为与期望不符。
 */
const { connectOrLaunch, sleep } = require('./mp.js');

const pass = [];
const fail = [];
function ok(m) { pass.push(m); console.log('  ✅ ' + m); }
function bad(m) { fail.push(m); console.log('  ❌ ' + m); }

// verdict: 'reject' = 期望被拦（库里不该出现记录）; 'accept' = 期望正常入库
function judge(label, expect, wrote, detail) {
  const actual = wrote ? 'accept' : 'reject';
  const msg = `${label} → ${actual === 'reject' ? '拒绝' : '入库'}${detail ? ' :: ' + detail : ''}`;
  if (actual === expect) ok(msg); else bad(msg + `（期望${expect === 'reject' ? '拒绝' : '入库'}）`);
}

const TABS = ['pages/dashboard/dashboard', 'pages/roster/roster', 'pages/attendance/attendance',
  'pages/announcement/announcement', 'pages/grades/grades'];

async function goto(mp, route, wait = 2400) {
  const isTab = TABS.includes(route.replace(/^\//, ''));
  for (let i = 0; i < 3; i++) {
    try {
      if (isTab) await mp.switchTab(route); else await mp.reLaunch(route);
      await sleep(800);
      const p = await mp.currentPage();
      if (p && p.path && p.path.replace(/^\//, '') === route.replace(/^\//, '')) {
        await mp.evaluate(() => {
          const pg = getCurrentPages().slice(-1)[0];
          if (pg && typeof pg.refresh === 'function') pg.refresh();
          else if (pg && typeof pg.load === 'function') pg.load();
        }).catch(() => {});
        await sleep(wait);
        return p;
      }
    } catch (e) { /* retry */ }
    await sleep(1000);
  }
  throw new Error('无法跳转到 ' + route);
}

// 劫持 toast/modal：很多校验只 toast 不改 data，读 data 看不出被拦没被拦
async function install(mp) {
  await mp.evaluate(() => {
    if (!wx.__probeInstalled) {
      const st = wx.showToast, sm = wx.showModal;
      wx.showToast = function (o) { (wx.__probeLog = wx.__probeLog || []).push('toast:' + (o && o.title)); return st.call(wx, o); };
      wx.showModal = function (o) { (wx.__probeLog = wx.__probeLog || []).push('modal:' + (o && o.title)); return sm.call(wx, o); };
      wx.__probeInstalled = true;
    }
    wx.__probeLog = [];
    return 1;
  });
}

/* ---------------- 各模块用例 ---------------- */

async function probeRewards(mp) {
  console.log('\n[rewards] 积分数值边界（Number() 的隐式转换是本轮所有数值 bug 的根因）');
  await goto(mp, '/pages/rewards/rewards');
  const stu = await mp.evaluate(() => {
    const pg = getCurrentPages().slice(-1)[0];
    return (pg.data.students || []).slice(0, 1).map(s => s._id);
  });
  if (!stu.length) { bad('rewards 前置：页面没有学生'); return; }
  const cases = [
    ['空积分', '', 'reject'], ['0 分', '0', 'reject'], ['纯空格', '   ', 'reject'],
    ['前导零 007', '007', 'reject'], ['十六进制 0x10', '0x10', 'reject'],
    ['带加号 +8', '+8', 'reject'], ['科学计数 1e5', '1e5', 'reject'],
    ['小数 2.5', '2.5', 'reject'], ['中文数字 五', '五', 'reject'],
    ['Infinity', 'Infinity', 'reject'], ['超上限 101', '101', 'reject'],
    ['极大 999999', '999999', 'reject'], ['上限 100', '100', 'accept'], ['正常 5', '5', 'accept']
  ];
  for (const [label, val, expect] of cases) {
    const r = await mp.evaluate(async (sid, val) => {
      const pg = getCurrentPages().slice(-1)[0];
      const d = wx.cloud.database();
      wx.__probeLog = [];
      pg.setData({ showForm: true, isEdit: false, typeIndex: 0,
        form: { _id: '', studentId: sid, type: '奖励', reason: 'PROBE边界', pointsInput: val, date: '2026-09-06' } });
      try { await pg.onFormSave(); } catch (e) { wx.__probeLog.push('throw:' + (e && e.message)); }
      await new Promise(r => setTimeout(r, 1200));
      const rows = (await d.collection('rewards').where({ reason: 'PROBE边界' }).get()).data;
      for (const x of rows) await d.collection('rewards').doc(x._id).remove();
      pg.setData({ showForm: false });
      return { log: wx.__probeLog.slice(), n: rows.length };
    }, stu[0], val);
    judge('积分 ' + label, expect, r.n > 0, (r.log || []).join('|'));
  }
}

async function probeAnnouncement(mp) {
  console.log('\n[announcement] 文本长度（wxml 的 maxlength 只挡键盘，setData/粘贴能绕过）');
  await goto(mp, '/pages/announcement/announcement');
  const cases = [
    ['纯空格标题', '   ', '正文', 'reject'],
    ['纯换行正文', 'PROBE标题A', '\n\n\n', 'reject'],
    ['标题 500 字', 'T'.repeat(500), '正文', 'reject'],
    ['正文 20000 字', 'PROBE标题B', 'X'.repeat(20000), 'reject'],
    ['正常通知', 'PROBE标题C', '早 7:30 到操场集合', 'accept']
  ];
  for (const [label, t, c, expect] of cases) {
    const r = await mp.evaluate(async (t, c) => {
      const pg = getCurrentPages().slice(-1)[0];
      const d = wx.cloud.database();
      wx.__probeLog = [];
      pg.setData({ showForm: true, form: { title: t, content: c, priority: '中', date: '2026-09-06' } });
      try { await pg.onFormSave(); } catch (e) { wx.__probeLog.push('throw:' + (e && e.message)); }
      await new Promise(r => setTimeout(r, 1200));
      const rows = (await d.collection('announcements').where({ title: String(t).trim() }).get()).data;
      for (const x of rows) await d.collection('announcements').doc(x._id).remove();
      pg.setData({ showForm: false });
      return { log: wx.__probeLog.slice(), n: rows.length };
    }, t, c);
    judge('公告 ' + label, expect, r.n > 0, (r.log || []).join('|'));
  }
}

async function probeRoster(mp) {
  console.log('\n[roster] 学号/姓名（学号是 5 个模块的外键，错了不报错）');
  await goto(mp, '/pages/roster/roster');
  const cases = [
    ['学号 200 位', '9'.repeat(200), 'PROBE甲', 'reject'],
    ['学号带空格 5 5', ' 5 5 ', 'PROBE乙', 'reject'],
    ['学号负号 -1', '-1', 'PROBE丙', 'reject'],
    ['姓名 200 字', 'P9001', 'P'.repeat(200), 'reject'],
    ['姓名纯空格', 'P9002', '   ', 'reject'],
    ['学号 007 前导零', 'P9003', 'PROBE丁', 'accept'],
    ['学号纯字母', 'PABC', 'PROBE戊', 'accept']
  ];
  for (const [label, no, nm, expect] of cases) {
    const r = await mp.evaluate(async (no, nm) => {
      const pg = getCurrentPages().slice(-1)[0];
      const d = wx.cloud.database();
      wx.__probeLog = [];
      pg.setData({ showForm: true, isEdit: false, genderIndex: 0, form: { _id: '', studentNo: no, name: nm, gender: '男' } });
      try { await pg.onFormSave(); } catch (e) { wx.__probeLog.push('throw:' + (e && e.message)); }
      await new Promise(r => setTimeout(r, 1400));
      const rows = (await d.collection('students').where({ name: String(nm).trim() }).get()).data;
      for (const x of rows) await d.collection('students').doc(x._id).remove();
      pg.setData({ showForm: false });
      return { log: wx.__probeLog.slice(), n: rows.length };
    }, no, nm);
    judge('名单 ' + label, expect, r.n > 0, (r.log || []).join('|'));
  }

  console.log('\n[roster] 超长学号不许污染 AI 导名单的起始学号');
  const ai = await mp.evaluate(async () => {
    const pg = getCurrentPages().slice(-1)[0];
    const d = wx.cloud.database();
    const id = (await d.collection('students').add({ data: { studentNo: '99999999999', name: 'PROBE巨号', gender: '男', _probe: true, updatedAt: Date.now() } }))._id;
    await pg.refresh();
    await new Promise(r => setTimeout(r, 1500));
    pg.openAiConfirm([{ name: '张边界' }, { name: '李边界' }]);
    const nos = (pg.data.aiRows || []).map(r => r.no);
    const start = String(pg.data.aiStartNo);
    pg.setData({ aiShow: false });
    await d.collection('students').doc(id).remove();
    await pg.refresh();
    return { start, nos };
  });
  const clean = /^\d{1,5}$/.test(ai.start) && ai.nos.every(n => /^\d{1,6}$/.test(n));
  clean ? ok(`AI 起始学号 ${ai.start}，分配 ${JSON.stringify(ai.nos)}（无科学计数污染）`)
        : bad(`AI 起始学号被污染：${ai.start} → ${JSON.stringify(ai.nos)}`);
}

async function probeGrades(mp) {
  console.log('\n[grades] 满分/分数（原始字符串必须直送 validate，先 Number() 会放过 1e2）');
  await goto(mp, '/pages/grades/grades');
  const cases = [
    ['满分 0', '0', '10', 'reject'], ['满分留空', '', '50', 'reject'],
    ['满分 -100', '-100', '50', 'reject'], ['满分 151', '151', '150', 'reject'],
    ['分数超满分', '100', '120', 'reject'], ['分数负数', '100', '-5', 'reject'],
    ['分数 2 位小数', '100', '88.55', 'reject'], ['分数 1e2', '100', '1e2', 'reject'],
    ['分数纯空格', '100', '   ', 'reject'],
    ['满分 150 边界', '150', '150', 'accept'], ['半分 88.5', '100', '88.5', 'accept']
  ];
  for (const [label, full, score, expect] of cases) {
    const r = await mp.evaluate(async (full, score) => {
      const pg = getCurrentPages().slice(-1)[0];
      const d = wx.cloud.database();
      wx.__probeLog = [];
      const stu = (pg.data.rows || [])[0];
      if (!stu) return { log: ['页面没有学生行'], n: 0 };
      pg.setData({ full: full });
      if (typeof pg.onFullInput === 'function') pg.onFullInput({ detail: { value: full } });
      pg.onScoreInput({ currentTarget: { dataset: { id: stu._id } }, detail: { value: score } });
      try { await pg.onSave(); } catch (e) { wx.__probeLog.push('throw:' + (e && e.message)); }
      await new Promise(r => setTimeout(r, 1500));
      const rows = (await d.collection('scores').where({ studentId: stu._id }).get()).data
        .filter(x => x.updatedAt > Date.now() - 8000);
      for (const x of rows) await d.collection('scores').doc(x._id).remove();
      pg.dirty = {};
      return { log: wx.__probeLog.slice(), n: rows.length, vals: rows.map(x => x.score + '/' + x.full) };
    }, full, score);
    judge('成绩 ' + label, expect, r.n > 0, (r.log || []).join('|'));
  }
}

async function probeProfile(mp) {
  console.log('\n[profile] 档案 + full=0 除零（|| 默认值 用在业务数值上就是替用户猜）');
  await goto(mp, '/pages/profile/profile', 2800);
  const dz = await mp.evaluate(async () => {
    const pg = getCurrentPages().slice(-1)[0];
    const d = wx.cloud.database();
    const stu = (pg.data.students || [])[0];
    if (!stu) return { err: '页面没有学生' };
    pg.onOpenDetail({ currentTarget: { dataset: { id: stu._id } } });
    await new Promise(r => setTimeout(r, 2600));
    const before = String((pg.data.stats || {}).avgPct);
    const bad = (await d.collection('scores').add({ data: { studentId: stu._id, subject: '语文', exam: 'PROBE零', score: 50, full: 0, updatedAt: Date.now() } }))._id;
    pg.onOpenDetail({ currentTarget: { dataset: { id: stu._id } } });
    await new Promise(r => setTimeout(r, 2600));
    const after = String((pg.data.stats || {}).avgPct);
    const badCount = (pg.data.stats || {}).badFullCount;
    await d.collection('scores').doc(bad).remove();
    return { before, after, badCount };
  });
  if (dz.err) bad('profile 前置：' + dz.err);
  else if (dz.before === dz.after && dz.badCount >= 1) ok(`full=0 的脏成绩不影响均分（${dz.before} → ${dz.after}，标记 ${dz.badCount} 条）`);
  else bad(`full=0 的脏成绩污染了均分：${dz.before} → ${dz.after}（badFullCount=${dz.badCount}）`);

  const cases = [
    ['出生日 2011-13-45', '2011-13-45', '', 'reject'],
    ['出生日 0000-00-00', '0000-00-00', '', 'reject'],
    ['出生日 2011-2-1 非补零', '2011-2-1', '', 'reject'],
    ['出生日 2099-01-01 未来', '2099-01-01', '', 'reject'],
    ['家长 10 位号', '', '妈妈 1390000888', 'reject'],
    ['家长 12 位号', '', '妈妈 139000088888', 'reject'],
    ['家长无号码', '', '妈妈', 'reject'],
    ['正常档案', '2011-05-20', '妈妈 13900008888', 'accept']
  ];
  for (const [label, birth, parent, expect] of cases) {
    const r = await mp.evaluate(async (birth, parent) => {
      const pg = getCurrentPages().slice(-1)[0];
      const d = wx.cloud.database();
      const cur = (pg.data.students || [])[0];
      if (!cur) return { log: ['页面没有学生'], changed: false };
      const before = (await d.collection('students').doc(cur._id).get()).data;
      wx.__probeLog = [];
      pg.setData({ showForm: true, form: { _id: cur._id, name: cur.name, studentNo: cur.studentNo, birth, parent, health: '', tagSet: [] } });
      try { await pg.onFormSave(); } catch (e) { wx.__probeLog.push('throw:' + (e && e.message)); }
      await new Promise(r => setTimeout(r, 1400));
      const after = (await d.collection('students').doc(cur._id).get()).data;
      const changed = String(after.birth || '') === String(birth || '').trim()
        && String(after.parent || '') === String(parent || '').trim();
      await d.collection('students').doc(cur._id).update({ data: { birth: before.birth || '', parent: before.parent || '', health: before.health || '', tags: before.tags || [] } });
      pg.setData({ showForm: false });
      return { log: wx.__probeLog.slice(), changed };
    }, birth, parent);
    judge('档案 ' + label, expect, r.changed, (r.log || []).join('|'));
  }
}

async function probeHomework(mp) {
  console.log('\n[homework] 截止日期（只验格式会放过不存在的日期和 3000 年）');
  await goto(mp, '/pages/homework/homework');
  const today = new Date();
  const soon = new Date(Date.now() + 7 * 86400000);
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const cases = [
    ['截止 2999-12-31', fmt(today), '2999-12-31', 'reject'],
    ['截止 2026-9-6 非补零', fmt(today), '2026-9-6', 'reject'],
    ['截止 2026-02-30 不存在', fmt(today), '2026-02-30', 'reject'],
    ['截止早于布置', fmt(today), '1900-01-01', 'reject'],
    ['标题 300 字', fmt(today), fmt(soon), 'reject'],
    ['正常一周后到期', fmt(today), fmt(soon), 'accept']
  ];
  for (const [label, ad, dd, expect] of cases) {
    const r = await mp.evaluate(async (label, ad, dd) => {
      const pg = getCurrentPages().slice(-1)[0];
      const d = wx.cloud.database();
      const title = label === '标题 300 字' ? 'H'.repeat(300) : 'PROBE作业' + label;
      wx.__probeLog = [];
      pg.setData({ showForm: true, isEdit: false, form: { _id: '', subject: '语文', title: title, content: 'x', assignDate: ad, dueDate: dd } });
      try { await pg.onFormSave(); } catch (e) { wx.__probeLog.push('throw:' + (e && e.message)); }
      await new Promise(r => setTimeout(r, 1300));
      const rows = (await d.collection('homework').where({ title: title }).get()).data;
      for (const x of rows) await d.collection('homework').doc(x._id).remove();
      pg.setData({ showForm: false });
      return { log: wx.__probeLog.slice(), n: rows.length };
    }, label, ad, dd);
    judge('作业 ' + label, expect, r.n > 0, (r.log || []).join('|'));
  }
}

async function probeAttendance(mp) {
  console.log('\n[attendance] 同人同日只许一条 + 枚举外状态不上屏');
  await goto(mp, '/pages/attendance/attendance');
  const r = await mp.evaluate(async () => {
    const pg = getCurrentPages().slice(-1)[0];
    const d = wx.cloud.database();
    const stu = (pg.data.students || [])[0];
    if (!stu) return { err: '页面没有学生' };
    const date = pg.data.date;
    const pre = (await d.collection('attendance').where({ studentId: stu._id, date }).get()).data;
    const preIds = pre.map(x => x._id);
    // 直插一条（模拟另一台设备已经登记过），本地 attendanceId 仍是空
    await d.collection('attendance').add({ data: { studentId: stu._id, date, status: '迟到', _probe: true, updatedAt: Date.now() } });
    wx.__probeLog = [];
    pg.onStatusTap({ currentTarget: { dataset: { id: stu._id, status: '请假' } } });
    await pg.onSave();
    await new Promise(r => setTimeout(r, 2000));
    const after = (await d.collection('attendance').where({ studentId: stu._id, date }).get()).data;
    // 枚举外状态
    await d.collection('attendance').add({ data: { studentId: stu._id, date, status: 'PROBE怪状态', _probe: true, updatedAt: Date.now() + 5000 } });
    await pg.refresh();
    await new Promise(r => setTimeout(r, 1600));
    const shown = (pg.data.students.find(s => s._id === stu._id) || {}).status;
    const all = (await d.collection('attendance').where({ studentId: stu._id, date }).get()).data;
    for (const x of all) if (preIds.indexOf(x._id) < 0) await d.collection('attendance').doc(x._id).remove();
    pg.dirty = {};
    return { extra: after.length - pre.length, shown, log: wx.__probeLog.slice() };
  });
  if (r.err) { bad('attendance 前置：' + r.err); return; }
  r.extra === 1 ? ok('同人同日重复：插一条 + 保存后净增 1 条（写前查云端命中改 update）')
                : bad(`同人同日重复：净增 ${r.extra} 条（期望 1）`);
  r.shown === '' ? ok('枚举外状态不渲染成选中态（避免老师以为没记过又存一条）')
                 : bad(`枚举外状态被原样上屏：${JSON.stringify(r.shown)}`);
}

async function probeDuty(mp) {
  console.log('\n[duty] 一人一天只排一个岗位');
  await goto(mp, '/pages/duty/duty');
  const r = await mp.evaluate(async () => {
    const pg = getCurrentPages().slice(-1)[0];
    const stu = (pg.students || [])[0];
    if (!stu) return { err: '页面没有学生' };
    pg.onOpenDay({ currentTarget: { dataset: { d: 1 } } });
    await new Promise(r => setTimeout(r, 800));
    const jobs = (pg.data.dayJobs || []).map(j => j.job).slice(0, 3);
    const log = [];
    for (const job of jobs) {
      wx.__probeLog = [];
      pg.onPickStudent({ currentTarget: { dataset: { id: stu._id } } });
      await new Promise(r => setTimeout(r, 250));
      pg.onAssignJob({ currentTarget: { dataset: { job } } });
      await new Promise(r => setTimeout(r, 350));
      log.push(job + '→' + (wx.__probeLog.join(',') || 'silent'));
    }
    const mine = Object.keys(pg.assign || {}).filter(k => /^1@/.test(k) && (pg.assign[k] || []).indexOf(stu._id) >= 0);
    pg.dirty = false;
    await pg.refresh();
    return { name: stu.name, mine, log };
  });
  if (r.err) { bad('duty 前置：' + r.err); return; }
  r.mine.length <= 1 ? ok(`连排 3 个岗位给 ${r.name}，最终只占 ${JSON.stringify(r.mine)}`)
                     : bad(`${r.name} 同一天被排进 ${r.mine.length} 个岗位：${JSON.stringify(r.mine)}`);
  console.log('     ' + r.log.join(' | '));
}

async function probeSettings(mp) {
  console.log('\n[settings] 班级信息长度');
  await goto(mp, '/pages/settings/settings');
  const r = await mp.evaluate(async () => {
    const pg = getCurrentPages().slice(-1)[0];
    const before = JSON.parse(JSON.stringify(pg.data.form || {}));
    const out = [];
    const cases = [
      ['学校 500 字', { school: 'S'.repeat(500), className: 'PROBE班' }, 'reject'],
      ['学校班级都空', { school: '   ', className: '   ' }, 'reject'],
      ['正常班级', { school: 'PROBE中学', className: 'PROBE班' }, 'accept']
    ];
    for (const [label, patch, expect] of cases) {
      wx.__probeLog = [];
      pg.setData({ form: Object.assign({}, before, patch) });
      try { await pg.onSave(); } catch (e) { wx.__probeLog.push('throw:' + (e && e.message)); }
      await new Promise(r => setTimeout(r, 1300));
      const cur = (await wx.cloud.database().collection('classInfo').limit(1).get()).data[0] || {};
      const applied = String(cur.school || '') === String(patch.school || '').trim()
        && String(cur.className || '') === String(patch.className || '').trim();
      out.push({ label, expect, applied, log: wx.__probeLog.slice() });
    }
    pg.setData({ form: before });
    await pg.onSave();
    await new Promise(r => setTimeout(r, 1300));
    return out;
  });
  r.forEach(x => judge('设置 ' + x.label, x.expect, x.applied, (x.log || []).join('|')));
}

/* ---------------- runner ---------------- */

const MODULES = {
  rewards: probeRewards, announcement: probeAnnouncement, roster: probeRoster,
  grades: probeGrades, profile: probeProfile, homework: probeHomework,
  attendance: probeAttendance, duty: probeDuty, settings: probeSettings
};

(async () => {
  const want = process.argv.slice(2).filter(a => !a.startsWith('-'));
  const names = want.length ? want : Object.keys(MODULES);
  const unknown = names.filter(n => !MODULES[n]);
  if (unknown.length) {
    console.error('未知模块: ' + unknown.join(',') + '\n可选: ' + Object.keys(MODULES).join(' '));
    process.exit(2);
  }
  const { mp } = await connectOrLaunch(Number(process.env.AUTO_PORT || 9491));
  try {
    await install(mp);
    for (const n of names) await MODULES[n](mp);
  } finally {
    // ⚠️ 一律 disconnect：close() 会关掉用户正在用的 IDE 窗口
    await mp.disconnect();
  }
  console.log(`\n${pass.length} 通过 / ${fail.length} 失败`);
  if (fail.length) { fail.forEach(f => console.log('  - ' + f)); process.exit(1); }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
