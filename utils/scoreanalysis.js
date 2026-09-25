// 成绩综合分析（纯逻辑，好单测）
// --------------------------------------------------------------------------
// 为什么单独抽出来：档案页要算「最近一次考试的总分 / 班级排名 / 强弱科 / 与上次对比」，
// 这些是变异高发的纯计算，塞在页面里没法脱离模拟器测。口径全部在这里定死。
//
// score 记录形态：{ studentId, exam, subject, score, full, date, updatedAt }
// 关键口径：
//   1) 同一「考试+学科」可能有多条（改过分），只保留 updatedAt 最新一条
//   2) 不同学科满分可能不同（语文 120 / 艺术 50），跨科比的是「得分率」不是原始分
//   3) 总分只有当该次考试所有学科满分一致时才展示，否则只展示平均得分率
//   4) 班级排名按平均得分率从高到低，并列同名次（标准竞赛排名，并列后跳号）
//   5) full<=0 / score 非数字的脏记录剔除，不计入任何统计

function pctOf(row) {
  return Number(row.score) / Number(row.full) * 100;
}

function valid(list) {
  return (list || []).filter(r =>
    r && Number.isFinite(Number(r.score)) && Number.isFinite(Number(r.full)) && Number(r.full) > 0
  );
}

function examKey(r) {
  return String(r.exam || '未命名考试');
}

// 同人 同考试+学科 去重，保留 updatedAt 最新（无 updatedAt 时按出现顺序后者覆盖）。
// ⚠️ key 必须带 studentId：第一版漏了，不同学生的同学科成绩互相覆盖，全班排名退化成 1 人（单测抓到）。
function dedupe(list) {
  const map = {};
  valid(list).forEach(r => {
    const k = String(r.studentId || '') + '@@' + examKey(r) + '@@' + String(r.subject || '');
    const cur = map[k];
    if (!cur || Number(r.updatedAt || 0) >= Number(cur.updatedAt || 0)) map[k] = r;
  });
  return Object.keys(map).map(k => map[k]);
}

function avgPct(rows) {
  if (!rows.length) return null;
  return rows.reduce((a, r) => a + pctOf(r), 0) / rows.length;
}

// 仅当所有学科满分一致时总分才有意义（120 制语文和 50 制艺术不能直接相加）
function totalOf(rows) {
  if (!rows.length) return null;
  const fulls = {};
  rows.forEach(r => { fulls[Number(r.full)] = true; });
  if (Object.keys(fulls).length !== 1) return null;
  const full = Number(rows[0].full);
  const sum = rows.reduce((a, r) => a + Number(r.score), 0);
  return { score: Math.round(sum * 10) / 10, full: full * rows.length };
}

// 把全班成绩整理成：exam → studentId → rows
function classMatrix(allScores) {
  const byStudent = {};
  dedupe(allScores).forEach(r => {
    byStudent[r.studentId] = byStudent[r.studentId] || {};
    const ek = examKey(r);
    (byStudent[r.studentId][ek] = byStudent[r.studentId][ek] || []).push(r);
  });
  return byStudent;
}

// 某次考试每个学生的平均得分率：[{ studentId, avg }]
function examClassAvgs(matrix, exam) {
  const out = [];
  Object.keys(matrix).forEach(sid => {
    const rows = matrix[sid][exam];
    if (rows && rows.length) {
      const a = avgPct(rows);
      if (a !== null) out.push({ studentId: sid, avg: a });
    }
  });
  out.sort((a, b) => b.avg - a.avg);
  return out;
}

// 标准竞赛排名：最高分第 1，两个并列第 1 后下一个是第 3
function rankOf(ordered, sid) {
  let rank = 0;
  for (let i = 0; i < ordered.length; i++) {
    if (i === 0 || ordered[i].avg !== ordered[i - 1].avg) rank = i + 1;
    if (ordered[i].studentId === sid) return rank;
  }
  return 0;
}

// 考试按「该生在这次考试里最新一条记录的时间」从新到旧排
function orderedExamsFor(studentRows) {
  const exams = {};
  studentRows.forEach(r => {
    const ek = examKey(r);
    exams[ek] = Math.max(exams[ek] || 0, Number(r.updatedAt || 0), Number(r.date) || 0);
  });
  return Object.keys(exams).sort((a, b) => exams[b] - exams[a]);
}

const r1 = n => Math.round(n * 10) / 10;

