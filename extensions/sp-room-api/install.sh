#!/usr/bin/env bash
# Stage a no-core-edit room observer on lain42.top.
# Deliberately does NOT restart Stronghold: all in-memory matches would be lost.
set -Eeuo pipefail
umask 077
[ "$(id -u)" = 0 ] || { echo "Run as root" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST=/opt/sp-room-api
UNIT=/etc/systemd/system/stronghold.service.d/20-sp-room-api.conf
TOKEN_DIR=/etc/sp-room-api
GAME_ROOT=/opt/Stronghold-Protocol
[ "$#" -eq 1 ] || { echo "Usage: sudo bash install.sh --prepare | --status" >&2; exit 2; }
MODE="$1"
if [ "$MODE" = '--status' ]; then
  systemctl show stronghold.service -p ActiveState -p DropInPaths
  if [ -s "$TOKEN_DIR/token" ]; then
    curl --fail --silent --show-error --max-time 5 \
      -H "Authorization: Bearer $(cat "$TOKEN_DIR/token")" \
      "http://127.0.0.1:5187/v1/rooms?limit=1" || true
  else
    echo "Token not configured"
  fi
  exit 0
fi
[ "$MODE" = '--prepare' ] || { echo "Usage: sudo bash install.sh --prepare | --status" >&2; exit 2; }
[ -f "$GAME_ROOT/server/lobby.js" ] && [ -f "$GAME_ROOT/server/index.js" ] ||
  { echo "Game root not found" >&2; exit 1; }
command -v node >/dev/null || { echo "Node not in PATH; check service runtime" >&2; exit 1; }
systemctl show stronghold.service -p ExecStart --value | grep -Fq "/opt/Stronghold-Protocol/server/index.js" || {
  echo "Only direct-node Stronghold service entry is supported; refusing NODE_OPTIONS injection" >&2; exit 1;
}
node --check "$HERE/preload.mjs"
node --test "$HERE/room-api.test.mjs"
if systemctl show stronghold.service -p Environment --value | grep -q 'NODE_OPTIONS=' && ! grep -Fq 'SP_ROOM_API_TOKEN_FILE' "$UNIT" 2>/dev/null; then
  echo "Existing NODE_OPTIONS detected; do not overwrite its configuration automatically" >&2
  exit 1
fi
install -d -m 700 "$TOKEN_DIR"
if [ ! -s "$TOKEN_DIR/token" ]; then
  openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n' > "$TOKEN_DIR/token"
fi
chmod 600 "$TOKEN_DIR/token"
install -d -m 755 "$DEST"
for f in preload.mjs api.mjs snapshot.mjs room-api.test.mjs; do
  install -m 644 "$HERE/$f" "$DEST/$f"
done
install -m 755 "$HERE/install.sh" "$DEST/install.sh"
install -d -m 755 "$(dirname "$UNIT")"
if [ -f "$UNIT" ] && ! grep -Fq 'SP_ROOM_API_TOKEN_FILE' "$UNIT"; then
  echo "Refusing to replace unrelated stronghold unit override" >&2
  exit 1
fi
cat > "$UNIT" <<'UNITCONF'
[Service]
Environment="SP_ROOM_GAME_ROOT=/opt/Stronghold-Protocol"
Environment="SP_ROOM_API_TOKEN_FILE=/etc/sp-room-api/token"
Environment="SP_ROOM_API_PORT=5187"
Environment="NODE_OPTIONS=--import=file:///opt/sp-room-api/preload.mjs"
UNITCONF
chmod 644 "$UNIT"
systemctl daemon-reload
echo "STAGED: $DEST and $UNIT"
echo "NO production restart performed. Observer activates at the NEXT planned Stronghold restart."
