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

## 4. 闸门在 CI 里真的会咬（run #11，故意让它红）

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

## 5. 网页版还没受益（要随 0.1.3 升级一起走）

`curl -s https://sp.lain42.top/index.html` 实测仍有 **2 次 `fonts.googleapis.com` + 1 次 `fonts.gstatic.com`**
（外加自托管的 `/fonts/fonts.css`）—— 因为线上那份 `index.html` 是**上游 0.1.3 的文件**：2026-10-05 14:20:24 CST
有一次覆盖式升级把 `public/index.html` 换回了上游版（连同 `dl.lain42.top` 的前端改写一起没了，见 `docs/12`）。
镜像在 fork 分支 `86719d1` 上，不在这份文件里。`public/index.html` 是热文件（重启前 244 人 / 174 场，14:21 实测 13 人 / 6 场），
**不能**用直接编辑它的方式铺字体；按 `docs/12` 第 4 节那条零风险路径走（生成 OSS 版 → 并行页验证 → 再覆盖）。

## 5b. 2026-10-05 17:04 对 **c10** 重做了一遍真浏览器测量（含一条要写清的局限）

之前那一行是拿 c6 时代解包目录 + 一次性探针做的，这次直接对**待发布的那份 payload** 重跑。宿主与样张现在是仓库里的脚本，
不再是一段没法复制的省略号：

```
cd D:/Code/lain42-stronghold-ops
node scripts/offline-font-lane.mjs D:/Code/_artifacts/payload-c10 47924
# 打开 http://127.0.0.1:47924/lane.html  —— 页面只引镜像样式表，不加载游戏 JS，全程不碰生产
# 控制台里 window.__lane() 直接返回 face/loaded/宽度对照
```

脚本自带的自校验：`<payload>/webfonts/google/google.css` 不在就直接 rc=2 报错（否则会对着一个没镜像的目录量"0 外链"，
那种 0 是假的）。17:06 用它起壳再验一遍：`lane=200 / sheet=200 text/css / slice=200 font/woff2`。

实测（Chromium 网络面板 + `document.fonts`）：
- `google.css` → 200 `text/css` **455,869 B**；切片 → 200 `font/woff2`。
- 字体相关请求**共 10 条，全部指向 `127.0.0.1:47923`**；对 `fonts.googleapis.com` / `fonts.gstatic.com` **0 条**。
- 样式表里注册 **421** 个 face，本次实际 `loaded` **17** 个（16 个 Noto Sans SC 切片 + 1 个 Rajdhani）——
  这正是 unicode-range 分片按需取的行为，和从 Google 取是一样的。
- **Rajdhani 与回退字体度量不同**：同一行拉丁文本 `649.16` vs `771.91` px → 镜像确实在用，不是回落。
- ⚠️ **中文不能用宽度来证**：`卫戍协议盟约 · 中文正文样本 1234` 镜像与回退宽度**完全相等（1026.63 / 1026.63，隔离样本 384 / 384）**，
  因为中日韩字形在近似的 1 em 步进下宽度本来就一致 —— **宽度相等不等于没用镜像**。中文这一侧的证据链是：
  ①那 16 个 Noto Sans SC 切片真的被抓取并 `loaded`（且只来自本机端口），②切片与 Google 当前字节 **112/112 sha256 相同**（`--verify-bytes`，16:28 复测）。
  谁要是想"用宽度差异证明中文生效"，会得到一个假阴性。

## 6. 两个宿主各自怎么验的（换 payload 后照抄这张表）

