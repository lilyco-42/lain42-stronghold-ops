#!/usr/bin/env python3
"""扫描 app 目录里所有「逃出 app 根」的相对引用，列出需要在上一层补齐的目标。

相对导入在 OSS 上按 URL 层级解析：
  .../app/js/screens/room.js 里写 ../../../shared/constants.js
  → .../stronghold-protocol/shared/constants.js（逃出了 app/）
在服务器上这本来指向站点根（/shared、/sim、/data.js），所以 OSS 上也必须在
上一层（.../stronghold-protocol/）放同样的东西。

用真实文件系统路径判断是否逃逸 —— 别用 posixpath.normpath（它会在根处钳制，
把逃逸"吃掉"，看不出问题）。
"""
import os
import re
import collections

APP = '/opt/sp-oss-build/app'
PARENT = os.path.dirname(APP)

IMPORT_RE = re.compile(r'''(?:from|import)\s*\(?\s*['"]([^'"]+)['"]''')
URL_RE = re.compile(r'''url\(\s*['"]?([^'")]+)['"]?\s*\)''')

escapes = collections.Counter()
examples = collections.defaultdict(list)
inside = 0

for dp, _, fs in os.walk(APP):
    for f in fs:
        if not f.endswith(('.js', '.css', '.html')):
            continue
        fp = os.path.join(dp, f)
        rel = os.path.relpath(fp, APP).replace(os.sep, '/')
        try:
            text = open(fp, encoding='utf-8').read()
        except Exception:
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            st = line.strip()
            if st.startswith(('//', '/*', '*')):
                continue
            for spec in IMPORT_RE.findall(line) + URL_RE.findall(line):
                if not spec.startswith('.'):
                    continue
                target = os.path.normpath(os.path.join(os.path.dirname(fp), spec.split('?')[0]))
                if target.startswith(APP + os.sep):
                    inside += 1
                else:
                    # 逃出 app 根 → 相对 PARENT 的路径
                    key = os.path.relpath(target, PARENT)
                    escapes[key] += 1
                    if len(examples[key]) < 4:
                        examples[key].append(f'{rel}:{lineno}')

print(f'app 内解析的引用: {inside}')
print(f'逃出 app 根的引用: {sum(escapes.values())}\n')
if escapes:
    print('需要在上一层 (.../stronghold-protocol/) 补齐的目标：')
    for t, c in escapes.most_common(30):
        print(f'  {c:4d} 次  {t}    例: {", ".join(examples[t])}')
else:
    print('没有逃逸引用 ✓')
