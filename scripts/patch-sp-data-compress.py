#!/usr/bin/env python3
"""给 sp.lain42.top/data 加压缩路由（幂等）。

问题：data/assets.json 有 890 KB，走服务器 590 KB/s 的出口实测要 10.9 秒；
而前端 app.js 里 `withTimeout(assets.ready(), 4000)` 是 4 秒超时 → 玩家加载超时 → 棋盘降级成 2D。
压缩后（br/gzip）大约能降到 ~100 KB，把 10.9 秒压到 1 秒内。

只给 /data 加，不动 sp 的 path=/（避免对图片/音频做无谓压缩浪费 CPU）。
"""
import shutil
import sys

P = '/etc/pingap.toml'
s = open(P, encoding='utf-8').read()

if 'locations.sp_data' in s:
    print('already patched — nothing to do')
    sys.exit(0)

shutil.copy2(P, P + '.bak-spdata')
print(f'backup -> {P}.bak-spdata')

checks = []

old = '    "sp",\n    "sp_ws",\n'
new = '    "sp_data",\n    "sp",\n    "sp_ws",\n'
checks.append(('locations list', old in s))
s = s.replace(old, new, 1)

old = '[locations.sp]\n'
new = '''[locations.sp_data]
enable_reverse_proxy_headers = true
host = "sp.lain42.top"
path = "/data"
upstream = "stronghold_backend"
plugins = ["api_static_compress"]

[locations.sp]
'''
checks.append(('locations.sp anchor', old in s))
s = s.replace(old, new, 1)

bad = [n for n, ok in checks if not ok]
if bad:
    print('ANCHOR NOT FOUND:', bad, '— 文件未修改')
    sys.exit(1)

open(P, 'w', encoding='utf-8').write(s)
print('patched:', ', '.join(n for n, _ in checks))
