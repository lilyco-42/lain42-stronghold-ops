# 17. 服务器上线改成「认 deploy/verified 自动切」——现场、判据与实测

2026-10-11。把生产从**手工重复线**（`production/upstream-0XX`）换成**机器人验过的那棵树**
（`deploy/verified`），并把它做成每天 04:30 自动执行的机制。顺手把服务端升到 0.2.4。

这份记录的重点有两处：① **生产拓扑和 `docs/12`/`docs/13` 写的已经不是一回事了**（下面是实读的）；
② 旧脚本的回滚会把生产**降级两版**，这个坑必须记下来。

## 1. 症状：0.2.4 进不来，客户端和服务端对不上

- 上游 0.2.4（2026-10-10T18:04:21Z，28 commits / 129 files）**根本进不来**：fork 的
  `auto-sync-upstream` 从 10-10 18:00 之后每 30 分钟**失败关闭**一次，唯一冲突是 `data/assets.json`，
  `deploy/prod` 卡在 0.2.3 约 13 小时。
- 玩家反映的「客户端和服务端不同步」，根因不在版本号，而在**两条线**：
  `deploy/prod`（服务端跑）和 `feat/skins`（客户端 payload 从它切）在 0.2.3 处**各自合了一次**，
  所以服务端和客户端真的是两棵不同的树。
- 服务器上还有**第三条线**：`production/upstream-023`。它不在 GitHub 上，只存在于游戏机。

## 2. 判据：`production/upstream-023` 就是 `deploy/prod` 的手工重贴版

不看 commit message，看 **blob 哈希**（内容寻址，跨仓可直接比）。生产分支相对上游 0.2.3 改了 17 个文件：

| 对比结果 | 文件 | 说明 |
|---|---|---|
| **7 个字节相同** | `data/servers.json`、`server/http/files.js`、`server/http/static.js`、`server/match/PlayerState.js`、`server/match/match/platform.js`、`server/match/player/round.js` … | 就是 fork 那套功能 |
| **2 个只差文案/注释** | `server/http/servers.js`（`'Not found'` → `'页面不存在 · Not found'`）、`shared/protocol.js`（一行注释） | 无功能差异 |
| **2 个只是整块移位** | `server/match/player/basics.js`（`cultivationFor()` 挪了位置）、`server/lobby.js`（`freezeSkins()` 挪了位置） | 代码一字未改，是手工重贴留下的乱序痕迹 |

**结论**：`deploy/prod@a8dc5091`（= 上游 0.2.4 + fork 全部功能）在功能上是它的**超集**，
唯一生产独有的是 `public/index-oss.html`（106 行，OSS/CDN 版入口，本地路径全改写成
`https://dl.lain42.top/downloads/stronghold-protocol/app/…`）——它**不在 `feat/skins`、也不在
`deploy/prod`**，只存在于服务器那个分支上。

> `index-oss.html` 不是手写的：它是 `scripts/build-oss-app.py` **生成**的产物（README「部署顺序」
> 第 3 步）。所以它不是"某个分支漏提交的文件"，而是**线上生成物**。新脚本因此把它
> **从当前树原样带过去**，而不是去重新生成（重新生成要跑 OSS 构建，属于另一件事）。

## 3. 生产拓扑真相（和 `docs/12`/`docs/13` 写的已经不同，以下为 2026-10-11 实读）

`/opt/Stronghold-Protocol*` **三个目录是同一个仓库的 git worktree**（`git worktree list` 互相可见）：

| 目录 | 分支/提交 | 版本 | 角色 |
|---|---|---|---|
| `/opt/Stronghold-Protocol` | `master` `7ca079bd` | **0.2.1** | 旧树，没在跑；**但它是旧脚本的回滚目标** |
| `/opt/Stronghold-Protocol-candidate` | `production/upstream-023` `56611aa8` | 0.2.3 | 切换前正在跑 |
| `/opt/Stronghold-Protocol-next` | detached `1db8e510` | 0.2.3 | 干净上游；**持有真正的 `node_modules`（148 M）**，`-candidate/node_modules` 是软链 |

`stronghold.service` 的 drop-in 才是真相（`/etc/systemd/system/stronghold.service.d/`）：
`20-sp-room-api.conf`（房间 API 三个环境变量 + `NODE_OPTIONS=--import=…/preload.mjs`）、
`30-upstream-023.conf`（`WorkingDirectory` + `ExecStart` 指向 `-candidate`）、`oom-protect.conf`。

