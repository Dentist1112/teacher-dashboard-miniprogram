// 守护 utils/scoreanalysis.js：去重/排名/强弱科/不同满分/进步对比
const SA = require('../utils/scoreanalysis.js');

let pass = 0, fail = 0;
const ok = m => { pass++; console.log('  ✅ ' + m); };
const bad = m => { fail++; console.log('  ❌ ' + m); };
const check = (cond, m) => cond ? ok(m) : bad(m);

function row(o) {
  return Object.assign({ updatedAt: 1, score: 90, full: 100, date: '2026-09-01' }, o);
}
const scores = [];
// 一次考试 EXAM：3 个学生，语文数学各 100 满分
const mk = (sid, subj, score) => scores.push(row({ studentId: sid, exam: '月考', subject: subj, score }));
// A: 语文90 数学80 → 平均85
mk('A', '语文', 90); mk('A', '数学', 80);
// B: 语文95 数学95 → 平均95（第一）
mk('B', '语文', 95); mk('B', '数学', 95);
// C: 语文60 数学70 → 平均65（第三）
mk('C', '语文', 60); mk('C', '数学', 70);

// A 的上次考试，均分 70（比这次 85 进步 15）
scores.push(row({ studentId: 'A', exam: '开学考', subject: '语文', score: 70, date: '2026-08-01', updatedAt: 0 }));
scores.push(row({ studentId: 'A', exam: '开学考', subject: '数学', score: 70, date: '2026-08-01', updatedAt: 0 }));

const a = SA.buildStudentAnalysis(scores, 'A');
check(!!a, 'A 生成分析');
check(a.exam === '月考', '默认展示最近一次考试（月考），实际 ' + a.exam);
check(a.rank === 2, 'A 班级排名第 2（按平均得分率），实际 ' + a.rank);
check(a.classSize === 3, '班级人数 3，实际 ' + a.classSize);
check(a.avgPct === 85, 'A 平均得分率 85，实际 ' + a.avgPct);
check(a.total === 170 && a.totalFull === 200, '满分一致时总分 170/200，实际 ' + a.total + '/' + a.totalFull);
check(a.delta === 15 && a.prevExam === '开学考', '较上次进步 15，实际 ' + a.delta + ' / ' + a.prevExam);
check(a.strongest.subject === '语文' && a.strongest.pct === 90, '最强科语文90%，实际 ' + (a.strongest && a.strongest.subject));
check(a.weakest.subject === '数学' && a.weakest.pct === 80, '薄弱科数学80%，实际 ' + (a.weakest && a.weakest.subject));
check(a.subjects.length === 2, '各科明细 2 行');
const mathRow = a.subjects.find(x => x.subject === '数学');
check(mathRow.classAvgPct === 81.7, '数学班级平均得分率 81.7，实际 ' + mathRow.classAvgPct);

// 同考试同学科多条：保留 updatedAt 最新
scores.push(row({ studentId: 'A', exam: '月考', subject: '数学', score: 30, date: '2026-09-02', updatedAt: 99 }));
const a2 = SA.buildStudentAnalysis(scores, 'A');
const math2 = a2.subjects.find(x => x.subject === '数学');
check(math2.score === 30, '同学科改分后保留最新（30），实际 ' + math2.score);

// 不同满分：语文120 + 艺术50，不能直接加原始分
const mixed = [
  row({ studentId: 'X', exam: 'E', subject: '语文', score: 120, full: 120 }),
  row({ studentId: 'X', exam: 'E', subject: '艺术', score: 25, full: 50 })
];
const x = SA.buildStudentAnalysis(mixed, 'X');
check(x.total === null, '满分不一致时不展示总分');
check(x.avgPct === 75, '平均得分率 (100+50)/2=75，实际 ' + x.avgPct);

// 脏数据：full=0 / 非数字 score 剔除
const dirty = [
  row({ studentId: 'Y', exam: 'E', subject: '语文', score: 50, full: 0 }),
  row({ studentId: 'Y', exam: 'E', subject: '数学', score: 'x', full: 100 }),
  row({ studentId: 'Y', exam: 'E', subject: '英语', score: 80, full: 100 })
];
const y = SA.buildStudentAnalysis(dirty, 'Y');
check(y.subjects.length === 1 && y.subjects[0].subject === '英语', '脏成绩剔除，只剩英语 1 科，实际 ' + y.subjects.length);

// 并列同名次后跳号：两个 95 并列第 1，65 的排第 3
const tie = [
  row({ studentId: 'P', exam: 'E', subject: '语文', score: 95 }),
  row({ studentId: 'Q', exam: 'E', subject: '语文', score: 95 }),
  row({ studentId: 'R', exam: 'E', subject: '语文', score: 65 })
];
check(SA.buildStudentAnalysis(tie, 'R').rank === 3, '并列第1后第3名，实际 ' + SA.buildStudentAnalysis(tie, 'R').rank);

