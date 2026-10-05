# AGENTS.md — 这个仓库怎么被 AI 操作

lain42.top《卫戍协议：盟约》的**运维改动集**：事故复盘、已上线的改动、可复用的补丁脚本、测量数据。
这里不放业务代码，只放「对线上动过什么、为什么、怎么验证、怎么回滚」。

## 1. 相关仓库与机器（先读这一节再动手）

| 位置 | 是什么 | 注意 |
|---|---|---|
| `root@lain42.top` | 生产机（阿里云 2 核 / 出口 3 Mbps） | **`ssh`/`scp` 必须带 `-i ~/.ssh/lain42.pem`**，默认 `id_ed25519` 会被拒 |
| `/opt/Stronghold-Protocol` | 游戏**线上 checkout**，`stronghold.service` 直接跑它，静态与 `data/` 按磁盘现状服务 | 改这里 = 立刻影响正在玩的人 |
| `/opt/sp-game-src` | 同 HEAD 的干净镜像，**没有任何服务引用** | staging/构建用这个，别动上面那份 |
| `/opt/online-platform` | Flask 大厅（`online-platform.service`，127.0.0.1:5000） | 与游戏是**两个进程两个端口**，重启大厅不杀对局；**另一个会话会往这里部署**（2026-10-05 13:48 有过一次 ads 改动 + 重启），动它之前先 `md5sum` 对一遍 |
| `/etc/pingap.toml` | 443 反代。`[servers.https].locations` 里与这个游戏相关的顺序（实测第 56-64 行）：`sp_healthz`、`sp_data`、`sp_sim`、`lobby_sub_ws`、`lobby_sub`、`sp`、`sp_ws`、`lobby`、`lobby_ws` | 改前先 `pingap -c /etc/pingap.toml -t`；reload 有 1–3 s 抖动；**pingap 不能停**；新 location 必须排在 `sp`（`path="/"`）**之前** —— 上面的 `sp_data`/`sp_sim` 就是靠这个顺序生效的 |
| `dl.lain42.top`（47.101.28.199，AliyunOSS） | 美术/spine/字体/素材清单，以及客户端 payload | 与本机（8.153.102.122）不同源，所以素材不占本机网卡；**payload 是永久地址，不要覆盖已发布版本** |
| `sganggs/Stronghold-Protocol` | 游戏上游（GPL-3.0） | 对 fork 账号只有 `pull: true, push: false` → 任何贡献走 fork→branch→PR；本仓库的分支改动**只在用户明确要求时才提 PR** |
| `lilyco-42/StrongholdProtocolClient` | 桌面/安卓客户端（Electron + Capacitor） | 打包细节看**那个仓库的 `AGENTS.md`**；`build-clients.yml` 是唯一构建入口 |
| 本机 `D:/Code/` | `Stronghold-Protocol-upstream`（blob:none clone，origin=我的 fork）、`StrongholdProtocolClient`、下载产物在 `_artifacts/` | 之前这里没有本地 clone，2026-10-05 才建的 |

## 2. 红线（违反过一次就要写进 README「硬规矩」）

1. **默认只读**。任何 `systemctl restart` / 写 `/opt` / 写 `/etc` 都要用户明确点头 —— 重启 stronghold 会杀掉所有进行中对局（状态只在内存，没落盘）。
2. **`public/` 和 `data/` 是热文件**：线上直接按磁盘现状服务，编辑那一刻就命中玩家。要改先在 `/opt/sp-game-src` 或本地 staged 副本里做。
3. **不覆盖已发布的 payload / Release 资产**（`dl.lain42.top/.../client/sp-client-payload.tar.gz` 等是永久地址）。
4. **不在本机编译 exe/apk**，一律 GitHub Actions。
5. `/tmp` 是 tmpfs（内存盘），大文件放 `/var/tmp`。
6. `pgrep -f 'pingap -c …'` 会匹配到自己的 bash → 用 `pgrep -x pingap`。
7. `LimitNOFILE=` 必须写 `软:硬` 两段。

## 3. 文件约定

- `docs/NN-主题.md`：**一次工作一份编号文档**，写「现象 → 因果链（带实测行号/数字）→ 改法 → 验证 → 回滚」。追加新编号，不要重排旧编号，也不要在标题里写总数。
- `patches/game/*.patch`：只用于**上游游戏仓库那些 LF 文件**的 `git diff` 产物，可直接 `patch -p1`。
- `patches/pingap/`、`patches/systemd/`：要粘进系统文件的片段。
- `scripts/patch-*.py`：**线上文件是 CRLF 时不能用 .patch**（`.gitattributes` 强制 `*.patch text eol=lf`，CR 会被吃掉 → `Hunk FAILED (different line endings)`）。改用这种幂等脚本，五条不变量：
  1. 幂等（已是目标状态就退出 0）；
  2. 锚点按行精确匹配，0 个或多于 1 个匹配都直接退出非零，绝不猜；
  3. 每个文件都验证过锚点、且 `compile()` 过即将写盘的源码，**才**开始写；
  4. 写之前留 `<file>.bak-<标签>`，且已存在就不覆盖；
  5. 用 `newline=''` + `splitlines(True)` 保留每个文件自己的换行符（顺手全转 LF 会造出几千行假 diff）。
  支持 `--dry-run`。
