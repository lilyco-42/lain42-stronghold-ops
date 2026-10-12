# 19. dl.lain42.top → R2 公开桶的验收闸门（2026-10-12 定稿）

## 为什么单独一篇

`dl.lain42.top` 背后的阿里云 OSS 账号被停用（见 `16-oss-account-disabled.md`），站内所有下载链接指向的对象一夜之间
变成 403/404。替代品是 Cloudflare R2 桶 `lain42-dl` + 自定义域名 `https://dl.lilyco42.top`。
**搬迁本身做完不等于交付完**：键一旦切过去，坏一个就是用户侧 404，而没人会天天手工点。
这一篇讲的是"谁来天天验"，不是"怎么搬的"（搬运过程在 16/17 里）。

## 两条车道

| 车道 | 文件 | 频率 | 断言强度 |
|---|---|---|---|
| 浅 | `.github/workflows/dl-mirror-check.yml` | 每天 4 次（03:17/09:17/15:17/21:17 UTC） | 每个键：HTTP 200/206、长度==期望、Content-Type、Range 被接受 |
| 全量 | `.github/workflows/dl-mirror-deep.yml` | 每月 1 日与 15 日 04:37 UTC | 上面全部 **+ 整段回读比 sha256**（≈2.7 GiB） |

为什么不是"每天一次/每月一次"：这个账号的 GitHub 定时任务实测会整小时推迟甚至整天不落地
（见 `codex-reset-reminder` 那边同一天只跑了一次 schedule、另一条 02:22 的 09:26 才跑），
槽位多几个是把"至少跑成一次"变成大概率，不是保证。

两条都跑同一个脚本 `scripts/check-dl-mirror.mjs`，期望值来自 `scripts/dl-mirror-expected.json`。

## 期望表的两类来源（强度不同，别说混）

- **manifest 项（22 条）**：期望值取自 `https://lain42.top/downloads/manifest.json` 的 `mirror.{url,size,sha256}`。
  这条能声称"与第三方清单一致"。每次生成表都会重新抓线上清单，所以站内加了新条目、改了尺寸，
  第二步的 `git diff --exit-code` 会红 —— 那是设计意图。
- **csv 项（33 条）**：2026-09-28 那批 npm/wasm 包，从来没有存哈希的清单。
  现在 `scripts/dl-mirror-csv-sha.json` 里有 sha256，来源是 `scripts/pin-csv-assets.mjs`：
  **本机当年上传的那份文件** 与 **R2 现对象** 各自算哈希，相等的键才写进表
  （2026-10-12 实测 33/33 一致、0 条不一致）。
  所以这条只能声称"桶里的字节 == 我上传的字节"，**不能**声称"与某个权威上游一致"。

已知待定 `knownGaps` 只剩 1 条，表里写清了理由，脚本会 SKIP 它们并保证 `checked == items - skipped`（防止
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

## `lyco-jev`：找回 pin 那份字节的检索已经穷尽（附可复现做法）

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
   绑域名等于**整桶公开可读**，且响应不带 CORS 头、带 `Cache-Control: max-age=14400`。
   顺带一条对比：同一批静态对象，源站 pingap 的整段 GET 会被严格 HTTP 客户端拒掉
   （`Transfer-Encoding can't be present with Content-Length`），R2 这条路正常。
