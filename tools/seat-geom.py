#!/usr/bin/env python3
"""座位网格几何验证：看不到图就量像素。
判据不用「颜色占比过半」（导航条/白卡也能过），而用「一条横线上能切出 N 个等宽座位块」。
实测色（模拟器截图有色彩变换，不能直接用 wxss 的十六进制）：
  已占座位卡 (250,248,242) / 空位 (247,244,236) / 边框 (230,223,208)±12
"""
from PIL import Image
import sys, os

f = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'shots', 'seats.png')
if not os.path.exists(f):
    print(f'没有 {f}，先跑 node tools/shot.js'); sys.exit(1)
im = Image.open(f).convert('RGB'); px = im.load(); w, h = im.size

# 实测色（模拟器截图有色彩变换，不能直接用 wxss 的十六进制）：
#   已占座位 (250,248,242) / 空位 (246,244,237) / 卡片白底 = 缝隙 (255,255,255) / 页面底 (246,243,235)
# ⚠️ 空位 (246,244,237) 和页面底 (246,243,235) 只差 2，用「颜色白名单」判座位必踩坑
#    （实测事故：空位被当成非座位，两个相邻空位合成一段，6 列被数成 5 列，误报「网格错位」）。
#    改成反向判定：座位块之间的缝隙是**纯白卡片底** #FFF —— 只有它能分割列。
MINW = 40   # 座位块最小宽度
def dark_count(y):
    return sum(1 for x in range(w) if sum(px[x, y][:3])/3 < 180)

def dark_xs(y):
    return [x for x in range(w) if sum(px[x, y][:3])/3 < 180]

def cols_from_xs(xs, gap=20, min_width=10):
    # gap=20：座位卡内文字间隙 <20，卡间白缝 >40（15 会让 3 字名拆成两段，把 6 列误数为 7 列）
    # min_width=10：过滤屏幕边缘/抗锯齿产生的 1~2px 假列
    if not xs: return []
    groups = [[xs[0]]]
    for x in xs[1:]:
        if x - groups[-1][-1] > gap:
            groups.append([x])
        else:
            groups[-1].append(x)
    return [(g[0], g[-1]) for g in groups if g[-1] - g[0] >= min_width]

# 座位行的特征：一行里有两个文字高峰（姓名行 dark>100，学号行 dark>30）
# 姓名行密集区就是座位行
TEXT_PEAK = 100
peaks = []
for y in range(h):
    if dark_count(y) >= TEXT_PEAK:
        peaks.append(y)
if not peaks:
    # 降低阈值试试
    TEXT_PEAK = 80
    peaks = [y for y in range(h) if dark_count(y) >= TEXT_PEAK]
if not peaks:
    print('❌ 整页找不到文字高峰行（dark>80）→ 页面没渲染'); sys.exit(1)

# 把高峰行聚成 band
bands_raw = []
start = peaks[0]; prev = peaks[0]
for y in peaks[1:]:
    if y - prev > 3:
        bands_raw.append((start, prev))
        start = y
    prev = y
bands_raw.append((start, prev))

# 每个 band 的列数
band_cols = []
for a, b in bands_raw:
    mid = (a + b) // 2
    xs = dark_xs(mid)
    cols = cols_from_xs(xs)
    band_cols.append((a, b, cols))

# 过滤：座位行列数 >=4，且列数一致的最大连续组
from collections import Counter
valid = [(a, b, cols) for a, b, cols in band_cols if len(cols) >= 4]
if not valid:
    print(f'❌ 没有 >=4 列的文字高峰行（bands={[(a,b,len(c)) for a,b,c in band_cols]}）→ 网格塌了'); sys.exit(1)

cc_groups = {}
for sb in valid:
    cc = len(sb[2])
    if cc not in cc_groups: cc_groups[cc] = []
    cc_groups[cc].append(sb)

best_group = None
for cc, group in cc_groups.items():
    group.sort(key=lambda x: x[0])
    # 找最长连续段
    runs = [[group[0]]]
    for sb in group[1:]:
        if sb[0] - runs[-1][-1][1] < 100:
            runs[-1].append(sb)
        else:
            runs.append([sb])
    for run in runs:
        if len(run) >= 4 and (best_group is None or len(run) > len(best_group)):
            best_group = run

if not best_group or len(best_group) < 4:
    print(f'❌ 找不到 >=4 行且列数一致的座位行组（候选: {[(cc, len(g)) for cc, g in cc_groups.items()]}）→ 网格塌了'); sys.exit(1)

mode_cols = len(best_group[0][2])
bands = [(sb[0], sb[1]) for sb in best_group]
band_col_widths = {}
for sb in best_group:
    ws = [b - a for a, b in sb[2]]
    band_col_widths[(sb[0], sb[1])] = ws

print(f'座位行 {len(bands)} 行，y 区间 {bands[0][0]}~{bands[-1][1]}')
fails = []
colcounts = [mode_cols] * len(bands)
heights = [b - a for a, b in bands]
print(f'每行列数 {colcounts}，行高 {heights}')

# ⚠️ 不再用 dark_x 的 x 跨度验「列宽均匀」：那是文字的宽度（2 字名 vs 3 字名天生不同），
#    拿它当座位卡宽必假红（实测 2 字名 51px vs 3 字名 73px，差 30%+）。
#    网格塌不塌由「连续座位行 >=4 且列数一致 / 位子总数 = 全班 ± 一行」两条守恒律判定，
#    这两条就能抓住 flex→block 塌列，不必量文字宽。
if len(bands) < 4:
    fails.append(f'只有 {len(bands)} 行，应 ≥4')
# band 是「深色文字高峰行」聚成的墨带，不是座位卡本身：末行只有单行文字越过
# 阈值时会被切成 a==b 的 0 高度带（实测 5 行布局 heights=[16,16,16,16,0]），
# 这是阈值切片伪影，不代表座位塌了。行高一致性只对有效（h>0）墨带判；
# 防挤压由下面独立的「行间距 ≥2px」守恒律负责。
heights_valid = [hh for hh in heights if hh > 0]
if heights_valid and max(heights_valid) - min(heights_valid) > 6:
    fails.append(f'行高不一致 {heights_valid}（差 >6px）')
gaps = [bands[i+1][0] - bands[i][1] for i in range(len(bands)-1)]
print(f'行间距 {gaps}')
if gaps and min(gaps) < 2:
    fails.append(f'行间距 {min(gaps)}px < 2，座位挤在一起')

total = mode_cols * len(bands)
print(f'位子总数 {mode_cols}×{len(bands)} = {total}')
students_n = 30
if total < students_n:
    fails.append(f'只有 {total} 个位子 < 全班 {students_n} 人（renderGrid 的 needRows 算错）')
if total > students_n + mode_cols:
    fails.append(f'有 {total} 个位子 > 全班 {students_n} + 一行 {mode_cols}（needRows 算多了）')

if fails:
    print(); [print('❌ ' + x) for x in fails]; sys.exit(1)
print('✅ 座位网格几何正常')
