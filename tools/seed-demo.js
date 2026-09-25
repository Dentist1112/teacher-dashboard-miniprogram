// 演示数据填充：让工作台不是空壳，方便真机逐项验收。
// 幂等：所有记录带 _demo: true，每次跑先清掉旧 _demo 再插新的，重复跑不堆积、不碰真实数据。
// ⚠️ 架构教训（2026-09-11 实测）：一个 evaluate 里做完全部清理/插入会撞 automator 30s 响应窗口，
//    客户端崩了小程序端循环还在跑，下次运行两边并发互踩。所以一律「Node 侧编排 + 小批 evaluate」：
//    每次 evaluate 只做 ≤12 条写入或 ≤15 条删除，单次远低于 30s。
// 用法: node tools/seed-demo.js
const { connectOrLaunch, sleep } = require('./mp.js');

const FLAKY = /timeout waiting for automator response|Connection closed|page is not on top of page stack|^Timeout$|is not valid JSON/i;
const DEMO_COLS = ['announcements', 'scores', 'rewards', 'homework', 'homeworkSubmit', 'attendance'];

let mp = null;
async function ev(fn, ...args) {
  let last = null;
  for (let i = 1; i <= 4; i++) {
    try { return await mp.evaluate(fn, ...args); }
    catch (e) {
      last = e;
      if (!FLAKY.test(e.message || '')) throw e;
      console.log(`  ⚠️ evaluate 抖动 ${i}/4，${i * 2}s 后重试`);
      await sleep(i * 2000);
    }
  }
  throw last;
}

// 小程序端：插入一批（每批 ≤12 条，utils/db.js 自带校验+幂等重试）
const addBatch = (rows, col) => {
  const db = require('utils/db.js');
  return (async () => {
    let n = 0;
    const errs = [];
    for (const r of rows) {
      try { await db.add(col, { ...r, _demo: true }); n++; }
      catch (e) { errs.push(String(e && (e.message || e)).slice(0, 80)); }
    }
    return { n, errs };
  })().catch(e => ({ n: 0, errs: [String(e && (e.message || e)).slice(0, 120)] }));
};

// 小程序端：清一批 _demo（≤15 条），返回剩余估计
const cleanBatch = col => {
  const db = require('utils/db.js');
  return (async () => {
    const old = await db.list(col, { _demo: true }, 15);
    for (const r of old) await db.remove(col, r._id);
    return { removed: old.length, maybeMore: old.length >= 15 };
  })().catch(e => ({ removed: 0, maybeMore: false, err: String(e && (e.message || e)).slice(0, 120) }));
};

const day = off => {
  const t = new Date(Date.now() + off * 86400000);
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
};
let _s = 20260911;
const rnd = () => { _s = (_s * 1103515245 + 12345) % 2147483648; return _s / 2147483648; };

