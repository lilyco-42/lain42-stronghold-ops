# Stronghold Protocol — QQ Bot room-query contract v1

This is a **read-only, authenticated HTTP adapter**, outside the game repository. It does not change the upstream WebSocket protocol. Upstream uses /ws: hello, room.create, room.join and room.state (see game docs/design/network.md). Upstream has NO HTTP waiting-room directory; this is a separate contract.

## HTTP request

Base: https://sp.lain42.top/api/bot/v1 (after Pingap installation). Local address: http://127.0.0.1:5187/v1.

- GET /rooms?mode=coop&joinable=0&limit=50&offset=0 — list waiting rooms.
- GET /rooms/ABCD — one waiting room; 404 if missing or in a match.
- HEAD variants are supported.

All calls require header Authorization: Bearer <random-secret> over HTTPS. The bot must never log or print the token. The token is in /etc/sp-room-api/token, mode 0600. No public access or CORS is enabled. Cache-Control is no-store.

Parameters: mode = coop (default), solo, or all; joinable = 0 (default) or 1; limit = 1..100 (default 50); offset = 0..10000.

Fictional example JSON — real results come only from live server state:

    {
      "ok": true, "schemaVersion": 1, "generatedAt": "2026-10-10T10:00:00.000Z",
      "total": 1, "offset": 0, "limit": 50,
      "rooms": [{
        "code": "ABCD", "mode": "coop", "difficulty": "HARD",
        "status": "waiting", "capacity": 4, "occupancy": 2,
        "humans": 1, "bots": 1, "joinable": true,
        "players": [
          {"seat": 0, "name": "博士甲", "isBot": false, "ready": false, "connected": true, "isHost": true},
          {"seat": 1, "name": "AI·阿米娅", "isBot": true, "ready": true, "connected": true, "isHost": false}
        ],
        "strategy": {"aiPicksLast": false},
        "createdAt": "2026-10-10T09:58:00.000Z"
      }]
    }

Difficulty IDs from upstream: FUNNY=标准模拟, NORMAL=险境模拟, HARD=绝境模拟, ABYSS=终极模拟. The only available waiting-room strategy option is strategy.aiPicksLast. Draft choices and private in-match tactical information DO NOT exist yet in a waiting room and are NOT exposed or fabricated.

Error codes in JSON: 400 BAD_QUERY, 401 UNAUTHORIZED, 404 ROOM_NOT_FOUND/NOT_FOUND, 405 METHOD_NOT_ALLOWED, 429 RATE_LIMITED, 503 LOBBY_UNAVAILABLE. Format: {"ok":false,"error":{"code":"UNAUTHORIZED"}}. Do not interpret an error as no rooms.

Names and four-letter room codes are join secrets protected by bearer authentication. The adapter never sends playerId, reconnect tokens, IP addresses, private loadouts, or in-match state. A QQ group command deliberately sharing a room code is a disclosure to that group: use bot allowlists where appropriate.

## QQ Bot request

On Radxa configure:

- SP_ROOM_API_URL=https://sp.lain42.top/api/bot/v1/rooms
- SP_ROOM_API_TOKEN=(the secret token, only in the private bot service environment)

Send an HTTPS GET with Authorization: Bearer (token), 5 second timeout, and parse JSON. Verify ok=true and schemaVersion=1; display code, players and occupancy, difficulty and aiPicksLast. Limit visible rooms to ten per message and show the total count.

Existing QQ Bot /房间 reads a DIFFERENT online-platform lobby. Prefer adding /游戏房间 for these actual Stronghold game rooms; do not silently combine these separate systems. Do not put credentials or private server payloads in a language model prompt.

## Compatibility and deployment

Local test on any checkout of the relevant game version:

    node --test extensions/sp-room-api/room-api.test.mjs
    node extensions/sp-room-api/integration-smoke.mjs /path/to/Stronghold-Protocol

On lain42.top, stage without restarting current players:

    sudo bash extensions/sp-room-api/install.sh --prepare

This installs /opt/sp-room-api and a systemd Stronghold drop-in. Activation requires a NEXT PLANNED game service restart, not an immediate restart. After activation:

    curl -H "Authorization: Bearer (token)" http://127.0.0.1:5187/v1/rooms

Configure a validated Pingap route for /api/bot/v1/ to 127.0.0.1:5187. Unauthenticated public requests must return 401, authenticated 200. The observer port must remain loopback-only.

No adapter can promise compatibility with every future upstream change. This one relies on Lobby.prototype.stats(), Lobby.rooms Map and Room.toState(). On version changes, integration-smoke must pass before production promotion; otherwise fail closed. It requires no patch or fake player session in the game repository.

Upstream WebSocket spec: https://github.com/sganggs/Stronghold-Protocol/blob/master/docs/design/network.md
