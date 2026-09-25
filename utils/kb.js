// 键盘避让：弹层表单的「保存/发布」按钮被软键盘挡住的通用解。
//
// 为什么需要：本项目所有表单弹层都是 `.mask{position:fixed}` + `.form-sheet` 贴底。
// 微信默认的 adjust-position 只上推**普通文档流**里的输入框，fixed 定位的弹层不受影响 ——
// 键盘一弹起来就盖住弹层底部的操作条，老师看到的现象正是「只能打字，找不到保存按钮」
// （用户真机反馈 2026-09-06）。模拟器窗口高 742px 且没有真键盘，肉眼永远发现不了。
//
// 用法（页面里 3 行）：
//   const kb = require('../../utils/kb.js');
//   onLoad() { kb.bind(this); }        // 会往 data 里写 kbH（px）
//   onUnload() { kb.unbind(this); }
// WXML：<view class="form-sheet" style="{{kbH ? 'margin-bottom:'+kbH+'px' : ''}}">
//
// 约定：kbH 只在 >0 时变化才 setData，避免键盘收起/弹出的高频回调打爆渲染。
//
// ⚠️ 2026-09-12 真机 bug（发布通知点了没反应）：
// 老师在键盘弹起状态下点「发布」，事件顺序是 touchstart → 输入框失焦 → 键盘开始收起
// → onKeyboardHeightChange(0) → kbH 立刻归零 → 整个 sheet 下坠 → touchend/tap 命中的
// 已经不是按钮而是盖在上面的 mask（mask catchtap=取消），结果弹层关闭、通知没发出去。
// 模拟器没有软键盘，回调永远不触发，e2e 全绿也测不出来。
// 修法：收到 0 不立即归零，延迟 HIDE_DELAY 再收 —— tap 在这 450ms 内已经派发完，
// sheet 位置不动，按钮该触发保存就触发保存。单测见 tools/test-kb.js。

const HIDE_DELAY = 450;

function bind(page) {
  if (!page || page.__kbBound) return;
  page.__kbBound = true;
  if (page.data.kbH === undefined) page.setData({ kbH: 0 });
  page.__kbHandler = res => {
    // 不做 Math.max(0,…)：负高度会被下面 `if (h > 0)` 挡掉、走归零逻辑，
    // kbH 永远不会被 setData 成负数（test-kb.js「负数高度最终兜底为 0」守这条可观测行为）。
    const h = Math.round((res && res.height) || 0);
    if (h > 0) {
      // 键盘重新弹起（或切换键盘高度变化）：取消等待中的归零，立即顶到新高度
      if (page.__kbHideTimer) {
        clearTimeout(page.__kbHideTimer);
        page.__kbHideTimer = null;
      }
      if (page.data.kbH !== h) page.setData({ kbH: h });
      return;
    }
    // h === 0：延迟归零（理由见文件头注释）。重复的 0 回调不重建定时器。
    if (page.data.kbH === 0 || page.__kbHideTimer) return;
    page.__kbHideTimer = setTimeout(() => {
      page.__kbHideTimer = null;
      // unbind 后页面可能已销毁，不再 setData
      if (page.__kbBound && page.data.kbH) page.setData({ kbH: 0 });
    }, HIDE_DELAY);
  };
  if (wx.onKeyboardHeightChange) wx.onKeyboardHeightChange(page.__kbHandler);
}

function unbind(page) {
  if (!page || !page.__kbBound) return;
  if (page.__kbHideTimer) {
    clearTimeout(page.__kbHideTimer);
    page.__kbHideTimer = null;
  }
  if (wx.offKeyboardHeightChange && page.__kbHandler) wx.offKeyboardHeightChange(page.__kbHandler);
  page.__kbBound = false;
  page.__kbHandler = null;
}

module.exports = { bind, unbind, HIDE_DELAY };
