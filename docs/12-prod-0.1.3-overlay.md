# 12 · 2026-10-05 14:20：线上被覆盖式升到 0.1.3（我全程只读，没动一个字节）

这份文档对齐"本轮之前所有文档"与 14:20 之后线上现实之间的差异。

## 1. 发生了什么

- `stronghold.service` **14:20:24 CST** 重启（`MainPID=3879232`、`NRestarts=0`、`Result=success` —— 主动重启，不是崩溃）。
- 活的代码确实是 **0.1.3**，两条独立证据：`package.json` 的 `"version": "0.1.3"`；
  `server/` + `shared/` 里 `room.spectate` / `removeSpectator` **命中 13 处**（这两个动词 0.1.1 根本没有）。
- 但 `/opt/Stronghold-Protocol` 的 `git log -1` 仍是 **`8b10625`（0.1.1）**，`git describe` = `8b10625-dirty`，
  `git status --porcelain` 有 **238 个 `M`**。也就是说这是**把新文件覆盖到旧 checkout 上**，不是切 tag/commit。
  直接后果：`git diff` 成了唯一的回滚线索，没有可切的旧 commit，仓库里也没有留 `*.bak*`。
- 大厅同一时段也被改过：`online-platform.service` **14:10:11 CST** 重启，`wsgi.py` md5 现在是 `3918ab4b…`
  （13:22 我测的是 `24c6a6eb…`，13:48 变 `43c3b939…`，14:10 又变一次）。`config.py` 一直未变（`b2c9493a…`）。
  我准备好的注册修复在最新字节上重跑 `--dry-run` **仍然 rc=0**（锚点还在 `wsgi.py:109`；
  `config.py` 里 `skip_email_verify` 仍然 0 命中 —— 那正是这个 bug 的成因）。

## 2. 什么活下来了，什么丢了

| 项 | 状态 | 实测 |
|---|---|---|
| 素材清单指向 OSS | **在** | `data/assets.json` 里 **4506 条** `https://dl.lain42.top/downloads/stronghold-protocol/site/…`，相对地址只剩 1 条；对清单里的真实对象 `HEAD` → **200** |
| 磁盘上的素材 | **在** | `public/assets` 3995 个文件 / 260 MB，`public/assets/char` 520 个文件，`public/assets/local/` 与 `data/local-assets.json` 都在 |
| `03-frontend-to-oss`（前端本体指向 OSS） | **丢了** | 新的 `public/index.html` 里 `dl.lain42.top` 命中 **0**；`/css/…`、`/fonts/fonts.css` 等全部回到 node 出口 |
| 字体外链 | **回来了** | 同一份 `index.html` 有 `fonts.googleapis.com` ×2 + `fonts.gstatic.com` ×1 —— 那是上游的 index.html，我的镜像在 fork 分支上，不在这份里 |
| 出口余量 | **吃紧** | `eth0` TX 实测 10 秒 **567 KB/s**；3 Mbps ≈ **375 KB/s** 天花板。`README` 里"改动后 183 KB/s @ 418 人"是**旧基线**，现在超线 |

⚠️ 这 567 KB/s 不能全记在 `index.html` 头上：WS 状态同步才是大头，而 pingap **没有按路径的访问日志**
（`docs/08` 就写过这个缺口）。所以这一条是"总量实测、归因待测"，要坐实得先开日志。

## 3. 一个必须记下来的测量坑

我一开始报"OSS 清单丢了"，因为 `grep -c 'dl.lain42.top' data/assets.json` 返回 **1**。
错在**这份 JSON 是单行**的 —— `grep -c` 数的是**行数**，不是出现次数。正确的做法是走 JSON 结构：

```bash
ssh -i ~/.ssh/lain42.pem root@lain42.top "cd /opt/Stronghold-Protocol && python3 -c '
import json, re
s = json.dumps(json.load(open(\"data/assets.json\")))
u = re.findall(r\"https://dl[.]lain42[.]top[^\\\"]+\", s)
print(\"oss urls\", len(u)); print(\"sample\", u[0])
'"
```

结论反过来才对：清单完好（4506 条），丢的是 `index.html` 那一层。**单行 JSON 上的 `grep -c` 一律不可信。**

## 4. 建议（都还没做，需要人点头）

1. 在新 0.1.3 上重做"前端指向 OSS"：`scripts/build-oss-app.py` 生成 OSS 版，用并行 `index-oss.html` 验证，
   确认无误再 `cp` 覆盖 —— `public/index.html` 是热文件，走这条零风险路径，别直接编辑。
2. 同一轮把字体镜像一起带上（fork 分支 `86719d1` 的 `public/index.html` + `public/webfonts/google/`），
   否则网页玩家继续吃 Google 外链；带上的话网页版字体请求也会变成 0（本机已实测 0 外部字体请求）。
3. 让部署**可切 commit**：把当前工作树收成一个 commit（或至少留 `index.html` / `assets.json` 的 `.bak-<日期>`）。
   现在 238 个 `M` 没备份，回滚只能靠反向 `git diff`。
4. 开 pingap 按路径访问日志，否则"谁在吃带宽"永远只能推。
5. 好消息已经**实测确认**（不是推断）：把新 payload 用纯静态服务起在 `127.0.0.1:47901`，在真 Chromium 里
   按应用自己的方式 `new Net({})` 再 `_probeServerInfo()`，结果：
   `serverKey = wss://sp.lain42.top/ws`、`healthUrl = https://sp.lain42.top/healthz`（跨源能读，靠 `sp_healthz_cors`）、
   **`serverApp = "0.1.3"`**，于是 `verbAvailable()` 对 `room.spectate` / `room.kick` / `room.removeSpectator`
   三个全部回到 `{ok:true, reason:null}`（线上还是 0.1.1 时它们是 `older-server` 灰掉），
   `serverLacks(...,'room.spectate') = false`。同一次读数里 `humans` 已从重启后的 13 回到 36、`matches` 23。
   这就是"客户端自动识别服务端版本并应用"设计内的行为，**不需要改客户端**。
