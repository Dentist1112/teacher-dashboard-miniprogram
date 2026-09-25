#!/usr/bin/env node
/**
 * 蓝队（设计者视角）：变异测试 —— 证明门禁「真能抓」，而不是「跑过就算」。
 *
 * 为什么必须有这个：duty 页的 e2e 断言和 duty 页代码是同一个我写的，共享同一个心智模型。
 * 实测事故：往 onRotate 注入 `i % (SLOTS-5)` 后，14 条 duty 断言全绿放行 ——
 * 漏洞从「岗位侧」（25 格空了 5 格）穿过，因为断言只查了「每人排几次」。
 * 手工注入靠记性，跑一次忘一次；这里把它变成能重复执行的门禁。
 *
 * 判定：注入变异体 → 跑指定 e2e 段 → 期望变红。
 *   变红   = 门禁有效（KILLED）
 *   仍全绿 = 门禁有洞，必须补断言（SURVIVED，退出码 1）
 *
 * 用法:
 *   node tools/mutate.js --list
 *   node tools/mutate.js duty-rotate-slots     跑单个
 *   node tools/mutate.js --tag duty            跑一组
 *   node tools/mutate.js --all                 全跑（慢，每个约 1.5min）
 *
 * 安全：每次注入前把原文件备份到 /tmp/mutate-backup/，无论成功失败/Ctrl-C 都还原。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BAK = '/tmp/mutate-backup';

// 每个变异体：改一处业务代码，制造一个真实会发生的 bug。
// slice = 应该抓住它的 e2e 段；expect = 期望命中的断言关键字（抓错地方也算问题）
const MUTANTS = [
  {
    id: 'duty-rotate-slots', tag: 'duty', slice: [18],
    file: 'pages/duty/duty.js',
    desc: '按学号轮排只填 20 个岗位位置（5 个格子空着）',
    from: 'const slot = i % SLOTS;\n      const wd = WEEKDAYS[Math.floor(slot / JOBS.length)].d;\n      const job = JOBS[slot % JOBS.length];\n      const k = wd + \'@\' + job;',
    to: 'const slot = i % (SLOTS - 5);\n      const wd = WEEKDAYS[Math.floor(slot / JOBS.length)].d;\n      const job = JOBS[slot % JOBS.length];\n      const k = wd + \'@\' + job;',
    expect: /轮排.*空岗|按学号轮排/
  },
  {
    id: 'duty-shuffle-slots', tag: 'duty', slice: [18],
    file: 'pages/duty/duty.js',
    desc: '随机轮排只填 20 个岗位位置',
    from: "      const slot = i % SLOTS;\n      const wd = WEEKDAYS[Math.floor(slot / JOBS.length)].d;\n      const job = JOBS[slot % JOBS.length];\n      (assign[wd + '@' + job]",
    to: "      const slot = i % (SLOTS - 5);\n      const wd = WEEKDAYS[Math.floor(slot / JOBS.length)].d;\n      const job = JOBS[slot % JOBS.length];\n      (assign[wd + '@' + job]",
    expect: /随机轮排/
  },
  {
    id: 'duty-save-nodiff', tag: 'duty', slice: [18],
    file: 'pages/duty/duty.js',
    desc: '保存不做 diff，已存在的记录重复插入（云端翻倍）',
    from: 'const adds = Object.keys(target).filter(k => !existing[k]).map(k => target[k]);',
    to: 'const adds = Object.keys(target).map(k => target[k]);',
    expect: /云端|重复|dirty|写库/
  },
  {
    // 注意：原先这个变异体写的是把 `this._busy` 换成 `this.data.saving`，结果 SURVIVED。
    // 实测判定（enter=4 次 / 云端只多 1 条）：那是**等价变异体**，不是门禁盲点 ——
    // 本项目 15 处 guard 到置位之间全是同步代码，两个标志此时行为完全一致。
    // 真正的 bug 形态是「根本没有 guard」，所以改成整行删掉。
    // 配套：check.js 新增静态门禁，禁止 guard 与置位之间出现 await（那才会让 data.saving 失效）。
    id: 'duty-no-busy', tag: 'duty', slice: [18],
    file: 'pages/duty/duty.js',
    desc: '值日保存完全删掉防连点 guard（连点会重复写库）',
    from: "  async onSave() {\n    if (this._busy) return;              // this.data.saving 是异步的，防不住同 tick 连点\n",
    to: "  async onSave() {\n",
    // 删掉 _busy guard 的下游症状不止「计数不符」：连点狂写库会先撞云开发频率限制
    // （meet frequency limit）。实测该变异体报的是限流 + dirty 未清，都是真捕获信号，
    // 所以 expect 三者取一。正常代码写入量根本触不到限流。
    expect: /连点|frequency|dirty 未清/
  },
  {
    id: 'duty-cascade-off', tag: 'cascade', slice: [18],
    file: 'pages/roster/roster.js',
    desc: '删学生时漏掉 dutySchedule 级联（留孤儿值日）',
    from: "      { collection: 'dutySchedule', field: 'studentId' },\n",
    to: '',
    expect: /级联|孤儿/
  },
  {
    id: 'seats-cascade-off', tag: 'cascade', slice: [17],
    file: 'pages/roster/roster.js',
    desc: '删学生时漏掉 seats 级联（留孤儿座位）',
    from: "      { collection: 'seats', field: 'studentId' },\n",
    to: '',
    expect: /级联|孤儿/
  },
  {
    id: 'sched-save-nodiff', tag: 'schedule', slice: [19],
    file: 'pages/schedule/schedule.js',
    desc: '课表保存不认云端已有记录，全部当新增插入（同格出现多条 → 一格一课破了）',
    from: '      const cur = existing[k];\n',
    to: '      const cur = null;\n',
    expect: /一格一课|update|云端/
  },
  {
    id: 'sched-tpl-holes', tag: 'schedule', slice: [19],
    file: 'pages/schedule/schedule.js',
    desc: '套用模板漏掉第 8 节（45 格里空 5 格，老师以为排满了）',
    from: "      plan[w.d + '@8'] = { subject: '自习', teacher: '' };\n",
    to: '',
    expect: /模板/
  },
  {
    // 新功能必须配自己的变异体：否则「午间延时」这条路等于没门禁（加页面清单第 1 条）
    id: 'sched-noon-hole', tag: 'schedule', slice: [19],
    file: 'pages/schedule/schedule.js',
    desc: '套用模板漏掉午间延时（45 格里空 5 格，老师中午看管没课可上）',
    from: "      plan[w.d + '@9'] = { subject: '自习', teacher: '' };\n",
    to: '',
    expect: /模板/
  },
  {
    id: 'sched-no-busy', tag: 'schedule', slice: [19],
    file: 'pages/schedule/schedule.js',
    desc: '课表保存完全删掉防连点 guard（连点会重复写库）',
    from: "  async onSave() {\n    if (this._busy) return;              // this.data.saving 是异步的，防不住同 tick 连点\n",
    to: "  async onSave() {\n",
    expect: /连点/
  },
  {
    // 探针实测的真 bug（第一版代码就是这样）：保存成功后按钮仍写着「保存」，老师会反复点。
    id: 'sched-dirtyflag-stuck', tag: 'schedule', slice: [19],
    file: 'pages/schedule/schedule.js',
    desc: 'render 不同步 dirtyFlag（保存成功后按钮仍显示「保存」）',
    from: "      dirtyFlag: !!this.dirty\n",
    to: '',
    expect: /保存后状态未清/
  },
  {
    id: 'sched-conflict-off', tag: 'schedule', slice: [19],
    file: 'pages/schedule/schedule.js',
    desc: '主科每日上限抬到 99（冲突检测形同关闭，排课不合理也不告警）',
    from: 'const MAX_MAIN_PER_DAY = 3;',
    to: 'const MAX_MAIN_PER_DAY = 99;',
    expect: /冲突/
  },
  {
    id: 'comm-save-nodiff', tag: 'committee', slice: [20],
    file: 'pages/committee/committee.js',
    desc: '班委保存不删云端多余记录（撤掉的人/超编记录永久残留 → 云端与页面不一致）',
    from: "      if (POSTS.indexOf(post) < 0 || !stuIds.has(sid) || validExisting.has(pair) || !target.has(pair)) {\n",
    to: "      if (POSTS.indexOf(post) < 0 || !stuIds.has(sid) || validExisting.has(pair)) {\n",
    expect: /还原失败|清空异常|脏数据清理异常/
  },
  {
    id: 'comm-recommend-overwrite', tag: 'committee', slice: [20],
    file: 'pages/committee/committee.js',
    desc: '「按积分推荐」覆盖已定好的岗位（老师手动定的人被一键冲掉）',
    from: '      if ((assign[post] || []).length) return;     // 已定（哪怕只有一人）的绝不覆盖\n',
    to: '',
    expect: /推荐/
  },
  {
    id: 'comm-no-busy', tag: 'committee', slice: [20],
    file: 'pages/committee/committee.js',
    desc: '班委保存完全删掉防连点 guard（连点会重复写库）',
    from: "  async onSave() {\n    if (this._busy) return;              // this.data.saving 是异步的，防不住同 tick 连点\n",
    to: "  async onSave() {\n",
    expect: /连点/
  },
  {
    id: 'comm-dup-post-through', tag: 'committee', slice: [20],
    file: 'pages/committee/committee.js',
    desc: 'buildFromCloud 不剔同岗超编（第 3 人也上屏，一岗两人破了）',
    from: "      if (assign[post].length >= MAX_PER_POST) { dropped += 1; return; } // 超编：只留前两人\n",
    to: "",
    expect: /一岗最多两人|超编|第 3 人/
  },
  {
    id: 'comm-warn-off', tag: 'committee', slice: [20],
    file: 'pages/committee/committee.js',
    desc: '兼岗上限抬到 99（兼岗告警形同关闭，一个人兼一堆职务也不提醒）',
    from: 'const MAX_POSTS_PER_PERSON = 2;',
    to: 'const MAX_POSTS_PER_PERSON = 99;',
    expect: /告警/
  },
  {
    // ⚠️ 不用「删整行」：committee 是数组末项，删掉会改数组结构，实测导致页面 FATAL
    // （pg.onSave is not a function），段在级联断言之前就崩 → 崩溃假象，不是真捕获。
    // 改成把 where 字段名写错：committee 里查不到任何匹配 → 级联对它失效，
    // 但数组结构/长度完全不变。（不能指向不存在的**集合**：云端会报 collection not
    // exists，整个删除失败，那是另一种故障形态，测的不是「漏级联」。）
    id: 'comm-cascade-off', tag: 'cascade', slice: [20],
    file: 'pages/roster/roster.js',
    desc: '删学生时 committee 级联查错字段（留孤儿任职：岗位挂着已删的人）',
    from: "      { collection: 'committee', field: 'studentId' }\n",
    to: "      { collection: 'committee', field: 'studentIdNope' }\n",
    expect: /级联|孤儿|班委/
  },
  {
    // 拍照导名单：两个变异体守「学号分配」这条唯一的外键生成路径。
    // slice 用 [] 表示不靠 e2e，而是靠 tools/test-roster-import.js 直接判定
    // （那段逻辑不需要模拟器，14min 的 e2e 里跑它是浪费）。
    id: 'roster-ai-dup-off', tag: 'roster', slice: [],
    file: 'pages/roster/roster.js',
    unit: 'node tools/test-roster-import.js',
    desc: '导名单不查云端学号重复（学号撞了照样写库 → 考勤/成绩挂错人）',
    from: "        if (cloudNos.has(no)) dup = '学号已存在';",
    to: "        if (false) dup = '学号已存在';",
    expect: /学号|dup|导入/
  },
  {
    // 2026-09-06 用户报的原 bug：「点设置，文本输入不了」。
    // 真因是 onShow 的 load() 云回包整体替换 form，把正在打的字冲掉。
    // 判定走 e2e 段 12（页面 JS 在模拟器热更新，段 12 本来就在 settings 页）。
    id: 'settings-dirty-off', tag: 'settings', slice: [12],
    file: 'pages/settings/settings.js',
    desc: '去掉 _dirty 保护（云回包重新覆盖用户正在输入的班级信息 → 手感是「打不上字」）',
    from: '    if (this._dirty) return;               // 用户已经动过表单 → 本次回包丢弃',
    to: '    if (false) return;',
    expect: /云回包|正在输入|冲掉/
  },
  {
    // 2026-09-06 用户报的核心 bug：「新加通知，文本输入不了」。
    // 真因：弹层内容区写 catchtap=""（空字符串处理器）**不拦冒泡**，
    // 点输入框的 tap 冒到 mask 的 catchtap="onFormCancel" → 弹层直接关掉，
    // 老师看到的就是「点了没反应/打不上字」。修法是换成真处理器 noop。
    // 判定必须走 e2e 段 21c（粘贴名单段，含「点输入框不会把弹层关掉」断言）。
    // 早期误配 slice:[21]（数据一致性段，只 1 条断言），变异体永远 SURVIVED ——
    // 2026-09-13 蓝队全量抓到：不是断言弱，是根本没跑到那段。
    id: 'roster-noop-empty', tag: 'roster', slice: ['21c'],
    file: 'pages/roster/roster.wxml',
    desc: '弹层 catchtap 换回空字符串（点输入框冒泡到 mask，弹层被关 → 「打不上字」）',
    // 锚点含 kbH 键盘避让的 style（2026-09-06 加入），改 WXML 时必须同步这里
    from: '<view class="form-sheet" catchtap="noop" style="{{kbH ? \'margin-bottom:\' + kbH + \'px;max-height:58vh\' : \'\'}}">\n    <view class="form-title">粘贴名单</view>',
    to: '<view class="form-sheet" catchtap="" style="{{kbH ? \'margin-bottom:\' + kbH + \'px;max-height:58vh\' : \'\'}}">\n    <view class="form-title">粘贴名单</view>',
    expect: /弹层被关|冒泡|弹层/
  },
  {
    // 2026-09-06 新增：粘贴名单（零密钥导入）的两道过滤。
    // 判定器是 tools/test-roster-import.js（纯函数，不用模拟器）。
    id: 'roster-paste-noheader', tag: 'roster', slice: [],
    file: 'pages/roster/roster.js',
    unit: 'node tools/test-roster-import.js',
    desc: '粘贴名单不剔表头（「姓名」「序号」被当成学生写库）',
    from: '      if (HEADERS.indexOf(n) >= 0) return false;',
    to: '      if (false) return false;',
    expect: /表头|姓名/
  },
  {
    id: 'roster-paste-nonumeric', tag: 'roster', slice: [],
    file: 'pages/roster/roster.js',
    unit: 'node tools/test-roster-import.js',
    desc: '粘贴名单不剔纯数字行（学号 001 / 手机号 13800001111 被当成学生姓名）',
    from: "      return /[\\u4e00-\\u9fa5a-zA-Z]/.test(n);      // 纯数字（学号/手机号）/符号不是姓名",
    to: '      return true;',
    expect: /纯数字|手机号|噪声|连字符/
  },
  {
    id: 'roster-ai-skip-hole', tag: 'roster', slice: [],
    file: 'pages/roster/roster.js',
    unit: 'node tools/test-roster-import.js',
    desc: '跳过的行也占学号（学号出现空洞，老师核对不下去）',
    from: '      if (!skip) {\n',
    to: '      if (true) {\n',
    expect: /学号|连续/
  },
  {
    // 互换丢课：第一次 if (av) 删掉了，导致第二次 if (bv) 写入时 av 已经被清。
    // 真 bug 形态：A=B=非空 → 期望 A 拿到 bv 课 / B 拿到 av 课。
    // 删掉第一个 if 后：A 直接被 delete；B 拿到 av 课；A 空 → 丢一节。
    id: 'grades-maxfull-off', tag: 'grades',
    file: 'utils/validate.js',
    unit: 'node tools/test-validate-range.js',
    desc: '满分上限抬到 10000（老师可填 9999 分，统计全乱）——用 Node 单测判定，不靠模拟器热更新',
    from: 'const SCORE_MAX_FULL = 150;',
    to: 'const SCORE_MAX_FULL = 10000;',
    expect: /满分上限|满分 1000|上限/
  },
  {
    id: 'grades-db-guard-off', tag: 'grades',
    file: 'utils/db.js',
    unit: 'node tools/test-db-guard.js',
    desc: 'db 写入层删掉数值兜底（OCR/粘贴路径能写超满分数据）——Node 真调 db.add/update 判定',
    from: "  assertValid(name, data);\n  // \u26a0\ufe0f add \u4e0d\u5e42\u7b49",
    to: "  // \u26a0\ufe0f add \u4e0d\u5e42\u7b49",
    expect: /超满分|拦截|未拦|full|小数/
  },
  // ---- 2026-09-06 第二轮边界探针沉淀的 8 个变异体 ----
  // 都是 unit 型（判定器 tools/test-boundary.js 直调 utils/validate.js）。
  // 理由见 docs/ADVERSARIAL.md #29：utils 模块在开发者工具里不热更新，走 e2e 会假 SURVIVED。
  {
    id: 'bnd-strictint-loose', tag: 'boundary',
    file: 'utils/validate.js',
    unit: 'node tools/test-boundary.js',
    desc: "strictInt 退回 Number()（'   '→0 分、'0x10'→16 分、'007'→7 分重新入库)",
    from: "  if (!/^-?(0|[1-9]\\d{0,8})$/.test(s)) return null;\n  return Number(s);",
    to: "  return Number(s);",
    expect: /空格|0x10|007|整数|积分/
  },
  {
    id: 'bnd-reward-zero-ok', tag: 'boundary',
    file: 'utils/validate.js',
    unit: 'node tools/test-boundary.js',
    desc: '允许 0 分奖惩记录（既不奖也不惩，只污染积分统计）',
    from: "  if (p === 0) return '积分不能是 0';",
    to: "  if (false) return '积分不能是 0';",
    expect: /积分 0|不能是 0/
  },
  {
    id: 'bnd-realdate-off', tag: 'boundary',
    file: 'utils/validate.js',
    unit: 'node tools/test-boundary.js',
    desc: "日期只验格式不验真实性（'2011-13-45'/'2026-02-30' 重新入库)",
    from: "  const dt = new Date(Date.UTC(y, mo - 1, d));\n  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;",
    to: "  return true;",
    expect: /2011-13-45|0000-00-00|02-30|日期/
  },
  {
    id: 'bnd-phone-loose', tag: 'boundary',
    file: 'utils/validate.js',
    unit: 'node tools/test-boundary.js',
    desc: '手机号回退成 match（12 位号里抠出前 11 位 → 一键拨号拨错人）',
    from: "function pickPhone(text) {\n  const s = String(text || '');",
    to: "function pickPhone(text) {\n  const mm = String(text || '').match(/1[3-9]\\d{9}/);\n  if (mm) return mm[0];\n  const s = String(text || '');",
    expect: /12 位|手机号/
  },
  {
    id: 'bnd-textmax-off', tag: 'boundary',
    file: 'utils/validate.js',
    unit: 'node tools/test-boundary.js',
    desc: '文本长度上限失效（500 字标题 / 20000 字正文重新入库，列表卡片被撑爆）',
    from: "  if (t.length > max) return { text: t, why: `最多 ${max} 个字（当前 ${t.length}）` };",
    to: "  if (false) return { text: t, why: `最多 ${max} 个字（当前 ${t.length}）` };",
    expect: /个字|500|20000|长/
  },
  {
    id: 'bnd-due-nolimit', tag: 'boundary',
    file: 'utils/validate.js',
    unit: 'node tools/test-boundary.js',
    desc: "截止日期无上限（'2999-12-31' 重新入库，卡片显示「还有 355497 天」)",
    from: "    if (days > DUE_MAX_DAYS) return `截止日期最远 ${DUE_MAX_DAYS} 天内`;",
    to: "    if (false) return `截止日期最远 ${DUE_MAX_DAYS} 天内`;",
    expect: /2999|截止日期最远|730/
  },
  {
    id: 'bnd-studentno-loose', tag: 'boundary',
    file: 'utils/validate.js',
    unit: 'node tools/test-boundary.js',
    desc: '学号格式不校验（200 位学号回来 → AI 名单起始号变 1e+200，分配出错号）',
    from: "    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(no)) return '学号要以字母或数字开头，只能用字母、数字、- 和 _';",
    to: "    if (false) return '学号要以字母或数字开头，只能用字母、数字、- 和 _';",
    expect: /学号/
  },
  {
    id: 'bnd-birthyear-off', tag: 'boundary',
    file: 'utils/validate.js',
    unit: 'node tools/test-boundary.js',
    desc: "出生年份不设区间（'2099-01-01' 重新入库，年龄统计为负)",
    from: "    if (y < BIRTH_MIN_YEAR || y > nowY) return `出生年份要在 ${BIRTH_MIN_YEAR}-${nowY} 之间`;",
    to: "    if (false) return `出生年份要在 ${BIRTH_MIN_YEAR}-${nowY} 之间`;",
    expect: /出生年份|2099|1980/
  },
  {
    // 成绩静默丢失：update 到已被删掉的文档不报错也不生效，toast 却显示「已保存 N 人」。
    // slice 14 是成绩页段；probe-boundary.js grades 也覆盖这条（回读确认）。
    // 判定器用 e2e slice 14（页面文件在模拟器里热更新，能被变异体影响；
    // probe-boundary 试过一次，判成 SURVIVED —— 复用实例下页面 JS 同样有不热更新的时候，
    // 只有走 e2e 的完整 reLaunch 序列才稳定生效，见 docs/ADVERSARIAL.md #23 同类坑）。
    // slice 14 里新增了「云端删掉记录后再存」的构造断言，专门覆盖失效 scoreId。
    id: 'grades-stale-scoreid', tag: 'grades', slice: [14],
    file: 'pages/grades/grades.js',
    desc: '删掉 update 后的回读兜底（scoreId 失效时成绩静默丢失，提示却是「已保存」）',
    from: "          const back = await db.list('scores', { _id: r.scoreId }, 1).catch(() => []);\n          if (!back.length) await db.add('scores', payload);",
    to: "          // mutated",
    expect: /成绩|保存|入库|分/
  },
  {
    id: 'ann-tabbar-layer', tag: 'announcement', slice: [6],
    file: 'pages/announcement/announcement.js',
    desc: '通知弹层打开时不隐藏自定义 tabBar（发布按钮继续被独立导航层截获触摸）',
    from: '  onAdd() {\n    modal.hideTabBar(this);\n    this.setData({',
    to: '  onAdd() {\n    // mutated: 不隐藏自定义 tabBar\n    this.setData({',
    expect: /底部导航|发布按钮/
  },
  {
    id: 'grades-saved-order-off', tag: 'grades', slice: [14],
    file: 'pages/grades/grades.js',
    desc: '保存后成绩列表仍按学号序展示（只算名次，不把高分排到前面）',
    from: 'this.setData({ rows: sortSavedRows(rows) });',
    to: 'this.setData({ rows });',
    expect: /按分数.*降序|高分/
  },
  {
    id: 'sched-swap-lose', tag: 'schedule', slice: [19],
    file: 'pages/schedule/schedule.js',
    desc: '互换逻辑顺序错（A 在 B 写入前被清，丢一节）',
    from: "      if (av && bv) {\n        this.plan[a] = { subject: subjectB, teacher };\n        this.plan[b] = { subject: subjectA, teacher };\n      } else if (av) {\n        // a 非空 b 空：移动过去\n        this.plan[b] = { subject: subjectA, teacher };\n        delete this.plan[a];\n      } else {\n        // a 空 b 非空：移回 a\n        this.plan[a] = { subject: subjectB, teacher };\n        delete this.plan[b];\n      }",
    to: '',  // 注入：互换三分支整段被删，av/bv 非空时不交换也不移动 → 互换丢课
      // 注：删了之后走到 render() 之前 dirty 没标，wx.showToast 也没了，但 dirty 会在外层 markDirty 调用
      //     —— 所以这个变异体的期望要靠 '互换'/'丢' 关键字抓到
    expect: /互换|移动|丢|脏|一格一课/
  },
  {
    // 不标 dirty：swap 后没 markDirty → 保存时「没有改动需要保存」，老师的互换直接丢
    id: 'sched-swap-nodirty', tag: 'schedule', slice: [19],
    file: 'pages/schedule/schedule.js',
    desc: '互换后忘标 dirty（保存时提示「无改动」互换直接丢）',
    from: '      this.markDirty();\n      this.render();\n      wx.showToast({',
    to: '      this.render();                                             // 注入：忘 markDirty\n      wx.showToast({',
    expect: /互换|dirty|无改动|保存/
  },
  {
    // 周表日期：算错「本周一」的经典写法 —— 直接用 getDay() 当偏移，周日会退到上一周。
    // 用 Node 单测判定：日期错在模拟器里只是「表头写了别的数字」，肉眼和 e2e 都看不出真伪。
    id: 'wk-monday-off', tag: 'weekdays',
    file: 'utils/weekdays.js',
    unit: 'node tools/test-weekdays.js',
    desc: '「本周一」算错（周末不前移到下周，退回上一周）',
    from: '  const delta = (w >= 1 && w <= 5) ? 1 - w : (w === 6 ? 2 : 1);',
    to: '  const delta = 1 - w;',
    expect: /周六|周日|下周|日期/
  },
  {
    // 月份少加 1：dateLabel 与 date 脱钩，老师看到的日子和实际不是同一天
    id: 'wk-month-off', tag: 'weekdays',
    file: 'utils/weekdays.js',
    unit: 'node tools/test-weekdays.js',
    desc: '月份少加 1（dateLabel 全部差一个月）',
    from: '    const m = day.getMonth() + 1;',
    to: '    const m = day.getMonth();',
    expect: /日期|dateLabel|date/
  },
  {
    // 周表直接填课（用户反馈 2026-09-06：不想为了改一节课进单日页）。
    // 删掉「已挑科目」分支 → 挑了科目点格子什么都不会发生（退回旧行为）。
    id: 'sched-week-nofill', tag: 'schedule', slice: [19],
    file: 'pages/schedule/schedule.js',
    desc: '周表点格子不填课（挑了科目也只进待交换态）',
    from: "    const picked = this.data.pickedSubject;",
    to: "    const picked = '';                      // 注入：周表填课分支失效",
    expect: /周表.*填课|填入/
  },
  {
    // 填完不清选中 → 老师接着点别的格子会连填一片（day 页踩过一次，周表同样会踩）
    id: 'sched-week-stickypick', tag: 'schedule', slice: [19],
    file: 'pages/schedule/schedule.js',
    desc: '周表填课后不清选中科目（会连填一片）',
    from: "      this.setData({ pickedSubject: '', swapFrom: '' });\n      wx.showToast({ title: '已填入 ' + picked, icon: 'none' });",
    to: "      wx.showToast({ title: '已填入 ' + picked, icon: 'none' });",
    expect: /清选中|连填|选中/
  },
  {
    // 长按清空不判空 → 空格长按也标脏，「已同步」无故变「保存」，老师以为漏了改动
    id: 'sched-week-clearblank', tag: 'schedule', slice: [19],
    file: 'pages/schedule/schedule.js',
    desc: '周表长按清空不判「本来是空的」（空格也标脏）',
    from: "    if (!this.plan[k]) {\n      wx.showToast({ title: '这一节本来是空的', icon: 'none' });\n      return;\n    }\n    delete this.plan[k];\n    this.markDirty();\n    this.render();\n    this.setData({ swapFrom: '', pickedSubject: '', fillTarget: '', fillTargetLabel: '' });\n    wx.showToast({ title: '已清空这一节', icon: 'none' });",
    to: "    delete this.plan[k];\n    this.markDirty();\n    this.render();\n    this.setData({ swapFrom: '', pickedSubject: '', fillTarget: '', fillTargetLabel: '' });\n    wx.showToast({ title: '已清空这一节', icon: 'none' });",
    expect: /本来是空的|长按|脏/
  },
  {
    // 挑科目不清 swapFrom → 填课/换课两种模式混在一起，点格子会被当成交换第二次点击
    id: 'sched-mode-mix', tag: 'schedule', slice: [19],
    file: 'pages/schedule/schedule.js',
    desc: '挑科目不退出待交换态（填课与换课模式混淆）',
    from: "    this.setData({ pickedSubject: this.data.pickedSubject === s ? '' : s, swapFrom: '' });",
    to: "    this.setData({ pickedSubject: this.data.pickedSubject === s ? '' : s });",
    expect: /互斥|待交换|swapFrom/
  },
  {
    // 键盘避让：不去重就会在每次键盘回调（安卓一次弹起会连报 5~10 次）都 setData，
    // 老师打字时页面明显卡顿。模拟器没真键盘，只有 Node 单测能抓。
    id: 'kb-no-dedup', tag: 'kb',
    file: 'utils/kb.js',
    unit: 'node tools/test-kb.js',
    desc: '键盘高度同值不去重（高频 setData 拖慢输入）',
    from: '      if (page.data.kbH !== h) page.setData({ kbH: h });',
    to: '      page.setData({ kbH: h }); // mutated: 去重被摘掉',
    expect: /重复回调|setData/
  },
  {
    // unbind 不摘监听 → 页面反复进出后累积 N 个监听，每次键盘弹起 setData N 次
    id: 'kb-leak', tag: 'kb',
    file: 'utils/kb.js',
    unit: 'node tools/test-kb.js',
    desc: 'unbind 不摘键盘监听（页面进出后监听泄漏）',
    from: '  if (wx.offKeyboardHeightChange && page.__kbHandler) wx.offKeyboardHeightChange(page.__kbHandler);',
    to: '  // mutated: 忘记 off',
    expect: /unbind|泄漏|监听/
  },
  {
    // 键盘收起必须延迟归零：立即归零会让 sheet 下坠，真机点「发布」的 tap 落到
    // mask 上变取消（2026-09-12 真机 bug，模拟器没有真键盘永远测不出）。
    id: 'kb-hide-delay', tag: 'kb',
      file: 'utils/kb.js',
      unit: 'node tools/test-kb.js',
      desc: '键盘收起立即归零（sheet 下坠吞掉保存按钮的 tap）',
      from: 'const HIDE_DELAY = 450;',
      to: 'const HIDE_DELAY = 0;',
      expect: /保持|下坠|tap/
    },
    // 等待归零期间重新弹起键盘，必须取消旧定时器，否则 sheet 会中途无故掉回底部
    {
      id: 'kb-cancel-timer', tag: 'kb',
      file: 'utils/kb.js',
      unit: 'node tools/test-kb.js',
      desc: '重新弹起键盘时不取消待执行的归零定时器',
      from: `      if (page.__kbHideTimer) {
        clearTimeout(page.__kbHideTimer);
        page.__kbHideTimer = null;
      }`,
      to: '      // mutated: 不取消归零定时器',
      expect: /取消|掉回|320/
    },
  {
    // 并行分页退回串行：功能不变但每页多等 300~700ms（性能回归，功能测试抓不到）→
    // 由 test-db-paging.js 的「首批 3 页并行」断言把守
    id: 'db-serial-paging', tag: 'perf',
    file: 'utils/db.js',
    unit: 'node tools/test-db-paging.js',
    desc: '分页退回逐页串行（每页多等一个往返）',
    from: '  const BATCH = 3;',
    to: '  const BATCH = 1;',
    expect: /并行|峰值并发/
  },
  {
    // watch 不过滤首次 init 快照 → 每次进页面数据拉两遍（实测 schedule 3 次 get 变 6 次）
    id: 'db-watch-init', tag: 'perf',
    file: 'utils/db.js',
    unit: 'node tools/test-db-paging.js',
    desc: 'watch 首次 init 不过滤（每次进页面重复拉一遍数据）',
    from: "        attempts = 0;\n        if (snapshot && snapshot.type === 'init') {\n          if (deliverReconnectInit) cb(snapshot);\n          return;\n        }",
    to: "        attempts = 0;\n        if (snapshot && snapshot.type === 'init') {\n          cb(snapshot);\n        }",
    expect: /init|过滤/
  },
  {
    // 断线重连后的 init 是断线期间变更的全量补齐；吞掉会让多设备同步停在旧状态。
    id: 'db-watch-reconnect-init', tag: 'perf',
    file: 'utils/db.js',
    unit: 'node tools/test-db-paging.js',
    desc: 'watch 重连后的 init 被吞掉（断线期间变更无法补齐）',
    from: "        if (snapshot && snapshot.type === 'init') {\n          if (deliverReconnectInit) cb(snapshot);\n          return;\n        }",
    to: "        if (snapshot && snapshot.type === 'init') {\n          return;\n        }",
    expect: /重连 init/
  },
  {
    id: 'seats-no-busy', tag: 'seats', slice: [17],
    file: 'pages/seats/seats.js',
    desc: '座位保存完全删掉防连点 guard（连点会重复写库）',
    from: "  async onSave() {\n    if (this._busy) return;              // this.data.saving 是异步的，防不住同 tick 连点\n",
    to: "  async onSave() {\n",
    expect: /连点|重复/
  },
  {
    // 门禁判定漏掉 skipped：老师点了「暂不设置」后每次启动又被弹回登录页 → 永远进不去
    id: 'login-gate-skip', tag: 'login',
    file: 'utils/profile.js',
    unit: 'node tools/test-profile.js',
    desc: '门禁不认「暂不设置」（跳过的老师每次启动都被弹回登录页）',
    from: '  return !!(p && (p.nickName || p.skipped));',
    to: '  return !!(p && p.nickName);',
    expect: /暂不设置|skip|门/
  },
  {
    // 全新用户被判成已登录 → 登录页永不出现，功能等于不存在
    id: 'login-gate-always', tag: 'login',
    file: 'utils/profile.js',
    unit: 'node tools/test-profile.js',
    desc: '门禁恒放行（登录页永远不出现）',
    from: '  return !!(p && (p.nickName || p.skipped));',
    to: '  return true;',
    expect: /isLoggedIn|登录页|未登录/
  },
  {
    // 头像不上传云存储：wxfile:// 临时路径重启后被清理 → 头像裂图
    id: 'login-avatar-temp', tag: 'login',
    file: 'utils/profile.js',
    unit: 'node tools/test-profile.js',
    desc: '头像不上传云存储，直接存临时路径（重启后裂图）',
    from: '  if (!db.isCloudReady()) return p;\n  const app = getApp();',
    to: '  if (true) return p;\n  const app = getApp();',
    expect: /cloud:\/\/|上传|头像/
  },
  {
    // 上传失败时把临时路径当持久值存下来 —— 同样是重启裂图，且老师以为存成功了
    id: 'login-avatar-fallback', tag: 'login',
    file: 'utils/profile.js',
    unit: 'node tools/test-profile.js',
    desc: '头像上传失败后拿临时路径兜底（重启裂图且无提示）',
    from: "      avatar = '';\n      warn = '头像上传失败，昵称已保存';",
    to: '      avatar = avatarTemp;\n      warn = 0 ? 1 : 0;',
    expect: /上传失败|临时路径|头像/
  },
  {
    // 云端为空时覆盖本地：换手机首启（云还没写）会把刚设的昵称清空
    id: 'login-pull-clobber', tag: 'login',
    file: 'utils/profile.js',
    unit: 'node tools/test-profile.js',
    desc: 'pull 用云端空值覆盖本地昵称（换手机首启清空刚设的名字）',
    from: '    if (!r.nickName && cur && cur.nickName) return cur;',
    to: '    if (false) return cur;',
    expect: /云端为空|覆盖|本机老师/
  },
  {
    // save 后不复位 skipped：老师明明设了真昵称，状态还留在「跳过」
    id: 'login-skip-stuck', tag: 'login',
    file: 'utils/profile.js',
    unit: 'node tools/test-profile.js',
    desc: 'save 不复位 skipped（设了真昵称仍算「跳过」状态）',
    from: "  const local = setLocal({ nickName: name, avatar, skipped: false });",
    to: '  const local = setLocal({ nickName: name, avatar });',
    expect: /skipped|复位|跳过/
  },
  {
    // 单文档集合被写成流水：每次保存都 add，云端堆积无数条，pull 拿到的是随机一条
    id: 'login-cloud-append', tag: 'login',
    file: 'utils/profile.js',
    unit: 'node tools/test-profile.js',
    desc: '身份每次保存都 add（单文档集合被撑成流水账）',
    from: '  if (rows.length && rows[0]._id) {',
    to: '  if (false) {',
    expect: /update|单文档|流水/
  },
  {
    // ensureDb 的版本门退回布尔：老用户升级后新集合永远不建（本轮真实踩到的 bug）
    id: 'schema-ver-bool', tag: 'login',
    file: 'app.js',
    // ⚠️ 不能直接用 `node tools/check.js` 当判定器：mutate 的解析器只认
    //    `N 通过 / N 失败`，check.js 打的是「发现 N 个问题」→ 判成 NO_RUN 而非 KILLED
    //    （2026-09-06 实测）。test-schema-gate.js 把它包成标准格式并补了行为断言。
    unit: 'node tools/test-schema-gate.js',
    desc: 'ensureDb 版本门退回布尔（老用户新增集合永不创建）',
    from: "    if (Number(wx.getStorageSync('mpInited')) >= SCHEMA_VER) return;",
    to: "    if (wx.getStorageSync('mpInited')) return;",
    expect: /SCHEMA|集合|mpInited/
  }
];

/* ---------------- 备份/还原：任何退出路径都要还原，否则会把 bug 留在用户代码里 ---------------- */
const dirty = new Map();      // abs path → 原始内容
function backup(rel) {
  const abs = path.join(ROOT, rel);
  if (dirty.has(abs)) return;
  const body = fs.readFileSync(abs, 'utf8');
  dirty.set(abs, body);
  fs.mkdirSync(BAK, { recursive: true });
  fs.writeFileSync(path.join(BAK, rel.replace(/\//g, '__')), body);
}
// 本轮备份过的文件 → 原始内容。dirty 在 restoreAll 里会被清空，
// 但汇总时还要用它做「真还原了吗」的比对，所以单独留一份（只含本轮碰过的文件）。
const restoredPaths = new Map();
function restoreAll() {
  for (const [abs, body] of dirty) {
    fs.writeFileSync(abs, body);
    restoredPaths.set(abs, body);
  }
  dirty.clear();
}
process.on('SIGINT', () => { console.log('\n中断，还原代码…'); restoreAll(); process.exit(130); });
process.on('SIGTERM', () => { restoreAll(); process.exit(143); });
process.on('uncaughtException', e => { restoreAll(); console.error(e); process.exit(1); });

function inject(mu) {
  const abs = path.join(ROOT, mu.file);
  backup(mu.file);
  const body = fs.readFileSync(abs, 'utf8');
  const hits = body.split(mu.from).length - 1;
  if (hits !== 1) return { okInject: false, why: `锚点匹配 ${hits} 处（要求恰好 1）—— 代码改过了，变异体要同步更新` };
  fs.writeFileSync(abs, body.replace(mu.from, mu.to));
  // 语法自检：变异体不许把文件写坏（那样测的是语法错，不是业务 bug）
  // 只对 .js 做 node -c；wxml/wxss 不是 JS，node -c 会报 get_format 错（2026-09-06 实测），
  // 那是工具链误判而非业务问题 —— wxml 的闭合校验由 tools/check.js 负责。
  if (abs.endsWith('.js')) {
    const r = spawnSync(process.execPath, ['-c', abs], { encoding: 'utf8' });
    if (r.status !== 0) { restoreAll(); return { okInject: false, why: '注入后语法错: ' + (r.stderr || '').split('\n')[0] }; }
  } else {
    const c = spawnSync(process.execPath, [path.join(__dirname, 'check.js')], { encoding: 'utf8', cwd: ROOT });
    if (c.status !== 0) { restoreAll(); return { okInject: false, why: '注入后 check.js 不过: ' + (c.stdout || c.stderr || '').split('\n').slice(-3).join(' ') }; }
  }
  return { okInject: true };
}

/* 每次抽段跑都把原始输出落盘到 /tmp/mutate-logs/<tag>.log。
 * 动因（实测）：--tag committee 连跑时两个变异体只报 `FATAL ... is not valid JSON`，
 * 汇总里看不到段内到底跑到哪一步崩的 —— 没有原始日志就只能靠猜。 */
const LOGDIR = path.join(require('os').tmpdir(), 'mutate-logs');
function runSlice(slices, label) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'e2e-slice.js'), ...slices.map(String)],
    { encoding: 'utf8', cwd: ROOT, maxBuffer: 1 << 24 });
  const out = (r.stdout || '') + (r.stderr || '');
  let logPath = '';
  try {
    fs.mkdirSync(LOGDIR, { recursive: true });
    logPath = path.join(LOGDIR, (label || 'slice-' + slices.join('_')).replace(/[^\w.-]/g, '_') + '.log');
    fs.writeFileSync(logPath, out);
  } catch (e) { /* 落盘失败不该拖垮测试 */ }
  const mm = out.match(/=====\s*(\d+) 通过 \/ (\d+) 失败\s*=====/);
  const fl = out.match(/SLICE_FAIL_LIST::(.*)/);
  /* JSON.parse 不许裸奔：SLICE_FAIL_LIST 那行若被 maxBuffer 截断或掺进别的输出，
   * 裸 parse 会把 mutate 整个打挂，还会被误读成「变异体让工具崩了」。 */
  let failures = [];
  let parseErr = '';
  if (fl) {
    try { failures = JSON.parse(fl[1]); }
    catch (e) {
      parseErr = e.message || String(e);
      failures = ['(SLICE_FAIL_LIST 解析失败: ' + parseErr + ') 原始片段: ' + fl[1].slice(0, 200)];
    }
  }
  return {
    pass: mm ? Number(mm[1]) : -1,
    fail: mm ? Number(mm[2]) : -1,
    failures, parseErr, logPath,
    raw: out
  };
}

