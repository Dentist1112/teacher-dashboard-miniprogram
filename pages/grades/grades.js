const db = require('../../utils/db.js');
const classinfo = require('../../utils/classinfo.js');
const kb = require('../../utils/kb.js');
const modal = require('../../utils/modal.js');
// 数值范围规则与 utils/db.js 的写库兜底、cloudfunctions/api 的服务端兜底同源，
// 不在这里手抄常量（抄一份就会漂移一份）
const validate = require('../../utils/validate.js');

const sa = require('../../utils/scoreanalysis.js');
const SUBJECTS = sa.SUBJECT_ORDER;
const DEFAULT_EXAM = '第一次月考';

function todayStr() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// 保留 1 位小数但去掉多余的 .0
function fmt(n) {
  const v = Math.round(n * 10) / 10;
  return String(v);
}

function compareStudentNo(a, b) {
  const an = Number(a.studentNo);
  const bn = Number(b.studentNo);
  if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
  return String(a.studentNo || '').localeCompare(String(b.studentNo || ''));
}

// 已加载/已保存的成绩按高分在前展示；rebuild 时调用。
// 不在 onScoreInput 的 recompute() 里排序，否则输入第一个数字时整行会跳到别处，
// 真机上键盘焦点和手指位置都会被打断。
function sortSavedRows(rows) {
  const scoreOf = r => {
    const raw = String(r.scoreInput || '').trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  return rows.slice().sort((a, b) => {
    const an = scoreOf(a);
    const bn = scoreOf(b);
    if (an === null && bn === null) return compareStudentNo(a, b);
    if (an === null) return 1;
    if (bn === null) return -1;
    if (an !== bn) return bn - an;
    return compareStudentNo(a, b);
  });
}

Page({
  // 弹层内容区吞掉 tap，避免冒泡到 mask 的取消处理器把弹层关掉
  // （原来写 catchtap="" 空处理器，实测不生效：点输入框 showForm 直接变 false）
  noop() {},

  data: {
    loading: true,
    cloudReady: false,
    classTitle: '',
    exams: [DEFAULT_EXAM],
    examIndex: 0,
    subjects: SUBJECTS,
    subjectIndex: 0,
    full: '100',
    fullWarn: '',                 // 满分非法时的原因（空 = 合法）
    focusInvalidId: '',           // 保存被拦时高亮的那一行
    maxFull: validate.SCORE_MAX_FULL,
    rows: [],
    stats: { entered: 0, avg: '0', max: '0', min: '0', passRate: '0' },
    buckets: [],
    wave: null,                  // 名次波动预警（仅选中最近一次考试时出现）
    saving: false,
    showExamForm: false,
    examInput: '',
    aiNote: '',
    aiPasteShow: false,
    aiPasteText: ''
  },

  onHide() {
    modal.showTabBar(this);
  },

  onUnload() {
    modal.showTabBar(this);
    kb.unbind(this);
  },

  onLoad() {
    kb.bind(this);   // 键盘弹起时把弹层底部操作条顶上来（fixed 弹层不受 adjust-position 影响）
    this.setData({ cloudReady: db.isCloudReady() });
    this.loadClassTitle();
    this.bootstrap();
  },

  onShow() {
    const tb = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tb) tb.setData({ selected: 2 });
    modal.syncTabBar(this, !!(this.data.showExamForm || this.data.aiPasteShow));
    this.loadClassTitle();
  },

  async loadClassTitle() {
    const info = await classinfo.get();
    this.setData({ classTitle: classinfo.title(info) });
  },

  async bootstrap() {
    this.setData({ loading: true });
    try {
      const [students, allScores] = await Promise.all([
        db.list('students', {}, 500, { orderBy: [['studentNo', 'asc']] }),
        db.list('scores', {}, 2000, { orderBy: [['updatedAt', 'desc']] })
      ]);
      this.students = students;
      this.allScores = allScores;

      // 已有考试名去重，最近用过的排前面
      const seen = [];
      allScores.forEach(s => {
        const e = String(s.exam || '').trim();
        if (e && seen.indexOf(e) < 0) seen.push(e);
      });
      const exams = seen.length ? seen : [DEFAULT_EXAM];
      this.setData({ exams, examIndex: 0, loading: false });
      this.rebuild();
    } catch (e) {
      console.error('grades bootstrap error', e);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  // 当前 考试+科目 组合下，把学生和已有成绩合并成录入行
  rebuild() {
    const exam = this.data.exams[this.data.examIndex];
    const subject = this.data.subjects[this.data.subjectIndex];
    const map = {};
    (this.allScores || []).forEach(s => {
      if (s.exam === exam && s.subject === subject) map[s.studentId] = s;
    });

    // 未保存的本地输入优先（切科目会清，切回来重读云端）
    const dirty = this.dirty || {};
    const prev = {};
    (this.data.rows || []).forEach(r => { prev[r._id] = r; });

    const rows = (this.students || []).map(s => {
      const rec = map[s._id];
      const local = dirty[s._id] ? prev[s._id] : null;
      const scoreInput = local ? local.scoreInput
        : (rec && rec.score !== undefined && rec.score !== null ? String(rec.score) : '');
      return {
        _id: s._id,
        studentNo: s.studentNo,
        name: s.name,
        scoreInput,
        scoreId: rec ? rec._id : '',
        invalid: false,
        invalidWhy: '',
        rankText: ''
      };
    });
    this.setData({ rows: sortSavedRows(rows) });
    this.buildAnalysis(exam);
    this.recompute();
  },

  // v0.9.6：只留名次波动预警；成绩全景挪进档案页单人视图（全班 48×10 大矩阵一屏看不清，已撤）。纯派生，不写库。
  buildAnalysis(exam) {
    const all = this.allScores || [];
    const students = this.students || [];
    const smap = {};
    students.forEach(st => { smap[st._id] = st; });

    // ---- 名次波动：只在选中全班最近一次考试时展示 ----
    let wave = null;
    const wv = sa.buildClassWave(all);
    if (exam === wv.latestExam && (wv.down.length || wv.up.length)) {
      const mapItem = x => {
        const st = smap[x.studentId];
        return st ? { id: x.studentId, name: st.name, n: Math.abs(x.delta), path: x.rankPrev + '→' + x.rankNow } : null;
      };
      const down = wv.down.map(mapItem).filter(Boolean);
      const up = wv.up.map(mapItem).filter(Boolean);
      if (down.length || up.length) wave = { prevExam: wv.prevExam, down, up };
    }
    this.setData({ wave });
  },


  // 统计 + 分布 + 排名，全部基于当前输入框的值（未保存也能预览）
  recompute() {
    const fullVal = Number(this.data.full) || 100;
    const rows = this.data.rows;
    const valid = [];

    const marked = rows.map(r => {
      const raw = String(r.scoreInput || '').trim();
      if (!raw) return { ...r, invalid: false, invalidWhy: '', num: null };
      // 把「原始字符串」而不是 Number(raw) 交给 validate：先转数字等于替老师做了一次
      // 隐式解析，'1e2' 会变成合法的 100 再送去校验，校验必然放行（2026-09-06 探针实测
      // 输入 1e2 存成 100 分）。规则里的 strictDec 只认十进制写法，所以必须原样传。
      const why = validate.check('scores', { score: raw, full: fullVal });
      const n = why ? null : Number(raw);
      if (!why) valid.push({ id: r._id, n });
      return { ...r, invalid: !!why, invalidWhy: why || '', num: n };
    });

    // 排名：同分同名次
    const sorted = valid.slice().sort((a, b) => b.n - a.n);
    const rankOf = {};
    let lastScore = null;
    let lastRank = 0;
    sorted.forEach((x, i) => {
      const rank = (lastScore !== null && x.n === lastScore) ? lastRank : i + 1;
      rankOf[x.id] = rank;
      lastScore = x.n;
      lastRank = rank;
    });

    const withRank = marked.map(r => ({
      ...r,
      rankText: rankOf[r._id] ? `第${rankOf[r._id]}` : ''
    }));

    let stats = { entered: 0, avg: '0', max: '0', min: '0', passRate: '0' };
    let buckets = [];
    if (valid.length) {
      const nums = valid.map(x => x.n);
      const sum = nums.reduce((a, b) => a + b, 0);
      const passLine = fullVal * 0.6;
      const passed = nums.filter(n => n >= passLine).length;
      stats = {
        entered: valid.length,
        avg: fmt(sum / valid.length),
        max: fmt(Math.max(...nums)),
        min: fmt(Math.min(...nums)),
        passRate: fmt((passed / valid.length) * 100)
      };
      // 按满分比例分段，适配 100/120/150 分制
      const defs = [
        { label: '优 ≥85%', cls: 'a', lo: 0.85, hi: 1.01 },
        { label: '良 70-85%', cls: 'b', lo: 0.70, hi: 0.85 },
        { label: '及格 60-70%', cls: 'c', lo: 0.60, hi: 0.70 },
        { label: '不及格 <60%', cls: 'd', lo: -1, hi: 0.60 }
      ];
      buckets = defs.map(d => {
        const count = nums.filter(n => {
          const p = n / fullVal;
          return p >= d.lo && p < d.hi;
        }).length;
        return { label: d.label, cls: d.cls, count, pct: Math.round((count / valid.length) * 100) };
      });
    }
    this.setData({ rows: withRank, stats, buckets });
  },

  isSaving() {
    return !!this._busy;
  },

  onExamChange(e) {
    if (this.isSaving()) return;
    this.dirty = {};
    this.setData({ examIndex: Number(e.detail.value) });
    this.rebuild();
  },

  onSubjectChange(e) {
    if (this.isSaving()) return;
    this.dirty = {};
    this.setData({ subjectIndex: Number(e.detail.value) });
    this.rebuild();
  },

  onFullInput(e) {
    if (this.isSaving()) return;
    const v = e.detail.value;
    const raw = String(v || '').trim();
    let why = '';
    if (!raw) why = '请填满分 1-' + validate.SCORE_MAX_FULL;
    else { const w = validate.check('scores', { full: Number(raw) }); if (w) why = w; }
    // 满分非法时不静默按 100 算（真机实测：填空/0 时统计照旧出数，老师不知道基准是啥）
    this.setData({ full: v, fullWarn: why });
    this.recompute();
  },

  onScoreInput(e) {
    if (this.isSaving()) return;
    const id = e.currentTarget.dataset.id;
    const idx = this.data.rows.findIndex(r => r._id === id);
    if (idx < 0) return;
    if (!this.dirty) this.dirty = {};
    this.dirty[id] = true;
    // 定点更新，避免整列表重渲染导致输入框失焦
    this.setData({ [`rows[${idx}].scoreInput`]: e.detail.value });
    this.recompute();
  },

  onEditExam() {
    if (this.isSaving()) return;
    modal.hideTabBar(this);
    this.setData({ showExamForm: true, examInput: this.data.exams[this.data.examIndex] || '' });
  },

  onExamInput(e) {
    this.setData({ examInput: e.detail.value });
  },

  onExamCancel() {
    modal.showTabBar(this);
    this.setData({ showExamForm: false });
  },

  onExamConfirm() {
    if (this.isSaving()) return;
    const name = String(this.data.examInput || '').trim();
    if (!name) {
      wx.showToast({ title: '请填考试名称', icon: 'none' });
      return;
    }
    const exams = this.data.exams.slice();
    let idx = exams.indexOf(name);
    if (idx < 0) {
      exams.unshift(name);
      idx = 0;
    }
    this.dirty = {};
    modal.showTabBar(this);
    this.setData({ exams, examIndex: idx, showExamForm: false });
    this.rebuild();
  },

  async onSave() {
    if (this._busy) return; // 同步标志：setData 异步，连点会穿透
    if (!db.isCloudReady()) {
      wx.showToast({ title: '请先配置云环境', icon: 'none' });
      return;
    }
    // 满分上限走共享规则（原来写死 1000 → 满分填 1000 就能录 1000 分，真机实测已入库）
    const fullVal = Number(this.data.full);
    if (validate.check('scores', { full: fullVal })) {
      wx.showToast({ title: `满分请填 1-${validate.SCORE_MAX_FULL}`, icon: 'none' });
      return;
    }
    const bad = this.data.rows.filter(r => r.invalid);
    if (bad.length) {
      // 报到具体是谁 + 具体为什么（超满分/负数/小数位），老师能直接改；
      // 同时把第一个非法行滚到视野里 —— 淡红底在真机上几乎看不见（真机反馈）
      this.setData({ focusInvalidId: bad[0]._id });
      wx.showToast({
        title: `${bad[0].name}：${bad[0].invalidWhy || '分数不合法'}（共 ${bad.length} 处）`,
        icon: 'none', duration: 2600
      });
      return;
    }
    const dirtyIds = Object.keys(this.dirty || {});
    const toSave = this.data.rows.filter(r => dirtyIds.indexOf(r._id) >= 0);
    if (!toSave.length) {
      wx.showToast({ title: '没有改动需要保存', icon: 'none' });
      return;
    }

    const exam = this.data.exams[this.data.examIndex];
    const subject = this.data.subjects[this.data.subjectIndex];

    this._busy = true;
    this.setData({ saving: true });
    try {
      let saved = 0;
      let cleared = 0;
      for (const r of toSave) {
        const raw = String(r.scoreInput || '').trim();
        if (!raw) {
          // 清空输入 = 删除该条成绩，而不是存 0（0 分和缺考语义不同）
          if (r.scoreId) {
            await db.remove('scores', r.scoreId);
            cleared += 1;
          }
          continue;
        }
        const payload = {
          studentId: r._id,
          exam,
          subject,
          // 与 recompute 同口径：raw 已过 validate（非法值在 onSave 开头就被拦），
          // 这里转数字只是为了入库类型正确
          score: Number(raw),
          full: fullVal,
          date: todayStr()
        };
        // scoreId 是「上次 rebuild 那一刻」的快照。这条成绩若已被别处删掉（另一台设备清空、
        // 云端手删），update 到不存在的文档**不报错也不生效** —— toast 显示「已保存 N 人」，
        // 库里其实什么都没有，成绩静默丢失（2026-09-06 探针实测：先删记录再存 88.5，
        // 提示已保存但云端 0 条）。所以 update 之后回读确认，没生效就降级为 add。
        if (r.scoreId) {
          await db.update('scores', r.scoreId, payload);
          const back = await db.list('scores', { _id: r.scoreId }, 1).catch(() => []);
          if (!back.length) await db.add('scores', payload);
        } else {
          await db.add('scores', payload);
        }
        saved += 1;
        delete this.dirty[r._id];
      }
      const msg = cleared ? `保存 ${saved} 人，清除 ${cleared} 条` : `已保存 ${saved} 人`;
      wx.showToast({ title: msg, icon: 'success' });
      // 重新拉云端，回填 scoreId 避免下次保存重复插入
      this.allScores = await db.list('scores', {}, 2000, { orderBy: [['updatedAt', 'desc']] });
      this.dirty = {};
      this.rebuild();
    } catch (e) {
      console.error('save scores error', e);
      // db 层的范围兜底会抛 validation 错：直接把原因给老师，不要笼统「保存失败」
      wx.showToast({ title: e && e.validation ? e.message : '保存失败', icon: 'none', duration: 2600 });
    } finally {
      this._busy = false;
      this.setData({ saving: false });
    }
  },

  // ============ AI 拍照/选图录成绩 ============
  async onAiPhoto() {
    if (this.isSaving()) return;
    if (!db.isCloudReady()) {
      wx.showToast({ title: '请先配置云环境', icon: 'none' });
      return;
    }
    let media;
    try {
      media = await wx.chooseMedia({
        count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed']
      });
    } catch (e) { return; } // 用户取消
    const file = media.tempFiles && media.tempFiles[0];
    if (!file) return;
    if (this.isSaving()) return;
    const tempPath = file.tempFilePath;

    wx.showLoading({ title: '识别中…', mask: true });
    try {
      const ext = (tempPath.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z]/g, '') || 'jpg';
      const up = await wx.cloud.uploadFile({
        cloudPath: `scores/ai_${Date.now()}.${ext}`,
        filePath: tempPath
      });
      const exam = this.data.exams[this.data.examIndex];
      const subject = this.data.subjects[this.data.subjectIndex];
      const res = await wx.cloud.callFunction({
        name: 'ocrScore',
        data: { fileID: up.fileID, examName: exam, subject }
      });
      const r = res.result || {};
      if (r.code === 0) {
        this.applyAiRows(r.data && r.data.rows ? r.data.rows : []);
      } else if (r.code === 5001) {
        // 没配密钥：直接给手动兜底
        wx.showToast({ title: '未配置密钥，已打开粘贴录入', icon: 'none' });
        modal.hideTabBar(this);
        this.setData({ aiPasteShow: true });
      } else {
        wx.showToast({ title: r.message || '识别失败', icon: 'none' });
      }
    } catch (e) {
      console.error('ocrScore error', e);
      wx.showToast({ title: '识别失败，可改用粘贴文本', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  // 照片识别结果 / 粘贴文本 → 匹配名单并填入选中行
  applyAiRows(rawRows) {
    if (this.isSaving()) return;
    const students = this.students || [];
    if (!students.length) {
      wx.showToast({ title: '请先添加学生名单', icon: 'none' });
      return;
    }
    const matched = new Set();
    const unmatched = [];
    const newRows = this.data.rows.map(r => {
      // 保留非 AI 已填的原有输入
      if (!r.ai) return { ...r, ai: false, aiLow: false };
      return { ...r, ai: false, aiLow: false };
    });
    const byId = {};
    newRows.forEach(r => { byId[r._id] = r; });

    (rawRows || []).forEach(item => {
      const name = String(item.name || '').trim();
      const score = item.score === null || item.score === undefined || item.score === '' ? null : Number(item.score);
      if (!name) return;
      const stu = this.fuzzyMatch(name, students);
      if (!stu) { unmatched.push(name); return; }
      const row = byId[stu._id];
      if (!row) return;
      if (row.ai) return; // 同一批识别里该生已匹配过，跳过重复名（防 OCR 把同一人读出两个近似名互相覆盖）
      matched.add(stu._id);
      row.ai = true;
      if (score === null || Number.isNaN(score)) {
        row.aiLow = true; // 识别到名字但分数看不清，标黄提醒
      } else {
        row.scoreInput = String(score);
        row.aiLow = false;
      }
      if (!this.dirty) this.dirty = {};
      this.dirty[stu._id] = true;
    });

    let note = `已从照片/文本匹配 ${matched.size} 人`;
    if (unmatched.length) note += `；未匹配：${unmatched.join('、')}`;
    if (!matched.size && !unmatched.length) note = '没有解析到有效姓名-分数';
    this.setData({ rows: newRows, aiNote: note });
    this.recompute();
  },

  onClearAi() {
    if (this.isSaving()) return;
    const newRows = this.data.rows.map(r => ({ ...r, ai: false, aiLow: false }));
    this.setData({ rows: newRows, aiNote: '' });
    this.recompute();
  },

  // 编辑距离模糊匹配（错别字/漏字也能对上）
  fuzzyMatch(name, students) {
    let exact = null, best = null, bestD = 99;
    for (const s of students) {
      if (s.name === name) { exact = s; break; }
      const d = this.levenshtein(name, s.name);
      const tol = s.name.length <= 3 ? 1 : 2;
      if (d <= tol && d < bestD) { best = s; bestD = d; }
    }
    return exact || best;
  },

  levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      }
    }
    return dp[m][n];
  },

  // ============ 粘贴文本兜底（无需密钥）============
  onPasteTap() {
    if (this.isSaving()) return;
    modal.hideTabBar(this);
    this.setData({ aiPasteShow: true });
  },
  onPasteCancel() {
    modal.showTabBar(this);
    this.setData({ aiPasteShow: false });
  },
  onPasteInput(e) { this.setData({ aiPasteText: e.detail.value }); },
  onPasteConfirm() {
    if (this.isSaving()) return;
    const text = String(this.data.aiPasteText || '').trim();
    if (!text) { wx.showToast({ title: '请先粘贴文本', icon: 'none' }); return; }
    const rows = [];
    text.split(/\r?\n/).forEach(line => {
      const t = line.trim();
      if (!t) return;
      const parts = t.split(/\s+/);
      if (parts.length < 2) return;
      const last = parts[parts.length - 1];
      const score = /^\d+(\.\d+)?$/.test(last) ? Number(last) : null;
      const name = score === null ? t : parts.slice(0, -1).join(' ');
      if (name) rows.push({ name: name.trim(), score });
    });
    if (!rows.length) {
      wx.showToast({ title: '没解析到「姓名 分数」', icon: 'none' });
      return;
    }
    modal.showTabBar(this);
    this.setData({ aiPasteShow: false, aiPasteText: '' });
    this.applyAiRows(rows);
  }
});
