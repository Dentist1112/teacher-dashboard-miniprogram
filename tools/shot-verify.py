#!/usr/bin/env python3
"""截图数值验证：我看不到图，所以用像素统计判断页面是否真的渲染了内容。
判定规则（实测截图 492x1086，比例判定不写死像素）：
  - 顶部 0~0.090h = 导航栏区（奶油底 实测(252,246,241) + 深色标题，2026-09-14 随奶油主题重校）
  - 底部 1418-110~1418 = tabBar 区（白底 + 文字）
  - 中部 = 内容区：非背景像素占比 <1.5% 视为空白页
"""
import sys, os, glob
from PIL import Image
from collections import Counter

BG = (240, 250, 246)  # #F0FAF6 薄荷雾白页面底（2026-09-05 薄荷×蜜桃 v2）
# 【实测校准 2026-09-05】NAV 不能照抄 CSS 的 #0E8F74=(14,143,116)：
#   automator 截图经过 P3->sRGB 色彩管理，导航条实测众数是 (65,141,117)，
#   与 CSS 值相差 51 个 R 通道，用 tol=12 匹配必然 0%（这就是上一轮 24 页全红的真因）。
#   → 屏幕取色类阈值一律用真实截图统计，不许用样式表里的十六进制推。
NAV = (252, 246, 241)  # 实测奶油导航条众数（2026-09-14 30 页 69.5%~81.7%）
# 导航从"白底黑字"改为"薄荷底白字"后，判定逻辑同步翻转：
#  ① 导航采样区必须出现足够多的薄荷底像素（空页/白导航/红导航都会被 mint_pct≈0 抓住）
#  ② 必须出现白色标题像素（薄荷纯色条也能让 ① 通过，所以白字是第二道闸）
# 采样窗口沿用实测结论：小程序导航栏标题在 y≈0.068h~0.098h（656x1418 即 96~138px）。
# 阈值暂按保守区间（mint>40 / 白字>0.6），待 automator 恢复后跑 shot.js 用真实读数校准。
NAV_TEXT_MAX = 90     # RGB 通道均值 <此 视为深色标题字（黑标题均值≈0，奶油底均值≈246）
# 【实测事故 2026-09-05】上一版写了 NAV_TEXT_MIN 却在下面用 NAV_TEXT_MAX，且比较方向是 `<`：
#   ① NameError 会让整个 6/8 门禁在第一张图就崩 —— 但 ship.sh 之前把它当「有页面渲染异常」，
#      真实原因（脚本自己坏了）被掩盖；
#   ② 700 是「三通道之和」的量级，而代码算的是均值(0~255)，方向也反了。
#   → 阈值必须和被判定的量同一量级，且改导航配色时要同步翻转比较方向。

def close(a, b, tol=12):
    return all(abs(x - y) <= tol for x, y in zip(a[:3], b[:3]))

