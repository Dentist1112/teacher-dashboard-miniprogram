// 边界规则单测（Node 直调 utils/validate.js —— 与被测物同环境，不受模拟器热更新影响）
// 每条用例都对应 2026-09-06 第二轮真机探针实测到的一个真实缺陷，见 docs/ADVERSARIAL.md #30~#41
const v = require('../utils/validate.js');
let pass = 0; const fail = [];
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ✅ ' + name); }
  else { fail.push(`${name}: got ${g} want ${w}`); console.log(`  ❌ ${name}: got ${g} want ${w}`); }
}
function rejects(name, col, data) {
  const why = v.check(col, data);
  if (why) { pass++; console.log('  ✅ ' + name + ' → 拒绝：' + why); }
  else { fail.push(name + ' 应拒绝但通过了'); console.log('  ❌ ' + name + ' 应拒绝但通过了'); }
}
function accepts(name, col, data) {
  const why = v.check(col, data);
  if (!why) { pass++; console.log('  ✅ ' + name + ' → 通过'); }
  else { fail.push(name + ' 应通过但被拒：' + why); console.log('  ❌ ' + name + ' 应通过但被拒：' + why); }
}

console.log('\n[strictInt] Number() 的隐式转换全部要挡住');
eq('空字符串', v.strictInt(''), null);
eq('纯空格（曾存成 0 分）', v.strictInt('   '), null);
eq('前导零 007（曾存成 7）', v.strictInt('007'), null);
eq('十六进制 0x10（曾存成 16）', v.strictInt('0x10'), null);
eq('带加号 +8（曾存成 8）', v.strictInt('+8'), null);
eq('科学计数 1e5', v.strictInt('1e5'), null);
eq('中文数字', v.strictInt('五'), null);
eq('Infinity', v.strictInt('Infinity'), null);
eq('小数 2.5 不是整数', v.strictInt('2.5'), null);
eq('正常 5', v.strictInt('5'), 5);
eq('负数 -5', v.strictInt('-5'), -5);
eq('零 0', v.strictInt('0'), 0);

console.log('\n[strictDec] 分数解析');
eq('1e2（曾存成 100）', v.strictDec('1e2', 1), null);
eq('88.888 超小数位', v.strictDec('88.888', 1), null);
eq('.5 缺整数位', v.strictDec('.5', 1), null);
eq('5. 缺小数', v.strictDec('5.', 1), null);
eq('88.5 合法', v.strictDec('88.5', 1), 88.5);
eq('88 合法', v.strictDec('88', 1), 88);

console.log('\n[isRealDate] 只验格式会放过不存在的日期');
eq('2011-13-45', v.isRealDate('2011-13-45'), false);
eq('0000-00-00', v.isRealDate('0000-00-00'), false);
eq('2026-02-30', v.isRealDate('2026-02-30'), false);
eq('2026-9-6 非补零', v.isRealDate('2026-9-6'), false);
eq('2024-02-29 闰年合法', v.isRealDate('2024-02-29'), true);
eq('2026-02-29 非闰年', v.isRealDate('2026-02-29'), false);

console.log('\n[pickPhone] 12 位号里不许抠出前 11 位（否则拨错人）');
eq('12 位号', v.pickPhone('妈妈 139000088888'), '');
eq('10 位号', v.pickPhone('妈妈 1390000888'), '');
eq('11 位合法', v.pickPhone('妈妈 13900008888'), '13900008888');
eq('号码在句中', v.pickPhone('联系13900008888（妈妈）'), '13900008888');
eq('前面挨数字', v.pickPhone('01113900008888'), '');
eq('无号码', v.pickPhone('妈妈'), '');

console.log('\n[rewards] 积分');
rejects('积分纯空格', 'rewards', { points: '   ', reason: 'x' });
rejects('积分 0', 'rewards', { points: 0, reason: 'x' });
rejects('积分 0x10', 'rewards', { points: '0x10', reason: 'x' });
rejects('积分 007', 'rewards', { points: '007', reason: 'x' });
rejects('积分 +8', 'rewards', { points: '+8', reason: 'x' });
rejects('积分 2.5', 'rewards', { points: '2.5', reason: 'x' });
rejects('积分 101', 'rewards', { points: 101, reason: 'x' });
rejects('积分 -101', 'rewards', { points: -101, reason: 'x' });
rejects('事由 300 字', 'rewards', { points: 5, reason: 'x'.repeat(300) });
accepts('积分 5', 'rewards', { points: 5, reason: '上课积极' });
accepts('积分 -5', 'rewards', { points: -5, reason: '迟到' });
accepts('积分 100 边界', 'rewards', { points: 100, reason: '边界' });

