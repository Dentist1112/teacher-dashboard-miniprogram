// 周一~周五的「周几 + 日历日期」。课表/值日两页共用，避免两处各算一套日期口径。
// 为什么需要日期：老师反馈「只有周一~周五记不住是哪天」（2026-09-06 真机试用）。
//
// 取哪一周：
//   周一~周五 → 本周（含今天）
//   周六/周日 → 下一周（老师周末排的是下周的课，不是刚过去那周）
// 高亮哪一天：沿用 todayWeekday()，周末回落到周一（页面必须恰好有一天 isToday，e2e 有断言）

const LABELS = ['周一', '周二', '周三', '周四', '周五'];

function mondayOf(now) {
  const base = now instanceof Date ? now : new Date();
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const w = d.getDay();                       // 0=周日 … 6=周六
  const delta = (w >= 1 && w <= 5) ? 1 - w : (w === 6 ? 2 : 1);
  d.setDate(d.getDate() + delta);
  return d;
}

function todayWeekday(now) {
  const w = (now instanceof Date ? now : new Date()).getDay();
  return w >= 1 && w <= 5 ? w : 1;
}

// → [{ d:1, label:'周一', dateLabel:'9/7', date:'2026-09-07' }, ...]
function weekdays(now) {
  const mon = mondayOf(now);
  return LABELS.map((label, i) => {
    const day = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i);
    const m = day.getMonth() + 1;
    const dd = day.getDate();
    return {
      d: i + 1,
      label,
      dateLabel: m + '/' + dd,
      date: day.getFullYear() + '-' + String(m).padStart(2, '0') + '-' + String(dd).padStart(2, '0')
    };
  });
}

module.exports = { weekdays, mondayOf, todayWeekday };
