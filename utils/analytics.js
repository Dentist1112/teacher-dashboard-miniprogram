// 数据分析聚合（纯逻辑，好单测）。给定一个日期区间，汇总考勤/作业/奖惩/成绩/待办。
// 口径说明（避免假装精确）：
//   - 历史考勤若只存异常、未存全员正常，出勤率分母用「已登记人次」，不假装是全班
//   - 作业「未交」不存记录，完成率分母用「有收交记录的人次」
//   - 成绩按记录上的 date 归期；跨科比得分率，不直接加原始分
const periods = require('./periods.js');

function pctOf(r) {
  return Number(r.score) / Number(r.full) * 100;
}
function validScore(r) {
  return r && Number.isFinite(Number(r.score)) && Number(r.full) > 0;
}

// rec 归期：优先业务 date（'YYYY-MM-DD'），没有就不计入（不拿 updatedAt 毫秒冒充日期）
function dated(list, r) {
  return (list || []).filter(x => periods.inRange(x.date, r));
}

function compute(input) {
  const r = input.range;
  const attendance = dated(input.attendance, r);
  const submits = dated(input.homeworkSubmit, r);
  const rewards = dated(input.rewards, r);
  const scores = dated(input.scores, r).filter(validScore);
  // 待办：到期日落在区间内；完成态用当前 done（无独立完成时间，按现状统计）
  const todosIn = (input.todos || []).filter(t => t.dueDate && periods.inRange(t.dueDate, r));

  // ---- 考勤 ----
  // 口径（2026-09-13 内测反馈后）：默认全班正常，老师只点改少数迟到/请假。
  // 所以「有登记的日期」上，当天没记录的学生按正常计；不能只按记录条数算，
  // 否则 28 人班只记 2 条迟到会显示正常率 0%（红队守恒律抓到的真 bug）。
  const roster = Array.isArray(input.studentIds) ? input.studentIds : [];
  const rosterSet = {};
  roster.forEach(id => { rosterSet[String(id)] = true; });
  const knowRoster = roster.length > 0;
  // 同人同日多条（多端并发）：只留 updatedAt 最新一条
  const latest = {};
  attendance.forEach(a => {
    if (knowRoster && !rosterSet[String(a.studentId)]) return;  // 已删除学生的孤儿记录不计人头
    const d = String(a.date || '').slice(0, 10);
    if (!d) return;
    const k = d + '@@' + String(a.studentId);
    const cur = latest[k];
    if (!cur || Number(a.updatedAt || 0) >= Number(cur.updatedAt || 0)) latest[k] = a;
  });
  const att = { '正常': 0, '迟到': 0, '请假': 0 };
  const abnormal = [];
  const dayStudents = {};   // date → Set(studentId) 当天有有效状态的人
  Object.keys(latest).forEach(k => {
    const a = latest[k];
    const d = String(a.date || '').slice(0, 10);
    const st = a.status === '缺勤' ? '请假' : a.status;  // 历史“缺勤”按请假展示
    if (att[st] === undefined) return;
    att[st] += 1;
    (dayStudents[d] = dayStudents[d] || {})[String(a.studentId)] = true;
    if (st !== '正常') {
      abnormal.push({
        name: (input.nameOf && input.nameOf(a)) || a.studentName || a.studentId || '—',
        status: st,
        reason: a.reason || (a.status === '缺勤' ? '原记为缺勤' : '')
      });
    }
  });
  const registeredDays = Object.keys(dayStudents).length;
  let impliedNormal = 0;
  if (knowRoster && registeredDays > 0) {
    // 每个登记日：全班人数 - 当天有状态记录的人数 = 当天默认正常的人数
    Object.keys(dayStudents).forEach(d => {
      impliedNormal += Math.max(0, roster.length - Object.keys(dayStudents[d]).length);
    });
  }
  const normalShown = att['正常'] + impliedNormal;
  const attTotal = knowRoster && registeredDays > 0
    ? roster.length * registeredDays
    : att['正常'] + att['迟到'] + att['请假'];
  const attendanceRate = attTotal ? Math.round(normalShown / attTotal * 100) : null;

  // ---- 作业收交 ----
  const hw = { '已交': 0, '补交': 0, '免交': 0, '未交': 0 };
  submits.forEach(s => { if (hw[s.status] !== undefined) hw[s.status] += 1; });
  const hwRecorded = hw['已交'] + hw['补交'] + hw['免交'] + hw['未交'];
  const hwDone = hw['已交'] + hw['补交'] + hw['免交'];
  const hwRate = hwRecorded ? Math.round(hwDone / hwRecorded * 100) : null;

  // ---- 奖惩 ----
  let rewardCount = 0, punishCount = 0, netPoints = 0;
  rewards.forEach(x => {
    const p = Number(x.points) || 0;
    netPoints += p;
    if (x.type === '惩戒' || p < 0) punishCount += 1; else rewardCount += 1;
  });

  // ---- 成绩：各科平均得分率 ----
  const subjMap = {};
  scores.forEach(s => {
    const k = String(s.subject || '其他');
    subjMap[k] = subjMap[k] || { sum: 0, n: 0 };
    subjMap[k].sum += pctOf(s);
    subjMap[k].n += 1;
  });
  const subjects = Object.keys(subjMap).map(k => ({
    subject: k,
    count: subjMap[k].n,
    avgPct: Math.round(subjMap[k].sum / subjMap[k].n * 10) / 10
  })).sort((a, b) => b.count - a.count || a.subject.localeCompare(b.subject, 'zh'));
  const overallPct = scores.length
    ? Math.round(scores.reduce((a, s) => a + pctOf(s), 0) / scores.length * 10) / 10 : null;

  // ---- 待办 ----
  const todoDone = todosIn.filter(t => t.done).length;
  const todoOpen = todosIn.length - todoDone;

  return {
    empty: attTotal === 0 && hwRecorded === 0 && rewards.length === 0 && scores.length === 0 && todosIn.length === 0,
    attendance: {
      total: attTotal, normal: normalShown, late: att['迟到'], leave: att['请假'],
      impliedNormal, registeredDays,
      rate: attendanceRate, abnormal: abnormal.slice(0, 20)
    },
    homework: {
      recorded: hwRecorded, done: hwDone, late: hw['补交'], exempt: hw['免交'],
      rate: hwRate
    },
    rewards: { reward: rewardCount, punish: punishCount, net: netPoints },
    scores: { count: scores.length, overallPct, subjects },
    todos: { total: todosIn.length, done: todoDone, open: todoOpen }
  };
}

module.exports = { compute };
