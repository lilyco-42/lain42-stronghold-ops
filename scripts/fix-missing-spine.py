#!/usr/bin/env python3
"""补齐 assets.json 引用但缺失的 spine 素材。

上游规则（来自 tools/assets/plan.mjs）：
  enemy → isHarryh/Ark-Models  models_enemies/<num>_<name>/<stem>.<ext>
  token → fexli/ArknightsResource  spine/<id>/<variant>/Spine|Front/<variant>.<ext>
"""
import base64
import json
import os
import re
import subprocess
import sys

OUT = 'fix-spine'
os.makedirs(OUT, exist_ok=True)

MISSING = [
    'spine/enemy/enemy_10028_vtswd/enemy_10028_vtswd.atlas',
    'spine/enemy/enemy_10042_prtrop/enemy_10042_prtrop.skel',
    'spine/enemy/enemy_10098_crhro/enemy_10098_crhro.skel',
    'spine/token/token_10019_nearl2_sword/token_10019_nearl2_sword_epoque_17.png',
    'spine/token/token_10019_nearl2_sword/token_10019_nearl2_sword_epoque_17.skel',
    'spine/token/token_10022_kazema_shadow/token_10022_kazema_shadow_witch_3.png',
    'spine/token/token_10028_vigil_wolf/token_10028_vigil_wolf_epoque_27.atlas',
    'spine/token/token_10028_vigil_wolf/token_10028_vigil_wolf_epoque_27.png',
    'spine/token/token_10030_mlyss_wtrman/token_10030_mlyss_wtrman_ambienceSynesthesia_6.atlas',
    'spine/token/token_10031_swire2_gdtrap/token_10031_swire2_gdtrap_ambienceSynesthesia_4.skel',
    'spine/token/token_10040_siege2_vlion/token_10040_siege2_vlion_epoque_50.png',
    'spine/token/token_10040_siege2_vlion/token_10040_siege2_vlion_epoque_50.skel',
    'spine/token/token_10056_angel2_target/token_10056_angel2_target_iteration_6.png',
    'spine/token/token_10056_angel2_target/token_10056_angel2_target_iteration_6.skel',
]


def gh(repo, path):
    """取 raw 内容（base64 解码）。"""
    r = subprocess.run(['gh', 'api', f'repos/{repo}/contents/{path}', '--jq', '.content'],
                       capture_output=True, text=True)
    if r.returncode != 0:
        return None, r.stderr.strip()[:90]
    try:
        return base64.b64decode(r.stdout.replace('\n', '')), None
    except Exception as e:
        return None, f'b64: {e}'


def candidates(rel):
    """给出该文件的候选上游 (repo, path) 列表。"""
    stem = os.path.basename(rel)
    name, ext = os.path.splitext(stem)
    if '/enemy/' in rel:
        # spine/enemy/enemy_10028_vtswd/enemy_10028_vtswd.atlas
        m = re.match(r'^enemy_(\d+_[a-z0-9_]+)$', name)
        if not m:
            return []
        return [('isHarryh/Ark-Models', f'models_enemies/{m.group(1)}/{stem}')]
    if '/token/' in rel:
        # 实测路径：spine/<id>/<id>_<variant>/Front/<id>_<variant>.<ext>
        tid = rel.split('/')[2]                       # token_10019_nearl2_sword
        if not name.startswith(tid + '_'):
            return []
        variant_dir = name                            # token_10019_nearl2_sword_epoque_17
        out = []
        for folder in ('Front', 'Spine'):
            out.append(('fexli/ArknightsResource',
                        f'spine/{tid}/{variant_dir}/{folder}/{name}{ext}'))
        return out
    return []


ok, fail = [], []
for rel in MISSING:
    got = None
    errs = []
    for repo, path in candidates(rel):
        data, err = gh(repo, path)
        if data:
            got = (repo, path, data)
            break
        errs.append(f'{repo}:{path} -> {err}')
    if not got:
        fail.append((rel, errs))
        print(f'✗ {rel}')
        for e in errs:
            print(f'    {e}')
        continue
    repo, path, data = got
    dst = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    open(dst, 'wb').write(data)
    ok.append((rel, len(data), repo))
    print(f'✓ {rel}  ({len(data)} bytes)  ← {repo}')

print(f'\n成功 {len(ok)} / {len(MISSING)}，失败 {len(fail)}')
if fail:
    sys.exit(1)
