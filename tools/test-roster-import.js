#!/usr/bin/env node
/**
 * 拍照导名单的确认表逻辑单测（不连网、不开模拟器、<0.1s）。
 *
 * 为什么单独立一个：这段逻辑决定「哪些行会被写进 students」，
 * 而 students.studentNo 是考勤/成绩/座位/值日/班委的外键 ——
 * 学号分配错一个，后面五个模块全挂在错人身上，且不报错。
 * e2e 跑一遍要 14 分钟且依赖模拟器，这里用 stub 直接跑真实源码的方法。
 *
 * 用法: node tools/test-roster-import.js    （exit 1 = 有用例失败）
 */
const fs=require('fs');
const src=fs.readFileSync(require('path').join(__dirname,'..','pages/roster/roster.js'),'utf8');
let P=null;
// validate 必须给真的：roster.js 用 db.validate.strictInt 过滤脏学号，
// stub 成空对象会让被测代码走进不存在的分支（本测试文件曾因此报 TypeError）
const validate=require('../utils/validate.js');
const dbStub={isCloudReady:()=>true,watch:()=>({close(){}}),list:async()=>[],add:async()=>{},get:async()=>({}),title:()=>'',validate};
const req=name=>String(name).indexOf('/modal.js')>=0
  ? require('../utils/modal.js')
  : String(name).indexOf('/classinfo.js')>=0
    ? {get:async()=>({}),title:()=>''}
    : String(name).indexOf('/kb.js')>=0
      ? {bind(){},unbind(){}}
      : dbStub;
new Function('require','Page','wx','module','exports',src)(req,o=>{P=o},{showToast(){},showModal(){},showLoading(){},hideLoading(){},chooseMedia(){},cloud:{}},{exports:{}},{});

let pass=0,fail=0;
const t=(n,g,w)=>{const a=JSON.stringify(g),b=JSON.stringify(w);
  if(a===b){pass++;console.log('  ✅',n)}else{fail++;console.log('  ❌',n,'\n     got :',a,'\n     want:',b)}};

function mk(students){
  // ⚠️ 顺序要紧：先 Object.assign(pg,P) 会把 pg.data 覆盖成 P.data（共享引用），
  // 各用例互相污染 —— 第一版就是这个错，报出 2 条假红。data 必须最后独立赋。
  const pg={setData(o){Object.assign(this.data,o)}};
  Object.assign(pg,P);
  pg.data=JSON.parse(JSON.stringify(P.data));
  pg.data.students=students;
  return pg;
}
const S=(no,name)=>({_id:'x'+no,studentNo:no,name});

console.log('[起始学号推导]');
let pg=mk([]);
pg.openAiConfirm([{name:'张三'},{name:'李四'}]);
t('空库从 1 开始', pg.data.aiStartNo, '1');
t('学号 1,2', pg.data.aiRows.map(r=>r.no), ['1','2']);
t('将导入 2 人', pg.data.aiWillImport, 2);

pg=mk([S('1','甲'),S('7','乙')]);
pg.openAiConfirm([{name:'张三'}]);
t('接最大号 7 → 8', pg.data.aiStartNo, '8');
t('无冲突', pg.data.aiConflicts, 0);

pg=mk([S('01','甲'),S('12','乙')]);
pg.openAiConfirm([{name:'张三'}]);
t('前导零 01/12 → 13', pg.data.aiStartNo, '13');

console.log('[查重]');
pg=mk([S('5','已存在')]);
pg.openAiConfirm([{name:'张三'},{name:'李四'}]);
pg.setData({aiStartNo:'5'}); pg.rebuildAiRows();
t('撞云端学号被标记', pg.data.aiRows.map(r=>r.dup), ['学号已存在','']);
t('冲突计 1', pg.data.aiConflicts, 1);
t('只导入 1 人', pg.data.aiWillImport, 1);

console.log('[跳过不留学号空洞]');
pg=mk([]);
pg.openAiConfirm([{name:'甲'},{name:'乙'},{name:'丙'}]);
pg.onAiToggleSkip({currentTarget:{dataset:{i:1}}});
t('跳过中间行后学号连续', pg.data.aiRows.map(r=>r.no), ['1','','2']);
t('跳过后只导 2 人', pg.data.aiWillImport, 2);
pg.onAiToggleSkip({currentTarget:{dataset:{i:1}}});
t('恢复后学号回到 1,2,3', pg.data.aiRows.map(r=>r.no), ['1','2','3']);

