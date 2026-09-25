# 审查清单（每次改动后过一遍）

> 这些不是理论风险，全部是本项目**实测发现并修复**的真 bug。加新页面时逐项对照。

## 自动化门禁

```bash
node tools/check.js        # 静态 11 项，<1s
node tools/mutate.js --check-anchors  # 变异体锚点自检 18 个，<0.1s（失配=静默漏测）
node tools/e2e.js          # 模拟器真跑 22 段 / 205 项，~14min
node tools/audit-data.js   # 数据卫生 51 项，~4s（--fix 自动清理）
node tools/mutate.js --all # 蓝队变异测试 18 个变异体，~35min
node tools/redteam.js 40   # 红队黑箱乱序 duty+schedule+committee，4 轮 × 40 步，~8min
node tools/shot.js && python3 tools/shot-verify.py   # 14 页 + 10 subview 截图 + 像素判定，~6min
python3 tools/seat-geom.py # 座位网格几何量测（墨迹%抓不到「网格塌成一列」）
python3 tools/contrast.py  # 全站配色对比度（WCAG AA）+ 每页专属 accent，<1s
./tools/ship.sh 1.0.11 "说明"  # 上面全部 + 上传（任一步红就中止）
```

## 已修 bug 台账

| # | 症状 | 根因 | 修法 | 回归项 |
|---|---|---|---|---|
| 1 | 所有页面空白 | WXSS 中文选择器 `.badge-高` 让整份 wxss 编译失败 | ASCII 类名 + js 里 `PCLS` 映射 | check.js 规则 7 |
| 2 | 打开是空白无导航 | 入口页是非 tabBar 的调试页 | dashboard 提到 pages[0] + `entryPagePath` | check.js |
| 3 | 30 人只显示 20 个 | 小程序端单次 `get()` 上限 20 条，`.limit(100)` 静默截断 | `list()` skip/limit 分页循环 | e2e [7][12] |
| 4 | 考勤点选后保存丢失 | watch 触发 `merge()` 无条件重建列表，冲掉未保存点选 | `this.dirty` 标记 + 保存期 `suspendMerge` | e2e [5] |
| 5 | 灌了数据前端读不到 | 云函数 admin 写入不带 `_openid`，前端「仅创建者可读写」读不到 | 每条 add 显式 `_openid: openid` | e2e [2] |
| 6 | 云函数 3s 超时 | `config.json` 的 timeout 不生效（CLI 不读），串行 30 次 add | `Promise.all` 并发 + `where().remove()` 批量删 | seed 能跑通即证明 |
| 7 | 「最新通知」不是最新 | `limit(3)` 无 `orderBy`，云端返回任意 3 条，前端再排也救不回 | `list()` 支持 `opts.orderBy`，排序交给云端 | e2e [10] |
| 8 | 删学生留孤儿 | 只删 students，考勤/奖惩残留，概览显示乱码 id | `removeCascade()` + 概览显示「已删除学生」 | e2e [11][13] |
| 9 | 连点发布插 3 条 | `this.data.saving` 由 setData 异步更新，同 tick 连点穿透 | 同步实例标志 `this._busy` | e2e [9] |
| 10 | 学号可重复 | 无校验，考勤/成绩会挂错人 | 保存前查重并拦截 | e2e [11] |
| 11 | 班级名写死 5 处且不一致 | 硬编码在 WXML | `utils/classinfo.js` 单例 + 设置页 | e2e [12] |
| 12 | 奖惩只能看不能改 | 概览显示 rewards 但无任何 CRUD 入口（断头功能） | 新建 `pages/rewards`，概览「管理 ›」跳转 | e2e [13] |
| 13 | 删学生留孤儿收交 | `removeCascade` 的 refs 漏了新集合 `homeworkSubmit`（实测删 1 人留 3 条） | roster.js 补上该 ref；清单里加「新集合要回头补 roster 的 refs」 | e2e [15] audit「孤儿收交_学生已删」 |
| 14 | 30 人全部无法拨号 | seed 的家长手机号写成掩码 `138****01`，正则抠不出号码 | seed 改成完整 11 位；e2e 断言「有家长信息的人必须都能抠出手机号」 | e2e [16] |
| 15 | `audit --fix` 报告不可验证 | fixed 只报总数，分不清「没脏数据」还是「没跑到」 | fixed 细化成 10 项各自出数字 | audit-data 自身 |
| 16 | 档案页切学生串上一人统计 | `stats` 是异步补的，切换时不清空会短暂显示前一人数据 | `openDetail` 同步 `stats: null` + `this._statsFor` 丢弃过期结果 | e2e [16] 两项 |
| 17 | 「档案」入口点错到奖惩 | 概览同页多个同类入口共用 `.quick-btn` 类名 | 加区分类名 `.link-rewards`/`.link-profile` | e2e [16] |
| 18 | 删学生留孤儿座位 | `removeCascade` 的 refs 又漏了新集合 `seats`（第二次犯同类错） | 补 ref + **check.js 第 10 条静态兜底**：凡引用 studentId 的集合不在清单里就报错 | check.js [CASCADE]（反向注入验证过） |
| 19 | e2e 跑完在册 30→32 人、座位留孤儿 | 「按学号铺满」把 e2e 的探针学生也排了座，清理段只删学生没删座位 | 清理段加全量扫孤儿座位（比逐个 id 删可靠） | audit「孤儿座位_学生已删」+ e2e [19] 报「孤儿座位 N」 |
| 20 | 座位网格塌成一列没人发现 | `.seat-row` 的 flex 坏掉后，shot.js 报 0 错误、shot-verify 全 OK（PNG 151KB→94KB 也没抓） | 新增 `tools/seat-geom.py` 量几何：行数×列数/列宽均匀度/行间距 | seat-geom.py（注入 `display:block` 验证过能抓） |
| 22 | 课表填完一格后接着点会连填一片 | `onTapCell` 填课后没清 `pickedSubject`（duty/seats 都是填完就清） | 填完 `setData({pickedSubject:''})` | e2e [19]「填课后自动清掉选中科目」 |
| 23 | 冲突检测断言形同没测 | [19] 只比「页面冲突数 == 复算冲突数」，而上一轮收尾把 40 格换成零冲突的模板 → `0 == 0` 恒真（实测 probe：total=40 / over=[]） | 段首强制造两类冲突（周一 4 节语文 / 周三 4~6 节数学），并要求 `>=2` 且两类都命中 | e2e [19]（注入 `MAX_MAIN_PER_DAY=99` 验证过能抓） |
| 24 | 红队 25 步撞不出课表冲突 | 纯随机填课几乎不会让同一天同一主科超 3 节 → S6 守恒律无从触发，注入 `MAX_MAIN_PER_DAY=99` 也全绿 | 加定向动作 `stack-main-subject`（一天前 5 节填同一主科，同时触发超上限+连排两类） | redteam S6（注入验证：4 类问题被抓） |
| 30 | shot.js 有两个门禁洞 | ① 第 1 次 verify 失败就 push errors，重试成功后仍算红 → ship 因已自愈的抖动中止（实测 `profile-detail`）② **两次都没拿到截图只 `console.log` 不进 errors** → ship 只 grep「运行期错误 0 条」直接放行，该视图等于没验证 | ① 只在 `attempt === 2` 计入 ② `if (!done) errors.push(...)` | 反向注入：把 `schedule-day` 的 verify 改成恒 false → 报 2 条错误 + 退出码 1 |
| 26 | 课表保存成功后按钮仍写着「保存」 | `onSave` 只清 `this.dirty`，`render()` 没像 duty/seats 一样带 `dirtyFlag: !!this.dirty` → 老师以为没存上，反复点 | `render()` 里同步 `dirtyFlag` | e2e [19]「dirty+dirtyFlag+saving 全清」+ 变异体 `sched-dirtyflag-stuck` |
| 27 | 抽段跑报 `FATAL $retry is not defined`，被 mutate 读成「基线就是红的」 | `e2e-slice.js` 的 runner **手抄**了 ok/bad/goto，给 e2e.js 加新 helper 后两边漂移 → 工具链故障伪装成业务失败 | runner 改成从 e2e.js **自动提取所有顶层函数**注入；另加静态检查：段内引用了 e2e.js 顶层 const 而 runner 没提供就直接报错 | `SLICE_EMIT_ONLY=1 node tools/e2e-slice.js 19` 看注入结果 |
| 28 | [19] 段首前置假设「库里有课」 | `sched-conflict-off` 变异体跑完把云端清成 0 条，下一次抽段 `dropped=0` → 报「前置准备失败」 | 段首兜底：库为空时自灌 40 格模板再摘 | 反向验证：手动 wipe 云端后跑 [19]，报「库为空，自灌 40 格」并 35/0 |
| 29 | 概览入口 `$()` 一次性查询偶发 null | 抽段跑刚 reLaunch 完，第一次 selector 查询会抖 → 误报「概览缺 .link-schedule-quick 入口」 | 新增 `$retry(pg, sel, 4)`，全部 `.link-*` 查询走它 | mutate 基线不再随机红 |
| 25 | 红队跑完留半残课表 | S9 门槛写 `restored === 0`，乱按常留十几节，虽不空但用户看到就是「表坏了」 | 门槛改 `< 40`（套模板应有值），恢复循环最多 3 次 | redteam S9 |
| 31 | `--tag committee` 连跑 2 个变异体报 `FATAL "undefined" is not valid JSON`，单跑却精准命中 | **不是解析层的错**：`[20]` 段首 `commPrep` 假设「库非空 ⇒ 班长一定在」，上一轮收尾留下「12 条但没班长」→ prep 早退 → 兼岗告警造不出来 → 下游断言级联失真 | prep 班长缺就自己任命一个；另给 `runSlice` 加原始日志落盘 `/tmp/mutate-logs/` + `JSON.parse` 容错 | 手动造「无班长」脏态后跑 [20]，36/0 全绿 |
| 32 | `comm-dup-post-through` SURVIVED（真盲点，非等价变异体） | 段内从没造过「云端同岗两条」的形态，删掉 `buildFromCloud` 去重毫无可观测差异 | 加「脏数据防线」：注入 3 条脏任职（同岗重复/枚举外/孤儿）→ 重载 → 断言只取第一条、孤儿不上屏 → 清干净。**[20] 36→42 项** | 补完重跑该变异体：KILLED 且命中期望断言 |
| 33 | `mutate.js` 报「代码没还原干净: roster.js」+ exit 4（假红） | `stillDirty` 拿 `/tmp/mutate-backup/` 的**历史残留**比对，跑只碰 committee.js 的变异体时被上一轮旧备份骗 | 只比对**本轮真备份过的文件**（新增 `restoredPaths` Map，在 `restoreAll()` 里填） | 单跑 `comm-warn-off` exit 0 |
| 34 | 变异体锚点失配会**静默漏测** | 给 roster `removeCascade` 加 committee 后行尾多了逗号，`duty-cascade-off` 锚点变 0 处；`inject()` 返回 `okInject:false` 但汇总看不出少了一个 | 新增常驻门禁 `node tools/mutate.js --check-anchors`（<0.1s），`--all`/`--tag` 开跑前也先自检 | 手动改锚点行 → 报失配 + exit 2 |
| 35 | 红队第一轮报 C5「挑人视图停在枚举外岗位」（我的动作越界，非业务 bug） | `assign-no-post` 用 `pg.setData({currentPost:''})` 直接改内部状态，造出合法路径到不了的形态 | 改成 `assign-after-back`（先点返回再重放任命）。**红队铁律：只走页面事件处理器** | 改后同种子全绿；再注入 2 个真 bug 仍被 C6/C7/C8 抓到 |
| 36 | e2e [19] 课表前置写死 `total === 40`（规则 14 再犯） | 红队跑完云端留 30 节 → 报「课表前置灌数异常」。写死条数=依赖上一轮收尾 | 改成 `>= 1 && <= 40`，真前置由下一步显式造 | 重跑 [19] 35/0 |
| 37 | 全站 106 处文字对比度不达标（字看不清） | `#888`/`#999`/浅金 `#A98B2F`/浅灰占位字（`空缺`/`未安排`/`未登记`）大量低于 WCAG AA 4.5 | 新增 `tools/contrast.py` 量化 + 主题改亮调：`--text2 #55555C`、`--gold #8A6D14`、`--bamboo #3D6A4A`，占位灰全提到 AA | 106 → 0；脚本自身做过 2 次假红修正（读 wxml 共现类 / 沿祖先链取底色） |
| 38 | `shot-verify.py` 导航栏判定改亮调后 23 页「标题字%」全等 15.33 | 采样窗口 `y=0.028h~0.075h` 量的是**模拟器自己的深色工具条**，等于 `0 == 0` 型判定 | 逆向排查真实位置 `y≈0.068h~0.098h`，改后各页 2.44%~4.25% 不再恒等 | 两种坏图（导航涂黑 / 标题擦掉）反向注入都被抓 |
| 39 | `seat-geom.py` 报「各行列数不一致 [6,6,6,6,6,4]」（主题改亮引起的脚本误判） | 「未排座」chips 底色从页面底色变成 `#F2F2F5`，不再被 `PAGE` 过滤 → 被当成「第 6 行座位」 | 按列宽中位数剔除偏离 >20% 的 band（座位 91~92px vs chips 125~126px） | 塌网格 / 列错位两种坏图反向注入仍能抓 |
| 21 | 每加一页要回头改 3 处入口断言 | e2e 写死 `quickBtns.length === 4` 且用下标 `quick3[2]` 点击 | 每个入口给专属类名 `.link-xxx-quick`，断言按类名查存在性 | e2e 全文已无写死数量 |
| 40 | 红队 seed=76405/84324/92243 值日保存后云端 40~44 条 ≠ 页面 28 人次、dirty 没清、再保存报「新增26/撤26」整表翻写 | 批量并发写用 `Promise.all`：一批里某条限流/传输失败时其余写入已落库（云端半迁移），catch 只 toast 不回读，`this.dutyRecords` 停在保存前旧快照；重试按旧基线 diff 把已成功的新增再插一遍（集合无唯一索引→重复文档） | duty/schedule/committee/seats 四页统一改 `Promise.allSettled` 收集失败项，**成败都先回读云端真值锚定 diff 基线**（只锚原始记录、不重建本地编排），有失败保 dirty 提示「再点保存补齐」，弱网回读失败也保本地不假装成功 | 三种子红队全转绿（28/28、收尾恢复） |
| 41 | 周表挑科目点一格后科目不脱手，再点别的格子连填一片 | `onCellPick` 填课分支漏了 `setData({pickedSubject:'',swapFrom:''})`（注释还在、代码被前序改动误删，是真实回归）；蓝队锚点 `sched-week-stickypick` 因此失配秒退 | 恢复清选中行；锚点重新匹配（这是「蓝队锚点失配」机制抓到真回归的实例，不是误报） | 锚点 62/62 + e2e [19] 292/0 |
| 42 | watch 弱网重连 5 次只覆盖 ~1.5s 后永久静默失效 | 退避写成 `100*attempts`，login/realtime INIT_LOGGING_IN 没结束就把 5 次重连耗光；旧 watcher 迟到回调也能污染新连接 | 退避恢复 `800*attempts`（测试用等待窗适配，不缩短生产值）；加 `connectSeq`，旧连接 onChange/onError 一律忽略 | test-db-paging 30/0（新增旧连接回调忽略用例） |
| 43 | 红队固定 `sleep(9000)` 后读云端，弱网保存还在进行就读到迁移中途态（total≠fetched） | 用固定时长等一个异步保存结束，慢就是误报、卡死又死等 | 新增 `waitSaved()` 轮询页面 `_busy` 回落（上限 60s）再校验 + 短收敛窗；值日收尾条件从 `restored===0` 改为「=轮排应有人次」，40+ 条残数据也会被恢复 | 三种子复跑无中途态误报 |
| 44 | 完整 e2e 唯一红 `initdb -404006 empty poll result`（291/1） | 云函数部署(Updating)期瞬态错误，但 callFunction 在页面里被 catch 成 `{error}`，外层 evaluate 成功、触发不到 mp 层 FLAKY 重试 | initdb 调用内部对 `-404006/empty poll/Timeout` 重试 4 次（递增 2s） | 重灌种子后完整 e2e 292/0 |
| 45 | 蓝队 `mutate --all` 跑 40 分钟不出结果，进程在死等 | 复用的 9491 自动化端口中途 ECONNREFUSED，WebSocket 关了但脚本在无限等 I/O | 重连前先探活；跑长测输出落日志可查；基线/变异必须在「标准种子→完整 e2e」干净顺序上做，中途手插 slice 会污染基线（实测 74/3 假红，单跑 23/0 澄清） | 基线 172/0 |
| 46 | 班委「一岗一人」改为「一岗最多两人」（2026-09-13 需求） | 旧模型 post→单 studentId，无法给一个岗位配两人；脏数据防线把「同岗两条」一律当脏剔除，和新需求直接冲突 | 数据模型改 post→[sid1,sid2]（≤2、去重、按学号排序），保存改 post@sid 集合 diff（只有 add/remove，无 update），每人可单独撤、长按整岗清空；审计/红队 C3/e2e[20]/变异体口径全部从「同岗≤1」改为「同岗≤2 且无同人重复、上限 24 条」 | e2e[20] 44/0、蓝队 5/5 KILLED、红队 committee 4轮×40步 0破绽（每轮收尾云端恢复12条） |
| 47 | 真人 48 人学号乱（1、32~78 混排），要求按姓氏拼音重排 1→48 | 云数据库按 openid 隔离，模拟器是测试号（30 假名），真人数据在用户本人 openid；本机/云函数 ICU 对多音字姓氏排序不可靠（查/单/解 实测排错） | rosterfix 云函数只负责「按 openid 分组+服务端强校验（48条/同组/无重无漏）」，排序在本机逐姓人工核定拼音后回传有序 _id 列表写库；同音字 tiebreak 按名字拼音（修正汪/王：王梦双 24、汪雯祥 25）；一次性修复，完成后下线函数 | 回读 01~48 无缺号重号；性别未动 |

