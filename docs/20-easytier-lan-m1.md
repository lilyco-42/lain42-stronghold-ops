# 20 — EasyTier 虚拟局域网 M1 落地方案

> 2026-10-13 成文。前置调研结论见 `MEMORY.md`「联机组网」节。
> 目标：**玩家自开服 + 互相发现，且流量不占我们出口**；官方服顺带获得一条
> 虚拟 LAN 直连路径。**排队功能不做**（连接数门限永不触发，见 2026-10-13 实测）。

## 0. 现状实测（2026-10-13 00:00-00:20）

| 项 | 实测值 | 影响 |
|---|---|---|
| 游戏服监听 | `127.0.0.1:5150`（`stronghold.service` 的 `Environment=HOST=127.0.0.1`） | 虚拟 IP 到达后**不会**自动进游戏服，需要一座本地桥 |
| 游戏服进程 | `node22 /opt/Stronghold-Protocol-a8dc5091/server/index.js`，RSS 243 MB，CPU 17.6% | EasyTier 单线程默认即可，别开 multi-thread |
| 内存 | total 1682 MB / available 719 MB / **swap 已用 1274 MB** | 别再往上叠常驻大进程（dockerd 全家已占约 1/4） |
| 出口带宽 | eth0 TX ≈ 2.01 Mbps（上限 3 Mbps） | 中继必须有带宽硬闸 |
| healthz | sockets 66 / sessions 120 / rooms 74 / matches 73 / humans 100 | 满载门限 `maxConnections: 2000` 永不触发 |
| socat | **未装** | 装它（apt，小写入） |
| 本机防火墙 | `iptables INPUT policy ACCEPT`，无规则 | 不拦；**但阿里云安全组是另一回事**，见 §4 |
| sp-room-api | `127.0.0.1:5187` 活着（401） | 只读房间状态，不参与本方案 |

## 1. 架构

```
                 ┌──────────────── 我们的服务器 sp.lain42.top ────────────────┐
                 │  easytier-core（TUN 10.126.126.1，共享节点，private-mode）  │
                 │      │  socat: 10.126.126.1:5150 → 127.0.0.1:5150         │
                 │      ▼                                                    │
                 │  stronghold（官方服，127.0.0.1:5150，业务零改动零重启）      │
                 └───────────────────────────────────────────────────────────┘
                      ▲ 玩家 P2P 直连到此节点（UDP 打洞优先）
   ┌──────────────────┼──────────────────────────────┐
   玩家 A（GUI/CLI）   玩家 B（自开服 stronghold+ET）   玩家 C（Android APK）
   10.126.126.x       10.126.126.y:5150              10.126.126.z
```

**核心判断（为什么自开服场景不占我们出口）**：游戏是 server-authoritative 的，
流量只有「玩家 → 该局的服主机」。玩家自开服时，流量是两个玩家之间的 P2P 流，
我们的节点只做 rendezvous（控制面，几 KB/s）。只有当双方 NAT 打洞失败时，
才经我们中继 —— 那时 `--foreign-relay-bps-limit` 兜底。

官方服场景下 EasyTier 不省带宽（玩家到服务器的路径本来就在公网上），
只多一层封装与加密开销，换来的是「虚拟 LAN 内 `ws://` 免 TLS」和一条
绕开 pingap 的直连路径。

## 2. 服务器侧（唯一需要动生产机的部分）

### 2.1 安装（小写入，需先经用户确认）

```bash
# EasyTier v2.6.4（2026-05-12 发布，实测为该仓最新 release）
mkdir -p /etc/easytier && cd /etc/easytier
curl -fL -o et.zip https://github.com/EasyTier/EasyTier/releases/download/v2.6.4/easytier-linux-x86_64-v2.6.4.zip
unzip -o et.zip && install -m 0755 easytier-linux-x86_64/easytier-core /usr/local/bin/
install -m 0755 easytier-linux-x86_64/easytier-cli /usr/local/bin/
apt-get install -y socat          # 端口桥用
```

### 2.2 systemd 单元 `/etc/systemd/system/easytier-lan.service`

