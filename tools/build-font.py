#!/usr/bin/env python3
# 站酷快乐体子集构建：把项目里所有「固定 UI 文案」用到的汉字打进子集，
# 内嵌成 base64 ttf 写进 assets/fonts/fonts.wxss。
# 动态数据（学生姓名/通知正文）不保证覆盖，缺字自动回退圆体-苹方。
# 用法：/tmp/fontvenv/bin/python tools/build-font.py /path/to/ZCOOLKuaiLe.ttf
import sys, os, re, base64, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else '/tmp/zc.ttf'
OUT_TTF = os.path.join(ROOT, 'assets/fonts/happy-sub.ttf')
OUT_WXSS = os.path.join(ROOT, 'assets/fonts/fonts.wxss')

from fontTools.ttLib import TTFont
from fontTools import subset as ftsubset

# 1) 现有子集已覆盖字符（保证旧 UI 文案一个不丢）
old = TTFont(OUT_TTF)
chars = set(chr(c) for c in old.getBestCmap())

# 2) 扫描项目固定文案
def add_text(t):
    for ch in t:
        if '\u4e00' <= ch <= '\u9fff' or ch in '，。、：；！？·「」『』（）【】—…✨🍄🌸💖⭐📈📝🗂🪑🧹📚🎖✅📣⚙️⚠️📅📷📋➜‹›↑↓—－+0123456789':
            chars.add(ch)

def read(p):
    try: return open(p, encoding='utf-8').read()
    except Exception: return ''

scan_dirs = ['pages', 'custom-tab-bar', 'templates']
files = []
for d in scan_dirs:
    for ext in ('wxml', 'js', 'json', 'wxss'):
        files += glob.glob(os.path.join(ROOT, d, '**', '*.' + ext), recursive=True)

WXML = re.compile(r'<\s*(?:import|include|wxs)[^>]*>')
for f in files:
    txt = read(f)
    if f.endswith('.wxml'):
        # 标签间文本
        add_text(re.sub(r'<[^>]+>', '\n', txt))
        # 属性中文（placeholder/title/content 等固定串）
        for m in re.findall(r'="([^"]*[\u4e00-\u9fff][^"]*)"', txt):
            add_text(m)
    elif f.endswith('.json'):
        add_text(txt)
    elif f.endswith('.js'):
        add_text(txt)
    elif f.endswith('.wxss'):
        # content: '✕' 之类
        add_text(txt)

# ASCII 标点数字基本集
chars |= set(' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz')

text_arg = ''.join(sorted(chars))
print('并集字符数:', len(chars))

# 3) 子集化（保留名字、布局特征）
font = TTFont(SRC)
opts = ftsubset.Options()
opts.layout_features = ['*']
opts.name_IDs = ['*']
opts.notdef_outline = True
opts.recalc_bounds = True
opts.drop_tables = []
ss = ftsubset.Subsetter(options=opts)
ss.populate(text=text_arg)
ss.subset(font)
font.save(OUT_TTF)
raw = open(OUT_TTF, 'rb').read()
print('子集 ttf 大小: %.1f KB' % (len(raw)/1024))
b64 = base64.b64encode(raw).decode('ascii')

header = (
"/* 站酷快乐体（免费商用授权）· 子集化，由 tools/build-font.py 生成，勿手改\n"
" * 只含固定 UI 字符（标题/功能名/分组标签/空状态文案），正文/输入框/动态数据勿用：\n"
" * 动态文字（学生姓名、通知内容、班级名、待办内容）缺字会掉回系统字体。\n"
" * 用法：class 加 .f-happy；新增固定文案后重跑 build-font.py 补字。\n"
" * 字符集来源：现有子集并集 pages/custom-tab-bar/templates 的 wxml 文本与属性、json 标题、js 中文串。 */\n"
)
css = header + (
"@font-face {\n"
"  font-family: 'HappyZcool';\n"
"  src: url(data:font/ttf;base64,%s) format('truetype');\n"
"  font-display: swap;\n"
"}\n"
".f-happy {\n"
"  font-family: 'HappyZcool', 'Yuanti SC', 'PingFang SC', sans-serif;\n"
"}\n"
) % b64
open(OUT_WXSS, 'w', encoding='utf-8').write(css)
print('fonts.wxss 大小: %.1f KB' % (len(css.encode('utf-8'))/1024))
