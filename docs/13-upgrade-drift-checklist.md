# 13 · 升服务器 / 换基线之后的漂移核对单（2026-10-05 每一步都实跑过）

这份单子存在的理由：这台机器对游戏仓库的定制**不在 git 里**（运维补丁、OSS 素材、本地字体镜像、
payload 里的 17 个上游没有的文件）。基线一换，这些东西不会自动跟上 —— 今天一天里就发生了两次：
14:20 的覆盖式部署把 `public/index.html` 换回上游版（`03-frontend-to-oss` 静默失效），
以及 fork 合并上游 `bd892a4` 后 `#110` 新增的 2 条 BGM 在本地磁盘上不存在（`assets.test.js` 直接红）。

顺序不要换：先让代码树自洽，再让素材自洽，最后才碰产物与线上。

## 1. 代码树：合并 + 全量测试

```
cd D:/Code/Stronghold-Protocol-upstream
git fetch upstream
git rev-list --left-right --count upstream/master...HEAD     # 左边非 0 就是落后了
git merge --no-edit upstream/master                          # 用 merge，别 rebase：不改写已推出去的历史
npm test --silent                                            # 全量（今天 3637 项）
```

今天实测的两次数字：并行整跑时 `test/sim/robustness.test.js` 的 CPU 阈值闸会红
（best-of-3 0.52 / 0.50 ms per tick，本机负载），单独跑该文件 **35/35 通过**（878–1795 ms）——
判据是 `git diff upstream/master..HEAD -- server/sim test/sim` 为空（这条闸测的东西没被我们改过）。
**别把这条 flake 当回归，也别拿它当通过**：要么单独复跑确认，要么承认没测。

## 2. 素材：新清单引用的文件必须在磁盘上

```
node tools/fetch-assets.mjs          # 只补差异（今天：ok 2 / skipped 4017 / missing 1 / errors 0，2.3 MB）
node --test test/assets.test.js      # 46/46；它有一条「每个清单路径都在磁盘上」
```

今天暴露的就是 `#110` 新加的两条 BGM：`public/assets/audio/bgm/m_bat_corrosion_{intro,loop}.mp3`。
补完**必须把生成的清单还原**：`fetch-assets` 会把 `data/assets.json` 的 `stats.bytes` 改掉
（`hash` 与 `files` 不变），那是无内容差异，但会让 payload 的 `build.json` 标成 `dirty:true`：

```
git checkout -- data/assets.json
git status --short                   # 干净才继续
```

## 3. 运维补丁：一条命令看漂移

```
python3 scripts/check-game-patches.py --tree D:/Code/Stronghold-Protocol-upstream \
  --allow-fail 04-asset-manifest-cdn
```

今天的输出（fork `86719d1` 基线）：`01 offset 71` / `02 offset 3` / `03 FUZZ 2` / `03b clean` /
`04 FAILED`（容忍：那是生成物的 diff，本该用 `tools/apply-oss-assets.mjs` 重生成）。
退出码单独取：不带 `--allow-fail` 是 **1**，带上是 **0**。
`offset`/`FUZZ` 不算坏但迟早会碎 —— 看到 FUZZ 就顺手重新生成那条补丁（`03b` 就是这么来的）。

## 4. 网页版要上线前：预检 OSS 接管

```
python3 scripts/check-frontend-oss-mirror.py --tree D:/Code/Stronghold-Protocol-upstream
```

今天：**22/22 可安全重放**（21 个与线上逐字节相同，`fonts/fonts.css` 只差 CDN 前缀改写，其 6 个字体对象全 200）。
塞一个不存在的键进去会变成 `21/22` + `HEAD 404` + rc=1。这一步的意义是：**动热文件之前**就知道会不会白屏。

## 5. 客户端产物链：闸门先跑，再谈发布

```
# 客户端仓库（不本机编译 exe/apk，一律 Actions）
node tools/package-client.mjs --server sp.lain42.top --game D:/Code/Stronghold-Protocol-upstream --out <dir>
node tools/check-payload-offline.mjs <dir>                                  # 暂存 payload
node tools/check-payload-offline.mjs --zip <apk>                            # 出厂 APK（整包 grep 会漏）
node tools/check-payload-offline.mjs <exe>/resources/www                    # 出厂桌面（asar 只有 ~29.6 KB 的壳）
```

今天的数字：合并基线后重新打的是 **payload-c9** —— 4368 文件 / 295.3 MB，`describe v0.1.3-14-gdae0a67`，
tar `221,352,079 B`，sha256 `a421f174dae8cd9a7aa69fb687d1f8de9118f9be01a23efc25414177a4f45af7`，
tar 内含那 2 条 corrosion BGM，离线闸门 0 问题。c8（4366 文件，`v0.1.3-8-g86719d1`）就此作废。

`game-client.patch`（客户端仓库打在 payload 上的那 3 文件 7 hunk）也要跟着复验：
合并后仍 `APPLIES`（`index.html` 2 / `net.js` 3 / `room.js` 2）。**它的 hunk 数、文件数、
`docs/PACKAGING.md` 里那句数字三处必须一起改**，否则下次没人知道谁过期了。

## 6. 版本信号别只信 `/healthz.app`：拿线级能力对一遍

```
node scripts/probe-server-capability.mjs wss://<host>/ws   room.spectate room.kick room.removeSpectator room.join room.notARealVerb
```

判读只看 `verdict`：`unknown` = 类型表里没有（这台机器没这能力），`handled` = 认得（回的是业务级错误）。
今天线上实测：三个 0.1.3 动词全 `unknown`，`room.join` 是 `handled`，自造那个 `unknown`（正控制过）——
而 `/healthz.app` 却报 `0.1.3`。原因是 `shared/` 与 `server/` 版本不一致（详见 `docs/12` §5）。
**探测器的 name 要用短名字**（`'CapabilityProbe'` 会收不到 welcome，全是超时）。

## 7. 服务器侧收尾（都要人点头）

- 部署要走**可切 commit**，别再用覆盖式（今天 238 个 `M` 没备份，回滚只能反着打 `git diff`）。
- `data/assets.json` 在线上是 CDN 改写版，**不能进 payload**（进了就绑死 OSS、离线白屏）。
- 素材差集：线上磁盘 3995 vs payload 4050，缺的 55 个是 `ui/emoticon` 36 + `ui/guide` 19（`docs/05` 追加节）。
- 版本信号只有 `/healthz` 的 `app`；`PROTOCOL_VERSION` 上游到今天仍是 **1**（`shared/constants.js:3`），
  `package.json` 也还是 **0.1.3** —— 所以 `expect_app` 暂时不用改，但每次合并后**要重新看一眼**，
  上游哪天悄悄升了协议，跨版本矩阵就得重测（`docs/09` 那张矩阵）。
