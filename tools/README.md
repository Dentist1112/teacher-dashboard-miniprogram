# 工具链（本机验证过，2026-08-26）

云环境 ID：见根目录 `env.local.js`（本地私有，不入库）　AppID：见 `project.config.json`

| 命令 | 作用 | 耗时 |
|---|---|---|
| `node tools/check.js` | 静态自检：JSON/JS 语法、页面四件套、tabBar 一致、WXML 闭合、事件绑定的方法是否存在、**WXSS 选择器禁中文**、云函数结构、envId | <1s |
| `node tools/e2e.js` | 模拟器真跑 64 项：云登录→建集合→名单增改删→考勤存取→通知发布→概览聚合→watch 实时推送→清理 | ~35s |
| `./tools/deploy-fn.sh login initdb` | 部署云函数（首次创建会进 Creating，自动重试 5 次） | ~15s/个 |
| `node tools/audit-data.js` | 数据卫生 26 项（--fix 自动清理测试残留/孤儿/非法值） | ~18s |
| `node tools/seed.js --clear` | 灌 30 学生 + 考勤 + 4 通知 + 5 奖惩 + 60 成绩 + 4 作业 + 54 收交 | ~5s |
| `node tools/shot.js` | 8 页 + 4 个弹层/二级视图截图到 `tools/shots/`，含 MD5 撞检测 | ~2min |
| `python3 tools/shot-verify.py` | 像素级判定（空白页/导航栏/tabBar/弹层遮罩/表单卡） | ~1.5s |
| `./tools/gui.sh` | **看不到界面时跑这个**：打开项目窗口并置前 | ~10s |
| `./tools/ship.sh 1.0.4 "改了xx"` | 自检→E2E→数据卫生→视觉巡检→上传，一条命令 | ~5min |

## 已踩的坑（别重犯）

1. **WXSS 选择器不能含中文**。`.badge-高 {}` 会让整份 wxss 编译失败，症状是 `getCurrentPages()` 返回空、automator 报 `Cannot destructure property 'rawPath'`，而控制台只写「编译 .wxss 文件错误」不指行号。已加进 check.js。中文枚举值要在 js 里映射成 ASCII class（见 `PCLS`）。
2. **首次部署云函数必然失败一次**：函数处于 Creating 状态，等 20s 重试即可。deploy-fn.sh 已处理。
3. **automator 端口冲突**：上次进程没退时 9420 被占，e2e.js 用 9430；报 `Port xxx is in use` 就换端口或 `pkill -f wechatwebdevtools`。
4. **automator 的 `switchTab`/`reLaunch` 在 wxss 编译失败时会静默超时**，别当成跳转 API 的问题，先跑 check.js。
5. **小程序端单次 `get()` 最多 20 条**，`.limit(100)` 被静默截断（云函数端才是 100）。30 人的班级只显示 20 个就是这个原因。`utils/db.js` 的 `list()` 已改成 skip/limit 分页循环。**写任何统计/校验脚本时也要分页**，否则会得出错误结论（我用 limit(100) 查孤儿记录时误报了 7 条不存在的孤儿）。
6. **云函数 timeout 固定 3 秒，`config.json` 里写 timeout 不生效**（CLI 部署不读）。所以云函数里禁止串行 30 次 `await add()`，必须 `Promise.all` 并发；批量删用 `where().remove()` 一次往返。
7. **入口页必须是 tabBar 页**。原来 `pages/index/index` 排第一，它只有一行 OPENID 文字且不在 tabBar 里，打开就是一片空白没有底部导航，看着像"没生效"。已把 dashboard 提到首位并显式设 `entryPagePath`。
8. **「跑完检测后 IDE 里看不到界面」的根因是 `mp.close()`**（它会关掉项目窗口）。
   已全部改成 `mp.disconnect()`，脚本跑完你的窗口还在。**新脚本禁止用 close()**。
9. **端口不要各脚本各写一个**。disconnect 后端口一直开着，硬编码端口必撞
   （`Port 9491 is in use`）。统一走 `tools/mp.js` 的 `connectOrLaunch(9491)`：
   能 connect 就复用（快，audit-data 18s→5s），不能才 launch。
10. **E2E 断言不能假设库是空的**。seed 在「第一次月考」灌了 60 条成绩，
    成绩页统计/排名断言必须先切到独立考试名 `E2EEXAM`（曾因此误报 2 条失败，功能其实是好的）。
11. **看不到界面先出数值证据，别猜**：`node tools/shot.js && python3 tools/shot-verify.py`。
    判导航栏颜色不能只采一行像素（模拟器顶部有黑状态栏），要按区域统计占比。

