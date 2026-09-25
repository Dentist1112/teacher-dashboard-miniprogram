// 守护 utils/analytics.js：周期内考勤/作业/奖惩/成绩/待办聚合，历史“缺勤”归一为请假。
const A = require('../utils/analytics.js');
const P = require('../utils/periods.js');

let pass = 0, fail = 0;
const ok = m => { pass++; console.log('  ✅ ' + m); };
const bad = m => { fail++; console.log('  ❌ ' + m); };
const check = (c, m) => c ? ok(m) : bad(m);

const r = P.range('day', new Date('2026-09-13T10:00:00')); // 今天 9/13
const inD = '2026-09-13', outD = '2026-09-12';

const attendance = [
  { studentId: 's1', date: inD, status: '正常' },
  { studentId: 's2', date: inD, status: '正常' },
  { studentId: 's3', date: inD, status: '迟到' },
  { studentId: 's4', date: inD, status: '请假', reason: '发烧' },
  { studentId: 's5', date: inD, status: '缺勤' },          // 历史缺勤归一为请假
  { studentId: 's6', date: outD, status: '迟到' }           // 周期外不计
];
const homeworkSubmit = [
  { studentId: 's1', date: inD, status: '已交' },
  { studentId: 's2', date: inD, status: '已交' },
  { studentId: 's3', date: inD, status: '补交' },
  { studentId: 's4', date: inD, status: '免交' },
  { studentId: 's5', date: outD, status: '已交' }           // 周期外
];
const rewards = [
  { studentId: 's1', date: inD, type: '奖励', points: 5 },
  { studentId: 's2', date: inD, type: '惩戒', points: -2 },
  { studentId: 's3', date: outD, type: '奖励', points: 3 }
];
const scores = [
  { studentId: 's1', date: inD, subject: '语文', score: 90, full: 100 },
  { studentId: 's2', date: inD, subject: '语文', score: 70, full: 100 },
  { studentId: 's3', date: inD, subject: '数学', score: 50, full: 0 },  // 脏数据剔除
  { studentId: 's4', date: outD, subject: '语文', score: 10, full: 100 }
];
const todos = [
  { title: 't1', dueDate: inD, done: true },
  { title: 't2', dueDate: inD, done: false },
  { title: 't3', dueDate: outD, done: false }
];
const nameOf = rec => ({ s1: '甲', s2: '乙', s3: '丙', s4: '丁', s5: '戊' }[rec.studentId] || '?');

const res = A.compute({ range: r, attendance, homeworkSubmit, rewards, scores, todos, nameOf, studentIds: ['s1','s2','s3','s4','s5','s6','s7','s8'] });

check(!res.empty, '有数据时不是空态');
check(res.attendance.normal === 5 && res.attendance.late === 1 && res.attendance.leave === 2,
  '考勤 正常5(含3名无记录默认正常)/迟到1/请假2，实际 ' + JSON.stringify([res.attendance.normal, res.attendance.late, res.attendance.leave]));
check(res.attendance.total === 8, '接名单后总人次=全班8人，实际 ' + res.attendance.total);
check(res.attendance.rate === 63, '正常率 5/8=63%，实际 ' + res.attendance.rate);
check(res.attendance.abnormal.length === 3, '异常名单 3 人（迟到+2请假），实际 ' + res.attendance.abnormal.length);
const legacy = res.attendance.abnormal.find(x => x.name === '戊');
check(legacy && legacy.status === '请假' && legacy.reason === '原记为缺勤', '历史缺勤显示请假且带说明');
check(!!res.attendance.abnormal.find(x => x.name === '丁' && x.reason === '发烧'), '请假事由带出');

check(res.homework.done === 4 && res.homework.late === 1 && res.homework.exempt === 1,
  '作业 完成4(含补交免交)/补交1/免交1，实际 ' + JSON.stringify([res.homework.done, res.homework.late, res.homework.exempt]));
check(res.homework.recorded === 4 && res.homework.rate === 100, '作业记录4人次完成率100%，实际 ' + res.homework.rate);

check(res.rewards.reward === 1 && res.rewards.punish === 1 && res.rewards.net === 3,
  '奖惩 奖励1/惩戒1/净积分3，实际 ' + JSON.stringify([res.rewards.reward, res.rewards.punish, res.rewards.net]));

check(res.scores.count === 2, '成绩只计周期内且合法 2 条（脏/周期外剔除），实际 ' + res.scores.count);
check(res.scores.overallPct === 80, '整体平均得分率 (90+70)/2=80，实际 ' + res.scores.overallPct);
const yw = res.scores.subjects.find(x => x.subject === '语文');
check(yw && yw.avgPct === 80 && yw.count === 2, '语文平均80%共2条，实际 ' + JSON.stringify(yw));

check(res.todos.total === 2 && res.todos.done === 1 && res.todos.open === 1,
  '待办 周期内2条 完成1/未完成1，实际 ' + JSON.stringify(res.todos));

// 全空周期 → empty
const emptyRes = A.compute({ range: P.range('month', new Date('2026-01-01T10:00:00')), attendance: [], homeworkSubmit: [], rewards: [], scores: [], todos: [] });
check(emptyRes.empty && emptyRes.attendance.rate === null && emptyRes.homework.rate === null, '空周期为空态且比率为 null');


// 内测场景：默认全班正常，只存异常。28 人班，今日只登记 2 条迟到
const class28 = Array.from({length:28},(_,i)=>'c'+(i+1));
const onlyAbnormal = [
  { studentId:'c1', date:inD, status:'迟到' },
  { studentId:'c2', date:inD, status:'迟到' }
];
const r2 = A.compute({ range:r, attendance:onlyAbnormal, homeworkSubmit:[], rewards:[], scores:[], todos:[], studentIds:class28 });
check(r2.attendance.normal === 26 && r2.attendance.late === 2, '只存异常：26人默认正常+2迟到，实际 ' + JSON.stringify([r2.attendance.normal,r2.attendance.late]));
check(r2.attendance.rate === 93, '只存异常：正常率 26/28=93%，实际 ' + r2.attendance.rate);

// 3) 周期多天：周内两天各登记 1 条迟到，默认正常按「登记日 × 全班」计
const twoDays = [
  { studentId:'c1', date:inD, status:'迟到' },
  { studentId:'c1', date:'2026-09-12', status:'请假', reason:'病' }  // 周六，落在本周
];
const rw = P.range('week', new Date('2026-09-13T10:00:00')); // 周一9/7~周日9/13
const r3 = A.compute({ range:rw, attendance:twoDays, homeworkSubmit:[], rewards:[], scores:[], todos:[], studentIds:class28 });
check(r3.attendance.registeredDays === 2, '周内 2 个登记日，实际 ' + r3.attendance.registeredDays);
check(r3.attendance.total === 56, '总人次=28人×2天=56，实际 ' + r3.attendance.total);
check(r3.attendance.normal === 54, '默认正常 56-1迟到-1请假=54，实际 ' + r3.attendance.normal);

// 4) 已删除学生的孤儿考勤不计人头
const withOrphan = [ { studentId:'ghost', date:inD, status:'迟到' } ];
const r4 = A.compute({ range:r, attendance:withOrphan, homeworkSubmit:[], rewards:[], scores:[], todos:[], studentIds:class28 });
check(r4.attendance.late === 0 && r4.attendance.total === 0 && r4.empty, '只有孤儿记录=当天无真实登记，按空态处理，不凭空算正常，实际 total=' + r4.attendance.total);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
