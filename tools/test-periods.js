// 守护 utils/periods.js：分析周期区间（今日/本周周一到周日/本月）边界。
const P = require('../utils/periods.js');

let pass = 0, fail = 0;
const ok = m => { pass++; console.log('  ✅ ' + m); };
const bad = m => { fail++; console.log('  ❌ ' + m); };

function eq(a, b, note) {
  if (a === b) ok(note + ' → ' + a);
  else bad(note + ': 实际 ' + a + ' 期望 ' + b);
}

// 今日
let r = P.range('day', new Date('2026-09-09T10:00:00'));
eq(r.start, '2026-09-09', '今日开始'); eq(r.end, '2026-09-09', '今日结束');

// 本周：周三 → 周一 9/7 到周日 9/13
r = P.range('week', new Date('2026-09-09T10:00:00'));
eq(r.start, '2026-09-07', '本周开始(周三)'); eq(r.end, '2026-09-13', '本周结束(周三)');

// 周日仍属本周（周一到周日）
r = P.range('week', new Date('2026-09-13T10:00:00'));
eq(r.start, '2026-09-07', '本周开始(周日)'); eq(r.end, '2026-09-13', '本周结束(周日)');

// 周一
r = P.range('week', new Date('2026-09-07T10:00:00'));
eq(r.start, '2026-09-07', '本周开始(周一)');

// 跨月周：2026-04-30 周四 → 4/27~5/3
r = P.range('week', new Date('2026-04-30T10:00:00'));
eq(r.start, '2026-04-27', '跨月周开始'); eq(r.end, '2026-05-03', '跨月周结束');

// 本月
r = P.range('month', new Date('2026-09-13T10:00:00'));
eq(r.start, '2026-09-01', '本月开始'); eq(r.end, '2026-09-30', '本月结束(30天)');
r = P.range('month', new Date('2024-02-10T10:00:00'));
eq(r.end, '2024-02-29', '闰二月结束29天');
r = P.range('month', new Date('2026-12-15T10:00:00'));
eq(r.end, '2026-12-31', '十二月结束');

// inRange 闭区间
r = { start: '2026-09-01', end: '2026-09-30' };
eq(String(P.inRange('2026-09-01', r)), 'true', '区间含起点');
eq(String(P.inRange('2026-09-30', r)), 'true', '区间含终点');
eq(String(P.inRange('2026-08-31', r)), 'false', '起点前一天在外');
eq(String(P.inRange('2026-10-01', r)), 'false', '终点后一天在外');
eq(String(P.inRange('', r)), 'false', '空日期在外');

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
