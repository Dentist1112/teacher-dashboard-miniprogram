// 守护 utils/validate.js 的数值范围规则（真机 Bug ①根源层）。
// 为什么用 Node 单测而不是模拟器 e2e：变异体注进去后开发者工具的 util 模块
// 不一定热更新（实测 maxfull 变异体在 e2e 里 SURVIVED，但日志里还是「上限 150」），
// 纯 require 同一份文件，变异必然生效。本测试同时兼做锚点自检。
const { check, SCORE_MAX_FULL, REWARD_MAX_POINTS, SCORE_DECIMALS } = require('../utils/validate.js');

let pass = 0, fail = 0;
function ok(m) { pass++; console.log('  ✅ ' + m); }
function bad(m) { fail++; console.log('  ❌ ' + m); }

// 满分上限本身：变异体抬到 10000 时下面 full:1000 不再报错，天然变红
if (SCORE_MAX_FULL === 150) ok(`满分上限 = 150 (${typeof SCORE_MAX_FULL})`);
else bad(`满分上限被改：${SCORE_MAX_FULL}（应为 150）`);

if (SCORE_DECIMALS === 1) ok('小数位规则 = 1 位');
else bad(`小数位被改：${SCORE_DECIMALS}`);

const chk = (name, cond, data) => {
  const why = check('scores', data);
  if (cond) ok(name);
  else bad(name + (why ? ` 返回了: ${why}` : ''));
};

// 满分 1000 必须被拦（真机反馈：满分写 1000 → 就能录 1000 分）
chk('满分 1000 被拦', /满分/.test(check('scores', { full: 1000 }) || ''), { full: 1000 });
// 满分 150 恰好允许（上限本身）
chk('满分 150 合法', check('scores', { full: 150 }) === null, { full: 150 });
// 满分 151 超上限
chk('满分 151 超上限被拦', /满分/.test(check('scores', { full: 151 }) || ''), { full: 151 });
// 分数不超满分：150/150 合法
chk('150/150 合法', check('scores', { score: 150, full: 150 }) === null, { score: 150, full: 150 });
// 分数超满分：151/150 非法
chk('151/150 超满分被拦', /超出/.test(check('scores', { score: 151, full: 150 }) || ''), { score: 151, full: 150 });
// 超过 1 位小数非法
chk('88.1234 超 1 位小数被拦', /小数/.test(check('scores', { score: 88.1234, full: 100 }) || ''), { score: 88.1234, full: 100 });
// 负数非法
chk('-1 非法', /大于等于 0|负/.test(check('scores', { score: -1, full: 100 }) || ''), { score: -1, full: 100 });
// 奖励积分上限守护
if (REWARD_MAX_POINTS === 100) ok(`奖励上限 = ${REWARD_MAX_POINTS}`);
else bad(`奖励上限被改：${REWARD_MAX_POINTS}`);

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
