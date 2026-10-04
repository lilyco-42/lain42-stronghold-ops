#!/usr/bin/env python3
"""把游戏的前端静态资源（js/css/vendor/fonts/shared）做一份「指向 OSS」的副本。

背景：这台 ECS 出口只有 3 Mbps，而静态文件占了出口的 ~24%（实测 113 KB/s）。
把 js/css/vendor/fonts/shared 搬到 OSS 直接省掉这部分，服务器只留
/sim、/data、/data.js、/assets（sim 靠相对路径引 /shared 与 /data.js，不能搬）。

产出：/opt/sp-oss-build/app/**   —— 与 public/ 同构，可直接同步到 OSS。
同时把改好的 index.html 复制成 public/index-oss.html 供并行测试。

只改 4 个文件里的「根绝对路径」引用，内容锚定、幂等、可重复跑。
"""
import os
import re
import shutil
import sys

GAME = '/opt/Stronghold-Protocol'
STAGE = '/opt/sp-oss-build'
OSS = 'https://dl.lain42.top/downloads/stronghold-protocol/app'
# 从 public/ 下复制的目录（注意 shared 不在 public/ 下，是仓库根目录的）
PUBLIC_DIRS = ['js', 'css', 'vendor', 'fonts']
PREFIXES = ['js', 'css', 'vendor', 'fonts', 'shared']


def patch_html(s):
    """index.html 里的 href/src 与 importmap 的根绝对路径 → OSS 绝对地址。"""
    n = 0
    for p in PREFIXES:
        for attr in ('href="', 'src="'):
            old = f'{attr}/{p}/'
            new = f'{attr}{OSS}/{p}/'
            c = s.count(old)
            if c:
                s = s.replace(old, new)
                n += c
        # importmap 里的 "preact": "/vendor/x.js"
        old = f'": "/{p}/'
        new = f'": "{OSS}/{p}/'
        c = s.count(old)
        if c:
            s = s.replace(old, new)
            n += c
    return s, n


# (相对路径, 旧串, 新串)
JS_PATCHES = [
    ('js/render/board3d/load.js',
     "export const THREE_URL = '/vendor/three.module.js';",
     f"export const THREE_URL = '{OSS}/vendor/three.module.js';"),
    ('js/render/app.js',
     "const VENDOR = { pixi: '/vendor/pixi.min.js', spine: '/vendor/pixi-spine.js' };",
     f"const VENDOR = {{ pixi: '{OSS}/vendor/pixi.min.js', spine: '{OSS}/vendor/pixi-spine.js' }};"),
    ('js/ui/emotes.js',
     "export const EMOTE_CSS_HREF = '/css/emotes.css';",
     f"export const EMOTE_CSS_HREF = '{OSS}/css/emotes.css';"),
    # sim 的 base 是动态 import 的路径，相对「模块自身 URL」解析。
    # /sim 必须留在服务器（它内部 ../../../../shared/ 依赖"在根处被钳制"），
    # 所以这里显式指向服务器的绝对地址；服务器已由 pingap 的 sp_sim location 加了 CORS。
    # dataBase 不用改：它走 fetch()，相对「页面 URL」解析，页面本来就在 sp.lain42.top。
    ('js/battle/runner.js',
     "export async function loadBrowserSim({ base = '/sim/', dataBase = '/data/',",
     "export async function loadBrowserSim({ base = 'https://sp.lain42.top/sim/', dataBase = '/data/',"),
    # fonts.css 里 @font-face 的 src 也是根绝对路径（生成文件，改的是 OSS 副本）
    ('fonts/fonts.css',
     "url('/fonts/",
     f"url('{OSS}/fonts/"),
]


def main():
    app = os.path.join(STAGE, 'app')
    if os.path.exists(app):
        shutil.rmtree(app)
    os.makedirs(app, exist_ok=True)

    # 1) 复制目录
    total = 0
    for d in PUBLIC_DIRS:
        src = os.path.join(GAME, 'public', d)
        if not os.path.isdir(src):
            print(f'  ⚠ 缺目录 {src}')
            continue
        dst = os.path.join(app, d)
        shutil.copytree(src, dst)
        cnt = sum(len(f) for _, _, f in os.walk(dst))
        total += cnt
        print(f'  复制 public/{d}/  ({cnt} 文件)')

    # shared/ 在仓库根目录（server/index.js 把它挂在 /shared）
    src = os.path.join(GAME, 'shared')
    if os.path.isdir(src):
        shutil.copytree(src, os.path.join(app, 'shared'))
        cnt = sum(len(f) for _, _, f in os.walk(os.path.join(app, 'shared')))
        print(f'  复制 shared/        ({cnt} 文件)')
    else:
        print(f'  ⚠ 缺目录 {src}')

    # index.html
    shutil.copyfile(os.path.join(GAME, 'public', 'index.html'), os.path.join(app, 'index.html'))
    print('  复制 index.html')

    # 2) 改 index.html
    idx = os.path.join(app, 'index.html')
    s = open(idx, encoding='utf-8').read()
    s2, n = patch_html(s)
    open(idx, 'w', encoding='utf-8').write(s2)
    print(f'\n  index.html: 改了 {n} 处引用')

    # 3) 改 JS / CSS
    for rel, old, new in JS_PATCHES:
        p = os.path.join(app, rel)
        t = open(p, encoding='utf-8').read()
        if new in t:
            print(f'  {rel}: 已改过，跳过')
            continue
        if old not in t:
            print(f'  {rel}: ❌ 锚点未找到，需人工确认')
            return 1
        c = t.count(old)
        open(p, 'w', encoding='utf-8').write(t.replace(old, new))
        print(f'  {rel}: ✓ ({c} 处)')

    # 4) shared/ 还要在**上一层**放一份：
    #    app 里 24 处 `../../../shared/constants.js` 会逃出 app/ 前缀，
    #    在 OSS 上解析到 .../stronghold-protocol/shared/（服务器上则是站点根 /shared）
    parent_shared = os.path.join(STAGE, 'shared')
    if os.path.exists(parent_shared):
        shutil.rmtree(parent_shared)
    shutil.copytree(os.path.join(app, 'shared'), parent_shared)
    print(f'  shared/ 另存一份到上一层: {parent_shared}')

    # 5) 复制改好的 index.html 供并行测试
    test_html = os.path.join(GAME, 'public', 'index-oss.html')
    shutil.copyfile(idx, test_html)
    print(f'\n  测试入口: {test_html}  → https://sp.lain42.top/index-oss.html')

    # 5) 汇总
    files = sum(len(f) for _, _, f in os.walk(app))
    size = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(app) for f in fs)
    print(f'\n  产出: {app}  {files} 文件 / {size/1048576:.1f} MB')

    # 6) 校验：不应再有裸的根绝对路径（跳过注释行）
    bad = []
    for dp, _, fs in os.walk(app):
        for f in fs:
            if not f.endswith(('.html', '.js', '.css')):
                continue
            fp = os.path.join(dp, f)
            for lineno, line in enumerate(open(fp, encoding='utf-8', errors='replace'), 1):
                stripped = line.strip()
                if stripped.startswith(('//', '/*', '*', '<!--')):
                    continue
                for m in re.finditer(r'''["'`(]/(js|css|vendor|fonts|shared)/''', line):
                    bad.append(f'{os.path.relpath(fp, app)}:{lineno} {m.group(0)}')
    if bad:
        print(f'\n  ⚠ 还剩 {len(bad)} 处根绝对路径（未在注释里）：')
        for b in bad[:20]:
            print('     ', b)
        return 1
    print('\n  ✓ 没有残留的根绝对路径（注释里的除外）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
