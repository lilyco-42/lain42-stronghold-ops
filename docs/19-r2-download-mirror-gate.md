# 19. dl.lain42.top → R2 公开桶的验收闸门（2026-10-12 定稿）

## 为什么单独一篇

`dl.lain42.top` 背后的阿里云 OSS 账号被停用（见 `16-oss-account-disabled.md`），站内所有下载链接指向的对象一夜之间
变成 403/404。替代品是 Cloudflare R2 桶 `lain42-dl` + 自定义域名 `https://dl.lilyco42.top`。
**搬迁本身做完不等于交付完**：键一旦切过去，坏一个就是用户侧 404，而没人会天天手工点。
这一篇讲的是"谁来天天验"，不是"怎么搬的"（搬运过程在 16/17 里）。

## 车道（验收两条 + 构建一条）

| 车道 | 文件 | 频率 | 断言强度 |
|---|---|---|---|
| 浅 | `.github/workflows/dl-mirror-check.yml` | **父车道 `sp-room-api` 每次跑完自动触发**（4 个 cron 槽位只当冗余） | 每个键：HTTP 200/206、长度==期望、Content-Type、Range 被接受 |
| 全量 | `.github/workflows/dl-mirror-deep.yml` | cron 每月 1/15 日 04:37 UTC **+ 被父车道带起来时的日历守卫**（只有 1/15 日真跑）+ 手工 dispatch | 上面全部 **+ 整段回读比 sha256**（2.7 GiB，实测约 1 分钟走完） |
| 构建 | `.github/workflows/build-hf-runtime.yml` | 只有手工 dispatch（不排程：它产的是二进制产物，不是验收） | 只读 checkout Pages 仓，跑它自带的 `tool/models/build-runtime.mjs`，产物齐 + 不含旧域名才出 artifact；产物哈希随后进 `dl-mirror-extra-pinned.json`，验收仍归上面两条 |

**浅车道为什么要三个触发源（这段是我修正过的判断，不是最初的版本）**：我最初测到"改了排程后
到点槽位 0 run"就下结论说 cron 在这个账号上不落地 —— 那个结论测得太早，后来被证伪：
本车道 21:17 UTC 的槽位在 **22:29:27Z** 落地（推迟 1h12m，success），提醒器仓 source-drift 也在
**21:19:17Z** 落地（推迟约 3 小时）。但另一面也成立：同一天 15:17 UTC 与 12:23 UTC 两个槽位
到过期后都没有产生任何 run，也就是**整槽会被跳过**。所以正确的说法是"会推迟 1–3 小时，且部分槽位整槽丢失"，
不是"永不调度"。因此排程留 4 个槽位、再加 `workflow_run`（父 `sp-room-api`，实测 16:41:35Z 点火）、
再加 push 触发（本文件与 scripts 改动必然自验，实测 02:53Z 那趟三步全绿），三层叠加让"今天有没有验过"
不再取决于单个定时器。教训仍然是对的：**别把"加了 schedule"当成"会被跑"，也不要拿一次观测就断言机制坏了。**

浅车道现在有**三个**触发源：4 个 cron 槽位（冗余）、`workflow_run`（父 `sp-room-api`）、以及进 main 的提交
（`paths` 限定 `scripts/**`、本文档与它自己的 YAML —— 让"改了检查逻辑"必然被自己验一遍）。

## 镜像当前真实状态（2026-10-14 实测，别再按旧数字说话）

线上 `downloads/manifest.json` 共 113 条条目，其中 **20 条有 mirror**，按主机分：

| mirror 主机 | 条数 | 含义 |
|---|---|---|
| `dl.lilyco42.top` | 18 | 已走 R2 镜像，每天验收 |
| `lain42.top` | 2 | `lyco`、`lyco-jev` 暂时回源站（源站本身是快的，境内实测 206 / 30 ms） |
| `dl.lain42.top` | **0** | 已停用的 OSS —— 死域名引用清零 |

两条后果，都已在闸门里体现：
· 浅车道从 91 键变成 **89 键**（18 manifest + 33 csv + 38 extra，`knownGaps` 0 条，89 键全部带 sha256）。
· `lyco-dl/lyco-windows.zip` 因为 mirror 回源站而脱离 manifest 覆盖，但桶里那份对象还在、而且正是切流预检的
  正向对照 —— 所以按“补一个就钉一个”把它补进 extra，别出现“镜面对象反而没人验”。深车道当天证过它整段哈希
  与 manifest 的 pin 一致，这个补钉不是凭印象。
