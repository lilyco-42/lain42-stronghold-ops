#!/usr/bin/env bash
# sp-watchdog — 每分钟一次自检/自愈（由 systemd timer 驱动，平时零常驻）
#
# 起因 2026-10-04：pingap 的软 FD 限额是 systemd 默认的 1024，被 300+ 个
# WebSocket 长连接耗尽（1021/1024）→ 它连自己的健康检查都开不了 socket
# → 上游被标记 down → 全站 503，而且**它自己永远恢复不了**。
# 这个脚本就是那个「外面的人」。
#
# 只有两个动作会改状态，都是幂等、低风险、不重启任何服务的：
#   1) prlimit 提升 pingap 的 FD 限额
#   2) touch /etc/pingap.toml 触发 autoreload，复位上游熔断状态
# 其余只告警，不自动重启（重启会踢掉在线玩家，交给人决定）。

set -uo pipefail

TAG=sp-watchdog
STATE=/run/sp-watchdog
mkdir -p "$STATE" 2>/dev/null || { STATE=/var/tmp/sp-watchdog; mkdir -p "$STATE" 2>/dev/null; }

HEARTBEAT_EVERY=60     # 每 60 次（约 1 小时）打一条 OK 心跳，免得没问题时也在刷日志
RELOAD_MIN_GAP=180     # 两次 autoreload 之间至少隔 180 秒
FD_SOFT_TARGET=524288
FD_WARN_PCT=80

warn() { logger -t "$TAG" -p daemon.warning "$1"; }
err()  { logger -t "$TAG" -p daemon.err     "$1"; }
info() { logger -t "$TAG" -p daemon.notice  "$1"; }

problems=0
USED="?"; SOFT="?"; DIRECT="?"; PROXY="?"

# ---------- 1) pingap FD 用量（本次事故的根因）----------
PID=$(pgrep -x pingap | head -1)
if [ -n "${PID:-}" ]; then
  USED=$(ls /proc/$PID/fd 2>/dev/null | wc -l)
  SOFT=$(awk '/Max open files/{print $4}' /proc/$PID/limits 2>/dev/null)
  if [ -n "${SOFT:-}" ] && [ "$SOFT" != "unlimited" ] && [ "${SOFT:-0}" -gt 0 ] 2>/dev/null; then
    PCT=$(( USED * 100 / SOFT ))
    if [ "$PCT" -ge "$FD_WARN_PCT" ]; then
      problems=$((problems + 1))
      if [ "$SOFT" -lt "$FD_SOFT_TARGET" ]; then
        if prlimit --pid "$PID" --nofile=$FD_SOFT_TARGET:$FD_SOFT_TARGET 2>/dev/null; then
          warn "pingap FD $USED/$SOFT (${PCT}%) 逼近上限 —— 已自动提升到 $FD_SOFT_TARGET"
        else
          err "pingap FD $USED/$SOFT (${PCT}%) —— prlimit 提升失败，需人工介入"
        fi
      else
        err "pingap FD $USED/$SOFT (${PCT}%) —— 已达设定上限，无法再自动提升；疑似连接泄漏"
      fi
    fi
  fi
else
  problems=$((problems + 1))
  err "找不到 pingap 进程"
fi

# ---------- 2) 上游健康：直连后端正常、但经反代不通 → 复位熔断 ----------
DIRECT=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:5150/ 2>/dev/null || echo 000)
PROXY=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 --resolve sp.lain42.top:443:127.0.0.1 https://sp.lain42.top/ 2>/dev/null || echo 000)
if [ "$DIRECT" = "200" ] && [ "$PROXY" != "200" ]; then
  problems=$((problems + 1))
  NOW=$(date +%s)
  LAST=$(cat "$STATE/last-reload" 2>/dev/null || echo 0)
  case "$LAST" in ''|*[!0-9]*) LAST=0 ;; esac
  if [ $((NOW - LAST)) -ge "$RELOAD_MIN_GAP" ]; then
    warn "直连后端 $DIRECT 正常但经 pingap 返回 $PROXY —— 触发 autoreload 复位上游状态"
    touch /etc/pingap.toml
    echo "$NOW" > "$STATE/last-reload"
  else
    err "经 pingap 仍不通（$PROXY），距上次 autoreload 不足 ${RELOAD_MIN_GAP}s —— 需人工检查"
  fi
fi

# ---------- 3) 可用内存 ----------
AVAIL=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 9999)
case "$AVAIL" in ''|*[!0-9]*) AVAIL=9999 ;; esac
if [ "$AVAIL" -lt 100 ]; then
  problems=$((problems + 1))
  warn "可用内存仅 ${AVAIL}M"
fi

# ---------- 4) /tmp（这台机器上是 tmpfs = 内存盘）----------
if [ "$(df -T /tmp 2>/dev/null | awk 'NR==2{print $2}')" = "tmpfs" ]; then
  TPCT=$(df --output=pcent /tmp 2>/dev/null | tail -1 | tr -dc '0-9')
  if [ -n "$TPCT" ] && [ "$TPCT" -ge 90 ]; then
    problems=$((problems + 1))
    warn "/tmp (tmpfs) 已用 ${TPCT}% —— 大文件不要放 /tmp，会吃内存"
  fi
fi

# ---------- 5) 服务存活 ----------
for s in stronghold pingap; do
  if ! systemctl is-active --quiet "$s"; then
    problems=$((problems + 1))
    err "$s 不是 active"
  fi
done

# ---------- 心跳：一切正常时不刷日志 ----------
N=$(cat "$STATE/run" 2>/dev/null || echo 0)
case "$N" in ''|*[!0-9]*) N=0 ;; esac
N=$((N + 1))
echo "$N" > "$STATE/run"
if [ "$problems" -eq 0 ] && [ $((N % HEARTBEAT_EVERY)) -eq 0 ]; then
  info "OK（第 $N 次）：pingap FD $USED/$SOFT、可用内存 ${AVAIL}M、直连 $DIRECT / 反代 $PROXY"
fi

exit 0