// 无成绩学生
check(SA.buildStudentAnalysis([], 'Z') === null, '无成绩返回 null');



// ============ v0.9.5：班级名次波动 buildClassWave ============
function wrow(o) {
  return Object.assign({ updatedAt: 1, score: 90, full: 100, date: '2026-09-01' }, o);
}
// 11 人两次考试。期末名次 S1..S11 顺序排列；开学考做两组交换：
//   S9: 开学1 → 期末9（退步8，入选）；S2: 开学9 → 期末2（进步7，不入选）
//   S11: 开学3 → 期末11（退步8，入选）；S3: 开学11 → 期末3（进步8，入选）
function waveScores() {
  const out = [];
  const finalPct = [99,97,95,93,91,89,87,85,83,81,79]; // 下标 i → S(i+1) 期末分
  for (let i=0;i<11;i++) out.push(wrow({studentId:'S'+(i+1),exam:'期末',subject:'语文',score:finalPct[i],date:'2026-09-01',updatedAt:200}));
  const prevRank = ['S9','S1','S11','S4','S5','S6','S7','S8','S2','S10','S3']; // 开学考名次 1..11
  prevRank.forEach((sid,i)=>out.push(wrow({studentId:sid,exam:'开学考',subject:'语文',score:99-i*2,date:'2026-08-01',updatedAt:100})));
  return out;
}
const w = SA.buildClassWave(waveScores());
check(w.latestExam === '期末' && w.prevExam === '开学考', '波动对比取最近两次考试，实际 ' + w.latestExam + '/' + w.prevExam);
check(w.down.length === 2 && w.down.map(x=>x.studentId).sort().join(',') === 'S11,S9', '退步≥8：S9(-8)、S11(-8)，实际 ' + JSON.stringify(w.down.map(x=>x.studentId+':'+x.delta)));
check(w.up.length === 1 && w.up[0].studentId === 'S3' && w.up[0].delta === 8, '进步≥8 只有 S3(+8)；S2(+7) 不入选，实际 ' + JSON.stringify(w.up.map(x=>x.studentId+':'+x.delta)));
const s9 = w.down.find(x=>x.studentId==='S9');
check(s9.rankPrev === 1 && s9.rankNow === 9, 'S9 名次 1→9，实际 ' + s9.rankPrev + '→' + s9.rankNow);

const w7 = SA.buildClassWave(waveScores(), 7);
check(w7.up.length === 2 && w7.up.some(x=>x.studentId==='S2'), '阈值改 7 时 S2(+7) 入选');
const w9 = SA.buildClassWave(waveScores(), 9);
check(w9.down.length === 0 && w9.up.length === 0, '阈值 9 时无人入选（边界：8 < 9）');

// 仅一次考试 → 空
const one = SA.buildClassWave([wrow({studentId:'A',exam:'只有一次',subject:'语文',score:90})]);
check(one.down.length === 0 && one.up.length === 0 && !one.latestExam, '仅一次考试不产生波动');

// 新生（上次缺考）不参与；排名只在两次都参加的人群内
const fresh = [
  wrow({studentId:'B',exam:'期末',subject:'语文',score:95,date:'2026-09-01',updatedAt:200}),
  wrow({studentId:'C',exam:'期末',subject:'语文',score:90,date:'2026-09-01',updatedAt:200}),
  wrow({studentId:'A',exam:'期末',subject:'语文',score:60,date:'2026-09-01',updatedAt:200}),
  wrow({studentId:'A',exam:'开学考',subject:'语文',score:95,date:'2026-08-01',updatedAt:100}),
  wrow({studentId:'B',exam:'开学考',subject:'语文',score:60,date:'2026-08-01',updatedAt:100})
];
const fw = SA.buildClassWave(fresh);
const hasC = fw.down.some(x=>x.studentId==='C') || fw.up.some(x=>x.studentId==='C');
check(!hasC, '新生 C 上次缺考，不进波动名单');
check(fw.down.length===0 && fw.up.length===0, '共同人群内 A/B 仅互换 1 名，达不到阈值');

// 并列竞赛排名在波动里同样生效（阈值放宽到 1 才能在 3 人样本里观察到）
const tieScores = [
  wrow({studentId:'P',exam:'期末',subject:'语文',score:95,date:'2026-09-01',updatedAt:200}),
  wrow({studentId:'Q',exam:'期末',subject:'语文',score:95,date:'2026-09-01',updatedAt:200}),
  wrow({studentId:'R',exam:'期末',subject:'语文',score:65,date:'2026-09-01',updatedAt:200}),
  wrow({studentId:'R',exam:'开学考',subject:'语文',score:95,date:'2026-08-01',updatedAt:100}),
  wrow({studentId:'P',exam:'开学考',subject:'语文',score:70,date:'2026-08-01',updatedAt:100}),
  wrow({studentId:'Q',exam:'开学考',subject:'语文',score:60,date:'2026-08-01',updatedAt:100})
];
const tw = SA.buildClassWave(tieScores, 1);
const tR = tw.down.find(x=>x.studentId==='R'), tP = tw.up.find(x=>x.studentId==='P');
check(tR && tR.rankNow === 3, 'R 期末并列第1后排第3（竞赛排名），实际 ' + (tR && tR.rankNow));
check(tP && tP.rankPrev === 2 && tP.rankNow === 1, 'P 开学考第2→期末并列第1，实际 ' + (tP && (tP.rankPrev+'→'+tP.rankNow)));

