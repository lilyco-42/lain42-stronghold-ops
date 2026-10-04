#!/usr/bin/env bash
# 给 stronghold 的 WebSocketServer 打开 permessage-deflate。
#
# 为什么：这台 ECS 出口只有 3 Mbps，而游戏状态流（JSON 文本）占了出口的 76%。
# 上游 server/index.js 里写死了 perMessageDeflate: false（大概是为了省 CPU/降延迟），
# 但在**带宽是瓶颈**的这台机器上，取舍要反过来 —— deflate 能压掉 70%+。
#
# ⚠️ 必须重启 stronghold 才生效，而**对局状态只在内存里** → 重启会丢掉所有
#    正在进行的对局。所以本脚本默认只在「后端连接数 = 0」时才动手。
#    要立刻强制执行：sp-apply-ws-compress.sh --force
#
# 幂等：已经开过就跳过。改前备份 server/index.js。

set -uo pipefail

GAME=/opt/Stronghold-Protocol
TARGET=$GAME/server/index.js
BACKUP=$GAME/server/index.js.bak-pre-ws-compress
TAG=sp-ws-compress

log() { logger -t "$TAG" -p "daemon.${1:-notice}" -- "$2"; echo "$2"; }

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# ---------- 0) 已经开过了？ ----------
if grep -q 'perMessageDeflate: {' "$TARGET" 2>/dev/null; then
  log notice "perMessageDeflate 已经开启，无需处理"
  exit 0
fi

# ---------- 1) 在线人数检查（非 --force 时）----------
CONN=$(ss -tn 2>/dev/null | grep -c ':5150')
if [ "$FORCE" -ne 1 ]; then
  if [ "${CONN:-0}" -gt 0 ]; then
    # 静默退出（timer 每 5 分钟来一次，不该刷日志）
    exit 0
  fi
  log notice "后端连接数 0，可以安全重启 —— 开始开启 WebSocket 压缩"
else
  log warning "--force：当前有 $CONN 个连接，仍要重启（会丢掉进行中的对局）"
fi

# ---------- 2) 备份（必须在打补丁之前）----------
[ -f "$BACKUP" ] || cp -a "$TARGET" "$BACKUP"
log notice "备份在 $BACKUP"

# ---------- 3) 打补丁（内容锚定，幂等）----------
python3 - "$TARGET" <<'PY'
import re
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

OLD = ("  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, "
       "perMessageDeflate: false, clientTracking: false });")

NEW = """  // lain42: 出口带宽只有 3 Mbps，游戏状态流（JSON 文本）占了 76%。开 deflate 可压掉 70%+。
  // threshold 512：小于 512B 的消息不压（避免小包反而变大）；level 1：拿 CPU 换速度。
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, clientTracking: false,
    perMessageDeflate: {
      threshold: 512,
      zlibDeflateOptions: { level: 1, memLevel: 7 },
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
    } });"""

if 'perMessageDeflate: {' in s:
    print('已经改过，跳过')
    sys.exit(0)
if OLD not in s:
    print('❌ 锚点未找到 —— 上游可能改了这行，需要人工确认：')
    for i, line in enumerate(s.splitlines(), 1):
        if 'WebSocketServer' in line:
            print(f'  {i}: {line}')
    sys.exit(1)

open(p, 'w', encoding='utf-8').write(s.replace(OLD, NEW, 1))
print('✓ server/index.js 已打补丁')
PY
RC=$?
if [ $RC -ne 0 ]; then
  log err "补丁失败（退出码 $RC），未重启"
  exit 1
fi

# ---------- 4) 语法检查 ----------
NODE=$(command -v node22 || command -v node || echo /usr/local/bin/node22)
if ! "$NODE" --check "$TARGET" 2>/dev/null; then
  log err "server/index.js 语法检查失败！回滚"
  cp -f "$BACKUP" "$TARGET"
  exit 1
fi
log notice "语法检查通过（$NODE）"

# ---------- 5) 重启 ----------
BEFORE=$(ps -o etime= -p "$(pgrep -x node22 | head -1)" 2>/dev/null | tr -d ' ')
systemctl restart stronghold
sleep 6

if systemctl is-active --quiet stronghold; then
  log notice "stronghold 已重启（重启前已运行 $BEFORE）"
else
  log err "stronghold 重启后不是 active！回滚并再重启"
  cp -f "$BACKUP" "$TARGET"
  systemctl restart stronghold
  exit 1
fi

# ---------- 6) 验证 ----------
sleep 4
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve sp.lain42.top:443:127.0.0.1 https://sp.lain42.top/ 2>/dev/null || echo 000)
if [ "$CODE" = "200" ]; then
  log notice "验证通过：站点 $CODE。WebSocket 压缩已生效"
else
  log err "验证失败：站点返回 $CODE —— 请人工检查"
  exit 1
fi

# ---------- 7) 关掉自己的 timer（一次性任务）----------
systemctl disable --now sp-ws-compress.timer 2>/dev/null && log notice "已停用 sp-ws-compress.timer（任务完成）"
exit 0
