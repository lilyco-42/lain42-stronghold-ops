#!/usr/bin/env python3
"""拆一个 GitHub Release 大资产里的**单个条目**，不用下载整包。

为什么要这条：`check-payload-offline.mjs <exe>/resources/www` 那条闸门要求本机有一份构建出来的 exe，
干净 clone 没有，整包又有 353 MB。Range 请求三次（尾部 + 中央目录 + 那一条）就能把出厂字节里的
`index.html` 读出来看外链。

这不是权威闸门，是**抽查**：权威判据仍然是把产物下载完整后跑 `tools/check-payload-offline.mjs`（它会扫全部
文本文件、比对镜像清单）。这里只回答一个问题——"发布的这份字节里，入口页到底还引没引站外字体"。

自校验（缺一行都不许信它）：解压出来的**字节数**必须等于中央目录里记的 uncompressed size，
不等就说明本地头/偏移算错了；脚本还打一条正控制——入口页里必然出现的 `<link` 次数。

用法：
    python scripts/spotcheck-release-entry.py v0.1.3-compat desktop 'resources/www/index.html' fonts.googleapis.com fonts.gstatic.com /webfonts/google/google.css '<link'
    python scripts/spotcheck-release-entry.py v0.1.3-compat android 'assets/public/index.html' fonts.googleapis.com fonts.gstatic.com /webfonts/google/google.css '<link'
"""
import json
import subprocess
import sys
import urllib.request
import zlib

REPO = 'lilyco-42/StrongholdProtocolClient'


def asset(tag, which):
    out = subprocess.check_output(
        ['gh', 'api', f'repos/{REPO}/releases/tags/{tag}', '--jq',
         f'[.assets[]|select(.name|test("{which}"))|[.name,.browser_download_url,.size]][0]'], text=True)
    return json.loads(out)


def fetch(url, start, end):
    req = urllib.request.Request(url, headers={'Range': f'bytes={start}-{end}',
                                              'Accept-Encoding': 'identity'})
    with urllib.request.urlopen(req, timeout=180) as r:
        if r.status != 206:
            raise SystemExit(f'服务器没理 Range（{r.status}）—— 这条抽查不适用，改回整包下载')
        return r.read()


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        raise SystemExit(2)
    tag, which, want = sys.argv[1], sys.argv[2], sys.argv[3]
    keys = sys.argv[4:] or ['fonts.googleapis.com', 'fonts.gstatic.com', '/webfonts/google/google.css']
    name, url, size = asset(tag, which)
    print(f'asset {name}  {size:,} B')

    tail = fetch(url, max(0, size - 65536), size - 1)
    i = tail.rfind(b'PK\x05\x06')
    if i < 0:
        raise SystemExit('尾部 64 KB 里没找到 EOCD —— 这个 zip 的注释太长，加大读取窗口')
    cd_size = int.from_bytes(tail[i + 12:i + 16], 'little')
    cd_off = int.from_bytes(tail[i + 16:i + 20], 'little')
    cd = fetch(url, cd_off, cd_off + cd_size - 1)

    p, hits = 0, []
    while cd[p:p + 4] == b'PK\x01\x02':
        method = int.from_bytes(cd[p + 10:p + 12], 'little')
        csize = int.from_bytes(cd[p + 20:p + 24], 'little')
        usize = int.from_bytes(cd[p + 24:p + 28], 'little')
        nlen = int.from_bytes(cd[p + 28:p + 30], 'little')
        elen = int.from_bytes(cd[p + 30:p + 32], 'little')
        clen = int.from_bytes(cd[p + 32:p + 34], 'little')
        loff = int.from_bytes(cd[p + 42:p + 46], 'little')
        ename = cd[p + 46:p + 46 + nlen].decode('utf8', 'replace')
        if want in ename:
            hits.append((ename, method, csize, usize, loff))
        p += 46 + nlen + elen + clen
    if not hits:
        raise SystemExit(f'中央目录里没有包含 {want!r} 的条目 —— 检查路径写法（zip 里可能带 build/... 前缀）')

    for ename, method, csize, usize, loff in hits:
        lh = fetch(url, loff, loff + 29)
        if lh[:4] != b'PK\x03\x04':
            raise SystemExit(f'{ename}: 本地文件头签名不对（{lh[:4]!r}）—— 偏移算错了，别信输出')
        lnl = int.from_bytes(lh[26:28], 'little')
        lel = int.from_bytes(lh[28:30], 'little')
        body = fetch(url, loff + 30 + lnl + lel, loff + 30 + lnl + lel + csize - 1)
        raw = zlib.decompress(body, -15) if method == 8 else body
        if len(raw) != usize:
            raise SystemExit(f'{ename}: 解压得到 {len(raw)} B，中央目录记 {usize} B —— 抽取不完整，判读无效')
        text = raw.decode('utf8', 'replace')
        print(f'{ename}\n  {csize:,} -> {usize:,} B（method {method}，字节数与中央目录一致 ✓）')
        for k in keys:
            print('  %-32s %d' % (k, text.count(k)))


if __name__ == '__main__':
    main()
