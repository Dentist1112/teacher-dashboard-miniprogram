// seed 云函数：灌入示例数据用于界面预览。event.clear=true 先清空同 openid 数据
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const NAMES = ['王雨桐','李承泽','张思远','刘沐晴','陈嘉行','杨知微','赵一鸣','周静姝','吴子墨','郑晚舟',
  '孙皓月','马书言,','徐念安','胡砚清','朱行舟','高langyue','林晚照','何清和','罗听雪','梁怀瑾',
  '宋屿森','谢知秋','唐若青','韩星野','曹叙白','邓亦然','许南风','冯照野','曾明煦','程灼华'];
const GIRL = new Set([1,3,5,7,9,11,12,15,16,17,18,19,21,22,23,26,27]);

const RELATION = ['母亲', '父亲', '爷爷', '奶奶'];
const PHONE_PREFIX = ['38', '39', '50', '55', '86', '77'];
// 覆盖档案页的各种分支：正常 / 过敏 / 用药 / 慢性病 / 空值（测「缺健康」统计）
const HEALTH = [
  '良好', '良好', '花生过敏，随身备氯雷他定', '良好', '哮喘，备沙丁胺醇',
  '良好', '', '轻度贫血，定期复查', '良好', '良好',
  '青霉素过敏，禁用头孢', '良好', '', '良好', '先天性心脏病，禁剧烈运动',
  '良好', '良好', '海鲜过敏', '良好', '癫痫史，随身备药',
  '良好', '', '蚕豆病，禁食蚕豆及氧化性药物', '良好', '良好',
  '晕车，长途需备晕车贴', '良好', '良好', '1 型糖尿病，随身备胰岛素', '良好'
];
function TAGS_OF(i) {
  const t = [];
  if (i % 7 === 0) t.push('班干部');
  if (i % 5 === 0 && i % 7 !== 0) t.push('需关注');
  if (i % 3 === 0) t.push('住宿'); else if (i % 3 === 1) t.push('走读');
  if (i % 11 === 4) t.push('体育特长');
  if (i % 13 === 6) t.push('艺术特长');
  if (i % 17 === 9) t.push('单亲家庭');
  return t;
}

