const db = require('../../utils/db.js');
const classinfo = require('../../utils/classinfo.js');
const kb = require('../../utils/kb.js');

const SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '道法', '历史', '生物', '地理', '艺术', '综合'];

// 提交状态：中文进不了 class 名（会让整份 wxss 编译失败），统一映射成 ASCII
const STATUSES = ['已交', '补交', '免交', '未交'];
const SCLS = { '已交': 'yes', '补交': 'late', '免交': 'exempt', '未交': 'no' };
// 「未交」= 不存记录（无记录即未交），和成绩页「清空=删除」同一套语义
const DEFAULT_STATUS = '未交';

function dayStr(offset = 0) {
  const d = new Date(Date.now() + offset * 86400000);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// 'YYYY-MM-DD' 相减得天数；非法输入返回 null（不要用 new Date 直接减，时区会漂）
function daysUntil(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!m) return null;
  const target = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const t = new Date();
  const today = Date.UTC(t.getFullYear(), t.getMonth(), t.getDate());
  return Math.round((target - today) / 86400000);
}

Page({
  // 弹层内容区吞掉 tap，避免冒泡到 mask 的取消处理器把弹层关掉
  // （原来写 catchtap="" 空处理器，实测不生效：点输入框 showForm 直接变 false）
  noop() {},

  data: {
    loading: true,
    cloudReady: false,
    classTitle: '',
    view: 'list',                 // list=作业列表 / check=逐人收交

    list: [],                     // 作业 + 进度
    overview: { total: 0, openCount: 0, pendingCount: 0 },

    // 布置/编辑表单
    showForm: false,
    isEdit: false,
    subjects: SUBJECTS,
    subjectIndex: 0,
    form: { _id: '', subject: SUBJECTS[0], title: '', content: '', assignDate: '', dueDate: '' },
    saving: false,

    // 收交面板
    current: null,
    statuses: STATUSES,
    rows: [],
    checkStats: { total: 0, yes: 0, late: 0, exempt: 0, no: 0, rate: '0' },
    onlyPending: false
  },

  onLoad() {
    kb.bind(this);   // 键盘弹起时把弹层底部操作条顶上来（fixed 弹层不受 adjust-position 影响）
    this.setData({ cloudReady: db.isCloudReady() });
    this.loadClassTitle();
    this.refresh();
    this.watcher = db.watch('homework', {}, () => {
      // 收交面板里不打扰：列表视图才静默刷新
      if (this.data.view === 'list') this.refresh(true);
    }, err => console.error('watch homework error', err));
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

  onPullDownRefresh() {
    if (this.isSaving()) { wx.stopPullDownRefresh(); return; }
    this.refresh().then(() => wx.stopPullDownRefresh());
  },

  // silent=true 时不打加载态（watch 触发）
  async refresh(silent) {
    if (!silent) this.setData({ loading: true });
    try {
      const [homework, students, submits] = await Promise.all([
        // orderBy 交给云端：limit 不保证顺序
        db.list('homework', {}, 300, { orderBy: [['dueDate', 'desc'], ['updatedAt', 'desc']] }),
        db.list('students', {}, 500, { orderBy: [['studentNo', 'asc']] }),
        db.list('homeworkSubmit', {}, 3000, { orderBy: [['updatedAt', 'desc']] })
      ]);
      this.students = students;
      this.submits = submits;

      const list = homework.map(h => this.decorate(h, students.length, submits));
      // 概览：进行中=未过截止日；待交=进行中作业里还没交的人次
      let openCount = 0;
      let pendingCount = 0;
      list.forEach(h => {
        if (!h.overdue) {
          openCount += 1;
          pendingCount += h.noCount;
        }
      });

      this.setData({
        list,
        overview: { total: list.length, openCount, pendingCount },
        loading: false
      });

      // 收交面板打开时，跟着刷新当前作业（不覆盖未保存的本地改动）
      if (this.data.view === 'check' && this.data.current) {
        const fresh = list.find(h => h._id === this.data.current._id);
        if (fresh) this.buildRows(fresh);
        else this.setData({ view: 'list', current: null }); // 作业被删了
      }
    } catch (e) {
      console.error('refresh homework error', e);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  // 单条作业的进度统计（按全班人数算，不受任何筛选影响）
  decorate(h, studentTotal, submits) {
    const mine = submits.filter(s => s.homeworkId === h._id);
    const cnt = { '已交': 0, '补交': 0, '免交': 0 };
    mine.forEach(s => {
      if (cnt[s.status] !== undefined) cnt[s.status] += 1;
    });
    const done = cnt['已交'] + cnt['补交'] + cnt['免交'];
    const noCount = Math.max(0, studentTotal - done);
    const left = daysUntil(h.dueDate);
    return {
      _id: h._id,
      subject: h.subject || '综合',
      title: h.title || '',
      content: h.content || '',
      assignDate: h.assignDate || '',
      dueDate: h.dueDate || '',
      yesCount: cnt['已交'],
      lateCount: cnt['补交'],
      exemptCount: cnt['免交'],
      noCount,
      studentTotal,
      // 全班 0 人时不能除 0
      pct: studentTotal ? Math.round((done / studentTotal) * 100) : 0,
      overdue: left !== null && left < 0,
      dueText: left === null ? (h.dueDate || '未设截止')
        : left < 0 ? `已过期 ${-left} 天`
          : left === 0 ? '今天到期' : `还有 ${left} 天`,
      dcls: left === null ? 'none' : left < 0 ? 'over' : left <= 1 ? 'soon' : 'ok'
    };
  },

  isSaving() {
    return !!this._busy;
  },

  /* ---------------- 布置 / 编辑 ---------------- */

  onAdd() {
    if (this.isSaving()) return;
    this.setData({
      showForm: true,
      isEdit: false,
      subjectIndex: 0,
      form: {
        _id: '', subject: SUBJECTS[0], title: '', content: '',
        assignDate: dayStr(0), dueDate: dayStr(1)
      }
    });
  },

  onEdit(e) {
    if (this.isSaving()) return;
    const id = e.currentTarget.dataset.id;
    const h = this.data.list.find(x => x._id === id);
    if (!h) return;
    const idx = SUBJECTS.indexOf(h.subject);
    this.setData({
      showForm: true,
      isEdit: true,
      subjectIndex: idx >= 0 ? idx : 0,
      form: {
        _id: h._id,
        subject: idx >= 0 ? h.subject : SUBJECTS[0],
        title: h.title,
        content: h.content,
        assignDate: h.assignDate || dayStr(0),
        dueDate: h.dueDate || dayStr(1)
      }
    });
  },

  onFormInput(e) {
    if (this.isSaving()) return;
    this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value });
  },

  onSubjectChange(e) {
    if (this.isSaving()) return;
    const idx = Number(e.detail.value);
    this.setData({ subjectIndex: idx, 'form.subject': SUBJECTS[idx] });
  },

  onAssignDateChange(e) {
    if (this.isSaving()) return;
    this.setData({ 'form.assignDate': e.detail.value });
  },

  onDueDateChange(e) {
    if (this.isSaving()) return;
    this.setData({ 'form.dueDate': e.detail.value });
  },

  onFormCancel() {
    if (this.isSaving()) return;
    this.setData({ showForm: false });
  },

  async onFormSave() {
    if (this._busy) return; // this.data.saving 是异步的，防不住连点
    if (!db.isCloudReady()) {
      wx.showToast({ title: '请先配置云环境', icon: 'none' });
      return;
    }
    const { _id, subject, title, content, assignDate, dueDate } = this.data.form;
    const tv = db.validate.checkText('hwTitle', title, true);
    if (tv.why) {
      wx.showToast({ title: '标题' + tv.why, icon: 'none', duration: 2400 });
      return;
    }
    const t = tv.text;
    if (!dueDate) {
      wx.showToast({ title: '请选截止日期', icon: 'none' });
      return;
    }
    // 日期真实性 + 两年上限（探针实测 '2026-9-6' 能入库并原样显示；'2999-12-31' 显示「还有 355497 天」）
    const dv = db.validate.check('homework', { title: t, content: content, assignDate: assignDate, dueDate: dueDate });
    if (dv) {
      wx.showToast({ title: dv, icon: 'none', duration: 2600 });
      return;
    }
    // 截止日不能早于布置日
    if (assignDate && dueDate < assignDate) {
      wx.showToast({ title: '截止日不能早于布置日', icon: 'none' });
      return;
    }
    // 同科目 + 同标题 + 同截止日 视为重复布置
    const dup = this.data.list.find(h =>
      h._id !== _id && h.subject === subject && h.title === t && h.dueDate === dueDate);
    if (dup) {
      wx.showToast({ title: '该作业已布置过', icon: 'none' });
      return;
    }

    this._busy = true;
    this.setData({ saving: true });
    try {
      const payload = {
        subject: subject || SUBJECTS[0],
        title: t,
        content: String(content || '').trim(),
        assignDate: assignDate || dayStr(0),
        dueDate
      };
      if (this.data.isEdit) {
        await db.update('homework', _id, payload);
        wx.showToast({ title: '已更新', icon: 'success' });
      } else {
        await db.add('homework', payload);
        wx.showToast({ title: '已布置', icon: 'success' });
      }
      this.setData({ showForm: false });
      await this.refresh();
    } catch (err) {
      console.error('save homework error', err);
      wx.showToast({ title: err && err.validation ? err.message : '保存失败', icon: 'none', duration: 2600 });
    } finally {
      this._busy = false;
      this.setData({ saving: false });
    }
  },

  onDelete(e) {
    if (this._busy) return;
    if (!db.isCloudReady()) {
      wx.showToast({ title: '请先配置云环境', icon: 'none' });
      return;
    }
    const id = e.currentTarget.dataset.id;
    const h = this.data.list.find(x => x._id === id);
    if (!h) return;
    wx.showModal({
      title: '删除确认',
      content: `删除「${h.subject} · ${h.title}」会同时清掉 ${h.yesCount + h.lateCount + h.exemptCount} 条收交记录，确定吗？`,
      confirmColor: '#B9412E',
      success: res => {
        if (!res.confirm || this.isSaving()) return;
        this._busy = true;
        // 级联：不然 homeworkSubmit 变孤儿，进度统计会算错
        db.removeCascade('homework', id, [{ collection: 'homeworkSubmit', field: 'homeworkId' }])
          .then(() => {
            wx.showToast({ title: '已删除', icon: 'success' });
            if (this.data.current && this.data.current._id === id) {
              this.setData({ view: 'list', current: null });
            }
            return this.refresh();
          })
          .catch(err => {
            console.error('delete homework error', err);
            wx.showToast({ title: '删除失败', icon: 'none' });
          })
          .then(() => { this._busy = false; });
      }
    });
  },

  /* ---------------- 收交面板 ---------------- */

  onOpenCheck(e) {
    if (this.isSaving()) return;
    const id = e.currentTarget.dataset.id;
    const h = this.data.list.find(x => x._id === id);
    if (!h) return;
    this.dirty = {};
    this.setData({ view: 'check', current: h, onlyPending: false });
    this.buildRows(h);
  },

  onBackToList() {
    if (this.isSaving()) return;
    if (this.dirty && Object.keys(this.dirty).length) {
      wx.showModal({
        title: '有未保存的改动',
        content: '返回会丢弃这次的收交标记，确定返回？',
        confirmColor: '#B9412E',
        success: res => {
          if (!res.confirm) return;
          this.dirty = {};
          this.setData({ view: 'list', current: null });
          this.refresh();
        }
      });
      return;
    }
    this.setData({ view: 'list', current: null });
    this.refresh();
  },

  // 学生 × 当前作业 的收交行；未保存的本地标记优先保留（watch 刷新不能冲掉老师点过的）
  buildRows(h) {
    const map = {};
    (this.submits || []).forEach(s => {
      if (s.homeworkId === h._id) map[s.studentId] = s;
    });
    const dirty = this.dirty || {};
    const prev = {};
    (this.data.rows || []).forEach(r => { prev[r._id] = r; });

    const rows = (this.students || []).map(s => {
      const rec = map[s._id];
      const keepLocal = dirty[s._id] && prev[s._id];
      const status = keepLocal ? prev[s._id].status : ((rec && rec.status) || DEFAULT_STATUS);
      return {
        _id: s._id,
        studentNo: s.studentNo,
        name: s.name,
        status,
        scls: SCLS[status] || 'no',
        submitId: rec ? rec._id : '',
        remark: keepLocal ? prev[s._id].remark : ((rec && rec.remark) || '')
      };
    });
    this.setData({ current: h, rows });
    this.recomputeCheck();
  },

  recomputeCheck() {
    const rows = this.data.rows || [];
    const c = { '已交': 0, '补交': 0, '免交': 0, '未交': 0 };
    rows.forEach(r => { if (c[r.status] !== undefined) c[r.status] += 1; });
    const done = c['已交'] + c['补交'] + c['免交'];
    this.setData({
      checkStats: {
        total: rows.length,
        yes: c['已交'], late: c['补交'], exempt: c['免交'], no: c['未交'],
        rate: rows.length ? String(Math.round((done / rows.length) * 100)) : '0'
      }
    });
  },

  // 点一下循环切状态：未交 → 已交 → 补交 → 免交 → 未交
  onToggleStatus(e) {
    if (this.isSaving()) return;
    const id = e.currentTarget.dataset.id;
    const idx = this.data.rows.findIndex(r => r._id === id);
    if (idx < 0) return;
    const order = ['未交', '已交', '补交', '免交'];
    const cur = this.data.rows[idx].status;
    const next = order[(order.indexOf(cur) + 1) % order.length];
    if (!this.dirty) this.dirty = {};
    this.dirty[id] = true;
    // 定点 setData，避免整表重渲染
    this.setData({
      [`rows[${idx}].status`]: next,
      [`rows[${idx}].scls`]: SCLS[next] || 'no'
    });
    this.recomputeCheck();
  },

  onToggleOnlyPending() {
    this.setData({ onlyPending: !this.data.onlyPending });
  },

  // 一键全交：把「未交」全标成「已交」，免交/补交不动
  onMarkAllSubmitted() {
    if (this.isSaving()) return;
    if (!this.dirty) this.dirty = {};
    const patch = {};
    this.data.rows.forEach((r, i) => {
      if (r.status === '未交') {
        patch[`rows[${i}].status`] = '已交';
        patch[`rows[${i}].scls`] = SCLS['已交'];
        this.dirty[r._id] = true;
      }
    });
    if (!Object.keys(patch).length) {
      wx.showToast({ title: '已经全部交齐', icon: 'none' });
      return;
    }
    this.setData(patch);
    this.recomputeCheck();
  },

  async onSaveCheck() {
    if (this._busy) return;
    if (!db.isCloudReady()) {
      wx.showToast({ title: '请先配置云环境', icon: 'none' });
      return;
    }
    const h = this.data.current;
    if (!h) return;
    const dirtyIds = Object.keys(this.dirty || {});
    if (!dirtyIds.length) {
      wx.showToast({ title: '没有改动需要保存', icon: 'none' });
      return;
    }
    const toSave = this.data.rows.filter(r => dirtyIds.indexOf(r._id) >= 0);

    this._busy = true;
    this.setData({ saving: true });
    try {
      let saved = 0;
      let cleared = 0;
      for (const r of toSave) {
        if (r.status === DEFAULT_STATUS) {
          // 「未交」不占记录：改回未交就删掉那条，避免堆垃圾 + 统计口径不一
          if (r.submitId) {
            await db.remove('homeworkSubmit', r.submitId);
            cleared += 1;
          }
          continue;
        }
        const payload = {
          homeworkId: h._id,
          studentId: r._id,
          status: r.status,
          remark: String(r.remark || '').trim(),
          date: dayStr(0)
        };
        if (r.submitId) await db.update('homeworkSubmit', r.submitId, payload);
        else await db.add('homeworkSubmit', payload);
        saved += 1;
      }
      this.dirty = {};
      wx.showToast({
        title: cleared ? `记录 ${saved} 人，撤回 ${cleared} 人` : `已记录 ${saved} 人`,
        icon: 'success'
      });
      await this.refresh(); // 回读拿 submitId，避免下次保存重复插入
    } catch (err) {
      console.error('save homeworkSubmit error', err);
      wx.showToast({ title: '保存失败', icon: 'none' });
    } finally {
      this._busy = false;
      this.setData({ saving: false });
    }
  }
});
