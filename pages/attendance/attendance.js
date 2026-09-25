const db = require('../../utils/db.js');
const classinfo = require('../../utils/classinfo.js');

function todayStr() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

Page({
  data: {
    date: todayStr(),
    // 状态口径（2026-09-13 内测反馈）：只保留 正常 / 迟到 / 请假。
    // 「缺勤」与「请假」对班主任是同一件事（人没来），拆两个状态只会让统计分叉，已移除。
    statuses: ['正常', '迟到', '请假'],
    students: [],
    loading: true,
    classTitle: '',
    cloudReady: false,
    saving: false,
    dupCount: 0,
    pendingCount: 0     // 尚未标记的人数（一键全员正常后应为 0）
  },

  onLoad() {
    this.setData({ cloudReady: db.isCloudReady() });
    this.loadClassTitle();
    this.refresh();
    this.startWatch(this.data.date);
  },

  onShow() {
    const tb = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tb) tb.setData({ selected: 3, hidden: false });
    this.loadClassTitle();
  },

  async loadClassTitle() {
    const info = await classinfo.get();
    this.setData({ classTitle: classinfo.title(info) });
  },

  onUnload() {
    this.stopWatch();
  },

  stopWatch() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  },

  startWatch(date) {
    this.stopWatch();
    this.watcher = db.watch('attendance', { date }, () => this.merge(), err => {
      console.error('watch attendance error', err);
    });
  },

  isSaving() {
    return !!this._busy;
  },

  onDateChange(e) {
    if (this.isSaving()) return;
    const date = e.detail.value;
    this.dirty = {};
    this.setData({ date });
    this.startWatch(date);
    this.refresh();
  },

  async refresh() {
    this.setData({ loading: true });
    try {
      const [students, records] = await Promise.all([
        db.list('students', {}, 500, { orderBy: [['studentNo', 'asc']] }),
        db.list('attendance', { date: this.data.date })
      ]);
      this.applyData(students, records);
      this.setData({ loading: false });
    } catch (e) {
      console.error('load attendance error', e);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  // 由 watch 触发的静默刷新
  async merge() {
    if (this.suspendMerge) return;
    try {
      const [students, records] = await Promise.all([
        db.list('students', {}, 500, { orderBy: [['studentNo', 'asc']] }),
        db.list('attendance', { date: this.data.date })
      ]);
      this.applyData(students, records);
    } catch (e) {
      console.error('merge attendance error', e);
    }
  },

  applyData(students, records) {
    // 同人同日可能有多条（多端并发 / 云端手改），取 updatedAt 最新一条，其余标记待清理。
    const map = {};
    const dupIds = [];
    records.forEach(r => {
      const cur = map[r.studentId];
      if (!cur) { map[r.studentId] = r; return; }
      const keepNew = Number(r.updatedAt || 0) >= Number(cur.updatedAt || 0);
      map[r.studentId] = keepNew ? r : cur;
      dupIds.push((keepNew ? cur : r)._id);
    });
    this.dupIds = dupIds;
    const VALID = this.data.statuses;
    Object.keys(map).forEach(sid => {
      const rec = map[sid];
      const st = rec && rec.status;
      if (st === '缺勤') {
        // 历史「缺勤」记录：人没来本质就是请假，显示为请假并保留来源说明，保存后规范成「请假」。
        map[sid] = Object.assign({}, rec, { status: '请假', reason: rec.reason || '原记为缺勤', _legacy: true });
      } else if (st && VALID.indexOf(st) < 0) {
        // 枚举外的值不当有效状态渲染，否则按钮组无选中态，老师以为没记过又新增一条
        map[sid] = Object.assign({}, rec, { status: '', _badStatus: st });
      }
    });
    if (dupIds.length) console.warn('[attendance] 同人同日重复记录 ' + dupIds.length + ' 条，已按最新一条显示');
    students.sort((a, b) =>
      String(a.studentNo || '').localeCompare(String(b.studentNo || ''), 'zh')
    );
    // 未保存的本地点选（dirty）优先，否则 watch/refresh 会把老师刚点的状态冲掉
    const dirty = this.dirty || {};
    const prev = {};
    (this.data.students || []).forEach(s => { prev[s._id] = s; });
    const merged = students.map(s => {
      const rec = map[s._id];
      const local = dirty[s._id] ? prev[s._id] : null;
      const status = local ? local.status : (rec ? rec.status : '');
      return {
        _id: s._id,
        studentNo: s.studentNo,
        name: s.name,
        status,
        reason: local ? (local.reason || '') : (rec ? (rec.reason || '') : ''),
        legacy: local ? !!local.legacy : !!(rec && rec._legacy),
        attendanceId: rec ? rec._id : ''
      };
    });
    const pendingCount = merged.filter(s => !s.status).length;
    this.setData({ students: merged, dupCount: dupIds.length, pendingCount });
  },

  // 清理同人同日重复：只删多余的，保留最新一条
  async onCleanDup() {
    const ids = (this.dupIds || []).slice();
    if (!ids.length) { wx.showToast({ title: '没有重复记录', icon: 'none' }); return; }
    if (this._busy) return;
    this._busy = true;
    try {
      for (const id of ids) await db.remove('attendance', id).catch(() => {});
      wx.showToast({ title: `已清理 ${ids.length} 条重复`, icon: 'success' });
      this.dupIds = [];
      await this.refresh();
    } catch (e) {
      console.error('clean dup attendance error', e);
      wx.showToast({ title: '清理失败', icon: 'none' });
    } finally {
      this._busy = false;
    }
  },

  // 一键全员正常：大多数人本来就正常，先把所有人标记成正常，老师只改少数迟到/请假。
  // 只填本地（脏标记），不落库 —— 老师改完异常再统一点一次保存，避免写一半又改。
  onMarkAllNormal() {
    if (this.isSaving()) return;
    if (!this.data.students.length) { wx.showToast({ title: '还没有学生', icon: 'none' }); return; }
    if (!this.dirty) this.dirty = {};
    const patch = {};
    let n = 0;
    this.data.students.forEach((s, idx) => {
      if (s.status === '正常') return;
      this.dirty[s._id] = true;
      patch[`students[${idx}].status`] = '正常';
      patch[`students[${idx}].reason`] = '';
      patch[`students[${idx}].legacy`] = false;
      n += 1;
    });
    if (!n) { wx.showToast({ title: '当前已全部是正常', icon: 'none' }); return; }
    patch.pendingCount = 0;
    this.setData(patch);
    wx.showToast({ title: `已标记 ${n} 人为正常`, icon: 'none' });
  },

  onStatusTap(e) {
    if (this.isSaving()) return;
    const { id, status } = e.currentTarget.dataset;
    if (this.data.statuses.indexOf(status) < 0) return;
    if (status === '请假') {
      // 请假必须填事由（内测反馈）。核心逻辑放 applyStatus，便于自动化直接调用。
      const row = this.data.students.find(s => s._id === id);
      wx.showModal({
        title: '请假事由',
        editable: true,
        placeholderText: '如：发烧请假 / 家中有事',
        content: (row && row.status === '请假' && row.reason && row.reason !== '原记为缺勤') ? row.reason : '',
        confirmText: '确定',
        success: res => {
          if (!res.confirm) return;
          const reason = String(res.content || '').trim();
          if (!reason) { wx.showToast({ title: '请填写请假事由', icon: 'none' }); return; }
          this.applyStatus(id, '请假', reason);
        }
      });
      return;
    }
    this.applyStatus(id, status, '');
  },

  // 核心状态变更（纯本地，不碰云）。e2e 可直接调用，绕过 wx.showModal。
  applyStatus(id, status, reason) {
    if (this.isSaving()) return;
    if (this.data.statuses.indexOf(status) < 0) return;
    const idx = this.data.students.findIndex(s => s._id === id);
    if (idx < 0) return;
    if (!this.dirty) this.dirty = {};
    this.dirty[id] = true;
    const patch = {
      [`students[${idx}].status`]: status,
      [`students[${idx}].reason`]: status === '请假' ? String(reason || '') : '',
      [`students[${idx}].legacy`]: false
    };
    const pendingCount = this.data.students.filter((s, i) =>
      (i === idx ? status : s.status) ? false : true
    ).length;
    patch.pendingCount = pendingCount;
    this.setData(patch);
  },

  async onSave() {
    if (this._busy) return; // 同步标志，setData 异步会让连点穿透
    if (this.data.saving) return;
    const date = this.data.date;
    // 快照：只提交本次真正点选过的行，避免把服务端已有状态重复写一遍
    const dirtyIds = Object.keys(this.dirty || {});
    const toSave = this.data.students.filter(s => s.status && dirtyIds.indexOf(s._id) >= 0);
    if (!toSave.length) {
      wx.showToast({ title: '请先选择考勤状态', icon: 'none' });
      return;
    }
    // 请假缺事由不允许落库（双保险，正常路径在 onStatusTap 已拦）
    const noReason = toSave.find(s => s.status === '请假' && !String(s.reason || '').trim());
    if (noReason) {
      wx.showToast({ title: `${noReason.name} 的请假事由为空`, icon: 'none' });
      return;
    }
    this._busy = true;
    this.setData({ saving: true });
    this.suspendMerge = true; // 保存期间挂起 watch 刷新，防止半途重建列表
    try {
      let saved = 0;
      for (const s of toSave) {
        let id = s.attendanceId;
        if (!id) {
          // 写前再查一次：本地 attendanceId 是上次 refresh 的快照，多端并发会本地空、云端已有 →
          // 直接 add 会插出第二条。
          const exist = await db.list('attendance', { studentId: s._id, date }, 5,
            { orderBy: [['updatedAt', 'desc']] }).catch(() => []);
          if (exist.length) {
            id = exist[0]._id;
            for (let i = 1; i < exist.length; i++) await db.remove('attendance', exist[i]._id).catch(() => {});
          }
        }
        const payload = {
          status: s.status,
          // 正常/迟到清掉旧事由；请假带事由
          reason: s.status === '请假' ? String(s.reason || '').trim() : ''
        };
        if (id) {
          await db.update('attendance', id, payload);
        } else {
          await db.add('attendance', Object.assign({ studentId: s._id, date }, payload));
        }
        saved += 1;
        delete this.dirty[s._id];
      }
      wx.showToast({ title: `已保存 ${saved} 人`, icon: 'success' });
      this.dirty = {};
      this.suspendMerge = false;
      await this.merge(); // 回填 attendanceId，避免再次保存时重复新增
    } catch (e) {
      console.error('save attendance error', e);
      this.suspendMerge = false;
      wx.showToast({ title: '保存失败', icon: 'none' });
    } finally {
      this._busy = false;
      this.setData({ saving: false });
    }
  }
});
