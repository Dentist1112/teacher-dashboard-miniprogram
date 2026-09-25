#!/usr/bin/env node
/**
 * 弹层表单可视性探针（用户反馈「新加通知没有保存按钮，通知添加不了」，2026-09-06）。
 *
 * 根因不是缺按钮 —— WXML 里 .form-actions 一直在，是 .form-sheet 没有 max-height/overflow，
 * 内容超屏后按钮被顶到可视区外且无法滚动。**肉眼在模拟器里看不出来**（模拟器窗口比手机高），
 * 所以必须量数值：按钮的 boundingClientRect 是否落在窗口高度内，以及弹层是否可滚。
 *
 * 用法: node tools/probe-sheet.js
 */
const { connectOrLaunch, sleep, evalRetry } = require('./mp.js');

// [页面, 打开表单的方法, 说明]
// [页面, 打开表单的方法名, 说明, 打开前的准备（可选，跑在小程序里）]
const CASES = [
  ['/pages/announcement/announcement', 'onAdd', '发布通知'],
  ['/pages/grades/grades', 'onEditExam', '新建考试'],
  ['/pages/roster/roster', 'onAdd', '新增学生'],
  ['/pages/homework/homework', 'onAdd', '布置作业'],
  ['/pages/rewards/rewards', 'onAdd', '登记奖惩'],
  // 档案编辑必须先进详情页（onEditProfile 依赖 data.current）
  ['/pages/profile/profile', 'onEditProfile', '编辑档案', 'openFirstDetail']
];

let pass = 0, fail = 0;
const ok = m => { pass++; console.log('  ✅ ' + m); };
const bad = m => { fail++; console.log('  ❌ ' + m); };

