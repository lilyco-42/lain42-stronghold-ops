#!/usr/bin/env python3
"""Opt-in Pingap route for the authenticated Stronghold room observer.

Never reloads Pingap by itself. Strict anchors, TOML verification, and backup.
Usage: python3 patch-pingap.py --check [/etc/pingap.toml]
       python3 patch-pingap.py --apply [/etc/pingap.toml]
"""
import argparse
import os
from pathlib import Path
import re
import subprocess
import tempfile
import tomllib

UPSTREAM = "sp_room_bot_backend"
LOCATION = "sp_room_bot"
SERVER = "https"
ROUTE = "/api/bot/v1/"


def patch(src: str) -> str:
    parsed = tomllib.loads(src)
    server = parsed.get("servers", {}).get(SERVER)
    if not isinstance(server, dict) or "sp" not in server.get("locations", []):
        raise ValueError("expected https server with Stronghold sp location")
    if LOCATION in server["locations"]:
        existing = parsed.get("locations", {}).get(LOCATION, {})
        upstream = parsed.get("upstreams", {}).get(UPSTREAM, {})
        if existing.get("path") != ROUTE or existing.get("upstream") != UPSTREAM or upstream.get("addrs") != ["127.0.0.1:5187"]:
            raise ValueError("conflicting existing room route")
        return src
    if LOCATION in parsed.get("locations", {}) or UPSTREAM in parsed.get("upstreams", {}):
        raise ValueError("route/upstream names already taken")
    matches = list(re.finditer(r"(?m)^\[servers\.https\]\s*$", src))
    if len(matches) != 1:
        raise ValueError("expected exactly one [servers.https] section")
    begin = matches[0].end()
    next_section = re.search(r"(?m)^\[[A-Za-z0-9_.-]+\]\s*$", src[begin:])
    end = begin + next_section.start() if next_section else len(src)
    part = src[begin:end]
    locations = list(re.finditer(r"(?ms)^locations\s*=\s*\[(.*?)\]", part))
    if len(locations) != 1:
        raise ValueError("expected exactly one locations array in https server")
    current = locations[0].group(1)
    target = re.search(r'(?m)^\s*"sp"\s*,?\s*$', current)
    if not target:
        raise ValueError("expected exact sp location entry")
    updated = current[:target.start()] + '    "sp_room_bot",\n' + current[target.start():]
    part = part[:locations[0].start(1)] + updated + part[locations[0].end(1):]
    out = src[:begin] + part + src[end:]
    out += (
        "\n[upstreams.sp_room_bot_backend]\n"
        'addrs = ["127.0.0.1:5187"]\n'
        "\n[locations.sp_room_bot]\n"
        'host = "sp.lain42.top"\n'
        'path = "/api/bot/v1/"\n'
        'upstream = "sp_room_bot_backend"\n'
        "enable_reverse_proxy_headers = true\n"
    )
    checked = tomllib.loads(out)
    assert checked["servers"][SERVER]["locations"].index(LOCATION) < checked["servers"][SERVER]["locations"].index("sp")
    assert checked["locations"][LOCATION]["upstream"] == UPSTREAM
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--check", action="store_true")
    group.add_argument("--apply", action="store_true")
    ap.add_argument("config", nargs="?", default="/etc/pingap.toml")
    args = ap.parse_args()
    path = Path(args.config)
    before = path.read_text(encoding="utf-8")
    after = patch(before)
    if args.check:
        print("VALID:", str(path), "already applied" if after == before else "pending patch")
        return
    if os.geteuid() != 0:
        raise PermissionError("must be root")
    if after == before:
        print("ALREADY_APPLIED")
        return
    with tempfile.NamedTemporaryFile(mode="w", suffix=".toml", prefix="sp-room-", delete=False, encoding="utf-8") as f:
        f.write(after)
        candidate = f.name
    try:
        subprocess.run(["pingap", "-c", candidate, "-t"], check=True)
        backup = path.with_name(path.name + ".sp-room-backup")
        if backup.exists():
            raise FileExistsError("backup already exists, refusing to overwrite")
        backup.write_text(before, encoding="utf-8")
        os.chmod(backup, 0o600)
        os.chmod(candidate, path.stat().st_mode & 0o777)
        os.replace(candidate, path)
        print("APPLIED; backup:", str(backup))
        print("No Pingap reload performed; validate the backend first.")
    finally:
        if os.path.exists(candidate):
            os.unlink(candidate)


if __name__ == "__main__":
    main()
