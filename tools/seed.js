// 调用 seed 云函数灌示例数据；--clear 先清空
const { connectOrLaunch } = require('./mp.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clear = process.argv.includes('--clear');
(async () => {
  const { mp, reused } = await connectOrLaunch(9491);
  await sleep(reused ? 1500 : 6000);
  const res = await mp.evaluate(c => wx.cloud.callFunction({ name: 'seed', data: { clear: c, force: c } })
    .then(r => r.result).catch(e => ({ error: String(e) })), clear);
  console.log('seed 结果:', JSON.stringify(res, null, 2));
  await mp.disconnect(); // 不用 close()：close 会关掉用户的 IDE 项目窗口
  process.exit(res && res.error ? 1 : 0);
})();
