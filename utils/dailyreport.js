// 班级日报纯文本拼接（v0.9.5）
// --------------------------------------------------------------------------
// 设计：纯函数、不碰 wx/云，输入今日各集合的已筛数据，输出可直接粘贴到群里的文本。
// 空段整段省略；当天完全没登记考勤时不输出到校行（不能谎报全员正常）。
// 考勤口径与 utils/analytics.js 一致：默认全班正常，老师只点改迟到/请假；
// 历史「缺勤」按请假展示；已删除学生的孤儿记录剔除。

const DUTY_JOBS = ['扫地', '擦黑板', '倒垃圾', '摆桌椅', '关窗锁门'];
const HW_DONE = ['已交', '补交', '免交'];

// '2026-09-13' → '9月13日'（去前导零，非法输入原样回退）
function fmtDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!m) return String(dateStr || '').trim();
  return Number(m[2]) + '月' + Number(m[3]) + '日';
}

// 今日值日：复刻 pages/duty/duty.js 的有效记录规则
// → [{ job, names:[...] }]，按标准岗位序；脏数据（孤儿/非法 weekday/非法岗位/重复）剔除
function todayDuty(dutySchedule, students, weekday) {
  const wd = Number(weekday);
  const stuMap = {};
  (students || []).forEach(s => { stuMap[s._id] = s; });
  const byJob = {};
  const seen = {};
  (dutySchedule || []).forEach(rec => {
    const job = String(rec.job || '');
    if (!(wd >= 1 && wd <= 5) || Number(rec.weekday) !== wd) return;
    if (DUTY_JOBS.indexOf(job) < 0 || !stuMap[rec.studentId]) return;
    const key = job + '@' + rec.studentId;
    if (seen[key]) return;
    seen[key] = true;
    (byJob[job] = byJob[job] || []).push(stuMap[rec.studentId].name);
  });
  return DUTY_JOBS.filter(j => byJob[j] && byJob[j].length)
    .map(j => ({ job: j, names: byJob[j] }));
}

// 到校行：attendance = 今日全部状态记录（含「正常」）。无记录 → null（整段省略）
function attendanceLine(attendance, students) {
  const stuMap = {};
  (students || []).forEach(s => { stuMap[s._id] = s; });
  const recs = (attendance || []).filter(a => stuMap[a.studentId]);
  if (!recs.length) return null;

  const late = [], leave = [];
  recs.forEach(a => {
    const name = stuMap[a.studentId].name;
    if (a.status === '迟到') late.push(name);
    else if (a.status === '请假' || a.status === '缺勤') leave.push(name);
  });
  const total = (students || []).length;
  let line = '到校：应到' + total + '人';
  if (!late.length && !leave.length) {
    line += '，全员正常';
  } else {
    if (late.length) line += '，迟到' + late.length + '人（' + late.join('、') + '）';
    if (leave.length) line += '，请假' + leave.length + '人（' + leave.join('、') + '）';
  }
  return line;
}

// 作业行：homeworkToday = 今日到期作业；未交 = 全班人数 - 完成(已交/补交/免交)
function homeworkLine(homeworkToday, submits, students) {
  const hw = homeworkToday || [];
  if (!hw.length) return null;
  const total = (students || []).length;
  const parts = [];
  let pendingSum = 0;
  hw.forEach(h => {
    const done = (submits || []).filter(s =>
      s.homeworkId === h._id && HW_DONE.indexOf(s.status) >= 0).length;
    const pending = Math.max(0, total - done);
    if (pending > 0) {
      pendingSum += pending;
      parts.push((h.title || h.subject || '作业') + ' ' + pending + '人');
    }
  });
  if (!pendingSum) return '作业：' + hw.length + '项今日应交，全部已交';
  return '作业：' + hw.length + '项今日应交，共' + pendingSum + '人次未交（' + parts.join(' / ') + '）';
}

// 待办行：标题最多展示 3 个，计数是全部
function todoLine(todos) {
  const list = todos || [];
  if (!list.length) return null;
  const titles = list.slice(0, 3).map(t => String(t.title || '').trim()).filter(Boolean);
  let line = '待办：' + list.length + '项未完成';
  if (titles.length) line += '（' + titles.join('、') + (list.length > 3 ? '等' : '') + '）';
  return line;
}

function buildDailyReport(input) {
  const o = input || {};
  const cls = String(o.classTitle || '').trim();
  const title = '【' + ((cls && cls !== '未设置班级信息') ? cls + ' ' : '')
    + '班级日报 · ' + fmtDate(o.date)
    + (o.weekdayLabel ? ' ' + o.weekdayLabel : '') + '】';

  const lines = [title];
  const att = attendanceLine(o.attendance, o.students);
  if (att) lines.push(att);
  const hw = homeworkLine(o.homeworkToday, o.submits, o.students);
  if (hw) lines.push(hw);

  const duty = todayDuty(o.dutySchedule, o.students, o.dutyWeekday);
  if (duty.length) {
    lines.push('值日：' + duty.map(d => d.job + ' ' + d.names.join('、')).join('；'));
  }

  const todo = todoLine(o.todos);
  if (todo) lines.push(todo);

  return lines.join('\n');
}

module.exports = { buildDailyReport, todayDuty, fmtDate };
