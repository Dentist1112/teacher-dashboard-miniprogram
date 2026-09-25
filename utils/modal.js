// 自定义 tabBar 是独立组件层：实测 z-index 高过它也会继续盖在 tab 页弹层底部。
// 模态表单打开期间必须直接隐藏 tabBar，关闭或离开页面时恢复。
function getTabBar(page) {
  if (!page || typeof page.getTabBar !== 'function') return null;
  try { return page.getTabBar(); } catch (e) { return null; }
}

function hideTabBar(page) {
  const tb = getTabBar(page);
  if (tb && !tb.data.hidden) tb.setData({ hidden: true });
}

function showTabBar(page) {
  const tb = getTabBar(page);
  if (tb && tb.data.hidden) tb.setData({ hidden: false });
}

function syncTabBar(page, modalOpen) {
  const tb = getTabBar(page);
  if (tb && tb.data.hidden !== !!modalOpen) tb.setData({ hidden: !!modalOpen });
}

module.exports = { hideTabBar, showTabBar, syncTabBar };
