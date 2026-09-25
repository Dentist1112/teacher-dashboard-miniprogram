const db = require('../../utils/db.js');
const classinfo = require('../../utils/classinfo.js');
const kb = require('../../utils/kb.js');
const scoreAnalysis = require('../../utils/scoreanalysis.js');

// 标签是中文，绝不能进 class 名（会让整份 wxss 编译失败），统一映射成 ASCII
const TAGS = ['班干部', '需关注', '住宿', '走读', '体育特长', '艺术特长', '单亲家庭', '低保'];
const TAG_CLS = {
  '班干部': 'cadre', '需关注': 'watch', '住宿': 'boarder', '走读': 'daily',
  '体育特长': 'sport', '艺术特长': 'art', '单亲家庭': 'single', '低保': 'aid'
};
// 健康状况里出现这些词就红色高亮：班主任最怕漏掉过敏和急救药
const RISK_WORDS = ['过敏', '哮喘', '心脏', '癫痫', '糖尿病', '蚕豆', '晕', '禁', '药'];
const HEALTH_OK = ['良好', '正常', '无', '健康', ''];

function isRisk(health) {
  const h = String(health || '').trim();
  if (HEALTH_OK.indexOf(h) >= 0) return false;
  return RISK_WORDS.some(w => h.indexOf(w) >= 0);
}

// 从 parent 字段里抠出手机号，方便一键拨号（seed 里是「家长01 138****01」这种格式）
// 交给 validate.pickPhone：正则 match 会从 12 位号里抠出前 11 位，一键拨号就拨错人
// （2026-09-06 探针实测：'妈妈 139000088888' 被存下并抠出 13900008888）
const pickPhone = db.validate.pickPhone;