## 已修的业务 bug

| bug | 症状 | 根因 | 修法 |
|---|---|---|---|
| WXSS 中文选择器 | 所有页面空白 | `.badge-高` 让整份 wxss 编译失败 | 改 ASCII 类名 + js 里映射 `PCLS` |
| seed 数据前端读不到 | 灌了 30 人但列表为空 | 云函数 admin 写入不带 `_openid`，前端「仅创建者可读写」读不到 | 每条 `add` 显式写 `_openid: openid` |
| 只显示 20 个学生 | 30 人的班少 10 个 | 小程序端 get 上限 20 条 | `list()` 分页循环 |
| 考勤点选后保存丢失 | 点了「迟到」保存后变空 | `watch` 触发 `merge()` 无条件重建列表，冲掉未保存的本地点选 | `this.dirty` 标记未保存行，`applyData` 优先保留；保存期间 `suspendMerge` 挂起 watch |
| 开发者工具里看不到界面 | 跑完检测后 IDE 项目窗口没了 | 脚本收尾调 `mp.close()`，它会关掉窗口（不是页面渲染问题，截图实测 7 页全正常） | 全改 `mp.disconnect()`；端口统一走 `tools/mp.js` 复用 |
| 小程序包体 1.6MB | 只加了一个页面却涨 600KB | `miniprogramRoot: "./"` 把 tools/（含 1.4MB 截图）和 docs/ 一起打包了 | `packOptions.ignore` 排除；已加进 check.js 第 8 项 |
| audit-data 直接 timeout | 加到第 7 个集合就崩 | 串行分页往返太多，撞 automator evaluate 超时 | 先 count 再并发拉所有分页，11.5s→3.8s |
| subview 截图全一样 | 3 张弹层图 MD5 完全相同 | 固定 sleep 后就截，拍到的是加载中骨架屏 | 每个 subview 配 `verify`，通过才截 + 截完复验 + MD5 撞检测 |
| profile-form 截不到 | 两轮重试全失败，verify 一直 false | enter 只调 `onEditProfile()`，重试时 reLaunch 回列表页 `current=null`，函数首行就 return | enter 自己补前置状态（先 onOpenDetail 再 onEditProfile）+ verify 加查 `form._id` |
| 每个 subview 都白跑一轮 | 6 个 subview 第 1 次全失败 | `mp.screenshot()` 在弹层打开时首次调用 100% timeout（stage 埋点实测），不是随机抖动 | 不重试 screenshot（重试反而更糟，实测丢 4 个），交给外层 reLaunch 重来；`waitFor` 加 `fatalTol=2` 只容忍紧邻 enter 的抖动 |
| e2e 长跑 3 项红、单独跑全绿 | watch/排序/级联删除在长跑里失败 | 状态累积：探针 watcher 未 close 拖垮 realtime；测试数据残留污染排序断言 | 探针 watcher 必 close；写入后 count 复核、清理后 count 复核为 0；失败分支打印云端自检 + toast |
| profile 切学生断言随机红 | 同一逻辑 400ms 有时通过有时失败 | 用 sleep 时长当断言条件，stats 何时补上取决于网络 | 改成同一次 evaluate 内同步读（`onBackToList()` + `onOpenDetail()` 后立刻读 data），再单独轮询验统计归属 |
| 座位网格塌成一列无人发现 | `.seat-row` flex→block 后 shot.js 报 0 错误、shot-verify 全 OK | 墨迹%/遮罩% 那套阈值对「布局塌陷」不敏感（PNG 151KB→94KB 也没触发任何规则） | 新增 `tools/seat-geom.py` 量几何：切横线数座位块，校验行数/列数/列宽均匀度/行间距，已接进 ship.sh |
| e2e 跑完在册 30→32 人 | audit 报「座位 32 条 > 在册 30 人」 | 「按学号铺满」把 e2e 探针学生也排了座，清理段只删学生没删座位 | 清理段改成全量扫孤儿座位；`check.js` 加 [CASCADE] 静态规则兜底 |
| seats-picked 截不到 | 报「没有未排座学生」 | subview 依赖 seed 留的 4 人未排座，但 e2e 跑完全班已排满 | enter 自己长按移出一个人造未排座（纯本地改动不写库） |
| reLaunch 回不到目标页 | 报「当前 pages/dashboard/dashboard」 | 非 tab 页 reLaunch 偶发不落地 | shot.js 的 relaunch 改成最多重试 3 轮并逐次打印 |

## 云函数