## 数据卫生检查项（tools/audit-data.js，46 项）

```
测试残留：学生 / 通知 / 奖惩（按学号前缀 + 姓名关键词 + _probe/_reg 标记识别）
引用完整：孤儿考勤 / 孤儿奖惩（studentId 指向已删学生）
唯一约束：重复学号 / 同人同日多条考勤 / classInfo 单文档
字段完整：学生缺姓名 / 考勤缺状态 / 奖惩缺事由或学生
取值合法：考勤状态必属 [正常,迟到,缺勤,请假] / 奖惩积分符号（惩戒必负，奖励必正）
成绩：测试残留成绩 / 成绩超范围(0~full) / 缺考试或科目或满分 / 孤儿成绩 / 同人同考同科重复
作业：测试残留作业 / 缺标题或截止日 / 截止早于布置 / 重复布置(同科+同标题+同截止)
收交：状态非法值(只许 已交/补交/免交) / 孤儿收交(作业已删) / 孤儿收交(学生已删)
     / 同作业同人多条 / 收交人数超全班
档案：标签非数组 / 标签枚举外的值 / 出生日期格式错 / 家长信息无有效手机号 / 手机号重复挂多人
座位：一人多座 / 一座多人 / 孤儿座位(学生已删) / 坐标非法(非负整数) / 座位数超全班
值日：weekday 非法 / 岗位枚举外 / 孤儿值日(学生已删) / 同天同岗重复排人 / 同一天排多个岗位(仅提示)
课表：weekday 非法 / period 非法 / 科目枚举外 / 同格重复排课 / 条数超 40 格
```

