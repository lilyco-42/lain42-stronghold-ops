# 12 · 2026-10-05 14:20：线上被覆盖式升到 0.1.3（我全程只读，没动一个字节）

这份文档对齐"本轮之前所有文档"与 14:20 之后线上现实之间的差异。

## 1. 发生了什么

- `stronghold.service` **14:20:24 CST** 重启（`MainPID=3879232`、`NRestarts=0`、`Result=success` —— 主动重启，不是崩溃）。
- 看起来是 0.1.3：`package.json` 的 `"version": "0.1.3"`，`server/` 里 `room.spectate` / `removeSpectator`
  命中 13 处（`server/lobby.js:292` 有 `case 'room.spectate'`），14:25 / 14:26 两个 mtime 也对得上。
  ⚠️ **但这句话当时只成立了一半**：`shared/protocol.js` 还是 0.1.1 那份（`room.join` 在表里、`spectate` 命中 0），
  于是线上是 `server/` = 0.1.3 + `shared/` = 0.1.1 的混合体，**线级行为仍然没有 0.1.3 的能力**。
  我一开始据此写"三个入口会自动解禁"，是错的 —— 完整测量与机制在 §5。
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

## 2b. 四个运维补丁在 0.1.3 上的状态（这次逐条实测，别再猜）

`patch -p1 --dry-run` 分别打在**纯净上游 0.1.3**（`git archive upstream/master`）与**我的 fork 分支**上，
再用只读 `grep` 看线上活文件：

| 补丁 | 纯净上游 0.1.3 | fork 分支 `86719d1` | 线上活文件里 |
|---|---|---|---|
| `01-ws-compression` | 可打（offset 71） | 可打（offset 71） | **在**：`server/index.js:686-692` 是启用形态（`threshold: 512`、`level 1`、`memLevel 7`、双向 `NoContextTakeover`）→ **升级没把压缩弄丢** |
| `02-spine-accept-http-url` | 可打（offset 3） | 可打（offset 3） | **在**：`public/js/assets.js:203-208` 的 `validSpine` 接受 `https?://…\.skel`，注释还留着"上游到 v0.1.3 都没修这个" |
| `03-frontend-to-oss` | **可打，rc=0**（干净应用） | 可打但 hunk#1 靠 **fuzz 2**（字体镜像改了那几行，位置漂了） | **没了**：`grep -c dl.lain42.top public/index.html` = **0** |

补了一条可复现的出路：新增 **`patches/game/03b-frontend-to-oss.font-mirror.patch`**（专给带字体镜像的树）。
在干净的 fork 分支树上 `patch -p1 --dry-run` **无 fuzz 无 offset、rc=0**，打上后与参考文件 `cmp` 逐字节相同；
产出的 `index.html` 实测：**26 条 `dl.lain42.top`、0 次 Google 字体主机、0 条相对 css/js**、本地字体表 1 条 ——
即"美术走 OSS + 字体离线"两个目标同时成立。旧的 `03` 依旧用于**不带镜像的上游树**（那边它干净可打），
两条各管各的基线；把 `03b` 打到纯净上游只能靠 fuzz 2 命中，所以别混用。
| **这张表现在可以一条命令复现**：`python3 scripts/check-game-patches.py --tree <checkout> --allow-fail 04-asset-manifest-cdn`
（只读：补丁打在 `tempfile.mkdtemp` 的副本上）。在 fork 分支 `86719d1` 上的实测输出：
`01 offset 71` / `02 offset 3` / `03 FUZZ 2` / `03b clean` / `04 FAILED`；
不带 `--allow-fail` 时退出码 **1**，带上是 **0**（两个退出码都不经管道，单独取过）。

`04-asset-manifest-cdn` | 数据部分天生对不上（`data/assets.json` 的 hunk FAILED）—— 它是**生成物的 diff**，本来就该用 `tools/apply-oss-assets.mjs` 重生成，不该拿补丁打 | 同左 | 清单是好的（4506 条 OSS），`tools/` 那两个 hunk 可打 |

所以带宽从 183 KB/s 涨到实测 567 KB/s，**不能**记在"压缩丢了"头上（压缩在）。目前能确认少掉的只有
`index.html` 那一层（CSS/JS/字体回到 node 出口）+ 0.1.3 本身更重；剩下要归因还得先开按路径日志。

### 2c. 重放之前的只读预检（已跑通，结论是"可以重放"）

`scripts/check-frontend-oss-mirror.py` 会在**临时副本**上打 03b，然后逐个验证 OSS 能不能接管：

```
python3 scripts/check-frontend-oss-mirror.py --tree D:/Code/Stronghold-Protocol-upstream
```