· 新增一条反向断言：**若任何 mirror 退回 `dl.lain42.top` 就直接红**。那种条目会被归进 `notMirrored` 而不进桶验收，
  不加这条就成了“安静地退回去”——而整个迁移的失败方式恰好就是这个。对照做过：拿今天的真表跑 PASS，
  把 `notMirrored[0].host` 改成死域名立刻红并指名 `lyco`。

## 预检现在直接读线上清单（2026-10-14，扫出 6 张碎图）

预检原先只看两样：Pages 仓库里的字面 URL、手工维护的 `CONCAT_KEYS`；期望表则只收 manifest 的 `mirror` 字段。
结果 `items[].icon` 挂在已停用域名上这件事**谁都不报**：6 张 PNG（ghboost / stemscan / simul-overlay /
cute-pet / mc-remote / mirage-tank）在新桶 404、旧域名 403，而下载页确实渲染 `item.icon` —— 用户现在看到的
就是 6 个碎图，而三条车道全绿。这就是"绿灯等于覆盖"的又一例。

现在预检会把清单里**所有 URL 字段**扫进探测集合，缺失的条目还会标注来自哪个字段。实测（CI run `38566900702`）：
清单扫出 25 键，`引用 44 条：可达 32，已知缺口 6，新缺口 0`，`已知缺口 404 downloads/icons/ghboost.png [清单字段：icon]`。
读清单必须用 curl：这份 manifest 由站上 pingap 0.13.5 直接服务，它同时发 `Content-Length` 和 `Transfer-Encoding`
（违反 RFC 9112 §6.1），node/undici 的普通 GET 会失败 —— 第一次本机跑就 rc=3 撞上。桶上那些键仍走 node fetch。

6 张图的代价写在 `EXPECTED_MISSING` 旁边：字节只在停用的 OSS 里，服务器上没有 icons 目录，Pages 仓只有
`assets/logos/ghboost.svg`、`assets/logos/cute-pet.svg` 两个同名但**不同格式不同字节**的素材。所以要么找回/重做
这 6 张图入库，要么把清单的 icon 字段改成站内本地素材 —— 后者是站内写，要点头。

## 切流预检（`scripts/check-cutover-readiness.mjs`）

它回答的是另一个问题：**站内代码真会去取的那些路径，新桶里有没有。** 期望表覆盖不到这件事
（它来自下载清单 + 2026-09-28 那份 OSS 清单），所以两边要独立测。

- 两类引用都要看：正则抓得到的 `https://dl.lain42.top/…` 字面量，以及
  `OSS + 'wllama/3.6.1/compat/wllama.js'` 这种拼接出来的（后者靠脚本里 `CONCAT_KEYS` 手工维护，漏了就是假绿）。
  为了不让手工清单烂掉，脚本还会从站内代码抓出所有"`*OSS*` + 资源字面量"，凡是没被覆盖的就报
  `新出现的拼接键` 并 rc=1。**这条也有过一段假绿历史**：第一版正则把变量前缀写成必须有一个前置字符，
  于是裸名 `OSS` 一条都匹配不到，只报"代码里 1 条"——看着通过其实是空转。
  变异验证（现版）：从 `CONCAT_KEYS` 删掉 `compat/wllama.js` → 输出"代码里新出现的拼接键 …"且 rc=1。
- 已知缺口现在剩 **1 条**（`models/hf/catalog.json`）钉在 `EXPECTED_MISSING`：多一条新缺口 → 红；**已知缺口被补齐 → 也红**并要求删条目，
  缺口清单就不会悄悄过期。因此它今天绿，不需要 `|| echo` 那种把死闸门写成绿的写法。
  两个方向都做过变异验证：塞一条不存在的键 → `NEW-MISS` rc=1；把一条可达的塞进清单 → 要求删条目 rc=1。
- **缺口的性质在 2026-10-13 纠正过一次：不是"切流会弄坏"，是"已经坏了"。** 旧域名 `dl.lain42.top` 对它们全部回
  403（OSS 停用），新桶回 404，所以 `tool/models` 与 `tool/lyco_chat` 两页当时就是坏的，补齐它们属于**修复**。
  而且 `tool/models/app.mjs:76` 是用 `fetch(catalog.json, {mode:'cors'})` 跨源取目录，
  桶没配 CORS 时 R2 自定义域名不回任何 `access-control-*` 头 —— **桶 CORS 因此是这一页恢复的硬前置，不是可选优化**。
