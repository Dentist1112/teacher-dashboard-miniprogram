// 静态自检：JSON 合法性 / JS 语法 / 页面文件完整 / tabBar 与 pages 对应 / WXML 标签闭合
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
let errors = [];
let checked = { json: 0, js: 0, wxml: 0, pages: 0 };

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    if (f === 'node_modules' || f === 'tools' || f.startsWith('.')) continue;
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const files = walk(root);

// 1. JSON
for (const f of files.filter(f => f.endsWith('.json'))) {
  try { JSON.parse(fs.readFileSync(f, 'utf8')); checked.json++; }
  catch (e) { errors.push(`[JSON] ${path.relative(root, f)}: ${e.message}`); }
}

// 2. JS 语法
for (const f of files.filter(f => f.endsWith('.js'))) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); checked.js++; }
  catch (e) { errors.push(`[JS] ${path.relative(root, f)}: ${String(e.stderr).split('\n').slice(0,3).join(' ')}`); }
}

// 3. app.json 页面四件套 + tabBar 一致
const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
for (const p of app.pages) {
  checked.pages++;
  for (const ext of ['.js', '.wxml', '.json']) {
    if (!fs.existsSync(path.join(root, p + ext))) errors.push(`[PAGE] 缺文件 ${p}${ext}`);
  }
}
for (const t of (app.tabBar && app.tabBar.list) || []) {
  if (!app.pages.includes(t.pagePath)) errors.push(`[TABBAR] ${t.pagePath} 不在 pages 中`);
}

// 4. envId：优先 env.local.js（gitignored），其次 app.js 硬编码；开源克隆无配置 = 演示模式（提示，不报错）
const appjs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
let envId = (appjs.match(/envId:\s*'([^']+)'/) || [])[1];
try { envId = require(path.join(root, 'env.local.js')).envId || envId; } catch (e) {}
if (!envId || envId === 'YOUR_ENV_ID') {
  console.log('提示：未配置 envId（演示模式）。本地开发请建 env.local.js：module.exports = { envId: \'你的环境ID\' }');
  envId = '(demo)';
}

// 5. WXML 标签闭合 + 事件绑定的方法必须在同名 js 中存在
const VOID = new Set(['image', 'input', 'import', 'include', 'wxs', 'icon', 'progress', 'br']);
for (const f of files.filter(f => f.endsWith('.wxml'))) {
  checked.wxml++;
  const src = fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(src))) {
    const [, close, tag, , self] = m;
    if (self || VOID.has(tag)) continue;
    if (close) {
      const top = stack.pop();
      if (top !== tag) errors.push(`[WXML] ${path.relative(root, f)} 标签不匹配：</${tag}> 对应 <${top}>`);
    } else stack.push(tag);
  }
  if (stack.length) errors.push(`[WXML] ${path.relative(root, f)} 未闭合：${stack.join(',')}`);

  const jsPath = f.replace(/\.wxml$/, '.js');
  if (fs.existsSync(jsPath)) {
    const js = fs.readFileSync(jsPath, 'utf8');
    const handlers = new Set();
    let h;
    // ⚠️ 事件名清单必须包含 open-type 类事件（chooseavatar/getphonenumber…）：
    //    2026-09-06 加登录页时发现原清单只有通用事件，bindchooseavatar 绑错方法名
    //    静态检查静默放行 —— 真机点头像直接 "is not a function"。
    const hre = /\b(?:bind|catch|capture-bind|capture-catch)(?::?)(?:tap|input|change|confirm|blur|focus|longpress|submit|scroll|load|error|chooseavatar|getuserinfo|getphonenumber|opensetting|contact)\s*=\s*"([^"{}]+)"/g;
    while ((h = hre.exec(src))) handlers.add(h[1].trim());
    for (const fn of handlers) {
      if (!fn) continue;
      if (!new RegExp(`(^|[^\\w])${fn}\\s*[:(]`, 'm').test(js)) {
        errors.push(`[BIND] ${path.relative(root, f)} 绑定的 ${fn} 在 ${path.basename(jsPath)} 中不存在`);
      }
    }
  }
}

// 6. 云函数目录必须有 index.js + package.json
const cfRoot = path.join(root, 'cloudfunctions');
if (fs.existsSync(cfRoot)) {
  for (const d of fs.readdirSync(cfRoot)) {
    const dir = path.join(cfRoot, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const need of ['index.js', 'package.json']) {
      if (!fs.existsSync(path.join(dir, need))) errors.push(`[CLOUDFN] ${d} 缺 ${need}`);
    }
  }
}


