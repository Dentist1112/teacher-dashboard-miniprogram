// 守护 utils/dailyreport.js：班级日报纯文本拼接 + 今日值日清洗
const D = require('../utils/dailyreport.js');

let pass = 0, fail = 0;
const ok = m => { pass++; console.log('  ✅ ' + m); };
const bad = m => { fail++; console.log('  ❌ ' + m); };
const check = (cond, m) => cond ? ok(m) : bad(m);

const stu = (id, name) => ({ _id: id, name, studentNo: id });
const students = [stu('s1', '张三'), stu('s2', '李四'), stu('s3', '王五')];
const base = {
  classTitle: '初三(2)班',
  date: '2026-09-13',
  weekdayLabel: '周日',
  students,
  attendance: [],
  homeworkToday: [],
  submits: [],
  dutySchedule: [],
  todos: []
};
const cp = o => JSON.parse(JSON.stringify(Object.assign({}, base, o)));

/* ---------- 标题 ---------- */
let t = D.buildDailyReport(cp({}));
check(t.startsWith('【初三(2)班 班级日报 · 9月13日 周日】'), '标题含班级/日期/周几：\n' + t.split('\n')[0]);

const tNoClass = D.buildDailyReport(cp({ classTitle: '未设置班级信息' }));
check(tNoClass.startsWith('【班级日报 · 9月13日 周日】'), '未设置班级时标题回退「班级日报」');

/* ---------- 到校 ---------- */
// 完全没登记 → 不出现到校行（不能谎报全员正常）
check(t.indexOf('到校') < 0, '当天未登记考勤，不输出到校行');

// 全员正常：3 条正常记录
const allNormal = cp({ attendance: [
  { studentId: 's1', status: '正常' }, { studentId: 's2', status: '正常' }, { studentId: 's3', status: '正常' }
] });
t = D.buildDailyReport(allNormal);
check(t.indexOf('应到3人') >= 0 && t.indexOf('全员正常') >= 0, '3 人全部有正常记录 → 应到3人，全员正常');

// 迟到 1 + 请假 2
const mixed = cp({ attendance: [
  { studentId: 's1', status: '迟到' },
  { studentId: 's2', status: '请假' }, { studentId: 's3', status: '请假' }
] });
t = D.buildDailyReport(mixed);
check(t.indexOf('应到3人') >= 0 && t.indexOf('迟到1人（张三）') >= 0 && t.indexOf('请假2人（李四、王五）') >= 0,
  '迟到/请假带名单：\n' + t.split('\n').find(x => x.indexOf('到校') >= 0));

// 历史"缺勤"按请假展示（与 analytics 口径一致）
const legacy = cp({ attendance: [{ studentId: 's1', status: '缺勤' }] });
t = D.buildDailyReport(legacy);
check(t.indexOf('请假1人（张三）') >= 0, '历史缺勤按请假展示');

// 孤儿记录（学生已删除）不计入人头、不出现裸 id
const orphan = cp({ attendance: [
  { studentId: 'gone', status: '迟到' },
  { studentId: 's1', status: '正常' }, { studentId: 's2', status: '正常' }, { studentId: 's3', status: '正常' }
] });
t = D.buildDailyReport(orphan);
check(t.indexOf('gone') < 0 && t.indexOf('全员正常') >= 0, '已删除学生的孤儿考勤剔除，其余全员正常');

/* ---------- 作业 ---------- */
const hw = [
  { _id: 'h1', title: '数学练习册', subject: '数学' },
  { _id: 'h2', title: '语文抄写', subject: '语文' },
  { _id: 'h3', title: '英语听写', subject: '英语' }
];
// h1 已交2人（未交1），h2 已交3人（未交0），h3 已交1人免交1人算完成（未交1）
const submits = [
  { homeworkId: 'h1', studentId: 's1', status: '已交' },
  { homeworkId: 'h1', studentId: 's2', status: '补交' },
  { homeworkId: 'h2', studentId: 's1', status: '已交' },
  { homeworkId: 'h2', studentId: 's2', status: '已交' },
  { homeworkId: 'h2', studentId: 's3', status: '已交' },
  { homeworkId: 'h3', studentId: 's1', status: '免交' },
  { homeworkId: 'h3', studentId: 's2', status: '已交' }
];
t = D.buildDailyReport(cp({ homeworkToday: hw, submits }));
const hwLine = t.split('\n').find(x => x.indexOf('作业') >= 0);
check(hwLine && hwLine.indexOf('3项今日应交') >= 0 && hwLine.indexOf('共2人次未交') >= 0,
  '作业行汇总今日到期与未交人次：' + hwLine);
check(hwLine.indexOf('数学练习册 1人') >= 0 && hwLine.indexOf('英语听写 1人') >= 0 && hwLine.indexOf('语文抄写') < 0,
  '只列有未交的作业项，全交的不列：' + hwLine);

// 全部已交
const allDone = cp({ homeworkToday: [hw[1]], submits: submits.filter(s => s.homeworkId === 'h2') });
t = D.buildDailyReport(allDone);
check(t.indexOf('1项今日应交，全部已交') >= 0, '全部已交的措辞');

/* ---------- 值日 ---------- */
const dutySchedule = [
  { weekday: 1, job: '扫地', studentId: 's1' },          // 今天（周一）
  { weekday: 1, job: '擦黑板', studentId: 's2' },
  { weekday: 1, job: '扫地', studentId: 's1' },          // 同人同岗重复 → 剔
  { weekday: 1, job: '倒垃圾', studentId: 'ghost' },     // 孤儿 → 剔
  { weekday: 1, job: '打怪兽', studentId: 's3' },        // 非法岗位 → 剔
  { weekday: 7, job: '关窗锁门', studentId: 's3' },      // 非法 weekday(7) → 剔
  { weekday: 2, job: '摆桌椅', studentId: 's3' }         // 不是今天 → 不出现
];
t = D.buildDailyReport(cp({ dutySchedule, dutyWeekday: 1 }));
const dutyLine = t.split('\n').find(x => x.indexOf('值日') >= 0);
check(dutyLine === '值日：扫地 张三；擦黑板 李四', '值日清洗脏数据且按岗位序：' + dutyLine);

// 今天没人值日 → 整段省略
t = D.buildDailyReport(cp({}));
check(t.indexOf('值日') < 0, '无今日值日记录时省略值日行');

/* ---------- 待办 ---------- */
t = D.buildDailyReport(cp({ todos: [{ title: '收伙食费' }, { title: '打印报名表' }, { title: '第三件' }, { title: '第四件' }] }));
const todoLine = t.split('\n').find(x => x.indexOf('待办') >= 0);
check(todoLine === '待办：4项未完成（收伙食费、打印报名表、第三件等）', '待办行计数全部、标题最多列 3 个并加等：' + todoLine);
t = D.buildDailyReport(cp({ todos: [] }));
check(t.indexOf('待办') < 0, '无未完成待办时省略');

/* ---------- 空段省略 + 无空行 ---------- */
const minimal = D.buildDailyReport(cp({}));
check(minimal.split('\n').length === 1 && minimal.indexOf('\n\n') < 0, '所有数据为空时只有标题，无空行');

/* ---------- todayDuty 直接接口（周末回落周一口径由调用方传 weekday）---------- */
const td = D.todayDuty(dutySchedule, students, 1);
check(td.length === 2 && td[0].job === '扫地' && td[0].names.join('') === '张三', 'todayDuty 返回岗位→姓名结构');

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