/* 用纯逻辑单测当判定器（变异体带 unit 字段时走这条）。
 * 动因：拍照导名单的学号分配逻辑不需要模拟器，塞进 14min 的 e2e 里跑纯属浪费；
 * 但它守的是外键生成路径，必须有蓝队覆盖。所以判定器换成 tools/test-*.js。
 * 输出格式与 runSlice 对齐（pass/fail/failures），上层判定逻辑零改动。 */
function runUnit(cmd, label) {
  const parts = cmd.split(' ').filter(Boolean);
  const r = spawnSync(parts[0] === 'node' ? process.execPath : parts[0], parts.slice(1),
    { encoding: 'utf8', cwd: ROOT, maxBuffer: 1 << 24 });
  const out = (r.stdout || '') + (r.stderr || '');
  let logPath = '';
  try {
    fs.mkdirSync(LOGDIR, { recursive: true });
    logPath = path.join(LOGDIR, (label || 'unit').replace(/[^\w.-]/g, '_') + '.log');
    fs.writeFileSync(logPath, out);
  } catch (e) { /* 落盘失败不该拖垮测试 */ }
  const mm = out.match(/(\d+) 通过 \/ (\d+) 失败/);
  // 失败项从 `  ❌ 用例名` 行抠出来，喂给 expect 判定（与 e2e 的 SLICE_FAIL_LIST 等价）
  const failures = (out.match(/^\s*❌ .*$/gm) || []).map(x => x.replace(/^\s*❌\s*/, '').trim());
  return {
    pass: mm ? Number(mm[1]) : -1,
    fail: mm ? Number(mm[2]) : (r.status === 0 ? 0 : -1),
    failures, parseErr: '', logPath, raw: out
  };
}