> **2026-10-05 更新：这张表里"纯静态等价道"和"桌面壳发镜像"两条已经从一次性探针变成仓库里的测试**，
> 不用再依赖没人能重跑的脚本 —— 客户端仓库 `test/packaging.test.js`：
> `the weakest host model still serves the mirror: plain static, no alias, no rewrite (Capacitor does exactly this)`
> 钉住"别名在纯静态下必然 404 / 真地址 200 / 镜像表 200 且 `text/css`、切片 `font/woff2` / 缺失切片 404 作正控制"，
> 并且扫**真的** `google.css`：实测 **112 个 `url()`，非根绝对路径 0 个**（相对引用的话，嵌套页面就会去要
> `/dev/webfonts/…`，纯静态宿主按原样发，直接 404 落回系统字体）。
> `the shell serves the mirrored font sheet the way a font host does (mime + long cache, and no escape)`
> 钉住 `LONG_CACHE_DIRS` 里必须有 `webfonts`、css/woff2 的 mime、`index.html` **不得**继承长缓存（正控制，
> 防止"全都长缓存"也能让前四条全绿），以及 `/webfonts/google/../../../../../../windows/win.ini` 必须非 200。
> 本机整跑 **75/75**（2026-10-05 16:53 CST；16:21 那次是 74，之后又加了 `payload 出处` 那道闸门的测试）。
> **网页版那一侧也补上了**（游戏仓库 `test/webfonts-serve.test.js`，16:30）：直接对 `server/index.js` 的
> `createStaticHandler` 起服务，钉住 `/webfonts/google/google.css` → 200 / `text/css` / `max-age=86400` / 455,869 B /
> 含 `font-display: swap` / 无远程地址；切片 → 200 / `font/woff2` / magic `wOF2`（HEAD 也 200）；
> 正控制是 `index.html` 与 `js/net.js` **不得**继承长缓存；三条点路径探测（含 `%2e` 编码那两种）实测一律 **403**，缺切片 404。
> 变异复验同样做过：把 `webfonts` 从 `LONG_CACHE_DIRS` 删掉 → 4 项里 2 项红，第一条直接点名"表每次都重取是回归"。
> ⚠️ 下表里剩下的**真 Chromium 看网络**那一列仍是手工测量（没有提交探针），换 payload 之后要照着第三列重跑一遍。

| 宿主 | 这条怎么测 | 实测 |
|---|---|---|
| 打包桌面（Electron 自带文件服务器） | 用 `desktop/serve.mjs` 的 `createStaticServer({ root: payload })` 起真实壳，再请求镜像 | `/webfonts/google/google.css` → **200 / `text/css` / `public, max-age=86400`**，421 个 `@font-face`、远程主机引用 **0**；`.woff2` → **200 / `font/woff2`**、magic `wOF2`；`index.html` → `no-cache`；不存在的音轨 → 404（没有把 404 伪装成 200） |
| 打包安卓（Capacitor 纯静态 `www/`） | Capacitor 就是把 `www/` 按根目录静态发出去，所以用**没有别名的纯静态服务**当等价lane（当初 `/media` 那个坑也是这么抓出来的），在真 Chromium 里看网络 | 对 `fonts.googleapis` / `fonts.gstatic` **0 请求**；21 个字体请求全部来自 `127.0.0.1`；`document.fonts` 424 face 已加载；Rajdhani 与回退字体度量不同（649.09 vs 755.98 px），说明镜像确实在用而不是回退 |
| 网页版（生产） | `curl -s https://sp.lain42.top/index.html` 数外链 | **2 次 `fonts.googleapis.com` + 1 次 `fonts.gstatic.com`**（14:20 覆盖式升级换上的是上游 `index.html`，见 `docs/12`） |
| 升级后的 node 服务（本机 fork 分支实跑，不碰生产） | `PORT=5399 HOST=127.0.0.1 SP_NO_BROWSER=1 node server/index.js` 起一份，逐项 curl | `/healthz` 报 **`app:"0.1.3"`**；发出去的 `index.html` 里 **0 次外链、1 次 `/webfonts/google/google.css`**；`google.css` → 200 / `text/css` / **`public, max-age=86400`** / nosniff，带 `Accept-Encoding` 时 **gzip 455,869 → 129,626 B**；`.woff2` → 200 / `font/woff2`、**不**再 gzip（已压缩过，二次压缩是浪费 CPU）；`/data/assets.json` 200 / `no-cache`（回归没坏）、`/media/bgm/…` 200 / `audio/mpeg` 1,138,773 B（音频别名没坏）；`/webfonts/google/../../../etc/passwd` → **404**（多挂一个长缓存目录没开口子） |

