#!/bin/zsh
# 部署云函数（首次创建会进 Creating 状态，自动重试）
CLI=/Applications/wechatwebdevtools.app/Contents/MacOS/cli
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
# 从 env.local.js 读云环境（已 gitignore）；读不到则报错退出
ENV=$(node -e "try{console.log(require('$PROJ/env.local.js').envId||'')}catch(e){}" 2>/dev/null)
[ -z "$ENV" ] && echo "缺少 env.local.js（云环境 ID），见 README 快速开始第 3 步" && exit 1
for name in "$@"; do
  for i in 1 2 3 4 5; do
    out=$("$CLI" cloud functions deploy --env "$ENV" --names "$name" -r --project "$PROJ" 2>&1)
    if echo "$out" | grep -q "│ true"; then echo "✅ $name 部署成功"; break; fi
    if [ $i = 5 ]; then echo "❌ $name 部署失败"; echo "$out" | tail -5; exit 1; fi
    echo "… $name 第 $i 次未成功，20s 后重试"; sleep 20
  done
done