- `login`：返回 OPENID，app.js onLaunch 自动调
- `initdb`：幂等创建 21 个集合（集合不存在时前端写入会报 -502005），并发执行，timeout 20s

## 页面清单

| 页面 | 入口 | 状态 |
|---|---|---|
| 概览 dashboard | tab 1 | ✅ 统计卡/最新通知/今日异常/最近奖惩 |
| 名单 roster | tab 2 | ✅ 增删改查 + 学号查重 + 级联删除 |
| 考勤 attendance | tab 3 | ✅ 按日登记 + watch 实时 + dirty 保护 |
| 通知 announcement | tab 4 | ✅ 发布/删除 + 优先级 |
| 设置 settings | tab 5 | ✅ 班级信息单例 + 数据概况 |
| 奖惩 rewards | 概览「管理 ›」 | ✅ 登记/编辑/删除/筛选 + 积分归一化 |
| 成绩 grades | 概览快捷入口 | ✅ 批量录入 + 统计/排名(同分同名次)/分布桶 + 清空=删除 + 多考试多科目 |
| 作业 homework | 概览快捷入口 | ✅ 布置/编辑/级联删除 + 逐人收交(点击循环切状态) + 进度条 + 只看未交 + 一键全标 |
| 档案 profile | 概览快捷入口 + 名单行内「档案」 | ✅ 名册(搜索姓名/学号/手机 + 4 筛选 + 健康红标) + 单人档案(基本信息/拨号复制/聚合统计/最近异常与奖惩) + 编辑(生日/家长/健康/8 标签多选) |
| 座位 seats | 概览快捷入口 | ✅ 网格排座(点两格互换/挑人落座/长按移出) + 按学号铺满 + 随机排座(Fisher-Yates) + 换列数不丢人 + 保存走 diff(只写变化) |

**tabBar 已满 5 项（微信硬上限）**，后续页面一律 navigateTo。

| 值日 duty | 概览快捷入口 | ✅ 周表(5天×5岗) + 单日编排(挑人→点岗位) + 按学号轮排 + 随机轮排(Fisher-Yates) + 未排到告警 + 清空 + 保存走 diff |
| 课表 schedule | 概览快捷入口 | ✅ 周表(5天×8节) + 单日编排(挑科目→点格子填/长按清) + 一键模板(主科上午+第8节自习) + 冲突检测(主科每天>3 / 同科连排3) + 每科周课时统计 + 清空 + 保存走 diff(新增/改/撤三分支) |
| 班委 committee | 概览快捷入口 | ✅ 12 岗位一岗最多两人 + 挑人(按积分降序/只看未任职) + 按积分一键推荐(已定不覆盖) + 两类告警(核心岗空缺/一人跨岗兼>2) + 单人撤职/整岗清空 + 保存走 post@sid 集合 diff(add/remove) |

## 已上传版本

| 版本 | 内容 |
|---|---|
| 1.0.9 | 座位表 seats |
| **1.0.10** | 值日表 duty + 课程表 schedule + 对抗审查系统（蓝队 12 变异体 / 红队 duty+schedule）。7 步门禁全绿，包 189.6 KB |
| **1.0.11** | 班委名单 committee + 对抗系统扩至 18 变异体 / 3 套守恒律 + 新增 `--check-anchors` 与 `contrast.py` 门禁 + 界面改亮调 Apple 风（13 页专属主题色，106 处低对比度修到 0） |

## 当前基线（2026-08-29 实测，全绿）

```
node tools/check.js       →  11 项全过，<1s（[BUSY] 防连点 guard 静态门禁）
node tools/mutate.js --check-anchors → 18 个变异体锚点全部恰好 1 处，<0.1s
node tools/e2e.js         →  22 段 / 205 通过 / 0 失败，~14min
node tools/e2e-slice.js 20→  班委段 42 通过 / 0 失败，~55s（含脏数据防线 5 项）
node tools/e2e-slice.js 19→  课表段 35 通过 / 0 失败，~40s
node tools/audit-data.js  →  51 项数据卫生全过，~4s
node tools/shot.js        →  14 页 + 10 subview，运行期错误 0 条，~6min
python3 tools/shot-verify.py → 待 automator 恢复后复测（判定已改「薄荷底>40% + 标题白字>0.6%」，2026-09-05 主题 v2）
python3 tools/seat-geom.py   → 5 行 × 6 列，列宽 91~92px，行高 81~82px
python3 tools/contrast.py    → 423 组配色 + 13 页主题色全达 WCAG AA
node tools/mutate.js --all   → 18 个变异体，~35min
node tools/redteam.js 40     → duty R1~R7 + schedule S1~S9 + committee C1~C9，~8min
```