// 主入口：给全班 allScores + 目标 studentId，产出该生成绩综合分析
function buildStudentAnalysis(allScores, studentId) {
  const matrix = classMatrix(allScores);
  const mine = matrix[studentId];
  if (!mine) return null;
  const examNames = orderedExamsFor(Object.keys(mine).reduce((a, ek) => a.concat(mine[ek]), []));
  if (!examNames.length) return null;

  const examView = ek => {
    const rows = (mine[ek] || []).slice().sort((a, b) => String(a.subject).localeCompare(String(b.subject), 'zh'));
    const avg = avgPct(rows);
    const total = totalOf(rows);
    const classOrdered = examClassAvgs(matrix, ek);
    // 每科班级均分（得分率）
    const subjClass = {};
    Object.keys(matrix).forEach(sid => {
      (matrix[sid][ek] || []).forEach(r => {
        const sk = String(r.subject || '');
        subjClass[sk] = subjClass[sk] || { sum: 0, n: 0 };
        subjClass[sk].sum += pctOf(r);
        subjClass[sk].n += 1;
      });
    });
    const subjects = rows.map(r => {
      const sk = String(r.subject || '');
      const c = subjClass[sk];
      return {
        subject: sk,
        score: r1(Number(r.score)),
        full: Number(r.full),
        pct: r1(pctOf(r)),
        classAvgPct: c ? r1(c.sum / c.n) : null,
        classN: c ? c.n : 0
      };
    });
    const byPct = subjects.slice().sort((a, b) => b.pct - a.pct);
    return {
      exam: ek,
      subjectCount: rows.length,
      avgPct: avg === null ? null : r1(avg),
      total: total ? total.score : null,
      totalFull: total ? total.full : null,
      rank: rankOf(classOrdered, studentId),
      classSize: classOrdered.length,
      strongest: byPct.length ? byPct[0] : null,
      weakest: byPct.length > 1 ? byPct[byPct.length - 1] : null,
      subjects
    };
  };

  const exams = examNames.map(examView);
  const latest = exams[0];
  const prev = exams[1];
  const delta = (latest && prev && latest.avgPct !== null && prev.avgPct !== null)
    ? r1(latest.avgPct - prev.avgPct) : null;

  return {
    has: true,
    exam: latest.exam,
    subjectCount: latest.subjectCount,
    avgPct: latest.avgPct,
    total: latest.total,
    totalFull: latest.totalFull,
    rank: latest.rank,
    classSize: latest.classSize,
    strongest: latest.strongest,
    weakest: latest.weakest,
    subjects: latest.subjects,
    prevExam: prev ? prev.exam : '',
    delta,
    examCount: exams.length
  };
}

module.exports = {
  valid, dedupe, avgPct, totalOf, classMatrix, examClassAvgs, rankOf,
  buildStudentAnalysis
};

// ==========================================================================
// v0.9.5 班级级分析（成绩全景矩阵 / 名次波动预警）
// 口径与上文一致：去重留最新、跨科比得分率、标准竞赛排名。
// ==========================================================================

// 规范科目序（grades 录入页的 10 科）；规范外科目按中文名排到规范科目之后
const SUBJECT_ORDER = ['语文', '数学', '英语', '物理', '化学', '道法', '历史', '生物', '地理', '艺术'];
const WAVE_RANK_DELTA = 8;   // 较上一次考试进退步达到该名次才预警（与对标作品一致）

function subjectOrderCompare(a, b) {
  const ia = SUBJECT_ORDER.indexOf(a);
  const ib = SUBJECT_ORDER.indexOf(b);
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  return a.localeCompare(b, 'zh');
}

// 考试按「全班在该次考试里最新记录的时间」从新到旧排
// （不能只看某一个学生，否则新转学生把一次旧考试顶成"最近"）
function orderedClassExams(allScores) {
  const clean = dedupe(allScores);
  const tmap = {};
  clean.forEach(r => {
    const ek = examKey(r);
    tmap[ek] = Math.max(tmap[ek] || 0, Number(r.updatedAt || 0), Number(r.date) || 0);
  });
  return Object.keys(tmap).sort((a, b) => tmap[b] - tmap[a]);
}

// 某次考试「至少有一条有效成绩」的学生集合（矩阵/波动只统计参加了该次考试的人）
function studentsInExam(matrix, exam) {
  return Object.keys(matrix).filter(sid => {
    const rows = matrix[sid][exam];
    return rows && rows.length;
  });
}