> ⚠️ **回滚会降级两版**：`sp-upgrade-023*.sh` 的 rollback 是**删掉 drop-in** —— 删了就回落到
> `/opt/Stronghold-Protocol`（0.2.1）。一次失败的 0.2.4 部署会把生产从 0.2.4 打到 0.2.1。
> 新脚本的回滚目标是**切换前正在跑的那棵树**（现读 `systemctl show -p WorkingDirectory`），只退一版。

**另外两个只有实读才知道的事实**：

- 站点**在 Cloudflare 后面**（响应头 `Server: cloudflare`）。切换前 `/webfonts/google/google.css`
  源站 **404**，靠 CF 的 `immutable` 边缘缓存（`Last-Modified: Fri, 09 Oct 2026 15:52:41 GMT`）在撑。
- `public/fonts`（Bender / Novecento）在**源站 / CF / CDN / 备份包**四处**全 404** →
  显示字体**当前就是坏的**（`index.html` 引 `/fonts/fonts.css`）。属**既有**问题，不是本次引入，
  靠 `theme.css` 回退。备份包 `/opt/sp-assets-upload.tar`（681 M）里只有
  `audio band bond char enemy item module prof skill spine token ui`，**没有 fonts**。

## 4. 这也解释了「客户端和服务端不同步」

生产分支相对上游只改了 `public/js/assets.js`（CDN `validSpine` 补丁）——**`public/js/` 里没有任何皮肤 UI**。
但服务端**是**支持皮肤的（`shared/protocol.js` 有 `room.skins`、`server/lobby.js` 有 `freezeSkins`）。
于是：**APK/桌面客户端（从 `feat/skins` 切）能选皮肤，浏览器客户端不能**（线上 `/js/ui/skinPicker.js` 404）。
`deploy/prod` 有皮肤 UI（`skinPicker.js` / `skins.js`，`public/js/main.js` 会引用）、
皮肤数据（`data/skins.json` / `skins-installed.json`）、自托管字体（`public/webfonts`，113 个文件）。

## 5. 新机制

```
sp-upstream-fetch.timer（~32 分钟）
   └─ sp-upstream-fetch.sh  →  裸仓 /var/lib/sp-upstream-sync/repo.git
        ├─ sganggs/Stronghold-Protocol  master        → refs/heads/upstream-master
        ├─ lilyco-42/…/Stronghold-Protocol deploy/verified → refs/heads/verified-deploy   ← 生产只认这个
        └─ lilyco-42/…/Stronghold-Protocol deploy/prod     → refs/heads/fork-deploy-prod（看「合了没过闸门」用）

sp-auto-upgrade.timer（每天 04:30，Persistent，抖动 ≤5 分钟）
   └─ sp-auto-upgrade.service → sp-auto-upgrade.sh
        ① 解析 verified-deploy 的 SHA；和 /var/lib/sp-deploy/deployed.sha 相同 → 空操作退出
        ② 暂存到 /opt/Stronghold-Protocol-<sha 前 8 位>
             git archive（**不碰共享 .git**）+ 软链当前树 node_modules
             + cp -al 硬链当前树 public/assets（零额外磁盘）+ 带过 index-oss.html
             + transform-assets.mjs 切 CDN
        ③ 隔离端口验证：游戏 5199 / 房间 API 5188，**生产一动不动**
        ④ 换 drop-in（90-auto-deploy.conf，排最后）+ 停用 30-upstream-*.conf + 重启
        ⑤ 三处健康闸门：本地 healthz / 房间 API 401+200 / 公网代理 401+200
        ⑥ 任一不过 → 回滚到**切换前那棵树**；全过 → 记 SHA + 清旧树（留 3 个）
```

**为什么认 `deploy/verified` 而不是 `deploy/prod`**：`deploy/prod` 只是「机器人合完了」；
`deploy/verified` 是「合完并且**跑过全部闸门**（单测 + `npm run golden` + ext-surface）之后」才发布的同一个 SHA。
闸门没过 → `deploy/verified` 不动 → 服务器自然不升。

**为什么单独开一个 timer 而不是放进 `sp-maintenance.d/`**：`sp-maintenance.sh` 会把**成功**的任务
改名成 `.done`（「成功的任务不再重复跑」）——那是给一次性迁移设计的。自动升级是**周期性**的，
放进去会在第一次成功后**把自己永久关掉**。

