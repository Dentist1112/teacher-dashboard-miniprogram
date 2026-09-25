#!/usr/bin/env node
/**
 * ocrScore 的 parseRows 单测（不花 AI 额度、不连网、<0.1s）。
 *
 * 为什么必须有：识别结果的清洗逻辑是「AI 输出 → 落库」之间唯一的防线，
 * 但它的输入来自模型，靠跑真实识别来验证既慢又烧钱，而且模型输出不稳定，
 * 同一份代码两次跑结论可能不同 —— 那种「验证」不构成证据。
 * 这里把模型可能吐出的 13 种脏形态固化成用例，用真实源码跑。
 *
 * 用法: node tools/test-ocr-parse.js     （exit 1 = 有用例失败）
 * 注意: 直接读 cloudfunctions/ocrScore/index.js 源码，不是复制粘贴的副本
 *       —— 复制一份就会漂移，改了云函数这里还是绿的（工具链假绿踩过多次）。
 */

// 用真实源码里的 parseRows：把文件读进来，剥掉 cloud sdk 依赖后取函数
const fs=require('fs');
let src=fs.readFileSync(require('path').join(__dirname,'..','cloudfunctions/ocrScore/index.js'),'utf8');
src=src.replace(/const cloud = require\('wx-server-sdk'\);/,'const cloud={init(){},database:()=>({command:{}}),DYNAMIC_CURRENT_ENV:1};');
src=src.replace(/^exports\.main[\s\S]*$/m,'');
src+='\nmodule.exports={parseRows};';
const m={exports:{}};
new Function('module','exports','require','process',src)(m,m.exports,require,process);
const {parseRows}=m.exports;

let pass=0,fail=0;
const t=(name,got,want)=>{
  const g=JSON.stringify(got),w=JSON.stringify(want);
  if(g===w){pass++;console.log('  ✅',name);}
  else{fail++;console.log('  ❌',name,'\n     got :',g,'\n     want:',w);}
};

console.log('[roster 模式]');
t('正常 3 人', parseRows('[{"name":"张三"},{"name":"李四"},{"name":"王五"}]','roster').map(r=>r.name), ['张三','李四','王五']);
t('剔表头', parseRows('[{"name":"姓名"},{"name":"序号"},{"name":"张三"}]','roster').map(r=>r.name), ['张三']);
t('去重复', parseRows('[{"name":"张三"},{"name":"张三"},{"name":"李四"}]','roster').map(r=>r.name), ['张三','李四']);
t('去内部空格', parseRows('[{"name":"张 三"},{"name":"李\u3000四"}]','roster').map(r=>r.name), ['张三','李四']);
t('剔纯数字', parseRows('[{"name":"01"},{"name":"张三"}]','roster').map(r=>r.name), ['张三']);
t('剔超长整行', parseRows('[{"name":"序号姓名性别家长电话备注一二三"},{"name":"张三"}]','roster').map(r=>r.name), ['张三']);
t('中文键 姓名', parseRows('[{"姓名":"赵六"}]','roster').map(r=>r.name), ['赵六']);
t('markdown 围栏', parseRows('```json\n[{"name":"张三"}]\n```','roster').map(r=>r.name), ['张三']);
t('看不清用?保留', parseRows('[{"name":"张?"}]','roster').map(r=>r.name), ['张?']);
t('英文名保留', parseRows('[{"name":"Tom"}]','roster').map(r=>r.name), ['Tom']);
t('roster 不带 score', parseRows('[{"name":"张三","score":95}]','roster')[0].score, null);
t('空数组', parseRows('[]','roster'), []);
t('剔纯符号', parseRows('[{"name":"---"},{"name":"张三"}]','roster').map(r=>r.name), ['张三']);

console.log('[score 模式回归 — 不许被 roster 改动影响]');
t('成绩正常', parseRows('[{"name":"张三","score":95}]','score'), [{name:'张三',score:95,conf:1}]);
t('分数 null', parseRows('[{"name":"张三","score":null}]','score')[0].score, null);
t('不传 mode 默认 score', parseRows('[{"name":"张三","score":88}]')[0].score, 88);
t('score 保留重名（不同人同名靠老师判定）', parseRows('[{"name":"张三","score":1},{"name":"张三","score":2}]','score').length, 2);

// ---- 静态检查：parseRows 之外的调用链盲点 ----
// 动因（实测）：把「重试时漏传 mode」注入进去，上面 17 个用例全绿放行 ——
// 单测只覆盖 parseRows，管不到 recognize 的递归调用。漏传的后果是静默退回
// 成绩模式：老师拍名单，AI 按「找姓名+分数」去读，返回一堆 score=null，
// 页面不报错、只是识别得莫名其妙差 —— 这是最难查的一类 bug。
console.log('[静态检查 — 调用链]');
const rawSrc = fs.readFileSync(require('path').join(__dirname,'..','cloudfunctions/ocrScore/index.js'),'utf8');
const recCalls = rawSrc.match(/recognize\([^)]*\)/g) || [];
const inner = recCalls.filter(c => /true/.test(c));   // 重试那次
t('recognize 重试调用必须带 mode', inner.length >= 1 && inner.every(c => /mode/.test(c)), true);
t('main 必须做 mode 白名单', /event\.mode === 'roster' \? 'roster' : 'score'/.test(rawSrc), true);
t('parseRows 调用必须传 mode', /parseRows\(content, mode\)/.test(rawSrc), true);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail?1:0);