- **`compat/wllama.{js,wasm}` 已补齐并从缺口清单删掉（2026-10-13）**。之前记的"上游没有 compat 产物、只能从
  `ngxson/wllama` 源码构建"是**假阴性**：我搜的是 `wllama` 包，而桶里那份 3.6.1 运行时的 `index.min.js` 自己写着
  `WasmCompatFromCDN = {worker:"https://cdn.jsdelivr.net/npm/@wllama/wllama-compat@3.6.1/wasm/wllama.js", …}` ——
  上游包是 scoped 的 `@wllama/wllama-compat`，`wasm/wllama.js` + `wasm/wllama.wasm` 就是站内那两个键，直接搬即可。
  验收：jsdelivr 与 unpkg 各拉一次，两份 sha256 相同（js `97f88f7b…`/170,982 B，wasm `3c447fe8…`/15,369,538 B），
  上传后从公网域名字节回读再哈希，与上游一致；两条已进期望表（`src=extra`，来自
  `scripts/dl-mirror-extra-pinned.json`），所以从此每天验哈希而不只是长度。
  **`wrangler r2 object put` 不带 `--remote` 会写进 `.wrangler/state/` 本地模拟并照样打印 "Upload complete"** ——
  第一次就是这么"成功"的，域名仍 404；判别方法：`r2 object get` 同一个键能拿回字节但拿不到桶里早就存在的键，
  就是读到本地了。这条已经吃掉过一次"迁移完成"的假结论。
- **`transformers.bundle.mjs` 也补齐了（2026-10-13），这条是"重建"不是"还原"**：生产者不用另找 —— Pages 仓
  `tool/models/build-runtime.mjs` 就是当年产它的脚本，`.github/workflows/build-hf-runtime.yml` 只读 checkout Pages
  跑它（本机一律不编译）。一次出五件：bundle 870,563 B / `094392fc…`，加 `app.mjs:130` 把
  `env.backends.onnx.wasm.wasmPaths` 指到 bundle 同目录所要求的 4 个 ort 文件（共约 33.6 MB）。
  五件的哈希都进 `scripts/dl-mirror-extra-pinned.json`，所以浅车道从 56 键涨到 **61 键**。
  强度边界写在这里：旧域名那份没留哈希、也取不回来，这条钉的是「lane 产物 == 桶里的对象」，
  引用时不能说成与 OSS 时代字节一致；OSS 那份是否与此不同，无法验证。
- **桶 CORS 已于 2026-10-13 配上**（`deploy/r2-dl-cors.json`，重建：
  `npx wrangler r2 bucket cors set lain42-dl --file deploy/r2-dl-cors.json -y`，读回 `... cors list lain42-dl`）。
  在服务器（干净出口，本机走代理只会拿到 `200 Connection established`）实测三条：
  GET+`Origin` → 200 带 `access-control-allow-origin: *` 与 `access-control-expose-headers`；
  `Range` GET+`Origin` → 206 且 `Content-Range` 在 expose 列表里（下载页算进度必须读得到它）；
  `OPTIONS` 预检 → 204 带 `allow-methods: GET, HEAD`、`allow-headers: range`、`max-age: 3600`。
  两个坑记在这里：① `methods` 里放 `"OPTIONS"` 会被 API 拒成
  `The JSON you provided was not well formed. [code: 10040]` —— 报错说的是"JSON 格式"，实际是**取值非法**，
  按字面去查 JSON 语法会查不出来；预检本身不需要把它列为允许方法。② 每次失败后 `cors list` 都回 10059
  （配置不存在），确认没有"半应用"的中间态。
  配置不在仓库里，控制台一键就能删掉，所以 `check-cutover-readiness.mjs` 现在直接断言这三条头里的两条：
  对照键的响应没有 ACAO 或 expose 里没有 `Content-Range` → 红。
- 带正向对照（`lyco-dl/lyco-windows.zip`，今天整段验过 sha256）：对照拿不到就 rc=3 作废整批结论 ——
  第一版就是靠它发现我自己踩了 `execFile('curl')` + `-o /dev/null` 两个 Windows 坑，15 条全假 404。