`android` 那条是**等价 lane 而非 APK 实测**——APK 要真机/模拟器才算摸过；这条区分在 `AGENTS.md` 的证据一节里也是硬要求。

## 7. 产物级闸门：还要落在出厂字节上（两处按 grep 会骗人的地方）

| 位置 | 实测 | 结论 |
|---|---|---|
| 桌面产物 | `app.asar` 只有 **29,619 B**（壳代码，`resolveMediaPath` 命中 2 次），游戏那份 www 在旁边的 `resources/www/` | 产物级闸门要指 `build/desktop/win-unpacked/resources/www`；只查 asar 根本看不到 HTML |
| APK 产物 | `assets/public/**` 共 **4255** 条（zip 总 4693 条：stored 3213 / deflate 1480）；**整包 grep `fonts.googleapis.com` = 0 命中**，但解开 `assets/public/index.html` 后同一字符串出现 **2 次** | 必须按 zip 条目解开再查；对 APK 做整包 grep 会一路放行 |

这两条路径不是抄来的，是从打包配置推导并由测试绑住的：桌面的 www 来自 `electron-builder` 的
`extraResources: ../build/client/www -> to: www`（`asar: true` 只装 4 个壳文件），安卓的前缀来自
`capacitor.config.json` 的 `webDir: ../build/client/www`（落进 `assets/public/**`）。
测试里把 `to` 改成 `www2` 会有两项立刻变红（客户端仓库 `test/packaging.test.js`，65/65）。

`tools/check-payload-offline.mjs` 因此支持三种目标（目录 / `--zip`），CI 两个 job 各多一步
`零外部依赖（产物内，闸门）`，排在二进制生成之后、上传之前（客户端仓库 `5b46f03`，测试 63/63，
把 inflate 那行改坏后有 4 项变红）。zip 解析器与 `python zipfile` 在真实 224 MB APK 上对齐：
4693 / 4255 / method0 3213 / method8 1480 完全一致；跑**已发布的旧 APK** 报 3 条问题
（`index.html`、`dev/uikit.html`、缺镜像表），跑旧桌面产物的 `resources/www` 同样 3 条。

**安卓那半边目前是合成验证**：把 `payload-c8` 按 `assets/public/` 前缀打成 deflate zip 过闸是绿的，
但**真正的 APK/EXE 还没用新 payload 重跑过** —— 要等新 payload 出门（见下面「还没做的一步」）。

## 8. 换机器复现这份 payload（不需要碰生产）

`public/assets|fonts|vendor` 和 `data/local-assets.json` 都不在 git 里，所以干净的 clone 一张美术都没有。
素材源就用**已发布的那份 payload**（Release 资产是永久地址，不依赖任何人本机还留着解包目录）：

```
gh api repos/lilyco-42/StrongholdProtocolClient/releases/tags/payload-v0.1.3-c5 \
  --jq '.assets[0].browser_download_url'                       # 也可写死：
  # https://github.com/lilyco-42/StrongholdProtocolClient/releases/download/payload-v0.1.3-c5/sp-payload-c5.tar.gz
curl -sL -o sp-payload-c5.tar.gz <上面那条地址>
sha256sum sp-payload-c5.tar.gz                                 # 必须是 de86c682da9cf32eb27dd95615e08e1cabefe3f889b811e2ec2f85e2a04ded80
tar -tzf sp-payload-c5.tar.gz | head                           # 布局是 ./assets ./css ./data ./js ./shared ./sim ./vendor ./fonts ./dev ./index.html ./build.json，共 5039 条
```

把解出来的 `assets/`、`fonts/`、`vendor/` 拷进游戏 checkout 的 `public/` 下，`data/local-assets.json` 拷进 `data/`，
然后 `node tools/package-client.mjs --server sp.lain42.top --game <checkout> --out <dir>`。

**包含关系怎么重验（别引用旧结论）**：解包目录是本机暂存，会被清掉 —— 2026-10-05 复查时 `payload-c6/` 已经没了，
所以这条写成命令，谁都能重跑。两个列表都必须 `LC_ALL=C sort`，否则 `comm` 会因为排序规则不同给出几百行假差异
（这个坑踩过，见 `docs/12` §3）：

