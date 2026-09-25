const db = require('../../utils/db.js');
const classinfo = require('../../utils/classinfo.js');
const kb = require('../../utils/kb.js');

const TYPES = ['奖励', '惩戒'];

function todayStr() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

Page({
  // 弹层内容区吞掉 tap，避免冒泡到 mask 的取消处理器把弹层关掉
  // （原来写 catchtap="" 空处理器，实测不生效：点输入框 showForm 直接变 false）
  noop() {},

  data: {
    records: [],          // 全量（云端已排序）
    shown: [],            // 当前筛选后的
    filter: 'all',
    loading: true,
    cloudReady: false,
    classTitle: '',
    summary: { rewardCount: 0, punishCount: 0, netPoints: 0 },
    // 表单
    showForm: false,
    isEdit: false,
    types: TYPES,
    typeIndex: 0,
    students: [],
    studentLabels: [],
    studentIndex: 0,
    form: { _id: '', studentId: '', type: '奖励', reason: '', pointsInput: '', date: '' },
    saving: false
  },

  onLoad() {
    kb.bind(this);   // 键盘弹起时把弹层底部操作条顶上来（fixed 弹层不受 adjust-position 影响）
    this.setData({ cloudReady: db.isCloudReady() });
    this.loadClassTitle();
    this.refresh();
    this.watcher = db.watch('rewards', {}, () => this.refresh(), err => {
      console.error('watch rewards error', err);
    });
  },

  onShow() {
    this.loadClassTitle();
  },

  onUnload() {
    kb.unbind(this);
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  },

  async loadClassTitle() {
    const info = await classinfo.get();
    this.setData({ classTitle: classinfo.title(info) });
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

  async refresh() {
    this.setData({ loading: true });
    try {
      // orderBy 交给云端：limit 不保证顺序
      const [records, students] = await Promise.all([
        db.list('rewards', {}, 500, { orderBy: [['date', 'desc'], ['updatedAt', 'desc']] }),
        db.list('students', {}, 500, { orderBy: [['studentNo', 'asc']] })
      ]);

      const nameMap = {};
      students.forEach(s => { nameMap[s._id] = s.name; });

      const decorated = records.map(r => {
        const pts = Number(r.points) || 0;
        const nm = nameMap[r.studentId] || (r.studentId ? '已删除学生' : '—');
        return {
          ...r,
          studentName: nm,
          // initial 是首字圆标锚点（纯展示，不入库）；原因、日期等长内容在列表里截断到 1 行
          initial: String(nm || '?').trim().slice(0, 1),
          reasonShort: String(r.reason || '').slice(0, 24),
          // 中文不能进 class 名（会让整份 wxss 编译失败）
          tcls: r.type === '惩戒' ? 'sub' : 'add',
          pcls: pts >= 0 ? 'add' : 'sub',
          pointsText: (pts >= 0 ? '+' : '') + pts
        };
      });

      const labels = students.map(s => `${s.studentNo} ${s.name}`);
      this.setData({
        records: decorated,
        students,
        studentLabels: labels,
        loading: false
      });
      this.applyFilter();
    } catch (e) {
      console.error('refresh rewards error', e);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  applyFilter() {
    const f = this.data.filter;
    const all = this.data.records;
    const shown = f === 'all' ? all
      : all.filter(r => (f === 'punish' ? r.type === '惩戒' : r.type !== '惩戒'));

    // 汇总按全量算（不受筛选影响，否则老师会误读）
    let rewardCount = 0, punishCount = 0, netPoints = 0;
    all.forEach(r => {
      const pts = Number(r.points) || 0;
      if (r.type === '惩戒') punishCount += 1; else rewardCount += 1;
      netPoints += pts;
    });

    this.setData({
      shown,
      summary: { rewardCount, punishCount, netPoints }
    });
  },

  onFilter(e) {
    const f = e.currentTarget.dataset.f;
    if (f === this.data.filter) return;
    this.setData({ filter: f });
    this.applyFilter();
  },

  onAdd() {
    if (!this.data.students.length) {
      wx.showToast({ title: '请先在名单里添加学生', icon: 'none' });
      return;
    }
    this.setData({
      showForm: true,
      isEdit: false,
      typeIndex: 0,
      studentIndex: 0,
      form: {
        _id: '',
        studentId: this.data.students[0]._id,
        type: '奖励',
        reason: '',
        pointsInput: '',
        date: todayStr()
      }
    });
  },

  onEdit(e) {
    if (this.isSaving()) return;
    const id = e.currentTarget.dataset.id;
    const rec = this.data.records.find(r => r._id === id);
    if (!rec) return;
    const idx = this.data.students.findIndex(s => s._id === rec.studentId);
    const pts = Number(rec.points) || 0;
    this.setData({
      showForm: true,
      isEdit: true,
      typeIndex: Math.max(0, TYPES.indexOf(rec.type || '奖励')),
      studentIndex: idx >= 0 ? idx : 0,
      form: {
        _id: rec._id,
        // 学生已删除时回落到第一个，避免存回一个不存在的 studentId
        studentId: idx >= 0 ? rec.studentId : (this.data.students[0] && this.data.students[0]._id) || '',
        type: rec.type || '奖励',
        reason: rec.reason || '',
        pointsInput: String(Math.abs(pts)),
        date: rec.date || todayStr()
      }
    });
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  onStudentChange(e) {
    const idx = Number(e.detail.value);
    const stu = this.data.students[idx];
    this.setData({ studentIndex: idx, 'form.studentId': stu ? stu._id : '' });
  },

  onTypeChange(e) {
    const idx = Number(e.detail.value);
    this.setData({ typeIndex: idx, 'form.type': TYPES[idx] });
  },

  onDateChange(e) {
    this.setData({ 'form.date': e.detail.value });
  },

  onFormCancel() {
    this.setData({ showForm: false });
  },

  async onFormSave() {
    if (this._busy) return; // 同步标志：this.data.saving 由 setData 异步更新，连点会穿透
    if (!db.isCloudReady()) {
      wx.showToast({ title: '请先配置云环境', icon: 'none' });
      return;
    }
    const { studentId, type, reason, pointsInput, date } = this.data.form;
    if (!studentId) {
      wx.showToast({ title: '请选择学生', icon: 'none' });
      return;
    }
    if (!String(reason || '').trim()) {
      wx.showToast({ title: '请填事由', icon: 'none' });
      return;
    }
    // 严格解析：Number('   ')=0、Number('0x10')=16、Number('007')=7 会让老师把垃圾值当成绩存进去
    // （2026-09-06 探针实测这三种都能入库）。规则统一放在 utils/validate.js，页面只负责提示。
    const signed = db.validate.strictInt(pointsInput);
    if (signed === null) {
      wx.showToast({ title: '积分请填整数，如 5', icon: 'none' });
      return;
    }
    const absPts = Math.abs(signed);
    if (absPts === 0) {
      wx.showToast({ title: '积分不能是 0', icon: 'none' });
      return;
    }
    if (absPts > db.validate.REWARD_MAX_POINTS) {
      wx.showToast({ title: `积分不要超过 ${db.validate.REWARD_MAX_POINTS}`, icon: 'none' });
      return;
    }
    const rsn = db.validate.checkText('reason', reason, true);
    if (rsn.why) {
      wx.showToast({ title: '事由' + rsn.why, icon: 'none' });
      return;
    }

    this._busy = true;
    this.setData({ saving: true });
    try {
      // 惩戒统一存负数，奖励存正数；老师只填绝对值，避免正负号填错
      const payload = {
        studentId,
        type: type || '奖励',
        reason: rsn.text,
        points: type === '惩戒' ? -absPts : absPts,
        date: date || todayStr()
      };
      if (this.data.isEdit) {
        await db.update('rewards', this.data.form._id, payload);
        wx.showToast({ title: '已更新', icon: 'success' });
      } else {
        await db.add('rewards', payload);
        wx.showToast({ title: '已登记', icon: 'success' });
      }
      this.setData({ showForm: false, saving: false });
      await this.refresh().catch(() => {});
    } catch (e) {
      console.error('save reward error', e);
      this.setData({ saving: false });
      // db 层范围兜底抛 validation：把原因直接给老师，不要笼统「保存失败」
      wx.showToast({ title: e && e.validation ? e.message : '保存失败', icon: 'none', duration: 2600 });
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
    const rec = this.data.records.find(r => r._id === id);
    if (!rec) return;
    wx.showModal({
      title: '删除确认',
      content: `确定删除「${rec.studentName} · ${rec.reason}」吗？`,
      confirmColor: '#B9412E',
      success: res => {
        if (!res.confirm || this.isSaving()) return;
        this._busy = true;
        db.remove('rewards', id).then(() => {
          wx.showToast({ title: '已删除', icon: 'success' });
          return this.refresh();
        }).catch(err => {
          console.error('remove reward error', err);
          wx.showToast({ title: '删除失败', icon: 'none' });
        }).then(() => { this._busy = false; });
      }
    });
  }
});