**每条门禁都反向注入验证过**（故意写坏 → 确认能抓 → 恢复），不是「跑过就算」。

## 对抗审查（2026-08-27 新增，详见 docs/ADVERSARIAL.md）

e2e 断言和业务代码出自同一心智模型，会一起漏同一个 bug（duty 实测：注入岗位空缺后
14 条断言全绿放行）。所以引入两个只看一半信息的对抗方：

| | 蓝队 `mutate.js` | 红队 `redteam.js` |
|---|---|---|
| 视角 | 设计者（看源码、改源码） | 使用者（只看页面和按钮） |
| 判定 | e2e 必须变红，不红=门禁有洞 | 只查用户可观察的守恒律 |
| 覆盖 | 18 个变异体（duty 4 / seats 2 / cascade 3 / schedule 5 / committee 4） | duty R1~R7、schedule S1~S9、committee C1~C9 |

```bash
node tools/e2e-slice.js --list        # e2e 的 22 段清单
node tools/e2e-slice.js 20           # 只跑班委段（~55s，全套 14min）
node tools/mutate.js --check-anchors # 锚点自检（失配=静默漏测，<0.1s）
node tools/mutate.js --tag committee # 蓝队跑班委那 4 个
TARGET=committee node tools/redteam.js 40      # 红队只攻班委
TARGET=committee SEED=4242 ROUNDS=1 node tools/redteam.js 25   # 复现某次失败
```

## 视觉门禁（2026-08-29 新增）

界面「好不好看」不可验证，但「字看不清」可以量：

```bash
python3 tools/contrast.py     # WCAG 2.1 相对亮度，全站配色 + 每页 --accent
```

主题已改成「薄荷×蜜桃」清新 v2（2026-09-05，用户拍板：明亮流行 + 女性化可爱）：
页面底薄荷雾白 `#F0FAF6`、卡片纯白、顶栏与 Tab 选中态薄荷主色 `#0E8F74`（白字）、
主按钮 `#0B7A62`、可爱强调/奖励用蜜桃粉 `#B23A5E`；按钮/标签全部胶囊圆角。
13 个页面各有专属 `--accent`（标题竖条 / 卡片顶线 / 主按钮用 accent，**不做大面积深色块**——
那会把字压到看不清，contrast.py 会直接报红）。首跑抓出 **106 处**（大正暖调时代）低对比度，
换 v2 令牌时借机修掉全部断链变量（--primary/--indigo/--bamboo/--wisteria 曾悬空）。

| 页面 | accent | vs 白 |
|---|---|---|
| dashboard | `#0B7A62` 主薄荷 | 5.28 |
| roster | `#1D5AA0` 清蓝 | 6.95 |
| attendance | `#A84E08` 暖橙 | 5.59 |
| announcement | `#17749B` 青空蓝 | 5.24 |
| committee | `#B0463C` 珊瑚 | 5.54 |
| duty | `#8A6A1A` 橄榄金 | 5.05 |
| grades | `#4A46B8` 靛紫 | 7.34 |
| homework | `#0E7490` 深青 | 5.36 |
| profile | `#6D3FA0` 紫藤 | 7.32 |
| rewards | `#B23A5E` 蜜桃粉 | 5.74 |
| schedule | `#C1355A` 莓粉 | 5.35 |
| seats | `#2F7A30` 草绿 | 5.32 |
| settings | `#5A6078` 雾灰蓝 | 6.21 |

语义色：薄荷 `--primary`（主行动/选中）、珊瑚 `--danger`（缺勤/删除/未排/健康风险）、
深金 `--gold`（暖点缀/次要链接）、靛蓝 `--indigo`（编辑/信息）、藤紫 `--wisteria`（关怀/女）。
警示一律用 `--danger`，**禁止再往 `--primary` 上挂警示语义**（v2 前 primary 同时当"品牌红+警示红"，
改 teal 后会把迟到/未交染成绿色，已逐页纠正）。

## 下一步（阶段8）

**联系方式 contacts** 或 **成长档案 growthEvents**（`cloudfunctions/initdb` 里集合都已有）。
每加一页按 `docs/AUDIT.md` 的必查清单走：
写页面 → check.js → e2e.js 加断言 → audit-data.js 加规则 → shot.js 加 SUBVIEWS
→ **mutate.js 加变异体（跑 --check-anchors）+ redteam.js 加独立守恒律与定向动作**
→ **contrast.py（新页要有 --accent）** → ship.sh。
`check.js` 的 [COVER] 规则会强制新页面必须进 shot.js 和 e2e.js，忘了会直接红。