(async () => {
  try {
    const conn = await connectOrLaunch(9491);
    mp = conn.mp;
    await sleep(2500);

    // 1. 读学生
    const stu = await ev(() => {
      const db = require('utils/db.js');
      return db.list('students', {}, 500, { orderBy: [['studentNo', 'asc']] })
        .then(list => list.map(s => ({ _id: s._id, studentNo: s.studentNo, name: s.name })))
        .catch(e => ({ error: String(e && (e.message || e)).slice(0, 120) }));
    });
    if (stu.error) throw new Error('读学生失败: ' + stu.error);
    console.log(`学生 ${stu.length} 人`);

    // 2. 分批清旧 demo 数据
    for (const col of DEMO_COLS) {
      let total = 0;
      for (let round = 0; round < 30; round++) {
        const r = await ev(cleanBatch, col);
        if (r.err) { console.log(`  ⚠️ 清 ${col} 出错: ${r.err}`); break; }
        total += r.removed;
        if (!r.maybeMore) break;
      }
      if (total) console.log(`清理 ${col}: ${total} 条旧演示数据`);
    }

    // 3. Node 侧生成全部数据，分批插入
    const jobs = [];
    const push = (col, rows) => { for (let i = 0; i < rows.length; i += 12) jobs.push({ col, rows: rows.slice(i, i + 12) }); };

    push('announcements', [
      { title: '期中考试安排通知', content: '本学期期中考试定于 10 月 15、16 日进行，请同学们提前复习，合理安排作息。考试期间带齐文具，诚信应考。', priority: '高', date: day(-1) },
      { title: '下周家长会通知', content: '定于下周五（9 月 18 日）下午 4:30 在本班教室召开家长会，请家长提前安排时间准时参加。', priority: '高', date: day(0) },
      { title: '秋季运动会报名开始', content: '学校秋季运动会将于 10 月下旬举行，请有意愿参加的同学到体育委员处报名，截止下周三。', priority: '中', date: day(-2) }
    ]);

    push('scores', stu.map(s => ({ studentId: s._id, exam: '9月月考', subject: '语文', score: Math.round(58 + rnd() * 41), full: 100 })));
    push('scores', stu.map(s => ({ studentId: s._id, exam: '9月月考', subject: '数学', score: Math.round(55 + rnd() * 44), full: 100 })));

    const rw = [
      { i: 0, type: '奖励', reason: '课堂发言积极', points: 2, date: day(-1) },
      { i: 3, type: '奖励', reason: '作业书写工整', points: 1, date: day(-1) },
      { i: 7, type: '奖励', reason: '主动帮助同学', points: 2, date: day(-2) },
      { i: 11, type: '奖励', reason: '卫生值日认真', points: 1, date: day(-3) },
      { i: 15, type: '奖励', reason: '月考进步明显', points: 3, date: day(0) },
      { i: 1, type: '惩戒', reason: '上课讲话', points: -1, date: day(-1) },
      { i: 5, type: '惩戒', reason: '未按时交作业', points: -2, date: day(-2) },
      { i: 9, type: '惩戒', reason: '课间追逐打闹', points: -1, date: day(-3) }
    ];
    push('rewards', rw.map(it => ({ studentId: stu[it.i % stu.length]._id, type: it.type, reason: it.reason, points: it.points, date: it.date })));

    // 作业：先插 2 份拿到 _id，再插收交
    const hwRows = [
      { subject: '语文', title: '练习册 32~34 页', content: '完成练习册 32 到 34 页全部题目，注意书写工整，家长签字。', assignDate: day(0), dueDate: day(1) },
      { subject: '数学', title: '口算题卡 第 5 页', content: '口算题卡第 5 页，计时 10 分钟完成。', assignDate: day(-3), dueDate: day(-1) }
    ];
    const hwIds = [];
    for (const h of hwRows) {
      const r = await ev(addBatch, [h], 'homework');
      if (!r.n) throw new Error('作业插入失败: ' + JSON.stringify(r.errs));
      const got = await ev(title => {
        const db = require('utils/db.js');
        return db.list('homework', { _demo: true, title }, 5).then(l => l[0] && l[0]._id);
      }, h.title);
      hwIds.push(got);
    }
    console.log('作业 2 份已插入');
    const subs = [];
    stu.forEach((s, i) => {
      if (i < 20) subs.push({ homeworkId: hwIds[0], studentId: s._id, status: '已交', remark: '', date: day(0) });
      else if (i < 23) subs.push({ homeworkId: hwIds[0], studentId: s._id, status: '补交', remark: '', date: day(0) });
      else if (i < 24) subs.push({ homeworkId: hwIds[0], studentId: s._id, status: '免交', remark: '病假', date: day(0) });
      subs.push({ homeworkId: hwIds[1], studentId: s._id, status: '已交', remark: '', date: day(-1) });
    });
    push('homeworkSubmit', subs);

    const att = [
      { i: 2, date: day(-1), status: '迟到' }, { i: 6, date: day(-1), status: '迟到' },
      { i: 10, date: day(-1), status: '请假' },
      { i: 4, date: day(0), status: '迟到' }, { i: 13, date: day(0), status: '请假', reason: '家中有事' }
    ];
    push('attendance', att.map(it => ({ studentId: stu[it.i % stu.length]._id, date: it.date, status: it.status })));

    // 4. 执行插入队列
    let added = 0;
    const errs = [];
    for (const job of jobs) {
      const r = await ev(addBatch, job.rows, job.col);
      added += r.n;
      if (r.errs && r.errs.length) errs.push({ col: job.col, errs: r.errs.slice(0, 3) });
      process.stdout.write(`\r插入进度 ${added} 条（${job.col}）...`);
    }
    console.log('');
    if (errs.length) {
      console.log('❌ 部分失败: ' + JSON.stringify(errs).slice(0, 400));
    } else {
      console.log(`✅ 演示数据填充完成：共 ${added + 2} 条（通知3/成绩${stu.length * 2}/奖惩8/作业2/收交${subs.length}/考勤5）`);
    }
    await mp.disconnect();
    process.exit(errs.length ? 1 : 0);
  } catch (e) {
    console.error('❌ seed-demo 中断: ' + (e && (e.message || e)));
    try { if (mp) await mp.disconnect(); } catch (e2) {}
    process.exit(1);
  }
})();
