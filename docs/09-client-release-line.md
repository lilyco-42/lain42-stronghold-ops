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

线上已经在 **0.1.3**（`/healthz` 的 `app`，`stronghold` 于 14:20:24 CST 重启），所以 0.1.3 客户端的观战/踢人
不再被版本闸门挡住 —— 这是设计内行为。但**这次升级是覆盖式的**：`git log` 还停在 `8b10625`、238 个 `M`、没留备份，
并且 `public/index.html` 回退成上游那份（`dl.lain42.top` 命中 0、Google 字体外链回来了）。
素材清单没受影响（4506 条 OSS）。细节与补救见 **`docs/12-prod-0.1.3-overlay.md`**。

下一轮服务器侧要做的（都需要窗口/点头）：在新 0.1.3 上重做"前端指向 OSS"（`scripts/build-oss-app.py` + 并行
`index-oss.html` 验证，`public/index.html` 是热文件）、把字体镜像带上（fork 分支 `86719d1`）、把部署收成可切的
commit，以及开 pingap 的按路径访问日志（`docs/08` 的测量缺口）。
