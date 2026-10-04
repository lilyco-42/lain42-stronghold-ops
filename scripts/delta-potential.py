#!/usr/bin/env python3
"""量化 m.public 的增量编码潜力（不需要任何依赖）。

m.public 是服务端反复广播的完整游戏状态，中位 3624 字节。
如果相邻帧大部分相同，那么「只发变化」能省掉绝大部分 —— 而且是在压缩**之前**省。
"""
import json
from collections import Counter

d = json.load(open('ws-frames.json', encoding='utf-8'))
pub = []
for f in d['frames']:
    if f['dir'] != 'in' or not f['text']:
        continue
    try:
        j = json.loads(f['payload'])
    except Exception:
        continue
    if j.get('t') == 'm.public':
        pub.append(j)

print(f'm.public 帧数: {len(pub)}')

full = sum(len(json.dumps(p, ensure_ascii=False, separators=(',', ':')).encode()) for p in pub)
print(f'完整发送合计: {full/1024:.1f} KB\n')


def deep_diff(a, b):
    """返回 b 相对 a 的补丁：{key: 新值}，值相同则不含该 key。列表按整体替换。"""
    if not isinstance(a, dict) or not isinstance(b, dict):
        return None if a == b else b
    out = {}
    for k, v in b.items():
        if k not in a:
            out[k] = v
        elif isinstance(v, dict) and isinstance(a[k], dict):
            sub = deep_diff(a[k], v)
            if sub:
                out[k] = sub
        elif v != a[k]:
            out[k] = v
    return out or None


pairs = list(zip(pub, pub[1:]))
diff_bytes = 0
changed_keys = Counter()
unchanged_top = 0
for a, b in pairs:
    p = deep_diff(a, b)
    if p is None:
        diff_bytes += len(b'null')  # 无变化
        continue
    diff_bytes += len(json.dumps(p, ensure_ascii=False, separators=(',', ':')).encode())
    for k in p:
        changed_keys[k] += 1
    same = sum(1 for k in b if k not in p)
    unchanged_top += same

n = len(pairs)
print(f'相邻帧对数: {n}')
print(f'完整发送合计: {full/1024:.1f} KB')
print(f'增量补丁合计: {diff_bytes/1024:.1f} KB  →  省 {100*(1-diff_bytes/full):.1f}%\n')

print('每个 key 在多少比例的帧里发生了变化：')
for k, c in changed_keys.most_common(25):
    print(f'  {k:<24} {c:>4}/{n}  ({100*c/n:5.1f}%)')

print(f'\n未变化顶层 key 数合计: {unchanged_top}（平均每帧 {unchanged_top/max(n,1):.1f} 个 key 没变）')

# 键的重复度（解释为什么 deflate 有效）
keys = Counter()
for p in pub:
    for k in p:
        keys[k] += 1
print(f'\n顶层 key 种类: {len(keys)}，出现最多的：')
for k, c in keys.most_common(10):
    print(f'  {k:<24} {c}/{len(pub)}')
