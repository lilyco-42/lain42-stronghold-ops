#!/usr/bin/env python3
"""给 pingap 加一个 /sim 的 location：CORS + 压缩。

为什么需要：
  静态资源（js/css/vendor/fonts/shared）搬到 OSS 后，OSS 上的模块要用
  `import('/sim/spec.js')` 动态导入 sim —— 动态 import 相对「模块自身 URL」解析，
  会落到 OSS 的域名根，所以 runner.js 里把 base 改成服务器的绝对地址。
  但那是**跨域** ESM 导入，服务器必须返回 Access-Control-Allow-Origin，
  而 stronghold 不返回任何 CORS 头 → 在这里补上。

/sim 必须留在服务器：它的内部引用（../../../../shared/constants.js）依赖
「在根处被钳制」才指向 /shared，放到任何 URL 前缀下都会解析错。

幂等：已经打过就跳过。改完用 `pingap -c /etc/pingap.toml -t` 校验。
"""
import re
import shutil
import subprocess
import sys
import time

CONF = '/etc/pingap.toml'
LOC = 'sp_sim'

s = open(CONF, encoding='utf-8').read()

if f'[locations.{LOC}]' in s:
    print(f'[locations.{LOC}] 已存在，跳过')
    sys.exit(0)

# --- 1) 插件：给 /sim 的响应加 CORS 头 ---
PLUGIN = f'''
[plugins.{LOC}_cors]
category = "response_headers"
set_headers = ["Access-Control-Allow-Origin: *"]
'''

# 插在 [plugins.api_static_compress] 之前（找个稳定的锚点）
anchor = '[plugins.api_static_compress]'
if anchor not in s:
    print(f'❌ 找不到锚点 {anchor}')
    sys.exit(1)
s = s.replace(anchor, PLUGIN.lstrip('\n') + '\n' + anchor, 1)

# --- 2) location：/sim → stronghold，带压缩 + CORS ---
LOCATION = f'''
[locations.{LOC}]
enable_reverse_proxy_headers = true
host = "sp.lain42.top"
path = "/sim"
upstream = "stronghold_backend"
plugins = ["api_static_compress", "{LOC}_cors"]
'''

anchor2 = '[locations.sp]\n'
if anchor2 not in s:
    print(f'❌ 找不到锚点 {anchor2!r}')
    sys.exit(1)
s = s.replace(anchor2, LOCATION.lstrip('\n') + '\n' + anchor2, 1)

# --- 3) 注册到 servers.https.locations（必须在 "sp" 之前）---
m = re.search(r'(\[servers\.https\][\s\S]*?locations = \[)([\s\S]*?)(\n\])', s)
if not m:
    print('❌ 找不到 servers.https.locations')
    sys.exit(1)
body = m.group(2)
if f'"{LOC}"' in body:
    print(f'"{LOC}" 已在 locations 列表里')
else:
    new_body = re.sub(r'(\n\s*)"sp",', r'\1"%s",\1"sp",' % LOC, body, count=1)
    if new_body == body:
        print('❌ 没能在 locations 列表里插入（找不到 "sp",）')
        sys.exit(1)
    s = s[:m.start(2)] + new_body + s[m.end(2):]

# --- 写回（先备份）---
shutil.copyfile(CONF, CONF + '.bak-sp-sim')
open(CONF, 'w', encoding='utf-8').write(s)
print('已写入配置（备份 %s.bak-sp-sim）' % CONF)

# --- 校验 ---
r = subprocess.run(['pingap', '-c', CONF, '-t'], capture_output=True, text=True)
out = (r.stdout or '') + (r.stderr or '')
print('pingap -t →', out.strip().splitlines()[-1] if out.strip() else '(无输出)')
if r.returncode != 0:
    print('❌ 配置校验失败，回滚')
    shutil.copyfile(CONF + '.bak-sp-sim', CONF)
    sys.exit(1)
print('✓ 配置校验通过（autoreload 会自动生效，无需重启）')

# --- 展示新增片段 ---
print('\n新增内容：')
for ln in (PLUGIN + LOCATION).strip().splitlines():
    print('  ' + ln)
