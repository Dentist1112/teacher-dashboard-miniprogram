const db = require('../../utils/db.js');
const classinfo = require('../../utils/classinfo.js');
const kb = require('../../utils/kb.js');
const modal = require('../../utils/modal.js');

Page({
  // 弹层内容区吞掉 tap，避免冒泡到 mask 的取消处理器把弹层关掉
  // （原来写 catchtap="" 空处理器，实测不生效：点输入框 showForm 直接变 false）
  noop() {},

  data: {
    notices: [],
    loading: true,
    classTitle: '',
    cloudReady: false,
    showForm: false,
    priorities: ['高', '中', '低'],
    priorityIndex: 0,
    form: { title: '', content: '', priority: '高', date: '' },
    saving: false,
    // 当前展开全文的通知 id（变长文本在列表里截断到 2 行，点一下展开；再点收起）
    expandedId: ''
  },

  onToggleExpand(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ expandedId: this.data.expandedId === id ? '' : id });
  },

  onLoad() {
    kb.bind(this);   // 键盘弹起时把弹层底部操作条顶上来（fixed 弹层不受 adjust-position 影响）
    this.setData({ cloudReady: db.isCloudReady() });
    this.loadClassTitle();
    this.refresh();
    this.watcher = db.watch('announcements', {}, () => this.refresh(), err => {
      console.error('watch announcements error', err);
    });
  },

  onShow() {
    const tb = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tb) tb.setData({ selected: 4 });
    modal.syncTabBar(this, this.data.showForm);
    this.loadClassTitle(); // 设置页改完切回来要同步
  },

  async loadClassTitle() {
    const info = await classinfo.get();
    this.setData({ classTitle: classinfo.title(info) });
  },

  onHide() {
    modal.showTabBar(this);
  },

  onUnload() {
    modal.showTabBar(this);
    kb.unbind(this);
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  },

  today() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  },

  async refresh() {
    this.setData({ loading: true });
    try {
      const raw = await db.list('announcements', {}, 500, { orderBy: [['date', 'desc'], ['updatedAt', 'desc']] });
      const PCLS = { '高': 'p1', '中': 'p2', '低': 'p3' };
      const list = raw.map(n => ({ ...n, pcls: PCLS[n.priority] || 'p3' }));
      this.setData({ notices: list, loading: false });
    } catch (e) {
      console.error('refresh announcements error', e);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  onAdd() {
    modal.hideTabBar(this);
    this.setData({
      showForm: true,
      priorityIndex: 0,
      form: { title: '', content: '', priority: '高', date: this.today() }
    });
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  onPriorityChange(e) {
    const idx = Number(e.detail.value);
    this.setData({
      priorityIndex: idx,
      'form.priority': this.data.priorities[idx]
    });
  },

  onDateChange(e) {
    this.setData({ 'form.date': e.detail.value });
  },

  onFormCancel() {
    modal.showTabBar(this);
    this.setData({ showForm: false });
  },

  isSaving() {
    return !!this._busy;
  },

  async onFormSave() {
    // 同步标志：this.data.saving 由 setData 异步更新，同一 tick 连点会穿透（实测连点 3 次插 3 条）
    if (this._busy) return;
    if (!db.isCloudReady()) {
      wx.showToast({ title: '请先配置云环境', icon: 'none' });
      return;
    }
    const { title, content, priority, date } = this.data.form;
    // 长度上限来自「卡片能显示多少」：探针实测 500 字标题 / 20000 字正文都能入库，列表页直接被撑爆
    const t = db.validate.checkText('annTitle', title, true);
    if (t.why) {
      wx.showToast({ title: '标题' + t.why, icon: 'none', duration: 2400 });
      return;
    }
    const c = db.validate.checkText('annContent', content, true);
    if (c.why) {
      wx.showToast({ title: '内容' + c.why, icon: 'none', duration: 2400 });
      return;
    }
    this._busy = true;
    this.setData({ saving: true });
    try {
      await db.add('announcements', {
        title: t.text,
        content: c.text,
        priority: priority || '中',
        date: date || this.today()
      });
      modal.showTabBar(this);
      this.setData({ showForm: false, saving: false });
      wx.showToast({ title: '已发布', icon: 'success' });
      await this.refresh().catch(() => {});
    } catch (e) {
      console.error('save announcement error', e);
      this.setData({ saving: false });
      wx.showToast({ title: e && e.validation ? e.message : '发布失败', icon: 'none', duration: 2600 });
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
    const item = this.data.notices.find(n => n._id === id);
    if (!item) return;
    wx.showModal({
      title: '删除确认',
      content: `确定删除「${item.title}」吗？`,
      confirmColor: '#B9412E',
      success: res => {
        if (!res.confirm || this.isSaving()) return;
        this._busy = true;
        db.remove('announcements', id).then(() => {
          wx.showToast({ title: '已删除', icon: 'success' });
          return this.refresh();
        }).catch(err => {
          console.error('remove announcement error', err);
          wx.showToast({ title: '删除失败', icon: 'none' });
        }).then(() => { this._busy = false; });
      }
    });
  }
});
