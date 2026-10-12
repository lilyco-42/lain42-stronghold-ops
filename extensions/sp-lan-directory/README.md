# sp-lan-directory — 虚拟局域网房间目录 v1

给「自由联机」用的**只读发现层**：列出 EasyTier 虚拟局域网内所有**开着游戏服**的节点，
让小白玩家不用交换 `10.126.126.x` 地址。

与 `extensions/sp-room-api` 的分工（**别混**）：

| | sp-room-api | sp-lan-directory（本目录） |
|---|---|---|
| 数据源 | 游戏进程内存态（preload 注入） | `easytier-cli peer` + 各节点 `/healthz` |
| 是否碰游戏 | **碰**（NODE_OPTIONS 注入） | **不碰**（独立服务、独立单元） |
| 鉴权 | Bearer token（含房间码/人名） | **公开只读**（只有虚拟 IP 与 healthz 计数） |
| 端口 | 127.0.0.1:5187 | 127.0.0.1:5188 |
| 公网路径 | `/api/bot/v1/` | `/api/lan/v1/` |

## 接口

```
GET /api/lan/v1/health  → {"ok":true,"schemaVersion":1,"easytier":"ok","peers":2}
GET /api/lan/v1/rooms   → 目录（见下）
```

```json
{
  "ok": true, "schemaVersion": 1, "generatedAt": "2026-10-13T00:50:57.823Z",
  "network": { "cidr": "10.126.126.0/24", "port": 5150, "peers": 2, "reachable": 2 },
  "rooms": [{
    "virtualIp": "10.126.126.2", "port": 5150, "hostname": "TEST-PLAYER", "self": false,
    "link": { "cost": "p2p", "nat": "PortRestricted" },
    "reachable": true, "app": "0.2.1", "version": "91263e812723", "uptimeSec": 434751,
    "rooms": 0, "humans": 0, "bots": 0, "spectators": 0, "sockets": 0,
    "joinable": false, "checkedAt": "2026-10-13T00:50:57.823Z"
  }]
}
```

- `self: true` = 我们自己的节点（官方服），客户端应单独标注。
- `joinable` 只表示"进程应答了且有活 socket"，**不代表有可进的房间** —— 房间细节属于 sp-room-api。
- 带 `Access-Control-Allow-Origin: *`（选服页跨源取），支持 OPTIONS 预检与 HEAD。
- 缓存 3 秒（`SP_LAN_CACHE_MS`），避免每次请求都扫一遍。

## 实测（2026-10-13 上线验证）

```
# 双节点：官方服 + 一个"玩家自开的服"（临时节点 10.126.126.2 桥到测试实例 5152）
$ curl -s https://sp.lain42.top/api/lan/v1/rooms | jq -r '.rooms[] | "\(.virtualIp) \(.hostname) app=\(.app) rooms=\(.rooms) humans=\(.humans)"'
10.126.126.1 Lain42       app=0.2.4 rooms=67 humans=86     ← self
10.126.126.2 TEST-PLAYER  app=0.2.1 rooms=0  humans=0      ← p2p
```

**双节点必须在同一台机器上测时要注意**：两个实例若共用同一个 `--hostname`（默认取机器名），
EasyTier 会把它们当同一个身份，**互相连不上**（表现为 `connect timeout`）。测试实例要显式
`--hostname TEST-PLAYER --dev-name et-test0 --rpc-portal 127.0.0.1:15889`，并走公网 IP 而不是
回环（回环那次实测超时）。真实玩家在不同机器上不会有这个问题。

## 部署

```bash
scp -r extensions/sp-lan-directory root@sp.lain42.top:/tmp/
ssh root@sp.lain42.top 'cd /tmp/sp-lan-directory && bash install.sh --install'
ssh root@sp.lain42.top 'cd /tmp/sp-lan-directory && python3 patch-pingap.py --check /etc/pingap.toml'
ssh root@sp.lain42.top 'cd /tmp/sp-lan-directory && python3 patch-pingap.py --apply /etc/pingap.toml'
```

- `install.sh` 跑 `node --test` 与 `node --check` 才装（**不过就不装**）。
- pingap 是 `--autoreload` 启动的，改完**不用重启**，约 20 秒内自动生效
  （实测：apply 后 404，等 10 秒变 200）。
- 卸载：`install.sh --uninstall`；pingap 侧回滚用 `/etc/pingap.toml.sp-lan-backup`。

## 已知边界

- 只探 `SP_LAN_GAME_PORT`（默认 5150）与 `SP_LAN_CIDR`（默认 10.126.126.0/24）内的地址，
  **不接受 peer 表里的任意地址**（防止被诱导去探别的网段）。
- 每个节点探一次，超时 800 ms，并发 16；节点多起来后要重估。
- EasyTier peer 表在节点掉线后会**残留一小段时间**（实测拆掉测试节点后仍显示 2 个 peer），
  此时该条 `reachable: false`，客户端应据此显示为离线而不是删除。
