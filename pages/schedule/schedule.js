const db = require('../../utils/db.js');
const classinfo = require('../../utils/classinfo.js');
const wk = require('../../utils/weekdays.js');

// 科目是中文，绝不能进 class 名（中文选择器会让整份 wxss 编译失败）——统一映射成 ASCII
const SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理', '体育', '音乐', '美术', '艺术', '信息', '自习'];
const SUB_CLS = {
  '语文': 'chn', '数学': 'math', '英语': 'eng', '物理': 'phy', '化学': 'chem',
  '生物': 'bio', '政治': 'pol', '历史': 'his', '地理': 'geo', '体育': 'pe',
  '音乐': 'music', '美术': 'art', '艺术': 'artc', '信息': 'it', '自习': 'self'
};
// 主科：一天排太多会被老师一眼看出不合理，用于「每日主科上限」告警
const MAIN_SUBJECTS = new Set(['语文', '数学', '英语']);
const MAX_MAIN_PER_DAY = 3;

// 周几 + 日历日期（如「周一 9/7」）由 utils/weekdays.js 统一算，值日页共用同一口径。
// 只有 d 是业务主键（对应云端 weekday 字段），label/dateLabel 纯展示。
const WEEKDAYS = wk.weekdays();
// 9 节：上午 4 节 + 午间延时 1 节 + 下午 4 节（2026-09-05 用户实际作息）
// ⚠️ 午间延时的 period 编号取 9（挂在数字末尾）而不是插成 5：
//    线上已有 period=1~8 的真实记录，插中间要迁移全部下午课，零收益高风险。
//    页面一律按 PERIODS 数组顺序渲染（render/buildDay 都是 PERIODS.map），
//    所以「数据编号」与「显示位置」解耦：9 在数组里排第 5 位，用户看到的就是午间。
//    校验一律用 PERIOD_SET（不许再写 pd <= 8 或 pd <= 9 这种区间判断）。
const PERIODS = [
  { p: 1, label: '第1节', part: 'am' }, { p: 2, label: '第2节', part: 'am' },
  { p: 3, label: '第3节', part: 'am' }, { p: 4, label: '第4节', part: 'am' },
  { p: 9, label: '延时', part: 'noon' },
  { p: 5, label: '第5节', part: 'pm' }, { p: 6, label: '第6节', part: 'pm' },
  { p: 7, label: '第7节', part: 'pm' }, { p: 8, label: '第8节', part: 'pm' }
];
const PERIOD_SET = new Set(PERIODS.map(x => x.p));
const SLOTS = WEEKDAYS.length * PERIODS.length;   // 45 个格子（5 天 × 9 节）

const todayWeekday = wk.todayWeekday;

