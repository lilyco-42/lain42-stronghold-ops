#!/usr/bin/env bash
# 只读汇总：当前状态 vs 今晚各修复的基线。不碰任何服务。
set -u
HZ=100
P=$(pgrep -x node22 | head -1)
PP=$(pgrep -x pingap | head -1)

cpu_pct() { # $1=pid $2=secs
  local a b
  a=$(awk '{print $14+$15}' /proc/$1/stat 2>/dev/null) || { echo "?"; return; }
  sleep "$2"
  b=$(awk '{print $14+$15}' /proc/$1/stat 2>/dev/null) || { echo "?"; return; }
  awk -v a="$a" -v b="$b" -v hz="$HZ" -v s="$2" 'BEGIN{printf "%.1f", (b-a)/hz/s*100}'
}

echo "=========== 当前状态 ==========="
echo "  玩家连接(5150)     : $(ss -tn 2>/dev/null | grep -c ':5150')"
echo "  stronghold 运行时长 : $(ps -o etime= -p $P 2>/dev/null | tr -d ' ')"
echo "  stronghold 内存     : $(awk '/VmRSS/{printf "%.0f MB", $2/1024}' /proc/$P/status)"
echo "  pingap FD           : $(ls /proc/$PP/fd 2>/dev/null | wc -l) / $(awk '/Max open files/{print $4}' /proc/$PP/limits)"
echo "  可用内存            : $(free -h | awk 'NR==2{print $7}')"
echo "  /tmp (tmpfs)        : $(df -h /tmp | awk 'NR==2{print $5}')"
echo "  磁盘                : $(df -h / | awk 'NR==2{print $5}')"
echo

echo "=========== 出口带宽（30 秒）==========="
S=0; N=0; MX=0
for i in $(seq 1 30); do
  A=$(cat /sys/class/net/eth0/statistics/tx_bytes); sleep 1
  B=$(cat /sys/class/net/eth0/statistics/tx_bytes)
  R=$(( (B-A)/1024 )); S=$((S+R)); N=$((N+1)); [ $R -gt $MX ] && MX=$R
done
echo "  均值 ${S}/${N} KB/s  →  $(awk -v s=$S -v n=$N 'BEGIN{printf "%.0f", s/n}') KB/s"
echo "  峰值 ${MX} KB/s"
echo "  上限 3 Mbps ≈ 375 KB/s（稳态）"
echo

echo "=========== CPU（各 20 秒）==========="
echo "  stronghold : $(cpu_pct $P 20)% of one core"
echo "  pingap     : $(cpu_pct $PP 20)% of one core"
echo "  核数       : $(nproc)"
echo

echo "=========== 静态请求（12 秒抓包）==========="
timeout 12 tcpdump -i lo -s 0 -w /tmp/st.pcap 'tcp port 5150' 2>/dev/null
tcpdump -r /tmp/st.pcap -A 2>/dev/null > /tmp/st.txt
echo "  总 HTTP 请求数: $(grep -cE '^(GET|POST) /' /tmp/st.txt)"
echo "  按路径:"
grep -oE '^(GET|POST) /[a-zA-Z0-9/._-]*' /tmp/st.txt | awk '{print $2}' | sed 's|^/\([a-z]*\)/.*|/\1/|' | sort | uniq -c | sort -rn | head -6 | sed 's/^/    /'
rm -f /tmp/st.pcap /tmp/st.txt
