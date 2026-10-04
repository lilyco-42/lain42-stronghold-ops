#!/usr/bin/env bash
# 只读测量：stronghold / pingap 的 CPU 占用（jiffies 差值），不碰任何服务。
set -u
HZ=100   # USER_HZ

cpu_of() {  # $1=pid $2=秒数  → 打印 "x.x% of one core"
  local p=$1 secs=$2 a b
  a=$(awk '{print $14+$15}' /proc/$p/stat 2>/dev/null) || return
  sleep "$secs"
  b=$(awk '{print $14+$15}' /proc/$p/stat 2>/dev/null) || return
  awk -v a="$a" -v b="$b" -v hz="$HZ" -v s="$secs" \
      'BEGIN{printf "%.1f%%", (b-a)/hz/s*100}'
}

P=$(pgrep -x node22 | head -1)
PP=$(pgrep -x pingap | head -1)

echo "stronghold PID=$P   pingap PID=$PP"
echo
for i in 1 2 3; do
  printf '  stronghold 第 %d 次（20 秒）: %s of one core   [连接 %s]\n' \
    "$i" "$(cpu_of "$P" 20)" "$(ss -tn 2>/dev/null | grep -c ':5150')"
done
echo
printf '  pingap（只转发，不压缩）: %s of one core\n' "$(cpu_of "$PP" 20)"
echo
echo "  CPU 核数: $(nproc)"
echo "  基线：压缩前 19:27 实测 stronghold = 9.9%（382 连接）"
