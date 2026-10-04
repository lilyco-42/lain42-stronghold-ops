# lain42 · 卫戍协议 运维改动集

对上游 [`sganggs/Stronghold-Protocol`](https://github.com/sganggs/Stronghold-Protocol) 的**最小改动集**，
用于在**低配 ECS**（2 核 / 1.6 GB / **出口仅 3 Mbps**）上跑起 400+ 并发的实时对局。

> **这不是游戏的 fork。** 这里只放「相对上游改了哪几行、为什么改」——
> 补丁、配置片段、脚本、以及实测数据。上游继续一天十几个 commit，这里的补丁
> 按需重新生成即可。

## 为什么需要这些改动

一句话：**3 Mbps 的出口，撑不住 400 人的实时对局。**

按因果顺序，问题是这样一条链：

```
① systemd 默认软 FD 限额 1024（全机服务都中招）
     → pingap 代理 300+ WebSocket 长连接时 FD 耗尽（1021/1024）
     → pingap 连健康检查都开不了 socket → 上游被标记 down
     → 全站 503，且自身无法恢复（健康检查也需要 FD）
     → 客户端疯狂重连 → 更多 FD → 死循环

② 出口带宽只有 3 Mbps（稳态），而游戏状态流占 76%
     → 压缩前每玩家 1570 B/s → 只能撑约 225 人

③ 890 KB 的 data/assets.json 走服务器出口
     → 被挤到 81 KB/s → 要下 10.9 秒
     → 前端写死 4 秒超时 → 3D 棋盘必然降级成 2D

④ 上游资源集缺 17 个文件（boss 骨架等）
     → boss 渲染成菱形占位符

⑤ 静态资源（js/css/vendor/fonts/shared）全从服务器出
     → 占掉出口的一大块
```

## 改动总览

| # | 改动 | 位置 | 类型 | 实测收益 |
|---|---|---|---|---|
| 1 | **系统级 FD 限额** | `/etc/systemd/system.conf` | 配置 | 全站 503 → 200（**根因**） |
| 2 | pingap FD 双保险 | `pingap.service.d/nofile.conf` | 配置 | — |
| 3 | OOM 保护 | `{stronghold,pingap,redis}.service.d/oom-protect.conf` | 配置 | 真 OOM 时不会杀掉游戏 |
| 4 | **WebSocket 压缩** | `server/index.js` | **代码** | 每玩家 **1570 → 450 B/s（−71%）** |
| 5 | `/data` 压缩路由 | `/etc/pingap.toml` | 配置 | `assets.json` 10.87s → 0.02s |
| 6 | `/sim` CORS 路由 | `/etc/pingap.toml` | 配置 | 前端搬 OSS 后 sim 仍可跨域导入 |
| 7 | **静态资源搬 OSS** | `public/index.html` + 4 个 JS/CSS | **代码** | 服务器静态请求 **−99.8%** |
| 8 | 素材清单指向 CDN | `data/assets.json` + `tools/` | **代码** | 素材不再走服务器出口 |
| 9 | `validSpine` 接受 http URL | `public/js/assets.js` | **代码** | 否则 spine 全部被拒 → 退化成菱形 |
| 10 | 补 17 个缺失素材 | `public/assets/**` | 数据 | boss 从菱形占位符 → 正常渲染 |
| 11 | 表情素材 + 清单 | `public/assets/local/**` + `data/local-assets.json` | 数据 | 交流面板从空框 → 6 套官方表情 |
| 12 | **自愈 watchdog** | `sp-watchdog.{sh,service,timer}` | 服务 | FD 自动提升 / 熔断自动复位 |

## 端到端效果

| 指标 | 改动前 | 改动后 |
|---|---|---|
| **每玩家流量** | 1570 B/s | **450 B/s（−71%）** |
| **出口带宽**（418 人） | ~656 KB/s | **183 KB/s** |
| 距 3 Mbps 稳态上限 | **175% 超载** | **49%（有余量）** |
| **3 Mbps 能承载的玩家数** | 约 225 人 | **约 850 人（3.8×）** |
| 静态请求打到服务器 | 577 / 15s | **1 / 12s（−99.8%）** |
| pingap FD | 1021 / 1024 ❌ | 1364 / 524288 ✅ |
| 服务器 CPU | 见下方说明 | **36% of one core**（= 整机 18%） |

> **关于 CPU**：一度以为 CPU 从 9.9% 涨到 40% 是压缩的代价 —— **那是错的**。
> 用 CPU profile 实测（`docs/04-measurements.md`）：**压缩只占 1.1% 的 CPU**，
> 真正的大头是**游戏模拟 60.6% + 对局逻辑 18.9%**。CPU 随**并发对局数**变化，
> 与压缩无关。详见 `docs/04-measurements.md` 的「CPU 归因」一节。

## 目录

```
patches/
  game/                    对游戏仓库的补丁（git diff 可直接 apply）
    01-ws-compression.patch        server/index.js —— WS 压缩
    02-spine-accept-http-url.patch public/js/assets.js —— 接受 CDN 绝对 URL
    03-frontend-to-oss.patch       public/index.html —— 前端资源指向 OSS
    04-asset-manifest-cdn.patch    data/assets.json + tools/ —— 素材指向 CDN
  pingap/
    locations-and-plugins.toml     要加进 /etc/pingap.toml 的片段
  systemd/
    README.md                      根因详解（FD 限额）
    *.conf                         可直接放到 /etc/systemd/system/*.service.d/

scripts/
  build-oss-app.py           生成「指向 OSS 的前端副本」（含逃逸路径校验）
  patch-pingap-sim-cors.py   给 pingap 加 /sim CORS location（幂等 + 校验 + 回滚）
  patch-sp-data-compress.py  给 pingap 加 /data 压缩 location
  fix-missing-spine.py       从上游仓库补 17 个缺失素材
  apply-oss-assets.mjs       把素材清单改写成 CDN 绝对 URL
  deploy.sh                  部署脚本（含步骤 2b：恢复 local 素材，防重部署丢失）
  sp-watchdog.sh + .service + .timer          自愈：FD / 熔断 / 内存 / tmpfs
  sp-apply-ws-compress.sh + .service + .timer 等没人在线时自动开 WS 压缩
  prof-stronghold.mjs / analyze-prof.mjs / close-inspector.mjs
                            给运行中的 Node 做 CPU profile（kill -USR1，不重启）
  cpu-measure.sh / status-report.sh           只读体检

docs/
  01-fd-exhaustion.md        事故复盘：503 的完整因果链
  02-ws-compression.md       压缩选型与实测（含 CPU 代价分析）
  03-static-to-oss.md        静态搬迁：三个必踩的坑
  04-measurements.md         编码 / 协议 / 语言的本地基准测试
  05-missing-assets.md       补齐上游缺失素材（含上游来源映射表）
```

## 部署顺序（重要）

```
1. systemd 侧（不用重启业务）
   - /etc/systemd/system.conf: DefaultLimitNOFILE=65535:524288
   - systemctl daemon-reexec
   - drop-ins → systemctl daemon-reload
   - 对运行中的 pingap 立即生效：prlimit --pid $(pgrep -x pingap) --nofile=524288:524288

2. pingap 侧（autoreload 自动生效，不用重启）
   - 加 locations/plugins → pingap -c /etc/pingap.toml -t 校验 → touch 触发加载
   ⚠️ 新 location 必须排在 "sp"（path="/"）之前

3. 静态资源搬 OSS（零风险流程）
   - python3 build-oss-app.py            → 生成 /opt/sp-oss-build + index-oss.html
   - 上传到 OSS
   - 用 https://sp.lain42.top/index-oss.html **并行测试**（玩家不受影响）
   - 确认无误再 cp index-oss.html index.html

4. WS 压缩（⚠️ 要重启 stronghold）
   - ⚠️ 对局状态只在内存里，重启会丢掉所有进行中的对局
   - sp-apply-ws-compress.sh 默认只在「后端连接数 = 0」时才动手
   - 强制执行：sp-apply-ws-compress.sh --force
```

## 回滚

| 改动 | 回滚 |
|---|---|
| WS 压缩 | `cp server/index.js.bak-pre-ws-compress server/index.js && systemctl restart stronghold` |
| 前端搬 OSS | `cp public/index.html.bak-pre-oss-<日期> public/index.html` |
| FD 限额 | `cp /etc/systemd/system.conf.bak-<日期> /etc/systemd/system.conf && systemctl daemon-reexec` |
| pingap 配置 | `cp /etc/pingap.toml.bak-sp-sim /etc/pingap.toml`（autoreload 自动加载） |
| watchdog | `systemctl disable --now sp-watchdog.timer` |

## ⚠️ 几条硬规矩（踩过的）

1. **`LimitNOFILE=` 必须写 `软:硬` 两段** —— 只写一个值只设硬限额，软限额还是 1024。
2. **pingap 不能停** —— 所有 443 流量都过它。「关掉其他服务省资源」时它和 stronghold 必须在白名单。
3. **`/tmp` 是 tmpfs（内存盘）** —— 大文件放 `/var/tmp`，否则吃内存。曾把 842 MB 的盘撑到 94%。
4. **改 pingap 配置前先 `pingap -c /etc/pingap.toml -t`** —— 配置错会让 443 全挂。
5. **`pgrep -f 'pingap -c ...'` 会匹配到自己的 bash** —— 用 `pgrep -x pingap`。
6. **重启 stronghold = 丢掉所有进行中的对局** —— 状态只在内存里，没有落盘。