> 课表那 5 条**反向注入验证过**：插 4 条脏数据（weekday=9 / period='3' 字符串 /
> 科目「午休」/ 同格重复），审计报 7 处，`--fix` 删 4 条后复检归零（40 条干净）。
> 课表**没有孤儿概念**（schedule 不含 studentId），所以不进 removeCascade。

> 座位那 5 条**反向注入验证过**：一次性造 6 条脏数据（一人 2 座 / 一座 2 人 / 孤儿 /
> row 是字符串 + col 为 -1），审计全部抓到；`--fix` 清理后重跑归零。

> ⚠️ audit-data 的取数**必须 count 后并发拉分页**。串行分页到第 7 个集合就会撞
> automator 的 evaluate 超时（实测：串行 11.5s 直接 timeout，并发后 3.8s 通过）。

## 视觉验证（tools/shot.js + tools/shot-verify.py）

「界面看不到/一片空白」类问题**不许靠猜**，跑这两条出数值证据：

```bash
node tools/shot.js            # 逐页截图到 tools/shots/，同时收集 console.error 与 exception
python3 tools/shot-verify.py  # 像素级判定：内容墨迹% / 导航栏品牌红% / tabBar%
```

判定阈值（656×1418 模拟器截图，实测基线）：

| 指标 | 普通页正常区间 | 弹层页正常区间 | 判失败条件 |
|---|---|---|---|
| 内容区非背景像素占比 | 9%~15% | 52%~80% | <1.5% = 空白页 |
| 顶部 15% 品牌红占比 | 48%~51% | 47%~48% | <8% = 导航栏没渲染 |
| tabBar 区非白像素占比 | 7%~14% | 26% | <1% = tabBar 缺失（仅 tab 页判） |
| 遮罩灰(110~175)占比 | 0.6%~1.7% | **81%~84%** | 弹层 <15% = 弹层没打开 |
| 下半屏纯白占比 | 60%~83% | 41%~74% | 弹层 <25% = 表单卡没渲染 |