- 必须显式传 Pages 仓库目录（CI 里是 checkout 出来的 `pages`，本机 `D:/Code/lilyco-42.github.io`），
  不给就 rc=2：不再默认某个人的绝对路径，那是上一版漂移闸门的死法。
- **`scripts/check-hf-catalog.mjs`：目录与语料的一致性**（浅车道里多出的一个步骤，不是新车道）。
  按长度逐个比的验收看不出"目录说的键其实不存在"这种错配，而 `catalog.json` 是一次性快照，
  所以这里检查的是三者对不对得上：
  · 页面自己的消费契约（`app.mjs:79`：`schemaVersion==1`、`models` 非空、`runtime.version=='3.8.1'`）；
  · 目录里每个文件键（`models/hf/<id>/resolve/<rev>/<path>`，与 `remoteHost + remotePathTemplate` 的拼法一致）
    在桶里取得到，且**实际字节 == 目录声明字节**，另外 `downloadBytes` 要等于该模型 files 之和；
  · `runtime.url` / `wasmBase` 不许再出现已停用的旧域名 —— 这正是服务器那份生成器下次会写出来的东西。
  2026-10-13 实测：4 个模型 / 29 个文件全过；`--selftest` 三条对照（取不到的键、尺寸不符、旧域名回归）
  都能红，且带一个与本项目无关的正向对照键（对照失败就 rc=3 作废，不把探测器的错算成目录的错）。
  本机跑要加 `NODE_USE_ENV_PROXY=1`（这台机器的 node 默认不走系统代理，直连这个域名会静默卡住）。
- **预检自己的两个坑（2026-10-13 后补）**：
  · `git grep` 零命中时退出码是 1，而 `execFileSync` 把它当异常抛 —— 于是**切流成功之后**（站内不再引用旧域名）
  这条预检反而会崩，崩在"引用都清干净了"的那一刻，rc=1 看着像红其实是脚本自己的毛病。现在包了一层 `gitGrep()`
  把"没有匹配"当空结果；用一份零引用的 fixture 仓库验过：改前崩、改后 rc=0。
  · 提取器只认字面 URL，而测试源码习惯把点写成 `\. ` 这类转义形态 —— 字面模式数出来的清单会漏。实测 Pages 仓：
  字面数法得 17 个文件 / 27 处，允许转义形态是 **20 个文件 / 35 处**，少算的 8 处全在 4 个测试文件的断言里
  （`oss-runtime-assets` 4、`hf-model-workbench` 2、`lp-wasm-loader` 1、`industry-workbench` 1）。这些断言必须与切流
  同批翻转，否则正确的切流会被 CI 判成回归。为防"站内代码哪天也用转义写法"悄悄漏键，预检多一条核对：非 tests/
  文件里出现**带反斜杠的**旧域名形态就报红。这条差点写成天天红 —— 第一版把反斜杠写成可选，7 个正常写法的文件全被判红。
  三向对照：真仓 rc=0、变异 fixture 指名 `x/app.mjs` rc=1、零引用 fixture rc=0。

两条都跑同一个脚本 `scripts/check-dl-mirror.mjs`，期望值来自 `scripts/dl-mirror-expected.json`。

## 期望表的三类来源（强度不同，别说混）

- **manifest 项（现在 18 条）**：期望值取自 `https://lain42.top/downloads/manifest.json` 的 `mirror.{url,size,sha256}`。
  2026-10-14 起只收 **mirror 主机就是桶域名**的条目 —— 清单里还有 2 条（`lyco`、`lyco-jev`）的 mirror 暂时回源站
  `lain42.top`，桶里没有对应对象可验，它们被显式记进 `notMirrored` 而不是被当成缺失。
  这条能声称"与第三方清单一致"。每次生成表都会重新抓线上清单，所以站内加了新条目、改了尺寸，
  第二步的 `git diff --exit-code` 会红 —— 那是设计意图。
- **csv 项（33 条）**：2026-09-28 那批 npm/wasm 包，从来没有存哈希的清单。
  现在 `scripts/dl-mirror-csv-sha.json` 里有 sha256，来源是 `scripts/pin-csv-assets.mjs`：
  **本机当年上传的那份文件** 与 **R2 现对象** 各自算哈希，相等的键才写进表
  （2026-10-12 实测 33/33 一致、0 条不一致）。
  所以这条只能声称"桶里的字节 == 我上传的字节"，**不能**声称"与某个权威上游一致"。

