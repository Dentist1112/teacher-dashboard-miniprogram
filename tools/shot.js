// 截图巡检：逐页打开并截图到 tools/shots/，用于"看不到界面"类问题的视觉取证
const { connectOrLaunch, evalRetry } = require('./mp.js');
const path = require('path');
const fs = require('fs');
const PROJECT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'shots');
const PORT = Number(process.env.AUTO_PORT || 9491);
const crypto = require('crypto');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const md5 = f => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const shots = new Map(); // md5 → 名字，用来抓「两张图一模一样」

// screenshot 在弹层打开时会 timeout（实测 6 个 subview 里 5 个卡在这），
// 但**重试无效**：连接进入坏状态后只有 reLaunch 回本页才能恢复（实测 3 次重试全失败，
// 反而把原本能靠 reLaunch 救回的 4 个 subview 全搞丢）。所以这里不做重试，交给外层 attempt 循环。

// 轮询等条件成立，最多 waitMs（固定 sleep 会拍到加载中状态）。
// 连接层报错（timeout waiting for automator response / Connection closed）要立刻抛，
// 否则会在这里干等到超时，然后拿一张过期的截图当成功（实测踩过：3 张 subview 图 MD5 相同）
const FATAL = /timeout waiting for automator response|Connection closed/i;
// fatalTol：连接层抖动最多容忍几次。0 = 立刻抛（首屏用，抖动必须暴露）。
// subview 用 2：实测「enter 改完状态后紧接的第一个 evaluate」100% 抖一次 timeout，
// 一抖就抛会触发整轮 reLaunch，把 current 等前置状态冲掉（profile-form 就是这样两轮全废）。
// 仍然保留上限，不能无限吞——吞掉会拿过期截图当成功。
async function waitFor(mp, fn, waitMs = 10000, fatalTol = 0) {
  const t0 = Date.now();
  let lastErr = null;
  let fatals = 0;
  while (Date.now() - t0 < waitMs) {
    try {
      if (await mp.evaluate(fn)) return true;
      lastErr = null;
    } catch (e) {
      lastErr = e;
      if (FATAL.test(e.message || '')) {
        if (++fatals > fatalTol) throw e;
        console.log(`     ⚠️ 连接抖动 ${fatals}/${fatalTol}（${(e.message || '').slice(0, 34)}），继续等`);
        await sleep(1200);
      }
    }
    await sleep(400);
  }
  if (lastErr) throw lastErr;
  return false;
}

// 截图并保证「不与已拍到的任何一张字节相同」。
// 撞车的两个真实成因（都实测量到，不是猜）：
//  ① settings 这类 data 里**没有 loading 字段**的页，waitFor(loading !== true) 会立刻返回，
//     只 sleep 1.2s 就截图 → 抢在渲染前；
//  ② automator 的 screenshot 会返回**缓存旧帧**：实测 grades 连截 3 次拿到的都是同一张
//     dashboard 的字节（146675B，而真实 grades 帧约 116KB）。光 sleep 重截救不回来，
//     必须 renav（重新导航到本页）把渲染帧冲掉。
// SHOT_FAULT=<tag> 做故障注入：第 1 次强行写入上一张图的字节，用来验证重试路径真会触发。
let lastShotFile = null;
async function shootUnique(mp, file, tag, renav) {
  let dup = null;
  for (let k = 1; k <= 3; k++) {
    await mp.screenshot({ path: file });
    if (process.env.SHOT_FAULT === tag && k === 1 && lastShotFile) {
      fs.copyFileSync(lastShotFile, file);
      console.log(`     [FAULT] 注入：把 ${path.basename(lastShotFile)} 的字节写成 ${tag}`);
    }
    const sum = md5(file);
    dup = shots.get(sum) || null;
    if (!dup) { shots.set(sum, tag); lastShotFile = file; return { size: fs.statSync(file).size, dup: null }; }
    console.log(`     ⚠️ ${tag} 与 ${dup} 字节完全相同（第 ${k}/3 次）${renav ? '，重新导航后重截' : '，等 2.5s 重截'}`);
    if (renav) { try { await renav(); } catch (e) { console.log(`     ⚠️ renav 失败: ${(e.message || e).toString().slice(0, 40)}`); } }
    await sleep(1500);
  }
  lastShotFile = file;
  return { size: fs.statSync(file).size, dup };
}

