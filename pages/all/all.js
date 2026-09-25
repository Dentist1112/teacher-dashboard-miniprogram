// 全部功能目录：所有功能分组平铺，任何功能 ≤2 次点击
// tone = 图标底色档位（app.wxss 的 .gm-ic.t1~t6），按分组给，让每组一眼可分
const ALL = [
  { group: '概览', tone: 't1', items: [
    { label: '首页概览', icon: '🏠', path: '/pages/dashboard/dashboard', tab: true },
  ]},
  { group: '班级管理', tone: 't5', items: [
    { label: '学生名单', icon: '👥', path: '/pages/roster/roster', tab: true },
    { label: '座位表', icon: '🪑', path: '/pages/seats/seats' },
    { label: '课程表', icon: '📚', path: '/pages/schedule/schedule' },
    { label: '值日表', icon: '🧹', path: '/pages/duty/duty' },
    { label: '班委名单', icon: '🎖️', path: '/pages/committee/committee' },
  ]},
  { group: '成绩学业', tone: 't1', items: [
    { label: '成绩录入', icon: '📈', path: '/pages/grades/grades', tab: true },
    { label: '数据分析', icon: '📊', path: '/pages/analytics/analytics' },
  ]},
  { group: '日常管理', tone: 't3', items: [
    { label: '考勤管理', icon: '🗓️', path: '/pages/attendance/attendance', tab: true },
    { label: '班级通知', icon: '📣', path: '/pages/announcement/announcement', tab: true },
    { label: '待办清单', icon: '✅', path: '/pages/todo/todo' },
    { label: '作业布置', icon: '📝', path: '/pages/homework/homework' },
    { label: '奖惩记录', icon: '⭐', path: '/pages/rewards/rewards' },
  ]},
  { group: '学生关怀', tone: 't4', items: [
    { label: '学生档案', icon: '🗂️', path: '/pages/profile/profile' },
  ]},
  { group: '系统', tone: 't6', items: [
    { label: '数据管理', icon: '⚙️', path: '/pages/settings/settings' },
  ]},
];

Page({
  data: { groups: ALL },
  go(e) {
    const path = e.currentTarget.dataset.path;
    const tab = e.currentTarget.dataset.tab === 'true' || e.currentTarget.dataset.tab === true;
    if (!path) return;
    if (tab) wx.switchTab({ url: path });
    else wx.navigateTo({ url: path });
  }
});