```ini
[Unit]
Description=EasyTier LAN node (Stronghold virtual LAN, 10.126.126.1)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/easytier/env          # NETWORK_NAME / NETWORK_SECRET，0600
ExecStart=/usr/local/bin/easytier-core \
  --instance-name stronghold-lan \
  --ipv4 10.126.126.1 \
  --network-name ${NETWORK_NAME} \
  --network-secret ${NETWORK_SECRET} \
  --listeners 11010 \
  --rpc-portal 127.0.0.1:15888 \
  --private-mode \
  --foreign-relay-bps-limit 262144 \
  --console-log-level info
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

参数依据（全部来自官方配置文档，逐条核对过）：

| 参数 | 作用 | 为什么选它 |
|---|---|---|
| `--ipv4 10.126.126.1` | 固定虚拟 IP | 官方服虚拟地址恒定，客户端可预填、bot 可播报 |
| `--listeners 11010` | tcp/udp/ws 听 11010，wss/wg 听 11011 | 只开一对端口，安全组最小化 |
| `--private-mode` | **只放行网络名+密码相同的节点握手/中转** | 防陌生人蹭我们节点当中转，官方公共节点全死背景下这是刚需 |
| `--foreign-relay-bps-limit 262144` | 转发流量限 256 KB/s | 出口剩 ~1 Mbps，这是硬闸；打洞失败时的最坏情况可控 |
| `--rpc-portal 127.0.0.1:15888` | 管理端口只听回环 | 不开公网管理面 |
| 不设 `--multi-thread` | 默认单线程 | 2 vCPU，游戏服已 17.6%，别抢 |

### 2.3 端口桥 `/etc/systemd/system/easytier-lan-bridge.service`

```ini
[Unit]
Description=Bridge virtual LAN 5150 to game server (127.0.0.1:5150)
After=easytier-lan.service
Requires=easytier-lan.service

[Service]
Type=simple
ExecStart=/usr/bin/socat TCP-LISTEN:5150,bind=10.126.126.1,fork,reuseaddr TCP:127.0.0.1:5150
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

**为什么不改 `stronghold.service` 的 `HOST=`**：改它要重启游戏服 =
丢掉所有进行中的对局（状态只在内存里）。socat 桥零重启、随时可拆，
同机回环一次拷贝，CPU 开销可忽略。**留作下次自然重启窗口的收尾项**：
把 `HOST` 改成 `10.126.126.1` 并删掉本桥。

### 2.4 网络凭据的生成与存放

```bash
install -d -m 0700 /etc/easytier
( umask 077; printf 'NETWORK_NAME=stronghold-lan\nNETWORK_SECRET=%s\n' \
    "$(head -c 24 /dev/urandom | base64)" > /etc/easytier/env )
```

凭据只从这台机器读出，经分享链接分发给玩家（见 §3）。

## 3. 分享链接（玩家一键加入的瓶颈）

官方 GUI/Web 的「分享」产出的是
`https://easytier.cn/comp_cfg?cfg=<base64url 压缩配置>`
（格式来自上游源码 `share_link_service.rs:13-14,97-105`：
host 固定 `easytier.cn`，path `/comp_cfg`，配置本体全内嵌、客户端本地解压，
**不依赖 easytier.cn 服务器本身可用** —— 域名只是链接门面）。

生成方式（在服务器的 easytier 上操作，或本地 GUI 建同参网络再分享）：

```bash
easytier-cli config-file /tmp/lan.toml     # 或直接写，字段见官方 example.toml
# ipv4 留空（玩家端用 dhcp 或让 ET 自己分配），只带：
#   [network_identity] network_name / network_secret
#   [[peer]] uri = "tcp://sp.lain42.top:11010"
#   [[peer]] uri = "udp://sp.lain42.top:11010"
```

然后 GUI 导入该 toml → 分享 → 得到链接与二维码。**分享链接内含网络密码，
等同房间密码，分发渠道 = 群公告 / 客户端选服页 / bot 播报。**

## 4. 必须用户本人在阿里云控制台做的事（AI 开不了）

安全组入方向放行：

| 协议 | 端口 | 用途 |
|---|---|---|
| TCP | 11010 | 打洞与连接（TCP 模式、ws） |
| UDP | 11010 | 打洞与连接（UDP 模式，主力） |
| TCP | 11011 | wss / WireGuard 兜底 |

放行前先验一下现状：从外部 `nc -vz sp.lain42.top 11010` 现在应为拒绝。
**没放行 = 整个方案不成立**，这是唯一的外部阻塞步骤。

