const { list, cmd, isCloudReady } = require('../../utils/db.js');
const classinfo = require('../../utils/classinfo.js');
const profile = require('../../utils/profile.js');
const wk = require('../../utils/weekdays.js');
const report = require('../../utils/dailyreport.js');

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 'YYYY-MM-DD' 距今天的天数；非法返回 null（不用 new Date 直减，时区会漂）
function daysLeft(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!m) return null;
  const t = new Date();
  return Math.round((Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    - Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
}

function isOverdue(dateStr) {
  const l = daysLeft(dateStr);
  return l !== null && l < 0;
}

Page({
  data: {
    loading: true,
    cloudReady: false,
    students: [],
    announcements: [],
    rewards: [],
    attendance: [],
    homework: [],
    hwPending: 0,
    todoToday: [],
    todoOpen: 0,
    healthAlerts: [],
    healthCount: 0,
    today: '',
    greeting: '',
    classTitle: '',
    meName: '',
    meAvatar: ''
  },

  onShow() {
    const tb = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tb) tb.setData({ selected: 0, hidden: false });
    this.setData({ cloudReady: isCloudReady() });
    this.loadMe();
    this.loadClassTitle();
    this.load();
  },

  // 读本地即可（同步，不等云）：登录页保存时已写 storage，云端 pull 在 app.js bootstrap 里做
  loadMe() {
    const p = profile.getLocal();
    this.setData({ meName: (p && p.nickName) || '', meAvatar: (p && p.avatar) || '' });
  },

  async loadClassTitle() {
    const info = await classinfo.get();
    this.setData({ classTitle: classinfo.title(info) });
  },

  async load() {
    this.setData({ loading: true, cloudReady: isCloudReady() });
    const today = todayStr();
    const h = new Date().getHours();
    const greeting = h < 6 ? '夜深了，注意休息' : h < 9 ? '早上好' : h < 12 ? '上午好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';

    // orderBy 必须交给云端：limit 不保证顺序，无序 limit(3) 会返回任意 3 条（实测踩过）
    const [students, announcements, rewards, attendance, homework, submits, todos, attendanceAll, duties] = await Promise.all([
      list('students', {}, 500, { orderBy: [['studentNo', 'asc']] }).catch(() => []),
      list('announcements', {}, 3, { orderBy: [['date', 'desc'], ['updatedAt', 'desc']] }).catch(() => []),
      list('rewards', {}, 5, { orderBy: [['updatedAt', 'desc']] }).catch(() => []),
      list('attendance', { date: today, status: cmd().neq('正常') }, 20).catch(() => []),
      list('homework', {}, 300, { orderBy: [['dueDate', 'desc'], ['updatedAt', 'desc']] }).catch(() => []),
      list('homeworkSubmit', {}, 3000, { orderBy: [['updatedAt', 'desc']] }).catch(() => []),
      list('todos', { done: cmd().neq(true) }, 200, { orderBy: [['dueDate', 'asc']] }).catch(() => []),
      list('attendance', { date: today }, 500).catch(() => []),
      list('dutySchedule', {}, 800).catch(() => [])
    ]);
    // 一键日报所需的今日快照（点击时才拼文本）
    this._reportInput = {
      students,
      attendance: attendanceAll,
      homeworkToday: homework.filter(h => h.dueDate === today),
      submits,
      dutySchedule: duties,
      todos,
      date: today,
      weekdayLabel: '周' + '日一二三四五六'[new Date().getDay()],
      dutyWeekday: wk.todayWeekday()
    };

    // 云端已按 date/updatedAt 倒序，这里只做 class 名映射（中文类名会让 wxss 整体编译失败）
    const PCLS = { '高': 'p1', '紧急': 'p1', 'high': 'p1', '中': 'p2', '低': 'p3' };
    const sortedAnn = announcements.map(n => ({ ...n, pcls: PCLS[n.priority] || 'p3' }));
    const sortedRew = rewards;

    // 学生姓名映射（按 _id 与 studentNo 双键兜底），让考勤/奖惩显示姓名而非 id
    const nameMap = {};
    students.forEach(s => { nameMap[s._id] = s.name; nameMap[s.studentNo] = s.name; });
    // 学生已被删除时不显示裸 _id（那是乱码），标为「已删除学生」
    const nameOf = rec => nameMap[rec.studentId] || nameMap[rec.studentNo] || (rec.studentId ? '已删除学生' : '—');
    // 历史“缺勤”统一按请假展示（人没来本质相同），新数据不再写缺勤
    const attendanceNamed = attendance.map(a => ({
      ...a,
      status: a.status === '缺勤' ? '请假' : a.status,
      legacyAbsent: a.status === '缺勤',
      studentName: nameOf(a)
    }));
    const rewardsNamed = sortedRew.map(r => ({ ...r, studentName: nameOf(r) }));

    // 健康需注意的学生：过敏/哮喘/急救药这类信息漏掉是真事故，必须上概览首屏
    const RISK_WORDS = ['过敏', '哮喘', '心脏', '癫痫', '糖尿病', '蚕豆', '晕', '禁', '药'];
    const HEALTH_OK = ['良好', '正常', '无', '健康', ''];
    const riskStudents = students.filter(s => {
      const h = String(s.health || '').trim();
      return HEALTH_OK.indexOf(h) < 0 && RISK_WORDS.some(w => h.indexOf(w) >= 0);
    });
    const healthAlerts = riskStudents.slice(0, 3).map(s => ({
      _id: s._id, name: s.name, studentNo: s.studentNo, health: s.health
    }));

    // 未截止的作业 + 各自还没交的人数。「未交」不存记录，所以按全班人数减去有记录的人算
    const DONE = ['已交', '补交', '免交'];
    const noCountOf = h => {
      const done = submits.filter(s => s.homeworkId === h._id && DONE.indexOf(s.status) >= 0).length;
      return Math.max(0, students.length - done);
    };
    const openHw = homework.filter(h => !isOverdue(h.dueDate));
    // 待交人次按全部未截止作业算，不能只算展示的 3 条（会少报）
    const hwPending = openHw.reduce((acc, h) => acc + noCountOf(h), 0);
    const hwCards = openHw.slice(0, 3).map(h => {
      const left = daysLeft(h.dueDate);
      return {
        _id: h._id,
        subject: h.subject || '综合',
        title: h.title || '',
        noCount: noCountOf(h),
        dueText: left === null ? '未设截止' : left === 0 ? '今天到期' : `还有 ${left} 天`,
        dcls: left !== null && left <= 1 ? 'soon' : 'ok'
      };
    });

    const todoToday = todos
      .filter(t => {
        const left = t.dueDate ? daysLeft(t.dueDate) : null;
        return left !== null && left <= 0;
      })
      .slice(0, 3)
      .map(t => {
        const left = daysLeft(t.dueDate);
        return {
          _id: t._id,
          title: t.title,
          overdue: left < 0,
          cls: left < 0 ? 'overdue' : 'today',
          dueText: left < 0 ? `逾期 ${-left} 天` : '今天'
        };
      });

    this.setData({
      todoToday,
      todoOpen: todos.length,
      loading: false,
      students,
      announcements: sortedAnn,
      rewards: rewardsNamed,
      attendance: attendanceNamed,
      homework: hwCards,
      hwPending,
      healthAlerts,
      healthCount: riskStudents.length,
      today,
      greeting
    });
  },

  // v0.9.5：一键复制今日班级日报（只复制，不发送、不落库）
  onCopyReport() {
    const input = this._reportInput;
    if (!input) { wx.showToast({ title: '数据还在加载', icon: 'none' }); return; }
    const text = report.buildDailyReport(Object.assign({ classTitle: this.data.classTitle }, input));
    if (text.split('\n').length < 2) {
      wx.showToast({ title: '今天还没有考勤/作业/值日/待办', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: text,
      success() { wx.showToast({ title: '已复制，可粘贴到群里', icon: 'none' }); }
    });
  },

  goGrades() {
    // 成绩已是 tab 页，必须 switchTab（navigateTo 到 tab 页会失败）
    wx.switchTab({ url: '/pages/grades/grades' });
  },
  goAnalytics() {
    wx.navigateTo({ url: '/pages/analytics/analytics' });
  },

  goAll() {
    wx.navigateTo({ url: '/pages/all/all' });
  },

  goTodo() {
    wx.navigateTo({ url: '/pages/todo/todo' });
  },

  goSettings() {
    wx.navigateTo({ url: '/pages/settings/settings' });
  },

  goRewards() {
    wx.navigateTo({ url: '/pages/rewards/rewards' });
  },

  goHomework() {
    wx.navigateTo({ url: '/pages/homework/homework' });
  },

  goProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' });
  },

  goSeats() {
    wx.navigateTo({ url: '/pages/seats/seats' });
  },

  goDuty() {
    wx.navigateTo({ url: '/pages/duty/duty' });
  },

  goSchedule() {
    wx.navigateTo({ url: '/pages/schedule/schedule' });
  },

  goCommittee() {
    wx.navigateTo({ url: '/pages/committee/committee' });
  },

  goProfileOf(e) {
    wx.navigateTo({ url: '/pages/profile/profile?id=' + e.currentTarget.dataset.id });
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  }
});
