// 抽段跑 e2e：蓝队变异验证要跑几十次，全套 6.5min 跑不起，只跑相关那一段（~40s）。
// 做法是把 e2e.js 里 `console.log('\n[N] ...')` 到下一段之间的源码切出来，套上同样的
// ok/bad/goto/evalRetry 环境执行 —— 断言代码本身零复制，改 e2e.js 这里自动跟着变。
// 用法: node tools/e2e-slice.js 18        只跑 [18]
//       node tools/e2e-slice.js 17 18     跑多段
//       node tools/e2e-slice.js --list    看所有段
const fs = require('fs');
const path = require('path');
const os = require('os');

const SRC = path.join(__dirname, 'e2e.js');
const src = fs.readFileSync(SRC, 'utf8');

// 段边界：只认行首缩进 + console.log('\n[N]，与 e2e.js 现有写法一致
const marks = [];
const re = /^ {4}console\.log\('\\n\[(\d+[a-z]?)\]([^']*)'\);/gm;
let m;
while ((m = re.exec(src))) marks.push({ n: m[1], title: m[2].trim(), start: m.index });
marks.forEach((x, i) => { x.end = i + 1 < marks.length ? marks[i + 1].start : src.length; });

const args = process.argv.slice(2);
if (!args.length || args.includes('--list')) {
  console.log('e2e.js 共 ' + marks.length + ' 段：');
  marks.forEach(x => console.log(`  [${x.n}] ${x.title}`));
  console.log('\n用法: node tools/e2e-slice.js 18 [19 ...]');
  process.exit(args.includes('--list') ? 0 : 1);
}

const want = args.filter(a => /^\d+[a-z]?$/.test(a));
const picked = marks.filter(x => want.includes(String(x.n)));
const missing = want.filter(n => !marks.some(x => String(x.n) === n));
if (missing.length) { console.error('❌ 没有这些段: ' + missing.join(',') + '（--list 看全部）'); process.exit(2); }

const body = picked.map(x => src.slice(x.start, x.end)).join('\n');
const MPJS = JSON.stringify(path.join(__dirname, 'mp.js'));

// 【单一来源】顶层辅助函数（ok/bad/goto/$retry…）一律从 e2e.js 原样提取，runner 不再手抄。
// 实测事故：给 e2e.js 加了 `$retry` 后，抽段跑报 `FATAL $retry is not defined`，
// 而 mutate.js 把这个当成「基线就是红的」直接中止 —— 手抄的运行时和真身漂移，
// 会把工具链故障伪装成业务失败。
function extractTopFns(source) {
  const out = [];
  const re = /^(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = re.exec(source))) {
    // 先找到参数列表右括号，再找函数体的 `{`；否则默认参数里的解构 `{ a = 1 }`
    // 会被误当函数体开头，waitPageIdle(mp, { label = 'x' } = {}) 曾把 helper 截成半条。
    let p0 = source.indexOf('(', m.index);
    if (p0 < 0) continue;
    let paren = 0;
    let p1 = -1;
    for (let q = p0; q < source.length; q++) {
      const ch = source[q];
      if (ch === '(') paren++;
      else if (ch === ')') {
        paren--;
        if (paren === 0) { p1 = q; break; }
      }
    }
    if (p1 < 0) continue;
    let i = source.indexOf('{', p1);
    if (i < 0) continue;
    let depth = 0;
    for (let j = i; j < source.length; j++) {
      const c = source[j];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { out.push({ name: m[1], code: source.slice(m.index, j + 1) }); break; } }
    }
  }
  return out;
}
const TOP_FNS = extractTopFns(src);
if (!TOP_FNS.some(f => f.name === 'goto')) {
  console.error('❌ 没从 e2e.js 提取到 goto —— 顶层函数写法变了，e2e-slice.js 的提取器要同步改');
  process.exit(3);
}
const HELPERS = TOP_FNS.map(f => f.code).join('\n\n');

// 顶层 const 分两类：
//   a) runner 自己会定义的运行时（PORT/pass/fail/sleep…）→ 跳过
//   b) 纯数据常量（数组/数字/字符串字面量，如 SCHED_PERIODS/SCHED_SLOTS）→ **自动原样注入**
// 为什么改成自动：原先靠手抄 RUNNER_PROVIDES 清单，往 e2e.js 加一个常量就要记得
// 同步这里，否则抽段直接 exit 3。这与台账 #14「runner 手抄 helper 导致工具链假红」
// 是同一类漂移 —— 手抄清单必然漂移，所以按同样的办法改成自动提取。
const RUNNER_RUNTIME = ['PROJECT_ROOT', 'PORT', 'pass', 'fail', 'sleep', 'connectOrLaunch', 'evalRetry', 'TABS'];
// 纯字面量常量：单行、右侧是数组/数字/字符串/简单算术，不含函数调用与 require
const DATA_CONST = /^const ([A-Za-z_$][\w$]*)\s*=\s*((?:\[[^\]]*\]|\d[\d.*+\-/ ]*|'[^']*'|"[^"]*")(?:\s*[*+\-/]\s*[\w.$]+)*)\s*;/gm;
const dataConsts = [...src.matchAll(DATA_CONST)]
  .filter(m => RUNNER_RUNTIME.indexOf(m[1]) < 0)
  .filter(m => new RegExp('\\b' + m[1].replace(/\$/g, '\\$') + '\\b').test(body));