// ============ v0.9.6：个人成绩全景 buildStudentPanorama ============
const panoScores = [
  wrow({studentId:'A',exam:'期末',subject:'语文',score:90,updatedAt:200,date:'2026-09-01'}),
  wrow({studentId:'A',exam:'期末',subject:'数学',score:80,updatedAt:200,date:'2026-09-01'}),
  wrow({studentId:'A',exam:'开学考',subject:'语文',score:70,updatedAt:100,date:'2026-08-01'}),
  wrow({studentId:'B',exam:'期末',subject:'语文',score:60,updatedAt:200,date:'2026-09-01'})
];
const pa = SA.buildStudentPanorama(panoScores, 'A');
check(pa.exams.join(',') === '期末,开学考', '考试新→旧，实际 ' + pa.exams);
check(pa.subjects.join(',') === '语文,数学', '科目按规范序，实际 ' + pa.subjects);
const pFinal = pa.rows.find(r=>r.exam==='期末');
check(pFinal.avg === 85, 'A 期末平均得分率 85，实际 ' + pFinal.avg);
check(pFinal.cells['语文'].pct === 90 && pFinal.cells['数学'].pct === 80, 'A 期末语文90 数学80');
const pOpen = pa.rows.find(r=>r.exam==='开学考');
check(pOpen.cells['数学'] === null, '开学考数学缺考格为 null');
check(pOpen.cells['语文'].score === 70 && pOpen.cells['语文'].full === 100, '缺考格以外保留原始分');

// 别人的成绩不串场 + 不同满分按得分率
const pb = SA.buildStudentPanorama(panoScores, 'B');
check(pb.rows.length === 1 && pb.rows[0].avg === 60, 'B 只有期末一行 avg=60，实际 ' + JSON.stringify(pb.rows));
const px = SA.buildStudentPanorama([
  wrow({studentId:'X',exam:'E',subject:'语文',score:120,full:120}),
  wrow({studentId:'X',exam:'E',subject:'艺术',score:25,full:50})
], 'X');
check(px.subjects.join(',') === '语文,艺术', '语文排在艺术前，实际 ' + px.subjects);
check(px.rows[0].avg === 75, '不同满分按得分率：X 平均 75，实际 ' + px.rows[0].avg);

// 空数据 / 不存在的学生 / maxExams 截断
check(SA.buildStudentPanorama([], '不存在').rows.length === 0, '空数据返回空全景');
check(SA.buildStudentPanorama(panoScores, '不存在').rows.length === 0, '学生无成绩返回空全景');
const many = [];
for (let i = 1; i <= 8; i++) many.push(wrow({studentId:'M',exam:'考' + i,subject:'语文',score:80,updatedAt:i * 100,date:'2026-0' + Math.min(i,9) + '-01'}));
const pm = SA.buildStudentPanorama(many, 'M', 6);
check(pm.rows.length === 6 && pm.exams[0] === '考8' && pm.exams[5] === '考3', '只留最近 6 次（考8→考3），实际 ' + pm.rows.length + ' ' + pm.exams[0] + '→' + pm.exams[5]);

// 规范外科目按中文名排在规范科目之后
const py = SA.buildStudentPanorama([
  wrow({studentId:'A',exam:'E',subject:'信息技术',score:90}),
  wrow({studentId:'A',exam:'E',subject:'语文',score:80})
], 'A');
check(py.subjects.join(',') === '语文,信息技术', '规范外科目（信息技术）排后，实际 ' + py.subjects);

// 同考试同学科改过分：只留最新
const pz = SA.buildStudentPanorama([
  wrow({studentId:'Z',exam:'E',subject:'语文',score:60,updatedAt:100}),
  wrow({studentId:'Z',exam:'E',subject:'语文',score:88,updatedAt:300})
], 'Z');
check(pz.rows[0].cells['语文'].score === 88, '改分后只留最新 88，实际 ' + pz.rows[0].cells['语文'].score);

check(SA.SUBJECT_ORDER[0] === '语文' && SA.SUBJECT_ORDER.length === 10, 'SUBJECT_ORDER 已导出（10 科）');
check(SA.WAVE_RANK_DELTA === 8, 'WAVE_RANK_DELTA = 8，实际 ' + SA.WAVE_RANK_DELTA);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
