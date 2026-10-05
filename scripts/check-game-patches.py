#!/usr/bin/env python3
"""把 patches/game/*.patch 逐条 dry-run 在一棵游戏树上，输出漂移表（只读，不写任何东西）。

为什么需要：这台机器对游戏仓库的改动全是补丁（WS 压缩、spine 接受 http、前端指向 OSS、清单指向 CDN）。
上游一升版本，补丁就可能对不上 —— 0.1.1→0.1.3 那次覆盖式部署就丢了 `03`（线上 index.html 变回上游版）。
与其事后靠带宽异常发现，不如升完第一时间跑这张表。

判读口径（都是 `patch --dry-run` 的原话）：
  clean     完全按声明位置命中 —— 最理想
  offset N  位置漂了 N 行但内容对得上 —— 可用，但基线一变就可能碎，值得重新生成补丁
  FUZZ N    连上下文都要凑 —— **勉强能打的运气货**，应当重新生成
  FAILED    打不上 —— 必须重新生成后才能部署这批改动

    python3 scripts/check-game-patches.py --tree D:/Code/Stronghold-Protocol-upstream
    python3 scripts/check-game-patches.py --tree /opt/sp-game-src --allow-fail 04-asset-manifest-cdn

`--allow-fail` 是给"本来就是生成物 diff"的那类补丁用的（04 的 data/assets.json 那半截是生成物，
本该用 tools/apply-oss-assets.mjs 重生成，不该指望补丁命中）。默认任何 FAILED 都会让退出码非零。
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PATCH_DIR = os.path.join(HERE, '..', 'patches', 'game')


def classify(out):
    """从 patch 的输出里判 clean / offset / fuzz / FAILED。"""
    if 'FAILED' in out or "can't be applied" in out or 'Reversed' in out:
        return 'FAILED'
    if re.search(r'with fuzz \d', out):
        return 'FUZZ ' + re.search(r'with fuzz (\d)', out).group(1)
    if re.search(r'offset [-\d]+ lines?', out):
        return 'offset ' + re.search(r'offset ([-\d]+) lines?', out).group(1)
    return 'clean' if 'checking file' in out else 'NO OUTPUT'


def run_patch(patch, tree):
    with open(patch, 'rb') as pf:
        r = subprocess.run(['patch', '-p1', '--dry-run'], cwd=tree, stdin=pf,
                           capture_output=True, text=True, encoding='utf-8', errors='replace')
    return r.returncode, (r.stdout or '') + (r.stderr or '')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tree', required=True, help='游戏 checkout（只读：补丁打在临时副本上）')
    ap.add_argument('--allow-fail', default='', help='逗号分隔的补丁名（可省略 .patch），FAILED 也不算失败')
    a = ap.parse_args()

    src = os.path.abspath(a.tree)
    if not os.path.isfile(os.path.join(src, 'public', 'index.html')):
        raise SystemExit(f'{src} 看起来不是游戏 checkout（没有 public/index.html）')
    allow = {x.strip() for x in a.allow_fail.split(',') if x.strip()}

    work = tempfile.mkdtemp(prefix='sp-patchcheck-')
    try:
        # 只拷补丁要碰的那些文件所在的树：整棵树太慢，用符号链接式拷贝即可
        shutil.copytree(src, os.path.join(work, 't'), symlinks=True, ignore=shutil.ignore_patterns('node_modules', '.git'))
        tree = os.path.join(work, 't')
        bad = []
        for name in sorted(os.listdir(PATCH_DIR)):
            if not name.endswith('.patch'):
                continue
            code, out = run_patch(os.path.join(PATCH_DIR, name), tree)
            verdict = classify(out) if code == 0 else 'FAILED'
            numbered = name[:-len('.patch')]                       # 04-asset-manifest-cdn
            bare = re.sub(r'^\d+-', '', numbered)                   # asset-manifest-cdn
            flag = '' if code == 0 else ' (rc=%d)' % code
            tolerated = verdict != 'FAILED' or bool({numbered, bare, name} & allow)
            print(f'  {verdict:10s} {name}{flag}' + ('   ← 已知生成物，容忍' if (verdict == 'FAILED' and tolerated) else ''))
            if verdict == 'FAILED' and not tolerated:
                bad.append(name)
            for line in out.splitlines():
                if 'FAILED' in line or 'fuzz' in line:
                    print('        ' + line.strip())
    finally:
        shutil.rmtree(work, ignore_errors=True)

    if bad:
        print('结论：这些补丁在当前树上打不上，重新生成之后才能部署：' + ', '.join(bad))
        return 1
    print('结论：补丁集可用（offset/fuzz 的条目建议顺手重新生成，别等基线再动一次就碎）。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