**二级视图必须单独截**（`SUBVIEWS` 配置）：作业页的收交面板、各页的表单弹层都是
独立的 wxml/wxss 分支，只截首屏等于没验证。每个 subview 要配 `verify`
（返回 true 才截图）+ 截完再 verify 一次，否则会拍到「加载中」骨架屏。

**两张截图 MD5 相同 = 至少一张没拍到目标状态**，shot.js 已自动报错。
（实测事故：3 张 subview 图 MD5 完全一致，全是同一张加载中的图，我差点当成功交付。）

**采样陷阱（已踩）**：模拟器截图顶部有黑色状态栏、左侧有白边，
判断导航栏颜色**不能只采一行像素**（我第一版采 y=nav_h*0.6 单行，7 个页面全部误判「导航栏非品牌色」）。
必须按区域统计占比。

## 加新页面必查

```
[ ] WXSS 选择器全 ASCII（中文枚举值在 js 里映射）
[ ] 列表读取用 db.list() 且传 orderBy（不要依赖 limit 的顺序）
[ ] 所有写入入口有 this._busy 同步防连点
[ ] 删主记录用 db.removeCascade() 带上所有引用它的集合
[ ] 唯一性字段（学号等）保存前查重
[ ] 页面顶部班级名用 {{classTitle}} + classinfo.get()
[ ] tabBar 页在 e2e.js 的 goto() isTab 列表里注册
[ ] 显示他表关联数据时，查不到要显示「已删除X」而非裸 _id
[ ] 新增集合要加进 cloudfunctions/initdb 的 COLLECTIONS
[ ] 新增集合若含 studentId，回头把它补进 roster.js 的 removeCascade refs（漏了就留孤儿，已踩）
[ ] seed 造的假数据要能被真功能用（手机号别写掩码，已踩）
[ ] 异步补的数据（stats 等）切换目标时同步清空 + 用 this._xxxFor 丢弃过期结果
[ ] 在 e2e.js 加一段断言，跑通再提交
[ ] 在 audit-data.js 加对应的数据卫生规则（唯一性/取值范围/引用完整）
[ ] 有正负号语义的字段（如积分）统一在保存时归一化，不要让用户填符号
[ ] 汇总统计按全量算，不能被前端筛选污染
[ ] 「无记录 = 默认态」的字段（未交/未录分）不要存记录，改回默认态要删除该条
[ ] 页面内有二级视图/弹层的，加进 tools/shot.js 的 SUBVIEWS（配 enter + verify）
[ ] subview 的 enter **不许依赖库里的现成状态**（e2e 会改数据）→ 自己造前置条件
[ ] e2e 断言**不许依赖 seed 的初始态**（上一轮跑完会变）→ 段首自己造前置条件
[ ] e2e 里写入过引用 studentId 的数据，清理段要全量扫孤儿（不是逐 id 删）
[ ] 有网格/多列布局的页面，墨迹%抓不到布局塌陷 → 单独写几何量测脚本
[ ] 概览新入口给专属类名 `.link-xxx-quick`，别让 e2e 靠下标点
[ ] 同一页面出现多个同类入口（两个「管理 ›」）时加区分类名，否则 e2e 会点错
[ ] tabBar 已满 5 个（微信上限），新页面用 navigateTo 从相关卡片进入
```