/* 锚点自检：业务代码一改，变异体的 from 字符串就可能失配（改成 0 处或 2 处）。
 * 失配的后果不是「报错」而是**静默漏测**：`inject()` 返回 okInject:false，那个变异体被跳过，
 * 汇总里看不出少了一个 —— 门禁以为自己在守，其实没守。
 * 实测：给 roster.js 的 removeCascade 加 committee 后，`dutySchedule` 那行末尾多了个逗号，
 * `duty-cascade-off` 锚点立刻变 0 处。所以做成能单跑的常驻门禁（<0.1s，接进 check 流程）。 */
function checkAnchors() {
  const rows = MUTANTS.map(mu => {
    const abs = path.join(ROOT, mu.file);
    let n = -1;
    try { n = fs.readFileSync(abs, 'utf8').split(mu.from).length - 1; } catch (e) { n = -2; }
    return { id: mu.id, file: mu.file, n };
  });
  const bad = rows.filter(r => r.n !== 1);
  rows.forEach(r => console.log(`  ${r.n === 1 ? '✅' : '❌'} ${r.id.padEnd(24)} ${r.file}  锚点 ${r.n} 处`));
  if (bad.length) {
    console.log(`\n❌ ${bad.length} 个变异体锚点失配（要求恰好 1 处）—— 业务代码改过了，`
      + `变异体的 from 必须同步更新，否则它会被静默跳过、门禁形同虚设`);
    return false;
  }
  console.log(`\n✅ ${rows.length} 个变异体锚点全部恰好匹配 1 处`);
  return true;
}

