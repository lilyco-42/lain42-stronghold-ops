#!/usr/bin/env bash
# 把桌面 zip / 安卓 APK 传到 OSS（dl.lain42.top），传完**必须**回读校验 sha256 才算成功。
#
#   在装了 ossutil 与 ~/.ossutilconfig 的那台机器上跑（今天查清：游戏机 8.153.102.122，
#   /usr/local/bin/ossutil + /root/.ossutilconfig，且它就在 cn-shanghai —— 所以走 -internal endpoint，
#   上传不吃那条 ~3 Mbps 公网出口，不影响玩家）。
#   ⚠️ 但**别指望在这台机器上从 GitHub 拉源文件**：实测 GitHub → 本机只有约 29 KB/s（16 分钟 26.5 MiB）。
#   正确两条腿：本机 scp 到 /opt/oss-stage → 这条脚本走内网传 OSS。
#
#   bash scripts/oss-put-client.sh <装着两个产物的目录> [版本号] [--force]
#
# 为什么校验这么严：Release 地址是永久的，玩家拿到坏文件只会骂"这游戏下不动"，没人知道是传输断了。
set -euo pipefail

SRC="${1:-}"; VER="${2:-0.1.3-compat}"; FORCE="${3:-}"
[ -n "$SRC" ] || { echo "用法: bash scripts/oss-put-client.sh <目录> [版本号] [--force]"; exit 2; }
EP='oss-cn-shanghai-internal.aliyuncs.com'            # 本机就是 cn-shanghai（实测 metadata: region=cn-shanghai, zone=cn-shanghai-m）
BUCKET="oss://lain42-downloads/downloads/stronghold-protocol/$VER"   # 与 gzip-spine-to-oss.sh 同一个 bucket（那条今天在生产跑过）
PREFIX="https://dl.lain42.top/downloads/stronghold-protocol/$VER"
FILES=("StrongholdProtocol-desktop-win-x64-$VER.zip" "Stronghold-$VER-android-debug.apk")
# Content-Type 必须给对：APK 给 application/vnd.android.package-archive，浏览器/手机才会当成安装包而不是未知二进制
MIME_apk='application/vnd.android.package-archive'; MIME_zip='application/zip'

for f in "${FILES[@]}"; do
  [ -f "$SRC/$f" ] || { echo "缺文件：$SRC/$f"; exit 2; }
done

if [ "$FORCE" != "--force" ]; then
  # 2026-10-05 实测修正：这台机器就在 cn-shanghai，走 -internal endpoint 传 OSS **不吃**那条 3 Mbps 公网出口
  # （之前我按公网 endpoint 估的"占满上行 25 分钟"不成立，所以这里降级成提醒，不再拦）。
  # 真正的瓶颈在**取源文件**：GitHub → 本机实测只有约 29 KB/s（16 分钟才 26.5 MiB），
  # 所以正确两条腿是「本机 scp → 服务器 /opt/oss-stage → 内网 endpoint → OSS」。
  H=$(curl -s --max-time 15 https://sp.lain42.top/healthz || echo '')
  HUMANS=$(printf '%s' "$H" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("humans",0))' 2>/dev/null || echo 0)
  echo "线上 ${HUMANS:-?} 人（走内网 endpoint，不占玩家带宽；仅记录）"
fi

command -v ossutil >/dev/null || { echo "这台机器上没有 ossutil"; exit 2; }

for f in "${FILES[@]}"; do
  case "$f" in *.apk) CT="$MIME_apk";; *) CT="$MIME_zip";; esac
  echo "--- 上传 $f  (Content-Type: $CT)"
  # 命令形式与 gzip-spine-to-oss.sh 一致（那条在生产跑过）。这台机器 ossutil 支持哪些并发参数我没全查，
  # 所以先探一次 --parallel：不认就退回朴素 cp（set -e 会让失败明确报出来，不会半传还装成功）。
  if ossutil cp --help 2>&1 | grep -q -- '--parallel'; then
    ossutil cp -f --parallel 1 --meta "Content-Type:$CT" "$SRC/$f" "$BUCKET/$f" -e "$EP" >/dev/null
  else
    ossutil cp -f --meta "Content-Type:$CT" "$SRC/$f" "$BUCKET/$f" -e "$EP" >/dev/null
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
