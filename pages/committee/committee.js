const db = require('../../utils/db.js');
const classinfo = require('../../utils/classinfo.js');

// 岗位是中文，绝不能进 class 名（中文选择器会让整份 wxss 编译失败）——统一映射成 ASCII
const POSTS = [
  '班长', '副班长', '学习委员', '纪律委员', '劳动委员', '文艺委员',
  '体育委员', '宣传委员', '生活委员', '语文科代表', '数学科代表', '英语科代表'
];
const POST_CLS = {
  '班长': 'monitor', '副班长': 'vice', '学习委员': 'study', '纪律委员': 'order',
  '劳动委员': 'labor', '文艺委员': 'arts', '体育委员': 'sports', '宣传委员': 'media',
  '生活委员': 'life', '语文科代表': 'repchn', '数学科代表': 'repmath', '英语科代表': 'repeng'
};
// 核心班委（前 3 个）：空缺时最要紧，单独高亮提醒
const KEY_POSTS = new Set(['班长', '副班长', '学习委员']);
// 一个人兼这么多岗就该提醒了（现实里兼 3 个以上必顾不过来）
const MAX_POSTS_PER_PERSON = 2;
// 同一个岗位最多两位负责人（2026-09-13：一岗一人 → 一岗最多两人）
const MAX_PER_POST = 2;
const SLOTS = POSTS.length;

