#!/usr/bin/env python3
"""上线前的只读预检：把 03b（前端指向 OSS）打在临时副本上，验证 OSS 真的能接管这些文件。

为什么需要它：`public/index.html` 是热文件（改了立刻命中在线玩家），而补丁把 21 个 css/js/fonts 地址
换成 `dl.lain42.top/downloads/stronghold-protocol/app/…`。要是 OSS 上那些对象不存在、或者是**旧版本**，
覆盖上去就是白屏或旧样式 —— 这类事只能在动手之前量，不能靠"当初传过"。

做法（全程只读：不写游戏仓库、不写线上、不写 OSS）：
  1. 把 checkout 的 public/index.html 拷进临时目录，用 `patch -p1` 打 03b；
  2. 抽出结果里每个 dl.lain42.top 地址，HEAD 一次（必须 200）；
  3. 再和线上同路径的活文件比字节：相等最好；不相等就把它归因清楚 ——
     只有"把 OSS 地址前缀还原成相对路径后与活文件逐字节相同"才算可接受（那正是 CDN 改写本身），
     其余任何差异都判失败（说明 OSS 上是旧内容）。

    python3 scripts/check-frontend-oss-mirror.py --tree /path/to/Stronghold-Protocol
"""
import argparse
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request

OSS_PREFIX = 'https://dl.lain42.top/downloads/stronghold-protocol/app/'
URL_ATTR = re.compile(r'(?:href|src)="(' + re.escape(OSS_PREFIX) + r'[^"]+)"')


def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()


def head(url, timeout=20):
    req = urllib.request.Request(url, method='HEAD', headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status
    except Exception as e:                                    # noqa: BLE001 - 报告任何失败原因
        return getattr(e, 'code', None) or f'ERR {type(e).__name__}'


def patched_index(tree, patch):
    """在临时目录里打补丁，返回补丁后的 index.html 文本（游戏仓库一个字节都不动）。"""
    work = tempfile.mkdtemp(prefix='sp-oss-check-')
    try:
        os.makedirs(os.path.join(work, 'public'))
        src = os.path.join(tree, 'public', 'index.html')
        shutil.copy2(src, os.path.join(work, 'public', 'index.html'))
        with open(patch, 'rb') as pf, open(os.devnull, 'w') as dn:
            r = subprocess.run(['patch', '-p1'], cwd=work, stdin=pf, stdout=dn, stderr=subprocess.PIPE)
        if r.returncode != 0:
            raise SystemExit(f'补丁打不上（rc={r.returncode}）：{r.stderr.decode("utf-8", "replace")[:300]}')
        with open(os.path.join(work, 'public', 'index.html'), encoding='utf-8') as f:
            return f.read()
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tree', required=True, help='游戏 checkout（读 public/index.html，绝不写）')
    ap.add_argument('--patch', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'patches', 'game', '03b-frontend-to-oss.font-mirror.patch'))
    ap.add_argument('--live', default='https://sp.lain42.top', help='线上同源地址，用来比字节是否漂移')
    ap.add_argument('--no-compare', action='store_true', help='只查 OSS 可达性，不跟线上比字节')
    a = ap.parse_args()

    index = patched_index(a.tree, a.patch)
    urls = list(dict.fromkeys(URL_ATTR.findall(index)))
    print(f'补丁后 index.html 里有 {len(urls)} 个 OSS 地址；Google 字体主机 {len(re.findall(r"fonts[.](?:googleapis|gstatic)[.]com", index))} 次')
    bad, stale, ok = [], [], 0
    for u in urls:
        rel = u[len(OSS_PREFIX):]
        code = head(u)
        if code != 200:
            bad.append(f'{rel} → HEAD {code}')
            continue
        if a.no_compare:
            ok += 1
            continue
        try:
            _, oss_bytes = fetch(u)
            _, live_bytes = fetch(a.live.rstrip('/') + '/' + rel)
        except Exception as e:                                # noqa: BLE001
            bad.append(f'{rel} → 取内容失败 {type(e).__name__}')
            continue
        h = lambda b: hashlib.md5(b).hexdigest()[:12]          # noqa: E731
        if h(oss_bytes) == h(live_bytes):
            ok += 1
            continue
        # 唯一可接受的差异：OSS 那份就是 CDN 改写版（把绝对前缀还原成 / 应当与活文件逐字节相同）
        norm = oss_bytes.decode('utf-8', 'replace').replace(OSS_PREFIX, '/')
        if norm.strip() == live_bytes.decode('utf-8', 'replace').strip():
            print(f'  ≈ {rel}：内容一致，只差 CDN 前缀改写（预期内）')
            ok += 1
            continue
        stale.append(f'{rel}：OSS {h(oss_bytes)} 与线上 {h(live_bytes)} 不同，且不只是前缀改写 —— OSS 上是旧内容，先重传再打补丁')

    print(f'可安全重放：{ok}/{len(urls)}')
    for m in bad + stale:
        print('  ✗ ' + m)
    if bad or stale:
        print('结论：**先别动 public/index.html**，上面这些必须先解决（传 OSS / 重新生成补丁）。')
        return 1
    print('结论：OSS 完全接管这些文件，重放 03b 不会带来 404 也不会带来旧样式。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
