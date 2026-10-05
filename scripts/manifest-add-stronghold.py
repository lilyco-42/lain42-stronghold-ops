#!/usr/bin/env python3
"""往下载站清单 `/var/www/studio/downloads/manifest.json` 里加"卫戍协议：盟约"两条。

五条不变量（与仓库里其它 patch-*.py 同一套）：
  1) 幂等：按 `id` 判断，跑第二次不会插两遍；
  2) `--dry-run` 先看 diff，不写盘；
  3) 写之前两份都能 `json.loads`，且写完再读回来比对；备份 `.bak-stronghold` 存在就不覆盖（避免把上一次的现场洗掉）；
  4) 保留原文件的缩进风格与换行结尾（这是给 nginx 直接发的静态文件，别顺手改格式造成无谓 diff）；
  5) 默认**拒绝**在镜像 URL 还不是 200 的时候写进去 —— 页面上会显示一个"OSS 镜像"徽章 + 坏链接，比不加更糟；
     确实要先占位就 `--allow-missing`。

用法：
    python3 scripts/manifest-add-stronghold.py --manifest /var/www/studio/downloads/manifest.json --dry-run
    python3 scripts/manifest-add-stronghold.py --manifest /var/www/studio/downloads/manifest.json
    # 新版本（size/sha256 从待发布文件实测，别手抄）：
    python3 scripts/manifest-add-stronghold.py --manifest ... --ver 0.1.3-c11 --src-dir /opt/oss-stage/0.1.3-c11 --dry-run
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys

VER = '0.1.3-compat'
# Release tag 带 `v` 前缀（v0.1.3-compat / v0.1.3-c11），版本号本身不带，所以这里拼一次；
# 之前写死成 tag/{VER} 会给出一个 404 的 Release 链接。
RELEASE_T = 'https://github.com/lilyco-42/StrongholdProtocolClient/releases/tag/v{}'
OSS_T = 'https://dl.lain42.top/downloads/stronghold-protocol/{}'
# 这两个 sha256 是 2026-10-05 从 GitHub Release 的 digest 与本机文件逐字节比对过的，不要凭记忆改；
# 新版本请用 --src-dir 从待发布文件当场实测 size + sha256，别手抄。
FILES = [
    {'id': 'stronghold-protocol-windows', 'platform': 'Windows x64', 'category': '游戏',
     'name': '卫戍协议：盟约（Windows 客户端）',
     'file': 'StrongholdProtocol-desktop-win-x64-{ver}.zip',
     'size': 353439776, 'sha256': '50f09e98ef1c536c9877eef537e6307de3ba45d960087cc630284b2db33def45',
     'summary': '自动棋 roguelike《卫戍协议：盟约》桌面客户端（Electron）。美术与音频全部内置，进对局不再下载资源；'
                '解压后整个文件夹一起放着用，双击里面的 exe 即可。'},
    {'id': 'stronghold-protocol-android', 'platform': 'Android arm64-v8a（debug 签名）', 'category': '游戏',
     'name': '卫戍协议：盟约（安卓 APK）',
     'file': 'Stronghold-{ver}-android-debug.apk',
     'size': 224848906, 'sha256': '27eadc94d40e2b59f54812a6bd8afe01aac00c218662f85cfa554bad62a0d4f2',
     'summary': '同上的安卓版，横屏。debug 签名：与别的签名的同名版本互斥，装之前先卸掉旧的；'
                '默认连 sp.lain42.top，也可在菜单里加自己的服务器。'},
]
LICENSE = 'GPL-3.0-or-later（含《明日方舟》美术/音频，版权归鹰角/Yostar，仅限个人非商业自用）'


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 22), b''):
            h.update(chunk)
    return h.hexdigest()


def build_items(ver=VER, src_dir=None):
    """清单条目。给了 `src_dir` 就 size/sha256 一律**实测**（新版本走这条），否则用上面钉住的兼容版数值。"""
    out = []
    for f in FILES:
        name = f['file'].format(ver=ver)
        size, digest = f['size'], f['sha256']
        if src_dir:
            p = os.path.join(src_dir, name)
            if not os.path.isfile(p):
                raise SystemExit(f'--src-dir 里没有 {name} —— 清单里的 size/sha256 必须是量出来的，不能凭记忆写')
            size, digest = os.path.getsize(p), sha256_of(p)
        release = RELEASE_T.format(ver)
        out.append({
            'id': f['id'], 'name': f['name'], 'summary': f['summary'], 'category': f['category'],
            'license': LICENSE,
            'repository': 'https://github.com/lilyco-42/StrongholdProtocolClient',
            'release': release, 'version': ver,
            'mirror': {'platform': f['platform'], 'file': name, 'size': size,
                       'sha256': digest, 'url': f'{OSS_T.format(ver)}/{name}'},
            'official': release,
        })
    return out


def reachable(url):
    try:
        r = subprocess.run(['curl', '-s', '-o', '/dev/null', '--max-time', '20', '-w', '%{http_code}', '-I', url],
                           capture_output=True, text=True)
        return r.stdout.strip() == '200'
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--manifest', required=True)
    ap.add_argument('--ver', default=VER, help='版本号（文件名与两条 URL 都由它拼出来），例如 0.1.3-c11')
    ap.add_argument('--src-dir', help='待发布文件所在目录：给出后 size/sha256 全部当场实测')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--allow-missing', action='store_true', help='镜像 URL 还没上传时也写（页面会给出坏链接，慎用）')
    a = ap.parse_args()

    # 钉住的那对 size/sha256 只属于兼容版；换了版本号还不实测，就会把旧哈希配到新 URL 上（清单里最坏的一种错）。
    if a.ver != VER and not a.src_dir:
        raise SystemExit(f'--ver {a.ver} 必须同时给 --src-dir（新版本的 size/sha256 要从待发布文件实测，不能沿用钉住的 {VER} 值）')

    raw = open(a.manifest, encoding='utf-8', newline='').read()   # newline='': 备份与判行尾都要看到原始字节
    data = json.loads(raw)                      # 读不回就说明清单坏了，先修再谈改动
    items = data.get('items')
    if not isinstance(items, list):
        raise SystemExit('manifest.items 不是列表，不动')

    want = build_items(a.ver, a.src_dir)
    by_id = {it.get('id'): it for it in items}
    # 幂等：同 id 同版本 → 不动。升版本（同 id 不同 version）是**替换**，否则页面永远停在旧的一条。
    add, replace = [], []
    for it in want:
        old = by_id.get(it['id'])
        if old is None:
            add.append(it)
        elif old.get('version') != it['version']:
            replace.append((old, it))
    if not add and not replace:
        print(f'幂等：两条已是 {a.ver}，无需改动')
        return 0

    todo = add + [new for _, new in replace]
    if not a.allow_missing:
        bad = [it['mirror']['url'] for it in todo if not reachable(it['mirror']['url'])]
        if bad:
            for u in bad:
                print('  ✗ 还取不到：', u)
            print('先跑 scripts/oss-put-client.sh 把文件传上去并回读校验，再来改清单。')
            return 1

    for it in add:
        items.append(it)
    for old, repl in replace:
        items[items.index(old)] = repl
    if 'updatedAt' in data:
        data['updatedAt'] = '2026-10-05'

    indent = 2 if re.search(r'\{\n  "', raw) else (4 if re.search(r'\{\n    "', raw) else 2)
    body = json.dumps(data, ensure_ascii=False, indent=indent) + ('\n' if raw.endswith('\n') else '')
    # 行尾要跟着原文件：这份清单今天是 CRLF 的，文本模式读会把 \r\n 吞成 \n，写回去就变成整文件 400 多行的无谓 diff。
    if '\r\n' in raw:
        body = body.replace('\r\n', '\n').replace('\n', '\r\n')
    back = json.loads(body)
    if [i.get('id') for i in back['items']] != [i.get('id') for i in items]:
        raise SystemExit('自检失败：写出的 JSON 读回来 id 顺序不一致，未写盘')

    if a.dry_run:
        print(f'--dry-run：不写盘。版本 {a.ver}，新增 {len(add)} 条、替换 {len(replace)} 条：')
        for it in todo:
            print('  %s%s  %s  %s B  sha256 %s' % ('+' if it in add else '~', it['id'], it['mirror']['url'],
                                                  it['mirror']['size'], it['mirror']['sha256']))
        print('  （缩进按原文件判为 %s，换行结尾保留）' % indent)
        return 0

    bak = a.manifest + '.bak-stronghold'
    if os.path.exists(bak):
        raise SystemExit(f'备份 {bak} 已存在 —— 那可能是上一次改动前的现场。确认后再改名或删掉，本脚本不覆盖它。')
    open(bak, 'w', encoding='utf-8', newline='').write(raw)
    open(a.manifest, 'w', encoding='utf-8', newline='').write(body)
    print('已写入', a.manifest, '（原文件备份在', bak, '）')
    for it in todo:
        print('  %s → %s' % (it['id'], it['mirror']['url']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