**为什么只用时间做闸门**：2026-10-05 的教训是「用在线人数当条件」会在高峰期人数短暂波动时
误触发重启、把全服踢下线（见 `sp-maintenance.sh` 顶部注释）。04:30 这个点本身就是闸门；
脚本会记录当时的在线人数供事后核对，但不拿它当条件。

## 6. 实测（2026-10-11，命令都是本轮实跑的）

切换前基线：`app 0.2.3`、`humans 100`、`matches 76`、`rooms 78`。

隔离端口 5199 验证 → 切换 → 线上复核：

| 路径 | 切换前 | 切换后 |
|---|---|---|
| `/healthz` | `app 0.2.3` `build 8379d7c89642` | **`app 0.2.4` `build a9c845b57db0`** |
| `/js/ui/skinPicker.js` | **404** | **200（5327 B）** ← 不同步已修 |
| `/js/ui/skins.js` | 404 | **200（10220 B）** |
| `/data/skins.json` | 404 | **200（21731 B）** |
| `/js/ui/loadoutStats.js` | — | 200（4809 B） |
| `/webfonts/google/google.css` | 源站 404（只有 CF 缓存） | **200（455869 B，源站自带）** |
| `/servers.json` | 200 | 200（607 B，生产功能已保留） |
| `/index-oss.html` | 200 | 200（7734 B，生产专有文件已保留） |
| 房间 API 未认证 | 401 | 401 |
| 房间 API 已认证 | 200 `schemaVersion:1` | 200 `schemaVersion:1` |

- 依赖：`package.json` / `package-lock.json` 在 0.2.3→0.2.4 之间**只改了版本行**，`node_modules` 直接复用。
- 素材：上游 0.2.4 只改了清单的 `hash` 和一个 token 的 `spineLocal` 字段，**115 个已装皮肤干员的基础模型 0 个变动**；
  该 token 的 `_ambienceSynesthesia_4` skel/atlas/png 与头像在**源站磁盘和 CDN 上都已经存在**（逐个 curl 验过）。
- 磁盘：暂存树 735 M，但 `public/assets`（674 M / 9418 文件）是**硬链**，`df` 前后无变化。
- 切换后 90 秒：`humans 38`、`matches 20`（玩家在回流）。

## 7. 操作要点 / 坑

| 坑 | 说明 |
|---|---|
| **drop-in 是字典序叠加的** | 新 drop-in 必须排最后。`90-auto-deploy.conf` 排最后；`30-upstream-*.conf` 一旦残留且排在后面会**静默赢掉**，所以脚本显式把它改名成 `.disabled` |
| **回滚目标不能靠"删 drop-in"** | 删了会回落到 0.2.1。新脚本把回滚目标写成 drop-in 的**内容**（切换前那棵树的路径） |
| **服务器上 SSH 到 GitHub 是坏的** | `git@ssh.github.com:443` → `Permission denied (publickey)`；`git@github.com` → `No ED25519 host key is known`。三条 URL 里**只有 HTTPS 那条通**，`sp-upstream-fetch.sh` 的循环就是为此 |
| `git -c key=val` 必须放在子命令**之前** | `git -C repo fetch -c a=b …` 会打印 usage 而不是报错，很容易看漏 |
| 运行中的 run 拿不到 `--log-failed` | 用 `gh api repos/<r>/actions/jobs/<job_id>/logs --allow-escape-sections`，配 `sed` 去 ANSI |
| `gh` 在无关 worktree 里没有默认仓库 | run id 是**按仓库**的，必须 `-R lilyco-42/Stronghold-Protocol` |

## 8. 手工操作

```bash
# 手动立刻上线（幂等；SHA 没变就是空操作）
/usr/local/sbin/sp-auto-upgrade.sh
tail -f /var/log/sp-auto-upgrade.log

# 手动抓一次上游/验证分支
/usr/local/sbin/sp-upstream-fetch.sh
tail -f /var/log/sp-upstream-sync.log

# 看定时器
systemctl list-timers sp-auto-upgrade.timer
```

**回滚一版（0.2.4 → 0.2.3）**：

