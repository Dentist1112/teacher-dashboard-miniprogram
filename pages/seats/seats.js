const db = require('../../utils/db.js');
const classinfo = require('../../utils/classinfo.js');

// 选择器里绝不能出现中文（会让整份 wxss 编译失败），性别统一映射成 ASCII
const GCLS = { '男': 'male', '女': 'female' };
const COLS_OPTIONS = [4, 5, 6, 7, 8];
const DEFAULT_COLS = 6;
const COLS_KEY = 'seats_cols';   // 自动列数的本地兜底偏好；老师手动设置后以 classInfo 为准
const MAX_ROWS = 12;             // 教室行数现实上限
const MAX_COLS = 10;            // 教室列数现实上限
const clampDims = (v, max) => Math.max(1, Math.min(max, Math.round(v)));

// 「没有记录 = 未排座」，和作业页「未交不存记录」同一套语义
function cellOf(row, col, stu) {
  return {
    row,
    col,
    key: row + '-' + col,
    studentId: stu ? stu._id : '',
    studentNo: stu ? stu.studentNo : '',
    name: stu ? stu.name : '',
    gcls: stu ? (GCLS[stu.gender] || 'male') : '',
    empty: !stu,
    sel: false
  };
}

Page({
  data: {
    loading: true,
    cloudReady: false,
    classTitle: '',

    cols: DEFAULT_COLS,
    rows: 1,
    colsOptions: COLS_OPTIONS,
    colsIndex: COLS_OPTIONS.indexOf(DEFAULT_COLS),
    capWarn: false,              // 座位总数 < 人数时提示

    grid: [],                    // [[cell,...],...]
    unseated: [],                // 未排座学生（按学号）
    overview: { total: 0, seated: 0, unseated: 0, seatCount: 0 },

    selKey: '',                  // 已选中的座位（点第二个座位就交换）
    pickedId: '',                // 从未排座名单里挑中的学生（再点座位落座）
    pickedName: '',
    dirtyFlag: false,            // 仅用于 UI 提示，判定逻辑走 this.dirty
    saving: false
  },

  onLoad() {
    this.setData({ cloudReady: db.isCloudReady() });
    this.loadClassTitle();
    this.dirty = false;
    this.fixedRows = 0;   // 0 = 行数自动（按人数/已占座推算）
    this.fixedCols = 0;   // 0 = 列数自动
    this.layoutReady = this.initLayout();
    this.layoutReady.then(() => this.refresh());
    // watch 只在没有未保存改动时刷新，否则会冲掉老师刚拖好的座位（考勤页踩过）
    this.watcher = db.watch('seats', {}, () => {
      if (!this.dirty) this.layoutReady.then(() => this.refresh(true));
    }, err => console.error('watch seats error', err));
  },

  // 读取老师为这个教室设置的行×列（存 classInfo，换机同步）
  async initLayout() {
    try {
      const info = await classinfo.get();
      this.fixedRows = classinfo.normLayout(info && info.seatRows, MAX_ROWS);
      this.fixedCols = classinfo.normLayout(info && info.seatCols, MAX_COLS);
    } catch (e) {
      this.fixedRows = 0; this.fixedCols = 0;
    }
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
      const [students, seats] = await Promise.all([
        db.list('students', {}, 500, { orderBy: [['studentNo', 'asc']] }),
        db.list('seats', {}, 500, { orderBy: [['updatedAt', 'asc']] })
      ]);
      this.students = students;
      this.seatRecords = seats;
      this.buildFromCloud();
      this.setData({ loading: false });
    } catch (e) {
      console.error('refresh seats error', e);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  // 云端记录 → 网格。脏数据（孤儿座位/一人多座/一座多人）在这里就地纠正并提示，
  // 不能让它进 UI（否则同一个学生显示在两个格子里，老师照着排会错）
  buildFromCloud() {
    const stuMap = {};
    (this.students || []).forEach(s => { stuMap[s._id] = s; });

    const seen = {};        // studentId → 已采用的记录（一人只能一座）
    const taken = {};       // 'r-c' → studentId（一座只能一人）
    let dropped = 0;
    let maxCol = -1;
    let maxRow = -1;
    (this.seatRecords || []).forEach(rec => {
      const r = Number(rec.row);
      const c = Number(rec.col);
      if (!stuMap[rec.studentId] || !Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0) {
        dropped += 1;                                   // 孤儿或坐标非法
        return;
      }
      const k = r + '-' + c;
      if (seen[rec.studentId] || taken[k]) {
        dropped += 1;                                   // 重复占位，保留先到的
        return;
      }
      seen[rec.studentId] = { row: r, col: c };
      taken[k] = rec.studentId;
      if (c > maxCol) maxCol = c;
      if (r > maxRow) maxRow = r;
    });
    if (dropped) console.warn(`[seats] 忽略 ${dropped} 条无效座位记录（孤儿/重复/坐标非法）`);

    // 列数：老师手动设置（fixedCols）优先；否则以云端数据为准（不截掉已排座位），
    // 没数据时用本地偏好。
    let cols;
    if (this.fixedCols > 0) {
      cols = clampDims(this.fixedCols, MAX_COLS);
    } else {
      cols = maxCol >= 0 ? maxCol + 1 : Number(wx.getStorageSync(COLS_KEY)) || DEFAULT_COLS;
      if (COLS_OPTIONS.indexOf(cols) < 0) cols = Math.max(1, Math.min(MAX_COLS, cols));
    }
    const maxRows = this.fixedRows > 0 ? clampDims(this.fixedRows, MAX_ROWS) : 0;
    const placed = {};      // 'r-c' → student（只放当前行列范围内的；越界学生自动回未排座）
    let overflow = 0;
    Object.keys(seen).forEach(sid => {
      const { row, col } = seen[sid];
      if (col >= cols || (maxRows && row >= maxRows)) { overflow += 1; return; }
      placed[row + '-' + col] = stuMap[sid];
    });
    if (overflow) console.warn(`[seats] ${overflow} 名学生超出 ${maxRows || '自动'} 行 × ${cols} 列，已回到未排座`);
    this.renderGrid(cols, placed, maxRow);
  },

  // placed: 'r-c' → student；maxRow 保证已占用的行不被裁；手动 fixedRows 时严格按设置行数
  renderGrid(cols, placed, maxRow) {
    const total = (this.students || []).length;
    const autoRows = Math.max(1, Math.ceil(total / cols), (maxRow === undefined ? -1 : maxRow) + 1);
    const needRows = this.fixedRows > 0 ? clampDims(this.fixedRows, MAX_ROWS) : autoRows;
    const grid = [];
    const usedIds = {};
    for (let r = 0; r < needRows; r++) {
      const line = [];
      for (let c = 0; c < cols; c++) {
        const stu = placed[r + '-' + c];
        if (stu) usedIds[stu._id] = true;
        line.push(cellOf(r, c, stu));
      }
      grid.push(line);
    }
    const unseated = (this.students || []).filter(s => !usedIds[s._id])
      .map(s => ({ _id: s._id, studentNo: s.studentNo, name: s.name, gcls: GCLS[s.gender] || 'male' }));

    this.setData({
      cols,
      rows: needRows,
      colsIndex: Math.max(0, COLS_OPTIONS.indexOf(cols)),
      capWarn: needRows * cols < total,
      grid,
      unseated,
      selKey: '',
      pickedId: '',
      pickedName: '',
      dirtyFlag: !!this.dirty,
      overview: {
        total,
        seated: Object.keys(usedIds).length,
        unseated: unseated.length,
        seatCount: needRows * cols
      }
    });
  },

  // 从当前 grid 重建（本地改动后调用，不回云端）
  rerenderFromGrid(nextCols) {
    const placed = {};
    let maxRow = -1;
    const cols = nextCols || this.data.cols;
    if (nextCols && nextCols !== this.data.cols) {
      // 换列数：保持阅读顺序重新填充，不然座位会错位
      const seq = [];
      this.data.grid.forEach(line => line.forEach(cell => { if (!cell.empty) seq.push(cell.studentId); }));
      const stuMap = {};
      (this.students || []).forEach(s => { stuMap[s._id] = s; });
      seq.forEach((sid, i) => {
        const r = Math.floor(i / cols);
        const c = i % cols;
        placed[r + '-' + c] = stuMap[sid];
        if (r > maxRow) maxRow = r;
      });
    } else {
      const stuMap = {};
      (this.students || []).forEach(s => { stuMap[s._id] = s; });
      this.data.grid.forEach(line => line.forEach(cell => {
        if (!cell.empty) {
          placed[cell.row + '-' + cell.col] = stuMap[cell.studentId];
          if (cell.row > maxRow) maxRow = cell.row;
        }
      }));
    }
    this.renderGrid(cols, placed, maxRow);
  },

  markDirty() {
    this.dirty = true;
    if (!this.data.dirtyFlag) this.setData({ dirtyFlag: true });
  },

  isSaving() {
    return !!this._busy;
  },

  /* ---------------- 交互 ---------------- */

  onColsChange(e) {
    if (this.isSaving()) return;
    const cols = COLS_OPTIONS[Number(e.detail.value)] || DEFAULT_COLS;
    if (cols === this.data.cols) return;
    this.fixedCols = cols;                 // 老师手动选列后以手动为准，并持久化
    wx.setStorageSync(COLS_KEY, cols);
    this.markDirty();
    this.rerenderFromGrid(cols);
    this.setData({ dirtyFlag: true });
    this.persistLayout();
  },

  // 行×列步进器（内测反馈：每个教室座位排布不同，要能自定义几行几列）
  onRowsStep(e) {
    if (this.isSaving()) return;
    const d = Number(e.currentTarget.dataset.d) || 0;
    const base = this.fixedRows > 0 ? this.fixedRows : this.data.rows;
    const rows = clampDims(base + d, MAX_ROWS);
    if (rows === base && this.fixedRows > 0) return;
    this.fixedRows = rows;
    if (!this.fixedCols) this.fixedCols = this.data.cols;
    this.markDirty();
    this.rerenderFromGrid();   // 列不变：保留原坐标，越界学生回未排座
    this.setData({ dirtyFlag: true });
    this.persistLayout();
  },

  onColsStep(e) {
    if (this.isSaving()) return;
    const d = Number(e.currentTarget.dataset.d) || 0;
    const base = this.fixedCols > 0 ? this.fixedCols : this.data.cols;
    const cols = clampDims(base + d, MAX_COLS);
    if (cols === base && this.fixedCols > 0) return;
    this.fixedCols = cols;
    wx.setStorageSync(COLS_KEY, cols);
    this.markDirty();
    this.rerenderFromGrid(cols);   // 列变：按阅读顺序重排，不错位
    this.setData({ dirtyFlag: true });
    this.persistLayout();
  },

  // 行数恢复自动（按人数/已占座推算）
  onRowsAuto() {
    if (this.isSaving()) return;
    if (!this.fixedRows) return;
    this.fixedRows = 0;
    this.markDirty();
    this.rerenderFromGrid();
    this.persistLayout();
  },

  // 把教室行×列布局存进 classInfo（换机同步）。布局是教室物理配置，独立即时保存，
  // 不和座位分配的 diff 保存混在一起。
  // 连点「行/列 +-」时不能丢布局：写库期间再来的改动标记 pending，
  // 写完补写最新值（否则云端停在旧行列，换机/重进座位错位）。
  async persistLayout() {
    if (!db.isCloudReady()) return;
    this._layoutPending = true;
    if (this._layoutBusy) return;
    this._layoutBusy = true;
    try {
      while (this._layoutPending) {
        this._layoutPending = false;
        await classinfo.saveLayout(this.fixedRows || 0, this.fixedCols || 0);
        classinfo.clearCache();
      }
    } catch (e) {
      // 保留排队中的最新行列：失败期间老师又点过 +/− 时，下一次 persistLayout 会补存。
      console.error('save seat layout error', e);
      wx.showToast({ title: '行列设置云端同步失败', icon: 'none' });
    } finally {
      this._layoutBusy = false;
    }
  },

  // 点未排座学生：挑中，再点空位落座
  onPickUnseated(e) {
    const id = e.currentTarget.dataset.id;
    const stu = this.data.unseated.find(s => s._id === id);
    if (!stu) return;
    if (this.data.pickedId === id) {
      this.setData({ pickedId: '', pickedName: '' });
      return;
    }
    this.setData({ pickedId: id, pickedName: stu.name, selKey: '' });
    this.clearSel();
  },

  clearSel() {
    const g = this.data.grid;
    const patch = {};
    g.forEach((line, ri) => line.forEach((cell, ci) => {
      if (cell.sel) patch[`grid[${ri}][${ci}].sel`] = false;
    }));
    if (Object.keys(patch).length) this.setData(patch);
  },

  // 点座位：① 手里有挑中的学生 → 落座（原占座者回未排座）
  //        ② 没选中过座位 → 选中
  //        ③ 已选中另一个座位 → 两格互换（含空位，即移动）
  onTapCell(e) {
    if (this.isSaving()) return;
    const { r, c } = e.currentTarget.dataset;
    const ri = Number(r);
    const ci = Number(c);
    const cell = this.data.grid[ri] && this.data.grid[ri][ci];
    if (!cell) return;

    if (this.data.pickedId) {
      this.placePicked(ri, ci);
      return;
    }
    if (!this.data.selKey) {
      this.setData({ [`grid[${ri}][${ci}].sel`]: true, selKey: cell.key });
      return;
    }
    if (this.data.selKey === cell.key) {
      this.setData({ [`grid[${ri}][${ci}].sel`]: false, selKey: '' });
      return;
    }
    this.swapCells(this.data.selKey, cell.key);
  },

  placePicked(ri, ci) {
    const sid = this.data.pickedId;
    const stu = (this.students || []).find(s => s._id === sid);
    if (!stu) return;
    const cell = this.data.grid[ri][ci];
    const kicked = cell.empty ? null : cell.studentId;
    const patch = {
      [`grid[${ri}][${ci}]`]: { ...cellOf(ri, ci, stu), sel: false }
    };
    // 未排座名单：挑中的人出列，被顶掉的人入列（保持学号序）
    let un = this.data.unseated.filter(s => s._id !== sid);
    if (kicked) {
      const k = (this.students || []).find(s => s._id === kicked);
      if (k) un = un.concat([{ _id: k._id, studentNo: k.studentNo, name: k.name, gcls: GCLS[k.gender] || 'male' }]);
    }
    un.sort((a, b) => String(a.studentNo).localeCompare(String(b.studentNo)));
    patch.unseated = un;
    patch.pickedId = '';
    patch.pickedName = '';
    this.setData(patch);
    this.markDirty();
    this.recount();
  },

  swapCells(keyA, keyB) {
    const find = k => {
      const [r, c] = k.split('-').map(Number);
      return { r, c, cell: this.data.grid[r] && this.data.grid[r][c] };
    };
    const a = find(keyA);
    const b = find(keyB);
    if (!a.cell || !b.cell) { this.setData({ selKey: '' }); return; }
    const stuMap = {};
    (this.students || []).forEach(s => { stuMap[s._id] = s; });
    this.setData({
      [`grid[${a.r}][${a.c}]`]: { ...cellOf(a.r, a.c, stuMap[b.cell.studentId]), sel: false },
      [`grid[${b.r}][${b.c}]`]: { ...cellOf(b.r, b.c, stuMap[a.cell.studentId]), sel: false },
      selKey: ''
    });
    this.markDirty();
    this.recount();
  },

  // 长按座位：把这个人移出座位（回未排座）
  onClearCell(e) {
    if (this.isSaving()) return;
    const ri = Number(e.currentTarget.dataset.r);
    const ci = Number(e.currentTarget.dataset.c);
    const cell = this.data.grid[ri] && this.data.grid[ri][ci];
    if (!cell || cell.empty) return;
    const stu = (this.students || []).find(s => s._id === cell.studentId);
    const un = this.data.unseated.concat(stu
      ? [{ _id: stu._id, studentNo: stu.studentNo, name: stu.name, gcls: GCLS[stu.gender] || 'male' }] : []);
    un.sort((a, b) => String(a.studentNo).localeCompare(String(b.studentNo)));
    this.setData({
      [`grid[${ri}][${ci}]`]: cellOf(ri, ci, null),
      unseated: un,
      selKey: ''
    });
    this.markDirty();
    this.recount();
    wx.showToast({ title: `${cell.name} 已移出座位`, icon: 'none' });
  },

  recount() {
    let seated = 0;
    this.data.grid.forEach(line => line.forEach(cell => { if (!cell.empty) seated += 1; }));
    this.setData({
      overview: {
        total: (this.students || []).length,
        seated,
        unseated: this.data.unseated.length,
        seatCount: this.data.rows * this.data.cols
      }
    });
  },

  // 按学号顺序铺满
  onFillByNo() {
    if (this.isSaving()) return;
    const stuMap = {};
    const placed = {};
    let maxRow = -1;
    (this.students || []).forEach((s, i) => {
      stuMap[s._id] = s;
      const r = Math.floor(i / this.data.cols);
      const c = i % this.data.cols;
      placed[r + '-' + c] = s;
      if (r > maxRow) maxRow = r;
    });
    this.markDirty();
    this.renderGrid(this.data.cols, placed, maxRow);
    this.setData({ dirtyFlag: true });
    wx.showToast({ title: '已按学号排好', icon: 'none' });
  },

  // 随机排（Fisher-Yates，不要用 sort(() => Math.random()-0.5)，分布是偏的）
  onShuffle() {
    if (this.isSaving()) return;
    const arr = (this.students || []).slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    const placed = {};
    let maxRow = -1;
    arr.forEach((s, i) => {
      const r = Math.floor(i / this.data.cols);
      const c = i % this.data.cols;
      placed[r + '-' + c] = s;
      if (r > maxRow) maxRow = r;
    });
    this.markDirty();
    this.renderGrid(this.data.cols, placed, maxRow);
    this.setData({ dirtyFlag: true });
    wx.showToast({ title: '已随机排座', icon: 'none' });
  },

  onClearAll() {
    if (this.isSaving()) return;
    if (this.data.overview.seated === 0) {
      wx.showToast({ title: '本来就没排座', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '清空座位表',
      content: `会把 ${this.data.overview.seated} 名学生全部移出座位（需点保存才会同步到云端）`,
      confirmColor: '#B9412E',
      success: res => {
        if (!res.confirm) return;
        if (this.isSaving()) return;
        this.markDirty();
        this.renderGrid(this.data.cols, {}, -1);
        this.setData({ dirtyFlag: true });
      }
    });
  },

  // 保存：diff 后只动变化的记录（全删重插会让 _id 抖动、也更容易半途失败）
  async onSave() {
    if (this._busy) return;              // this.data.saving 是异步的，防不住同 tick 连点
    if (!db.isCloudReady()) {
      wx.showToast({ title: '请先配置云环境', icon: 'none' });
      return;
    }
    const target = {};                   // studentId → {row,col}
    let dup = '';
    this.data.grid.forEach(line => line.forEach(cell => {
      if (cell.empty) return;
      if (target[cell.studentId]) dup = cell.name;   // 同一人出现两次 = 逻辑坏了，别写库
      target[cell.studentId] = { row: cell.row, col: cell.col };
    }));
    if (dup) {
      wx.showToast({ title: `${dup} 占了两个座位，请检查`, icon: 'none' });
      return;
    }

    const existing = {};
    (this.seatRecords || []).forEach(rec => {
      if (existing[rec.studentId]) return;           // 云端脏数据：一人多条，多的走删除分支
      existing[rec.studentId] = rec;
    });
    const dupRecords = (this.seatRecords || []).filter(rec => existing[rec.studentId] && existing[rec.studentId]._id !== rec._id);

    const adds = [];
    const updates = [];
    Object.keys(target).forEach(sid => {
      const cur = existing[sid];
      if (!cur) adds.push({ studentId: sid, ...target[sid] });
      else if (Number(cur.row) !== target[sid].row || Number(cur.col) !== target[sid].col) {
        updates.push({ _id: cur._id, ...target[sid] });
      }
    });
    const removes = Object.keys(existing).filter(sid => !target[sid]).map(sid => existing[sid]._id)
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
      // 分批并发（30+ 条串行太慢）。allSettled：同批单条失败时其余写入可能已落库，
      // 整批 reject + catch 不回读会让 this.seatRecords 停在旧快照，重试按旧基线 diff
      // 把已成功的新增再插一遍（值日页红队实测云端冒出重复文档）。
      const jobs = []
        .concat(adds.map(a => () => db.add('seats', a)))
        .concat(updates.map(u => () => db.update('seats', u._id, { row: u.row, col: u.col })))
        .concat(removes.map(id => () => db.remove('seats', id)));
      const rejected = [];
      for (let i = 0; i < jobs.length; i += 10) {
        const rs = await Promise.allSettled(jobs.slice(i, i + 10).map(f => f()));
        rs.forEach(r => { if (r.status === 'rejected') rejected.push(r.reason); });
      }
      // 成败都回读云端真值锚定 this.seatRecords，只锚定原始记录、不重建座位网格；
      // 再点保存时 diff「本地座位 vs 云端真值」，只补缺/改余，一人多条脏数据顺手清掉。
      this.seatRecords = await db.list('seats', {}, 500, { orderBy: [['updatedAt', 'asc']] });
      if (rejected.length) {
        console.error('save seats partial-fail', rejected.length, rejected[0]);
        this.dirty = true;
        this.setData({ dirtyFlag: true });
        wx.hideLoading();
        wx.showToast({ title: `${rejected.length} 项没存上，再点保存补齐`, icon: 'none' });
        return;
      }
      this.dirty = false;
      wx.hideLoading();
      wx.showToast({ title: `已保存（新增${adds.length}/移动${updates.length}/撤${removes.length}）`, icon: 'success' });
      await this.refresh(true);           // 全成功才重建视图
    } catch (err) {
      // 连回读锚定都失败（弱网）：本地座位必须保留，不许假装成功
      console.error('save seats error', err);
      this.dirty = true;
      this.setData({ dirtyFlag: true });
      wx.hideLoading();
      wx.showToast({ title: '网络异常，座位已保留，请重试', icon: 'none' });
    } finally {
      this._busy = false;
      this.setData({ saving: false });
    }
  }
});
