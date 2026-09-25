// 数据卫生审查：查残留测试数据、孤儿记录、重复学号、字段缺失
const { connectOrLaunch, evalRetry } = require('./mp.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fix = process.argv.includes('--fix');

(async () => {
  const { mp, reused } = await connectOrLaunch(9491);
  await sleep(reused ? 1500 : 7000);

  const report = await evalRetry(mp, async doFix => {
    const db = wx.cloud.database();
    // 小程序端单次 get 上限 20 条，必须分页。但串行分页往返太多会撞 automator 的
    // evaluate 超时（加到 7 个集合就炸了），所以先 count 再并发拉所有分页。
    const all = async (name, where) => {
      const { total } = await db.collection(name).where(where || {}).count();
      const pages = Math.ceil(total / 20);
      const chunks = await Promise.all(Array.from({ length: pages }, (_, i) =>
        db.collection(name).where(where || {}).skip(i * 20).limit(20).get().then(r => r.data)));
      return [].concat(...chunks);
    };

    const [students, attendance, rewards, announcements, scores, homework, hwSubmit, seats, duties, sched, comm] = await Promise.all(
      ['students', 'attendance', 'rewards', 'announcements', 'scores', 'homework', 'homeworkSubmit', 'seats', 'dutySchedule', 'schedule', 'committee'].map(n => all(n)));

    const ids = new Set(students.map(s => s._id));
    // 测试残留：学号带 T/W/Z/REG/AUD 前缀，或带 _probe/_audit/_reg/_aud2/_aud3 标记
    const TESTNO = /^(T|W|Z|REG|AUD|SORT|DBLTAP|FIX|ORD)/i;
    const testFlag = r => r._probe || r._audit || r._reg || r._aud2 || r._aud3;
    const junkStu = students.filter(s => TESTNO.test(String(s.studentNo || '')) || testFlag(s) || /测试|审查|级联|重号|探针|诊断/.test(String(s.name || '')));
    const junkAnn = announcements.filter(a => testFlag(a) || TESTNO.test(String(a.title || '')) || /自动化|测试|回归/.test(String(a.title || '')));
    const orphanAtt = attendance.filter(a => !ids.has(a.studentId));
    const orphanRew = rewards.filter(r => !ids.has(r.studentId));

    // 重复学号
    const byNo = {};
    students.forEach(s => { const k = String(s.studentNo || '').trim(); (byNo[k] = byNo[k] || []).push(s.name); });
    const dupNo = Object.entries(byNo).filter(([, v]) => v.length > 1).map(([k, v]) => `${k}: ${v.join('/')}`);

    // 同一学生同一天多条考勤（应唯一）
    const attKey = {};
    attendance.forEach(a => { const k = a.studentId + '@' + a.date; attKey[k] = (attKey[k] || 0) + 1; });
    const dupAtt = Object.entries(attKey).filter(([, n]) => n > 1).length;

    // 缺关键字段
    const noName = students.filter(s => !String(s.name || '').trim()).length;
    const noStatus = attendance.filter(a => !String(a.status || '').trim()).length;

    // 奖惩积分符号：惩戒必须 <=0，奖励必须 >=0（不一致会让净积分算错）
    const badSign = rewards.filter(r => {
      const p = Number(r.points) || 0;
      return r.type === '惩戒' ? p > 0 : p < 0;
    }).map(r => `${r.type}/${r.points}/${r.reason}`);

    // 奖惩缺事由或缺学生引用
    const badRew = rewards.filter(r => !String(r.reason || '').trim() || !r.studentId).length;

    // 成绩：分数必须在 0..full 内；缺 exam/subject/full 会让统计失真
    const badScore = scores.filter(x => {
      const sc = Number(x.score);
      const fl = Number(x.full) || 100;
      return Number.isNaN(sc) || sc < 0 || sc > fl;
    }).map(x => `${x.exam}/${x.subject}/${x.score}(满分${x.full})`);
    const badScoreMeta = scores.filter(x => !String(x.exam || '').trim() || !String(x.subject || '').trim() || !Number(x.full)).length;
    const orphanScore = scores.filter(x => !ids.has(x.studentId)).length;
    // 同一学生同一考试同一科目应唯一（重复会让平均分算错）
    const scKey = {};
    scores.forEach(x => { const k = `${x.studentId}@${x.exam}@${x.subject}`; scKey[k] = (scKey[k] || 0) + 1; });
    const dupScore = Object.entries(scKey).filter(([, n]) => n > 1).length;
    // 测试残留成绩
    const junkScore = scores.filter(x => testFlag(x) || /GRTEST|E2EEXAM|TESTEXAM/i.test(String(x.exam || '')));

    // ---- 作业 ----
    const hwIds = new Set(homework.map(h => h._id));
    // 缺标题/截止日会让列表和「进行中」判断失效
    const badHwMeta = homework.filter(h => !String(h.title || '').trim() || !/^\d{4}-\d{2}-\d{2}$/.test(String(h.dueDate || ''))).map(h => `${h.subject}/${h.title}/${h.dueDate}`);
    // 截止日早于布置日 = 逻辑矛盾
    const badHwRange = homework.filter(h => h.assignDate && h.dueDate && h.dueDate < h.assignDate).map(h => `${h.title}: ${h.assignDate}→${h.dueDate}`);
    // 同科目+同标题+同截止日 重复布置
    const hwKey = {};
    homework.forEach(h => { const k = `${h.subject}@${h.title}@${h.dueDate}`; hwKey[k] = (hwKey[k] || 0) + 1; });
    const dupHw = Object.entries(hwKey).filter(([, n]) => n > 1).map(([k]) => k);
    const junkHw = homework.filter(h => testFlag(h) || /E2EHW|HWTEST|自动化|回归/i.test(String(h.title || '')));

    // ---- 收交记录 ----
    const OKSUBMIT = ['已交', '补交', '免交'];
    // 「未交」不该存记录（无记录即未交），存了会让完成率算重
    const badSubmitStatus = [...new Set(hwSubmit.map(x => x.status).filter(x => OKSUBMIT.indexOf(x) < 0))];
    const orphanSubmitHw = hwSubmit.filter(x => !hwIds.has(x.homeworkId)).length;
    const orphanSubmitStu = hwSubmit.filter(x => !ids.has(x.studentId)).length;
    // 同一作业同一学生只能一条
    const subKey = {};
    hwSubmit.forEach(x => { const k = `${x.homeworkId}@${x.studentId}`; subKey[k] = (subKey[k] || 0) + 1; });
    const dupSubmit = Object.entries(subKey).filter(([, n]) => n > 1).length;
    // 交的人数不能超过全班人数（超了说明有脏数据）
    const overSubmit = Object.entries(hwSubmit.reduce((m, x) => {
      m[x.homeworkId] = (m[x.homeworkId] || 0) + 1; return m;
    }, {})).filter(([, n]) => n > students.length).map(([k, n]) => `${k}:${n}人>${students.length}`);

    // ---- 学生档案 ----
    const OKTAGS = ['班干部', '需关注', '住宿', '走读', '体育特长', '艺术特长', '单亲家庭', '低保'];
    // tags 必须是数组：存成字符串会让 profile 页的 filter/indexOf 静默失效
    const badTagType = students.filter(s => s.tags !== undefined && s.tags !== null && !Array.isArray(s.tags))
      .map(s => `${s.studentNo}/${s.name}: ${typeof s.tags}`);
    // 标签枚举外的值进不了 TAG_CLS 映射，会掉到 chip-other（不算错但要能看见）
    const unknownTags = [...new Set([].concat(...students
      .map(s => Array.isArray(s.tags) ? s.tags : []))
      .filter(t => OKTAGS.indexOf(t) < 0))];
    // 出生日期格式：非 YYYY-MM-DD 会让 date picker 打不开
    const badBirth = students.filter(s => String(s.birth || '').trim()
      && !/^\d{4}-\d{2}-\d{2}$/.test(String(s.birth).trim())).map(s => `${s.name}:${s.birth}`);
    // 填了家长却抠不出 11 位手机号 = 关键时刻打不通（实测事故：seed 曾用 138****01 掩码格式）
    const badParentPhone = students.filter(s => String(s.parent || '').trim()
      && !/1[3-9]\d{9}/.test(String(s.parent))).map(s => `${s.studentNo}/${s.name}: ${s.parent}`);
    // 同一手机号挂到多个学生身上：多半是复制粘贴错了（双胞胎除外，所以只警示不算致命）
    const phoneMap = {};
    students.forEach(s => {
      const m = String(s.parent || '').match(/1[3-9]\d{9}/);
      if (m) (phoneMap[m[0]] = phoneMap[m[0]] || []).push(s.name);
    });
    const dupPhone = Object.entries(phoneMap).filter(([, v]) => v.length > 1).map(([k, v]) => `${k}: ${v.join('/')}`);

    // ---- 座位表 ----
    // 一人只能一座、一座只能一人：任一破了，页面会把同一个人画在两个格子里，老师照着排必错
    const seatByStu = {};
    const seatByPos = {};
    seats.forEach(x => {
      (seatByStu[x.studentId] = seatByStu[x.studentId] || []).push(x);
      const k = `${x.row}-${x.col}`;
      (seatByPos[k] = seatByPos[k] || []).push(x);
    });
    const dupSeatStu = Object.entries(seatByStu).filter(([, v]) => v.length > 1)
      .map(([sid, v]) => `${(students.find(s => s._id === sid) || {}).name || sid}: ${v.length} 座`);
    const dupSeatPos = Object.entries(seatByPos).filter(([, v]) => v.length > 1)
      .map(([k, v]) => `${k}: ${v.map(x => (students.find(s => s._id === x.studentId) || {}).name || '?').join('/')}`);
    const orphanSeat = seats.filter(x => !ids.has(x.studentId)).length;
    // 坐标必须是非负整数：字符串 '1' 或 -1 会让网格渲染错位
    const badSeatPos = seats.filter(x => !Number.isInteger(x.row) || !Number.isInteger(x.col) || x.row < 0 || x.col < 0)
      .map(x => `${(students.find(s => s._id === x.studentId) || {}).name || x.studentId}: (${JSON.stringify(x.row)},${JSON.stringify(x.col)})`);
    // 座位记录数不能超过在册人数（超了必是脏数据）
    const seatOverflow = seats.length > students.length ? `${seats.length} 条 > 在册 ${students.length} 人` : '';

    // ---- 值日表 ----
    const OKJOBS = ['扫地', '擦黑板', '倒垃圾', '摆桌椅', '关窗锁门'];
    // weekday 必须是 1~5 的整数：字符串 '1' 或 0/6/7 会让周表整格丢失（页面按 Number 比对）
    const badDutyDay = duties.filter(x => !Number.isInteger(x.weekday) || x.weekday < 1 || x.weekday > 5)
      .map(x => `${(students.find(s => s._id === x.studentId) || {}).name || x.studentId}: weekday=${JSON.stringify(x.weekday)}`);
    // 岗位必须在枚举内：枚举外的值进不了 JOB_CLS 映射，标签会变透明看不见
    const badDutyJob = [...new Set(duties.map(x => x.job).filter(j => OKJOBS.indexOf(j) < 0))];
    const orphanDuty = duties.filter(x => !ids.has(x.studentId)).length;
    // 同一天同一岗位同一个人只能一条（重复会让「人均次数」和「未排到」算错）
    const dutyKey = {};
    duties.forEach(x => { const k = `${x.weekday}@${x.job}@${x.studentId}`; dutyKey[k] = (dutyKey[k] || 0) + 1; });
    const dupDuty = Object.entries(dutyKey).filter(([, n]) => n > 1)
      .map(([k, n]) => `${k} × ${n}`);
    // 一个人一天被排了多个岗位：不算错（可能故意），但要能看见
    const perDayPerson = {};
    duties.forEach(x => { const k = `${x.weekday}@${x.studentId}`; perDayPerson[k] = (perDayPerson[k] || 0) + 1; });
    const multiJobSameDay = Object.entries(perDayPerson).filter(([, n]) => n > 1)
      .map(([k, n]) => `${(students.find(s => s._id === k.split('@')[1]) || {}).name || '?'} 周${k.split('@')[0]} 排了 ${n} 个岗位`);

    // ---- 课程表 ----
    // schedule 不含 studentId，没有孤儿概念；核心不变量是「一格一课」+ 字段合法
    // 与 pages/schedule/schedule.js 的 SUBJECTS/PERIODS 必须同源。
    // 午间延时的 period=9（挂数字末尾，页面按 PERIODS 数组顺序显示在上午之后）。
    const OKSUBJECTS = ['语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理', '体育', '音乐', '美术', '艺术', '信息', '自习'];
    const OKPERIODS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const SCHED_SLOTS = 5 * OKPERIODS.length;   // 45 格
    // weekday/period 必须是整数：字符串 '1' 会让该格在页面上整格丢失（页面按 Number 比对）
    const badSchedDay = sched.filter(x => !Number.isInteger(x.weekday) || x.weekday < 1 || x.weekday > 5)
      .map(x => `weekday=${JSON.stringify(x.weekday)}/${x.subject}`);
    const badSchedPeriod = sched.filter(x => !Number.isInteger(x.period) || OKPERIODS.indexOf(x.period) < 0)
      .map(x => `period=${JSON.stringify(x.period)}/${x.subject}`);
    // 科目枚举外的值进不了 SUB_CLS 映射，格子会变成没底色的空白块
    const badSchedSubject = [...new Set(sched.map(x => x.subject).filter(s => OKSUBJECTS.indexOf(s) < 0))]
      .map(s => JSON.stringify(s));
    // 一格一课：同 weekday@period 多条会让页面只显示其中一条，老师看到的和云端不一致
    const schedKey = {};
    sched.forEach(x => { const k = `${x.weekday}@${x.period}`; schedKey[k] = (schedKey[k] || 0) + 1; });
    const dupSched = Object.entries(schedKey).filter(([, n]) => n > 1).map(([k, n]) => `${k} × ${n}`);
    // 课表条数不能超过 45 格（5 天 × 9 节，含午间延时），超了必是脏数据
    const schedOverflow = sched.length > SCHED_SLOTS ? `${sched.length} 条 > ${SCHED_SLOTS} 格` : '';

    // ---- 班委 ----
    const OKPOSTS = ['班长', '副班长', '学习委员', '纪律委员', '劳动委员', '文艺委员',
      '体育委员', '宣传委员', '生活委员', '语文科代表', '数学科代表', '英语科代表'];
    // 岗位枚举外的值进不了 POST_CLS 映射，标签会变成没底色的空白块
    const badCommPost = [...new Set(comm.map(x => x.post).filter(p => OKPOSTS.indexOf(p) < 0))]
      .map(p => JSON.stringify(p));
    // 一岗最多两人：同 post 超过 2 条必是脏数据；同一 post+studentId 重复也算脏
    const commKey = {};
    comm.forEach(x => { commKey[x.post] = (commKey[x.post] || 0) + 1; });
    const dupCommPost = Object.entries(commKey).filter(([, n]) => n > 2).map(([k, n]) => `${k} × ${n}`);
    const pairSeen = {};
    const samePair = [];
    comm.forEach(x => {
      const k = x.post + '@' + x.studentId;
      if (pairSeen[k]) samePair.push(k);
      pairSeen[k] = 1;
    });
    dupCommPost.push(...samePair);
    const orphanComm = comm.filter(x => !ids.has(x.studentId)).length;
    // 一个人兼多个岗位：不算错（现实里会发生），但要能看见
    const commByStu = {};
    comm.forEach(x => { (commByStu[x.studentId] = commByStu[x.studentId] || []).push(x.post); });
    const multiPostPerson = Object.entries(commByStu).filter(([, v]) => v.length > 2)
      .map(([sid, v]) => `${(students.find(s => s._id === sid) || {}).name || sid}: ${v.join('/')}`);
    // 任职记录数不能超过 岗位数×2（超了必是脏数据）
    const commCap = OKPOSTS.length * 2;
    const commOverflow = comm.length > commCap ? `${comm.length} 条 > ${commCap}（${OKPOSTS.length} 岗 × 2 人）` : '';

    // classInfo 必须是单文档
    const ciCount = (await db.collection('classInfo').count()).total;

    // 考勤状态必须在允许集合内（拼错会让概览「异常」统计失真）
    const OKSTATUS = ['正常', '迟到', '缺勤', '请假'];
    const weirdStatus = [...new Set(attendance.map(a => a.status).filter(x => OKSTATUS.indexOf(x) < 0))];

    let fixed = null;
    if (doFix) {
      const del = (c, arr) => Promise.all(arr.map(x => db.collection(c).doc(x._id).remove().catch(() => null)));
      await del('students', junkStu);
      await del('announcements', junkAnn);
      const junkRew = rewards.filter(r => testFlag(r) || /REWTEST|DBLREW|E2EREW|E2E校验|校验测试|审查|级联|回归/.test(String(r.reason || '')));
      await del('rewards', junkRew);
      await del('scores', junkScore);
      await del('homework', junkHw);
      // 作业被删 → 收交记录跟着删（不然变孤儿，完成率算错）
      const junkHwIds = new Set(junkHw.map(h => h._id));
      const delSubHw = hwSubmit.filter(x => junkHwIds.has(x.homeworkId) || !hwIds.has(x.homeworkId));
      await del('homeworkSubmit', delSubHw);
      // 删完垃圾学生后重算孤儿
      const stillIds = new Set(students.filter(s => junkStu.indexOf(s) < 0).map(s => s._id));
      const delAtt = attendance.filter(a => !stillIds.has(a.studentId));
      const delRewOrphan = rewards.filter(r => !stillIds.has(r.studentId));
      const delScoreOrphan = scores.filter(x => !stillIds.has(x.studentId));
      await del('attendance', delAtt);
      await del('rewards', delRewOrphan);
      await del('scores', delScoreOrphan);
      const delSubStu = hwSubmit.filter(x => !stillIds.has(x.studentId));
      await del('homeworkSubmit', delSubStu);
      // 座位：孤儿 + 一人多座（保留第一条）+ 一座多人（保留第一条）+ 坐标非法
      const keepSeat = new Set();
      const posTaken = new Set();
      const delSeat = [];
      seats.forEach(x => {
        const posOk = Number.isInteger(x.row) && Number.isInteger(x.col) && x.row >= 0 && x.col >= 0;
        const k = `${x.row}-${x.col}`;
        if (!stillIds.has(x.studentId) || !posOk || keepSeat.has(x.studentId) || posTaken.has(k)) {
          delSeat.push(x);
          return;
        }
        keepSeat.add(x.studentId);
        posTaken.add(k);
      });
      await del('seats', delSeat);
      // 值日：孤儿 + 非法 weekday/岗位 + 同键重复（保留第一条）
      const dutyKeep = new Set();
      const delDuty = [];
      duties.forEach(x => {
        const k = `${x.weekday}@${x.job}@${x.studentId}`;
        const dayOk = Number.isInteger(x.weekday) && x.weekday >= 1 && x.weekday <= 5;
        const jobOk = OKJOBS.indexOf(x.job) >= 0;
        if (!stillIds.has(x.studentId) || !dayOk || !jobOk || dutyKeep.has(k)) { delDuty.push(x); return; }
        dutyKeep.add(k);
      });
      await del('dutySchedule', delDuty);
      // 课表：非法 weekday/period/科目 + 同格重复（保留第一条）。无孤儿概念
      const schedKeep = new Set();
      const delSched = [];
      sched.forEach(x => {
        const k = `${x.weekday}@${x.period}`;
        const dayOk = Number.isInteger(x.weekday) && x.weekday >= 1 && x.weekday <= 5;
        const perOk = Number.isInteger(x.period) && OKPERIODS.indexOf(x.period) >= 0;
        const subOk = OKSUBJECTS.indexOf(x.subject) >= 0;
        if (!dayOk || !perOk || !subOk || schedKeep.has(k)) { delSched.push(x); return; }
        schedKeep.add(k);
      });
      await del('schedule', delSched);
      // 班委：孤儿 + 岗位枚举外 + 同岗重复（保留第一条）
      const commKeep = new Set();
      const delComm = [];
      comm.forEach(x => {
        const postOk = OKPOSTS.indexOf(x.post) >= 0;
        if (!stillIds.has(x.studentId) || !postOk || commKeep.has(x.post)) { delComm.push(x); return; }
        commKeep.add(x.post);
      });
      await del('committee', delComm);
      // 每一项都要出数字：否则「已修复: null / 都是 0」时分不清是没脏数据还是 fix 没跑
      fixed = { 删学生: junkStu.length, 删通知: junkAnn.length, 删奖惩: junkRew.length,
        删成绩: junkScore.length, 删作业: junkHw.length,
        删收交_作业已删: delSubHw.length, 删收交_学生已删: delSubStu.length,
        删考勤: delAtt.length, 删孤儿奖惩: delRewOrphan.length, 删孤儿成绩: delScoreOrphan.length,
        删座位_孤儿或重复: delSeat.length, 删值日_孤儿或重复: delDuty.length,
        删课表_非法或重复: delSched.length, 删班委_孤儿或重复: delComm.length };
    }

    return {
      总量: { 学生: students.length, 考勤: attendance.length, 奖惩: rewards.length, 通知: announcements.length,
        成绩: scores.length, 作业: homework.length, 收交: hwSubmit.length, 座位: seats.length, 值日: duties.length, 课表: sched.length, 班委: comm.length },
      问题: {
        测试残留学生: junkStu.map(s => `${s.studentNo}/${s.name}`),
        测试残留通知: junkAnn.map(a => a.title),
        测试残留奖惩: rewards.filter(r => testFlag(r) || /REWTEST|DBLREW|E2EREW|E2E校验|校验测试|审查|级联|回归/.test(String(r.reason || ''))).map(r => r.reason),
        孤儿考勤: orphanAtt.length,
        孤儿奖惩: orphanRew.length,
        重复学号: dupNo,
        同人同日多条考勤: dupAtt,
        学生缺姓名: noName,
        考勤缺状态: noStatus,
        积分符号错: badSign,
        奖惩缺事由或学生: badRew,
        考勤状态非法值: weirdStatus,
        测试残留成绩: junkScore.map(x => `${x.exam}/${x.subject}`),
        成绩超范围: badScore,
        成绩缺考试或科目或满分: badScoreMeta,
        孤儿成绩: orphanScore,
        同人同考同科重复: dupScore,
        测试残留作业: junkHw.map(h => `${h.subject}/${h.title}`),
        作业缺标题或截止日: badHwMeta,
        作业截止早于布置: badHwRange,
        重复布置作业: dupHw,
        收交状态非法值: badSubmitStatus,
        孤儿收交_作业已删: orphanSubmitHw,
        孤儿收交_学生已删: orphanSubmitStu,
        同作业同人多条收交: dupSubmit,
        收交人数超全班: overSubmit,
        标签非数组: badTagType,
        标签枚举外的值: unknownTags,
        出生日期格式错: badBirth,
        家长信息无有效手机号: badParentPhone,
        手机号重复挂多人: dupPhone,
        一人多座: dupSeatStu,
        一座多人: dupSeatPos,
        孤儿座位_学生已删: orphanSeat,
        座位坐标非法: badSeatPos,
        座位数超全班: seatOverflow,
        值日weekday非法: badDutyDay,
        值日岗位枚举外: badDutyJob,
        孤儿值日_学生已删: orphanDuty,
        同天同岗重复排人: dupDuty,
        同一天排多个岗位: multiJobSameDay,
        课表weekday非法: badSchedDay,
        课表period非法: badSchedPeriod,
        课表科目枚举外: badSchedSubject,
        同格重复排课: dupSched,
        课表条数超格数上限: schedOverflow,
        班委岗位枚举外: badCommPost,
        同岗重复任职: dupCommPost,
        孤儿班委_学生已删: orphanComm,
        一人兼多岗: multiPostPerson,
        班委条数超岗位数: commOverflow,
        classInfo条数: ciCount
      },
      已修复: fixed
    };
  }, [fix]);

  console.log(JSON.stringify(report, null, 1));
  const p = report.问题;
  const bad = p.测试残留学生.length + p.测试残留通知.length + p.测试残留奖惩.length + p.测试残留成绩.length
    + p.孤儿考勤 + p.孤儿奖惩 + p.孤儿成绩
    + p.重复学号.length + p.同人同日多条考勤 + p.同人同考同科重复
    + p.学生缺姓名 + p.考勤缺状态 + p.积分符号错.length + p.奖惩缺事由或学生
    + p.考勤状态非法值.length + p.成绩超范围.length + p.成绩缺考试或科目或满分
    + p.测试残留作业.length + p.作业缺标题或截止日.length + p.作业截止早于布置.length + p.重复布置作业.length
    + p.收交状态非法值.length + p.孤儿收交_作业已删 + p.孤儿收交_学生已删
    + p.同作业同人多条收交 + p.收交人数超全班.length
    + p.标签非数组.length + p.出生日期格式错.length + p.家长信息无有效手机号.length
    + p.一人多座.length + p.一座多人.length + p.孤儿座位_学生已删 + p.座位坐标非法.length
    + (p.座位数超全班 ? 1 : 0)
    + p.值日weekday非法.length + p.值日岗位枚举外.length + p.孤儿值日_学生已删 + p.同天同岗重复排人.length
    + p.课表weekday非法.length + p.课表period非法.length + p.课表科目枚举外.length + p.同格重复排课.length
    + (p.课表条数超格数上限 ? 1 : 0)
    + p.班委岗位枚举外.length + p.同岗重复任职.length + p.孤儿班委_学生已删
    + (p.班委条数超岗位数 ? 1 : 0)
    + (p.classInfo条数 > 1 ? 1 : 0);
  console.log(bad === 0 ? '\n✅ 数据卫生检查通过' : `\n❌ 发现 ${bad} 处问题${fix ? '（已尝试修复，请重跑确认）' : '，加 --fix 自动清理'}`);
  await mp.disconnect(); // 不用 close()：close 会关掉用户的 IDE 项目窗口
  process.exit(bad === 0 ? 0 : 1);
})();
