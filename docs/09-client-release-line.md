# 09 · 客户端发布线（payload → Release → CI → 产物核对）

服务器侧要记住的事实，全部可命令复核；打包细节在客户端仓库 `AGENTS.md`。

## 链条（顺序不能换）

1. **payload 在有机器的素材那份 checkout 上生成**（素材不在 git 里，且我们的素材比上游 fetch 列表多 17 个文件：
   boss 骨架 / token 皮肤 / 盟约图标）。`node tools/package-client.mjs --server sp.lain42.top --game <checkout> --out <dir>`
   → 里面 `build.json` 会记 `game.app / commit / describe / dirty`。
2. **payload 的 `data/assets.json` 必须是相对清单**。线上那份被改写成 OSS 绝对地址（见 `08-resource-split-audit.md`），
   一旦进 payload，exe/apk 就绑死 OSS、离线白屏。核对：产物内 `dl.lain42.top` 计数 == 0。
3. tar 成 `./index.html` 布局（不是 `www/...` 包一层），发布到 **客户端仓库的 GitHub Release 资产**
   （draft 的资产匿名访问 403，CI 拉不到）。
4. `gh workflow run build-clients.yml -f payload_url=... -f expect_app=<版本>` —— 出 Windows 目录版 + Android debug APK。
   **exe/apk 一律在 Actions 里编，不本机编译。**

## 闸门与踩过的坑

CI 现在一共**五道**闸门（两个 job 各跑一遍），顺序就是防御顺序：

| # | 步骤名 | 查什么 | 红过一次吗 |
|---|---|---|---|
| 1 | `校验 payload 完整性` | 四个必需文件在不在、素材数 >3000 | — |
| 2 | `校验 payload 版本（闸门）` | `build.json.game.app` 对 `expect_app`（或本仓库 `version`）+ `server` 输入 | run #4 就是死在这（payload 停在 0.1.1） |
| 2b | `payload 出处（闸门）`（`tools/check-payload-provenance.mjs`） | `build.json.game.dirty` 必须是 `false`，且 `describe` 末尾要有 `-g<7+ 位 hex>` | **今天新增，起因是实测不是回归**：默认 `payload_url` 那份（OSS，15:40:49 CST 被换过，195,809,375 B）里 `describe="v0.1.3-dirty"`、`dirty:true`，版本闸门与离线闸门都会放行它 —— 没有这道闸门，CI 会绿着发一个追不到 commit 的 exe/apk |
| 3 | `零外部依赖（闸门）` | **暂存 payload**：任何**站外引用形式**（href/src/url()/fetch/@import/`new WebSocket('http…')`）/ CDN 绝对地址 / 字体镜像完整性 | run `37270463759`（故意用旧 payload 跑的）两个 job 都红在这一步 |
| 4 | `零外部依赖（产物内，闸门）` | **出厂字节**：桌面扫 `resources/www`，APK 用 `--zip` 按条目扫 | 本地对已发布的旧 exe/APK 跑是红的；新产物还没经 CI 出过 |

第 4 道为什么要存在（两条实测）：桌面 `app.asar` 只有 29,619 B（游戏 www 在它旁边），
而 APK 的 `assets/public/**` 是 deflate 条目 —— **整包 grep 字体主机 0 命中，解开条目才有 2 次**。

- `build-clients.yml` 里"校验 payload 完整性"只 `cat build.json`、**从不比对版本**，所以仓库标 0.1.2 时产物静默
  发布了 0.1.1（run #2/#3 都是）。现在加了 `expect_app` 闸门：留空则要求 payload `game.app` == 本仓库 `version`，
  顺带校验 `build.json.server` == `server` 输入。实测 run #4 精确死在这一步、run #9 显式放行后成功。
