const automator = require('miniprogram-automator');
const fs = require('fs');
const path = require('path');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = '/tmp/012_frames';
const FPS = 24;

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9491' });
  console.log('CONNECTED');

  const scenes = [
    ['首页', '/pages/dashboard/dashboard', 'reLaunch', 3.5],
    ['学生名单', '/pages/roster/roster', 'switchTab', 3.0],
    ['考勤登记', '/pages/attendance/attendance', 'switchTab', 3.0],
    ['成绩录入', '/pages/grades/grades', 'reLaunch', 3.5],
    ['作业管理', '/pages/homework/homework', 'reLaunch', 3.0],
    ['值日表', '/pages/duty/duty', 'reLaunch', 2.5],
    ['座位表', '/pages/seats/seats', 'reLaunch', 2.5],
    ['通知公告', '/pages/announcement/announcement', 'switchTab', 3.0],
    ['回到首页', '/pages/dashboard/dashboard', 'reLaunch', 2.0],
  ];

  let frameIdx = 0;
  
  for (const [name, route, method, holdSec] of scenes) {
    console.log('-> ' + name);
    try {
      if (method === 'switchTab') {
        await mp.switchTab(route);
      } else {
        await mp.reLaunch(route);
      }
      await sleep(700);
      
      const totalFrames = Math.floor(holdSec * FPS);
      for (let f = 0; f < totalFrames; f++) {
        const fname = path.join(OUT, 'frame_' + String(frameIdx).padStart(5, '0') + '.png');
        await mp.screenshot({ path: fname });
        frameIdx++;
        await sleep(1000 / FPS);
      }
    } catch(e) {
      console.log('  err: ' + e.message);
      await sleep(500);
    }
  }

  console.log('DONE: ' + frameIdx + ' frames');
  await mp.disconnect();
  process.exit(0);
})().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