const TABS = ['pages/dashboard/dashboard', 'pages/roster/roster', 'pages/grades/grades', 'pages/attendance/attendance', 'pages/announcement/announcement'];
const ROUTES = [...TABS, 'pages/settings/settings', 'pages/rewards/rewards', 'pages/homework/homework', 'pages/profile/profile', 'pages/seats/seats', 'pages/duty/duty', 'pages/schedule/schedule', 'pages/committee/committee', 'pages/all/all', 'pages/todo/todo', 'pages/login/login', 'pages/analytics/analytics'];

// 页面内的二级视图（弹层/切换视图），首屏截图覆盖不到。
// enter 触发进入，verify 必须返回 true 才截图 —— 否则会截到「加载中」骨架屏
// （实测踩过：3 张 subview 截图 MD5 完全相同，都是同一张加载中的图）
const SUBVIEWS = {
  'pages/homework/homework': [
    {
      name: 'check',
      enter: () => {
        const pg = getCurrentPages().slice(-1)[0];
        const first = pg.data.list[0];
        if (!first) throw new Error('作业列表为空，无法进收交面板');
        pg.onOpenCheck({ currentTarget: { dataset: { id: first._id } } });
      },
      verify: () => {
        const pg = getCurrentPages().slice(-1)[0];
        return pg.data.view === 'check' && pg.data.rows.length > 0;
      }
    },
    {
      name: 'form',
      // 不走 onBackToList（它可能弹确认框），直接 setData 回列表再开表单
      enter: () => {
        const pg = getCurrentPages().slice(-1)[0];
        pg.dirty = {};
        pg.setData({ view: 'list', current: null });
        pg.onAdd();
      },
      verify: () => {
        const pg = getCurrentPages().slice(-1)[0];
        return pg.data.showForm === true && pg.data.view === 'list';
      }
    }
  ],
  'pages/profile/profile': [
    {
      name: 'detail',
      enter: () => {
        const pg = getCurrentPages().slice(-1)[0];
        // 优先挑健康风险的学生，档案页最要紧的红色告警卡才会出现
        const s = pg.data.students.find(x => x.risk) || pg.data.students[0];
        if (!s) throw new Error('档案页没有学生');
        pg.onOpenDetail({ currentTarget: { dataset: { id: s._id } } });
      },
      // stats 是异步补的，等它到位再截，否则拍到「统计加载中…」
      verify: () => {
        const pg = getCurrentPages().slice(-1)[0];
        return pg.data.view === 'detail' && !!pg.data.stats;
      }
    },
    {
      name: 'form',
      // ⚠️ 必须自己先把 current 准备好：subview 不能依赖上一个 subview 的遗留状态
      // （实测事故：重试时 reLaunch 回列表页，current=null，onEditProfile 第一行就 return，
      //   verify 永远 false，两轮全废）
      enter: () => {
        const pg = getCurrentPages().slice(-1)[0];
        if (!pg.data.current) {
          const s = pg.data.students.find(x => x.risk) || pg.data.students[0];
          if (!s) throw new Error('档案页没有学生');
          pg.onOpenDetail({ currentTarget: { dataset: { id: s._id } } });
        }
        pg.onEditProfile();
      },
      verify: () => {
        const pg = getCurrentPages().slice(-1)[0];
        return pg.data.showForm === true && !!pg.data.form && !!pg.data.form._id;
      }
    }
  ],
  'pages/seats/seats': [
    {
      // 「挑中未排座学生 + 选中一个座位」两种高亮态都是独立的 CSS 分支，必须单独取证
      name: 'picked',
      // ⚠️ 不许依赖库里「刚好有人未排座」：e2e 跑完会把全班排满，那时这里必挂（实测踩过）。
      //    自己长按移出一个人造出未排座，再挑中他 —— 纯本地改动，不写库。
      enter: () => {
        const pg = getCurrentPages().slice(-1)[0];
        if (!pg.data.unseated.length) {
          const filled = [].concat(...pg.data.grid).find(c => !c.empty);
          if (!filled) throw new Error('座位表整个是空的，无法取证');
          pg.onClearCell({ currentTarget: { dataset: { r: filled.row, c: filled.col } } });
        }
        const un = pg.data.unseated[0];
        if (!un) throw new Error('造未排座失败');
        pg.onPickUnseated({ currentTarget: { dataset: { id: un._id } } });
        // 同时选中一个已占座位，让 seat-sel 高亮也进画面
        const filled2 = [].concat(...pg.data.grid).find(c => !c.empty);
        if (filled2) pg.setData({ [`grid[${filled2.row}][${filled2.col}].sel`]: true });
      },
      verify: () => {
        const pg = getCurrentPages().slice(-1)[0];
        return !!pg.data.pickedId && pg.data.grid.length > 0 && pg.data.unseated.length > 0;
      }
    }
  ],
  'pages/duty/duty': [
    {
      // 单日编排是独立的 wxml/wxss 分支（岗位卡 + 候选池 chips），首屏只有周表，必须单独取证
      name: 'day',
      enter: () => {
        const pg = getCurrentPages().slice(-1)[0];
        if (!pg.data.week.length) throw new Error('周表为空');
        pg.onOpenDay({ currentTarget: { dataset: { d: 1 } } });
        // 顺手挑一个学生，让 picked-bar 和 chip-sel 高亮也进画面
        const cand = pg.data.pool && pg.data.pool[0];
        if (cand) pg.onPickStudent({ currentTarget: { dataset: { id: cand._id } } });
      },
      verify: () => {
        const pg = getCurrentPages().slice(-1)[0];
        return pg.data.view === 'day' && pg.data.dayJobs.length === 5 && pg.data.pool.length > 0;
      }
    }
  ],
  'pages/schedule/schedule': [
    {
      // 单日编排是独立分支（节次列表 + 科目池 chips），首屏只有周表网格，必须单独取证
      name: 'day',
      enter: () => {
        const pg = getCurrentPages().slice(-1)[0];
        if (!pg.data.week.length) throw new Error('周表为空');
        pg.onOpenDay({ currentTarget: { dataset: { d: 1 } } });
        // 顺手挑一个科目，让 chip-picked 高亮和 picked-hint 也进画面
        pg.onPickSubject({ currentTarget: { dataset: { subject: '数学' } } });
      },
      verify: () => {
        const pg = getCurrentPages().slice(-1)[0];
        // ⚠️ 9 = 4 上午 + 午间延时 + 4 下午（PERIODS 长度）。写死 8 会让 verify 恒 false →
        //    该视图「两次都没拿到截图」，等于静默漏检（2026-09-05 实测踩到）。
        return pg.data.view === 'day' && pg.data.dayCells.length === 9 && pg.data.pickedSubject === '数学';
      }
    }
  ],
  'pages/committee/committee': [
    {
      // 挑人是独立分支（候选 chips + 积分排序），首屏只有岗位清单，必须单独取证
      name: 'pick',
      enter: () => {
        const pg = getCurrentPages().slice(-1)[0];
        if (!pg.data.posts.length) throw new Error('岗位清单为空');
        // 挑一个**空缺**岗位，让「空缺 → 挑人」这条主路径进画面
        const vacant = pg.data.posts.find(p => p.empty) || pg.data.posts[0];
        pg.onOpenPost({ currentTarget: { dataset: { post: vacant.post } } });
      },
      verify: () => {
        const pg = getCurrentPages().slice(-1)[0];
        return pg.data.view === 'pick' && !!pg.data.currentPost && pg.data.pool.length > 0;
      }
    }
  ],
  'pages/rewards/rewards': [
    {
      name: 'form',
      enter: () => getCurrentPages().slice(-1)[0].onAdd(),
      verify: () => getCurrentPages().slice(-1)[0].data.showForm === true
    }
  ],
  'pages/grades/grades': [
    {
      name: 'examform',
      enter: () => getCurrentPages().slice(-1)[0].onEditExam(),
      verify: () => getCurrentPages().slice(-1)[0].data.showExamForm === true
    }
  ],
  'pages/roster/roster': [
    {
      // 批量管理态：勾选框 + 全选/删所选/清空全班工具条
      name: 'batch',
      enter: () => {
        const pg = getCurrentPages().slice(-1)[0];
        pg.onToggleBatch();
        const s = pg.data.students[0];
        if (s) pg.onToggleSelect({ currentTarget: { dataset: { id: s._id } } });
      },
      verify: () => {
        const pg = getCurrentPages().slice(-1)[0];
        return pg.data.batchMode === true && pg.data.selectedCount === 1;
      }
    }
  ],
  'pages/attendance/attendance': [
    {
      // 全员正常 + 一人请假（带事由），截请假事由行
      name: 'leave',
      enter: () => {
        const pg = getCurrentPages().slice(-1)[0];
        pg.onMarkAllNormal();
        const s = pg.data.students[0];
        if (s) pg.applyStatus(s._id, '请假', '发烧');
      },
      verify: () => {
        const pg = getCurrentPages().slice(-1)[0];
        return pg.data.students.some(x => x.status === '请假' && x.reason === '发烧');
      }
    }
  ],
  'pages/analytics/analytics': [
    {
      name: 'month',
      enter: () => getCurrentPages().slice(-1)[0].onTab({ currentTarget: { dataset: { i: 2 } } }),
      verify: () => {
        const pg = getCurrentPages().slice(-1)[0];
        return pg.data.period === 'month' && pg.data.loading === false && !!pg.data.result;
      }
    }
  ]
};

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { mp, reused } = await connectOrLaunch(PORT);
  const errors = [];
  mp.on('exception', e => errors.push('exception: ' + (e.message || JSON.stringify(e))));
  mp.on('console', m => { if (m.type === 'error') errors.push('console.error: ' + JSON.stringify(m.args && m.args.map(a => a && (a.value !== undefined ? a.value : (a.description || a.preview || a.type)))).slice(0, 400)); });
  try {
    await sleep(reused ? 1500 : 7000);
    for (const r of ROUTES) {
      const isTab = TABS.includes(r);
      const goto = async () => {
        let landed = null;
        for (let i = 0; i < 3 && !landed; i++) {
          try {
            if (isTab) await mp.switchTab('/' + r); else await mp.reLaunch('/' + r);
            await sleep(1200);
            const cur = await mp.currentPage();
            if (cur && cur.path && cur.path.replace(/^\//, '') === r) landed = cur;
          } catch (e) { await sleep(1000); }
        }
        return landed;
      };
      let p = await goto();
      const name = r.split('/')[1];
      if (!p) { console.log('❌ 无法进入 ' + r); errors.push('无法进入 ' + r); continue; }
      // 等 loading 变 false 再截，不然拍到的是骨架屏（骨架屏的 png 各页长得一样，MD5 会撞）
      try {
        if (!(await waitFor(mp, () => {
          const pg = getCurrentPages().slice(-1)[0];
          return !!pg && pg.data.loading !== true;
        }))) errors.push(`${name} 加载超时（loading 一直是 true）`);
      } catch (e) { errors.push(`${name} 等加载时连接异常: ` + (e.message || e)); }
      // data 里没有 loading 字段的页（settings 等）上面那个 waitFor 是秒过的，
      // 等于没等 —— 这类页多等 2.5s，再叠加 shootUnique 的撞车重截兜底。
      let hasLoading = true;
      try {
        hasLoading = await evalRetry(mp, () => {
          const pg = getCurrentPages().slice(-1)[0];
          return !!pg && pg.data && Object.prototype.hasOwnProperty.call(pg.data, 'loading');
        }, [], 3);
      } catch (e) { hasLoading = true; }
      await sleep(hasLoading ? 1200 : 3700);
      const file = path.join(OUT, name + '.png');
      const shot1 = await shootUnique(mp, file, name, async () => {
        await goto();
        await sleep(hasLoading ? 1200 : 3700);
      });
      const size = shot1.size;
      // 数值验证：页面根节点渲染出多少 DOM（$('page') 选不到，用 evaluate 直接量）
      const dom = await evalRetry(mp, () => {
        const pg = getCurrentPages().slice(-1)[0];
        if (!pg) return { keys: 0, nodes: -1 };
        return { keys: Object.keys(pg.data || {}).length, nodes: -1 };
      }, [], 3);
      if (size < 20 * 1024) errors.push(`${name} 截图仅 ${(size / 1024).toFixed(0)}KB，疑似空白`);
      if (shot1.dup) errors.push(`${name} 截图与 ${shot1.dup} 完全相同（MD5 撞，已重截 3 次仍相同）`);
      console.log(`✅ ${name}  png=${(size / 1024).toFixed(0)}KB  data字段=${dom.keys}`);

      // 二级视图也要截：同一页面内的另一套 wxml/wxss 分支同样会编译失败或错位，
      // 只截首屏等于没验证（作业页的收交面板、表单弹层都在这里）
      for (const sub of (SUBVIEWS[r] || [])) {
        const tag = `${name}-${sub.name}`;
        let done = false;
        let stage = '';
        // 重试 2 轮：连接偶发抖动时重新 reLaunch 回本页再试，不要直接判失败
        for (let attempt = 1; attempt <= 2 && !done; attempt++) {
          try {
            stage = 'relaunch';
            if (attempt > 1) {
              // reLaunch 偶发不落地（实测掉回 dashboard），最多重试 3 轮，
              // 未落地就 enter 会打到上一个页面（实测报 pg.onAdd is not a function）
              let landed = false;
              for (let k = 0; k < 3 && !landed; k++) {
                await mp.reLaunch('/' + r);
                await sleep(2500);
                const back = await mp.currentPage();
                landed = !!(back && back.path.replace(/^\//, '') === r);
                if (!landed) console.log(`     ⚠️ reLaunch 第 ${k + 1}/3 次没落到 ${r}（当前 ${back && back.path}）`);
              }
              if (!landed) throw new Error('reLaunch 3 次都没回到 ' + r);
            }
            // 截图后紧接的第一个 evaluate 会稳定抖 timeout（踩坑 #11），
            // 走 evalRetry 就地重试，别让它触发整轮 reLaunch（那会丢掉 current 等前置状态）
            stage = 'enter';
            await evalRetry(mp, sub.enter, [], 3);
            stage = 'waitFor';
            if (!(await waitFor(mp, sub.verify, 12000, 2))) {
              // 只在最后一次才计入 errors：第 1 次失败后重试成功是正常路径（automator 抖动），
              // 无条件 push 会让 ship 因为「已经自愈的抖动」中止（实测 profile-detail 踩过）
              if (attempt === 2) errors.push(`${tag} 状态未就绪（verify 一直 false）`);
              else console.log(`   ↳ ${sub.name}  ⚠️ 第1次失败[waitFor](verify false)，重试`);
              continue;
            }
            await sleep(900); // 等渲染落地
            stage = 'screenshot';
            const f2 = path.join(OUT, tag + '.png');
            const shot2 = await shootUnique(mp, f2, tag);
            // 截完再验一次状态：确认这张图确实是目标视图，而不是过期缓存
            // ⚠️ 这里是「截图后紧接 evaluate」，100% 抖一次 timeout，必须走 evalRetry
            // （实测：不走重试的话每个 subview 第 1 轮都失败，白跑一次 reLaunch，整轮多花 60s）
            stage = 'reverify';
            if (!(await evalRetry(mp, sub.verify, [], 3))) {
              if (attempt === 2) errors.push(`${tag} 截图后状态已变，图不可信`);
              else console.log(`   ↳ ${sub.name}  ⚠️ 第1次失败[reverify](状态已变)，重试`);
              continue;
            }
            const s2 = shot2.size;
            if (s2 < 20 * 1024) errors.push(`${tag} 截图仅 ${(s2 / 1024).toFixed(0)}KB，疑似空白`);
            // 两张截图字节完全相同 = 至少有一张没拍到目标状态（实测踩过）。
            // 第 1 轮撞车就交给外层 attempt 循环重来（它会 reLaunch + 重新 enter，能冲掉缓存帧），
            // 只 sleep 干等救不回来（实测连截 3 次全是同一张陈旧图）。
            if (shot2.dup) {
              if (attempt === 2) errors.push(`${tag} 截图与 ${shot2.dup} 完全相同（MD5 撞，重试后仍相同），说明没真进入该视图`);
              else { console.log(`   ↳ ${sub.name}  ⚠️ 第1次失败[dup](与 ${shot2.dup} 字节相同)，重试`); continue; }
            }
            console.log(`   ↳ ${sub.name}  png=${(s2 / 1024).toFixed(0)}KB`);
            done = true;
          } catch (e) {
            const msg = e.message || String(e);
            if (attempt === 2) errors.push(`${tag} 进入失败[${stage}]: ` + msg);
            else console.log(`   ↳ ${sub.name}  ⚠️ 第1次失败[${stage}](${msg.slice(0, 40)})，重试`);
          }
        }
        // 两次都没拿到 = 这个视图根本没验证过。原先只 console.log 不进 errors，
        // ship.sh 只 grep「运行期错误 0 条」就会放行 —— 门禁有洞（反向注入验证过）。
        if (!done) {
          errors.push(`${tag} 两次都没拿到截图，该视图未经验证`);
          console.log(`   ↳ ${sub.name}  ❌ 两次都没拿到`);
        }
      }
    }
  } finally {
    console.log('\n运行期错误 ' + errors.length + ' 条');
    errors.slice(0, 20).forEach(e => console.log('  ⚠️ ' + e));
    await mp.disconnect();
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