- **extra 项（37 条，`scripts/dl-mirror-extra-pinned.json`）**：上面两张表都覆盖不到、但站内代码真引用的键，
  补一条就钉一条。这一类内部强度还分三层，引用时别一把话说：
  · `wasm/wllama/3.6.1/compat/*` 两条 = 上游发布物 `@wllama/wllama-compat@3.6.1`，jsdelivr 与 unpkg 各拉一次
    哈希相同 —— 可以说「与上游一致」；
  · `wasm/transformers-js/3.8.1/*` 五条 = 按 Pages 仓 lock **重建**的产物，只能证明「lane 产物 == 桶里的对象」；
  · `models/hf/*` 三十条 = 权威 pin 来自服务器 `/opt/lain42-model-sync/state.json`（LFS 文件是整文件 sha256，
    非 LFS 是 git-blob-sha1），逐条对上才上架，所以这三十条是**真还原**。

**`knownGaps` 现在是 0 条**（2026-10-14）。原来看似无解的那条 `lyco-jev` 由站内自己解决了：manifest 已经把它重钉成
源站现物的 `1,155,579,350 B / 3b47b18b…`（就是我量出来并列为“换 build”选项的那份），并把 mirror 指向源站而不是死域名。
所以它不再是 pin 冲突，也不需要我等的决定了；下面那节“检索已穷尽”保留下来当**方法记录**，但结论已被今天的事实推翻。

曾经的行为是：表里写清理由，脚本会 SKIP 它们并保证 `checked == items - skipped`（防止
"全表被清空也显示全绿"）：

- `lyco-jev`：manifest 钉 623,029,300 B / `3947c93b…`，那份字节只在停用的 OSS 里 —— 服务器与本机都按**精确尺寸**
  全盘搜过（`find / -size 623029300c`），没有副本。源站 `lain42.top/lyco-jev-dl/…` 是**另一个 build**：
  就地算出 1,155,579,350 B / sha256 `3b47b18b…`，境内 206 / 30 ms / 类型正确。
  **改链接技术上可行**，但用户拿到的是不同的 build → 这是"重钉还是换 build"的决定，不是我能替做的。

`cute-pet` 已经不再是待定项（2026-10-12 找回原字节，不需要决定）：GitHub 上 v0.3.5 那个同名资产在 10-10 被重传过
（同尺寸不同字节），但 **pin 那份字节在服务器 `/tmp/cute-pet-shell.apk` 里还活着**（10-03 的副本，
sha256 `801aa079…` 与 manifest 逐字节相同）。链路是 scp 回本机 → 重新算 sha256 仍等于 pin → 确认是合法 APK
（zip magic、24 个条目、含 AndroidManifest/classes/resources.arsc）→ `wrangler put` 到
`lain42-dl/downloads/cute-pet/0.3.5/cute-pet-shell.apk` → 回读 sha256 一致 → 公网整段 GET（严格客户端）与
Range 各验一次 → 境内整段下载 42,715,247 B / 11.7 s / 3.6 MB/s。服务器那份 `/tmp` 副本不是我的，没有删。

## `lyco-jev`：找回 pin 那份字节的检索已经穷尽（方法记录；2026-10-14 站内已改钉新 build，此节结论作废）

结论：manifest 钉的 623,029,300 B / `3947c93b…` 在我能碰到的每个面上都不存在了。这不是推测，逐面测过：

| 面 | 做法 | 结果 |
|---|---|---|
| 服务器 | `find / -type f -size 623029300c`（按**精确字节尺寸**而不是名字） | 无命中（42715247c 那条命中了 cute-pet，见上） |
| 本机 | 同样按精确尺寸搜 `/d/Code`、`/d/tmp` | 无命中 |
| GitHub Release / tag | `gh release list`、`/tags` | 该仓库一个 Release 都没有 |
| CI 产物 | 27 个 `app-debug` 产物，≥100 MB 的 7 个 | 内层 APK 尺寸见下，无 623029300 |
| 另两个 R2 桶 | `wrangler r2 object get` 4 个候选键 | 全 404 |