function d(offset) {
  const t = new Date(Date.now() + offset * 86400000);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

exports.main = async event => {
  const openid = cloud.getWXContext().OPENID;
  // 按 count 循环删干净：不能用「本批 <100 就 break」，删除有延迟会漏掉后续分页
  // 用 where().remove() 批量删（云函数 admin 权限支持），一次往返搞定，避免 3s timeout
  const wipe = name => db.collection(name).where({ _openid: openid }).remove().catch(() => null);

  if (event && event.clear) {
    await Promise.all(['attendance', 'rewards', 'scores', 'students', 'announcements', 'classInfo',
      'homework', 'homeworkSubmit', 'todos', 'seats', 'dutySchedule', 'schedule', 'committee'].map(wipe));
  }

  const now = Date.now();
  const exist = await db.collection('students').where({ _openid: openid }).count();
  if (exist.total > 0 && !(event && event.force)) {
    // 老账号不重置学生数据，但 2026-09-12 新增 todos 集合时要补示例待办，
    // 否则老师升级后待办页空空，不知道分组长什么样。todos 已有数据就不补（幂等）。
    let seededTodos = 0;
    try {
      const todoCnt = await db.collection('todos').where({ _openid: openid }).count();
      if (todoCnt.total === 0) {
        const demoTodos = [
          { title: '收周五体检的家长知情同意书', done: false, dueDate: d(-1) },
          { title: '批改第三单元语文试卷', done: false, dueDate: d(0) },
          { title: '准备下周家长会发言稿', done: false, dueDate: d(1) },
          { title: '更新教室文化墙照片', done: false, dueDate: d(5) },
          { title: '想想运动会班级口号', done: false, dueDate: '' },
          { title: '登记新生校服尺码', done: true, dueDate: d(-2) }
        ];
        await Promise.all(demoTodos.map(t => db.collection('todos').add({ data: { ...t, _openid: openid, updatedAt: now } })));
        seededTodos = demoTodos.length;
      }
    } catch (e) { /* todos 集合刚建时延迟可见，下次启动再补 */ }
    return { skipped: true, students: exist.total, seededTodos, msg: '已有数据，未重复灌入；已补示例待办 ' + seededTodos + ' 条' };
  }


  // 班级信息
  await db.collection('classInfo').add({ data: {
    _openid: openid,
    school: 'XX中学', className: '初三(1)班', grade: '初三', semester: '2026学年上',
    teacher: '胡老师', updatedAt: now
  }});

  // 学生 30 人（并发写入：云函数 timeout 只有 3s，串行 30 次必超时）
  const stuIds = await Promise.all(Array.from({ length: 30 }, (_, i) => {
    const no = String(i + 1).padStart(2, '0');
    return db.collection('students').add({ data: {
      _openid: openid,
      studentNo: no,
      name: NAMES[i].replace(',', ''),
      gender: GIRL.has(i) ? '女' : '男',
      birth: `2011-0${(i % 9) + 1}-1${i % 9}`,
      // 手机号必须是完整 11 位：掩码格式（138****01）抠不出号码，档案页拨号会全部失效
      parent: RELATION[i % 4] + ' 1' + PHONE_PREFIX[i % 6] + String(10000000 + i * 137).slice(-8),
      health: HEALTH[i % HEALTH.length],
      tags: TAGS_OF(i),
      updatedAt: now
    }}).then(r => r._id);
  }));

  // 今日考勤：2 人异常 + 其余正常（状态口径：正常/迟到/请假，已移除“缺勤”）
  const today = d(0);
  const abnormal = [[2, '迟到'], [9, '请假']];
  await Promise.all(stuIds.map((id, i) => {
    const hit = abnormal.find(a => a[0] === i);
    return db.collection('attendance').add({ data: {
      _openid: openid, studentId: id, date: today, status: hit ? hit[1] : '正常', updatedAt: now
    }});
  }));

  // 通知 4 条
  const notices = [
    { title: '周五下午体检，务必空腹', content: '本周五 14:00 全班到校医室体检，早餐请勿进食，带好医保卡。有慢性病史的同学提前告知班主任。', priority: '高', date: d(0) },
    { title: '第三次月考安排', content: '下周一至周三月考。语文/数学/英语上午，物理/化学/道法下午。考场为本班教室，按学号就座。', priority: '高', date: d(-1) },
    { title: '本周值日调整', content: '因周三教研会，周三值日组与周四对调，请两组同学互相确认。', priority: '中', date: d(-2) },
    { title: '校运会报名启动', content: '有意参加 100m / 800m / 跳远 / 接力的同学，本周五前找体育委员登记。', priority: '低', date: d(-4) }
  ];
  await Promise.all(notices.map(n => db.collection('announcements').add({ data: { ...n, _openid: openid, updatedAt: now } })));

  // 待办 5 条：覆盖 逾期/今天/明天/以后/无日期 + 1 条已完成，让新用户一眼看懂分组
  const todos = [
    { title: '收周五体检的家长知情同意书', done: false, dueDate: d(-1) },
    { title: '批改第三单元语文试卷', done: false, dueDate: d(0) },
    { title: '准备下周家长会发言稿', done: false, dueDate: d(1) },
    { title: '更新教室文化墙照片', done: false, dueDate: d(5) },
    { title: '想想运动会班级口号', done: false, dueDate: '' },
    { title: '登记新生校服尺码', done: true, dueDate: d(-2) }
  ];
  await Promise.all(todos.map(t => db.collection('todos').add({ data: { ...t, _openid: openid, updatedAt: now } })));

  // 奖惩 5 条
  const rewards = [
    { studentId: stuIds[0], type: '奖励', reason: '月考数学年级第 3', points: 5 },
    { studentId: stuIds[6], type: '奖励', reason: '主动帮同学补课两周', points: 3 },
    { studentId: stuIds[13], type: '惩戒', reason: '课上使用手机', points: -3 },
    { studentId: stuIds[20], type: '奖励', reason: '运动会 800m 第一', points: 5 },
    { studentId: stuIds[27], type: '惩戒', reason: '连续三次未交作业', points: -2 }
  ];
  await Promise.all(rewards.map((r, i) =>
    db.collection('rewards').add({ data: { ...r, _openid: openid, date: d(-i), updatedAt: now - i * 3600000 } })));

  // 成绩：语文/数学各 30 条，分数按学号做可复现的伪随机，覆盖各分段
  const EXAM = '第一次月考';
  const scoreOf = (i, base) => {
    const r = ((i * 37 + base) % 55); // 0..54
    return Math.min(100, 45 + r);     // 45..99
  };
  const scoreDocs = [];
  stuIds.forEach((id, i) => {
    scoreDocs.push({ _openid: openid, studentId: id, exam: EXAM, subject: '语文', score: scoreOf(i, 11), full: 100, date: d(-3), updatedAt: now });
    scoreDocs.push({ _openid: openid, studentId: id, exam: EXAM, subject: '数学', score: scoreOf(i, 29), full: 100, date: d(-3), updatedAt: now });
  });
  await Promise.all(scoreDocs.map(doc => db.collection('scores').add({ data: doc })));

  // 作业 4 条：2 条进行中（含今天到期）+ 1 条已过期 + 1 条无人交
  const hwDefs = [
    { subject: '数学', title: '练习册 P32-P34', content: '只做选择和填空，明早交组长', assignDate: d(0), dueDate: d(1), submitRate: 0.6 },
    { subject: '语文', title: '背诵《岳阳楼记》并默写', content: '默写在作文本上，家长签字', assignDate: d(0), dueDate: d(0), submitRate: 0.3 },
    { subject: '英语', title: 'Unit5 单词听写订正', content: '错题抄三遍', assignDate: d(-3), dueDate: d(-1), submitRate: 0.9 },
    { subject: '物理', title: '实验报告：测量小灯泡功率', content: '含数据表格和误差分析', assignDate: d(0), dueDate: d(3), submitRate: 0 }
  ];
  const hwIds = await Promise.all(hwDefs.map(h => db.collection('homework').add({ data: {
    _openid: openid,
    subject: h.subject, title: h.title, content: h.content,
    assignDate: h.assignDate, dueDate: h.dueDate, updatedAt: now
  }}).then(r => r._id)));

  // 收交记录：「未交」不存记录（无记录即未交），所以只写已交/补交/免交
  const submitDocs = [];
  hwDefs.forEach((h, hi) => {
    const n = Math.round(stuIds.length * h.submitRate);
    for (let i = 0; i < n; i++) {
      // 每 7 人里掺 1 个补交、每 11 人里掺 1 个免交，让状态分布可见
      const status = i % 11 === 10 ? '免交' : (i % 7 === 6 ? '补交' : '已交');
      submitDocs.push({
        _openid: openid,
        homeworkId: hwIds[hi],
        studentId: stuIds[i],
        status,
        remark: status === '免交' ? '病假' : '',
        date: h.dueDate,
        updatedAt: now
      });
    }
  });
  await Promise.all(submitDocs.map(doc => db.collection('homeworkSubmit').add({ data: doc })));

  // 座位：6 列，只排前 26 人（留 4 人未排座，让「未排座」分支有真数据可测）
  const SEAT_COLS = 6;
  const seatDocs = stuIds.slice(0, 26).map((id, i) => ({
    _openid: openid,
    studentId: id,
    row: Math.floor(i / SEAT_COLS),
    col: i % SEAT_COLS,
    updatedAt: now
  }));
  await Promise.all(seatDocs.map(doc => db.collection('seats').add({ data: doc })));

  // 值日表：5 天 × 5 岗 = 25 个位置，按学号轮排前 22 人（留 8 人未排到，
  // 让「本周没排到值日」这个告警分支有真数据可测）
  const DUTY_JOBS = ['扫地', '擦黑板', '倒垃圾', '摆桌椅', '关窗锁门'];
  const dutyDocs = stuIds.slice(0, 22).map((id, i) => ({
    _openid: openid,
    studentId: id,
    weekday: Math.floor(i / DUTY_JOBS.length) + 1,
    job: DUTY_JOBS[i % DUTY_JOBS.length],
    updatedAt: now
  }));
  await Promise.all(dutyDocs.map(doc => db.collection('dutySchedule').add({ data: doc })));

  // 课表：5 天 × 9 节 = 45 格（含午间延时 period=9）。只排前 6 节 × 5 天 = 30 节 + 5 节午间延时，
  //  第 7、8 节留空
  //（让「空课」统计和「套用模板」的对比有真数据；不排满是因为「无记录 = 空课」，不存占位）
  // 另外故意让周一的语文排 4 节 —— 触发「主科每天不超过 3 节」告警分支，
  // 否则那个 warn-card 永远拿不到真数据（值日表的「未排到」分支立过这个规矩）
  const SUB_AM = ['语文', '数学', '英语', '物理'];
  const SUB_PM = ['化学', '生物', '政治', '历史', '地理', '体育'];
  const schedDocs = [];
  for (let wd = 1; wd <= 5; wd++) {
    for (let pd = 1; pd <= 6; pd++) {
      let subject;
      if (wd === 1 && pd <= 4) subject = pd === 4 ? '语文' : SUB_AM[(pd - 1 + wd) % SUB_AM.length];
      else if (pd <= 4) subject = SUB_AM[(pd - 1 + wd) % SUB_AM.length];
      else subject = SUB_PM[(wd * 2 + pd) % SUB_PM.length];
      schedDocs.push({ _openid: openid, weekday: wd, period: pd, subject, teacher: '', updatedAt: now });
    }
    // 午间延时（period=9）：固定自习。排上是为了让「延时」这一行有真数据，
    // 否则页面上那一行永远是空课，看不出功能已生效。
    schedDocs.push({ _openid: openid, weekday: wd, period: 9, subject: '自习', teacher: '', updatedAt: now });
  }
  // 周一强制凑成 4 节语文（第 1、2、4、5 节）：本地推演过 —— 只改第 1、2 节的话周一恰好
  // 3 节语文，不超过上限，告警分支拿不到数据（第一版就是这个错，靠推演脚本抓出来的）。
  // 第 1、2 节相邻但第 3 节是物理，所以只触发「主科每天超上限」，不会同时触发「连排 3 节」——
  // 两个告警分支各留一个专属触发点，才好在 e2e 里分别断言。
  [1, 2, 4, 5].forEach(pd => {
    const hit = schedDocs.find(d => d.weekday === 1 && d.period === pd);
    if (hit) hit.subject = '语文';
  });
  // 周三第 4~6 节连排 3 节数学：专门喂「连排 3 节」告警分支
  [4, 5, 6].forEach(pd => {
    const hit = schedDocs.find(d => d.weekday === 3 && d.period === pd);
    if (hit) hit.subject = '数学';
  });
  await Promise.all(schedDocs.map(doc => db.collection('schedule').add({ data: doc })));

  // 班委：12 个岗位只定 9 个（留 3 空缺），并且**故意让「学习委员」空着** ——
  // 那是核心岗（班长/副班长/学习委员），空缺才会触发「核心岗空缺」告警分支。
  // 另外让第 1 个学生兼 3 个职务（班长+文艺+宣传），触发「一人兼岗过多（>2）」告警。
  // 这两个分支的触发条件是本地推演脚本验证过的（/tmp/simulate-committee.js）：
  // 只填前 9 个岗、不做兼岗的话，两个 warn 分支都拿不到数据（duty「未排到」立过这个规矩）。
  const COMM_POSTS = ['班长', '副班长', '学习委员', '纪律委员', '劳动委员', '文艺委员',
    '体育委员', '宣传委员', '生活委员', '语文科代表', '数学科代表', '英语科代表'];
  const commPlan = {};
  COMM_POSTS.filter(p => p !== '学习委员').slice(0, 9).forEach((p, i) => { commPlan[p] = stuIds[i + 1]; });
  commPlan['班长'] = stuIds[0];
  commPlan['文艺委员'] = stuIds[0];
  commPlan['宣传委员'] = stuIds[0];
  const commDocs = Object.keys(commPlan).map(post => ({
    _openid: openid,
    post,
    studentId: commPlan[post],
    updatedAt: now
  }));
  await Promise.all(commDocs.map(doc => db.collection('committee').add({ data: doc })));

  return { ok: true, students: stuIds.length, attendance: stuIds.length, announcements: notices.length,
    rewards: rewards.length, scores: scoreDocs.length, homework: hwIds.length, homeworkSubmit: submitDocs.length,
    seats: seatDocs.length, dutySchedule: dutyDocs.length, schedule: schedDocs.length,
    committee: commDocs.length, todos: todos.length };
};