// 只在给定学生人群内算平均得分率排名，返回 Map(sid → rank)
function rankWithin(matrix, exam, sids) {
  const set = {};
  sids.forEach(sid => { set[sid] = true; });
  const ordered = Object.keys(matrix)
    .filter(sid => set[sid])
    .map(sid => ({ studentId: sid, avg: avgPct(matrix[sid][exam]) }))
    .filter(x => x.avg !== null)
    .sort((a, b) => b.avg - a.avg);
  const out = {};
  let lastAvg = null, lastRank = 0;
  ordered.forEach((x, i) => {
    const rank = (lastAvg !== null && x.avg === lastAvg) ? lastRank : i + 1;
    out[x.studentId] = rank;
    lastAvg = x.avg;
    lastRank = rank;
  });
  return out;
}

// 班级名次波动：取全班最近两次考试，只对「两次都参加」的学生在共同人群内排名，
// 输出 |delta| >= threshold 的退步/进步名单。考试不足两次返回空结构。
function buildClassWave(allScores, threshold = WAVE_RANK_DELTA) {
  const empty = { latestExam: '', prevExam: '', down: [], up: [] };
  const matrix = classMatrix(allScores);
  const exams = orderedClassExams(allScores);
  if (exams.length < 2) return empty;
  const latestExam = exams[0];
  const prevExam = exams[1];

  const latestSet = studentsInExam(matrix, latestExam);
  const prevSet = studentsInExam(matrix, prevExam);
  const common = latestSet.filter(sid => prevSet.indexOf(sid) >= 0);
  if (!common.length) return { latestExam, prevExam, down: [], up: [] };

  const rankNow = rankWithin(matrix, latestExam, common);
  const rankPrev = rankWithin(matrix, prevExam, common);

  const moved = common.map(sid => ({
    studentId: sid,
    rankNow: rankNow[sid],
    rankPrev: rankPrev[sid],
    delta: rankPrev[sid] - rankNow[sid]   // 正=进步（名次数字变小），负=退步
  })).filter(x => Math.abs(x.delta) >= threshold);

  const down = moved.filter(x => x.delta < 0).sort((a, b) => a.delta - b.delta || a.rankNow - b.rankNow);
  const up = moved.filter(x => x.delta > 0).sort((a, b) => b.delta - a.delta || a.rankNow - b.rankNow);
  return { latestExam, prevExam, down, up };
}

// 学生个人成绩全景：行=考试（新→旧，最多 maxExams 次），列=科目（规范序），缺考格 null。
// v0.9.6：全班大矩阵从成绩页撤下（48 人 × 10 科一屏根本看不清），
// 改成档案页单人全景——班主任真正的问题是「这个孩子哪科弱、走势怎样」。
// 返回 { exams, subjects, rows:[{exam, avg, cells:{科目:{score,full,pct}|null}}] }
function buildStudentPanorama(allScores, studentId, maxExams) {
  const empty = { exams: [], subjects: [], rows: [] };
  const mine = classMatrix(allScores)[studentId];
  if (!mine) return empty;
  const exams = orderedExamsFor(Object.keys(mine).reduce((a, ek) => a.concat(mine[ek]), []))
    .slice(0, maxExams || 6);
  if (!exams.length) return empty;

  const subjectSet = {};
  exams.forEach(ek => (mine[ek] || []).forEach(r => { subjectSet[String(r.subject || '')] = true; }));
  const subjects = Object.keys(subjectSet).sort(subjectOrderCompare);

  const rows = exams.map(ek => {
    const cells = {};
    (mine[ek] || []).forEach(r => {
      cells[String(r.subject || '')] = { score: r1(Number(r.score)), full: Number(r.full), pct: r1(pctOf(r)) };
    });
    subjects.forEach(sk => { if (!cells[sk]) cells[sk] = null; });
    const avg = avgPct(mine[ek]);
    return { exam: ek, avg: avg === null ? null : r1(avg), cells };
  });
  return { exams, subjects, rows };
}

module.exports = {
  valid, dedupe, avgPct, totalOf, classMatrix, examClassAvgs, rankOf,
  buildStudentAnalysis,
  SUBJECT_ORDER, WAVE_RANK_DELTA, subjectOrderCompare,
  buildClassWave, buildStudentPanorama
};