Page({
  data: {
    loading: true,
    cloudReady: false,
    classTitle: '',
    view: 'week',                 // week=周表 / day=单日编排

    subjects: SUBJECTS,
    periods: PERIODS,
    week: [],                     // [{ d, label, isToday, cells:[{p,label,part,subject,scls,teacher,empty}], filled }]
    // 概览：老师最关心「还有几格空着」和「有没有排出冲突」
    overview: { slots: SLOTS, filled: 0, empty: SLOTS, subjects: 0, conflicts: 0 },
    conflictList: [],             // 冲突清单（同一时段同一老师被排两个班次 / 一天主科超上限）
    subjectStat: [],              // 每科周课时统计

    // 单日编排
    currentDay: 0,
    dayLabel: '',
    dayCells: [],
    pickedSubject: '',            // 挑中的科目（再点格子就填进去）
    swapFrom: '',                  // 调课模式：第一次点的格子 key（'d@p'），点第二个即交换
    fillTarget: '',                // 待填格子 key（'d@p'）：先点空格再挑科目的反向填课流（2026-09-11 用户反馈）
    fillTargetLabel: '',           // 给看的：「周一·第1节」

    dirtyFlag: false,             // 仅 UI 用；判定逻辑走 this.dirty
    saving: false
  },

  onLoad() {
    this.setData({ cloudReady: db.isCloudReady() });
    this.loadClassTitle();
    this.dirty = false;
    this.refresh();
    // watch 只在没有未保存改动时刷新，否则冲掉老师刚排好的（考勤/座位/值日都踩过）
    this.watcher = db.watch('schedule', {}, () => {
      if (!this.dirty) this.refresh(true);
    }, err => console.error('watch schedule error', err));
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
      // list() 内部分页：小程序端单次 get 最多 20 条，40 格必须分页取
      const rows = await db.list('schedule', {}, 400, { orderBy: [['weekday', 'asc'], ['period', 'asc']] });
      this.records = rows;
      this.buildFromCloud();
      this.setData({ loading: false });
    } catch (e) {
      console.error('refresh schedule error', e);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  // 云端记录 → 本地 plan。脏数据（非法 weekday/period/科目、同格多条）在这里就地剔除，
  // 不能让它进 UI（否则同一格显示两门课，老师照着上课必错）
  buildFromCloud() {
    const plan = {};              // 'weekday@period' → { subject, teacher }
    let dropped = 0;
    (this.records || []).forEach(rec => {
      const wd = Number(rec.weekday);
      const pd = Number(rec.period);
      const subject = String(rec.subject || '');
      if (!(wd >= 1 && wd <= 5) || !PERIOD_SET.has(pd) || SUBJECTS.indexOf(subject) < 0) {
        dropped += 1;
        return;
      }
      const k = wd + '@' + pd;
      if (plan[k]) { dropped += 1; return; }     // 同格重复：保留第一条
      plan[k] = { subject, teacher: String(rec.teacher || '') };
    });
    if (dropped) console.warn(`[schedule] 忽略 ${dropped} 条无效课表记录（非法weekday/period/科目 或 同格重复）`);
    this.plan = plan;
    this.render();
  },

  // 唯一渲染入口：week / overview / conflictList / subjectStat 全从 this.plan 算，
  // 保证「页面显示」和「将要保存的数据」永远同源（两套算法必然漂移，值日页立过这个规矩）
  render() {
    const today = todayWeekday();
    const plan = this.plan || {};
    const counts = {};            // 科目 → 周课时
    let filled = 0;

    // 每次渲染重算日期：小程序进程常驻，跨零点后模块级常量会停在旧日期（用户会看到昨天的日历）
    const week = wk.weekdays().map(w => {
      const cells = PERIODS.map(pd => {
        const item = plan[w.d + '@' + pd.p];
        if (item) {
          filled += 1;
          counts[item.subject] = (counts[item.subject] || 0) + 1;
        }
        return {
          p: pd.p,
          label: pd.label,
          part: pd.part,
          subject: item ? item.subject : '',
          scls: item ? (SUB_CLS[item.subject] || 'self') : '',
          teacher: item ? item.teacher : '',
          empty: !item
        };
      });
      return {
        d: w.d,
        label: w.label,
        dateLabel: w.dateLabel,          // 表头显示的日历日期（老师反馈：光有周几记不住哪天）
        isToday: w.d === today,
        cells,
        filled: cells.filter(c => !c.empty).length
      };
    });

    // 冲突1：同一天同一科目连着排太多（主科每天 ≤ MAX_MAIN_PER_DAY）
    // 冲突2：同一天同一节次出现两门课 —— 这个在 buildFromCloud 已剔重，这里兜底再查一次
    const conflicts = [];
    week.forEach(w => {
      const perSubject = {};
      w.cells.forEach(c => {
        if (c.empty) return;
        perSubject[c.subject] = (perSubject[c.subject] || 0) + 1;
      });
      Object.keys(perSubject).forEach(sub => {
        if (MAIN_SUBJECTS.has(sub) && perSubject[sub] > MAX_MAIN_PER_DAY) {
          conflicts.push({ key: w.d + '-' + sub, text: `${w.label} ${sub} 排了 ${perSubject[sub]} 节（主科每天不超过 ${MAX_MAIN_PER_DAY} 节）` });
        }
      });
      // 同一节次连着同一科目 3 连及以上，老师一般不接受
      for (let i = 0; i + 2 < w.cells.length; i++) {
        const a = w.cells[i], b = w.cells[i + 1], c = w.cells[i + 2];
        if (!a.empty && a.subject === b.subject && b.subject === c.subject) {
          conflicts.push({ key: w.d + '-run-' + a.p, text: `${w.label} ${a.subject} 连排 3 节（第${a.p}~${c.p}节）` });
        }
      }
    });

    const subjectStat = Object.keys(counts)
      .map(s => ({ subject: s, scls: SUB_CLS[s] || 'self', count: counts[s] }))
      .sort((a, b) => b.count - a.count || SUBJECTS.indexOf(a.subject) - SUBJECTS.indexOf(b.subject));

    this.setData({
      week,
      overview: {
        slots: SLOTS,
        filled,
        empty: SLOTS - filled,
        subjects: subjectStat.length,
        conflicts: conflicts.length
      },
      conflictList: conflicts,
      subjectStat,
      // 必须在唯一渲染入口里同步 dirtyFlag：只在 onSave 里清 this.dirty 的话，
      // 按钮会一直卡在「保存」上（duty/seats 的 render 都带这一行，schedule 第一版漏了）。
      // 实测探针：改一格 → 保存成功（dirty=false）→ dirtyFlag 仍 true。
      dirtyFlag: !!this.dirty
    });

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
    this.setData({ view: 'day', currentDay: d, pickedSubject: '' });
    this.buildDay(d);
  },

  onBackToWeek() {
    this.setData({ view: 'week', currentDay: 0, pickedSubject: '' });
  },

  buildDay(d) {
    const day = (this.data.week || []).find(w => w.d === d);
    this.setData({
      currentDay: d,
      dayLabel: (day && day.label) || '',
      dayCells: day ? day.cells : []
    });
  },

  // '1@9' → '周一·延时'；给待填提示条用
  labelOf(k) {
    const parts = String(k).split('@');
    const d = Number(parts[0]), pd = Number(parts[1]);
    const w = WEEKDAYS.find(x => x.d === d);
    const per = PERIODS.find(x => x.p === pd);
    return (w ? w.label : '') + '·' + (per ? per.label : '');
  },

  // 点科目：有待填格子就直接填进去；没有则挑中（再点格子填入）；重复点取消
  onPickSubject(e) {
    if (this.isSaving()) return;
    const s = e.currentTarget.dataset.subject;
    if (SUBJECTS.indexOf(s) < 0) return;
    // 反向填课流：老师先点了空格（「我要填的就是这一格」），再点科目即填入
    const t = this.data.fillTarget;
    if (t) {
      const cur = this.plan[t];
      if (cur && cur.subject === s) {
        wx.showToast({ title: '这一节已经是' + s, icon: 'none' });
        this.setData({ fillTarget: '', fillTargetLabel: '' });
        return;
      }
      this.plan[t] = { subject: s, teacher: (cur && cur.teacher) || '' };
      this.markDirty();
      this.render();
      this.setData({ fillTarget: '', fillTargetLabel: '', pickedSubject: '' });
      wx.showToast({ title: '已填入 ' + s, icon: 'none' });
      return;
    }
    // 「填课」和「换课」是互斥的两种模式：挑了科目就退出待交换态，
    // 否则老师挑完科目点格子，会被当成交换的第二次点击（实测很容易误操作）
    this.setData({ pickedSubject: this.data.pickedSubject === s ? '' : s, swapFrom: '' });
  },

  // 点格子：把挑中的科目填进这一节（已有课则覆盖）
  onTapCell(e) {
    if (this.isSaving()) return;
    const p = Number(e.currentTarget.dataset.p);
    if (!PERIOD_SET.has(p)) return;
    const sub = this.data.pickedSubject;
    const d = this.data.currentDay;
    const k = d + '@' + p;
    if (!sub) {
      // 空格：记为待填目标，再点科目直接填入（不写数据不标脏）
      if (!this.plan[k]) {
        if (this.data.fillTarget === k) {
          this.setData({ fillTarget: '', fillTargetLabel: '' });
        } else {
          this.setData({ fillTarget: k, fillTargetLabel: this.labelOf(k) });
          wx.showToast({ title: '再挑一个科目填入这一节', icon: 'none' });
        }
        return;
      }
      wx.showToast({ title: '先在下面挑一个科目', icon: 'none' });
      return;
    }
    const cur = this.plan[k];
    if (cur && cur.subject === sub) {
      wx.showToast({ title: '这一节已经是' + sub, icon: 'none' });
      return;
    }
    this.plan[k] = { subject: sub, teacher: (cur && cur.teacher) || '' };
    this.markDirty();
    this.render();
    // 填完必须清掉选中：不清的话老师接着点别的格子会连填一片（duty/seats 都是填完就清，
    // 这里第一版漏了，被 e2e 的「未挑科目」断言意外暴露出来）
    this.setData({ pickedSubject: '' });
  },

  // 长按格子：清掉这一节（「无记录 = 空课」，不存占位记录）
  onClearCell(e) {
    if (this.isSaving()) return;
    const p = Number(e.currentTarget.dataset.p);
    const d = this.data.currentDay;
    const k = d + '@' + p;
    if (!this.plan[k]) {
      wx.showToast({ title: '这一节本来是空的', icon: 'none' });
      return;
    }
    delete this.plan[k];
    this.markDirty();
    this.render();
  },

  /* ---------------- 周表快捷调换（用户反馈 2026-09-06）----------------
   * 设计：点格子 = 选中 → 再点格子 = 交换；同格再点 = 取消；非法格 = 拒绝。
   * 走 this.plan 改内存，云端走 onSave 统一持久化。
   * 「非空↔空」= 移动，「非空↔非空」= 互换。 */
  onCellPick(e) {
    if (this.isSaving()) return;
    const d = Number(e.currentTarget.dataset.d);
    const p = Number(e.currentTarget.dataset.p);
    if (!(d >= 1 && d <= 5) || !PERIOD_SET.has(p)) return;
    const k = d + '@' + p;
    // 态 1：已挑科目 → 直接填进这一格（省掉「进单日页」这一跳，用户反馈 2026-09-06）
    const picked = this.data.pickedSubject;
    if (picked) {
      if (SUBJECTS.indexOf(picked) < 0) { this.setData({ pickedSubject: '' }); return; }
      const cur0 = this.plan[k];
      if (cur0 && cur0.subject === picked) {
        wx.showToast({ title: '这一节已经是' + picked, icon: 'none' });
        this.setData({ pickedSubject: '' });
        return;
      }
      this.plan[k] = { subject: picked, teacher: (cur0 && cur0.teacher) || '' };
      this.markDirty();
      this.render();
      // 填完必须清选中，否则老师接着点别的格子会连填一片（day 页同样规矩）
      this.setData({ pickedSubject: '', swapFrom: '' });
      wx.showToast({ title: '已填入 ' + picked, icon: 'none' });
      return;
    }
    if (!this.data.swapFrom) {
      // 没有交换源时：空格 = 进「待填」态（用户反馈：点空格就是想填课，
      // 只弹「先挑科目」的 toast 等于没有入口）；已占格 = 进交换选择
      if (!this.plan[k]) {
        if (this.data.fillTarget === k) {
          this.setData({ fillTarget: '', fillTargetLabel: '' });
        } else {
          this.setData({ fillTarget: k, fillTargetLabel: this.labelOf(k), swapFrom: '' });
          wx.showToast({ title: '再挑一个科目填入这一节', icon: 'none' });
        }
        return;
      }
      this.setData({ swapFrom: k, fillTarget: '', fillTargetLabel: '' });
      return;
    }
    if (this.data.swapFrom === k) {
      this.setData({ swapFrom: '' });
      return;
    }
    const a = this.data.swapFrom;
    const b = k;
    const av = this.plan[a];
    const bv = this.plan[b];
    if (av || bv) {
      // ⚠️ 读 av/bv 必须在写之前：onCellPick 的 if 块会先写 plan[b]，导致后面读 plan[a] 拿到新值
      // 互换逻辑必须先缓存原值：subjectA=av.subject, subjectA=bv.subject 互相覆盖
      const subjectA = av && av.subject;
      const subjectB = bv && bv.subject;
      const teacher = (bv && bv.teacher) || (av && av.teacher) || '';
      // 双方都非空：互换
      if (av && bv) {
        this.plan[a] = { subject: subjectB, teacher };
        this.plan[b] = { subject: subjectA, teacher };
      } else if (av) {
        // a 非空 b 空：移动过去
        this.plan[b] = { subject: subjectA, teacher };
        delete this.plan[a];
      } else {
        // a 空 b 非空：移回 a
        this.plan[a] = { subject: subjectB, teacher };
        delete this.plan[b];
      }
      this.markDirty();
      this.render();
      wx.showToast({ title: av && bv ? '已交换两节课' : '已移动一节课', icon: 'none' });
    }
    this.setData({ swapFrom: '', fillTarget: '', fillTargetLabel: '' });
  },

  onCancelSwap() {
    this.setData({ swapFrom: '', pickedSubject: '', fillTarget: '', fillTargetLabel: '' });
  },

  // 周表格子长按 = 清掉这一节（day 页 onClearCell 只认 currentDay，周表必须带 d）
  onClearWeekCell(e) {
    if (this.isSaving()) return;
    const d = Number(e.currentTarget.dataset.d);
    const p = Number(e.currentTarget.dataset.p);
    if (!(d >= 1 && d <= 5) || !PERIOD_SET.has(p)) return;
    const k = d + '@' + p;
    if (!this.plan[k]) {
      wx.showToast({ title: '这一节本来是空的', icon: 'none' });
      return;
    }
    delete this.plan[k];
    this.markDirty();
    this.render();
    this.setData({ swapFrom: '', pickedSubject: '', fillTarget: '', fillTargetLabel: '' });
    wx.showToast({ title: '已清空这一节', icon: 'none' });
  },

  /* ---------------- 批量操作 ---------------- */

  // 一键套用模板：主科排在上午（学生上午状态好），副科下午，第 8 节固定自习
  // 不是随机填 —— 老师要的是「能直接用」的初稿，不是需要重排的乱表
  onApplyTemplate() {
    if (this.isSaving()) return;
    const AM = ['语文', '数学', '英语', '物理'];
    const PM = ['化学', '生物', '政治', '历史', '地理', '体育', '音乐', '美术', '艺术', '信息'];
    const plan = {};
    WEEKDAYS.forEach((w, wi) => {
      // 上午 4 节：主科轮转，保证每天顺序不同（避免每天第 1 节都是语文）
      AM.forEach((_, i) => {
        const sub = AM[(i + wi) % AM.length];
        plan[w.d + '@' + (i + 1)] = { subject: sub, teacher: '' };
      });
      // 午间延时（period 9）：固定自习 —— 延时课的实际用途就是看管+补作业，
      // 排主科会让「每日主科上限」告警误报，排副科老师中午也不到岗
      plan[w.d + '@9'] = { subject: '自习', teacher: '' };
      // 下午 5~7 节：副科按天轮转；第 8 节固定自习
      for (let i = 0; i < 3; i++) {
        const sub = PM[(wi * 3 + i) % PM.length];
        plan[w.d + '@' + (i + 5)] = { subject: sub, teacher: '' };
      }
      plan[w.d + '@8'] = { subject: '自习', teacher: '' };
    });
    this.plan = plan;
    this.markDirty();
    this.render();
    wx.showToast({ title: `已套用模板（${SLOTS} 节全排）`, icon: 'none' });
  },

  onClearAll() {
    if (this.isSaving()) return;
    if (this.data.overview.filled === 0) {
      wx.showToast({ title: '本来就是空的', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '清空课表',
      content: `会清掉全部 ${this.data.overview.filled} 节课，保存后生效。`,
      confirmColor: '#B9412E',
      success: res => {
        if (!res.confirm) return;
        if (this.isSaving()) return;
        this.plan = {};
        this.markDirty();
        this.render();
      }
    });
  },

  /* ---------------- 保存 ---------------- */

  async onSave() {
    if (this._busy) return;              // this.data.saving 是异步的，防不住同 tick 连点
    if (!db.isCloudReady()) {
      wx.showToast({ title: '请先配置云环境', icon: 'none' });
      return;
    }
    // 目标态：'weekday@period' → { weekday, period, subject, teacher }
    const target = {};
    Object.keys(this.plan || {}).forEach(k => {
      const [wdStr, pdStr] = k.split('@');
      const wd = Number(wdStr);
      const pd = Number(pdStr);
      const item = this.plan[k] || {};
      if (!(wd >= 1 && wd <= 5) || !PERIOD_SET.has(pd)) return;
      if (SUBJECTS.indexOf(item.subject) < 0) return;
      target[k] = { weekday: wd, period: pd, subject: item.subject, teacher: item.teacher || '' };
    });

    // 云端态（同格多条 = 脏数据，多的进删除队列）
    const existing = {};
    const dupRecords = [];
    (this.records || []).forEach(rec => {
      const key = `${Number(rec.weekday)}@${Number(rec.period)}`;
      if (existing[key]) { dupRecords.push(rec); return; }
      existing[key] = rec;
    });

    // 一格一课，所以 diff 是三分支：新增 / 改科目(update) / 撤掉(remove)
    const adds = [];
    const updates = [];
    Object.keys(target).forEach(k => {
      const cur = existing[k];
      if (!cur) { adds.push(target[k]); return; }
      if (String(cur.subject) !== target[k].subject || String(cur.teacher || '') !== target[k].teacher) {
        updates.push({ _id: cur._id, subject: target[k].subject, teacher: target[k].teacher });
      }
    });
    const removes = Object.keys(existing).filter(k => !target[k]).map(k => existing[k]._id)
      .concat(dupRecords.map(r => r._id));

    if (!adds.length && !updates.length && !removes.length) {
      this.dirty = false;
      this.setData({ dirtyFlag: false });
      wx.showToast({ title: '没有改动需要保存', icon: 'none' });
      return;
    }

    this._busy = true;
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中…', mask: true });
    try {
      // 分批并发：串行 40 条往返太慢（云函数那边 3s 就超时，小程序端也拖）。
      // allSettled：同批单条失败时其余写入可能已落库，不能整批 reject 后拿旧基线重 diff
      //（值日页实测：半迁移 + 旧快照重试 → 已存新增被再插一遍，云端冒出重复文档）。
      const jobs = []
        .concat(adds.map(a => () => db.add('schedule', a)))
        .concat(updates.map(u => () => db.update('schedule', u._id, { subject: u.subject, teacher: u.teacher })))
        .concat(removes.map(id => () => db.remove('schedule', id)));
      const rejected = [];
      for (let i = 0; i < jobs.length; i += 10) {
        const rs = await Promise.allSettled(jobs.slice(i, i + 10).map(f => f()));
        rs.forEach(r => { if (r.status === 'rejected') rejected.push(r.reason); });
      }
      // 成败都回读云端真值锚定 this.records，只锚定原始记录、不重建 this.plan；
      // 再点保存时 diff「本地课表 vs 云端真值」，只补缺/改余，重复同格文档顺手清掉。
      this.records = await db.list('schedule', {}, 400, { orderBy: [['weekday', 'asc'], ['period', 'asc']] });
      if (rejected.length) {
        console.error('save schedule partial-fail', rejected.length, rejected[0]);
        this.dirty = true;
        this.setData({ dirtyFlag: true });
        wx.hideLoading();
        wx.showToast({ title: `${rejected.length} 项没存上，再点保存补齐`, icon: 'none' });
        return;
      }
      this.dirty = false;
      wx.hideLoading();
      wx.showToast({ title: `已保存（新增${adds.length}/改${updates.length}/撤${removes.length}）`, icon: 'success' });
      await this.refresh(true);           // 全成功才重建视图
    } catch (err) {
      // 连回读锚定都失败（弱网）：本地课表必须保留，不许假装成功
      console.error('save schedule error', err);
      this.dirty = true;
      this.setData({ dirtyFlag: true });
      wx.hideLoading();
      wx.showToast({ title: '网络异常，课表已保留，请重试', icon: 'none' });
    } finally {
      this._busy = false;
      this.setData({ saving: false });
    }
  }
});