## 环境事实（实测，非文档推断）

- AppID 见 `project.config.json`，云环境见根目录 `env.local.js`（本地私有，不入库）
- 云函数 runtime Nodejs16.13，timeout **固定 3s**
- 小程序端 `get()` 单次 ≤20 条；云函数端 ≤100 条
- 首次部署云函数必失败一次（Creating 状态），`deploy-fn.sh` 自动重试
- `mp.close()` 会关掉你的 IDE 项目窗口 —— **所有脚本一律用 `mp.disconnect()`**，
  这是「跑完检测后用户看不到界面」的真正原因（2026-08-27 定位）
- 端口统一由 `tools/mp.js` 的 `connectOrLaunch(9491)` 管理：**先扫已开的端口 connect 复用，
  没有再 launch**。改成 disconnect 后端口会一直开着，各脚本各占一个端口的老做法必然冲突
  （报 `Port 9491 is in use`）。复用后 audit-data 从 18s 降到 5s
- 报 `Failed to launch ... http port is open` 时 `pkill -f wechatwebdevtools` 再跑
- **E2E 断言不能假设数据库是空的**：seed 会在「第一次月考」灌 60 条成绩，
  成绩页的统计/排名断言必须先切到独立考试名（E2EEXAM）再算，否则误报失败
- tabBar 最多 5 项，已占满：概览/名单/考勤/通知/设置
- **`miniprogramRoot: "./"` 时 tools/ docs/ 会被打进小程序包**。实测：tools/shots 的
  1.4MB 截图让包体 114KB → 1.6MB。必须在 `project.config.json` 的
  `packOptions.ignore` 里排除。已加进 check.js 第 8 项（反向注入故障验证过能抓）
