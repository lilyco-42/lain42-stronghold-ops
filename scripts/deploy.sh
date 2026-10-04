#!/usr/bin/env bash
# Stronghold-Protocol deployment helper for lain42.top.
#
# The game needs ~380 MB of art/audio that upstream serves from
# raw.githubusercontent.com, which this ECS cannot reach. The assets are
# mirrored to OSS once (from a machine that can), and this script pulls them
# back over the OSS internal endpoint (~150 MB/s, free intra-region traffic).
#
# Usage:  ./deploy.sh [--skip-assets]
set -euo pipefail

ROOT=/opt/Stronghold-Protocol
OSS_BUCKET=oss://lain42-downloads
OSS_ENDPOINT=oss-cn-shanghai-internal.aliyuncs.com
OSS_PREFIX=stronghold-protocol
NODE=/usr/local/bin/node22
NPM=/usr/local/bin/npm22
TMP=/var/tmp/sp-deploy

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

log "0. sanity"
[ -d "$ROOT" ] || { echo "missing $ROOT — clone the repo first"; exit 1; }
"$NODE" --version
mkdir -p "$TMP"

if [ "${1:-}" != "--skip-assets" ]; then
  log "1. pull mirrored assets from OSS (internal endpoint)"
  ossutil cp "$OSS_BUCKET/downloads/$OSS_PREFIX/sp-assets.tar.gz" "$TMP/sp-assets.tar.gz" \
    -e "$OSS_ENDPOINT" -f
  ossutil cp "$OSS_BUCKET/downloads/$OSS_PREFIX/sp-fonts.tar.gz" "$TMP/sp-fonts.tar.gz" \
    -e "$OSS_ENDPOINT" -f
  ls -la "$TMP"

  log "2. extract into the project"
  mkdir -p "$ROOT/public/assets" "$ROOT/public/fonts"
  tar xzf "$TMP/sp-assets.tar.gz" -C "$ROOT/public/assets"
  tar xzf "$TMP/sp-fonts.tar.gz"  -C "$ROOT/public/fonts"
  echo "assets: $(find "$ROOT/public/assets" -type f | wc -l) files"
  echo "fonts : $(find "$ROOT/public/fonts" -type f | wc -l) files"
fi

log "2b. restore local-client art (emotes) from OSS"
if ossutil cp "$OSS_BUCKET/downloads/$OSS_PREFIX/sp-local-assets.tar.gz" "$TMP/" -e "$OSS_ENDPOINT" -f 2>/dev/null; then
  tar xzf "$TMP/sp-local-assets.tar.gz" -C "$ROOT"
  echo "local art : $(find "$ROOT/public/assets/local" -type f 2>/dev/null | wc -l) files"
else
  echo "  (no local-art bundle on OSS - in-match emotes fall back to neutral glyphs)"
fi

log "3. npm install (node22)"
cd "$ROOT"
PATH=/usr/local/bin:$PATH "$NPM" install --no-audit --no-fund

log "4. finish the asset pipeline offline"
# The heavy downloads are already on disk; --offline post-processes them, parses
# the Spine skeletons and rewrites data/assets.json + public/fonts/fonts.css.
"$NODE" tools/fetch-assets.mjs --offline

log "4b. point data/assets.json at the OSS CDN (tools/apply-oss-assets.mjs)"
"$NODE" tools/apply-oss-assets.mjs

log "5. summary"
echo "public/assets : $(du -sh "$ROOT/public/assets" | cut -f1)"
echo "public/fonts  : $(du -sh "$ROOT/public/fonts" | cut -f1)"
"$NODE" -e "
const m = require('$ROOT/data/assets.json');
console.log('manifest stats:', JSON.stringify(m.stats));
"
log "done — start with:  systemctl restart stronghold"
