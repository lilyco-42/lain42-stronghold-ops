#!/usr/bin/env bash
# Install the Stronghold LAN directory as a STANDALONE systemd service.
#
# Deliberately touches neither the game repository nor the running game process:
# the directory only shells out to `easytier-cli` and probes each peer's /healthz.
# Nothing here restarts Stronghold, so no in-memory match is lost.
#
# Usage: sudo bash install.sh --install | --status | --uninstall
set -Eeuo pipefail
umask 022
[ "$(id -u)" = 0 ] || { echo "Run as root" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST=/opt/sp-lan-directory
UNIT=/etc/systemd/system/sp-lan-directory.service
NODE=${SP_LAN_NODE:-/usr/local/bin/node22}

usage() { echo "Usage: sudo bash install.sh --install | --status | --uninstall" >&2; exit 2; }
[ "$#" -eq 1 ] || usage
MODE="$1"

case "$MODE" in
  --status)
    systemctl --no-pager --full status "$UNIT" 2>/dev/null | head -12 || true
    echo "--- probe ---"
    curl --fail --silent --show-error --max-time 5 http://127.0.0.1:5188/v1/health || echo "(not answering)"
    echo
    curl --fail --silent --show-error --max-time 8 http://127.0.0.1:5188/v1/rooms || echo "(not answering)"
    echo
    exit 0
    ;;
  --uninstall)
    systemctl disable --now sp-lan-directory.service 2>/dev/null || true
    rm -f "$UNIT"; systemctl daemon-reload
    rm -rf "$DEST"
    echo "UNINSTALLED (Pingap route, if patched, must be reverted separately)"
    exit 0
    ;;
  --install) ;;
  *) usage ;;
esac

[ -x "$NODE" ] || { echo "Node runtime not found at $NODE (override with SP_LAN_NODE=...)" >&2; exit 1; }
command -v easytier-cli >/dev/null || { echo "easytier-cli not in PATH; deploy the EasyTier LAN node first (docs/20)" >&2; exit 1; }
"$NODE" --check "$HERE/directory.mjs"
"$NODE" --test "$HERE/directory.test.mjs" >/dev/null || { echo "unit tests failed; refusing to install" >&2; exit 1; }

install -d -m 755 "$DEST"
install -m 644 "$HERE/directory.mjs" "$DEST/directory.mjs"
install -m 644 "$HERE/directory.test.mjs" "$DEST/directory.test.mjs"
install -m 755 "$HERE/install.sh" "$DEST/install.sh"

cat > "$UNIT" <<UNITCONF
[Unit]
Description=Stronghold LAN directory (lists game servers on the EasyTier virtual LAN)
After=network-online.target
Wants=network-online.target
# Not Requires=easytier-lan: this service must stay up across an EasyTier restart and
# simply answer 503 EASYTIER_UNAVAILABLE while the node is down.

[Service]
Type=simple
DynamicUser=yes
ExecStart=$NODE $DEST/directory.mjs
Environment=SP_LAN_DIRECTORY_PORT=5188
Environment=SP_LAN_DIRECTORY_BIND=127.0.0.1
Environment=SP_LAN_CIDR=10.126.126.0/24
Environment=SP_LAN_GAME_PORT=5150
# Both ports on purpose: 5150 is ours, 3000 is the game's own default — a player who hosts for
# their friends follows upstream DEPLOY.md and lands on 3000. Probing only 5150 hid every
# player-hosted room, which is the case this whole feature exists for. Override to narrow it.
Environment=SP_LAN_GAME_PORTS=5150,3000
Environment=SP_LAN_EASYTIER_CLI=/usr/local/bin/easytier-cli
Environment=SP_LAN_RPC_PORTAL=127.0.0.1:15888
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=128M

[Install]
WantedBy=multi-user.target
UNITCONF
chmod 644 "$UNIT"
systemctl daemon-reload
systemctl enable --now sp-lan-directory.service
sleep 2
systemctl is-active sp-lan-directory.service
echo "INSTALLED: $DEST, unit $UNIT (listening 127.0.0.1:5188)"
echo "Next: expose it with patch-pingap.py --apply, then verify https://sp.lain42.top/api/lan/v1/rooms"