- **`mp.screenshot()` 在二级视图/弹层打开时第一次调用 100% 报 `timeout waiting for
  automator response`**（2026-08-27 用 stage 埋点实测定位：6 个 subview 里 5 个卡在
  `screenshot`、1 个卡在紧邻的 `waitFor`，不是随机抖动，也不是「evaluate 的问题」——
  之前把根因记成 evaluate 是错的，已作废）。
  **重试 screenshot 无效**：实测加 3 次重试后 4 个 subview 反而全丢，连接进坏状态只有
  `reLaunch` 回本页能恢复。所以 shot.js 的处理是：不重试 screenshot，直接让外层
  attempt 循环 reLaunch 重来（第 2 轮 100% 成功，0 错误）。
  `waitFor` 的 `fatalTol=2` 只容忍紧邻 enter 的那次抖动，**不能无限吞**（吞掉会拿过期截图当成功）
- **subview 的 `enter` 不能依赖上一个 subview 的遗留状态**（2026-08-27 实测事故）：
  `profile-form` 的 enter 只调 `onEditProfile()`，重试时 reLaunch 回的是列表页、
  `current=null`，函数第一行 `if (!s) return` 直接返回，`verify` 永远 false，两轮全废。
  每个 enter 必须自己把前置状态补齐（先 `onOpenDetail` 再 `onEditProfile`）