- `scripts/test-*.py`：夹具由被测脚本自己的常量拼出来（`importlib` 直接 import 被测脚本），这样测试和脚本不会各说各话。跑法 `python3 scripts/test-<name>.py`，退出码即结论。
- 改完代码要**同步 README**：`改动总览`表、`目录`树、必要时 `回滚`表和 `⚠️ 几条硬规矩`。

## 4. 什么才算证据

- 结论来自**这一轮真的跑过的命令**，产物名/行号/字节数要有对应输出在上面。
- 服务的状态用 `systemctl show` / `ss -ltnp`，不用「我记得」。
- 版本信号只有 `GET /healthz` 的 `app`（跨源要 pingap 的 `sp_healthz_cors`；自建服没开 CORS 就读不到）。
- CI 结论用 `gh run view --json conclusion`，**`gh run watch` 的 shell 退出码不是结论**（末尾接 `tail` 就变成 tail 的退出码）。
- 产物要下载拆开验（asar 里的函数名、payload 里的标记、APK 里的开关、asset `digest` == 本机 `sha256sum`）。
- 测试写完要做**变异验证**（故意把脚本改坏，确认对应检查真的变红），否则检查可能是空的。
- 任何"探测器"必须自带**正控制**：今天写的线级能力探测第一版全返回 TIMEOUT，我误判成"服务器不回 rid"（其实回了），
  真正原因没人猜得到 —— `hello` 里的 `name` 太长（`'CapabilityProbe'`）服务器直接不回 welcome，换成 `'Probe'` 就通。
  是末尾那个"自造动词本该 unknown"的正控制没过，才逼我去看真实事件流。探测类脚本没有正控制就等于在报自己的 bug。
- 版本号不是能力：`/healthz.app` 说 0.1.3 也可能 `room.spectate` 回 `unknown type`（混合部署）。能力要用
  `scripts/probe-server-capability.mjs` 看 verdict，别拿 `app` 字段当结论。

## 5. 当前状态（2026-10-05）

- 线上游戏**已是 0.1.3**：2026-10-05 14:20:24 CST 有一次**覆盖式**部署（`/healthz.app=0.1.3`、`room.spectate`
  命中 13 处，可 `git log` 仍停在 `8b10625`、238 个 `M`、没留备份）。那次部署把 `public/index.html` 换回上游版，
  OSS 前端改写与字体镜像一起没了；素材清单没受影响（4506 条 OSS）。全在 `docs/12-prod-0.1.3-overlay.md`。
  `PROTOCOL_VERSION` 三个版本都是 1 → 升不升级**不能**靠 socket 协商。
- 客户端已发布跨版本兼容产物（见客户端仓库 Release `v0.1.3-compat` 与 `docs/09-client-release-line.md`）；
  fork 分支已合并上游 `bd892a4`（0 behind，`git rev-list --left-right --count upstream/master...HEAD` 实测 `0 13`），
  待发布的 payload 是 **c10**（`v0.1.3-16-g603b94c`，sha256 `234ee962…ec36`；c9 作废）。
  换基线之后怎么核对、以及"c10 什么时候才需要重打"，见 `docs/13-upgrade-drift-checklist.md`。
- 大厅注册 400 的修复**代码已备好、回归测试全绿、线上未部署**：`docs/10-lobby-register-400.md`。
- ~~线上是混合版本~~ **2026-10-05 15:59 复测：这条已过时**。服务在 15:33:25 CST 又被重启过一次（不是本会话做的，本会话全程只读），
  线级探测现在报 `room.spectate`/`room.kick`/`room.removeSpectator`/`room.join` **全部 handled**（rc=0，正控制仍 unknown）。
  但线上那份 checkout 的 git 状态**不能当版本证据**：HEAD 还停在 `8b10625`（10-03）而有 177 个文件处于 modified，
  `shared/protocol.js` 的 md5 `a17f47ae…` 与任何 git 树都不同 —— 比 v0.1.3 多一条**手写**进 `hello` 的 `z` 校验（`docs/12` §6 附原行）。
  下一次覆盖式升级若不先把这条 diff 出来，它会静默消失。诊断与复现命令在 `docs/12-prod-0.1.3-overlay.md` §5、§6。
- 大厅 `wsgi.py` 一天里被外部改过两次（13:48 变全 LF、14:10 再变，md5 `24c6a6eb…`→`43c3b939…`→`3918ab4b…`），
  `config.py` 未变（`b2c9493a…`）；`patch-lobby-skip-email-verify.py --dry-run` 在最新字节上重跑仍 rc=0（见 `docs/10` 末节）。
  **推论**：动大厅前必须重新 `--dry-run` + `md5sum`，不能沿用早上的结论。
- `docs/08-resource-split-audit.md` 结论：素材层已彻底分离（清单 4451 条指向 OSS，同源只剩 8 条），
  node 只剩 `/ws` + `index.html` + `/data` + `/sim`。