Page({
  data: {
    loading: true,
    cloudReady: false,
    classTitle: '',
    view: 'list',                 // list=岗位清单 / pick=挑人

    posts: [],                    // [{ post, pcls, isKey, holders:[{studentId,name,studentNo,points}], count, empty, full }]
    // 概览：老师最关心「还有几个岗位空着」和「有没有人被压太多岗」
    overview: { slots: SLOTS, filled: 0, empty: SLOTS, keyEmpty: 0, multi: 0 },
    warnList: [],                 // 告警清单（核心岗空缺 / 一人兼多岗）
    idleList: [],                 // 没担任任何职务的人（按积分降序，方便老师从里面挑）

    // 挑人视图
    currentPost: '',
    currentPcls: '',
    currentCount: 0,              // 当前岗位已有的人数（满 2 人时再加人要先撤一个）
    pool: [],                     // 候选（带积分、已兼岗数）
    poolFilter: 'all',            // all=全班 / idle=仅未任职

    dirtyFlag: false,             // 仅 UI 用；判定逻辑走 this.dirty
    saving: false
  },

  onLoad() {
    this.setData({ cloudReady: db.isCloudReady() });
    this.loadClassTitle();
    this.dirty = false;
    this.refresh();
    // watch 只在没有未保存改动时刷新，否则冲掉老师刚定好的（考勤/座位/值日/课表都踩过）
    this.watcher = db.watch('committee', {}, () => {
      if (!this.dirty) this.refresh(true);
    }, err => console.error('watch committee error', err));
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
      // list() 内部分页：小程序端单次 get 最多 20 条，48 人 + 奖惩必须分页取
      const [students, records, rewards] = await Promise.all([
        db.list('students', {}, 500, { orderBy: [['studentNo', 'asc']] }),
        db.list('committee', {}, 200, { orderBy: [['post', 'asc']] }),
        db.list('rewards', {}, 800, { orderBy: [['date', 'desc']] })
      ]);
      this.students = students;
      this.records = records;
      // 积分是「推荐班委」的排序依据，必须由奖惩实时汇总 —— 不在 students 上存冗余字段
      //（存了就会和 rewards 漂移，档案页/奖惩页已经立过这个规矩）
      const pts = {};
      rewards.forEach(r => {
        const n = Number(r.points);
        if (!Number.isFinite(n)) return;
        pts[r.studentId] = (pts[r.studentId] || 0) + n;
      });
      this.points = pts;
      this.buildFromCloud();
      this.setData({ loading: false });
    } catch (e) {
      console.error('refresh committee error', e);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  // 云端记录 → 本地 assign。脏数据（孤儿/岗位枚举外/同岗超过 2 人/同人重复）在这里就地剔除，
  // 不能让它进 UI（否则一个岗位显示一堆人，老师照着安排必错）。
  // assign：post → [studentId, studentId]（每岗最多两人；成员按学号排，保证顺序稳定）
  buildFromCloud() {
    const stuMap = {};
    (this.students || []).forEach(s => { stuMap[s._id] = s; });
    const assign = {};
    let dropped = 0;
    (this.records || []).forEach(rec => {
      const post = String(rec.post || '');
      const sid = rec.studentId;
      if (POSTS.indexOf(post) < 0 || !stuMap[sid]) { dropped += 1; return; }
      if (!assign[post]) assign[post] = [];
      if (assign[post].indexOf(sid) >= 0) { dropped += 1; return; }  // 同人重复：丢弃
      if (assign[post].length >= MAX_PER_POST) { dropped += 1; return; } // 超编：只留前两人
      assign[post].push(sid);
    });
    if (dropped) console.warn(`[committee] 忽略 ${dropped} 条无效任职记录（孤儿/岗位枚举外/同岗超 ${MAX_PER_POST} 人/同人重复）`);
    this.assign = assign;
    this.render();
  },

  // 唯一渲染入口：posts / overview / warnList / idleList 全从 this.assign 算，
  // 保证「页面显示」和「将要保存的数据」永远同源（两套算法必然漂移，duty/schedule 都立过这个规矩）
  render() {
    const stuMap = {};
    (this.students || []).forEach(s => { stuMap[s._id] = s; });
    const pts = this.points || {};
    const assign = this.assign || {};
    const holdCount = {};         // studentId → 兼了几个岗

    const noOf = sid => {
      const n = parseInt(String((stuMap[sid] || {}).studentNo || '').replace(/\D/g, ''), 10);
      return Number.isFinite(n) ? n : 9999;
    };

    const posts = POSTS.map(post => {
      const sids = (assign[post] || []).slice().sort((a, b) => noOf(a) - noOf(b) || String(a).localeCompare(String(b)));
      const holders = sids.map(sid => {
        const stu = stuMap[sid];
        holdCount[sid] = (holdCount[sid] || 0) + 1;
        return { studentId: sid, name: stu.name, studentNo: stu.studentNo, points: pts[sid] || 0 };
      });
      return {
        post,
        pcls: POST_CLS[post] || 'monitor',
        isKey: KEY_POSTS.has(post),
        holders,
        // studentId/name 保留首人字段，供旧逻辑/测试锚点使用
        studentId: holders[0] ? holders[0].studentId : '',
        name: holders[0] ? holders[0].name : '',
        studentNo: holders[0] ? holders[0].studentNo : '',
        count: holders.length,
        empty: holders.length === 0,
        full: holders.length >= MAX_PER_POST
      };
    });

    const filled = posts.filter(p => !p.empty).length;
    // 告警1：核心岗位空缺（班长/副班长/学习委员没人，开学第一周就会卡住）
    const warns = [];
    posts.forEach(p => {
      if (p.empty && p.isKey) warns.push({ key: 'keyempty-' + p.pcls, text: `${p.post} 还没定人（核心班委）` });
    });
    // 告警2：一个人兼太多岗（跨岗位计数，与「每岗两人」是两条独立规则）
    Object.keys(holdCount).forEach(sid => {
      if (holdCount[sid] > MAX_POSTS_PER_PERSON) {
        const held = posts.filter(p => p.holders.some(h => h.studentId === sid)).map(p => p.post);
        warns.push({
          key: 'multi-' + sid,
          text: `${(stuMap[sid] || {}).name || '?'} 兼了 ${holdCount[sid]} 个职务（${held.join('、')}），超过 ${MAX_POSTS_PER_PERSON} 个`
        });
      }
    });

    // 未任职名单：按积分降序（积分高的更适合推给老师当候选），同分按学号
    const idleList = (this.students || []).filter(s => !holdCount[s._id])
      .map(s => ({ _id: s._id, name: s.name, studentNo: s.studentNo, points: pts[s._id] || 0 }))
      .sort((a, b) => b.points - a.points || noOf(a._id) - noOf(b._id));

    this.setData({
      posts,
      overview: {
        slots: SLOTS,
        filled,
        empty: SLOTS - filled,
        keyEmpty: posts.filter(p => p.empty && p.isKey).length,
        multi: Object.keys(holdCount).filter(sid => holdCount[sid] > MAX_POSTS_PER_PERSON).length
      },
      warnList: warns,
      idleList,
      // 必须在唯一渲染入口里同步 dirtyFlag：只在 onSave 里清 this.dirty 的话，
      // 按钮会一直卡在「保存」上（schedule 第一版漏了这行，探针实测抓到）
      dirtyFlag: !!this.dirty
    });
    this.holdCount = holdCount;
    // 挑人视图打开时同步刷新（任职被别处改了要跟着变）
    if (this.data.view === 'pick' && this.data.currentPost) this.buildPool(this.data.currentPost);
  },

  markDirty() {
    this.dirty = true;
    if (!this.data.dirtyFlag) this.setData({ dirtyFlag: true });
  },

  isSaving() {
    return !!this._busy;
  },

  /* ---------------- 挑人 ---------------- */

  onOpenPost(e) {
    const post = e.currentTarget.dataset.post;
    if (POSTS.indexOf(post) < 0) return;
    this.setData({ view: 'pick', currentPost: post, currentPcls: POST_CLS[post] || 'monitor' });
    this.buildPool(post);
  },

  onBackToList() {
    this.setData({ view: 'list', currentPost: '', currentPcls: '', currentCount: 0, pool: [] });
  },

  buildPool(post) {
    const pts = this.points || {};
    const hold = this.holdCount || {};
    const cur = (this.assign || {})[post] || [];
    const curSet = new Set(cur);
    let pool = (this.students || []).map(s => ({
      _id: s._id,
      name: s.name,
      studentNo: s.studentNo,
      points: pts[s._id] || 0,
      holds: hold[s._id] || 0,
      isCurrent: curSet.has(s._id)
    }));
    if (this.data.poolFilter === 'idle') pool = pool.filter(x => x.holds === 0 || x.isCurrent);
    // 积分高的排前面（老师挑班委看的就是这个），同分按学号；在任者用 chip-cur 样式标记，不挪位置
    const noOf = x => {
      const n = parseInt(String(x.studentNo || '').replace(/\D/g, ''), 10);
      return Number.isFinite(n) ? n : 9999;
    };
    pool.sort((a, b) => b.points - a.points || noOf(a) - noOf(b));
    this.setData({
      currentPost: post,
      currentPcls: POST_CLS[post] || 'monitor',
      currentCount: cur.length,
      pool
    });
  },

  onToggleFilter() {
    const next = this.data.poolFilter === 'all' ? 'idle' : 'all';
    this.setData({ poolFilter: next });
    if (this.data.currentPost) this.buildPool(this.data.currentPost);
  },

  // 点候选人：追加为当前岗位的负责人（每岗最多两人，第三人拦下）
  onAssign(e) {
    if (this.isSaving()) return;
    const sid = e.currentTarget.dataset.id;
    const post = this.data.currentPost;
    if (POSTS.indexOf(post) < 0) return;
    if (!(this.students || []).some(s => s._id === sid)) return;   // 脏 dataset / 幽灵 id
    const cur = (this.assign || {})[post] || [];
    if (cur.indexOf(sid) >= 0) {
      wx.showToast({ title: '已经在任这个岗位了', icon: 'none' });
      return;
    }
    if (cur.length >= MAX_PER_POST) {
      wx.showToast({ title: `这个岗位已满 ${MAX_PER_POST} 人，先撤掉一人`, icon: 'none' });
      return;
    }
    if (!this.assign[post]) this.assign[post] = [];
    this.assign[post].push(sid);
    this.markDirty();
    this.render();
    // 任命完回岗位清单：老师的动作是「一个岗位定人」，留在挑人页会误点成连加。
    // 不弹 toast：任命后新增的人就在这一行，toast 会正好盖住他（实测截图）。
    this.setData({ view: 'list', currentPost: '', currentPcls: '', currentCount: 0, pool: [] });
  },

  // 撤人：dataset.sid 指定撤某一个人；不指定（长按岗位行）则撤掉整个岗位
  onVacate(e) {
    if (this.isSaving()) return;
    const post = e.currentTarget.dataset.post;
    if (POSTS.indexOf(post) < 0) return;
    const cur = (this.assign || {})[post] || [];
    const sid = e.currentTarget.dataset.sid;
    if (!cur.length) {
      wx.showToast({ title: '这个岗位本来就空着', icon: 'none' });
      return;
    }
    if (sid) {
      const idx = cur.indexOf(sid);
      if (idx < 0) {
        wx.showToast({ title: '这个人不在这个岗位', icon: 'none' });
        return;
      }
      cur.splice(idx, 1);
      if (!cur.length) delete this.assign[post];
    } else {
      delete this.assign[post];
    }
    this.markDirty();
    this.render();
  },

  /* ---------------- 批量操作 ---------------- */

  // 一键推荐：按积分从高到低填满**空缺**岗位（每岗先推荐一人，第二人由老师自己定），
  // 已定的不动（老师最烦「一键」把已定好的冲掉）；同一个人不重复上岗；人不够时剩下的继续空着
  onRecommend() {
    if (this.isSaving()) return;
    const stu = (this.students || []).slice();
    if (!stu.length) {
      wx.showToast({ title: '还没有学生', icon: 'none' });
      return;
    }
    const pts = this.points || {};
    const assign = {};
    Object.keys(this.assign || {}).forEach(p => { assign[p] = (this.assign[p] || []).slice(); });
    const taken = new Set();
    Object.keys(assign).forEach(p => assign[p].forEach(sid => taken.add(sid)));
    const cands = stu.filter(s => !taken.has(s._id))
      .sort((a, b) => (pts[b._id] || 0) - (pts[a._id] || 0) || String(a.studentNo).localeCompare(String(b.studentNo)));
    let ci = 0;
    let added = 0;
    POSTS.forEach(post => {
      if ((assign[post] || []).length) return;     // 已定（哪怕只有一人）的绝不覆盖
      if (ci >= cands.length) return;              // 人不够，继续空着
      assign[post] = [cands[ci++]._id];
      added += 1;
    });
    if (!added) {
      wx.showToast({ title: '岗位都已定人', icon: 'none' });
      return;
    }
    this.assign = assign;
    this.markDirty();
    this.render();
    wx.showToast({ title: `已推荐 ${added} 人（按积分）`, icon: 'none' });
  },

  onClearAll() {
    if (this.isSaving()) return;
    if (this.data.overview.filled === 0) {
      wx.showToast({ title: '本来就是空的', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '清空班委',
      content: `会清掉全部 ${this.data.overview.filled} 个岗位的任职，保存后生效。`,
      confirmColor: '#B9412E',
      success: res => {
        if (!res.confirm || this.isSaving()) return;
        this.assign = {};
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
    const stuIds = new Set((this.students || []).map(s => s._id));
    // 目标态：合法的 post@sid 对（每岗最多两人，由 onAssign/buildFromCloud 保证）
    const target = new Set();
    Object.keys(this.assign || {}).forEach(post => {
      (this.assign[post] || []).forEach(sid => {
        if (POSTS.indexOf(post) >= 0 && stuIds.has(sid)) target.add(post + '@' + sid);
      });
    });

    // 云端态：合法记录按 post@sid 锚定；非法记录（枚举外岗位/孤儿学生/同人重复对）进删除队列。
    // 每岗最多两人的超编记录也在页面加载时被剔出 assign，保存时必须从云端一并清掉。
    const validExisting = new Set();
    const removes = [];
    (this.records || []).forEach(rec => {
      const post = String(rec.post || '');
      const sid = rec.studentId;
      const pair = post + '@' + sid;
      if (POSTS.indexOf(post) < 0 || !stuIds.has(sid) || validExisting.has(pair) || !target.has(pair)) {
        removes.push(rec._id);
        return;
      }
      validExisting.add(pair);
    });
    // 目标里有、云端没有 → 新增；其余都是保留或删除（pair 模型不需要 update）
    const adds = [];
    target.forEach(pair => {
      if (validExisting.has(pair)) return;
      const i = pair.indexOf('@');
      adds.push({ post: pair.slice(0, i), studentId: pair.slice(i + 1) });
    });

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
      // allSettled：同批单条失败时其余写入可能已落库，不能整批 reject 后拿旧基线重 diff
      //（值日页实测：半迁移 + 旧快照重试 → 已存新增被再插一遍，云端冒出重复文档）。
      const jobs = []
        .concat(adds.map(a => () => db.add('committee', a)))
        .concat(removes.map(id => () => db.remove('committee', id)));
      const rejected = [];
      for (let i = 0; i < jobs.length; i += 10) {
        const rs = await Promise.allSettled(jobs.slice(i, i + 10).map(f => f()));
        rs.forEach(r => { if (r.status === 'rejected') rejected.push(r.reason); });
      }
      // 成败都回读云端真值锚定 this.records，只锚定原始记录、不重建本地编排。
      this.records = await db.list('committee', {}, 200, { orderBy: [['post', 'asc']] });
      if (rejected.length) {
        console.error('save committee partial-fail', rejected.length, rejected[0]);
        this.dirty = true;
        this.setData({ dirtyFlag: true });
        wx.hideLoading();
        wx.showToast({ title: `${rejected.length} 项没存上，再点保存补齐`, icon: 'none' });
        return;
      }
      this.dirty = false;
      wx.hideLoading();
      wx.showToast({ title: `已保存（新增${adds.length}/撤${removes.length}）`, icon: 'success' });
      await this.refresh(true);           // 全成功才重建视图
    } catch (err) {
      // 连回读锚定都失败（弱网）：本地名单必须保留，不许假装成功
      console.error('save committee error', err);
      this.dirty = true;
      this.setData({ dirtyFlag: true });
      wx.hideLoading();
      wx.showToast({ title: '网络异常，名单已保留，请重试', icon: 'none' });
    } finally {
      this._busy = false;
      this.setData({ saving: false });
    }
  }
});