// 7. WXSS 选择器禁止中文（真实事故：.badge-高 让整份 wxss 编译失败，页面栈为空）
for (const f of files.filter(f => f.endsWith('.wxss'))) {
  const src = fs.readFileSync(f, 'utf8');
  src.split('\n').forEach((line, i) => {
    const m = line.match(/[.#][A-Za-z0-9_-]*[\u4e00-\u9fff][^\s{,:]*/);
    if (m) errors.push(`[WXSS] ${path.relative(root, f)}:${i + 1} 选择器含中文「${m[0]}」→ wxss 编译会整体失败`);
  });
}

// 8. 打包体积：miniprogramRoot 是 ./ 时，tools/ docs/ 等开发目录会被一起打进小程序包
//    （实测事故：tools/shots 的 1.4MB 截图让包体从 114KB 涨到 1.6MB）
const PKG_EXCLUDE = ['tools', 'docs'];
try {
  const pc = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'));
  if ((pc.miniprogramRoot || './').replace(/^\.\//, '') === '') {
    const ignored = new Set(((pc.packOptions || {}).ignore || [])
      .filter(x => x.type === 'folder').map(x => String(x.value).replace(/\/$/, '')));
    for (const d of PKG_EXCLUDE) {
      if (fs.existsSync(path.join(root, d)) && !ignored.has(d)) {
        errors.push(`[PKG] ${d}/ 存在但没写进 project.config.json 的 packOptions.ignore → 会被打进小程序包`);
      }
    }
  }
} catch (e) {
  errors.push('[PKG] project.config.json 解析失败: ' + e.message);
}

// 9. 每个页面都必须进 shot.js 的 ROUTES + e2e.js 至少被引用一次
//    （实测事故：加了页面忘了进截图巡检，布局坏了没人发现；忘了加 e2e 断言等于没测）
try {
  const shotSrc = fs.readFileSync(path.join(root, 'tools', 'shot.js'), 'utf8');
  const e2eSrc = fs.readFileSync(path.join(root, 'tools', 'e2e.js'), 'utf8');
  const appPages = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).pages || [];
  for (const pg of appPages) {
    if (pg === 'pages/index/index') continue;         // 调试页，不进巡检
    // 只认 ROUTES/TABS 那两行：全文 indexOf 会被 SUBVIEWS 里的同名 key 蒙过去（实测漏抓）
    const routeLines = shotSrc.split('\n').filter(l => /^const (ROUTES|TABS)\s*=/.test(l.trim())).join('\n');
    if (routeLines.indexOf(pg) < 0) errors.push(`[COVER] ${pg} 不在 tools/shot.js 的 ROUTES/TABS 里 → 截图巡检漏这一页`);
    if (e2eSrc.indexOf(pg) < 0) errors.push(`[COVER] ${pg} 在 tools/e2e.js 里没被引用 → 这一页没有任何 e2e 断言`);
  }
} catch (e) {
  errors.push('[COVER] 覆盖率检查失败: ' + e.message);
}

// 10. 引用 studentId 的集合必须进 roster 的级联删除清单
//     （实测事故：漏 homeworkSubmit 留 3 条孤儿；漏 seats 会让网格静默丢格）
try {
  const rosterSrc = fs.readFileSync(path.join(root, 'pages', 'roster', 'roster.js'), 'utf8');
  // 级联清单已抽成 cascadeRefs()（单个删/批量删共用同一份），优先解析它；
  // 兼容内联写法。
  let cascadeBlock = (rosterSrc.match(/cascadeRefs\s*\(\)\s*\{[\s\S]*?return\s*\[([\s\S]*?)\];/) || [,''])[1];
  if (!cascadeBlock) cascadeBlock = (rosterSrc.match(/removeCascade\('students'[\s\S]*?\]\)/) || [''])[0];
  const REF_COLLECTIONS = ['attendance', 'rewards', 'scores', 'homeworkSubmit', 'contacts', 'seats', 'dutySchedule', 'committee'];
  for (const c of REF_COLLECTIONS) {
    if (cascadeBlock.indexOf(`'${c}'`) < 0) {
      errors.push(`[CASCADE] 集合 ${c} 引用 studentId 但不在 roster.js 的 removeCascade 清单里 → 删学生会留孤儿`);
    }
  }
} catch (e) {
  errors.push('[CASCADE] 级联清单检查失败: ' + e.message);
}

// 12. initdb 的集合数必须与 app.js 的 SCHEMA_VER 对得上
//     实测事故（2026-09-06）：加了 teacherProfile 集合，但 ensureDb 的门是布尔 mpInited=1，
//     老用户升级后新集合永远不建，写入一路报 "Db or Table not exist"。
//     规则：initdb 的 COLLECTIONS 条数变了，SCHEMA_VER 必须跟着 +1。
//     这里钉住「条数 → 版本号」的映射表，改集合就必须同时改这里，逼人想一遍迁移。
try {
  const initSrc = fs.readFileSync(path.join(root, 'cloudfunctions', 'initdb', 'index.js'), 'utf8');
  const block = (initSrc.match(/const COLLECTIONS = \[([\s\S]*?)\]/) || [, ''])[1];
  const nCol = (block.match(/'[^']+'/g) || []).length;
  const ver = Number((appjs.match(/SCHEMA_VER\s*=\s*(\d+)/) || [])[1] || 0);
  const EXPECT = { 23: 1, 24: 2, 25: 3 };   // 集合数 → SCHEMA_VER；新增集合时在此登记
  // 光有 SCHEMA_VER 常量不够：必须确认那个值真的被用在门上。
  // 变异测试实测（2026-09-06）：把门改回 `if (wx.getStorageSync('mpInited')) return;`
  // 时 SCHEMA_VER 常量还在，条数也对得上，这条检查却全绿 —— 变异体 SURVIVED。
  if (!/getStorageSync\('mpInited'\)\)\s*>=\s*SCHEMA_VER/.test(appjs)) {
    errors.push('[SCHEMA] ensureDb 的门没和 SCHEMA_VER 比较（应为 Number(getStorageSync("mpInited")) >= SCHEMA_VER）→ 老用户升级后新集合永不创建');
  }
  if (!ver) errors.push('[SCHEMA] app.js 里找不到 SCHEMA_VER（ensureDb 的版本门丢了 → 老用户不会补建新集合）');
  else if (!EXPECT[nCol]) errors.push(`[SCHEMA] initdb 有 ${nCol} 个集合，但 check.js 的 EXPECT 表里没登记 → 新增集合后请把 SCHEMA_VER +1 并在此登记`);
  else if (EXPECT[nCol] !== ver) errors.push(`[SCHEMA] initdb ${nCol} 个集合应对应 SCHEMA_VER=${EXPECT[nCol]}，实际 ${ver} → 老用户升级后新集合不会建`);
} catch (e) {
  errors.push('[SCHEMA] 集合版本检查失败: ' + e.message);
}

// 11. 防连点 guard 必须紧跟置位，中间不许有 await
//     变异测试实测：把 `this._busy` 换成 `this.data.saving` 时，7 个变异体里两个 SURVIVED，
//     一查是**等价变异体** —— 因为本项目所有 guard 到置位之间都是同步代码，两者行为一致。
//     但只要中间插入一个 await，控制权就会交还事件循环，第二次点击能穿过 guard 造成重复写。
//     这个危险区间没法靠 e2e 断言稳定复现（依赖时序），所以钉成静态门禁。
try {
  const pageFiles = walk(path.join(root, 'pages')).filter(f => f.endsWith('.js'));
  for (const f of pageFiles) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(root, f);
    const re = /if \(this\._busy\)\s*return;/g;
    let m;
    while ((m = re.exec(src))) {
      const line = src.slice(0, m.index).split('\n').length;
      const seg = src.slice(m.index + m[0].length, m.index + m[0].length + 3000);
      const setPos = seg.indexOf('this._busy = true');
      if (setPos < 0) {
        errors.push(`[BUSY] ${rel}:${line} 有 _busy guard 但 3000 字符内找不到 this._busy = true → guard 永久放行`);
        continue;
      }
      const between = seg.slice(0, setPos);
      const awaits = between.match(/\bawait\b/g);
      if (awaits) {
        errors.push(`[BUSY] ${rel}:${line} guard 到置位之间有 ${awaits.length} 个 await → 连点能穿过去重复写库，把 await 移到置位之后`);
      }
    }
    // 有云写入的方法必须有 guard（漏 guard 是真 bug，变异体 duty-no-busy/seats-no-busy 覆盖）
    // ⚠️ 不要用正则去配「整个函数体」：duty 的 onSave 有 60 行且结尾是 `\n  }\n});`，
    //    第一版 /...\n  \}/ 配不到，导致「删掉 guard」这种注入静默放行（反向验证抓到的）。
    //    改成按缩进切方法块：从 `  methodName(` / `  async methodName(` 起，
    //    到下一个同级方法（行首恰好 2 空格 + 标识符 + `(`）或文件结束。
    const methodRe = /^ {2}(?:async )?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm;
    const heads = [];
    let hm;
    while ((hm = methodRe.exec(src))) heads.push({ name: hm[1], start: hm.index });
    heads.forEach((h, i) => {
      h.end = i + 1 < heads.length ? heads[i + 1].start : src.length;
      h.body = src.slice(h.start, h.end);
      h.line = src.slice(0, h.start).split('\n').length;
    });
    const WRITE = /db\.(add|remove|update|set|removeCascade)\(/;
    // ⚠️ 判定必须认「guard 形态」`if (this._busy) return`，不能只查是否出现 `this._busy`：
    //    第一版用 indexOf('this._busy') 时，finally 段里的复位语句 `this._busy = false`
    //    也算命中，于是「删掉 guard」这种注入被静默放行（反向验证第二次才抓到）。
    const GUARD = /if \(this\._busy\)\s*return/;
    // 只读方法（refresh/load/onLoad 之类）不写库，不需要 guard；按「是否真有写调用」判定
    for (const h of heads) {
      if (!WRITE.test(h.body)) continue;
      if (GUARD.test(h.body)) continue;
      errors.push(`[BUSY] ${rel}:${h.line} ${h.name}() 有云写入(db.add/remove/update)但缺少 if (this._busy) return guard → 连点会重复写库`);
    }
  }
} catch (e) {
  errors.push('[BUSY] 防连点 guard 检查失败: ' + e.message);
}

/* ---- 数值规则一致性：客户端 validate.js 与云函数 api/index.js 都要报同一个数 ----
 * 不许两边各写一份然后靠记性对齐（2026-09-06 教训：满分上限 1000 是这一类漂移的产物）。
 * 改任一侧都得改另一侧，反向验证：故意改坏一侧必须被这里抓到。 */
try {
  const fsSync = require('fs');
  const valSrc = fsSync.readFileSync(path.join(__dirname, '..', 'utils', 'validate.js'), 'utf8');
  const apiSrc = fsSync.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'api', 'index.js'), 'utf8');
  // 抠两个关键常量：SCORE_MAX_FULL（满分上限）+ REWARD_MAX_POINTS（积分绝对值上限）
  const grab = (src, name) => {
    const re = new RegExp('(?:const|var|let)\\s+' + name + '\\s*=\\s*([0-9]+)');
    const m = src.match(re);
    return m ? Number(m[1]) : NaN;
  };
  const pair = [
    ['SCORE_MAX_FULL', valSrc, apiSrc],
    ['REWARD_MAX_POINTS', valSrc, apiSrc]
  ];
  for (const [name, a, b] of pair) {
    const va = grab(a, name), vb = grab(b, name);
    if (Number.isNaN(va) || Number.isNaN(vb)) {
      errors.push('[RANGE] 抓不到 ' + name + '：utils=' + va + ' api=' + vb);
    } else if (va !== vb) {
      errors.push('[RANGE] ' + name + ' 不一致：utils/validate.js=' + va + ' ≠ cloudfunctions/api/index.js=' + vb);
    }
  }
} catch (e) {
  errors.push('[RANGE] 一致性检查失败: ' + e.message);
}

