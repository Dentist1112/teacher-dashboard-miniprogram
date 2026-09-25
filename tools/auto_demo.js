// 小程序自动演示脚本：按顺序跳转每个功能页，模拟点击操作
const automator = require('miniprogram-automator');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9491' });
  console.log('CONNECTED');

  const pages = [
    // [名称, 路由, 方法, 停留秒数]
    ['首页概览', '/pages/dashboard/dashboard', 'reLaunch', 3500],
    ['学生名单', '/pages/roster/roster', 'switchTab', 3000],
    ['考勤登记', '/pages/attendance/attendance', 'switchTab', 3500],
    ['成绩录入', '/pages/grades/grades', 'reLaunch', 3500],
    ['作业管理', '/pages/homework/homework', 'reLaunch', 3500],
    ['值日表', '/pages/duty/duty', 'reLaunch', 3500],
    ['课程表', '/pages/schedule/schedule', 'reLaunch', 3500],
    ['班委名单', '/pages/committee/committee', 'reLaunch', 3500],
    ['奖惩登记', '/pages/rewards/rewards', 'reLaunch', 3000],
    ['学生档案', '/pages/profile/profile', 'reLaunch', 3000],
    ['座位表', '/pages/seats/seats', 'reLaunch', 3000],
    ['通知公告', '/pages/announcement/announcement', 'switchTab', 3000],
    ['设置', '/pages/settings/settings', 'switchTab', 2500],
    ['回到首页', '/pages/dashboard/dashboard', 'reLaunch', 3000],
  ];

  for (const [name, route, method, delay] of pages) {
    console.log('→ ' + name);
    try {
      if (method === 'switchTab') {
        await mp.switchTab(route);
      } else {
        await mp.reLaunch(route);
      }
      await sleep(delay);
    } catch(e) {
      console.log('  错误: ' + e.message);
      await sleep(1000);
    }
  }

  console.log('DEMO DONE');
  await mp.disconnect();
  process.exit(0);
})().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
