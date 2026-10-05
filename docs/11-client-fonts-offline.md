# 11 · 客户端字体离线化（源头已改，产物待发布）

目标：网页版与打包客户端都不再依赖第三方字体主机，**且观感不变**。

## 1. 为什么以前的测量误导过一次

不带 UA 请求 `css2` 拿到的是**未切片**的老格式：**11 个 woff2 / 43.3 MB** —— 据此会得出"自托管太大，只能裁剪字符集"。
带 Chrome UA（`Chrome/126.0.0.0`）拿到的是真正给浏览器的东西：**421 个 @font-face / 112 个 woff2 / 4.84 MB**。
4.84 MB 放进 293 MB 的 payload 里毫无压力，于是决策从"裁剪"变成"**逐字节镜像**"。

结论要落在这条命令上，别凭记忆：
```
curl -s -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' \
  'https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700;900&family=Oxanium:wght@400;500;600;700&family=Rajdhani:wght@500;600;700&display=swap' \
  | grep -c '@font-face'
```

## 2. 做法（游戏 fork 分支 `feat/net-cross-version-capability`）

- `tools/fetch-webfonts.mjs`：按 Chrome UA 取 `css2`，把每个 `url()` 落到 `public/webfonts/google/<派生名>`，
  并生成同样 `unicode-range` / `font-display: swap` 的本地表 `google.css`。派生名 = `<家族-版本>-<原名末段>-<sha1(pathname) 前 8 位>.woff2`。
- `public/webfonts/google/` 112 个 woff2 + `google.css` 全部**入库**（不再是要现抓的外部资源）。
- `public/index.html` 与 `public/dev/uikit.html` 都改成
  `<link rel="stylesheet" media="print" onload="this.media='all'" href="/webfonts/google/google.css" />`，
  两个 preconnect 和 css2 外链删除；`server/index.js` 的 `LONG_CACHE_DIRS` 加上 `webfonts`。
- 提交：`5aa4405`（镜像 + index.html）、`75fb8eb`（`--verify-bytes`）、`86719d1`（dev/uikit + 全树检查）。

## 3. "同一套字形"是怎么证的（不是"看着差不多"）

| 层次 | 检查 | 实测 |
|---|---|---|
| 字节 | `node tools/fetch-webfonts.mjs --check --verify-bytes` | **112/112 的 sha256 与 Google 当前提供的一致** |
| 闸门可证伪 | 给某个镜像文件尾部加一个 `x` 再跑 | rc=1，点名该文件与两侧摘要（`remote cf5346b0… vs mirror c105b896…`） |
| 源码 | 游戏仓库 `test/webfonts-local.test.js`（5 项）+ `test/client-static.test.js`（215 项） | 全绿；把外链加回 `dev/uikit.html` → 5 项里 1 项红并点名文件 |
| 产物 | 客户端仓库 `tools/check-payload-offline.mjs` | payload-c8：727 个文本文件、112 woff2、112 引用，**0 问题** |
| 真机浏览器 | 本地静态服务 + Chromium 驱动，看网络与字形 | 对 `fonts.googleapis`/`gstatic` 的请求 **0 条**；21 个字体请求全部来自 `127.0.0.1`；`google.css` 载入 421 条规则；`document.fonts` 424 个 face 已加载；Rajdhani 与回退字体度量不同（649.09 vs 755.98），说明镜像真的在用 |
| 旧产物对照 | 同一闸门跑 `www-c5` / `www-compat` | **红**：`index.html`、`dev/uikit.html` 命中外部字体主机 + 缺镜像表 —— 所以旧 exe/apk 确实带着外链出门 |

payload 里唯一剩下的外部请求是 `https://sp.lain42.top/healthz`（自己服务器的版本探测），这是设计行为，不是字体依赖。

## 5. 闸门在 CI 里真的会咬（run #11，故意让它红）

用**已发布的旧 payload** `payload-v0.1.3-c5`（`sp-payload-c5.tar.gz`，213,917,927 B，`expect_app=0.1.3`）跑了一次
`build-clients.yml`：run `37270463759` 结论 **failure**，两个 job 都恰好死在 `零外部依赖（闸门）`，之后没有跑
`npm install`/打包（闸门放在装依赖之前，所以这次验证几乎不花分钟）。CI 原日志：

```
payload 离线闸门：扫描 726 个文本文件，woff2 镜像 0 个，字体表引用 0 个
  ✗ index.html 引用外部字体主机 fonts.googleapis.com
  ✗ dev/uikit.html 引用外部字体主机 fonts.googleapis.com
  ✗ 缺自托管字体表 webfonts/google/google.css —— 镜像没进 payload？
```

同一份检查在换成本机 `payload-c8` 时是绿的（727 个文本文件、112 woff2、0 问题）—— 红/绿两边都有实测，
闸门不是摆设。**换 payload 之后要重跑一次**，红在这一步就说明产物里还没进镜像。

## 6. 网页版还没受益（要随 0.1.3 升级一起走）

`curl -s https://sp.lain42.top/index.html` 实测仍有 **2 次 `fonts.googleapis.com` + 1 次 `fonts.gstatic.com`**
（外加自托管的 `/fonts/fonts.css`）—— 因为线上跑的是 `/opt/Stronghold-Protocol` 那份 **0.1.1** checkout，
而镜像在 fork 分支上。线上 `public/index.html` 是热文件（此刻还有 246 人 / 177 场），
**不能**用直接编辑它的方式铺字体；只能随 0.1.3 升级在低峰窗口整份换 checkout，一并带上字体镜像。

## 4. 还没做的一步（要人点头）

源头与产物闸门都已就位，但**已发布的 exe/apk 仍是旧 payload**。要出带镜像字体的新产物：

```
# payload 已在本机备好（不要覆盖已发布资产，一律新 tag / 新文件名）
D:/Code/_artifacts/sp-client-payload-0.1.3-c8.tar.gz
  218,916,336 B  sha256 d31f7d3c8f8b357f9d285d843dd20b694cd37a9b66ac70d3a3911ae7996caa04
  build.json: game.app=0.1.3, describe=v0.1.3-8-g86719d1, protocol=1

gh release create payload-v0.1.3-c8 --draft=false --title 'payload v0.1.3-c8（字体镜像）' \
  D:/Code/_artifacts/sp-client-payload-0.1.3-c8.tar.gz
gh workflow run build-clients.yml -R lilyco-42/StrongholdProtocolClient \
  -f payload_url='https://github.com/lilyco-42/StrongholdProtocolClient/releases/download/payload-v0.1.3-c8/sp-client-payload-0.1.3-c8.tar.gz' \
  -f server=sp.lain42.top -f expect_app=0.1.3
```

draft 的 Release 资产匿名访问是 403，CI 拉不到 —— 建完要么直接非 draft，要么记得 `gh release edit --draft=false`。
跑完照旧：结论看 `gh run view --json conclusion`，产物**下载拆开**验 `webfonts/google/google.css` 在 asar/APK 里、
`fonts.googleapis` 计数为 0、`resolveMediaPath`（桌面）、`__SP_MEDIA_ALIAS__ = false`（安卓）。

上线口径（`/opt/Stronghold-Protocol`）也顺带说明：那份是热文件，网页玩家直接命中，**不能**用编辑线上文件的方式
铺字体镜像 —— 要么随 0.1.3 升级一起在低峰窗口换 checkout，要么先只在客户端线上用。
