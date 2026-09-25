const automator = require('miniprogram-automator');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9491' });
  console.log('CONNECTED');

  // 8 个核心页面，每页 5 秒，总共约 40 秒
  const pages = [
    ['首页概览', '/pages/dashboard/dashboard', 'reLaunch', 5500],
    ['学生名单', '/pages/roster/roster', 'switchTab', 5000],
    ['考勤登记', '/pages/attendance/attendance', 'switchTab', 5000],
    ['成绩录入', '/pages/grades/grades', 'reLaunch', 5500],
    ['作业管理', '/pages/homework/homework', 'reLaunch', 5000],
    ['值日表', '/pages/duty/duty', 'reLaunch', 4500],
    ['座位表', '/pages/seats/seats', 'reLaunch', 4500],
    ['通知公告', '/pages/announcement/announcement', 'switchTab', 4500],
    ['回到首页', '/pages/dashboard/dashboard', 'reLaunch', 3000],
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