## 5. 客户端改动（客户端仓，不改游戏仓）

现状（实测，纠正一处旧记忆）：客户端**没有** `tools/ws-url.mjs` 这个文件。
让虚拟 IP 直接可用的是 `shell/picker-core.js:139` 起的设计 ——
无 scheme 的地址会 **ws:// 与 wss:// 双探针**（`:184-185` 互为反向）。
即：**M1 的「能连」部分今天就能用，玩家手填 `10.126.126.1:5150` 即可。**

要改的只有「不够傻瓜」的部分，最小集：

1. `shell/picker.js` / `picker-core.js`：`BUILTIN_SERVERS` 之外，
   加一张「虚拟局域网」说明卡（EasyTier 下载地址、一键加入步骤、我们的分享链接与二维码）。
   链接**不放常量**，跟 `feat/server-list` 的 `/servers.json` 同思路做成可下发，
   否则改一次网络密码就要重发客户端。
2. 预填 `10.126.126.1:5150`（官方服虚拟地址）到「添加服务器」的 placeholder 或列表首行。

自开服发现（M1.5，本期不做）：MVP 靠群里贴 `10.126.126.x`；
进阶走官方服 `GET /servers.json`（`feat/server-list` 分支已实现，契约见
客户端仓 `docs/SERVER-LIST.md`）或壳在 TUN 上做 LAN 广播发现。
**先让 M1 跑起来再接 M1.5**，不要在没流量前先建目录。

## 6. 带宽与资源账

| 场景 | 谁出流量 | 增量 |
|---|---|---|
| 官方服（玩家经虚拟 LAN 连） | 我们 | 每包多一层封装+加密（~60-100 B/包），无省 |
| 玩家自开服，打洞成功 | **不经过我们** | 0 |
| 玩家自开服，打洞失败 | 我们（中继） | ≤ 256 KB/s 硬闸 |
| rendezvous 控制面 | 我们 | KB/s 级 |

服务器内存增量预估：EasyTier Rust 进程约 20-40 MB 常驻（对照 sing-box 19 MB）。
在 available 719 MB、swap 已重的情况下**可接受但不宽裕** —— 再叠东西前先看
`free -m`，dockerd 全家（约 400 MB）是更大的清理对象。

## 7. 上线步骤与验收

```bash
# 1) 部署（用户确认后）
systemctl daemon-reload && systemctl enable --now easytier-lan.service
systemctl enable --now easytier-lan-bridge.service
easytier-cli node                       # 应看到 10.126.126.1 / Local
easytier-cli peer                       # 分享链接自连测试后应出现自己的第二条链路

# 2) 端到端（在虚拟 LAN 内的另一台机器上）
#    导入分享链接 → 连接 → ping 10.126.126.1
#    打开客户端选服页 → 填 10.126.126.1:5150 → 应能进房
curl -s http://10.126.126.1:5150/healthz   # 服务器本体验证桥通了

# 3) 带宽兜底验证（可选但建议）
#    人为让两个打不通的节点互连，观察 eth0 TX 不超过 ~262 KB/s + 基线
```

## 8. 回滚

```bash
systemctl disable --now easytier-lan-bridge easytier-lan
apt-get remove -y socat && rm -rf /etc/easytier /usr/local/bin/easytier-*
```

游戏服、pingap、游戏仓、客户端仓全程零改动 —— 回滚是纯粹的减法。
**本方案不重启任何线上服务**；唯一重启过的是新加的 easytier 两个单元自己。

## 9. 待定 / 风险

1. **安全组不放行则全盘不成立**（§4）——唯一硬阻塞。
2. 网络密码随分享链接分发 = 谁拿到谁进网。可接受（等同房间密码），
   要更严可用 `--secure-mode` + `--credential` 临时凭据，但那是 per-player 管理，M1 不做。
3. UDP 打洞在校园网/运营商 NAT 下的成功率未实测（本机 Clash TUN 会干扰，测了也不算）。
   上线后以 `easytier-cli peer` 的 `tunnel_proto`/`cost` 列为观测点，实在差再开 TCP 兜底。
4. `--foreign-relay-bps-limit 262144` 是按「出口剩 ~1 Mbps」拍的，接入量上来后要重估。
