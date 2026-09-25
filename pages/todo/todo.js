// 待办清单：随手记想法/工作，可勾选完成、设日期、删除。按「今天/逾期/以后/无日期/已完成」分组。
const db = require('../../utils/db.js');

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 'YYYY-MM-DD' 距今天天数（非法返回 null）
function daysLeft(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!m) return null;
  const t = new Date();
  return Math.round((Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    - Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
}

function fmtDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? `${Number(m[2])}月${Number(m[3])}日` : s;
}

Page({
  data: {
    loading: true,
    cloudReady: false,
    draft: '',
    dueDate: '',
    saving: false,
    groups: [],
    openCount: 0
  },

  onLoad() {
    this.setData({ cloudReady: db.isCloudReady() });
    this.refresh();
    // 实时同步：另一台设备/页面改动立即出现
    this.watcher = db.watch('todos', {}, () => this.refresh(), err => {
      console.error('watch todos error', err);
    });
  },

  onUnload() {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
  },

  isSaving() {
    return !!this._busy;
  },

  onPullDownRefresh() {
    if (this.isSaving()) {
      wx.stopPullDownRefresh();
      return;
    }
    this.refresh().then(() => wx.stopPullDownRefresh());
  },

  onInput(e) {
    this.setData({ draft: e.detail.value });
  },

  onDateChange(e) {
    this.setData({ dueDate: e.detail.value });
  },

  onClearDate() {
    this.setData({ dueDate: '' });
  },

  // 把原始记录分成 5 组，组内按日期/更新时间排
  groupRows(rows) {
    const today = todayStr();
    const buckets = { overdue: [], today: [], later: [], nodate: [], done: [] };
    rows.forEach(r => {
      if (r.done) { buckets.done.push(r); return; }
      if (!r.dueDate) { buckets.nodate.push(r); return; }
      const left = daysLeft(r.dueDate);
      let label;
      if (left === 0) { label = '今天'; buckets.today.push({ ...r, cls: 'today', dueLabel: '今天 ' + fmtDate(r.dueDate) }); return; }
      if (left < 0) { label = `逾期 ${-left} 天`; buckets.overdue.push({ ...r, cls: 'overdue', dueLabel: `逾期 ${-left} 天 · ${fmtDate(r.dueDate)}` }); return; }
      if (left === 1) label = '明天';
      else label = `${left} 天后`;
      buckets.later.push({ ...r, cls: 'later', dueLabel: `${label} · ${fmtDate(r.dueDate)}` });
    });
    const byUpd = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
    Object.values(buckets).forEach(arr => arr.sort(byUpd));
    const defs = [
      ['overdue', '逾期未做'], ['today', '今天'], ['later', '以后'],
      ['nodate', '无日期'], ['done', '已完成']
    ];
    return defs
      .filter(([key]) => buckets[key].length)
      .map(([key, label]) => ({ key, label, items: buckets[key] }));
  },

  async refresh() {
    this.setData({ loading: true, cloudReady: db.isCloudReady() });
    try {
      // 已完成的沉底：先取未完成，再取已完成（云数据库单次排序方向固定，分两次取）
      const cmd = db.cmd();
      const [open, doneRows] = await Promise.all([
        db.list('todos', { done: cmd.neq(true) }, 200, { orderBy: [['dueDate', 'asc']] }).catch(() => []),
        db.list('todos', { done: true }, 200, { orderBy: [['updatedAt', 'desc']] }).catch(() => [])
      ]);
      // dueDate 为空字符串时 asc 排在最前，但「无日期」应该沉到「以后」之后：组内按 updatedAt 排
      const merged = open.concat(doneRows);
      const groups = this.groupRows(merged);
      const openCount = open.length;
      this.setData({ groups, openCount, loading: false });
    } catch (e) {
      console.error('refresh todos error', e);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  async onAdd() {
    if (this._busy) return;
    if (!db.isCloudReady()) {
      wx.showToast({ title: '请先配置云环境', icon: 'none' });
      return;
    }
    const title = db.validate.checkText('todoTitle', this.data.draft, true);
    if (title.why) {
      wx.showToast({ title: '待办' + title.why, icon: 'none' });
      return;
    }
    const dueDate = this.data.dueDate || '';
    // 保存返回前老师可能已经在输入下一条；只清空提交时的草稿，不能把新输入误删。
    const submittedDraft = title.text;
    const submittedDueDate = dueDate;
    this._busy = true;
    this.setData({ saving: true });
    try {
      await db.add('todos', { title: submittedDraft, done: false, dueDate: submittedDueDate });
      const stillSameDraft = this.data.draft === submittedDraft;
      const stillSameDueDate = this.data.dueDate === submittedDueDate;
      this.setData(Object.assign({ saving: false },
        stillSameDraft ? { draft: '' } : {},
        stillSameDueDate ? { dueDate: '' } : {}));
      wx.showToast({ title: '已记下', icon: 'success', duration: 900 });
      await this.refresh().catch(() => {});
    } catch (e) {
      console.error('add todo error', e);
      this.setData({ saving: false });
      wx.showToast({ title: e && e.validation ? e.message : '添加失败', icon: 'none' });
    } finally {
      this._busy = false;
    }
  },

  async onToggle(e) {
    if (this._busy) return;
    const id = e.currentTarget.dataset.id;
    const item = this.data.groups.reduce((acc, g) => acc || g.items.find(t => t._id === id), null);
    if (!item) return;
    this._busy = true;
    try {
      await db.update('todos', id, { done: !item.done });
      await this.refresh().catch(() => {});
    } catch (err) {
      // 教训 #72：catch 不能只 toast 通用文案，validation 分支要把原因露出来，否则真机上只看到「操作失败」无法归因
      console.error('toggle todo error', err);
      wx.showToast({ title: err && err.validation ? err.message : '操作失败', icon: 'none' });
    } finally {
      this._busy = false;
    }
  },

  onDelete(e) {
    if (this._busy) return;
    if (!db.isCloudReady()) {
      wx.showToast({ title: '请先配置云环境', icon: 'none' });
      return;
    }
    const id = e.currentTarget.dataset.id;
    const item = this.data.groups.reduce((acc, g) => acc || g.items.find(t => t._id === id), null);
    if (!item) return;
    wx.showModal({
      title: '删除确认',
      content: `删除「${item.title}」吗？`,
      confirmColor: '#B9412E',
      success: res => {
        if (!res.confirm || this.isSaving()) return;
        this._busy = true;
        db.remove('todos', id).then(() => {
          wx.showToast({ title: '已删除', icon: 'success', duration: 900 });
          return this.refresh();
        }).catch(err => {
          console.error('remove todo error', err);
          wx.showToast({ title: '删除失败', icon: 'none' });
        }).then(() => { this._busy = false; });
      }
    });
  }
});