- **Actions artifact 只保 7 天**，长期分发靠 Release；`gh run download` 必须在仓库目录里或带 `--repo`。
- `gh run watch` 的 shell 退出码不等于 run 的结论（末尾若接 `tail`，退出码是 tail 的）—— 结论一律用
  `gh run view --json conclusion`，产物一律下载拆开验（asar 里 `resolveMediaPath`、payload 里 `serverKey`、
  APK 里 `__SP_MEDIA_ALIAS__ = false`、GitHub 的 asset `digest` == 本机 `sha256sum`）。

## 跨版本兼容（服务器与客户端不同版本时会发生什么）

- `PROTOCOL_VERSION` 0.1.1 与 0.1.3 **都是 1**，socket 上也不回传版本 → 老服务器不会拒绝新客户端。
- 新动词打到老服务器：`shared/protocol.js`/`server/net.js:588` 回 `BAD_MSG` + **`unknown type <verb>`**
  （`server/lobby.js:296` 那句 `unhandled type` 只有"表里有、switch 没接"才走得到）。
- 唯一可用版本信号是 `GET /healthz` 的 `app`（我们这台靠 pingap 的 `sp_healthz_cors` 才可跨源读；自建服没开 CORS 时
  读不到 → 客户端必须乐观放行，不能锁功能）。实测矩阵与已发布产物见客户端仓库 Release `v0.1.3-compat`。

## 服务器侧现状（2026-10-05 14:20 之后）

线上 `/healthz.app` 已经是 **0.1.3**（`stronghold` 14:20:24、14:26:09，15:33:25 CST 又重启过一次），
但**别把版本号当能力** —— 这条同一天实测到两个相反答案，所以只能现跑，不能引用文档：
- 15:09：线级探测 `room.spectate` / `room.kick` / `room.removeSpectator` 三个全部回 `BAD_MSG unknown type`，
  `room.join` 回业务级 `ROOM_NOT_FOUND`。那次部署是覆盖式的混合体：`server/` 上了 0.1.3，
  `shared/protocol.js` 还是 0.1.1，而 `server/net.js:587` 判类型只看后者那张表。
  客户端因此会点亮入口 → 玩家点一次报错 → 才被动学会灰掉。
- 15:59（15:33 那次重启之后，同一条命令）：**四个全部 `handled`，rc=0**，正控制那个自造动词仍 `unknown`。
  也就是说生产现在不再有"点一次才灰"的现象，那条被动学习路径留给更老的自建服与分叉。
  ⚠️ 复测时请注意 `probe-server-capability.mjs` 改过：正控制不再计入"缺失能力"（改之前每次运行都固定报"缺 1 个"）。
复现与机制在 **`docs/12-prod-0.1.3-overlay.md` §5**（含线上 `shared/protocol.js` 比任何 git 树多一条手写 `hello.z` 那段），
换基线后的整套核对在 **`docs/13-upgrade-drift-checklist.md`**。
同一次部署还把 `public/index.html` 换回上游那份（`dl.lain42.top` 命中 0、Google 字体外链回来了）；
素材清单没受影响（4506 条 OSS）。

下一轮服务器侧要做的（都需要窗口/点头）：在新 0.1.3 上重做"前端指向 OSS"（`scripts/build-oss-app.py` + 并行
`index-oss.html` 验证，`public/index.html` 是热文件）、把字体镜像带上（fork 分支 `86719d1`）、把部署收成可切的
commit，以及开 pingap 的按路径访问日志（`docs/08` 的测量缺口）。

> 规则 3 后来从"禁两个字体主机字面量"扩成"禁一切站外引用形式"（客户端仓库 `check-payload-offline.mjs`）。
> 判的是**引用形式**而不是裸 URL：payload-c10 的 727 个文本文件里有 27 处 wikipedia、19 处 github.com、
> 17 处 `xmlns="http://www.w3.org/2000/svg"` —— 全在注释或标识符里，不构成请求，实测引用形式命中 **0**。
> 别去"修"那些注释链接，那是噪音；要盯的是新增的 `src=`/`href=`/`fetch(`。
