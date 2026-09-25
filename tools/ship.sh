#!/bin/zsh
# 一键：静态自检+锤点+对比度 → E2E 真跑 → 对抗审查(蓝队变异+红队乱序) → 数据卫生 → 视觉巡检 → 上传
# 对抗审查为什么必须在门禁里：e2e 断言和业务代码出自同一心智模型，会一起漏同一个 bug。
# 详见 docs/ADVERSARIAL.md。跳过它用 SKIP_ADV=1 ./tools/ship.sh ...（只在赶时间时用）
set -e
cd "$(dirname "$0")/.."
CLI=/Applications/wechatwebdevtools.app/Contents/MacOS/cli
VER="${1:-1.0.0}"
DESC="${2:-例行发布}"

echo "▶ 1/8 静态自检"
node tools/check.js
# 锤点失配 = 变异体被静默跳过，门禁以为自己在守其实没守（<0.1s，必跑）
node tools/mutate.js --check-anchors || { echo "❌ 变异体锤点失配，先修 tools/mutate.js 的 from 字符串"; exit 1; }
# 配色对比度：「界面好不好看」不可验证，但「字看不清」可以量（WCAG AA）
python3 tools/contrast.py || { echo "❌ 有文字对比度不达标，老师在阳光下看不清"; exit 1; }
# AI 识别的两段纯逻辑单测（不连网、不开模拟器、<0.2s）。
# 它们守的是「AI 输出 → 写库」之间唯一的人工防线，坏了不会报错、只会静默写错数据。
node tools/test-ocr-parse.js || { echo "❌ ocrScore 识别结果清洗逻辑坏了（表头/重复/学号会漏进名单）"; exit 1; }
node tools/test-roster-import.js || { echo "❌ 导名单的学号分配/查重坏了（考勤成绩会挂错人）"; exit 1; }
# 真机 Bug ①的写库防线（2026-09-06）：满分上限 + 小数位 + db 层兜底。
# 用 Node 直调判定，不依赖开发者工具 util 模块热更新（实测变异体在模拟器里 SURVIVED）。
node tools/test-validate-range.js || { echo "❌ 成绩满分/小数规则坏了（史上真机可录 1000 分）；详询工具内断言"; exit 1; }
# 边界规则总门禁（77 项）：积分/文本长度/日期真实性/手机号/学号/出生年份
# 全部来自 2026-09-06 真机探针实测过的入库缺陷，见 docs/ADVERSARIAL.md #30-#41
node tools/test-boundary.js || { echo "❌ 边界规则坏了（史上：空格存 0 分、0x10 存 16 分、2011-13-45 入库、12 位假手机号可拨号）"; exit 1; }
node tools/test-db-guard.js || { echo "❌ db 写库前数值兜底坏了（OCR/粘贴路径能写超满分数据）"; exit 1; }
# watch 重连/分页/旧连接迟到回调（红队 seed=76405 半迁移事故后补，30 项）
node tools/test-db-paging.js || { echo "❌ 分页/watch 重连语义坏了（弱网会静默丢实时同步或重复写库）"; exit 1; }
# 成绩综合分析纯逻辑（38 项：个人分析 + 班级波动 + 全景矩阵）
node tools/test-scoreanalysis.js || { echo "❌ 成绩综合分析口径坏了"; exit 1; }
# v0.9.5 一键班级日报文本拼接（16 项）
node tools/test-dailyreport.js || { echo "❌ 班级日报口径坏了"; exit 1; }
node tools/test-analytics.js || { echo "❌ 周期分析口径坏了"; exit 1; }
node tools/test-profile.js || { echo "❌ 登录/身份资料逻辑坏了"; exit 1; }

echo "\n▶ 2/8 E2E 真跑（模拟器 + 云开发）"
node tools/e2e.js

echo "\n▶ 3/8 蓝队：变异测试（证明门禁真能抓，不是跑过就算）"
if [ "$SKIP_ADV" = "1" ]; then
  echo "  ⏭  SKIP_ADV=1，跳过（风险自负）"
else
  node tools/mutate.js --all || { echo "❌ 有变异体存活 = 门禁盲点，补断言后重试（详见 docs/ADVERSARIAL.md）"; exit 1; }
fi

echo "\n▶ 4/8 红队：黑箱乱序攻击（只查用户可观察的守恒律）"
if [ "$SKIP_ADV" = "1" ]; then
  echo "  ⏭  SKIP_ADV=1，跳过（风险自负）"
else
  node tools/redteam.js 40 || { echo "❌ 红队找到破绽，按报告里的 SEED 复现后修（node tools/redteam.js 的复现命令）"; exit 1; }
fi

echo "\n▶ 5/8 数据卫生检查"
node tools/audit-data.js || { echo "❌ 有脏数据，跑 node tools/audit-data.js --fix 清理后重试"; exit 1; }

echo "\n▶ 6/8 视觉巡检（像素级确认每页+每个弹层真的渲染了）"
# ⚠️ 必须显式收 shot.js 的退出码：`node ... | tee` 下 set -e 只看 tee 的退出码，
# 而 shot.js 是先打印「运行期错误 0 条」再 FATAL 退出的 —— 光 grep 那行会把
# automator 连接崩溃的整轮空跑当成通过（实测踩过，这是门禁洞不是业务 bug）。
set -o pipefail
node tools/shot.js 2>&1 | tee /tmp/ship-shot.log || { echo "❌ 截图巡检进程异常退出（见 /tmp/ship-shot.log 末尾 FATAL）"; exit 1; }
set +o pipefail
grep -q "运行期错误 0 条" /tmp/ship-shot.log || { echo "❌ 截图巡检有运行期错误，见上"; exit 1; }
# 截到的图张数也要卡：连接崩溃时可能一张没截却报「0 条」
SHOT_N=$(ls tools/shots/*.png 2>/dev/null | wc -l | tr -d ' ')
[ "$SHOT_N" -ge 20 ] || { echo "❌ 只截到 $SHOT_N 张图（应 >=20），巡检没真跑完"; exit 1; }
python3 tools/shot-verify.py || { echo "❌ 有页面渲染异常，看 tools/shots/*.png"; exit 1; }

echo "\n▶ 7/8 座位网格几何量测"
# 座位表是唯一的网格布局页，墨迹%那套阈值抓不到「塌成一列」（实测 flex→block 后 shot-verify 仍报 OK），
# 必须用几何量测：行数×列数、列宽均匀度、行间距
python3 tools/seat-geom.py || { echo "❌ 座位网格布局坏了，看 tools/shots/seats.png"; exit 1; }

echo "\n▶ 8/8 上传体验版 v$VER"
"$CLI" upload --project "$PWD" -v "$VER" -d "$DESC" 2>&1 | tail -12
echo "\n✅ 已上传。去「微信公众平台 → 版本管理 → 开发版本」设为体验版，或提交审核。"
echo "   IDE 项目窗口未被关闭（脚本用 disconnect 不用 close），可直接在模拟器里点。"