def analyze(path):
    im = Image.open(path).convert('RGB')
    w, h = im.size
    px = im.load()
    # 【实测事故 2026-09-05】原为 0.065h（1086px 下 =70px），但实测导航条底边在 y=92px(0.0847h)，
    # 于是 70~92px 这 22px 全宽薄荷条被算进「内容墨迹」，一张完全空白的页也能凑出 ~2.8% > 1.5% 阈值
    # → 空白页检测形同虚设（注入实测：内容区全部涂成背景色仍 SURVIVED）。裁到导航条以下再统计。
    nav_h = int(h * 0.090)
    tab_h = int(h * 0.078)
    content = (0, nav_h, w, h - tab_h)
    # 内容区非背景像素比
    step = 2
    tot = ink = 0
    rows_with_ink = 0
    for y in range(content[1], content[3], step):
        row_ink = 0
        for x in range(0, w, step):
            tot += 1
            if not close(px[x, y], BG) and not close(px[x, y], (255, 255, 255)):
                ink += 1
                row_ink += 1
        if row_ink > w / step * 0.02:
            rows_with_ink += 1
    ink_pct = ink / tot * 100
    # 导航栏已改白底黑字（亮调主题），不能再用「红色占比」判定。
    # 现在量两个数：① 白底占比（导航区应基本是白）② 深色文字像素占比（标题真的画了）。
    # 只查白底不够：一张全白的空页也能蒙混过去。
    # 采样窗口必须用实测值定。【实测事故】第一版写 y=0.028h~0.075h，
    # 结果 23 页的「标题字%」全等于 15.33 —— 23 个不同标题不可能一致，
    # 那其实量的是模拟器自己的深色工具条（y<56），等于 0==0 型断言。
    # 逆向排查后的真实位置：小程序导航栏标题在 y≈0.068h~0.098h（656x1418 下即 96~138px），
    # 改后各页读数 2.66%~4.25% 不再恒等，才是真的在量标题。
    nav_white = nav_text = nav_tot = 0
    for y in range(int(h * 0.045), int(h * 0.083), 2):
        for x in range(int(w * 0.10), int(w * 0.90), 2):
            nav_tot += 1
            pxl = px[x, y]
            if close(pxl, NAV, 12):
                nav_white += 1
            if sum(pxl[:3]) / 3 < NAV_TEXT_MAX:
                nav_text += 1
    nav_pct = nav_white / max(nav_tot, 1) * 100
    nav_text_pct = nav_text / max(nav_tot, 1) * 100
    # 【实测校准 2026-09-05，24 张真实截图 492x1086】
    #   采样窗 y=0.045h~0.083h（旧窗 0.068~0.098 已越过导航条落进内容区，见事故注释）
    #   奶油底占比 69.5%~81.7% → 阀 60（空页/白导航会掉到 ~0）
    #   深色标题字 1.69%~2.76% → 阀 1.3（纯色导航条无标题时接近 0）
    nav_ok = nav_pct > 60.0 and nav_text_pct > 1.3
    # tabBar 区是否有文字（非纯白像素）
    tab_ink = 0; tab_tot = 0
    for y in range(h - tab_h, h, 2):
        for x in range(0, w, 2):
            tab_tot += 1
            if not close(px[x, y], (255, 255, 255), 20):
                tab_ink += 1
    tab_pct = tab_ink / tab_tot * 100
    # 弹层专用：半透明黑遮罩(rgba(0,0,0,0.45)) 压在浅底上 ≈ (135~150) 灰
    mask = mask_tot = 0
    for y in range(nav_h, int(h * 0.45), 3):
        for x in range(0, w, 3):
            r0, g0, b0 = px[x, y]
            mask_tot += 1
            if abs(r0 - g0) < 8 and abs(g0 - b0) < 8 and 110 < r0 < 175:
                mask += 1
    mask_pct = mask / mask_tot * 100
    # 底部 sheet：下半屏的白色占比（表单卡片是白底）
    sheet = sheet_tot = 0
    for y in range(int(h * 0.55), h - tab_h, 3):
        for x in range(0, w, 3):
            sheet_tot += 1
            if close(px[x, y], (255, 255, 255), 10):
                sheet += 1
    sheet_pct = sheet / sheet_tot * 100
    return dict(w=w, h=h, ink_pct=ink_pct, rows=rows_with_ink, nav_pct=nav_pct,
                total_rows=(content[3] - content[1]) // step, nav_text_pct=nav_text_pct,
                nav_ok=nav_ok, tab_pct=tab_pct, mask_pct=mask_pct, sheet_pct=sheet_pct)

TABS = {'dashboard', 'roster', 'attendance', 'announcement', 'settings'}
# 弹层类二级视图：必须能看到遮罩 + 底部白色表单卡，否则说明弹层没真正打开
SHEETS = {'rewards-form', 'grades-examform', 'homework-form', 'profile-form'}
# 视图切换类（非弹层）：还是按普通页面判，但要求和首屏不同（shot.js 已做 MD5 撞检测）
PANELS = {'homework-check', 'profile-detail', 'seats-picked', 'duty-day', 'schedule-day', 'committee-pick'}
fails = []
files = sorted(glob.glob(os.path.join(os.path.dirname(__file__), 'shots', '*.png')))
if not files:
    print('没有截图，先跑 node tools/shot.js'); sys.exit(1)
print(f'{"页面":<18}{"内容墨迹%":>10}{"有内容行":>10}{"导航底%":>8}{"标题字%":>8}{"tabBar%":>8}{"遮罩%":>7}{"表单卡%":>8}  判定')
for f in files:
    name = os.path.basename(f)[:-4]
    r = analyze(f)
    verdict = []
    if r['ink_pct'] < 1.5:
        verdict.append('空白页')
    if not r['nav_ok']:
        verdict.append(f'导航栏异常(奶油底{r["nav_pct"]:.0f}%应>60 / 深色标题{r["nav_text_pct"]:.2f}%应>1.3)')
    if name in TABS and r['tab_pct'] < 1.0:
        verdict.append('tabBar缺失')
    if name in SHEETS:
        # 弹层没打开时，截到的就是普通页面：遮罩几乎为 0
        if r['mask_pct'] < 15:
            verdict.append(f'弹层遮罩缺失({r["mask_pct"]:.0f}%<15%)')
        if r['sheet_pct'] < 25:
            verdict.append(f'底部表单卡缺失({r["sheet_pct"]:.0f}%<25%)')
    if name in PANELS and r['mask_pct'] > 15:
        verdict.append('该视图不该有遮罩，可能截到了弹层')
    v = 'OK' if not verdict else '❌ ' + '/'.join(verdict)
    if verdict:
        fails.append(f'{name}: {"/".join(verdict)}')
    print(f'{name:<18}{r["ink_pct"]:>10.2f}{r["rows"]:>6}/{r["total_rows"]:<4}{r["nav_pct"]:>10.1f}{r["nav_text_pct"]:>10.2f}{r["tab_pct"]:>8.2f}{r["mask_pct"]:>7.1f}{r["sheet_pct"]:>8.1f}  {v}')
print()
if fails:
    print(f'❌ {len(fails)} 页有问题：'); [print('  - ' + x) for x in fails]; sys.exit(1)
print('✅ 全部页面渲染正常（像素级验证）')