- **reLaunch 后必须确认真的回到目标页再 enter**：未落地就 enter 会打到上一个页面，
  报 `pg.onAdd is not a function`（实测）。shot.js 已加二次确认
- **e2e 长跑失败但单独跑全过 → 是状态累积/污染，不是功能 bug**（2026-08-27）：
  watch/排序/级联删除三项在长跑里红、隔离脚本 3/3 全绿。修法不是改功能，而是
  ① 探针 watcher 必须 close（泄漏会拖垮 realtime 连接）
  ② 每次写测试数据后 `count()` 复核，清理后再 `count()` 复核为 0
  ③ 失败分支要打印云端读写自检 + 页面 toast/console.error，否则红字不可归因

## 对抗审查系统（2026-08-27 新增，完整说明见 docs/ADVERSARIAL.md）

**为什么需要**：e2e 断言和业务代码出自同一心智模型，会一起漏同一个 bug。
duty 实测：注入 `i % (SLOTS - 5)`（25 个岗位空 5 格）后 **14 条断言全绿放行** ——
断言查「每人排几次」（正常），bug 在「岗位侧」。出题人 = 答题人，盲点必然重合。

**明确否决**：再开一个 LLM Agent 互审。同模型 + 同上下文 = 盲点高度相关，
只会产出两份措辞不同的同一个错误结论。隔离不来自「换 Agent」，来自**换观测基准**。

```bash
node tools/mutate.js --all         # 蓝队：11 个变异体，注入后 e2e 必须变红（~18min）
node tools/mutate.js --tag schedule # 只跑课表那 4 个（~7min）
node tools/redteam.js 40           # 红队：duty + schedule 各 4 轮换种子（~5min）
TARGET=schedule node tools/redteam.js 40   # 只攻课表
node tools/e2e-slice.js 19         # 只跑 [19] 课表段（~40s，全套要 8min）
```
两者都已接入 `ship.sh`（第 3、4 步），`SKIP_ADV=1` 可跳过。

### 本轮对抗抓到并修掉的真问题
1. 轮排断言只查「每人次数」，岗位空缺放行 → 加 `emptySlots === 0`
2. 座位 diff 按 studentId 幂等，删 `_busy` guard 后云端条数不变 → 改成**数真实写调用次数**（拦 `utils/db.js`）
3. `[17]` 段 2 处长 evaluate 让整段 FATAL，「抓到了」实为崩溃假象 → 拆成触发/等待/读取
4. 红队起始态总是满表，`assign` 分支走不到 → 起始态按种子随机化（empty/half/full/asis）
5. 单种子覆盖不足（SEED=7 抓到、1337 漏）→ 默认 4 轮换种子
6. 抽段跑是空降，页面栈残留导致 `page is not on top of page stack` → 段前强制重置栈
7. 变异体（cascade-off）留脏数据污染后续断言 → mutate.js 结尾自动 `audit-data --fix`
8. `QUICK_LINKS` 手抄清单漏加 duty → 改成从 `dashboard.wxml` 解析（单一来源）
9. `[14]` 段末清理在 FATAL 时跳过 → 段首先清 E2EEXAM（幂等前置）

### 课表轮（2026-08-27）新增覆盖
| 蓝队变异体 | 注入的 bug | 判定 |
|---|---|---|
| `sched-save-nodiff` | diff 不认云端已有记录，全当新增 | KILLED（7 条红：云端 78/页面 40、38 格两门课） |
| `sched-tpl-holes` | 模板漏掉第 8 节（40 格空 5 格） | KILLED（5 条红） |
| `sched-no-busy` | 删掉保存防连点 guard | KILLED（连点写 3 次） |
| `sched-conflict-off` | `MAX_MAIN_PER_DAY` 抬到 99 | KILLED（页面 3 处 vs 复算 4 处） |
| `sched-dirtyflag-stuck` | `render` 不同步 `dirtyFlag` | KILLED（保存后 flag 仍 true） |

