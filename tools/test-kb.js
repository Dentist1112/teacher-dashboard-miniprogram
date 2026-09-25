// 守护 utils/kb.js：软键盘避让。
// 为什么必须单测：模拟器没有真键盘，wx.onKeyboardHeightChange 永远不触发 ——
// 这条逻辑在开发者工具里 100% 测不到，只能在 Node 里模拟回调。
const handlers = [];
global.wx = {
  onKeyboardHeightChange(fn) { handlers.push(fn); },
  offKeyboardHeightChange(fn) { const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1); }
};
const KB_PATH = require('path').resolve(__dirname, '..', 'utils', 'kb.js');
delete require.cache[KB_PATH];
const kb = require(KB_PATH);

let pass = 0, fail = 0;
const ok = m => { pass++; console.log('  ✅ ' + m); };
const bad = m => { fail++; console.log('  ❌ ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const assert = (cond, m) => cond ? ok(m) : bad(m);

function mockPage() {
  return {
    data: {},
    setDataCalls: 0,
    setData(o) { this.setDataCalls += 1; Object.assign(this.data, o); }
  };
}

(async () => {
  // 绑定后 kbH 初始化为 0
  const pg = mockPage();
  kb.bind(pg);
  assert(pg.data.kbH === 0, 'bind 后 kbH 初始化为 0');
  assert(handlers.length === 1, '已注册 onKeyboardHeightChange');
  const h = handlers[0];

  // 键盘弹起
  h({ height: 336 });
  assert(pg.data.kbH === 336, '键盘弹起 kbH=336');

  // 同高度重复回调不许再 setData（安卓一次弹起连报 5~10 次，重复 setData 拖慢输入）
  const n1 = pg.setDataCalls;
  h({ height: 336 }); h({ height: 336 });
  assert(pg.setDataCalls === n1, '同高度重复回调不触发 setData（避免高频渲染）');

  // 小数高度取整（安卓上报 335.6，style 里不许出现长小数）
  h({ height: 335.6 });
  assert(pg.data.kbH === 336, '高度取整（335.6 → 336）');

  // 真机 bug 核心：键盘收起（点「发布」瞬间）kbH 必须延迟归零，不能立刻下坠
  h({ height: 300 });
  h({ height: 0 });
  assert(pg.data.kbH === 300, '键盘收起后 kbH 暂时保持 300（等 tap 派发完，不许立刻下坠）');
  await sleep(120);
  assert(pg.data.kbH === 300, '收起后 120ms 仍保持（tap 窗口内不能动）');
  await sleep(kb.HIDE_DELAY - 120 + 80);
  assert(pg.data.kbH === 0, `延迟 ${kb.HIDE_DELAY}ms 后 kbH 归零`);

  // 等待归零期间键盘重新弹起：取消归零，立即顶到新高度，且延迟后不许掉回 0
  h({ height: 280 });
  h({ height: 0 });
  await sleep(100);
  assert(pg.data.kbH === 280, '收起等待中保持 280');
  h({ height: 320 });
  assert(pg.data.kbH === 320, '等待归零期间重新弹起 → 立即顶到 320');
  await sleep(kb.HIDE_DELAY + 80);
  assert(pg.data.kbH === 320, '重新弹起后旧的归零定时器被取消（不会中途掉回 0）');

  // 负数/缺字段/null：兜底按「键盘已收起」处理，最终是 0，不会出现负数
  h({ height: -20 });
  await sleep(kb.HIDE_DELAY + 80);
  assert(pg.data.kbH === 0, '负数高度最终兜底为 0');
  h({ height: 300 }); h({});
  await sleep(kb.HIDE_DELAY + 80);
  assert(pg.data.kbH === 0, '缺 height 字段兜底为 0');
  h({ height: 300 }); h(null);
  await sleep(kb.HIDE_DELAY + 80);
  assert(pg.data.kbH === 0, '回调传 null 不崩且归零');

  // 重复 bind 幂等
  kb.bind(pg);
  assert(handlers.length === 1, '重复 bind 幂等（仍 1 个监听）');

  // unbind 摘掉监听，且等待中的归零定时器不许在页面销毁后补刀 setData
  let setAfterUnbind = false;
  const pg2 = mockPage();
  const origSet2 = pg2.setData.bind(pg2);
  pg2.setData = function (o) { if (!this.__kbBound) setAfterUnbind = true; origSet2(o); };
  kb.bind(pg2);
  const h2 = handlers[handlers.length - 1];
  h2({ height: 300 }); h2({ height: 0 });
  assert(pg2.data.kbH === 300, '第二个页面收起也延迟归零');
  kb.unbind(pg2);
  assert(handlers.length === 1, 'unbind 摘掉监听（页面销毁不泄漏）');
  await sleep(kb.HIDE_DELAY + 80);
  assert(!setAfterUnbind, 'unbind 后等待中的归零不补刀 setData');
  kb.unbind(pg2);
  ok('重复 unbind 不崩');

  // unbind 后可重新 bind
  kb.bind(pg2);
  assert(handlers.length === 2, 'unbind 后可重新 bind');
  kb.unbind(pg2);

  // 旧版微信无 onKeyboardHeightChange 时降级不崩
  const savedOn = global.wx.onKeyboardHeightChange;
  delete global.wx.onKeyboardHeightChange;
  try {
    const pg3 = mockPage();
    kb.bind(pg3); kb.unbind(pg3);
    assert(pg3.data.kbH === 0, '旧版微信无 onKeyboardHeightChange 时降级不崩');
  } catch (e) { bad('旧版降级崩了: ' + e.message); }
  global.wx.onKeyboardHeightChange = savedOn;

  // 传 null 不崩
  try { kb.bind(null); kb.unbind(null); ok('传 null 页面不崩'); } catch (e) { bad('null 页面崩了: ' + e.message); }

  console.log(`\nkb: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