```
tar -tzf sp-payload-c5.tar.gz | sed 's|^\./||' | grep -v -e '/$' -e '^$' | LC_ALL=C sort -u > a.list
( cd <新的暂存目录> && find . -type f | sed 's|^\./||' ) | LC_ALL=C sort -u > b.list
comm -23 a.list b.list | wc -l        # 期望 0：旧 payload 里的每个文件都得还在
comm -13 a.list b.list | awk -F/ '{print $1}' | sort | uniq -c   # 多出来的按顶层目录分类看
```

2026-10-05 实测（c5 → **c10**）：`4253 → 4368`，**丢失 0**，多出 **115** = `webfonts/` 113（112 个 woff2 + `google.css`）
+ `assets/` 2（合并上游 `bd892a4` 带进来的 #110 那两条 corrosion BGM）。
判读方式：多出来的**只许落在你预期新增的那几个顶层目录里**，且每一类都说得出原因；
若哪天冒出一个说不清的顶层目录，那是素材漂移，先查清楚再发布。

⚠️ 别把 `./` 漏掉不处理：`sed 's|^\./||'` 之后根目录条目变成**空字符串**，`grep -v '/$'` 不会滤掉它，
于是 `comm -23` 平白多出一个"丢了 1 个文件"的假象（我就是这么撞上的 —— 打印出来才发现那一行是空的）。
滤法要么加 `-e '^$'`，要么先 `grep -v '/$'` 再做 `sed`。
c5 里 `grep -c webfonts` 是 **0**（镜像是 c5 之后才进 payload 的），所以"多出 113 个 webfonts"这条从一开始就成立。

## 9. 还没做的一步（要人点头）

源头与产物闸门都已就位，但**已发布的 exe/apk 仍是旧 payload**。要出带镜像字体的新产物：

```
# payload 已在本机备好（不要覆盖已发布资产，一律新 tag / 新文件名）
D:/Code/_artifacts/sp-client-payload-0.1.3-c10.tar.gz
  221,350,850 B  sha256 234ee9625fb844789d82289cad4f9a2bdaf491c622db8c2151eea752ff1fec36
  build.json: game.app=0.1.3, describe=v0.1.3-16-g603b94c, protocol=1, 4368 文件 / 295.3 MB
  （c8 = 4366 文件 / v0.1.3-8-g86719d1 已作废：合并上游 bd892a4 之后它是旧基线，缺 #110 的 2 条 BGM）

gh release create payload-v0.1.3-c10 --draft=false --title 'payload v0.1.3-c10（字体镜像 + 0.1.3 最新基线）' \
  D:/Code/_artifacts/sp-client-payload-0.1.3-c10.tar.gz
gh workflow run build-clients.yml -R lilyco-42/StrongholdProtocolClient \
  -f payload_url='https://github.com/lilyco-42/StrongholdProtocolClient/releases/download/payload-v0.1.3-c10/sp-client-payload-0.1.3-c10.tar.gz' \
  -f server=sp.lain42.top -f expect_app=0.1.3
```

draft 的 Release 资产匿名访问是 403，CI 拉不到 —— 建完要么直接非 draft，要么记得 `gh release edit --draft=false`。
跑完照旧：结论看 `gh run view --json conclusion`，产物**下载拆开**验 `webfonts/google/google.css` 在 asar/APK 里、
`fonts.googleapis` 计数为 0、`resolveMediaPath`（桌面）、`__SP_MEDIA_ALIAS__ = false`（安卓）。

上线口径（`/opt/Stronghold-Protocol`）也顺带说明：那份是热文件，网页玩家直接命中，**不能**用编辑线上文件的方式
铺字体镜像 —— 要么随 0.1.3 升级一起在低峰窗口换 checkout，要么先只在客户端线上用。

> 网页玩家现在仍走外链：生产 `sp.lain42.top/index.html` 实测 2 次 `fonts.googleapis.com` + 1 次 `fonts.gstatic.com`。
> 那份是热文件（本轮在线 246 人 / 177 场），只能随 0.1.3 升级整份换 checkout —— 上表最后一条就是升级后应当看到的结果。