(async () => {
  const argv = process.argv.slice(2);
  if (argv.includes('--check-anchors')) {
    console.log(`变异体锚点自检（${MUTANTS.length} 个）：`);
    process.exit(checkAnchors() ? 0 : 1);
  }
  if (!argv.length || argv.includes('--list')) {
    console.log('变异体清单（' + MUTANTS.length + ' 个）：');
    MUTANTS.forEach(m => console.log(`  ${m.id.padEnd(20)} [${m.tag}] slice=${(m.slice || []).join(',')}  ${m.desc}`));
    console.log('\n用法: node tools/mutate.js <id> | --tag <tag> | --all | --check-anchors');
    process.exit(0);
  }

  let list;
  if (argv.includes('--all')) list = MUTANTS;
  else if (argv[0] === '--tag') list = MUTANTS.filter(m => m.tag === argv[1]);
  else list = MUTANTS.filter(m => argv.includes(m.id));
  if (!list.length) { console.error('❌ 没匹配到变异体，--list 看清单'); process.exit(2); }

  // 先过锚点自检：失配的变异体会被静默跳过，跑完还以为门禁有效
  {
    const rows = list.map(mu => {
      let n = -1;
      try { n = fs.readFileSync(path.join(ROOT, mu.file), 'utf8').split(mu.from).length - 1; } catch (e) { n = -2; }
      return { id: mu.id, n };
    }).filter(r => r.n !== 1);
    if (rows.length) {
      console.log('❌ 锚点失配，先修变异体的 from 字符串：');
      rows.forEach(r => console.log(`   ${r.id} 匹配 ${r.n} 处（要求 1）`));
      process.exit(2);
    }
  }

  // 基线：不注入时必须全绿，否则「变红」无法归因（可能本来就是红的）
  const slices = [...new Set(list.filter(m => !m.unit).flatMap(m => m.slice))].sort((a, b) => a - b);
  console.log(`\n【基线】先确认 slice ${slices.join(',')} 干净时全绿（否则变红无法归因）`);
  if (slices.length) {
    const base = runSlice(slices, 'baseline');
    console.log(`  基线: ${base.pass} 通过 / ${base.fail} 失败`);
    if (base.fail !== 0) {
      console.log('  ❌ 基线就是红的，先修好再做变异测试。失败项：');
      base.failures.forEach(f => console.log('     - ' + f));
      process.exit(3);
    }
  } else {
    console.log('  （本批全是 unit 型变异体，无 e2e 段）');
  }
  // unit 型判定器的基线也要确认干净，否则「变红」同样无法归因
  const units = [...new Set(list.filter(m => m.unit).map(m => m.unit))];
  for (const u of units) {
    const ub = runUnit(u, 'baseline-unit');
    console.log(`  基线[${u}]: ${ub.pass} 通过 / ${ub.fail} 失败`);
    if (ub.fail !== 0) {
      console.log('  ❌ 单测基线就是红的，先修好再做变异测试');
      ub.failures.forEach(f => console.log('     - ' + f));
      process.exit(3);
    }
  }

  const results = [];
  for (const mu of list) {
    console.log(`\n【变异】${mu.id} —— ${mu.desc}`);
    const inj = inject(mu);
    if (!inj.okInject) {
      console.log('  ⚠️ 注入失败: ' + inj.why);
      results.push({ id: mu.id, verdict: 'INJECT_FAIL', why: inj.why });
      restoreAll();
      continue;
    }
    const r = mu.unit ? runUnit(mu.unit, mu.id) : runSlice(mu.slice, mu.id);
    restoreAll();
    if (r.fail > 0) {
      const hit = r.failures.some(f => mu.expect.test(f));
      console.log(`  ✅ KILLED（${r.fail} 条断言变红）`);
      if (r.parseErr) console.log('  ⚠️ SLICE_FAIL_LIST 解析异常: ' + r.parseErr);
      r.failures.slice(0, 4).forEach(f => console.log('     ↳ ' + f.slice(0, 110)));
      if (!hit) console.log(`  ⚠️ 但没命中期望断言 /${mu.expect.source}/ —— 可能是连带崩溃而非精准捕获，值得看一眼`);
      if (!hit && r.logPath) console.log('     原始日志: ' + r.logPath);
      results.push({ id: mu.id, verdict: hit ? 'KILLED' : 'KILLED_OFFTARGET', fail: r.fail });
    } else if (r.fail === 0) {
      console.log('  ❌ SURVIVED —— 门禁有洞！这个 bug 能带着上线，必须补断言');
      results.push({ id: mu.id, verdict: 'SURVIVED' });
    } else {
      console.log('  ⚠️ 段没跑起来（自动化抖动？）原始输出末尾：');
      console.log(r.raw.split('\n').slice(-6).join('\n'));
      results.push({ id: mu.id, verdict: 'NO_RUN' });
    }
  }

  restoreAll();

  // ⚠️ 变异测试会故意制造脏数据（duty-cascade-off / seats-cascade-off 就是「删学生不级联」，
  //    跑完必然在库里留孤儿 + 残留探针学生 DUTY999/SEAT999）。不清掉的话下一次跑
  //    e2e/audit 会红在莫名其妙的地方（实测：学生数从 30 变 31，红队守恒律跟着飘）。
  if (results.some(r => /^KILLED|SURVIVED/.test(r.verdict))) {
    console.log('\n【收尾】变异体制造的脏数据要清掉（否则污染后续所有断言）');
    const r = spawnSync(process.execPath, [path.join(__dirname, 'audit-data.js'), '--fix'],
      { encoding: 'utf8', cwd: ROOT, maxBuffer: 1 << 24 });
    const fixed = ((r.stdout || '').match(/"删[^"]*": (\d+)/g) || [])
      .map(x => Number(x.match(/(\d+)/)[1])).reduce((a, b) => a + b, 0);
    console.log(`  audit --fix 清理了 ${fixed} 条脏记录`);
    const r2 = spawnSync(process.execPath, [path.join(__dirname, 'audit-data.js')],
      { encoding: 'utf8', cwd: ROOT, maxBuffer: 1 << 24 });
    console.log('  ' + (/数据卫生检查通过/.test(r2.stdout || '') ? '✅ 数据已恢复干净' : '❌ 仍有脏数据，手动跑 node tools/audit-data.js 看详情'));
  }

  // 双重保险：确认工作区真的干净。
  // ⚠️ 只能比对**本轮真正备份过的文件**（dirty map 的 key），不能拿 /tmp/mutate-backup 里的
  //    历史残留比 —— 那些文件可能是上一轮甚至上一周留下的，与当前正确代码天然不同。
  //    实测假红：跑 comm-warn-off（只碰 committee.js）时，11:39 的旧 roster 备份让它报
  //    「代码没还原干净: pages/roster/roster.js」并 exit 4，而 roster 本轮根本没被动过。
  const stillDirty = [...restoredPaths.entries()]
    .filter(([abs, orig]) => fs.readFileSync(abs, 'utf8') !== orig)
    .map(([abs]) => path.relative(ROOT, abs));

  console.log('\n================ 变异测试汇总 ================');
  const killed = results.filter(r => /^KILLED/.test(r.verdict)).length;
  const survived = results.filter(r => r.verdict === 'SURVIVED');
  results.forEach(r => console.log(`  ${r.verdict.padEnd(17)} ${r.id}${r.why ? ' :: ' + r.why : ''}`));
  console.log(`\n杀死 ${killed}/${results.length}，存活 ${survived.length}`);
  if (stillDirty.length) { console.log('❌ 代码没还原干净: ' + stillDirty.join(', ') + '（备份在 ' + BAK + '）'); process.exit(4); }
  console.log('✅ 业务代码已全部还原');
  if (survived.length) { console.log('❌ 存活变异体 = 门禁盲点: ' + survived.map(r => r.id).join(', ')); process.exit(1); }
  process.exit(0);
})();
