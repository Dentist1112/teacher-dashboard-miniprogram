const db = require('../../utils/db.js');
const classinfo = require('../../utils/classinfo.js');
const kb = require('../../utils/kb.js');
const modal = require('../../utils/modal.js');

Page({
  // 弹层内容区吞掉 tap，避免冒泡到 mask 的取消处理器把弹层关掉
  // （原来写 catchtap="" 空处理器，实测不生效：点输入框 showForm 直接变 false）
  noop() {},

  data: {
    students: [],
    loading: true,
    classTitle: '',
    cloudReady: false,
    showForm: false,
    isEdit: false,
    form: { _id: '', studentNo: '', name: '', gender: '男' },
    genders: ['男', '女'],
    genderIndex: 0,
    saving: false,

    // ===== 拍照导名单（AI 识别 → 确认表 → 批量写入）=====
    // 识别结果绝不直接落库：AI 读错一个字，后面考勤/成绩/座位全挂在错人身上。
    // 必须经这张确认表让老师逐行看过、可改可删，再批量写。
    aiShow: false,          // 确认表弹层
    aiRows: [],             // [{ key, name, no, dup, skip }]
    aiStartNo: '',          // 起始学号（自动递增分配，AI 不猜学号）
    aiImporting: false,

    // ===== 粘贴名单（零密钥兜底）=====
    // 拍照识别要老师自己申请视觉模型密钥（探针实测未配密钥时云函数返回 5001），
    // 微信官方 OCR 又需要付费开通额度（实测报 not enough market quota）。
    // 老师手上的名单大多能从微信群/Excel 里复制出来 —— 粘一次比拍照更快也不花钱。
    pasteShow: false,
    pasteText: '',

    // ===== 批量管理（内测反馈：新老师要逐个删掉演示学生才能录自己班，太累）=====
    batchMode: false,
    selectedMap: {},     // { [studentId]: true }，WXML 不能用 Set
    selectedCount: 0
  },

  onLoad() {
    kb.bind(this);   // 键盘弹起时把弹层底部操作条顶上来（fixed 弹层不受 adjust-position 影响）
    this.setData({ cloudReady: db.isCloudReady() });
    this.loadClassTitle();
    this.refresh();
    this.watcher = db.watch('students', {}, () => this.refresh(), err => {
      console.error('watch students error', err);
    });
  },

  onShow() {
    const tb = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tb) tb.setData({ selected: 1 });
    modal.syncTabBar(this, !!(this.data.showForm || this.data.aiShow || this.data.pasteShow));
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

  async refresh() {
    this.setData({ loading: true });
    try {
      const list = await db.list('students', {}, 500, { orderBy: [['studentNo', 'asc']] });
      // initial 只用于列表首字圆标（同质记录的扫视锚点），纯展示字段，不入库
      this.setData({
        students: list.map(s => ({ ...s, initial: String(s.name || '?').trim().slice(0, 1) })),
        loading: false
      });
    } catch (e) {
      console.error('refresh students error', e);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  onAdd() {
    modal.hideTabBar(this);
    this.setData({
      showForm: true,
      isEdit: false,
      form: { _id: '', studentNo: '', name: '', gender: '男' },
      genderIndex: 0
    });
  },

  onEdit(e) {
    if (this.isSaving()) return;
    modal.hideTabBar(this);
    const id = e.currentTarget.dataset.id;
    const stu = this.data.students.find(s => s._id === id);
    if (!stu) return;
    this.setData({
      showForm: true,
      isEdit: true,
      form: {
        _id: stu._id,
        studentNo: stu.studentNo || '',
        name: stu.name || '',
        gender: stu.gender || '男'
      },
      genderIndex: Math.max(0, this.data.genders.indexOf(stu.gender || '男'))
    });
  },

  onProfile(e) {
    // 带 id 直达单人档案，省得老师进去再找一遍
    wx.navigateTo({ url: '/pages/profile/profile?id=' + e.currentTarget.dataset.id });
  },

  onGenderChange(e) {
    const idx = Number(e.detail.value);
    this.setData({
      genderIndex: idx,
      'form.gender': this.data.genders[idx]
    });
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  onFormCancel() {
    modal.showTabBar(this);
    this.setData({ showForm: false });
  },

  isSaving() {
    return !!this._busy;
  },

  async onFormSave() {
    if (this._busy) return;
    if (!db.isCloudReady()) {
      wx.showToast({ title: '请先配置云环境', icon: 'none' });
      return;
    }
    const { studentNo, name, gender } = this.data.form;
    if (!String(studentNo || '').trim()) {
      wx.showToast({ title: '请填学号', icon: 'none' });
      return;
    }
    if (!String(name || '').trim()) {
      wx.showToast({ title: '请填姓名', icon: 'none' });
      return;
    }
    // 学号/姓名规则（探针实测：200 位纯数字学号、200 字姓名、'5 5' 都能入库；
    // 超长学号还会把 AI 名单的起始学号污染成 '1e+200'）
    const why = db.validate.check('students', { studentNo: String(studentNo).trim(), name: String(name).trim() });
    if (why) {
      wx.showToast({ title: why, icon: 'none', duration: 2600 });
      return;
    }
    this._busy = true;
    this.setData({ saving: true });
    try {
      const no = String(studentNo).trim();
      // 学号重复会让考勤/成绩挂错人，保存前查一次
      const dup = this.data.students.filter(s => String(s.studentNo || '').trim() === no && s._id !== this.data.form._id);
      if (dup.length) {
        this.setData({ saving: false });
        this._busy = false;
        wx.showToast({ title: `学号 ${no} 已被 ${dup[0].name} 占用`, icon: 'none', duration: 2500 });
        return;
      }
      const payload = {
        studentNo: no,
        name: String(name).trim(),
        gender: gender || '男'
      };
      if (this.data.isEdit) {
        await db.update('students', this.data.form._id, payload);
        wx.showToast({ title: '已更新', icon: 'success' });
      } else {
        await db.add('students', { ...payload, birth: '', parent: '', health: '', tags: [] });
        wx.showToast({ title: '已添加', icon: 'success' });
      }
      modal.showTabBar(this);
      this.setData({ showForm: false, saving: false });
      await this.refresh().catch(() => {});
    } catch (e) {
      console.error('save student error', e);
      this.setData({ saving: false });
      wx.showToast({ title: e && e.validation ? e.message : '保存失败', icon: 'none', duration: 2600 });
    } finally {
      this._busy = false;
    }
  },

  /* ==================== 拍照导名单（AI） ====================
   * 链路：选图 → 上传云存储 → ocrScore(mode=roster) → 确认表 → 逐行核对 → 批量写入
   * 三条铁律（都是本项目踩过的坑推导出来的）：
   *   1) AI 只出姓名，学号由本地按「起始号 + 递增」分配 —— 学号是考勤/成绩/座位的
   *      外键，AI 把 03 读成 08 会静默挂错人，而姓名读错老师一眼能看出来。
   *   2) 识别结果先进确认表，老师点过「导入」才写库。绝不自动落库。
   *   3) 写入前必须查重（与云端已有 + 本批次内），学号重复会让考勤挂错人
   *      （roster 单条保存早就有这道校验，批量导入不能绕过去）。
   */
  async onAiPhoto() {
    // guard 与置位之间不许有 await（check.js [BUSY] 会拦）：
    // 中间插 await 的话第二次点击能从缝里穿过去 → 传两张图、烧两次 AI 额度。
    if (this._busy) return;
    this._busy = true;
    if (!db.isCloudReady()) {
      this._busy = false;
      wx.showToast({ title: '请先配置云环境', icon: 'none' });
      return;
    }
    let media;
    try {
      media = await wx.chooseMedia({
        count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed']
      });
    } catch (e) { this._busy = false; return; }   // 用户取消，不是错误
    const file = media && media.tempFiles && media.tempFiles[0];
    if (!file) { this._busy = false; return; }

    wx.showLoading({ title: '识别中…', mask: true });
    try {
      const ext = (String(file.tempFilePath).split('.').pop() || 'jpg')
        .toLowerCase().replace(/[^a-z]/g, '') || 'jpg';
      const up = await wx.cloud.uploadFile({
        cloudPath: `roster/ai_${Date.now()}.${ext}`,
        filePath: file.tempFilePath
      });
      const res = await wx.cloud.callFunction({
        name: 'ocrScore',
        data: { fileID: up.fileID, mode: 'roster' }
      });
      const r = (res && res.result) || {};
      wx.hideLoading();
      if (r.code === 0) {
        this.openAiConfirm((r.data && r.data.rows) || []);
      } else if (r.code === 5001) {
        // 拍照识别要老师自己申请视觉模型密钥（探针实测：未配密钥云函数返回 5001），
        // 别把人推去申请 API Key —— 直接打开粘贴名单，一样一次导入整班。
        wx.showModal({
          title: '拍照识别未开通',
          content: '拍照识别需要先在「数据设置」里填视觉模型密钥。更快的办法：直接粘贴名单（从微信群/Excel 复制即可）。',
          confirmText: '粘贴名单',
          cancelText: '知道了',
          success: res => { if (res.confirm) { modal.hideTabBar(this); this.setData({ pasteShow: true, pasteText: '' }); } }
        });
      } else {
        wx.showToast({ title: r.message || '识别失败', icon: 'none' });
      }
    } catch (e) {
      wx.hideLoading();
      console.error('roster ocr error', e);
      wx.showToast({ title: '识别失败，试试「粘贴名单」', icon: 'none', duration: 2400 });
    } finally {
      this._busy = false;
    }
  },

  // 识别结果 → 确认表。学号在这里本地分配，不用 AI 的
  openAiConfirm(rows) {
    const names = (rows || []).map(r => String(r.name || '').trim()).filter(Boolean);
    if (!names.length) {
      modal.showTabBar(this);
      wx.showModal({
        title: '没认出学生姓名',
        content: '换一张更清楚的照片再试，或手动添加。',
        showCancel: false
      });
      return;
    }
    // 起始学号：接着云端现有最大数字学号往下排（没有就从 1 开始）
    // 只认「长度合规的纯数字学号」：历史脏数据里的 200 位学号会让 parseInt 得到 1e+200，
    // 起始号变成 '1e+200'，后面分配出 '1200' 这种错号（2026-09-06 探针实测）
    const nums = (this.data.students || [])
      .map(s => db.validate.strictInt(String(s.studentNo || '').replace(/\D/g, '')))
      .filter(n => n !== null && n >= 0 && n < 100000);
    const start = (nums.length ? Math.max.apply(null, nums) : 0) + 1;
    modal.hideTabBar(this);
    this.setData({ aiShow: true, aiStartNo: String(start) });
    this.rebuildAiRows(names.map(n => ({ name: n })));
  },

  // 唯一渲染入口：aiRows 全从 (names, startNo, 云端名单) 重算，
  // 保证「屏幕上显示的」和「将要写入的」永远同源（本项目立过这条规矩）
  rebuildAiRows(seed) {
    const src = seed || this.data.aiRows || [];
    const start = db.validate.strictInt(String(this.data.aiStartNo || '').replace(/\D/g, ''));
    const base = start !== null && start > 0 && start < 100000 ? start : 1;
    const cloudNos = new Set((this.data.students || []).map(s => String(s.studentNo || '').trim()));
    const usedInBatch = new Set();
    let seq = 0;
    const rows = src.map((r, i) => {
      const name = String(r.name || '').trim();
      const skip = !!r.skip;
      let no = '';
      let dup = '';
      if (!skip) {
        // 学号只分配给未跳过的行，跳过的不占号（否则删一行会在学号里留空洞）
        no = String(base + seq);
        seq += 1;
        if (cloudNos.has(no)) dup = '学号已存在';
        else if (usedInBatch.has(no)) dup = '本批重复';
        else usedInBatch.add(no);
      }
      return { key: 'r' + i, name, no, dup, skip };
    });
    const willImport = rows.filter(r => !r.skip && r.name && !r.dup).length;
    const conflicts = rows.filter(r => !r.skip && r.dup).length;
    this.setData({ aiRows: rows, aiWillImport: willImport, aiConflicts: conflicts });
  },

  onAiStartNoInput(e) {
    if (this.isSaving()) return;
    this.setData({ aiStartNo: e.detail.value });
    this.rebuildAiRows();
  },

  onAiNameInput(e) {
    if (this.isSaving()) return;
    const i = Number(e.currentTarget.dataset.i);
    const rows = (this.data.aiRows || []).slice();
    if (!rows[i]) return;
    rows[i] = Object.assign({}, rows[i], { name: e.detail.value });
    this.setData({ aiRows: rows });
    this.rebuildAiRows(rows);
  },

  // 跳过/恢复某一行（不是删除数组元素：删了学号会整体错位，老师核对不下去）
  onAiToggleSkip(e) {
    if (this.isSaving()) return;
    const i = Number(e.currentTarget.dataset.i);
    const rows = (this.data.aiRows || []).slice();
    if (!rows[i]) return;
    rows[i] = Object.assign({}, rows[i], { skip: !rows[i].skip });
    this.rebuildAiRows(rows);
  },

  // ===== 粘贴名单：一行一个名字，也兼容「1 张三 男 138…」这种整行粘贴 =====
  onPasteTap() {
    if (this.isSaving()) return;
    modal.hideTabBar(this);
    this.setData({ pasteShow: true, pasteText: '' });
  },
  onPasteCancel() {
    modal.showTabBar(this);
    this.setData({ pasteShow: false, pasteText: '' });
  },
  onPasteInput(e) { this.setData({ pasteText: e.detail.value }); },

  // 纯函数，好单测：从粘贴文本里抠出姓名列表。
  // 规则和 ocrScore 的 roster parser 同源（表头/纯数字/超长行/重复都要剔）。
  //
  // 难点是「一行到底是一个人还是多个人」，靠三步判定（都是变异测试逼出来的）：
  //   1) 先按分隔符切开，若切出 ≥2 个都合法且都 ≥2 字的姓名 → 这行是多人
  //      （「张三、李四、王五」「张三  李四」）
  //   2) 否则整行去空白后当一个姓名试（「张 三」→「张三」，单字切片不算多人）
  //   3) 整行太长/不合法（「1 张三 男 13800001111」去空白后 15 字）→ 退回切片结果
  //      早期版本只按 \s{2,} 切，单空格整行直接被判超长丢掉，整行学生凭空消失。
  parsePasteNames(text) {
    const HEADERS = ['姓名', '学生姓名', '名字', '学生', '序号', '学号', '班级', '性别', '备注', '合计', '小计'];
    const clean = raw => {
      let n = String(raw || '').replace(/[\s\u3000]+/g, '')
        .replace(/^[「『（(【\[]+|[」』）)】\]]+$/g, '');
      return n.replace(/^\d+[.、．)）]?/, '');     // 「1.张三」「01 张三」剥前缀序号
    };
    const okName = n => {
      if (!n) return false;
      if (HEADERS.indexOf(n) >= 0) return false;
      if (n === '男' || n === '女') return false;
      if (n.length > 12) return false;             // 中文姓名不会超 12 字，超了必是整行
      return /[\u4e00-\u9fa5a-zA-Z]/.test(n);      // 纯数字（学号/手机号）/符号不是姓名
    };
    const seen = new Set();
    const out = [];
    const push = n => { if (!seen.has(n)) { seen.add(n); out.push(n); } };
    String(text || '').split(/\r?\n/).forEach(line => {
      const cells = line.split(/[\t,，、;；]+|\s+/).map(clean).filter(okName);
      if (cells.length >= 2 && cells.every(n => n.length >= 2)) {
        cells.forEach(push);                       // 这行是多人
        return;
      }
      const whole = clean(line);
      if (okName(whole)) { push(whole); return; }  // 这行是一个人（含「张 三」）
      cells.forEach(push);                         // 整行不合法 → 用切片
    });
    return out;
  },

  onPasteConfirm() {
    if (this.isSaving()) return;
    const names = this.parsePasteNames(this.data.pasteText);
    if (!names.length) {
      wx.showToast({ title: '没解析到姓名，一行一个试试', icon: 'none', duration: 2400 });
      return;
    }
    this.setData({ pasteShow: false, pasteText: '' });
    // 复用拍照那套确认表：学号本地递增分配 + 查重 + 逐行可改可跳过
    this.openAiConfirm(names.map(n => ({ name: n })));
  },

  onAiCancel() {
    if (this.isSaving()) return;
    modal.showTabBar(this);
    this.setData({ aiShow: false, aiRows: [], aiWillImport: 0, aiConflicts: 0 });
  },

  async onAiImport() {
    if (this._busy) return;                    // this.data.aiImporting 是异步的，防不住同 tick 连点
    const rows = (this.data.aiRows || []).filter(r => !r.skip && r.name && !r.dup);
    if (!rows.length) {
      wx.showToast({ title: '没有可导入的行', icon: 'none' });
      return;
    }
    this._busy = true;
    this.setData({ aiImporting: true });
    wx.showLoading({ title: `导入 ${rows.length} 人…`, mask: true });
    try {
      // 分批并发：串行 30 条太慢，一次全并发会撞云函数并发上限（课表保存同款做法）
      let done = 0;
      for (let i = 0; i < rows.length; i += 10) {
        const batch = rows.slice(i, i + 10);
        await Promise.all(batch.map(r => db.add('students', {
          studentNo: r.no,
          name: r.name,
          gender: '男',          // AI 不认性别，统一给默认值，老师后续在档案页改
          birth: '', parent: '', health: '', tags: []
        })));
        done += batch.length;
      }
      wx.hideLoading();
      wx.showToast({ title: `已导入 ${done} 人`, icon: 'success' });
      modal.showTabBar(this);
      this.setData({ aiShow: false, aiRows: [], aiWillImport: 0, aiConflicts: 0 });
      await this.refresh().catch(() => {});
    } catch (e) {
      wx.hideLoading();
      console.error('roster ai import error', e);
      wx.showToast({ title: '导入失败', icon: 'none' });
    } finally {
      this._busy = false;
      this.setData({ aiImporting: false });
    }
  },

  // 学生被哪些集合引用：单个删和批量删共用同一份额定，漏一处就留孤儿
  cascadeRefs() {
    return [
      { collection: 'attendance', field: 'studentId' },
      { collection: 'rewards', field: 'studentId' },
      { collection: 'contacts', field: 'studentId' },
      { collection: 'scores', field: 'studentId' },
      { collection: 'homeworkSubmit', field: 'studentId' },
      { collection: 'seats', field: 'studentId' },
      { collection: 'dutySchedule', field: 'studentId' },
      { collection: 'committee', field: 'studentId' }
    ];
  },

  onToggleBatch() {
    if (this.isSaving()) return;
    const next = !this.data.batchMode;
    this.setData({ batchMode: next, selectedMap: {}, selectedCount: 0 });
  },

  // 批量模式下点整行 = 勾选；普通模式 = 编辑（原 onEdit）
  onRowTap(e) {
    if (this.isSaving()) return;
    if (this.data.batchMode) this.onToggleSelect(e);
    else this.onEdit(e);
  },

  onToggleSelect(e) {
    if (this.isSaving() || !this.data.batchMode) return;
    const id = e.currentTarget.dataset.id;
    const map = Object.assign({}, this.data.selectedMap);
    if (map[id]) delete map[id]; else map[id] = true;
    this.setData({ selectedMap: map, selectedCount: Object.keys(map).length });
  },

  onSelectAll() {
    if (this.isSaving()) return;
    const map = {};
    this.data.students.forEach(s => { map[s._id] = true; });
    this.setData({ selectedMap: map, selectedCount: this.data.students.length });
  },

  onSelectNone() {
    if (this.isSaving()) return;
    this.setData({ selectedMap: {}, selectedCount: 0 });
  },

  // 删除一批学生（含级联）。分批 4 人并发，避免一次性几十条级联查询撞云限流。
  async deleteStudents(ids, label) {
    if (this._busy) return;
    if (!db.isCloudReady()) { wx.showToast({ title: '请先配置云环境', icon: 'none' }); return; }
    if (!ids.length) return;
    this._busy = true;
    wx.showLoading({ title: `删除中 0/${ids.length}`, mask: true });
    try {
      const refs = this.cascadeRefs();
      let done = 0;
      for (let i = 0; i < ids.length; i += 4) {
        const batch = ids.slice(i, i + 4);
        await Promise.all(batch.map(id => db.removeCascade('students', id, refs).catch(err => {
          console.error('batch remove cascade error', id, err);
          throw err;
        })));
        done += batch.length;
        wx.showLoading({ title: `删除中 ${done}/${ids.length}`, mask: true });
      }
      wx.hideLoading();
      wx.showToast({ title: `已删除 ${done} 人`, icon: 'success' });
      this.setData({ selectedMap: {}, selectedCount: 0 });
      await this.refresh().catch(() => {});
    } catch (e) {
      wx.hideLoading();
      console.error('batch delete students error', e);
      wx.showToast({ title: '部分删除失败，请重试', icon: 'none' });
      await this.refresh().catch(() => {});
    } finally {
      this._busy = false;
    }
  },

  onBatchDelete() {
    if (this.isSaving()) return;
    const ids = Object.keys(this.data.selectedMap);
    if (!ids.length) { wx.showToast({ title: '还没勾选学生', icon: 'none' }); return; }
    wx.showModal({
      title: '删除所选学生',
      content: `将删除 ${ids.length} 名学生及其考勤、成绩、作业、座位、奖惩等全部记录，不可恢复。确定继续？`,
      confirmText: '删除 ' + ids.length + ' 人',
      confirmColor: '#B9412E',
      success: res => {
        if (!res.confirm || this.isSaving()) return;
        this.deleteStudents(ids, '批量删除');
      }
    });
  },

  onClearAll() {
    if (this.isSaving()) return;
    const all = this.data.students;
    if (!all.length) { wx.showToast({ title: '名单本来就是空的', icon: 'none' }); return; }
    wx.showModal({
      title: '清空全班名单',
      content: `将删除全部 ${all.length} 名学生及相关的考勤、成绩、作业、座位、奖惩等记录，不可恢复。建议只在第一次替换成你自己班级时使用。`,
      confirmText: '清空 ' + all.length + ' 人',
      confirmColor: '#B9412E',
      success: r1 => {
        if (!r1.confirm || this.isSaving()) return;
        // 二次确认：这是全班级破坏性操作，误触代价极大
        wx.showModal({
          title: '再次确认',
          content: '真的要清空整个班级吗？此操作无法撤销。',
          confirmText: '我确定清空',
          confirmColor: '#B9412E',
          success: r2 => {
            if (!r2.confirm || this.isSaving()) return;
            this.deleteStudents(all.map(s => s._id), '清空全班');
          }
        });
      }
    });
  },

  onDelete(e) {
    if (this._busy) return;
    if (!db.isCloudReady()) {
      wx.showToast({ title: '请先配置云环境', icon: 'none' });
      return;
    }
    const id = e.currentTarget.dataset.id;
    const stu = this.data.students.find(s => s._id === id);
    if (!stu) return;
    wx.showModal({
      title: '删除确认',
      content: `确定删除 ${stu.name}（${stu.studentNo}）吗？`,
      confirmColor: '#B9412E',
      success: res => {
        if (!res.confirm || this.isSaving()) return;
        this._busy = true;
        wx.showLoading({ title: '删除中…', mask: true });
        // 级联删：只删 students 会留下孤儿考勤/奖惩，概览页会显示「已删除学生」
        // ⚠️ 每加一个引用 studentId 的集合，这里必须同步加，否则留孤儿
        // （实测事故：漏了 homeworkSubmit，删 1 个学生留下 3 条孤儿收交记录）
        db.removeCascade('students', id, this.cascadeRefs()).then(() => {
          wx.hideLoading();
          wx.showToast({ title: '已删除', icon: 'success' });
          return this.refresh();
        }).catch(err => {
          wx.hideLoading();
          console.error('remove student error', err);
          wx.showToast({ title: '删除失败', icon: 'none' });
        }).then(() => { this._busy = false; });
      }
    });
  }
});
