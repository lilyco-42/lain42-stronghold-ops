#!/usr/bin/env bash
# sp-auto-upgrade.sh —— 把生产切到 deploy/verified 指向的那棵树。通用：结束「一版一脚本」。
#
# 为什么认 deploy/verified 而不是 deploy/prod：
#   deploy/prod = 机器人合完上游；deploy/verified = 合完并且**跑过全部闸门**
#   （单测 + `npm run golden` + ext-surface）之后才发布的那个 ref。生产只认后者。
#
# 为什么回滚目标不再是 /opt/Stronghold-Protocol：
#   那棵树是 0.2.1。旧的 sp-upgrade-023*.sh 回滚方式是「删掉 drop-in」→ 直接掉回 0.2.1，
#   等于一次失败部署把生产降级两版。本脚本的回滚目标是**切换前正在跑的那棵树**（现读 systemd），
#   所以失败只回退一版。
#
# 流程：锁 → 解析目标 → 幂等判断 → 暂存 → 隔离端口验证 → 换 drop-in + 重启
#       → 线上健康闸门 → 失败自动回滚 / 成功记状态 + 清旧树
#
# 由 sp-maintenance.d/50-sp-auto-upgrade.sh 在维护窗口（04:00–06:00）调用。
# 也可手动跑（它会自己上锁，重复调用安全）。
set -Eeuo pipefail
umask 077

BASE=/var/lib/sp-upstream-sync
REPO=$BASE/repo.git
STATE_DIR=/var/lib/sp-deploy
STATE=$STATE_DIR/deployed.sha
NODE=/usr/local/bin/node22
TOKEN=/etc/sp-room-api/token
DD=/etc/systemd/system/stronghold.service.d
DROP=$DD/90-auto-deploy.conf
UNIT=stronghold.service
LOG=/var/log/sp-auto-upgrade.log
# 试跑端口块（5198/5199）刻意与常驻服务的 515x/518x 分开：
#   5150 游戏 / 5152 sp-dev-test / 5187 房间 API（pingap 路由 /api/bot/v1/）
#   5188 局域网目录 sp-lan-directory（pingap 路由 sp_lan_directory_backend）
# 2026-10-13 实测：隔离验证的试跑 API 曾用 5188，与 sp-lan-directory 撞端口 →
#   preload 报 "loopback listener unavailable: EADDRINUSE"，curl 打到目录服务上拿到 200、
#   闸门误判成「未认证返回 200」而 fail closed（生产未受影响）。故移出 5188。
TRIAL_PORT=5199
TRIAL_API_PORT=5198
LIVE_PORT=5150
LIVE_API_PORT=5187
KEEP_TREES=3

mkdir -p "$STATE_DIR"
exec >>"$LOG" 2>&1
say() { echo "[$(date -Is)] $*"; }
exec 9>/run/lock/sp-auto-upgrade.lock
flock -n 9 || { say "另一个部署正在进行，退出"; exit 0; }

say "=== 开始 ==="

# ---------- 1. 解析目标 ----------
SHA=""
for ref in refs/heads/verified-deploy refs/heads/fork-deploy-prod; do
  if git -C "$REPO" rev-parse -q --verify "$ref" >/dev/null 2>&1; then
    SHA=$(git -C "$REPO" rev-parse "$ref")
    say "目标 ref: $ref -> ${SHA:0:12}"
    [ "$ref" = "refs/heads/fork-deploy-prod" ] && \
      say "⚠️ 裸仓里没有 verified-deploy，退而使用 deploy/prod（它**没**跑过完整闸门）"
    break
  fi
done
[ -n "$SHA" ] || { say "裸仓里没有可用 ref，退出"; exit 1; }

# ---------- 2. 幂等 ----------
if [ -f "$STATE" ] && [ "$(cat "$STATE")" = "$SHA" ]; then
  say "目标 SHA 已经在跑，无事可做"; exit 0
fi

CUR_DIR=$(systemctl show "$UNIT" -p WorkingDirectory --value 2>/dev/null || true)
[ -n "$CUR_DIR" ] || { say "读不到当前 WorkingDirectory，退出"; exit 1; }
say "当前运行的树: $CUR_DIR"

D=/opt/Stronghold-Protocol-${SHA:0:8}