console.log('[改名]');
pg=mk([]);
pg.openAiConfirm([{name:'张三'},{name:'李西'}]);
pg.onAiNameInput({currentTarget:{dataset:{i:1}},detail:{value:'李四'}});
t('改名生效', pg.data.aiRows.map(r=>r.name), ['张三','李四']);
t('改名不影响学号', pg.data.aiRows.map(r=>r.no), ['1','2']);
pg.onAiNameInput({currentTarget:{dataset:{i:0}},detail:{value:''}});
t('清空名字 → 不计入导入', pg.data.aiWillImport, 1);

console.log('[起始学号手改]');
pg=mk([]);
pg.openAiConfirm([{name:'甲'},{name:'乙'}]);
pg.onAiStartNoInput({detail:{value:'100'}});
t('起始 100', pg.data.aiRows.map(r=>r.no), ['100','101']);
pg.onAiStartNoInput({detail:{value:''}});
t('空起始号兜底为 1', pg.data.aiRows.map(r=>r.no), ['1','2']);
pg.onAiStartNoInput({detail:{value:'abc'}});
t('非法起始号兜底为 1', pg.data.aiRows.map(r=>r.no), ['1','2']);
pg.onAiStartNoInput({detail:{value:'0'}});
t('0 兜底为 1', pg.data.aiRows.map(r=>r.no), ['1','2']);

console.log('[空结果]');
pg=mk([]);
pg.openAiConfirm([]);
t('无姓名不开确认表', pg.data.aiShow, false);
pg.openAiConfirm([{name:'  '}]);
t('全空白名不开确认表', pg.data.aiShow, false);

console.log('[取消]');
pg=mk([]); pg.openAiConfirm([{name:'甲'}]); pg.onAiCancel();
t('取消清空状态', [pg.data.aiShow,pg.data.aiRows.length], [false,0]);

console.log('[粘贴名单解析 parsePasteNames]');
pg=mk([]);
const PN=t=>pg.parsePasteNames(t);
t('一行一个', PN('张三\n李四\n王五'), ['张三','李四','王五']);
t('空行忽略', PN('张三\n\n\n李四'), ['张三','李四']);
t('剔表头', PN('姓名\n张三\n序号'), ['张三']);
t('去重', PN('张三\n张三\n李四'), ['张三','李四']);
t('去内部空格', PN('张 三\n李\u3000四'), ['张三','李四']);
t('制表符整行只取姓名', PN('1\t张三\t男\t13800001111'), ['张三']);
t('逗号整行', PN('1,张三,男,13800001111'), ['张三']);
t('中文顿号一行三人全取', PN('张三、李四、王五'), ['张三','李四','王五']);
t('空格分隔一行三人', PN('张三  李四  王五'), ['张三','李四','王五']);
t('前缀序号 1.', PN('1.张三\n2.李四'), ['张三','李四']);
t('前缀序号 01 空格', PN('01 张三'), ['张三']);
t('剔纯数字行', PN('001\n张三'), ['张三']);
t('剔手机号', PN('13800001111\n张三'), ['张三']);
t('剔性别单元格', PN('男\n女\n张三'), ['张三']);
t('剔超长整行', PN('序号姓名性别家长电话备注一二三\n张三'), ['张三']);
t('英文名保留', PN('Tom\nJerry'), ['Tom','Jerry']);
t('单空格整行不丢人', PN('1 张三 男 13800001111'), ['张三']);
t('单空格两人', PN('张三 李四'), ['张三','李四']);
t('单字姓名不被切开', PN('张 三'), ['张三']);
t('混合分隔符', PN('1、张三\t2、李四'), ['张三','李四']);
t('整行全是噪声', PN('1 001 13800001111'), []);
// 带连字符的电话/学号（3-1-05 是本项目允许的合法学号写法）剥掉前缀数字后仍是纯符号数字，
// 必须被姓名过滤挡住 —— 变异体 roster-paste-nonumeric 守这条
t('剔带连字符电话/学号', PN('张三\n138-0000-1111\n3-1-05'), ['张三']);
t('空文本', PN(''), []);
t('纯空白', PN('   \n\t\n  '), []);
t('undefined 不炸', PN(undefined), []);

console.log('[粘贴 → 确认表]');
pg=mk([S('1','甲')]);
pg.setData({pasteText:'张三\n李四'});
pg.onPasteConfirm();
t('开确认表', pg.data.aiShow, true);
t('接最大号 1 → 2,3', pg.data.aiRows.map(r=>r.no), ['2','3']);
t('pasteText 已清空', pg.data.pasteText, '');
pg=mk([]);
pg.setData({pasteText:'姓名\n序号'});
pg.onPasteConfirm();
t('全是表头不开确认表', pg.data.aiShow, false);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail?1:0);
