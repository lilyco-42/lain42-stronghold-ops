# 08 · 资源分离审计：谁在服务什么（2026-10-05，全程只读）

问题：客户端/服务器的资源是否分离，服务器还剩多少负载可以卸载。
方法：读 `server/index.js` 挂载表、`data/assets.json` 清单前缀、`/etc/pingap.toml`、`/proc/net/dev` 采样、
OSS 与本机分别 HEAD，**没有**重启/改任何线上文件。线上当时 196 人 / 146 场，`NRestarts=0`。

## 1. 一句话结论

**素材层面已经彻底分离**：清单里 **4451 条值是 `dl.lain42.top/.../site/` 绝对地址**，同源只剩 8 条；
`dl.lain42.top` 解析到 **47.101.28.199（AliyunOSS）**，而服务器是 **8.153.102.122** —— 也就是美术/音频
**根本不走这台机器的网卡**。服务器现在只剩四件事：**`/ws` 状态同步、`index.html`、`/data/*.json`、`/sim/*.js`**。

eth0 实测 TX ≈ 68–70 KB/s（约 0.55 Mbps / 上限 3 Mbps），2697 条 TCP 里 pingap:443 占 2164、node:5150 占 286。

## 2. 服务器仍在发的东西（按可卸载性排序）

| 项 | 体量 | 状态 | 卸载价值 |
|---|---|---|---|
| `/ws` 对局状态 | 出口的主体（运维文档估 ~76%） | 有状态，**不可搬走** | 只能靠协议：deflate 已上线、增量编码 −58% |
| `/data/*.json` | 4.4 MB/次加载，`assets.json` 单文件 889,978 B，**no-cache** | pingap 已做 gzip6/br5 | 中：可指到 OSS，但 `/sim` 与 runner 假设同源，动它风险高 |
| `/sim/*.js` | 1.9 MB | 必须留在服务器（文档 03 坑 2：根路径钳制） | 低收益高风险 |
| `index.html` | 48 行改动的那份（OSS 开关版） | 必须由 node 发，否则 `/data`、`/sim`、`/ws` 的源就不对 | 不动 |
| 美术/音频/spine/字体/vendor | 260 MB 素材 | **已在 OSS**，且 spine 预 gzip（`.skel` 总 87,869,136 B；OSS 响应带 `Content-Encoding: gzip`，抽样 −71%/−84%/−83%） | 已完成 |

`/media/*` 那条无扩展名音频路由（`index.js:318-320 → serveMedia`，Range 支持、mp3 不 gzip）
对**网页玩家其实是死代码**：清单里音频是 OSS 绝对地址，`public/js/media.js:37-38` 对跨源地址原样返回，
所以浏览器直接找 OSS。它真正服务的是**相对清单**的场景 —— 也就是打包客户端（桌面壳自己解析；安卓已关别名走直连）。
BGM 单文件实测 1,138,773 B（`m_sys_act1autochess_intro` / `_loop`）。

Node 侧 gzip 缓存（`GzipCache`，`index.js:128-163`）：首次命中才压，单文件上限 8 MB、总 LRU 96 MB ——
现在只对 data/sim/html/js 生效，美术的 gzip 是 OSS 的活。

## 3. 打包客户端 = 最彻底的那次分离

干净 checkout（`/opt/sp-game-src`，detached HEAD）里 `data/assets.json` 是 **0 条 OSS / 4452 条相对**，
`index.html` 也 0 条 OSS —— 所以 payload 打进 exe/apk 的 288 MB 素材**不引 OSS、也不引 node**，
装机玩家对服务器只剩 `ws` + `/healthz`。

⚠️ 因此有条硬规则：**线上那份被改写成 OSS 绝对地址的 `data/assets.json` 绝不能进 payload**，
否则客户端会绑死 OSS、离线就白屏（这条已在客户端仓库 `AGENTS.md` §3/§8 落成核对项：
产物内 `resources/www/data/assets.json` 的 `dl.lain42.top` 计数必须是 0）。

## 4. 文档与现实的偏差（要改文档）

- `03-static-to-oss.md` 说只搬了 `js css vendor fonts shared`、`/assets` 仍由 node 发 —— **已过时**：
  实际后续改动把**整张美术清单（含音频、spine）都指向了 OSS**（4451 条 `…/site/`）。
- `07`（spine gzip 已上线）**与现实一致**（OSS 响应头 + 抽样压缩比都对得上）。
- OSS 上存在与 node 完全相同的 `app/index.html`（ETag == node 的 md5），但 HTML 必须继续由 node 发 —— 别被
  "OSS 有副本"误导成可以把入口也搬走。

## 5. 不可测 / 缺口

- pingap **没开按路径的访问日志**，所以"每类资源各占多少字节"只能靠协议推算，不能直接测量；
- 流量采样窗口只有 ~15 s，且 WS 与静态的占比是推断（沿用文档 03 的 76% 估计），不是实测；
- 结论里凡是"WS 占大头"都应视为**推断**，其余（清单前缀、OSS 解析地址、文件体量、压缩比、socket 计数）是实测。

> **2026-10-05 14:20 之后重测**（见 `docs/12`）：清单仍是彻底分离的 —— **4506 条 OSS / 1 条相对**（本文的 4451 是当时的数），
> 但 `public/index.html` 里 `dl.lain42.top` 命中变成 **0**：覆盖式升级把前端那一层换回了上游版。
> eth0 TX 实测 **567 KB/s**（3 Mbps ≈ 375 KB/s）。
> ⚠️ 方法学修正：本文用 `grep -c` 报的"条数"其实是**行数** —— `data/assets.json` 是单行 JSON，数出现次数要走 JSON 结构
> （正确写法在 `docs/12` 第 3 节）。方向不变，数字口径以 `docs/12` 为准。