```bash
cat > /etc/systemd/system/stronghold.service.d/90-auto-deploy.conf <<'CONF'
[Service]
WorkingDirectory=/opt/Stronghold-Protocol-candidate
ExecStart=
ExecStart=/usr/local/bin/node22 /opt/Stronghold-Protocol-candidate/server/index.js
Environment=SP_ROOM_GAME_ROOT=/opt/Stronghold-Protocol-candidate
CONF
systemctl daemon-reload && systemctl restart stronghold.service
rm -f /var/lib/sp-deploy/deployed.sha     # 否则下次自动升级会以为已经部署过了
```

> `/opt/Stronghold-Protocol-candidate`（0.2.3）在切换后**故意保留**，它就是回滚目标。
> 自动清理只删 `/opt/Stronghold-Protocol-<8 位 hex>` 形状的暂存树，且保留最新 3 个、绝不删正在跑的。

## 9. 未做 / 已知缺口

- ~~**客户端 payload 还停在 0.2.3**~~ → **已发**：`payload-v0.2.4-c40`（`publish=ready`）+
  玩家 Release `v0.2.4-c40`（六个形态、六个匿名 HEAD 全 200）。客户端那一刀完整记在
  `docs/18-client-0.2.4-cut.md`。
- `public/fonts`（Bender / Novecento）仍缺，需从 OSS 素材包补，本机没有。
- `production/upstream-0XX` 这条手工重复线**建议废掉**（本次已实质弃用：生产现在直接吃 `deploy/verified`）。
  否则每次上游发版都要手工重贴一遍 —— 就是这次 `data/assets.json` 卡 13 小时的同类病根。
- 机器人侧的 `tools/merge-assets-skins.mjs`（把 `data/assets.json` 的皮肤合并**自动**做掉）
  还没提交、也没接进 `auto-sync-upstream.yml`。
- `ci.yml` 的 ext-surface 闸门缺 `upstream` 远端（`actions/checkout` 只建 `origin`），
  导致那条闸门在 CI 里**从来跑不起来**，是各分支基线唯一的红。

## 10. 本仓（游戏 fork）的发布与 tag 约定

游戏 fork 在此之前**一个 Release 都没有**，tag 也只到 `v0.2.3`。这一轮补上了第一个：
**`v0.2.4-lain42`** → `a8dc509118ac50f8db80d008cc9bcb06cd9df34c`（= `deploy/verified` = `deploy/prod`，
即线上正在跑的那棵树）。

### 为什么带 `-lain42` 而不是就叫 `v0.2.4`

本仓的 `v0.1.0` ~ `v0.2.3` 与上游是**逐字节相同**的 tag —— 实测 `v0.2.3` 两边都是 `1db8e510`，
也就是本仓**从来没自己造过 tag**。而上游的 `v0.2.4` 是 `bc50cac0`，我们的部署树是它的**后代**
（`a8dc5091`，`git rev-list --count bc50cac0..a8dc5091` = **78**）。

如果这里也叫 `v0.2.4`，同一个 tag 名就会指向两个不同的 commit：

- `git fetch upstream --tags` 会报 `would clobber existing tag`，而本仓持续合并上游，这条会一直挡路；
- `git describe` 会把两棵树混起来 —— 而 `describe` 正是**客户端打包的出处闸门**在读的东西
  （`check-payload-provenance.mjs` 要求它末尾带 `-g<7+ 位 hex>`）。

**约定：本仓自己的发布一律带 `-lain42` 后缀，与上游的 tag 名永不重合。**

### Release 里放什么

**不放资产。** 本仓是部署 fork，不发整合包（玩家的下载在客户端仓）。
Release 只是"哪一刻部署了哪棵树"的记录，正文写清：commit、`/healthz` 读数、
与上游的关系（包含上游 v0.2.4 + 78 个 commit / 199 个文件）、怎么复现这棵树、
以及"升级不靠手打 tag"（升级的输入永远是 `deploy/verified` 这个分支）。

复核：

```bash
gh release view v0.2.4-lain42 -R lilyco-42/Stronghold-Protocol --json tagName,isDraft,targetCommitish
gh api repos/lilyco-42/Stronghold-Protocol/git/refs/tags --jq '.[].ref'   # 不应出现裸 v0.2.4
gh api repos/sganggs/Stronghold-Protocol/git/ref/tags/v0.2.4 --jq '.object.sha'  # 上游那个不许被动过
```