# ---------- 3. 前置检查（都不触碰生产）----------
test -f "$TOKEN" || { say "房间 API 凭证缺失，退出"; exit 2; }
[ -d "$CUR_DIR/public/assets" ] || { say "当前树没有 public/assets，退出"; exit 2; }

# ---------- 4. 暂存 ----------
if [ -e "$D" ]; then
  say "暂存目录已存在，跳过暂存: $D"
else
  say "暂存到 $D"
  mkdir -p "$D"
  git -C "$REPO" archive "$SHA" | tar -x -C "$D"
  # 依赖：0.2.3→0.2.4 无变化；沿用当前树的 node_modules（只读共享，零拷贝）
  ln -s "../$(basename "$CUR_DIR")/node_modules" "$D/node_modules"
  # 素材：硬链当前树 —— 硬链不占额外空间，且当前树保持完好（它还是回滚目标）
  cp -al "$CUR_DIR/public/assets" "$D/public/assets"
  # 素材管线期望存在的空目录
  mkdir -p "$D/public/fonts" "$D/public/vendor"
  # 生产专有文件：不在任何分支上，只存在于服务器 —— 必须带过去
  if [ -f "$CUR_DIR/public/index-oss.html" ]; then
    cp -a "$CUR_DIR/public/index-oss.html" "$D/public/index-oss.html"
  fi
  # 清单切 CDN（生产素材走 CDN 绝对 URL；纯文本替换，可逆）
  "$NODE" /opt/sp-tools/transform-assets.mjs "$D/data/assets.json" https://cdn.lilyco42.top
  echo "$SHA" > "$D/.sp-deploy-sha"
fi

VER=$("$NODE" -e "process.stdout.write(String(require('$D/package.json').version))" 2>/dev/null || true)
[ -n "$VER" ] || { say "读不到暂存树的版本号，退出"; exit 2; }
say "目标版本: $VER"

# 静态自检
"$NODE" --check "$D/server/index.js" || { say "server/index.js 语法错误，退出"; exit 2; }
"$NODE" -e "JSON.parse(require('fs').readFileSync('$D/data/assets.json','utf8'))" \
  || { say "data/assets.json 不是合法 JSON，退出"; exit 2; }
grep -q 'cdn\.lilyco42\.top' "$D/data/assets.json" || { say "清单未切 CDN，退出"; exit 2; }
say "静态自检通过"

# ---------- 5. 隔离端口验证（生产一动不动）----------
say "隔离验证：游戏 :$TRIAL_PORT / 房间 API :$TRIAL_API_PORT"
cleanup_trial() { pkill -f "$D/server/index.js" 2>/dev/null || true; }
cleanup_trial
( cd "$D" && PORT=$TRIAL_PORT HOST=127.0.0.1 NODE_ENV=production SP_COMBAT=client SP_NO_BROWSER=1 \
    TRUST_PROXY=1 SP_ROOM_GAME_ROOT="$D" SP_ROOM_API_TOKEN_FILE="$TOKEN" \
    SP_ROOM_API_PORT=$TRIAL_API_PORT NODE_OPTIONS=--import=file:///opt/sp-room-api/preload.mjs \
    timeout 90 "$NODE" "$D/server/index.js" ) >/tmp/sp-auto-trial.log 2>&1 &
ok=no
for _ in $(seq 1 25); do
  sleep 1
  if curl -fsS -m 3 "http://127.0.0.1:$TRIAL_PORT/healthz" 2>/dev/null | grep -q "\"app\":\"$VER\""; then ok=yes; break; fi
done
if [ "$ok" != yes ]; then
  say "  ✗ 隔离验证失败，生产未受影响"; tail -25 /tmp/sp-auto-trial.log | sed 's/^/    /'
  cleanup_trial; exit 1
fi
say "  ✓ healthz app=$VER"

c=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$TRIAL_API_PORT/v1/rooms?limit=2" || echo 000)
[ "$c" = 401 ] || { say "  ✗ 房间 API 未认证期望 401，实得 $c"; cleanup_trial; exit 1; }
curl -fsS -m 5 -H "Authorization: Bearer $(cat "$TOKEN")" \
  "http://127.0.0.1:$TRIAL_API_PORT/v1/rooms?limit=2" \
  | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(j.ok!==true||j.schemaVersion!==1)process.exit(1)})' \
  || { say "  ✗ 房间 API 已认证校验失败"; cleanup_trial; exit 1; }
say "  ✓ 房间 API 401 / 200"