红队 schedule 守恒律 S1~S9（与 duty 的 R1~R7 **不复用同一套 snapshot** ——
duty 是「人 × 岗位」多对多，schedule 是「格子 → 一门课」一对一，
硬抽公共基类会把两套语义混在一起，反而造新盲点）：
```
S1 overview.filled == 周表非空格子求和
S2 filled + empty == slots == 40
S3 每日 w.filled == 该日非空格子数（第二处独立计算）
S4 结构恒为 5 天 × 8 节，动作不许抛异常
S5 科目 class 名恒为纯小写 ASCII；格子/选中态不许出现枚举外科目
S6 conflictList.length == overview.conflicts，且与页面数据复算一致
S7 保存回读：云端条数 == 页面 filled，无同格重复，无非法字段
S8 dirty 清后再保存必须提示「没有改动」
S9 收尾恢复到 40 节（不许给用户留空表/残表）
```

### 判错记录（我自己的错，防再犯）
**`duty-no-busy` 第一版是「`this._busy` → `this.data.saving`」，SURVIVED。
我判成「门禁有洞」去改 e2e，改完仍 SURVIVED。第二次才实测出：那是等价变异体。**
- `setData({saving:true})` 对 `this.data` **同步生效**（探针 `rightAfter:true`）
- 全项目 15 处 guard 到置位之间**全是同步代码**（无 await）→ 两标志行为一致
- 探针：删 guard 换 `data.saving` 后 `onSave` 调 4 次、云端只多 1 条 → 确实无 bug

**规则：`SURVIVED` 有两种解释 —— ① 门禁有洞 ② 变异体不是真 bug。
必须先实测分清，不许直接改断言。**（跳过这一步浪费一轮 4min 验证）

## 数据卫生：班委规则（2026-09-13 更新为「一岗最多两人」）

| 规则 | 计入 bad？ |
|---|---|
| 班委岗位枚举外 | ✅ |
| 同岗超过 2 人 | ✅ |
| 同 post+studentId 重复对 | ✅ |
| 孤儿班委（学生已删） | ✅ |
| 班委条数超 岗位数×2（>24） | ✅ |
| 一人跨岗兼职（>2 个不同岗位） | ❌ 只提示（现实会发生） |

反向注入验证：插 5 条脏数据 → 报 4 处 → `--fix` 删 3 条 → 复检干净。

## check.js 第 11 项 `[BUSY]`（2026-08-27 新增）
「guard 与置位之间插 await」依赖时序、e2e 复现不稳定，所以钉成静态门禁：
1. guard 到 `this._busy = true` 之间不许有 `await`
2. 有 guard 但找不到置位语句 → guard 永久放行
3. 有云写入的方法必须有 `if (this._busy) return` guard

三种坏法都反向注入验证过能抓。**第 3 条第一版用 `indexOf('this._busy')` 判定，
被 `finally` 里的 `this._busy = false` 骗过 → 必须匹配 guard 形态，不能只查标识符出现。**

## 加新页面时对抗系统要跟着做
```
[ ] mutate.js 加 2~3 个变异体（核心算法不变量 / diff 去重 / 级联删除）
[ ] 确认锚点恰好匹配 1 处，verdict 是 KILLED 而非 KILLED_OFFTARGET
[ ] redteam.js 的 ACTIONS 加该页操作（含非法参数版本）
[ ] 为该页定义守恒律（只用页面上看得见的数字）
[ ] 起始态随机化覆盖 空/半满/满 三态
[ ] 红队收尾把数据恢复成有内容的状态
```

## 成绩全景从成绩页搬到档案页（2026-09-19，v0.9.6）
- **起因（用户反馈）**：全班 48 人 × 10 科大矩阵放在成绩页一屏根本看不清，「在名单里体现肯定不行」。
- **改动**：成绩页撤掉 matrix 卡片/data/wxss（波动预警保留）；档案页单人详情新增「成绩全景」卡
  （行=最近 6 次考试新→旧，列=规范科目序，格=每百得分 5 档配色，缺考 —，长按看原始分）。
- **纯函数**：`buildExamMatrix`（全班）删除 → `buildStudentPanorama(allScores, sid, maxExams)`，
  复用 classMatrix/orderedExamsFor/subjectOrderCompare，口径与综合分析一致（去重留最新、得分率）。
- **验证**：单测 44/0（新增 9 条全景断言）；verify-v095.js 改判「成绩页无 matrix + 档案全景结构/均分/分档/缺考格」；
  e2e 14 段 23/0、16 段 19/0；蓝队 grades 组 4/4 KILLED；锚点 61/61。
- **教训**：删功能时 grep 三件套（页面 js/wxml/wxss + 单测 + verify/e2e 脚本 + 蓝队锚点），一处都不能漏。