console.log('\n[scores] 分数');
rejects('分数 1e2', 'scores', { full: 100, score: '1e2' });
rejects('分数纯空格', 'scores', { full: 100, score: '   ' });
rejects('分数 88.888', 'scores', { full: 100, score: '88.888' });
rejects('分数超满分', 'scores', { full: 100, score: 120 });
rejects('分数负数', 'scores', { full: 100, score: -1 });
rejects('满分 0', 'scores', { full: 0, score: 10 });
rejects('满分 151', 'scores', { full: 151, score: 10 });
accepts('满分 150 边界', 'scores', { full: 150, score: 150 });
accepts('88.5 半分', 'scores', { full: 100, score: 88.5 });
accepts('0 分', 'scores', { full: 100, score: 0 });

console.log('\n[students] 名单与档案');
rejects('学号 200 位', 'students', { studentNo: '9'.repeat(200), name: '张三' });
rejects('学号含空格', 'students', { studentNo: '5 5', name: '张三' });
rejects('学号负号', 'students', { studentNo: '-1', name: '张三' });
rejects('姓名 200 字', 'students', { studentNo: 'X1', name: 'P'.repeat(200) });
rejects('出生日 2011-13-45', 'students', { birth: '2011-13-45' });
rejects('出生日 0000-00-00', 'students', { birth: '0000-00-00' });
rejects('出生日 2099-01-01（未来）', 'students', { birth: '2099-01-01' });
rejects('出生日 1980（超范围）', 'students', { birth: '1980-01-01' });
rejects('家长 12 位号', 'students', { parent: '妈妈 139000088888' });
rejects('家长无号码', 'students', { parent: '妈妈' });
accepts('学号 007 前导零合法', 'students', { studentNo: '007', name: '张三' });
accepts('学号纯字母', 'students', { studentNo: 'ABC', name: '张三' });
accepts('正常档案', 'students', { birth: '2011-05-20', parent: '妈妈 13900008888', health: '良好' });

console.log('\n[announcements] 通知');
rejects('标题 500 字', 'announcements', { title: 'T'.repeat(500), content: 'x' });
rejects('正文 20000 字', 'announcements', { title: 't', content: 'X'.repeat(20000) });
rejects('标题纯空格', 'announcements', { title: '   ', content: 'x' });
accepts('正常通知', 'announcements', { title: '明日校运会', content: '早 7:30 到操场集合' });

console.log('\n[todos] 待办');
rejects('待办空标题', 'todos', { title: '   ' });
rejects('待办 61 字', 'todos', { title: '待'.repeat(61) });
rejects('待办日期倒置', 'todos', { title: '改作业', dueDate: '2026-13-40' });
rejects('待办日期非补零', 'todos', { title: '改作业', dueDate: '2026-9-6' });
rejects('待办日期 2999', 'todos', { title: '改作业', dueDate: '2999-12-31' });
rejects('完成标记非布尔', 'todos', { title: '改作业', done: 1 });
accepts('待办无日期', 'todos', { title: '想想口号', dueDate: '' });
accepts('待办正常', 'todos', { title: '批改试卷', dueDate: '2026-09-20', done: false });

console.log('\n[homework] 作业');
rejects('截止 2999-12-31', 'homework', { title: 't', dueDate: '2999-12-31' });
rejects('截止 2026-9-6 非补零', 'homework', { title: 't', dueDate: '2026-9-6' });
rejects('截止 2026-02-30', 'homework', { title: 't', dueDate: '2026-02-30' });
rejects('标题 300 字', 'homework', { title: 'H'.repeat(300), dueDate: '' });
accepts('明日到期', 'homework', { title: '语文默写', dueDate: (() => { const d = new Date(Date.now() + 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })() });

console.log('\n[classInfo] 班级信息');
rejects('学校 500 字', 'classInfo', { school: 'S'.repeat(500) });
rejects('班级 100 字', 'classInfo', { className: 'C'.repeat(100) });
accepts('正常班级', 'classInfo', { school: '示例中学', className: '初三(1)班' });

// 格式必须是「N 通过 / M 失败」：tools/mutate.js 的 runUnit 按这个正则抠结果，
// 写反了会让所有 unit 型变异体判成 NO_RUN（实测踩过，8 个变异体集体空跑）
console.log(`\n${pass} 通过 / ${fail.length} 失败`);
if (fail.length) { fail.forEach(f => console.log('  - ' + f)); process.exit(1); }