(async () => {
  const { mp } = await connectOrLaunch();
  try {
    for (const [route, opener, label, prep] of CASES) {
      console.log(`\n[${label}] ${route}`);
      await mp.reLaunch(route);
      // 等到页面栈真的落到目标页：reLaunch 返回 ≠ 新页 onLoad 完成，
      // 抢跑会拿到上一个页面对象（实测 announcement 第一次探到的是残留页，报「找不到 onAdd」）
      const want = route.slice(1);
      for (let i = 0; i < 40; i++) {
        const r = await evalRetry(mp, () => {
          const pg = getCurrentPages().slice(-1)[0];
          return pg ? { route: pg.route, loading: pg.data.loading } : { route: '' };
        });
        if (r.route === want && r.loading !== true) break;
        await sleep(150);
      }
      await sleep(400);
      if (prep === 'openFirstDetail') {
        await evalRetry(mp, () => {
          const pg = getCurrentPages().slice(-1)[0];
          const first = (pg.data.list || pg.data.students || [])[0];
          if (first && typeof pg.onOpenDetail === 'function') {
            pg.onOpenDetail({ currentTarget: { dataset: { id: first._id } } });
          }
          return !!(pg.data.current || {})._id;
        });
        await sleep(500);
      }
      // 找一个能打开表单的方法（各页命名不同，逐个试）
      // 方法要重试查：页面刚 onLoad 时 Page 实例的方法已挂全，但 reLaunch 到 tabBar 页时
      // 页面栈末位可能还是上一个页（自定义 tabBar 的切换是两段式），实测偶发拿到残留页。
      let opened = null;
      for (let i = 0; i < 12; i++) {
        opened = await evalRetry(mp, (op, want2) => {
          const stack = getCurrentPages();
          const pg = stack.filter(p => p.route === want2).slice(-1)[0] || stack.slice(-1)[0];
          const cands = [op, 'onAdd', 'onOpenForm', 'onEditExam', 'onEditProfile'].filter(n => typeof pg[n] === 'function');
          if (!cands.length) return { err: 'no-opener', route: pg.route, stack: stack.map(p => p.route), keys: Object.keys(pg).filter(k => /^on/.test(k)).slice(0, 24) };
          return { ready: 1, used: cands[0] };
        }, [opener, want]);
        if (!opened.err) break;
        await sleep(300);
      }
      if (opened.err) { bad(`${label}: 找不到打开表单的方法（route=${opened.route} stack=${JSON.stringify(opened.stack)} keys=${JSON.stringify(opened.keys)}）`); continue; }
      opened = await evalRetry(mp, (op, want2) => {
        const stack = getCurrentPages();
        const pg = stack.filter(p => p.route === want2).slice(-1)[0] || stack.slice(-1)[0];
        const cands = [op, 'onAdd', 'onOpenForm', 'onEditExam', 'onEditProfile'].filter(n => typeof pg[n] === 'function');
        if (!cands.length) return { err: 'no-opener', route: pg.route, stack: stack.map(p => p.route), keys: Object.keys(pg).filter(k => /^on/.test(k)).slice(0, 24) };
        // 有的表单需要先有一条数据（如档案编辑），传第一条的 id
        const first = (pg.data.students || pg.data.list || pg.data.notices || [])[0];
        const ev = { currentTarget: { dataset: { id: first && first._id, index: 0 } } };
        pg[cands[0]](ev);
        return { used: cands[0], showForm: pg.data.showForm, showExamForm: pg.data.showExamForm };
      }, [opener, want]);
      if (opened.err) { bad(`${label}: 找不到打开表单的方法（${JSON.stringify(opened.keys)}）`); continue; }
      console.log('     opener=' + JSON.stringify(opened));
      await sleep(800);

      // ⚠️ 不能在 evaluate 里用 wx.createSelectorQuery().exec(cb)：回调在 automator 里不回传，
      //    evaluate 直接超时（2026-09-06 实测三次重试全挂）。用 automator 的元素 API 量。
      const page = await mp.currentPage();
      const winH = await evalRetry(mp, () => {
        const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
        return info.windowHeight;
      });
      // 元素查询要重试：setData → 渲染层落地有延迟，一次查不到不代表没渲染
      let sheetEl = null, actEl = null;
      for (let i = 0; i < 12; i++) {
        sheetEl = await page.$('.form-sheet') || await page.$('.exam-sheet');
        actEl = await page.$('.form-actions');
        if (sheetEl && actEl) break;
        await sleep(250);
      }
      if (!sheetEl) { bad(`${label}: 弹层 .form-sheet 未渲染（表单没打开？）`); continue; }
      if (!actEl) { bad(`${label}: 没有 .form-actions（真的缺按钮）`); continue; }
      const sheetSize = await sheetEl.size();
      const sheetOff = await sheetEl.offset();
      const actSize = await actEl.size();
      const actOff = await actEl.offset();
      const geo = {
        winH,
        sheet: { height: sheetSize.height, top: sheetOff.top },
        actions: [{ top: actOff.top, bottom: actOff.top + actSize.height }],
        scroll: null
      };
      const acts = (geo.actions || []).filter(Boolean);
      if (!acts.length) { bad(`${label}: 没有 .form-actions（真的缺按钮）`); continue; }
      const a = acts[0];
      const visible = a.top >= 0 && a.bottom <= geo.winH + 1;
      const sheetFits = geo.sheet.height <= geo.winH + 1;
      const scrollable = geo.scroll && geo.scroll.scrollHeight > geo.sheet.height + 1;
      console.log(`     窗口高 ${geo.winH}px / 弹层高 ${Math.round(geo.sheet.height)}px / 按钮 top ${Math.round(a.top)} bottom ${Math.round(a.bottom)} / 内容高 ${geo.scroll ? Math.round(geo.scroll.scrollHeight) : '-'}`);
      visible
        ? ok(`${label}: 操作按钮在可视区内（bottom ${Math.round(a.bottom)} ≤ 窗口 ${geo.winH}）`)
        : bad(`${label}: 操作按钮超出可视区 ${Math.round(a.bottom - geo.winH)}px —— 老师点不到`);
      sheetFits
        ? ok(`${label}: 弹层高度不超屏（${Math.round(geo.sheet.height)} ≤ ${geo.winH}）`)
        : bad(`${label}: 弹层高 ${Math.round(geo.sheet.height)} > 窗口 ${geo.winH}，需要 max-height`);
      if (scrollable) ok(`${label}: 内容超出时弹层可滚动（内容 ${Math.round(geo.scroll.scrollHeight)} > 容器 ${Math.round(geo.sheet.height)}）`);

      // 输入框必须能收到输入（用户反馈「文本输入不了」的通用回归）
      const typed = await evalRetry(mp, (want2) => {
        const stack = getCurrentPages();
        const pg = stack.filter(p => p.route === want2).slice(-1)[0] || stack.slice(-1)[0];
        if (typeof pg.onInput !== 'function') return { skip: 1 };
        const before = JSON.stringify(pg.data.form || {});
        pg.onInput({ currentTarget: { dataset: { field: 'title' } }, detail: { value: '探针标题' } });
        return { before, after: JSON.stringify(pg.data.form || {}), showForm: pg.data.showForm };
      }, [want]);
      if (!typed.skip) {
        /探针标题/.test(typed.after) && typed.showForm !== false
          ? ok(`${label}: 输入能写进 form 且弹层未被关掉`)
          : bad(`${label}: 输入未生效或弹层被关: ${JSON.stringify(typed)}`);
      }

      await evalRetry(mp, () => {
        const pg = getCurrentPages().slice(-1)[0];
        ['onFormCancel', 'onCancel', 'onCloseForm', 'onExamFormCancel'].forEach(n => { if (typeof pg[n] === 'function') pg[n](); });
      });
      await sleep(200);
    }
    console.log(`\n弹层可视性: ${pass} 通过 / ${fail} 失败`);
  } finally {
    await mp.disconnect();
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