/* ---- 键盘避让方式：form-sheet 必须用 margin-bottom 上移，禁止 padding-bottom ----
 * padding 是 sheet 内部滑动区，表单滑到 85vh 上限后 sticky 操作条仍在屏幕底 =
 * 键盘后面（用户真机反馈 2026-09-12：发布通知只能打字找不到发布按钮）。
 * margin-bottom 把整个 sheet 顶到键盘上方才是正解。模拟器没真键盘，只能靠这条静态门禁。 */
try {
  const wxmlFiles = files.filter(f => f.endsWith('.wxml'));
  for (const fp of wxmlFiles) {
    const f = path.relative(root, fp);
    const src = fs.readFileSync(fp, 'utf8');
    if (/form-sheet[\s\S]{0,200}kbH.*padding-bottom/.test(src) || /kbH.*padding-bottom[\s\S]{0,200}form-sheet/.test(src)) {
      errors.push('[KB] ' + f + ' 的 form-sheet 用 padding-bottom 避键盘，键盘弹起后操作条仍被挡 → 必须改 margin-bottom');
    }
  }
} catch (e) {
  errors.push('[KB] 键盘避让检查失败: ' + e.message);
}

/* ---- 浮层层级：mask 要高于普通内容，自定义 tabBar 弹层期间必须显式隐藏 ----
 * 真机事故 2026-09-13：通知发布弹层 z-index=100，自定义 tabBar z-index=900，
 * 底部「发布」按钮被导航栏截获触摸。实测仅提高 z-index 不够，自定义 tabBar 是独立组件层；
 * 所以除 CSS 外，tab 页弹层还必须显式隐藏导航。只修通知页会漏掉成绩/名单等同类弹层。 */
