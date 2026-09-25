const automator = require('miniprogram-automator');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9491' });
  console.log('CONNECTED');

  const pages = [
    ['首页概览', '/pages/dashboard/dashboard', 'reLaunch', 3000],
    ['学生名单', '/pages/roster/roster', 'switchTab', 2500],
    ['考勤登记', '/pages/attendance/attendance', 'switchTab', 2500],
    ['成绩录入', '/pages/grades/grades', 'reLaunch', 2500],
    ['作业管理', '/pages/homework/homework', 'reLaunch', 2500],
    ['值日表', '/pages/duty/duty', 'reLaunch', 2500],
    ['课程表', '/pages/schedule/schedule', 'reLaunch', 2500],
    ['班委名单', '/pages/committee/committee', 'reLaunch', 2500],
    ['奖惩登记', '/pages/rewards/rewards', 'reLaunch', 2500],
    ['学生档案', '/pages/profile/profile', 'reLaunch', 2000],
    ['座位表', '/pages/seats/seats', 'reLaunch', 2000],
    ['通知公告', '/pages/announcement/announcement', 'switchTab', 2500],
    ['设置', '/pages/settings/settings', 'switchTab', 1500],
    ['回到首页', '/pages/dashboard/dashboard', 'reLaunch', 1500],
  ];

  for (const [name, route, method, delay] of pages) {
    console.log('-> ' + name);
    try {
      if (method === 'switchTab') {
        await mp.switchTab(route);
      } else {
        await mp.reLaunch(route);
      }
      await sleep(delay);
    } catch(e) {
      console.log('  err: ' + e.message);
      await sleep(500);
    }
  }

  console.log('DEMO DONE');
  await mp.disconnect();
  process.exit(0);
})().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
