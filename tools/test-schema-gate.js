// 守护 app.js 的 ensureDb 版本门（新增云集合后老用户能否补建）。
// 为什么单独一个脚本而不是直接用 check.js 当判定器：
//   mutate.js 的输出解析器只认 `N 通过 / N 失败`，check.js 打印的是「发现 N 个问题」
//   → 变异体被判 NO_RUN 而不是 KILLED（2026-09-06 实测）。
//   这里把 check.js 的 [SCHEMA] 判定包成标准格式，同时补上 check.js 覆盖不到的行为断言。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = m => { pass++; console.log('  ✅ ' + m); };
const bad = m => { fail++; console.log('  ❌ ' + m); };

// 1) 静态门禁：跑 check.js，只看 [SCHEMA] 那几条
let checkOut = '';
try {
  checkOut = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'check.js')], { encoding: 'utf8' });
} catch (e) {
  checkOut = String((e.stdout || '') + (e.stderr || ''));
}
const schemaErrs = checkOut.split('\n').filter(l => l.indexOf('[SCHEMA]') >= 0);
schemaErrs.length === 0
  ? ok('check.js 的 [SCHEMA] 检查无告警')
  : bad('SCHEMA 门禁告警: ' + schemaErrs.map(x => x.trim()).join(' | '));

// 2) 行为断言：模拟老用户 storage（mpInited=1）+ 当前 SCHEMA_VER=2 → 必须重跑 initdb
const appjs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const ver = Number((appjs.match(/SCHEMA_VER\s*=\s*(\d+)/) || [])[1] || 0);
ver >= 2 ? ok('SCHEMA_VER = ' + ver) : bad('SCHEMA_VER 缺失或过低: ' + ver);

// 把 ensureDb 的门那一行抠出来单独求值，避免整份 app.js 依赖 wx/App 环境
const gateLine = (appjs.match(/^\s*if \(.*mpInited.*\) return;/m) || [''])[0];
if (!gateLine) bad('找不到 ensureDb 的门（含 mpInited 的 if...return 行）');
else {
  const gate = (stored) => {
    const wx = { getStorageSync: () => stored };
    // 把 `if (...) return;` 变成可求值的谓词：命中门 → true（跳过初始化）
    const body = 'return (function(){' + gateLine.replace('return;', 'return true;') + ' return false; })();';
    // eslint-disable-next-line no-new-func
    return new Function('wx', 'SCHEMA_VER', body)(wx, ver);
  };
  gate(0) === false ? ok('全新用户（无 mpInited）→ 会跑 initdb') : bad('全新用户被跳过初始化 → 集合永远不建');
  gate(1) === false
    ? ok('老用户（mpInited=1，低于当前版本 ' + ver + '）→ 会重跑 initdb 补建新集合')
    : bad('老用户被门挡住 → 新增的云集合永不创建，写入报 "Db or Table not exist"');
  gate(ver) === true ? ok('已是最新版本（mpInited=' + ver + '）→ 跳过，不重复建表') : bad('最新版本仍重复初始化（每次启动多两次云函数调用）');
}

// 3) initdb 集合清单必须含 teacherProfile（登录功能依赖）
const initSrc = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'initdb', 'index.js'), 'utf8');
initSrc.indexOf("'teacherProfile'") >= 0
  ? ok('initdb 集合清单含 teacherProfile')
  : bad('initdb 缺 teacherProfile → 登录保存身份会报集合不存在');

console.log(`\nschema-gate: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
