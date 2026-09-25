// 自定义底部导航：薄荷×蜜桃主题，字号 26rpx（≈13px），比原生 10px 大一档
// 每个 tab 页 onShow 里调用：this.getTabBar().setData({ selected: N })
const TABS = [
  { pagePath: '/pages/dashboard/dashboard', text: '首页', icon: '🏠' },
  { pagePath: '/pages/roster/roster', text: '名单', icon: '👥' },
  { pagePath: '/pages/grades/grades', text: '成绩', icon: '📈' },
  { pagePath: '/pages/attendance/attendance', text: '考勤', icon: '🗓️' },
  { pagePath: '/pages/announcement/announcement', text: '通知', icon: '📣' }
];

Component({
  data: { selected: 0, hidden: false, list: TABS },
  methods: {
    onTap(e) {
      const i = Number(e.currentTarget.dataset.index);
      const t = TABS[i];
      if (!t || i === this.data.selected) return;
      wx.switchTab({ url: t.pagePath });
      this.setData({ selected: i });
    }
  }
});
