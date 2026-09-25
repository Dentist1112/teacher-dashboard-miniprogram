#!/bin/zsh
# 「我在开发者工具里看不到界面」专用：把 IDE 拉到前台 + 把小程序重置到首页 + 用像素证明它真的渲染了
# 用法：./tools/see.sh            → 回首页
#      ./tools/see.sh duty       → 直接跳值日表（页面名即 pages/<名>/<名>）
cd "$(dirname "$0")/.."
PAGE="${1:-dashboard}"

echo "1/3 把开发者工具窗口拉到最前 ..."
osascript -e 'tell application "System Events" to set frontmost of (first process whose name is "Electron" and (count of windows) > 0) to true' 2>/dev/null
# IDE 可能有多个 Electron 进程，逐个尝试直到能截到品牌红
for pid in $(pgrep -f 'wechatwebdevtools.app/Contents/MacOS/Electron'); do
  osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $pid) to true" 2>/dev/null
done
sleep 2

echo "2/3 把小程序重置到 pages/$PAGE/$PAGE ..."
node - "$PAGE" <<'JS'
const { connectOrLaunch, sleep, evalRetry } = require('./tools/mp.js');
const page = process.argv[2];
(async () => {
  const { mp } = await connectOrLaunch(9491);
  try {
    const route = `/pages/${page}/${page}`;
    try { await mp.reLaunch(route); } catch (e) { console.log('  reLaunch 失败，改用 switchTab'); await mp.switchTab(route).catch(() => 0); }
    await sleep(2500);
    const p = await mp.currentPage();
    console.log('  当前页面:', p && p.path);
    await mp.screenshot({ path: '/tmp/see-sim.png' });
    console.log('  已截图 /tmp/see-sim.png');
  } catch (e) { console.log('  ERR', e.message); }
  finally { await mp.disconnect(); }   // 绝不能 close()，会关掉你的 IDE 窗口
})();
JS

echo "3/3 像素判定（我看不到图，只能量数值）..."
python3 - <<'PY'
from PIL import Image
from collections import Counter
try:
    im = Image.open('/tmp/see-sim.png').convert('RGB')
except Exception as e:
    print('  ❌ 没截到图:', e); raise SystemExit(1)
w, h = im.size; px = im.load()
def near(a, b, t=14): return all(abs(x - y) <= t for x, y in zip(a, b))
NAV = (171, 73, 54)     # 导航栏品牌红（模拟器截图实测值，不是 wxss 里的 #B9412E）
BG  = (249, 247, 242)
nav = sum(1 for y in range(0, int(h * .15), 2) for x in range(0, w, 2) if near(px[x, y], NAV))
navtot = len(range(0, int(h * .15), 2)) * len(range(0, w, 2))
ink = tot = 0
for y in range(int(h * .07), int(h * .92), 2):
    for x in range(0, w, 2):
        tot += 1
        if not near(px[x, y], BG) and not near(px[x, y], (255, 255, 255)) and not near(px[x, y], (246, 243, 235)):
            ink += 1
navp, inkp = nav / navtot * 100, ink / tot * 100
print(f'  尺寸 {w}x{h}  导航栏红 {navp:.1f}%  内容墨迹 {inkp:.1f}%')
if navp > 6 and inkp > 1.5:
    print('  ✅ 界面正在正常渲染。看不到 = 窗口被挡住或模拟器面板被折叠，不是代码问题。')
else:
    print('  ❌ 页面像是白屏/骨架屏：点 IDE 左上「编译」，或看 Console 面板报错。')
PY
echo
echo "还是看不到？按顺序试：① 点 IDE 左上「编译」 ② 顶部菜单「界面 → 模拟器」勾上 ③ 窗口 → 缩放"