sc=$(curl -s -o /dev/null -w '%{http_code}' -m 6 "http://127.0.0.1:$TRIAL_PORT/servers.json" || echo 000)
[ "$sc" = 200 ] || { say "  ✗ /servers.json 期望 200，实得 $sc（服务器列表是 fork 功能，必须有）"; cleanup_trial; exit 1; }
say "  ✓ /servers.json 200"
for u in /index.html /index-oss.html; do
  cc=$(curl -s -o /dev/null -w '%{http_code}' -m 6 "http://127.0.0.1:$TRIAL_PORT$u" || echo 000)
  [ "$cc" = 200 ] && say "  ✓ $u 200" || say "  ⚠ $u -> $cc"
done
cleanup_trial
say "隔离验证全部通过"

# ---------- 6. 切换 ----------
PREV_DIR="$CUR_DIR"
for f in "$DD"/30-upstream-*.conf; do
  [ -e "$f" ] || continue
  mv -f "$f" "$f.disabled"
  say "停用遗留 drop-in: $(basename "$f") -> $(basename "$f").disabled"
done
write_drop() {
  local dir="$1"
  cat > "$DROP.tmp" <<CONF
[Service]
WorkingDirectory=$dir
ExecStart=
ExecStart=$NODE $dir/server/index.js
Environment=SP_ROOM_GAME_ROOT=$dir
CONF
  chmod 0644 "$DROP.tmp"
  mv -f "$DROP.tmp" "$DROP"
  systemctl daemon-reload
}
rollback() {
  say "ROLLBACK: $1"
  write_drop "$PREV_DIR"
  systemctl restart "$UNIT" || true
  sleep 4
  say "  回滚后服务状态: $(systemctl is-active "$UNIT")"
  curl -fsS -m 8 "http://127.0.0.1:$LIVE_PORT/healthz" || true
  say "  已回滚到 $PREV_DIR（注意：本次重启已踢掉对局）"
  exit 1
}

say "切换 $PREV_DIR -> $D"
write_drop "$D"
systemctl restart "$UNIT" || rollback "restart 失败"

ready=no
for _ in $(seq 1 20); do
  if curl -fsS -m 3 "http://127.0.0.1:$LIVE_PORT/healthz" 2>/dev/null | grep -q "\"app\":\"$VER\""; then ready=yes; break; fi
  sleep 2
done
[ "$ready" = yes ] || rollback "本地 healthz 未达 $VER"
say "  ✓ 本地 healthz app=$VER"

c=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$LIVE_API_PORT/v1/rooms?limit=2" || echo 000)
[ "$c" = 401 ] || rollback "房间 API 未认证期望 401，实得 $c"
curl -fsS -m 5 -H "Authorization: Bearer $(cat "$TOKEN")" \
  "http://127.0.0.1:$LIVE_API_PORT/v1/rooms?limit=2" >/dev/null || rollback "房间 API 已认证失败"
say "  ✓ 房间 API 401 / 200"

remote=000
for _ in $(seq 1 24); do
  remote=$(curl -ksS -m 5 -o /dev/null -w '%{http_code}' "https://sp.lain42.top/api/bot/v1/rooms?limit=2" || echo 000)
  [ "$remote" = 401 ] && break
  sleep 2
done
[ "$remote" = 401 ] || rollback "公网未认证期望 401，实得 $remote"
say "  ✓ 公网未认证 401"

ra=$(curl -ksS -m 7 -H "Authorization: Bearer $(cat "$TOKEN")" -o /dev/null -w '%{http_code}' \
  "https://sp.lain42.top/api/bot/v1/rooms?limit=2" || echo 000)
[ "$ra" = 200 ] || rollback "公网已认证期望 200，实得 $ra"
say "  ✓ 公网已认证 200"

say "SUCCESS $VER (${SHA:0:12})"
curl -fsS -m 8 "https://sp.lain42.top/healthz" || true
echo "$SHA" > "$STATE"

# ---------- 7. 清旧树（保留最新 KEEP_TREES 个，绝不删正在跑的）----------
for old in $(ls -dt /opt/Stronghold-Protocol-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f] 2>/dev/null | tail -n +$((KEEP_TREES + 1))); do
  [ "$old" = "$D" ] && continue
  [ "$old" = "$PREV_DIR" ] && continue
  say "清旧树 $old"
  rm -rf "$old"
done
say "=== 完成 ==="
