const db = require('../../utils/db.js');
const classinfo = require('../../utils/classinfo.js');
const periods = require('../../utils/periods.js');
const analytics = require('../../utils/analytics.js');

const TABS = [
  { key: 'day', label: '今日' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' }
];

Page({
  data: {
    tabs: TABS,
    tabIndex: 0,
    period: 'day',
    rangeText: '',
    loading: true,
    cloudReady: false,
    classTitle: '',
    result: null
  },

  onLoad() {
    this.setData({ cloudReady: db.isCloudReady() });
    this.loadClassTitle();
    this.load();
  },

  onShow() {
    this.loadClassTitle();
  },

  async loadClassTitle() {
    const info = await classinfo.get();
    this.setData({ classTitle: classinfo.title(info) });
  },

  isSaving() {
    return !!this._busy;
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  onTab(e) {
    const i = Number(e.currentTarget.dataset.i);
    if (i === this.data.tabIndex) return;
    this.setData({ tabIndex: i, period: TABS[i].key });
    // 加载中连点分段：旧实现直接 return，会吞掉「本月」点击。只保留最后一次选择，
    // 当前加载结束后自动补跑（ponytail: 单槽 pending，中间态无意义）。
    if (this._busy) { this._pendingTab = i; return; }
    this.load();
  },

  async load() {
    if (this._busy) return;
    this._busy = true;
    this.setData({ loading: true });
    try {
      const type = this.data.period;
      const r = periods.range(type);
      const rangeText = r.start === r.end ? r.start : r.start + ' 至 ' + r.end;

      const [students, attendance, submits, rewards, scores, todos] = await Promise.all([
        db.list('students', {}, 500, { orderBy: [['studentNo', 'asc']] }).catch(() => []),
        db.list('attendance', {}, 3000, { orderBy: [['date', 'desc']] }).catch(() => []),
        db.list('homeworkSubmit', {}, 3000, { orderBy: [['date', 'desc']] }).catch(() => []),
        db.list('rewards', {}, 1000, { orderBy: [['date', 'desc']] }).catch(() => []),
        db.list('scores', {}, 2000, { orderBy: [['updatedAt', 'desc']] }).catch(() => []),
        db.list('todos', {}, 500, { orderBy: [['dueDate', 'asc']] }).catch(() => [])
      ]);
      const nameMap = {};
      students.forEach(s => { nameMap[s._id] = s.name; });
      const nameOf = rec => nameMap[rec.studentId] || rec.studentName || '已删除学生';

      const result = analytics.compute({
        range: r, attendance, homeworkSubmit: submits, rewards, scores, todos, nameOf,
        studentIds: students.map(s => s._id)   // 默认全班正常口径：没记录的学生按正常计
      });
      this.setData({ result, rangeText, loading: false });
    } catch (e) {
      console.error('analytics load error', e);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      this._busy = false;
      if (this._pendingTab != null) {
        const i = this._pendingTab;
        this._pendingTab = null;
        this.setData({ tabIndex: i, period: TABS[i].key });
        this.load();
      }
    }
  }
});