**怎么在不下载整包的情况下知道产物里那个文件多大**：取 zip 最后约 1.6 MB，扫 `PK\x01\x02` 中央目录记录，
读 offset 24 的 uncompressed size 即可。但**别假设 Range 一定生效** —— 同一条产物地址，我这轮有两种结果：
`curl -sL -K cfg -r -2000000`（后缀 Range）回的是 **200 整包**，被 `--max-time` 截成没用的碎片，白流约 1.1 GB；
而换成带 token 的绝对 Range `bytes=<size-1600000>..<size-1>` 明确回 **206 + `content-range: …/588230350`**，
一次到位。另一条用 node fetch 发后缀 Range 的路径反而解析出了中央目录。所以规则是：**每次Range探测都要断言
状态是 206 并把 `content-range` 打出来**，两个独立客户端（curl / node）都跑一遍更稳。

七个 ≥100MB 产物的内层尺寸（curl 与 node 两条路各自测得，数值一致）：`666705026 / 666721410 / 666721410 /
1155562966 / 1155579350 / 1155579350 / 1199255080` —— 没有 manifest 钉的 623029300。

顺带一个对做决定有用的副产品：**源站那份 1,155,579,350 B 的 build 在 CI 里也有第二出处**
（两个 10-02 的 `app-debug` 产物内层正好是这个尺寸），所以如果你选"重钉到现 build"，
那份字节不止 pingap 一处能取。

## models/hf 语料是怎么补的（2026-10-13，`EXPECTED_MISSING` 因此清空）

缺口清单里最后一条 `models/hf/catalog.json` 只是索引，它指向的模型语料是 **29 个文件 / 839,471,805 B**，
新桶里当时全是 404。补法按顺序是：

1. 从服务器**只读**取 `state.json`（每条带 `path/bytes/checksum/checksumAlgorithm`）与 `models.json`；
2. 本机从 `https://hf-mirror.com` 按 `<repo>/resolve/<revision>/<path>` 逐条下载（实测 3.04 MB/s，29 条 116 s 下完），
   **按它自己声明的算法**校验：8 条 LFS 比整文件 sha256，21 条比 git blob sha1（`sha1("blob <len>\0" + 内容)`），29/29 全过才继续；
3. 上架：28 条走 `wrangler r2 object put --remote`（每条上架后用 `Range: bytes=0-0` 回读，比对 `content-range`
   里的总长；中途真失败过 1 条，补传后才 28/28），最后一条 `Jev-Style-0.8B…gguf` 504.8 MiB 超 wrangler 的
   300 MiB 硬上限，走 `scripts/r2-put-large.mjs` 的分片装配 + 回读整段 sha256（实测这一条单独花了 **1635 s**，
   本机→R2 约 1 MB/s；装配成功时临时分片会自动删掉，`_asm/*` 现在全是 404）；
4. `catalog.json` 用**服务器那份 `sync_hf_models.py` 的 `build_catalog()`** 生成（本机跑它的副本；它是纯函数，
   只吃 manifest + state）—— 不另写一份 node 版，抄一份就会和线上漂移。生成物只改两处 base，改完断言旧域名
   一条不剩，并检查页面自己的契约（`app.mjs:79`：`schemaVersion==1`、`models` 是非空数组、`runtime.version=='3.8.1'`）。
   最终 8,522 B / sha256 `3e94fc47…`，4 个模型、声明 800.6 MiB。

**两处残留风险，别当成已经收尾**：
· 服务器上那份脚本仍把 `runtime.url` / `wasmBase` 硬编码成旧域名。下一次真发生模型变更时它会生成一份带死域名
  的目录，而它的 `ossutil` 上架那一步会因为 OSS 停用而响亮失败（`check=True`），不会静默成功 —— 把它改成写新桶
  属于**服务器写**，要点头；
· 我上传的这份 `catalog.json` 是一次性快照，不会跟着语料自动更新。而且每天 11:15 UTC 那条 cron 现在天天打印
  `unchanged ×4 + catalog unchanged` —— 它的成功路径就是「啥也不干」，因此**不可能**报告「输出端已经死了」。
  这类「绿灯等于覆盖」和本页开头那条 cron 教训是同一个。

**补这批时踩到的两个传输层坑（是这台机器的环境，不是通用知识）**：
· `*.workers.dev` 的 DNS 在这台机器上被污染成 Facebook 的 IP（`nslookup` 给 157.240.12.50），node 直连必然
  `UND_ERR_CONNECT_TIMEOUT`；
