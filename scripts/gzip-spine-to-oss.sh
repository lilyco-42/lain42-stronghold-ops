#!/usr/bin/env bash
# 把 spine 的 .skel / .atlas 以 gzip 形式存到 OSS（带 Content-Encoding: gzip）。
#
# 为什么：干员模型 .skel 中位 183 KB、最大 1365 KB；.skel 压 77%、.atlas 压 81%。
# 浏览器对 Content-Encoding: gzip 是**透明解压**的，所以不用改游戏代码、不用重启。
# .png 不动（已压缩，只省 5.7%）。
#
# 幂等：重复跑会重新压、重新传（覆盖），结果一致。
set -uo pipefail

SRC=/opt/Stronghold-Protocol/public/assets
STAGE=/opt/sp-gz
BUCKET=oss://lain42-downloads/downloads/stronghold-protocol/site
EP=oss-cn-shanghai-internal.aliyuncs.com

cd "$SRC" || exit 1

echo "=== 1) 收集文件 ==="
mapfile -t FILES < <(find spine -type f \( -name '*.skel' -o -name '*.atlas' \) | sort)
echo "  待处理: ${#FILES[@]} 个"

echo "=== 2) gzip 到暂存目录 ==="
rm -rf "$STAGE"
mkdir -p "$STAGE"
RAW=0; GZ=0
for f in "${FILES[@]}"; do
  mkdir -p "$STAGE/$(dirname "$f")"
  gzip -6 -c "$f" > "$STAGE/$f"
  RAW=$((RAW + $(stat -c%s "$f")))
  GZ=$((GZ + $(stat -c%s "$STAGE/$f")))
done
awk -v r=$RAW -v g=$GZ 'BEGIN{printf "  原始 %.1f MB → gzip %.1f MB  (省 %.1f%%)\n", r/1048576, g/1048576, 100*(1-g/r)}'

echo "=== 3) 上传到 OSS（带 Content-Encoding: gzip）==="
ossutil cp -r -f "$STAGE/spine" "$BUCKET/spine" --meta 'Content-Encoding:gzip' -e "$EP" 2>&1 | tail -3

echo "=== 4) 校验 ==="
OK=0; BAD=0
for f in "${FILES[@]:0:3}" "${FILES[@]:$(( ${#FILES[@]} / 2 )):2}" "${FILES[@]: -2}"; do
  LOCAL=$(md5sum "$f" | cut -d' ' -f1)
  GOT=$(curl -s --compressed --max-time 20 "https://dl.lain42.top/downloads/stronghold-protocol/site/$f" | md5sum | cut -d' ' -f1)
  if [ "$LOCAL" = "$GOT" ]; then OK=$((OK+1)); else BAD=$((BAD+1)); echo "  ✗ 不一致: $f"; fi
done
echo "  抽查 $((OK+BAD)) 个：一致 $OK，不一致 $BAD"

echo "=== 5) 抽查响应头 ==="
curl -sI -H 'Accept-Encoding: gzip' --max-time 10 "https://dl.lain42.top/downloads/stronghold-protocol/site/${FILES[0]}" \
  | grep -iE 'HTTP/|content-encoding|content-length' | sed 's/^/  /'

echo "=== 6) 清理暂存 ==="
rm -rf "$STAGE"
df -h /opt | tail -1 | sed 's/^/  /'
echo "完成"