Page({
  // 弹层内容区吞掉 tap，避免冒泡到 mask 的取消处理器把弹层关掉
  // （原来写 catchtap="" 空处理器，实测不生效：点输入框 showForm 直接变 false）
  noop() {},

  data: {
    loading: true,
    cloudReady: false,
    classTitle: '',
    view: 'list',                 // list=名册 / detail=单人档案

    students: [],                 // 装饰后的全量
    shown: [],                    // 筛选后的
    filter: 'all',                // all / risk / watch / nodata
    keyword: '',
    overview: { total: 0, riskCount: 0, watchCount: 0, noPhone: 0, noHealth: 0 },

    // 单人档案
    current: null,
    stats: null,

    // 编辑表单
    showForm: false,
    tags: TAGS,
    form: { _id: '', name: '', studentNo: '', birth: '', parent: '', health: '', tagSet: [] },
    saving: false
  },

  onUnload() {
    kb.unbind(this);
  },

  onLoad(query) {
    kb.bind(this);   // 键盘弹起时把弹层底部操作条顶上来（fixed 弹层不受 adjust-position 影响）
    this.setData({ cloudReady: db.isCloudReady() });
    this.loadClassTitle();
    // 支持从名单页带 id 直接进详情
    this.pendingId = query && query.id ? query.id : '';
    this.refresh();
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
    if (this.isSaving()) {
      wx.stopPullDownRefresh();
      return;
    }
    this.refresh().then(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    this.setData({ loading: true });
    try {
      const students = await db.list('students', {}, 500, { orderBy: [['studentNo', 'asc']] });
      const decorated = students.map(s => this.decorate(s));

      // 概览按全量算，不受筛选/搜索影响
      const overview = {
        total: decorated.length,
        riskCount: decorated.filter(s => s.risk).length,
        watchCount: decorated.filter(s => s.tagList.indexOf('需关注') >= 0).length,
        noPhone: decorated.filter(s => !s.phone).length,
        noHealth: decorated.filter(s => !String(s.health || '').trim()).length
      };

      this.setData({ students: decorated, overview, loading: false });
      this.applyFilter();

      if (this.data.view === 'detail' && this.data.current) {
        const fresh = decorated.find(s => s._id === this.data.current._id);
        if (fresh) this.openDetail(fresh);
        else this.setData({ view: 'list', current: null, stats: null }); // 学生被删了
      } else if (this.pendingId) {
        const hit = decorated.find(s => s._id === this.pendingId);
        this.pendingId = '';
        if (hit) this.openDetail(hit);
      }
    } catch (e) {
      console.error('refresh profile error', e);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  decorate(s) {
    const tagList = Array.isArray(s.tags) ? s.tags.filter(t => String(t || '').trim()) : [];
    const health = String(s.health || '').trim();
    return {
      _id: s._id,
      studentNo: s.studentNo || '',
      name: s.name || '',
      gender: s.gender || '',
      gcls: s.gender === '女' ? 'female' : 'male',
      birth: s.birth || '',
      parent: s.parent || '',
      phone: pickPhone(s.parent),
      health,
      risk: isRisk(health),
      tagList,
      tagChips: tagList.map(t => ({ text: t, cls: TAG_CLS[t] || 'other' })),
      // 档案完整度：姓名/学号是必填不算，看这 4 项
      missing: ['birth', 'parent', 'health'].filter(k => !String(s[k] || '').trim()).length
        + (tagList.length ? 0 : 1)
    };
  },

  applyFilter() {
    const { filter, keyword, students } = this.data;
    const kw = String(keyword || '').trim().toLowerCase();
    let shown = students;
    if (filter === 'risk') shown = shown.filter(s => s.risk);
    else if (filter === 'watch') shown = shown.filter(s => s.tagList.indexOf('需关注') >= 0);
    else if (filter === 'nodata') shown = shown.filter(s => s.missing > 0);
    if (kw) {
      shown = shown.filter(s =>
        s.name.toLowerCase().indexOf(kw) >= 0
        || s.studentNo.toLowerCase().indexOf(kw) >= 0
        || s.phone.indexOf(kw) >= 0);
    }
    this.setData({ shown });
  },

  onFilter(e) {
    const f = e.currentTarget.dataset.f;
    if (f === this.data.filter) return;
    this.setData({ filter: f });
    this.applyFilter();
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value });
    this.applyFilter();
  },

  onClearSearch() {
    this.setData({ keyword: '' });
    this.applyFilter();
  },

  /* ---------------- 单人档案 ---------------- */

  onOpenDetail(e) {
    const id = e.currentTarget.dataset.id;
    const stu = this.data.students.find(s => s._id === id);
    if (!stu) return;
    this.openDetail(stu);
  },

  // 打开详情：先出静态信息，再异步补聚合数据（不阻塞渲染）
  openDetail(stu) {
    this.setData({ view: 'detail', current: stu, stats: null });
    this.loadStats(stu._id);
  },

  async loadStats(studentId) {
    if (!db.isCloudReady()) return;
    this._statsFor = studentId;
    try {
      const [att, rew, sc, subs, allScores] = await Promise.all([
        db.list('attendance', { studentId }, 400, { orderBy: [['date', 'desc']] }),
        db.list('rewards', { studentId }, 200, { orderBy: [['date', 'desc']] }),
        db.list('scores', { studentId }, 400, { orderBy: [['updatedAt', 'desc']] }),
        db.list('homeworkSubmit', { studentId }, 400, { orderBy: [['updatedAt', 'desc']] }),
        // 全班成绩用于跨学科总览的班级排名和各科班级均分（分页取全量，班级百条内）
        db.list('scores', {}, 2000, { orderBy: [['updatedAt', 'desc']] })
      ]);
      // 期间可能已经切到别人了，丢弃过期结果
      if (this._statsFor !== studentId) return;

      const abnormal = att.filter(a => a.status && a.status !== '正常');
      const netPoints = rew.reduce((acc, r) => acc + (Number(r.points) || 0), 0);
      // full 必须是正数才能算百分比：`Number(x.full) || 100` 会把 full=0 的脏成绩
      // 悄悄按 100 分制算（探针实测 score=50/full=0 把均分从 74 拉到 62，老师看不出哪错了）。
      // 这类记录一律不计入均分，另外计数备查。
      const scored = sc.filter(x => Number.isFinite(Number(x.score)) && Number(x.full) > 0);
      const badFull = sc.length - scored.length;
      const avg = scored.length
        ? String(Math.round(scored.reduce((a, x) => a + Number(x.score) / Number(x.full) * 100, 0) / scored.length))
        : '—';

      this.setData({
        stats: {
          attTotal: att.length,
          attAbnormal: abnormal.length,
          // 只列最近 5 条异常，全列会把页面撑爆
          attRecent: abnormal.slice(0, 5).map(a => ({
            date: a.date,
            status: a.status === '缺勤' ? '请假（原缺勤）' : a.status
          })),
          rewCount: rew.length,
          netPoints,
          rewRecent: rew.slice(0, 5).map(r => {
            const p = Number(r.points) || 0;
            return { reason: r.reason, date: r.date, pointsText: (p >= 0 ? '+' : '') + p, pcls: p >= 0 ? 'add' : 'sub' };
          }),
          scoreCount: scored.length,
          badFullCount: badFull,
          avgPct: avg,
          hwDone: subs.filter(x => ['已交', '补交', '免交'].indexOf(x.status) >= 0).length,
          hwTotal: subs.length,
          // 跨学科综合分析（最近一次考试 + 班级排名 + 强弱科 + 与上次对比）
          scoreAnalysis: scoreAnalysis.buildStudentAnalysis(allScores, studentId),
          // v0.9.6 个人成绩全景：历次考试 × 各科，原成绩页全班大矩阵撤到这里
          scorePanorama: this.buildPanoramaView(allScores, studentId)
        }
      });
    } catch (e) {
      console.error('load profile stats error', e);
      if (this._statsFor === studentId) this.setData({ stats: null });
    }
  },

  // 全景数据 → 视图模型：分档配色与成绩页原矩阵同一套（1 档最高 5 档最低 0 缺考）
  buildPanoramaView(allScores, studentId) {
    const p = scoreAnalysis.buildStudentPanorama(allScores, studentId, 6);
    if (!p.rows.length) return null;
    return {
      subjects: p.subjects,
      rows: p.rows.map(r => ({
        exam: r.exam,
        avg: r.avg === null ? '—' : String(r.avg),
        cells: p.subjects.map(sk => {
          const c = r.cells[sk];
          if (!c) return { text: '—', cls: 0, tip: '' };
          const pct = Math.round(c.pct);
          const cls = pct >= 90 ? 1 : pct >= 80 ? 2 : pct >= 70 ? 3 : pct >= 60 ? 4 : 5;
          return { text: String(pct), cls, tip: c.score + '/' + c.full };
        })
      }))
    };
  },

  onPanoCell(e) {
    const tip = e.currentTarget.dataset.tip;
    if (tip) wx.showToast({ title: '原始分 ' + tip, icon: 'none' });
  },

  onBackToList() {
    this._statsFor = '';
    this.setData({ view: 'list', current: null, stats: null });
  },

  onCallParent() {
    const phone = this.data.current && this.data.current.phone;
    if (!phone) {
      wx.showToast({ title: '未登记家长手机号', icon: 'none' });
      return;
    }
    wx.makePhoneCall({ phoneNumber: phone, fail: () => {} });
  },

  onCopyPhone() {
    const phone = this.data.current && this.data.current.phone;
    if (!phone) {
      wx.showToast({ title: '未登记家长手机号', icon: 'none' });
      return;
    }
    wx.setClipboardData({ data: phone });
  },

  /* ---------------- 编辑档案 ---------------- */

  onEditProfile() {
    if (this.isSaving()) return;
    const s = this.data.current;
    if (!s) return;
    this.setData({
      showForm: true,
      form: {
        _id: s._id,
        name: s.name,
        studentNo: s.studentNo,
        birth: s.birth || '',
        parent: s.parent || '',
        health: s.health || '',
        tagSet: s.tagList.slice()
      }
    });
  },

  onFormInput(e) {
    this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value });
  },

  onBirthChange(e) {
    this.setData({ 'form.birth': e.detail.value });
  },

  onToggleTag(e) {
    const t = e.currentTarget.dataset.tag;
    const set = this.data.form.tagSet.slice();
    const i = set.indexOf(t);
    if (i >= 0) set.splice(i, 1); else set.push(t);
    this.setData({ 'form.tagSet': set });
  },

  onFormCancel() {
    this.setData({ showForm: false });
  },

  async onFormSave() {
    if (this._busy) return; // setData 异步，this.data.saving 防不住连点
    if (!db.isCloudReady()) {
      wx.showToast({ title: '请先配置云环境', icon: 'none' });
      return;
    }
    const { _id, birth, parent, health, tagSet } = this.data.form;
    if (!_id) return;
    // 出生日期格式必须能被 picker 和统计识别
    const b = String(birth || '').trim();
    const p = String(parent || '').trim();
    const h = String(health || '').trim();
    // 规则收在 validate.checkStudent：只验格式会放过 '2011-13-45' / '0000-00-00' / '2099-01-01'
    //（三者探针实测全部入库），也放过 12 位假手机号
    const why = db.validate.check('students', { birth: b, parent: p, health: h });
    if (why) {
      wx.showToast({ title: why, icon: 'none', duration: 2600 });
      return;
    }

    this._busy = true;
    this.setData({ saving: true });
    try {
      await db.update('students', _id, {
        birth: b,
        parent: p,
        health: h,
        tags: (tagSet || []).filter(t => TAGS.indexOf(t) >= 0)
      });
      wx.showToast({ title: '已保存', icon: 'success' });
      this.setData({ showForm: false });
      await this.refresh();
    } catch (e) {
      console.error('save profile error', e);
      wx.showToast({ title: '保存失败', icon: 'none' });
    } finally {
      this._busy = false;
      this.setData({ saving: false });
    }
  }
});
