// v0.9.5 内存级真机渲染验证：不写云库，直接灌 page.students/allScores 后读 data + 截图
const { connectOrLaunch, sleep, evalRetry } = require('./mp.js');

// switchTab 偶发不落地（实测掉回 dashboard），轮询 3 轮
async function land(mp, route, isTab) {
  for (let i = 0; i < 3; i++) {
    try { if (isTab) await mp.switchTab(route); else await mp.reLaunch(route); } catch (e) {}
    await sleep(1500);
    const path = await mp.evaluate(() => { const p = getCurrentPages().slice(-1)[0]; return p && p.route; });
    if (path === route.replace(/^\//, '')) return true;
  }
  return false;
}

(async () => {
  const { mp } = await connectOrLaunch(9491);
  const fail = m => { console.log('❌ ' + m); process.exitCode = 1; };
  const ok = m => console.log('✅ ' + m);
  try {
    /* ---------- 成绩页：波动 + 矩阵 ---------- */
    if (!await land(mp, '/pages/grades/grades', true)) { fail('无法进入成绩页'); throw new Error('nav'); }
    await sleep(2000);
    await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      if (typeof pg.rebuild !== 'function') throw new Error('rebuild missing on ' + pg.route);
      const students = [];
      for (let i = 1; i <= 11; i++) students.push({ _id: 'S' + i, name: '同学' + i, studentNo: String(i).padStart(2, '0') });
      const scores = [];
      const finalPct = [99,97,95,93,91,89,87,85,83,81,79];
      students.forEach((s, i) => {
        ['语文', '数学'].forEach(sub => scores.push({ _id: 'f' + s._id + sub, studentId: s._id, exam: '期末考试', subject: sub, score: finalPct[i], full: 100, date: '2026-09-01', updatedAt: 200 }));
      });
      const prevRank = ['S9','S1','S11','S4','S5','S6','S7','S8','S2','S10','S3'];
      prevRank.forEach((sid, i) => ['语文', '数学'].forEach(sub =>
        scores.push({ _id: 'p' + sid + sub, studentId: sid, exam: '开学考试', subject: sub, score: 99 - i * 2, full: 100, date: '2026-08-01', updatedAt: 100 })));
      pg.students = students;
      pg.allScores = scores;
      pg.dirty = {};
      pg.setData({ exams: ['期末考试', '开学考试'], examIndex: 0, subjectIndex: 0, full: '100' });
      pg.rebuild();
    });
    await sleep(800);
    const g = await mp.evaluate(() => {
      const pg = getCurrentPages().slice(-1)[0];
      return {
        path: pg.route,
        hasMatrix: 'matrix' in pg.data,   // v0.9.6：全班大矩阵已撤到档案页，成绩页不应再有
        wave: pg.data.wave && { prev: pg.data.wave.prevExam, down: pg.data.wave.down, up: pg.data.wave.up }
      };
    });
    console.log('成绩页数据：', JSON.stringify(g));
    if (!g.hasMatrix) ok('全班大矩阵已从成绩页撤下'); else fail('成绩页仍有 matrix 数据');
    if (g.wave && g.wave.prev === '开学考试') {
      const dn = g.wave.down.map(x => x.name), up = g.wave.up.map(x => x.name);
      if (dn.includes('同学9') && dn.includes('同学11') && up.includes('同学3') && !up.includes('同学2'))
        ok('波动名单正确：下滑=' + dn + ' 进步=' + up);
      else fail('波动名单错误：' + JSON.stringify(g.wave));
    } else fail('波动卡缺失：' + JSON.stringify(g.wave));
    await mp.screenshot({ path: '/tmp/v095-grades.png' });
    ok('成绩页截图 /tmp/v095-grades.png');

    /* ---------- 档案页：个人成绩全景（v0.9.6 从成绩页搬来） ---------- */
    if (!await land(mp, '/pages/profile/profile', false)) { fail('无法进入档案页'); throw new Error('nav-p'); }
    await sleep(1500);
    await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      if (typeof pg.buildPanoramaView !== 'function') throw new Error('buildPanoramaView missing on ' + pg.route);
      const view = pg.buildPanoramaView([
        { studentId: 'S1', exam: '期末考试', subject: '语文', score: 99, full: 100, date: '2026-09-01', updatedAt: 200 },
        { studentId: 'S1', exam: '期末考试', subject: '数学', score: 45, full: 100, date: '2026-09-01', updatedAt: 200 },
        { studentId: 'S1', exam: '开学考试', subject: '语文', score: 70, full: 100, date: '2026-08-01', updatedAt: 100 },
        { studentId: 'S2', exam: '期末考试', subject: '语文', score: 60, full: 100, date: '2026-09-01', updatedAt: 200 }
      ], 'S1');
      if (!view) throw new Error('panorama null');
      getCurrentPages().slice(-1)[0]._panoProbe = {
        exams: view.rows.map(r => r.exam), subjects: view.subjects,
        firstRowAvg: view.rows[0].avg,
        cellSample: view.rows[0].cells.map(c => c.text + '/' + c.cls),
        gapCell: view.rows[1].cells[1]
      };
    });
    const pv = await mp.evaluate(() => getCurrentPages().slice(-1)[0]._panoProbe);
    console.log('全景探针：', JSON.stringify(pv));
    if (pv.exams.join() === '期末考试,开学考试' && pv.subjects.join() === '语文,数学') ok('全景 行=考试新→旧 列=规范科目序'); else fail('全景结构错误：' + JSON.stringify(pv));
    if (pv.firstRowAvg === '72') ok('期末平均得分率 72（(99+45)/2），实际 ' + pv.firstRowAvg); else fail('全景均分错误：' + pv.firstRowAvg);
    if (pv.cellSample[0] === '99/1' && pv.cellSample[1] === '45/5') ok('分档 99→1档 45→5档'); else fail('全景分档错误：' + pv.cellSample);
    if (pv.gapCell && pv.gapCell.text === '—' && pv.gapCell.cls === 0) ok('开学考数学缺考格为 —/0档'); else fail('缺考格错误：' + JSON.stringify(pv.gapCell));

    /* ---------- 首页：复制日报 ---------- */
    if (!await land(mp, '/pages/dashboard/dashboard', true)) { fail('无法进入首页'); throw new Error('nav2'); }
    await sleep(2500);
    await evalRetry(mp, () => {
      const pg = getCurrentPages().slice(-1)[0];
      if (pg.route !== 'pages/dashboard/dashboard') throw new Error('not dashboard');
      pg._reportInput = {
        students: [{ _id: 'S1', name: '张三' }, { _id: 'S2', name: '李四' }, { _id: 'S3', name: '王五' }],
        attendance: [{ studentId: 'S1', status: '迟到' }, { studentId: 'S2', status: '正常' }, { studentId: 'S3', status: '正常' }],
        homeworkToday: [{ _id: 'h1', title: '数学练习册', subject: '数学' }],
        submits: [{ homeworkId: 'h1', studentId: 'S2', status: '已交' }, { homeworkId: 'h1', studentId: 'S3', status: '已交' }],
        dutySchedule: [{ weekday: 1, job: '扫地', studentId: 'S2' }],
        todos: [{ title: '收伙食费' }],
        date: '2026-09-13', weekdayLabel: '周日', dutyWeekday: 1
      };
      pg.setData({ classTitle: '初三(2)班' });
      pg.onCopyReport();
    });
    await sleep(800);
    const clip = await mp.evaluate(() => new Promise(res => wx.getClipboardData({ success: r => res(r.data), fail: () => res('FAIL') })));
    console.log('剪贴板内容：\n' + clip);
    const need = ['【初三(2)班 班级日报 · 9月13日 周日】', '应到3人', '迟到1人（张三）', '数学练习册 1人', '值日：扫地 李四', '待办：1项未完成'];
    const miss = need.filter(x => clip.indexOf(x) < 0);
    if (!miss.length && clip !== 'FAIL') ok('日报 6 项要素全部进剪贴板'); else fail('日报缺：' + miss);
    await mp.screenshot({ path: '/tmp/v095-dashboard.png' });
    ok('首页截图 /tmp/v095-dashboard.png');
  } catch (e) {
    console.error('脚本异常', e);
    process.exitCode = 1;
  } finally {
    await mp.disconnect();
    console.log(process.exitCode ? '\n❌ 有失败项' : '\n🎉 全部通过');
    process.exit(process.exitCode || 0);
  }
})();