const DATA_CONST_CODE = dataConsts.map(m => m[0]).join('\n');

const topConsts = [...src.matchAll(/^const ([A-Za-z_$][\w$]*)\s*=/gm)].map(m => m[1]);
const injected = new Set(dataConsts.map(m => m[1]));
const missingConsts = topConsts.filter(n => RUNNER_RUNTIME.indexOf(n) < 0 && !injected.has(n)
  && new RegExp('\\b' + n.replace(/\$/g, '\\$') + '\\b').test(body));
if (missingConsts.length) {
  console.error('❌ 段内用到 e2e.js 顶层常量但 runner 没提供且无法自动注入: ' + missingConsts.join(', ')
    + '\n   修法：若是纯数据常量请写成单行字面量（会被自动注入）；'
    + '否则在 e2e-slice.js 的 runner 里定义同名变量并加进 RUNNER_RUNTIME');
  process.exit(3);
}
if (dataConsts.length) {
  console.log('  ↳ 自动注入 e2e.js 顶层数据常量: ' + dataConsts.map(m => m[1]).join(', '));
}

// 段内代码依赖的运行时（与 e2e.js 主体保持同构：ok/bad/sleep/goto/evalRetry/db 直读）
const runner = `
const { connectOrLaunch, sleep: _s, evalRetry, PROJECT } = require(${MPJS});
const PROJECT_ROOT = PROJECT;   // 段内代码可能读项目文件（如 dashboard.wxml），不能靠 __dirname
const PORT = Number(process.env.AUTO_PORT || 9491);
const pass = [], fail = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
// stamp 是段 [3] 内的局部变量，用来给测试数据起唯一名字。抽段跑 [12]/[13]/[16] 等
// 后面的段时它不存在 → FATAL stamp is not defined，会被误读成业务失败。
// 这里给个同格式兜底（每次抽段都是新值，唯一性照样成立）。全量 e2e 不走这条。
const stamp = Date.now().toString().slice(-6);
// testNo 同理（段 [3] 里声明的 testNo = 'T' + stamp）：抽段跑 [4]/[11] 等引用它的段
// 会 FATAL testNo is not defined —— 2026-09-06 抽段跑 [3][4][12] 时实测踩到。
// 注：段 [3] 自己会用 const 再声明一次，同名 const 在同一作用域会 SyntaxError，
// 所以这里用 var —— var 允许被后面的 const 遮蔽（块级），也允许重复声明。
var testNo = 'T' + stamp;
/* ==== e2e.js 顶层数据常量（自动提取，改 e2e.js 这里自动跟着变） ==== */
${DATA_CONST_CODE}
/* ==== 以下 helper 由 e2e-slice.js 从 e2e.js 原样注入，改 e2e.js 这里自动跟着变 ==== */
${HELPERS}
/* ==== 注入结束 ==== */
(async () => {
  const { mp } = await connectOrLaunch(PORT);
  let fatal = null;
  try {
    // 【抽段隔离】全套 e2e 从 [1] 起跑，页面栈是已知的；抽段是空降，栈里可能还压着
    // 上一轮 navigateTo 的 2~3 层页面 —— 此时刚取到的 page 句柄会立刻过期，
    // 报 page-is-not-on-top-of-page-stack，被误读成业务失败（实测踩过）。
    // 所以开跑前强制把栈重置成单页 dashboard。
    for (let i = 0; i < 3; i++) {
      try {
        await mp.reLaunch('/pages/dashboard/dashboard');
        await sleep(1200);
        const depth = await mp.evaluate(() => getCurrentPages().length).catch(() => -1);
        if (depth === 1) { console.log('  ↺ 页面栈已重置为单页 dashboard'); break; }
        console.log('  ⚠️ 页面栈深度 ' + depth + '，重试重置');
      } catch (e) { console.log('  ⚠️ 重置页面栈失败: ' + (e.message || e)); }
      await sleep(1000);
    }
    await sleep(1500);
${body}
  } catch (e) {
    fatal = e;
    bad('FATAL ' + (e.message || e));
  } finally {
    console.log('\\n===== ' + pass.length + ' 通过 / ' + fail.length + ' 失败 =====');
    if (fail.length) console.log('SLICE_FAIL_LIST::' + JSON.stringify(fail));
    await mp.disconnect();
    process.exit(fail.length ? 1 : 0);
  }
})();
`;

const out = path.join(os.tmpdir(), `e2e-slice-${picked.map(x => x.n).join('_')}.js`);
fs.writeFileSync(out, runner);
// 语法先自检，别把 e2e.js 的语法错当成业务失败
try { new (require('vm').Script)(runner, { filename: out }); }
catch (e) { console.error('❌ 抽出的段语法错（e2e.js 结构变了？）: ' + e.message); process.exit(3); }

if (process.env.SLICE_EMIT_ONLY) { console.log(out); process.exit(0); }
require('child_process').spawn(process.execPath, [out], { stdio: 'inherit' })
  .on('exit', c => process.exit(c === null ? 1 : c));
