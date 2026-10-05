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
"""
import argparse
import json
import os
import re
import subprocess
import sys

VER = '0.1.3-compat'
PREFIX = f'https://dl.lain42.top/downloads/stronghold-protocol/{VER}'
RELEASE = f'https://github.com/lilyco-42/StrongholdProtocolClient/releases/tag/{VER}'
# 这两个 sha256 是 2026-10-05 从 GitHub Release 的 digest 与本机文件逐字节比对过的，不要凭记忆改
FILES = [
    {'id': 'stronghold-protocol-windows', 'platform': 'Windows x64', 'category': '游戏',
     'name': '卫戍协议：盟约（Windows 客户端）',
     'file': f'StrongholdProtocol-desktop-win-x64-{VER}.zip',
     'size': 353439776, 'sha256': '50f09e98ef1c536c9877eef537e6307de3ba45d960087cc630284b2db33def45',
     'summary': '自动棋 roguelike《卫戍协议：盟约》桌面客户端（Electron）。美术与音频全部内置，进对局不再下载资源；'
                '解压后整个文件夹一起放着用，双击里面的 exe 即可。'},
    {'id': 'stronghold-protocol-android', 'platform': 'Android arm64-v8a（debug 签名）', 'category': '游戏',
     'name': '卫戍协议：盟约（安卓 APK）',
     'file': f'Stronghold-{VER}-android-debug.apk',
     'size': 224848906, 'sha256': '27eadc94d40e2b59f54812a6bd8afe01aac00c218662f85cfa554bad62a0d4f2',
     'summary': '同上的安卓版，横屏。debug 签名：与别的签名的同名版本互斥，装之前先卸掉旧的；'
                '默认连 sp.lain42.top，也可在菜单里加自己的服务器。'},
]
LICENSE = 'GPL-3.0-or-later（含《明日方舟》美术/音频，版权归鹰角/Yostar，仅限个人非商业自用）'


def build_items():
    out = []
    for f in FILES:
        out.append({
            'id': f['id'], 'name': f['name'], 'summary': f['summary'], 'category': f['category'],
            'license': LICENSE,
            'repository': 'https://github.com/lilyco-42/StrongholdProtocolClient',
            'release': RELEASE, 'version': VER,
            'mirror': {'platform': f['platform'], 'file': f['file'], 'size': f['size'],
                       'sha256': f['sha256'], 'url': f'{PREFIX}/{f["file"]}'},
            'official': RELEASE,
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
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--allow-missing', action='store_true', help='镜像 URL 还没上传时也写（页面会给出坏链接，慎用）')
    a = ap.parse_args()

    raw = open(a.manifest, encoding='utf-8').read()
    data = json.loads(raw)                      # 读不回就说明清单坏了，先修再谈改动
    items = data.get('items')
    if not isinstance(items, list):
        raise SystemExit('manifest.items 不是列表，不动')

    have = {it.get('id') for it in items}
    add = [it for it in build_items() if it['id'] not in have]
    if not add:
        print('幂等：两条都已在清单里，无需改动')
        return 0

    if not a.allow_missing:
        bad = [it['mirror']['url'] for it in add if not reachable(it['mirror']['url'])]
        if bad:
            for u in bad:
                print('  ✗ 还取不到：', u)
            print('先跑 scripts/oss-put-client.sh 把文件传上去并回读校验，再来改清单。')
            return 1

    for it in add:
        items.append(it)
    if 'updatedAt' in data:
        data['updatedAt'] = '2026-10-05'

    indent = 2 if re.search(r'\{\n  "', raw) else (4 if re.search(r'\{\n    "', raw) else 2)
    new = json.dumps(data, ensure_ascii=False, indent=indent) + ('\n' if raw.endswith('\n') else '')
    back = json.loads(new)
    if [i.get('id') for i in back['items']] != [i.get('id') for i in items]:
        raise SystemExit('自检失败：写出的 JSON 读回来 id 顺序不一致，未写盘')

    if a.dry_run:
        print('--dry-run：不写盘。将新增：')
        for it in add:
            print('  +%s  %s' % (it['id'], it['mirror']['url']))
        print('  （缩进按原文件判为 %s，换行结尾保留）' % indent)
        return 0

    bak = a.manifest + '.bak-stronghold'
    if os.path.exists(bak):
        raise SystemExit(f'备份 {bak} 已存在 —— 那可能是上一次改动前的现场。确认后再改名或删掉，本脚本不覆盖它。')
    open(bak, 'w', encoding='utf-8', newline='').write(raw)
    open(a.manifest, 'w', encoding='utf-8', newline='').write(new)
    print('已写入', a.manifest, '（原文件备份在', bak, '）')
    for it in add:
        print('  +%s → %s' % (it['id'], it['mirror']['url']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
