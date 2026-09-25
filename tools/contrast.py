#!/usr/bin/env python3
"""配色对比度门禁（WCAG 2.1 相对亮度）。

为什么必须有这个脚本：我看不到界面，"好看"无法用眼验证，但"字看不清"可以量。
本项目立过的规矩：无法用眼验证时，写检测脚本用数值验证。

判定：
  1) 主题色 token（--primary/--accent 等）配白字 或 当白底上的文字色 → 对比度 ≥ 4.5
  2) 每条同时写了 color + background 的 wxss 规则 → 对比度 ≥ 4.5（大字号 ≥ 3.0）
  3) 只写 color 的规则 → 对比白卡(#fff) 与页面底色 两种场景都要 ≥ 4.5
  4) 每页必须有 page { --accent } （"每个界面体现专属特色"的落地方式，且能被机器检查）
用法: python3 tools/contrast.py
"""
import re, os, sys, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LARGE_PT = 30          # rpx；>=30rpx 且 bold 视为大字号，阈值放宽到 3.0

def srgb_to_lin(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

def lum(rgb):
    r, g, b = (srgb_to_lin(x) for x in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b

def ratio(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)

def parse_hex(h):
    h = h.strip().lstrip('#')
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    if len(h) != 6:
        return None
    try:
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return None

def over(fg, bg, alpha):
    """半透明前景压在 bg 上的实际颜色（rgba 色块背景要按合成后算，不能按原色算）"""
    return tuple(round(fg[i] * alpha + bg[i] * (1 - alpha)) for i in range(3))

# ---------- 读 token ----------
app = open(os.path.join(ROOT, 'app.wxss'), encoding='utf-8').read()
TOKENS = dict(re.findall(r'--([\w-]+)\s*:\s*(#[0-9A-Fa-f]{3,6})\s*;', app))
BG = parse_hex(TOKENS.get('bg', '#ffffff'))
WHITE = (255, 255, 255)

def resolve(val, page_tokens):
    """把 color 值解析成 RGB；var() 查 token；rgba 需要底色 → 交给调用方处理"""
    val = val.strip().rstrip(';').strip()
    m = re.match(r'^var\(--([\w-]+)\)$', val)
    if m:
        key = m.group(1)
        raw = page_tokens.get(key) or TOKENS.get(key)
        return parse_hex(raw) if raw else None
    if val.startswith('#'):
        return parse_hex(val)
    if val in ('white',):
        return WHITE
    if val in ('transparent', 'inherit', 'none'):
        return None
    return None

def resolve_bg(val, page_tokens, under):
    """背景值 → RGB。支持 rgba()/渐变(取最深的一站)/var()/hex"""
    val = val.strip().rstrip(';').strip()
    m = re.match(r'rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)', val)
    if m:
        rgb = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
        a = float(m.group(4)) if m.group(4) else 1.0
        return over(rgb, under, a)
    if 'gradient' in val:
        stops = re.findall(r'#[0-9A-Fa-f]{3,6}', val)
        cands = [parse_hex(x) for x in stops]
        cands = [c for c in cands if c]
        if not cands:
            return None
        # 取亮度最高和最低两端里"对文字最不利"的那端由调用方判定；这里返回两端
        return sorted(cands, key=lum)
    return resolve(val, page_tokens)

fails, warns, checked = [], [], 0

# ---------- 1) token 自身可读性 ----------
for name in ('primary', 'accent-fallback'):
    pass
for name, raw in sorted(TOKENS.items()):
    rgb = parse_hex(raw)
    if rgb is None or name in ('bg', 'card', 'card-2', 'sep', 'text', 'text2'):
        continue
    r = ratio(rgb, WHITE)
    checked += 1
    if r < 4.5:
        fails.append(f'app.wxss token --{name} ({raw}) 与白色对比度 {r:.2f} < 4.5'
                     f' —— 它既当白底上的标题色又当白字的底色，两头都会看不清')

# 正文色必须够黑
for name in ('text', 'text2'):
    if name in TOKENS:
        rgb = parse_hex(TOKENS[name])
        for base, bn in ((WHITE, '白卡'), (BG, '页面底')):
            r = ratio(rgb, base)
            checked += 1
            if r < 4.5:
                fails.append(f'app.wxss --{name} ({TOKENS[name]}) 在{bn}上对比度 {r:.2f} < 4.5')

# ---------- 2/3) 逐条 wxss 规则 ----------
RULE = re.compile(r'([^{}]+)\{([^{}]*)\}', re.S)

def clean_sel(sel):
    """去掉规则前面粘着的注释（正则切规则时会带上）"""
    return re.sub(r'/\*.*?\*/', '', sel, flags=re.S).strip()

def cooccur_classes(rel):
    """从同名 wxml 里读「同一元素上同时出现的类」。
    动因（实测假红）：`class="job-tag job-{{j.jcls}}"` —— 白字的底色由**兄弟类**给，
    wxss 里两条规则毫无关系，脚本只看 wxss 会把 12 个正常彩标全判成「白字压白底」。
    只看 wxss 推不出共现，必须读 wxml。"""
    wxml = os.path.join(ROOT, os.path.dirname(rel), os.path.basename(rel).replace('.wxss', '.wxml'))
    pairs = {}
    if not os.path.exists(wxml):
        return pairs
    src = open(wxml, encoding='utf-8').read()
    for m in re.finditer(r'class\s*=\s*"([^"]*)"', src):
        raw = m.group(1)
        # 静态类名；`job-{{x}}` 这种动态部分展开成前缀通配
        static = re.findall(r'(?<![\w-]){?([a-z][\w-]*)(?=[\s"]|$)', re.sub(r'\{\{[^}]*\}\}', ' \x00 ', raw))
        dyn = re.findall(r'([a-z][\w-]*)-\x00', re.sub(r'\{\{[^}]*\}\}', '\x00', raw))
        for a in static:
            pairs.setdefault('.' + a, set()).update('.' + b for b in static if b != a)
            pairs.setdefault('.' + a, set()).update('PREFIX:' + b + '-' for b in dyn)
    return pairs

def bg_candidates(sel, bgmap, cooc=None):
    """某条规则只写了 color 没写 background 时，它的实际底色可能来自：
      (a) 同一元素的**其他规则**：`.job-tag { color:#fff }` + `.job-tag.jobclean { background:… }`
          —— 第一版脚本不认这个，把 12 个正常的彩色标签全报成「白字压白底」（假红）。
      (b) **祖先规则**：`.pool-chip.chip-cur { background:var(--primary) }` + 后代 `.chip-no { color:… }`
    两种都要解析，否则脚本自己就是最大的噪声源。
    """
    out = []
    parts = sel.split()
    # (b) 祖先链：从最近的祖先往上找
    for anc in reversed(parts[:-1]):
        if anc in bgmap:
            out.extend(bgmap[anc])
    # (a) 同元素扩展选择器：`.job-tag` → 任何以 `.job-tag.` 开头的规则
    last = parts[-1]
    base = last.split('.')[1] if last.startswith('.') and last.count('.') >= 1 else None
    if base:
        for k, v in bgmap.items():
            if k.startswith('.' + base + '.') or k.startswith(last + '.'):
                out.extend(v)
    # (c) wxml 共现类（兄弟类给底色）
    for sib in (cooc or {}).get(last, ()):
        if sib.startswith('PREFIX:'):
            pref = '.' + sib[7:]
            for k, v in bgmap.items():
                if k.startswith(pref):
                    out.extend(v)
        elif sib in bgmap:
            out.extend(bgmap[sib])
    return out
files = [os.path.join(ROOT, 'app.wxss')] + sorted(glob.glob(os.path.join(ROOT, 'pages', '*', '*.wxss')))
page_accents = {}
for f in files:
    src = open(f, encoding='utf-8').read()
    rel = os.path.relpath(f, ROOT)
    local = dict(re.findall(r'--([\w-]+)\s*:\s*(#[0-9A-Fa-f]{3,6})\s*;', src))
    if 'pages/' in rel:
        m = re.search(r'page\s*\{[^}]*--accent\s*:\s*(#[0-9A-Fa-f]{3,6})', src, re.S)
        if m:
            page_accents[rel.split('/')[1]] = m.group(1)
    cooc = cooccur_classes(rel)
    # 先建 selector → 背景色 映射（供只写 color 的规则查继承）
    bgmap = {}
    for sel, body in RULE.findall(src):
        sel = clean_sel(sel)
        if sel.startswith('@') or sel == 'page':
            continue
        bm0 = re.search(r'(?:^|[;\s])background(?:-color)?\s*:\s*([^;}]+)', body)
        if not bm0:
            continue
        v = resolve_bg(bm0.group(1), local, WHITE)
        if v is None:
            continue
        bgmap.setdefault(sel, []).extend(v if isinstance(v, list) else [v])

    for sel, body in RULE.findall(src):
        sel = clean_sel(sel)
        if sel.startswith('@') or sel == 'page':
            continue
        cm = re.search(r'(?:^|[;{\s])color\s*:\s*([^;}]+)', body)
        if not cm:
            continue
        fg = resolve(cm.group(1), local)
        if fg is None:
            continue
        bm = re.search(r'(?:^|[;\s])background(?:-color)?\s*:\s*([^;}]+)', body)
        fsm = re.search(r'font-size\s*:\s*(\d+)rpx', body)
        boldm = re.search(r'font-weight\s*:\s*(\d+|bold)', body)
        size = int(fsm.group(1)) if fsm else 28
        bold = bool(boldm)
        limit = 3.0 if (size >= LARGE_PT and bold) else 4.5
        if bm:
            bgv = resolve_bg(bm.group(1), local, WHITE)
            if bgv is None:
                continue
            cands = bgv if isinstance(bgv, list) else [bgv]
            for c in cands:
                r = ratio(fg, c)
                checked += 1
                if r < limit:
                    fails.append(f'{rel} `{sel}` 文字{cm.group(1).strip()} 压在 {bm.group(1).strip()} 上'
                                 f' → 对比度 {r:.2f} < {limit}')
        else:
            inherited = bg_candidates(sel, bgmap, cooc)
            if inherited:
                # 底色由其他规则/祖先提供：逐个候选都要能看清
                for c in inherited:
                    r = ratio(fg, c)
                    checked += 1
                    if r < limit:
                        fails.append(f'{rel} `{sel}` 文字{cm.group(1).strip()} 在继承底色 rgb{c} 上对比度 {r:.2f} < {limit}')
            else:
                # 没写背景也无继承 → 可能落在白卡或页面底色上，两种都要能看清
                for base, bn in ((WHITE, '白卡'), (BG, '页面底')):
                    r = ratio(fg, base)
                    checked += 1
                    if r < limit:
                        fails.append(f'{rel} `{sel}` 文字{cm.group(1).strip()} 在{bn}上对比度 {r:.2f} < {limit}')

# ---------- 4) 每页专属主题色 ----------
PAGES = [os.path.basename(os.path.dirname(x)) for x in glob.glob(os.path.join(ROOT, 'pages', '*', '*.json'))]
SKIP_ACCENT = {'index'}         # index 是占位页，不进主流程
missing = [p for p in sorted(set(PAGES)) if p not in SKIP_ACCENT and p not in page_accents]
if missing:
    fails.append('这些页面缺 page { --accent: #xxx }（"每页专属特色"无法落地也无法机器校验）: ' + ', '.join(missing))
# 主题色必须互不相同，否则"专属"是假的
seen = {}
for p, c in sorted(page_accents.items()):
    seen.setdefault(c.lower(), []).append(p)
dups = {c: ps for c, ps in seen.items() if len(ps) > 1}
for c, ps in dups.items():
    fails.append(f'主题色 {c} 被 {len(ps)} 个页面共用（{", ".join(ps)}）—— 不构成"专属"')
# 主题色自身可读性（既当白字底，也当白底上的标题）
for p, c in sorted(page_accents.items()):
    rgb = parse_hex(c)
    r = ratio(rgb, WHITE)
    checked += 1
    if r < 4.5:
        fails.append(f'pages/{p} --accent {c} 与白色对比度 {r:.2f} < 4.5（白字压不住 / 白底上标题发虚）')

print(f'对比度检查：{checked} 组配色 / {len(page_accents)} 页主题色 / token {len(TOKENS)} 个')
for p, c in sorted(page_accents.items()):
    rgb = parse_hex(c)
    print(f'  {p:<14}{c}  vs白 {ratio(rgb, WHITE):.2f}')
if warns:
    print(f'\n⚠️  {len(warns)} 处提示：')
    for w in warns:
        print('  - ' + w)
if fails:
    print(f'\n❌ {len(fails)} 处配色不达标：')
    for x in fails:
        print('  - ' + x)
    sys.exit(1)
print('\n✅ 全部配色对比度达标（WCAG AA）')
