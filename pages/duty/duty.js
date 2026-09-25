const db = require('../../utils/db.js');
const classinfo = require('../../utils/classinfo.js');
const wk = require('../../utils/weekdays.js');

// 岗位是中文，绝不能进 class 名（会让整份 wxss 编译失败），统一映射成 ASCII
const JOBS = ['扫地', '擦黑板', '倒垃圾', '摆桌椅', '关窗锁门'];
const JOB_CLS = {
  '扫地': 'sweep', '擦黑板': 'board', '倒垃圾': 'trash',
  '摆桌椅': 'desk', '关窗锁门': 'lock'
};
// 周几 + 日历日期（与课表页共用 utils/weekdays.js，两页日期口径必须一致）
const WEEKDAYS = wk.weekdays();
const SLOTS = WEEKDAYS.length * JOBS.length;   // 25 个岗位位置

// 今天是周几（1~5，周末回落到周一，值日表只排工作日）
const todayWeekday = wk.todayWeekday;

Page({
  data: {
    loading: true,
    cloudReady: false,
    classTitle: '',
    view: 'week',                 // week=周表 / day=单日编排

    jobs: JOBS,
    week: [],                     // [{ d, label, isToday, jobs:[{job,jcls,people:[],count}], total }]
    // 概览：老师最怕「有人一周都没排到」和「有人排了 3 次」
    overview: { total: 0, slots: SLOTS, assigned: 0, missing: 0, maxTimes: 0, minTimes: 0 },
    missingList: [],              // 本周一次都没排到的人

    // 单日编排
    currentDay: 0,
    dayJobs: [],
    pickedId: '',
    pickedName: '',
    pool: [],                     // 可选学生（带本周已排次数，方便老师避开排太多的）

    dirtyFlag: false,             // 仅 UI 用；判定逻辑走 this.dirty
    saving: false
  },

  onLoad() {
    this.setData({ cloudReady: db.isCloudReady() });
    this.loadClassTitle();
    this.dirty = false;
    this.refresh();
    // watch 只在没有未保存改动时刷新，否则冲掉老师刚排好的（考勤页踩过）
    this.watcher = db.watch('dutySchedule', {}, () => {
      if (!this.dirty) this.refresh(true);
    }, err => console.error('watch dutySchedule error', err));
  },

  onShow() {
    this.loadClassTitle();
  },

  onUnload() {
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

  async refresh(silent) {
    if (!silent) this.setData({ loading: true });
    try {
      const [students, duties] = await Promise.all([
        db.list('students', {}, 500, { orderBy: [['studentNo', 'asc']] }),
        db.list('dutySchedule', {}, 800, { orderBy: [['weekday', 'asc']] })
      ]);
      this.students = students;
      this.dutyRecords = duties;
      this.buildFromCloud();
      this.setData({ loading: false });
    } catch (e) {
      console.error('refresh duty error', e);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  // 云端记录 → 本地 assign 表。脏数据（孤儿/非法 weekday/非法岗位/同天同岗重复排同人）
  // 在这里就地剔除，不能让它进 UI（否则同一个人在一格里出现两次）
  buildFromCloud() {
    const stuMap = {};
    (this.students || []).forEach(s => { stuMap[s._id] = s; });
    const seen = {};
    let dropped = 0;
    const assign = {};            // 'weekday@job' → [studentId]
    (this.dutyRecords || []).forEach(rec => {
      const wd = Number(rec.weekday);
      const job = String(rec.job || '');
      if (!stuMap[rec.studentId] || !(wd >= 1 && wd <= 5) || JOBS.indexOf(job) < 0) {
        dropped += 1;
        return;
      }
      const k = wd + '@' + job;
      const key = k + '@' + rec.studentId;
      if (seen[key]) { dropped += 1; return; }   // 同天同岗同人重复
      seen[key] = true;
      (assign[k] = assign[k] || []).push(rec.studentId);
    });
    if (dropped) console.warn(`[duty] 忽略 ${dropped} 条无效值日记录（孤儿/非法weekday/非法岗位/重复）`);
    this.assign = assign;
    this.render();
  },

  // 由 this.assign 渲染整个周表 + 概览（唯一的渲染入口，避免多处算出不同口径）
  render() {
    const stuMap = {};
    (this.students || []).forEach(s => { stuMap[s._id] = s; });
    const times = {};             // studentId → 本周次数
    const today = todayWeekday();

    // 每次渲染重算日期：进程常驻跨零点后模块级常量会停在旧日期
    const week = wk.weekdays().map(w => {
      const jobs = JOBS.map(job => {
        const ids = (this.assign[w.d + '@' + job] || []).filter(id => stuMap[id]);
        ids.forEach(id => { times[id] = (times[id] || 0) + 1; });
        return {
          job,
          jcls: JOB_CLS[job] || 'sweep',
          people: ids.map(id => ({ _id: id, name: stuMap[id].name, studentNo: stuMap[id].studentNo })),
          count: ids.length
        };
      });
      return {
        d: w.d,
        label: w.label,
        dateLabel: w.dateLabel,
        isToday: w.d === today,
        jobs,
        total: jobs.reduce((a, j) => a + j.count, 0)
      };
    });

    const total = (this.students || []).length;
    const assigned = Object.values(times).reduce((a, n) => a + n, 0);
    const missingList = (this.students || []).filter(s => !times[s._id])
      .map(s => ({ _id: s._id, name: s.name, studentNo: s.studentNo }));
    const counts = (this.students || []).map(s => times[s._id] || 0);

    this.setData({
      week,
      overview: {
        total,
        slots: SLOTS,
        assigned,
        missing: missingList.length,
        maxTimes: counts.length ? Math.max(...counts) : 0,
        minTimes: counts.length ? Math.min(...counts) : 0
      },
      missingList,
      dirtyFlag: !!this.dirty
    });
    this.times = times;
    // 单日视图打开时同步刷新（值日人被别处改了要跟着变）
    if (this.data.view === 'day' && this.data.currentDay) this.buildDay(this.data.currentDay);
  },

  markDirty() {
    this.dirty = true;
    if (!this.data.dirtyFlag) this.setData({ dirtyFlag: true });
  },

  isSaving() {
    return !!this._busy;
  },

  /* ---------------- 单日编排 ---------------- */

  onOpenDay(e) {
    const d = Number(e.currentTarget.dataset.d);
    if (!(d >= 1 && d <= 5)) return;
    this.setData({ view: 'day', currentDay: d, pickedId: '', pickedName: '' });
    this.buildDay(d);
  },

  onBackToWeek() {
    this.setData({ view: 'week', currentDay: 0, pickedId: '', pickedName: '' });
  },

  buildDay(d) {
    const stuMap = {};
    (this.students || []).forEach(s => { stuMap[s._id] = s; });
    const day = (this.data.week || []).find(w => w.d === d);
    const dayJobs = JOBS.map(job => {
      const ids = (this.assign[d + '@' + job] || []).filter(id => stuMap[id]);
      return {
        job,
        jcls: JOB_CLS[job] || 'sweep',
        people: ids.map(id => ({ _id: id, name: stuMap[id].name, studentNo: stuMap[id].studentNo })),
        count: ids.length
      };
    });
    // 候选池：带本周次数，次数少的排前面（老师优先挑没排过的）
    const t = this.times || {};
    const onDuty = new Set([].concat(...dayJobs.map(j => j.people.map(p => p._id))));
    const pool = (this.students || []).map(s => ({
      _id: s._id,
      name: s.name,
      studentNo: s.studentNo,
      times: t[s._id] || 0,
      busy: onDuty.has(s._id)          // 今天已经排了别的岗位
    })).sort((a, b) => a.times - b.times || String(a.studentNo).localeCompare(String(b.studentNo)));

    this.setData({
      currentDay: d,
      dayLabel: (day && day.label) || '',
      dayJobs,
      pool
    });
  },

  // 点候选学生：挑中（再点岗位就加进去）；重复点取消
  onPickStudent(e) {
    const id = e.currentTarget.dataset.id;
    const s = (this.data.pool || []).find(x => x._id === id);
    if (!s) return;
    if (this.data.pickedId === id) {
      this.setData({ pickedId: '', pickedName: '' });
      return;
    }
    this.setData({ pickedId: id, pickedName: s.name });
  },

  // 点岗位：把挑中的人加进这个岗位
  onAssignJob(e) {
    if (this.isSaving()) return;
    const job = e.currentTarget.dataset.job;
    if (JOBS.indexOf(job) < 0) return;
    const sid = this.data.pickedId;
    if (!sid) {
      wx.showToast({ title: '先在下面挑一个学生', icon: 'none' });
      return;
    }
    const d = this.data.currentDay;
    const k = d + '@' + job;
    const list = (this.assign[k] || []).slice();
    if (list.indexOf(sid) >= 0) {
      wx.showToast({ title: '这个岗位已经有他了', icon: 'none' });
      return;
    }
    // 同一天已排别的岗位就不再重复排：一个学生一天干两份值日不现实，
    // 而候选池里的 busy 标记只是灰一下、点了照样能排（探针实测同一人一天被排进 2 个岗）。
    const sameDay = JOBS.filter(j => (this.assign[d + '@' + j] || []).indexOf(sid) >= 0);
    if (sameDay.length) {
      const who = (this.students || []).find(s => s._id === sid);
      wx.showToast({
        title: `${who ? who.name : '这位同学'}今天已排「${sameDay[0]}」，先移除再换岗`,
        icon: 'none', duration: 2600
      });
      return;
    }
    list.push(sid);
    this.assign[k] = list;
    this.markDirty();
    this.render();
    this.setData({ pickedId: '', pickedName: '' });
  },

  // 点已排的人：从该岗位移除
  onRemovePerson(e) {
    if (this.isSaving()) return;
    const { job, id } = e.currentTarget.dataset;
    const d = this.data.currentDay;
    const k = d + '@' + job;
    const list = (this.assign[k] || []).filter(x => x !== id);
    if (list.length) this.assign[k] = list; else delete this.assign[k];
    this.markDirty();
    this.render();
  },

  /* ---------------- 批量操作 ---------------- */

  // 一键轮排：全班按学号轮流填 25 个岗位位置，保证每人恰好 1 次（人数>25 时部分岗位 2 人）
  onRotate() {
    if (this.isSaving()) return;
    const arr = (this.students || []).slice();
    if (!arr.length) {
      wx.showToast({ title: '还没有学生', icon: 'none' });
      return;
    }
    const assign = {};
    arr.forEach((s, i) => {
      const slot = i % SLOTS;
      const wd = WEEKDAYS[Math.floor(slot / JOBS.length)].d;
      const job = JOBS[slot % JOBS.length];
      const k = wd + '@' + job;
      (assign[k] = assign[k] || []).push(s._id);
    });
    this.assign = assign;
    this.markDirty();
    this.render();
    wx.showToast({ title: `已轮排 ${arr.length} 人`, icon: 'none' });
  },

  // 随机轮排：先打乱再轮排（Fisher-Yates，不要用 sort(()=>Math.random()-0.5)，分布是偏的）
  onShuffleRotate() {
    if (this.isSaving()) return;
    const arr = (this.students || []).slice();
    if (!arr.length) {
      wx.showToast({ title: '还没有学生', icon: 'none' });
      return;
    }
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    const assign = {};
    arr.forEach((s, i) => {
      const slot = i % SLOTS;
      const wd = WEEKDAYS[Math.floor(slot / JOBS.length)].d;
      const job = JOBS[slot % JOBS.length];
      (assign[wd + '@' + job] = assign[wd + '@' + job] || []).push(s._id);
    });
    this.assign = assign;
    this.markDirty();
    this.render();
    wx.showToast({ title: '已随机轮排', icon: 'none' });
  },

  onClearAll() {
    if (this.isSaving()) return;
    if (this.data.overview.assigned === 0) {
      wx.showToast({ title: '本来就是空的', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '清空值日表',
      content: `会清掉本周全部 ${this.data.overview.assigned} 人次安排（需点保存才同步到云端）`,
      confirmColor: '#B9412E',
      success: res => {
        if (!res.confirm) return;
        if (this.isSaving()) return;
        this.assign = {};
        this.markDirty();
        this.render();
      }
    });
  },

  /* ---------------- 保存 ---------------- */

  // diff 后只动变化的记录（全删重插会让 _id 抖动，也更容易半途失败）
  async onSave() {
    if (this._busy) return;              // this.data.saving 是异步的，防不住同 tick 连点
    if (!db.isCloudReady()) {
      wx.showToast({ title: '请先配置云环境', icon: 'none' });
      return;
    }
    // 目标态：'weekday@job@studentId' → {weekday,job,studentId}
    const target = {};
    Object.keys(this.assign || {}).forEach(k => {
      const [wdStr, job] = k.split('@');
      const wd = Number(wdStr);
      if (!(wd >= 1 && wd <= 5) || JOBS.indexOf(job) < 0) return;
      (this.assign[k] || []).forEach(sid => {
        target[`${wd}@${job}@${sid}`] = { weekday: wd, job, studentId: sid };
      });
    });

    // 云端态（同键多条 = 脏数据，多的进删除队列）
    const existing = {};
    const dupRecords = [];
    (this.dutyRecords || []).forEach(rec => {
      const key = `${Number(rec.weekday)}@${rec.job}@${rec.studentId}`;
      if (existing[key]) { dupRecords.push(rec); return; }
      existing[key] = rec;
    });

    const adds = Object.keys(target).filter(k => !existing[k]).map(k => target[k]);
    const removes = Object.keys(existing).filter(k => !target[k]).map(k => existing[k]._id)
      .concat(dupRecords.map(r => r._id));

    if (!adds.length && !removes.length) {
      this.dirty = false;
      this.setData({ dirtyFlag: false });
      wx.showToast({ title: '没有改动需要保存', icon: 'none' });
      return;
    }

    this._busy = true;
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中…', mask: true });
    try {
      // 分批并发：串行 30+ 条往返太慢（云函数那边 3s 就超时，小程序端也拖）。
      // 必须用 allSettled 而不是 Promise.all：一批里某条被限流/传输失败时，
      // 同批其余写入可能已落库（云端半迁移）。整批 reject + catch 不回读，会让
      // this.dutyRecords 停在保存前的旧快照，老师再点保存就按旧基线 diff，
      // 把已成功的新增再插一遍 —— 实测红队 seed=76405 云端冒出 41 条重复脏数据。
      const jobs = []
        .concat(adds.map(a => () => db.add('dutySchedule', a)))
        .concat(removes.map(id => () => db.remove('dutySchedule', id)));
      const rejected = [];
      for (let i = 0; i < jobs.length; i += 10) {
        const rs = await Promise.allSettled(jobs.slice(i, i + 10).map(f => f()));
        rs.forEach((r, j) => { if (r.status === 'rejected') rejected.push(r.reason); });
      }
      // 成败都先回读云端真值锚定 diff 基线。只更新原始记录，绝不重建 this.assign ——
      // 老师本地排好的内容原样保留；下次保存 diff「本地意图 vs 云端真值」，只补缺、删余，
      // 历史遗留的同键重复文档也会被 existing/dupRecords 逻辑顺手清掉（保存即自愈）。
      this.dutyRecords = await db.list('dutySchedule', {}, 800, { orderBy: [['weekday', 'asc']] });
      if (rejected.length) {
        console.error('save duty partial-fail', rejected.length, rejected[0]);
        this.dirty = true;               // 有没存上的，保持脏态让老师能继续点保存补齐
        this.setData({ dirtyFlag: true });
        wx.hideLoading();
        wx.showToast({ title: `${rejected.length} 项没存上，再点保存补齐`, icon: 'none' });
        return;
      }
      this.dirty = false;
      wx.hideLoading();
      wx.showToast({ title: `已保存（新增${adds.length}/撤${removes.length}）`, icon: 'success' });
      await this.refresh(true);           // 全成功才重建视图 + 清 dirtyFlag
    } catch (err) {
      // 连回读锚定都失败（弱网）：本地改动必须保留，不许假装成功
      console.error('save duty error', err);
      this.dirty = true;
      this.setData({ dirtyFlag: true });
      wx.hideLoading();
      wx.showToast({ title: '网络异常，安排已保留，请重试', icon: 'none' });
    } finally {
      this._busy = false;
      this.setData({ saving: false });
    }
  }
});
