# 19. dl.lain42.top → R2 公开桶的验收闸门（2026-10-12 定稿）

## 为什么单独一篇

`dl.lain42.top` 背后的阿里云 OSS 账号被停用（见 `16-oss-account-disabled.md`），站内所有下载链接指向的对象一夜之间
变成 403/404。替代品是 Cloudflare R2 桶 `lain42-dl` + 自定义域名 `https://dl.lilyco42.top`。
**搬迁本身做完不等于交付完**：键一旦切过去，坏一个就是用户侧 404，而没人会天天手工点。
这一篇讲的是"谁来天天验"，不是"怎么搬的"（搬运过程在 16/17 里）。

## 两条车道

| 车道 | 文件 | 频率 | 断言强度 |
|---|---|---|---|
| 浅 | `.github/workflows/dl-mirror-check.yml` | 每天 03:17 UTC | 每个键：HTTP 200/206、长度==期望、Content-Type、Range 被接受 |
| 全量 | `.github/workflows/dl-mirror-deep.yml` | 每月 1 日 04:37 UTC | 上面全部 **+ 整段回读比 sha256**（≈2.6 GiB） |

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

已知待定 `knownGaps` 只有 2 条，都在表里写清了理由，脚本会 SKIP 它们并保证 `checked == items - skipped`（防止
"全表被清空也显示全绿"）：

- `lyco-jev`：manifest 钉 623,029,300 B / `3947c93b…`，那份只在停用的 OSS 里；源站 fallback
  `lain42.top/lyco-jev-dl/…` 境内实测 206、总长 1,155,579,350 B、类型正确。**改链接技术上可行**，
  但用户拿到的是另一个 build → 这是"重钉还是换 build"的决定，不是我能替做的。
- `cute-pet`：pin `801aa079…` vs GitHub 现资产 `0cd6f668…`（同尺寸不同字节，资产在打 pin 之后重传过）。
  源站**没有** `/cute-pet-dl/` 路径（实测 404），所以连"改链接"这条路都不存在，只能决定重钉还是顶用。

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