实测输出：**22/22 可安全重放**，`补丁后 index.html` 里 Google 字体主机 **0** 次；
其中 `fonts/fonts.css` 与线上不同，但脚本判定为"只差 CDN 前缀改写"（把绝对前缀还原成 `/` 后与活文件逐字节相同）——
这正是当初 `apply-oss-assets` 做的改写，不是旧内容。其余 21 个对象与线上活文件**逐字节相同**，
说明 0.1.3 没动这批 css/js，重放不会带出旧样式。

脚本本身可证伪：把补丁里某个键改成 `app/css/theme-DOES-NOT-EXIST.css` 再跑，输出 `可安全重放：21/22`、
`✗ css/theme-DOES-NOT-EXIST.css → HEAD 404`、rc=1 并明确写"先别动 public/index.html"。
它只读：不写游戏仓库（补丁打在 `tempfile.mkdtemp` 里）、不写线上、不写 OSS。

重放 03 的两种方式（都要人点头，因为 `public/index.html` 是热文件）：
上游 checkout 上 `patch -p1 < patches/game/03-frontend-to-oss.patch` 是干净可用的；
但若想在**带字体镜像的 fork 分支**上打，先重新生成该补丁（现在靠 fuzz 2 命中，属于迟早会碎的运气）。

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
5. ~~线上现在是 0.1.3，观战/踢人入口会自动解禁~~ —— **这条我先写错过，已被实测推翻，见 §5。**

## 5. `/healthz.app` 会骗人：线上是"混合版本"（15:09 实测）

客户端侧一切正常，但结论是**错的**那一半在这里纠正。两次独立测量：

- 版本探测：新 payload 用纯静态服务起在 `127.0.0.1:47901`，真 Chromium 里按应用自己的方式 `new Net({})` +
  `_probeServerInfo()` → `serverApp = "0.1.3"`、`verbAvailable()` 对三个 0.1.3 动词全部 `{ok:true}`（版本号驱动，符合设计）。
- 线级探测：`node scripts/probe-server-capability.mjs wss://sp.lain42.top/ws room.spectate room.kick room.removeSpectator room.join room.notARealVerb` →

  ```
    unknown  room.spectate          BAD_MSG: unknown type room.spectate
    unknown  room.kick              BAD_MSG: unknown type room.kick
    unknown  room.removeSpectator   BAD_MSG: unknown type room.removeSpectator
    handled  room.join              ROOM_NOT_FOUND:
    unknown  room.notARealVerb      BAD_MSG: unknown type room.notARealVerb   ← 正控制
  ```

  同一台机器上 `room.join` 回的是业务级 `ROOM_NOT_FOUND`（说明它认得这个类型），三个新动词回的是协议级
  `unknown type` —— 所以**这台服务器没有这三个能力**，尽管 `/healthz` 说自己是 0.1.3。

机制（读了两边的代码才敢写）：`server/net.js:587` 只认 `shared/protocol.js` 里 `C2S` 表的类型，不在表里就在
`net.js:589` 直接 `BAD_MSG unknown type …`，**根本走不到** `server/lobby.js` 的 `case`。
0.1.3 的 `shared/protocol.js:259` 有 `'room.spectate': {…}`；而线上的 `shared/protocol.js`（14:26 改过）
`room.join` 命中 1、`spectate` 命中 **0**，同目录的 `server/lobby.js`（14:25、48 KB）却已经是 0.1.3 那份。
也就是说 14:20 / 14:26 那两次部署是**混合文件**：`server/` 上了 0.1.3，`shared/` 还是 0.1.1。

对用户看到的行为：客户端点亮观战/踢人 → 点下去报一次错 → 客户端从这条 `BAD_MSG` 学到"这台服务器没有"，
之后才灰掉（`serverLacks` 的被动学习）。**能自纠，但要多点一次**，所以：
- 服务器侧要把 `shared/` 一起升到 0.1.3（`git checkout -- shared/` 之类，动的是热文件，需点头），或整份换 commit；
- 客户端侧的可选加固：连上之后用这种 bogus-code 探测主动学一次（代价是服务器日志里多几条 BAD_MSG），
  我没擅自加，因为它不是明确需求，而且现有被动学习已经能自纠 —— 但这是今天量出来的真实缺口，值得记着。

顺带记一条踩坑方法学：`name` 传 `'CapabilityProbe'` 时服务器**不回 welcome**，探测会永远超时；换成 `'Probe'` 就正常。
我第一次误判成"BAD_MSG 不回传 rid"，实际 rid 是回传的（`{"t":"error","code":"BAD_MSG","rid":2,…}`）——
是末尾那个自造动词的正控制没通过，才逼我去看真实事件流。**探测器必须自带正控制**，否则报的是探测器的 bug。