· 用 `NODE_USE_ENV_PROXY=1` 让 node 走代理之后，**同一进程里的 wrangler 上传反过来失败**
  （`Failed to fetch /accounts/…/objects/_asm/…`）。所以 `r2-put-large.mjs` 的 Worker 那一腿改成走 curl
  （系统代理一直是通的，无 token 时回 401 可证），token 用 `curl --config -` 从 stdin 喂，不进 argv 也不进日志。

## 怎么加一条 / 怎么改钉

```bash
# 站内清单变了：重新生成期望表，看 diff，确认无误就提交
node scripts/build-dl-mirror-expected.mjs && git diff scripts/dl-mirror-expected.json

# 大文件（>300 MiB，wrangler 上限）：分片 + Worker 侧 multipart 组装，自带回读比哈希
node scripts/r2-put-large.mjs <本地文件> --dest-key <桶内键>

# 小文件：走清单驱动的上传器（护栏：键必须在 /downloads/ 下，且尺寸/哈希都先验）
node scripts/r2-put-from-manifest.mjs --only <id> --stage <本地目录>

# 给 csv 那半边补/刷新哈希
node scripts/pin-csv-assets.mjs
```

## 闸门自己的对照（`scripts/test-dl-mirror-stall.mjs`）

CI run 38234496095 第一次跑 `--deep all` 就红了，原因不在数据，而在闸门本身：
第 19 条（645 MiB 的 gguf）被"总时长 5 分钟"的 `AbortSignal` 掐死，而异常没接住，
日志只留下一个 `DOMException`，看不出卡在第几条。所以：

- 超时段位：整段回读现在用**停顿超时**（连续 90 s 收不到字节才算链路死）+ 一个很宽的 15 分钟总上限；
  前面 378 MiB 那条只用 7 秒，说明"大对象"和"会超时"根本无关，用总时长掐它就是在制造假故障。
- 异常必须变成一行 `✗ … 原因=…`，不许掀掉整个 job。
- 判定为红要用 `process.exitCode` 而不是 `process.exit()`：强退会撞上还没关闭的 undici
  keep-alive socket，**Windows** 上触发 libuv 断言 `src\win\async.c:76`，退出码变成
  3221226505（0xC0000409）—— 断言内容全对，但看起来像闸门崩了而不是红了。
  Linux runner 炸不出来，而失败路径在那边还从没红过，两边都不测就等于没测。
- 三个对照（正向整段一致 / 整段黑洞 / 键被删 404）都跑在本机 HTTP 服务上、不碰外网，
  已挂进每日车道的第一步。实测 9/9 PASS；黑洞那行输出
  `http=ABORT bytes=0/161 … 原因=连续 1.5s 没收到字节`。
  写这条测试时自己还踩过一个坑：用 `spawnSync` 会让本进程的事件循环冻住，HTTP 服务发不出响应，
  "正向对照"于是也变假红 —— 必须异步 `spawn`。

## 踩过的两个坑，写在这里防止复发

1. **`cmd && git diff --exit-code file || echo '::warning::…'` 会把死闸门写成绿的**。
   生成器当年读 `D:/Code/_staging/oss-assets-20260928.csv`（只有我本机有），CI 里 ENOENT，
   被 `||` 吞成 step success，日志里连 `写出 55 条` 都没出现过。判断"这一步跑没跑"要看**它自己的 stdout**，
   不是 step 结论。现在：输入全部落仓库、路径相对脚本自身、去掉 `||`、再加一条"来源残缺"断言，
   并用变异测试证明它会红（删一行快照 → diff rc=1；把表过滤成单一来源 → 断言炸）。
2. **R2 自定义域名只发桶对象**。Worker 的 `/health` 在这个域名上 404，`data.json` 才在；
   绑域名等于**整桶公开可读**，且默认响应不带 CORS 头、带 `Cache-Control: max-age=14400`
   （CORS 是桶级配置，`lain42-dl` 已于 2026-10-13 配上，见上；`max-age` 那条仍在，切流后 4 小时内的
   旧响应可能还在边缘，验证时要带 query 绕开缓存）。
   顺带一条对比：同一批静态对象，源站 pingap 的整段 GET 会被严格 HTTP 客户端拒掉
   （`Transfer-Encoding can't be present with Content-Length`），R2 这条路正常。
