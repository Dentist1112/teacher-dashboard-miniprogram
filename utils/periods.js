// 分析周期：今日 / 本周（周一到周日）/ 本月。返回 'YYYY-MM-DD' 闭区间。
// 周口径与 utils/weekdays.js 一致取周一，但分析要含完整 7 天（含周末）。

function fmt(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// type: day | week | month
function range(type, now) {
  const base = now instanceof Date ? startOfDay(now) : startOfDay(new Date());
  let start;
  let end;
  if (type === 'day') {
    start = new Date(base);
    end = new Date(base);
  } else if (type === 'week') {
    const w = base.getDay();            // 0=日 6=六
    const deltaToMon = (w >= 1 ? 1 - w : -6);
    start = new Date(base); start.setDate(start.getDate() + deltaToMon);
    end = new Date(start); end.setDate(end.getDate() + 6);
  } else {
    start = new Date(base.getFullYear(), base.getMonth(), 1);
    end = new Date(base.getFullYear(), base.getMonth() + 1, 0);
  }
  return { start: fmt(start), end: fmt(end) };
}

// 'YYYY-MM-DD' 是否落在闭区间内
function inRange(dateStr, r) {
  const d = String(dateStr || '').slice(0, 10);
  return !!d && d >= r.start && d <= r.end;
}

module.exports = { range, inRange, fmt };
