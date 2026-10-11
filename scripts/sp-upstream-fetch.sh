#!/usr/bin/env bash
# Fetch upstream and fork on the server, without changing running game files.
#
# 2026-10-11 起多抓一个 ref：lilyco-42 的 deploy/verified。
#   机器人合完上游先推 deploy/prod，**跑过全部闸门**（单测 + npm run golden + ext-surface）
#   之后才把同一个 SHA 推到 deploy/verified。生产部署只认 deploy/verified（见 sp-auto-upgrade.sh），
#   所以这里必须把它抓下来；deploy/prod 继续抓，是为了能看到「合了但没过闸门」的那个状态。
set -Eeuo pipefail
umask 077
BASE=/var/lib/sp-upstream-sync
LOG=/var/log/sp-upstream-sync.log
mkdir -p "$BASE"
exec 9>"$BASE/lock"
flock -n 9 || exit 0
exec >>"$LOG" 2>&1
echo "[$(date -Is)] sync started"
export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false
REPO="$BASE/repo.git"
if [ ! -d "$REPO" ]; then git init --bare -q "$REPO"; fi
fetch_ref() {
  local name="$1" branch="$2" ref="$3" url
  local before after
  before=$(git -C "$REPO" rev-parse -q --verify "$ref" 2>/dev/null || true)
  for url in \
    "ssh://git@ssh.github.com:443/$name.git" \
    "git@github.com:$name.git" \
    "https://github.com/$name.git"; do
    echo "[$(date -Is)] fetching $name $branch using ${url%%:*}"
    if timeout 100 git -c credential.helper= \
      -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 \
      -c core.sshCommand='ssh -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=9' \
      -C "$REPO" fetch --depth=1 --no-tags "$url" \
      "+refs/heads/$branch:$ref"; then
      after=$(git -C "$REPO" rev-parse "$ref")
      printf '%s\n' "$after" > "$BASE/${ref##*/}.sha"
      echo "[$(date -Is)] FETCH_OK $name $branch ${after:0:12} previous=${before:0:12}"
      return 0
    fi
    echo "[$(date -Is)] transport failure; trying alternative"
  done
  echo "[$(date -Is)] FETCH_FAILED $name $branch (existing ref retained)"
  return 1
}
status=0
fetch_ref sganggs/Stronghold-Protocol master refs/heads/upstream-master || status=1
fetch_ref lilyco-42/Stronghold-Protocol deploy/verified refs/heads/verified-deploy || status=1
fetch_ref lilyco-42/Stronghold-Protocol deploy/prod refs/heads/fork-deploy-prod || status=1
if [ -d /usr/local/sbin/sp-maintenance.d ]; then
  count=$(find /usr/local/sbin/sp-maintenance.d -maxdepth 1 -name '*.sh' -type f | wc -l)
  echo "[$(date -Is)] pending_maintenance_jobs=$count; fetch only, no production changes"
fi
echo "[$(date -Is)] sync finished status=$status"
exit "$status"
