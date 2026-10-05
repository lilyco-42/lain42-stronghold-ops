#!/usr/bin/env bash
# 把桌面 zip / 安卓 APK 传到 OSS（dl.lain42.top），传完**必须**回读校验 sha256 才算成功。
#
#   在装了 ossutil 与 ~/.ossutilconfig 的那台机器上跑（今天查清：是游戏机 8.153.102.122，
#   /usr/local/bin/ossutil + /root/.ossutilconfig）。⚠️ 那台机器出口只有 ~3 Mbps（今天 18:xx 实测 TX 567 KB/s，
#   已超线），传 551 MiB ≈ 25 分钟持续占用，会和正在玩的玩家抢同一条链路 —— 所以默认 **拒绝在有人时跑**，
#   先看一眼 /healthz，或用 --force 明确覆盖这个判断。
#
#   bash scripts/oss-put-client.sh <装着两个产物的目录> [版本号] [--force]
#
# 为什么校验这么严：Release 地址是永久的，玩家拿到坏文件只会骂"这游戏下不动"，没人知道是传输断了。
set -euo pipefail

SRC="${1:-}"; VER="${2:-0.1.3-compat}"; FORCE="${3:-}"
[ -n "$SRC" ] || { echo "用法: bash scripts/oss-put-client.sh <目录> [版本号] [--force]"; exit 2; }
EP='oss-cn-shanghai.aliyuncs.com'                       # 与 gzip-spine-to-oss.sh 同源（改这里即可换区）
BUCKET="oss://dl-lain42/downloads/stronghold-protocol/$VER"
PREFIX="https://dl.lain42.top/downloads/stronghold-protocol/$VER"
FILES=("StrongholdProtocol-desktop-win-x64-$VER.zip" "Stronghold-$VER-android-debug.apk")

for f in "${FILES[@]}"; do
  [ -f "$SRC/$f" ] || { echo "缺文件：$SRC/$f"; exit 2; }
done

if [ "$FORCE" != "--force" ]; then
  H=$(curl -s --max-time 15 https://sp.lain42.top/healthz || echo '')
  HUMANS=$(printf '%s' "$H" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("humans",0))' 2>/dev/null || echo 0)
  if [ "${HUMANS:-0}" -gt 60 ]; then
    echo "现在线上 $HUMANS 人，这台机器的上行会被这次上传占满约 25 分钟 —— 挑低峰再来，或加 --force 明确知道自己在做什么。"
    exit 3
  fi
  echo "线上 ${HUMANS:-?} 人（≤60），继续。"
fi

command -v ossutil >/dev/null || { echo "这台机器上没有 ossutil"; exit 2; }

for f in "${FILES[@]}"; do
  echo "--- 上传 $f"
  # 命令形式与 gzip-spine-to-oss.sh 里那条一致（那条今天在生产上跑过）。
  # 限速靠 --parallel / --part-size；这台机器上 ossutil 是哪个大版本我没查，所以先探一次：
  # 不认这些参数就退回最朴素的 cp（set -e 会让失败明确报出来，不会悄悄半传）。
  if ossutil cp --help 2>&1 | grep -q -- '--parallel'; then
    ossutil cp -f --parallel 1 "$SRC/$f" "$BUCKET/$f" -e "$EP" >/dev/null
  else
    ossutil cp -f "$SRC/$f" "$BUCKET/$f" -e "$EP" >/dev/null
  fi
done

echo "=== 回读校验（HTTP 层，玩家看到的就是这条路）==="
RC=0
for f in "${FILES[@]}"; do
  LOCAL=$(sha256sum "$SRC/$f" | cut -d' ' -f1)
  REMOTE=$(curl -sL --max-time 600 "$PREFIX/$f" | sha256sum | cut -d' ' -f1)
  SIZE=$(stat -c%s "$SRC/$f")
  if [ "$LOCAL" = "$REMOTE" ]; then
    echo "  ✓ $f  $SIZE B  sha256 $LOCAL"
  else
    echo "  ✗ $f  本地 $LOCAL ≠ 远端 $REMOTE —— 别发这条链接，重传"
    RC=1
  fi
done
[ "$RC" = 0 ] || exit "$RC"

echo
echo "可以给玩家/评论区用的直链："
for f in "${FILES[@]}"; do echo "  $PREFIX/$f"; done
echo "下一步：python3 scripts/manifest-add-stronghold.py --manifest /var/www/studio/downloads/manifest.json --dry-run"
