#!/usr/bin/env node
const modal = require('../utils/modal.js');
let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
};
function makePage(hidden) {
  let sets = 0;
  const tb = {
    data: { hidden: !!hidden },
    setData(o) { sets++; Object.assign(this.data, o); }
  };
  const page = { getTabBar: () => tb, _sets: () => sets };
  return { page, tb };
}

console.log('[modal tabBar]');
let x = makePage(false);
modal.hideTabBar(x.page);
ok('hide 显示中的导航', x.tb.data.hidden === true && x.page._sets() === 1);
modal.hideTabBar(x.page);
ok('hide 幂等，不重复 setData', x.tb.data.hidden === true && x.page._sets() === 1);
modal.showTabBar(x.page);
ok('show 隐藏中的导航', x.tb.data.hidden === false && x.page._sets() === 2);
modal.showTabBar(x.page);
ok('show 幂等，不重复 setData', x.tb.data.hidden === false && x.page._sets() === 2);
modal.syncTabBar(x.page, true);
ok('sync true 隐藏导航', x.tb.data.hidden === true && x.page._sets() === 3);
modal.syncTabBar(x.page, true);
ok('sync true 幂等', x.tb.data.hidden === true && x.page._sets() === 3);
modal.syncTabBar(x.page, false);
ok('sync false 恢复导航', x.tb.data.hidden === false && x.page._sets() === 4);

let called = false;
modal.hideTabBar({ getTabBar() { called = true; throw new Error('tab bar unavailable'); } });
modal.showTabBar({ getTabBar: () => null });
modal.syncTabBar(null, true);
ok('tabBar 不存在或组件异常时降级不崩', called === true);

console.log(`\nmodal: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