try {
  const tabCss = fs.readFileSync(path.join(root, 'custom-tab-bar', 'index.wxss'), 'utf8');
  const tabBlock = tabCss.match(/\.tb-wrap\s*\{([\s\S]*?)\n\}/);
  const tabZ = tabBlock && Number((tabBlock[1].match(/z-index:\s*(\d+)/) || [])[1]);
  if (!Number.isFinite(tabZ)) errors.push('[LAYER] 抓不到 custom-tab-bar/.tb-wrap 的 z-index');
  else {
    for (const fp of files.filter(f => f.endsWith('.wxss'))) {
      const src = fs.readFileSync(fp, 'utf8');
      const blocks = [...src.matchAll(/(?:^|\n)\.mask\s*\{([\s\S]*?)\n\}/g)];
      blocks.forEach(m => {
        const z = Number((m[1].match(/z-index:\s*(\d+)/) || [])[1]);
        const rel = path.relative(root, fp);
        if (!Number.isFinite(z)) errors.push(`[LAYER] ${rel} 的 .mask 缺少 z-index，可能被 tabBar 挡住`);
        else if (z <= tabZ) errors.push(`[LAYER] ${rel} 的 .mask z-index=${z} 必须大于 tabBar ${tabZ}，否则底部按钮点不到`);
      });
    }
  }

  for (const t of (app.tabBar && app.tabBar.list) || []) {
    const fp = path.join(root, t.pagePath + '.wxss');
    const src = fs.readFileSync(fp, 'utf8');
    if (!/page\s+\.container\s*\{[^}]*padding-bottom:\s*calc\(180rpx\s*\+\s*env\(safe-area-inset-bottom\)\)/.test(src)) {
      errors.push(`[LAYER] ${t.pagePath}.wxss 缺少 page .container 底部 180rpx 留白，普通内容会被浮动 tabBar 遮住`);
    }
  }

  // 只抬 z-index 不够：custom-tab-bar 是独立组件层（2026-09-13 真机截图实证），
  // tab 页的模态 mask 必须在打开时隐藏组件、关闭时恢复。
  const tabJs = fs.readFileSync(path.join(root, 'custom-tab-bar', 'index.js'), 'utf8');
  const tabWxml = fs.readFileSync(path.join(root, 'custom-tab-bar', 'index.wxml'), 'utf8');
  const tabWxss = fs.readFileSync(path.join(root, 'custom-tab-bar', 'index.wxss'), 'utf8');
  if (!/hidden:\s*false/.test(tabJs) || !/tb-hidden/.test(tabWxml) || !/\.tb-hidden\s*\{[^}]*display:\s*none/.test(tabWxss)) {
    errors.push('[LAYER] custom-tab-bar 缺少 hidden/tb-hidden 显隐能力，tab 页弹层会被独立导航层挡住');
  }
  for (const t of (app.tabBar && app.tabBar.list) || []) {
    const wxml = fs.readFileSync(path.join(root, t.pagePath + '.wxml'), 'utf8');
    if (!/class="[^"]*mask/.test(wxml)) continue;
    const js = fs.readFileSync(path.join(root, t.pagePath + '.js'), 'utf8');
    if (!/require\(['"][^'"]*\/modal\.js['"]\)/.test(js) || !/modal\.hideTabBar\(this\)/.test(js) || !/modal\.showTabBar\(this\)/.test(js)) {
      errors.push(`[LAYER] ${t.pagePath} 含 .mask 弹层，但未用 utils/modal.js 隐藏/恢复 custom-tab-bar`);
    }
  }
} catch (e) {
  errors.push('[LAYER] 浮层层级检查失败: ' + e.message);
}

console.log(`检查：${checked.json} json / ${checked.js} js / ${checked.wxml} wxml / ${checked.pages} 页面 / env=${envId}`);
if (errors.length) { console.error('\n发现 ' + errors.length + ' 个问题：'); errors.forEach(e => console.error(' - ' + e)); process.exit(1); }
console.log('全部通过 ✅');
