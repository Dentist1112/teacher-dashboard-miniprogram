#!/bin/zsh
# 一键把项目窗口开到前台（跑完自动化后如果看不到界面就执行这个）
cd "$(dirname "$0")/.."
/Applications/wechatwebdevtools.app/Contents/MacOS/cli open --project "$PWD" 2>&1 | tail -2
sleep 3
osascript -e 'tell application "System Events" to set frontmost of (first process whose name is "Electron") to true' 2>/dev/null
echo "✅ 项目窗口已打开。看不到内容就点 IDE 左上「编译」，或勾掉「详情→本地设置→不校验合法域名」。"
