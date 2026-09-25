// 守护 utils/weekdays.js：周表表头的「周几 + 日历日期」。
// 为什么用 Node 单测：日期算错在模拟器里只表现为「表头写了个别的数字」，e2e 断言不出真伪；
// 跨月/跨年/周末回落这些边界，只有纯函数直调能穷举。
const wk = require('../utils/weekdays.js');

let pass = 0, fail = 0;
const ok = m => { pass++; console.log('  ✅ ' + m); };
const bad = m => { fail++; console.log('  ❌ ' + m); };

const L = ['周一', '周二', '周三', '周四', '周五'];

function check(iso, expectDates, expectToday, note) {
  const d = new Date(iso);
  const w = wk.weekdays(d);
  const got = w.map(x => x.dateLabel);
  const labels = w.map(x => x.label);
  const today = wk.todayWeekday(d);
  const okLabels = labels.join() === L.join();
  const okDates = got.join() === expectDates.join();
  const okToday = today === expectToday;
  const okD = w.every((x, i) => x.d === i + 1);
  if (okLabels && okDates && okToday && okD) ok(`${iso.slice(0, 10)} ${note} → ${got.join(' ')} today=周${today}`);
  else bad(`${iso} ${note}: dates=${got.join(' ')}(期望 ${expectDates.join(' ')}) labels=${labels.join()} today=${today}(期望 ${expectToday}) dOk=${okD}`);
}

// 工作日：取本周（含今天）
check('2026-09-07T08:00:00', ['9/7', '9/8', '9/9', '9/10', '9/11'], 1, '周一');
check('2026-09-09T23:59:00', ['9/7', '9/8', '9/9', '9/10', '9/11'], 3, '周三深夜');
check('2026-09-11T00:01:00', ['9/7', '9/8', '9/9', '9/10', '9/11'], 5, '周五零点后');
// 周末：老师排的是下周，必须前移到下周一，且 isToday 回落周一
check('2026-09-12T10:00:00', ['9/14', '9/15', '9/16', '9/17', '9/18'], 1, '周六→下周');
check('2026-09-13T10:00:00', ['9/14', '9/15', '9/16', '9/17', '9/18'], 1, '周日→下周');
// 跨月
check('2026-04-30T10:00:00', ['4/27', '4/28', '4/29', '4/30', '5/1'], 4, '周四跨月');
check('2026-02-28T10:00:00', ['3/2', '3/3', '3/4', '3/5', '3/6'], 1, '周六跨月');
// 跨年
check('2026-01-01T10:00:00', ['12/29', '12/30', '12/31', '1/1', '1/2'], 4, '元旦跨年');
// 闰年 2/29（2024 是闰年，2/29 是周四）
check('2024-02-29T10:00:00', ['2/26', '2/27', '2/28', '2/29', '3/1'], 4, '闰日');

// date 字段必须是 YYYY-MM-DD 且与 dateLabel 同一天
const w = wk.weekdays(new Date('2026-01-01T10:00:00'));
w.every(x => /^\d{4}-\d{2}-\d{2}$/.test(x.date))
  ? ok('date 字段格式 YYYY-MM-DD: ' + w.map(x => x.date).join(' '))
  : bad('date 格式错: ' + JSON.stringify(w.map(x => x.date)));
w.every(x => {
  const [, m, dd] = x.date.split('-');
  return x.dateLabel === Number(m) + '/' + Number(dd);
}) ? ok('dateLabel 与 date 同一天') : bad('dateLabel 与 date 不一致: ' + JSON.stringify(w));

// 连续 5 天：相邻差恰好 86400000ms（跨月/跨年最容易断裂）
const days = w.map(x => new Date(x.date + 'T00:00:00').getTime());
days.every((t, i) => i === 0 || t - days[i - 1] === 86400000)
  ? ok('5 天连续无断裂')
  : bad('日期断裂: ' + JSON.stringify(w.map(x => x.date)));

// mondayOf 幂等：对本周任意一天调用都得到同一个周一
const mons = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']
  .map(s => wk.mondayOf(new Date(s + 'T12:00:00')).toDateString());
new Set(mons).size === 1 ? ok('mondayOf 对周一~周五同周幂等') : bad('mondayOf 不幂等: ' + JSON.stringify(mons));

// 无参调用（页面实际用法）不许抛错，且结构完整
try {
  const now = wk.weekdays();
  now.length === 5 && now.every(x => x.label && x.dateLabel && x.date && x.d)
    ? ok('无参调用返回完整 5 天: ' + now.map(x => x.label + x.dateLabel).join(' '))
    : bad('无参调用结构不完整: ' + JSON.stringify(now));
} catch (e) {
  bad('无参调用抛错: ' + e.message);
}

// todayWeekday 全周覆盖：周一~周五=1~5，周六周日=1（2026-09-06 是周日）
const twGot = [6, 7, 8, 9, 10, 11, 12]
  .map(i => wk.todayWeekday(new Date(`2026-09-${String(i).padStart(2, '0')}T10:00:00`)));
const twExp = [1, 1, 2, 3, 4, 5, 1];
twGot.join() === twExp.join()
  ? ok('todayWeekday 全周正确（周末回落周一）: ' + twGot.join())
  : bad(`todayWeekday 错: 得到 ${twGot.join()} 期望 ${twExp.join()}`);

console.log(`\nweekdays: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
