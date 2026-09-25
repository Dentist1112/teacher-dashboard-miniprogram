// 共享：连上开发者工具。优先复用已开的自动化端口（快且不动用户窗口），
// 连不上再 launch。收尾一律 disconnect()，close() 会关掉用户的项目窗口。
const automator = require('miniprogram-automator');
const path = require('path');
const net = require('net');

const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';
const PROJECT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function portOpen(port) {
  return new Promise(res => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
    s.setTimeout(700, () => { s.destroy(); res(false); });
  });
}

// 渲染层存活探测。实例死后 getCurrentPages() 为空、currentPage() 报 rawPath。
async function alive(mp) {
  try {
    const pg = await mp.currentPage();
    return !!(pg && pg.path);
  } catch (e) { return false; }
}

// base 之后连续扫，遇到已开着的先试 connect，全空则在第一个空闲口 launch
async function connectOrLaunch(base = 9491, span = 12) {
  for (let p = base; p < base + span; p++) {
    if (!(await portOpen(p))) continue;
    try {
      const mp = await automator.connect({ wsEndpoint: `ws://127.0.0.1:${p}` });
      // 健康探测：渲染层死掉后 connect 仍会成功，但任何页面操作都报
      // `Cannot destructure property 'rawPath'`。不探测就会把环境故障伪装成业务失败。
      if (!(await alive(mp))) {
        console.log(`☠︎ 端口 ${p} 渲染层已死（rawPath），跳过`);
        try { await mp.disconnect(); } catch (e) {}
        continue;
      }
      console.log(`↺ 复用已开的自动化端口 ${p}`);
      return { mp, reused: true, port: p };
    } catch (e) { /* 端口被别的东西占，继续扫 */ }
  }
  for (let p = base; p < base + span; p++) {
    if (await portOpen(p)) continue;
    const mp = await automator.launch({ cliPath: CLI, projectPath: PROJECT, port: p, timeout: 120000 });
    console.log(`▶ 新启动自动化端口 ${p}`);
    return { mp, reused: false, port: p };
  }
  throw new Error(`端口 ${base}~${base + span - 1} 全被占用：pkill -f wechatwebdevtools 后重试`);
}

// automator 偶发 `timeout waiting for automator response`（4 轮隔离诊断未能稳定复现，
// 单独重跑必成功）。所有一次性的大 evaluate 都过这层重试，别让抖动伪装成业务失败。
const FLAKY = /timeout waiting for automator response|Connection closed/i;
async function evalRetry(mp, fn, args = [], tries = 3) {
  let last = null;
  for (let i = 1; i <= tries; i++) {
    try {
      return await mp.evaluate(fn, ...args);
    } catch (e) {
      last = e;
      if (!FLAKY.test(e.message || '')) throw e;
      console.log(`  ⚠️ evaluate 抖动第 ${i}/${tries} 次（${(e.message || '').slice(0, 40)}），2s 后重试`);
      await sleep(2000);
    }
  }
  throw last;
}

module.exports = { connectOrLaunch, sleep, CLI, PROJECT, evalRetry, alive };
