# 18 · 客户端 0.2.4 那一刀（版本戳 → payload c40 → 六个形态）

服务端那一半见 `docs/17`（`deploy/verified` 自动切，线上已 `0.2.4` / build `a9c845b57db0`）。
这份记客户端那一半：**壳的版本戳**、**payload 怎么切出来的**、**独立复核了什么**，以及一个关于
`code.sha256` 的实测发现。

每一条都留了复核命令；数字都是 2026-10-11 的实测值，**会变，别照抄**。

---

## 0. 起因：壳的版本戳还停在 0.2.3

服务端切到内核 0.2.4 之后，客户端仓库 `main` 的 `package.json` 还是 `0.2.3` —— 正是 `4cce3aa7`
（`0.2.2 → 0.2.3`）那一刀要修的那种错位："payload 的内核是 0.2.2，壳就不该显示 0.2.1"。

而且它**会真的拦住构建**：`build-clients.yml` / `build-tauri.yml` 的版本闸门要求 payload 内
`build.json` 的 `game.app` 等于本仓库 `package.json` 的 `version`（`expect_app` 留空时）。
0.2.4 的 payload 配 0.2.3 的壳会被闸门拦下。

## 1. 版本戳：十处一次写全（PR #7 → squash `0c75562e`）

与上一刀**同形**，纯字符串替换，`git diff --numstat` 合计 **10 files / +16 / -16**（没有整文件重写）：

| 文件 | 改动 |
|---|---|
| `package.json`、`desktop/package.json`、`mobile/package.json`、`tauri/package.json` | `version` 0.2.3 → 0.2.4 |
| `desktop/package-lock.json`、`mobile/package-lock.json` | 根与 `packages."".version` 各一处（共 2 处/文件） |
| `mobile/android/app/build.gradle` | `versionCode 203 → 204`、`versionName "0.2.3" → "0.2.4"` |
| `mobile/ios/App/App.xcodeproj/project.pbxproj` | `CURRENT_PROJECT_VERSION` ×2、`MARKETING_VERSION` ×2 |
| `tauri/src-tauri/Cargo.toml` | `version` |
| `tauri/src-tauri/tauri.conf.json` | `version` |

⚠️ `mobile/package-lock.json` 里的 `"buffer-crc32": "~0.2.3"` 是**依赖版本**，不动 —— 全文件替换时
它不会命中 `"version": "0.2.3"` 这个模式，但复核时要确认它还在（`grep -n '0\.2\.3' mobile/package-lock.json`
应当**只剩这一行**）。

**没有测试断言仓库自身版本号**，所以这一刀不会把 CI 弄红：`test/picker-probe.test.js:192` 的
`app: '0.2.3'` 是假主机 `host.example` 的 `/healthz` **响应夹具**（同文件 `:203` 用的是 `'0.1.3'`），与版本无关。

CI（`ci.yml`，`npm test` = `node --test`，零依赖）run `38125833535`：ubuntu-latest **8s**、windows-latest **21s**，两个都 pass。

```bash
# 复核
gh api repos/lilyco-42/StrongholdProtocolClient/commits/main --jq '.sha[0:8],.commit.message'
```

## 2. payload 怎么切出来的（`cut-payload`，run `38125898931`）

14 个真实步骤**全绿**（含六道闸门）。派发参数：

| 输入 | 值 |
|---|---|
| `game_ref` | `feat/skins` = `6d48a55fd95703a5a918f421910a0da668eb1c41` |
| `base_payload_release` | `payload-v0.2.1-c29`（素材那半的来源） |
| `server` | `sp.lain42.top` |
| `out_tag` | `payload-v0.2.4-c40` |
| `asset_name` | `sp-client-payload-0.2.4-c40.tar.gz` |
| `publish` | **`ready`** |

### 为什么是 `publish=ready`，不是 `draft`

`build-clients.yml` / `build-tauri.yml` 取 payload 用的是**匿名** `curl -fL "$URL"`（没有任何 token），
而 **Draft Release 的资产匿名访问 403** —— `docs/09` 第 13 行早就写过这条。实测确认这条路径通：

```
匿名 HEAD payload-v0.2.4-c40 的 tar → HTTP 200，Content-Length: 605,341,357（与本机 `gh release view` 的 size 相同）
```

### 版本线怎么读

`0.2.3-cNN` 里的 `cNN` 是**客户端计数器**，不是游戏版本：`app 0.2.3` + 计数 37/38/39。
所以游戏 0.2.4 的第一刀是 **c40**（`payload-v0.2.4-c40`），玩家 Release 也应当是 `v0.2.4-c40`。

### 切出来的 Release（`payload-v0.2.4-c40`，非 draft）

| 资产 | 大小 |
|---|---|
| `sp-client-payload-0.2.4-c40.tar.gz` | 605,341,357 B |
| `sp-client-code-v0.2.4-c40.tar.gz` | 10,453,596 B |
| `sp-client-manifest-v0.2.4-c40.json` | 619 B |

manifest 的关键字段：

```json
{ "cut": "payload-v0.2.4-c40", "version": "0.2.4",
  "game": { "app": "0.2.4", "commit": "6d48a55fd95703a5a918f421910a0da668eb1c41",
            "describe": "v0.2.3-100-g6d48a55f" },
  "server": "sp.lain42.top",
  "code": { "sha256": "sha256:0f287b89…a6b528", "files": 659, "bytes": 10453596 },
  "art":  { "digest": "sha256:dffe9b67…d90944", "files": 13655, "bytes": 833146452 },
  "artFrom": "payload-v0.2.1-c29", "minShell": 1 }
```

`describe` 末尾有 `-g6d48a55f`、`dirty:false` —— 这两条正是 `check-payload-provenance.mjs` 要的。

## 3. 独立复核（不采信 CI 的自述）

把**已发布的** tar 流式列一遍（不落 605 MB 到磁盘），再对：

| 量 | 实测 | 与 manifest 对得上吗 |
|---|---|---|
| tar 条目 | 16,258（含 1,944 个目录项） | — |
| 文件总数 | **14,314** | = 659 (code) + 13,655 (art) ✓ 精确相等 |
| `assets/` | **13,655 文件 / 833,146,452 B（794.6 MiB）** | 与 `art.files` / `art.bytes` **逐字节相同** ✓ |
| 整包 | 874,161,913 B（833.7 MiB） | — |
| 布局 | 顶层是 `./index.html` | 不是 `www/...` 包一层 ✓ |

也就是说 **`art` ≡ `assets/`，`code` ≡ 其余全部**（`sim` 286 / `js` 142 / `webfonts` 113 / `dev` 28 / `data` 25 / `css` 17 / `shared` 14 / `icons` 10 / `vendor` 7 / `fonts` 7 / `i18n` 4 / `packs` 2 / 4 个单文件）。

离线与补丁（在 code 那半 659 个文件上直接 grep）：

| 检查 | 结果 |
|---|---|
| `dl.lain42.top` | **0 个文件** ✓（payload 里的 `data/assets.json` 是相对清单） |
| `fonts.googleapis` / `fonts.gstatic` | **0 / 0** ✓ |
| `__SP_SERVER__` | `js/runtime-config.js` 1 处 ✓ |
| `toHttpUrl`（补丁落地的证据） | `js/net.js`、`js/screens/room.js`、`js/shell/picker.js` ✓ |
| 自检页 | `dev/spine-probe.html` 2,943 B + `dev/spine-probe.js` 15,188 B ✓ |
| 字体镜像 | `fonts/fonts.css` + `webfonts/google/` 113 个文件（整包 115 个 woff2）✓ |

> 顺带回答一个老问题：**客户端 payload 里字体是全的**（`fonts/bender-*.{ttf,otf,woff2}`、
> `novecento-wide-normal.otf`、112 个 Google 切片）。服务端 `public/fonts` 404（`docs/11`）是
> **网页版那条路**的问题，不是客户端的。

## 4. 实测发现：`code.sha256` 不是内容指纹，别拿它跨刀比对

同一 commit（`feat/skins` `6d48a55f`）、同一素材源，两次切出来的 code 那半：

| 切的时间 | `code.sha256` | `code.bytes` |
|---|---|---|
| 07:49 干跑（`publish=no`） | `sha256:f4bf1a95…a0642c` | 10,453,429 |
| 08:46 正式（`publish=ready`） | `sha256:0f287b89…a6b528` | 10,453,596 |

文件数**都是 659**，而 `art.digest` 两次**完全相同**（`dffe9b67…`）。所以差的不是内容。

**根因**：code 那半是 **tar.gz**。gzip 头的 MTIME 已经归零（`od -j4 -N4` → `0 0 0 0`），但
**tar 每个条目的 mtime 是打包当刻的真实时间** —— 实测 659 个文件里 **646 个**带的是 run 的 mtime
（16:45:06/07，少数 16:45:30/41、16:46:01）。mtime 变了 → tar 字节变了 → sha256 和压缩后大小都变。

**结论与用法**：
- `code.sha256` 只能当"**这一份**的下载完整性校验"（`docs/AUTO-UPDATE.md` 就是这么用的：
  "下载后先验 sha256 再解包，不符就丢弃"）—— 这个用途**不受影响**。
- 它**不能**拿来回答"c39 → c40 代码有没有变"。能跨刀比的是 `art.digest`，因为它是
  "名字 + 每个文件的 sha256 再聚合"，`AUTO-UPDATE.md` 第 36 行已经写明这个取舍
  （"不是 mtime —— mtime 在解包/打包里会变"）。**同样的道理对 code 那半也成立，只是当初没顺手做。**
- 若要让 code 也可复现：`tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -czf`（gzip 用 `-n`）。
  没做，因为目前没有"靠比对 code.sha256 做决定"的地方。

## 5. 六个形态（`build-clients` + `build-tauri`）

两条流水线**并行**派发，`payload_url` 都显式指向 c40 的 tar，`server=sp.lain42.top`、`expect_app=0.2.4`：

| 流水线 | run id | job | 结论 |
|---|---|---|---|
| `build-clients` | `38126118884` | `desktop` / `android` / `ios` | 三个全 success |
| `build-tauri` | `38126120611` | `windows-tauri` | success |

四个 job 的闸门**逐条**都过（`gh run view <id> --json jobs` 里挑 `闸门`/`校验` 两类步骤）：

- 每条都有：`校验 payload 完整性`、`校验 payload 版本（闸门）`、`payload 出处（闸门）`、`零外部依赖（闸门）`、
  **`零外部依赖（产物内，闸门）`**（这条扫的是**出厂字节**，不是暂存 payload）。
- `android` 另有 `APK 签名就是那一把钥匙（闸门）`；`desktop` 另有 `Electron 主进程模块（产物内，闸门）`。
- `windows-tauri` 另有 `壳的版本必须跟着 payload（闸门）`、`两个壳的表必须一致（闸门）`、`启动探针（boot_probe 毫秒数，闸门）`。

## 6. 玩家 Release `v0.2.4-c40`

`publish-client.yml` 收口（run `38127048000`，7 步全绿）：取两条流水线的 artifact → 改成玩家看到的文件名 →
核对数量与形态 → 逐个上传并核对 sha256/size → 验收资产。**runner 内部搬运，不过本机。**

| 资产 | size | sha256（= GitHub `digest`） |
|---|---|---|
| `StrongholdProtocol-desktop-win-0.2.4-c40.zip` | 743,588,314 | `a3dff148…c6c6e` |
| `StrongholdProtocol-0.2.4-portable.exe` | 642,603,040 | `d4478993…350e` |
| `StrongholdProtocol-0.2.4-Setup.exe` | 642,813,205 | `aed0a508…7a09` |
| `Stronghold-0.2.4-c40-android-release.apk` | 635,015,146 | `87b63381…2e1e` |
| `Stronghold-0.2.4-c40-ios-unsigned.ipa` | 609,815,607 | `def99902…eedf` |
| `StrongholdProtocolTauri-0.2.4-c40-setup.exe` | 553,946,248 | `47e45b7e…4730` |

### ⚠️ Draft 模式下那条"匿名 200"是不会跑的

`as_draft=yes` 时，`publish-client` 的验收步骤走**认证 REST**，`AUTO-UPDATE.md` 第 130 行也写明
"`as_draft=yes` 时那条「匿名 200」要求会自动转成核对状态"。所以**建完 Draft 之后、翻正式之前**，
必须自己补这一步 —— 否则"资产能匿名下载"这件事从来没被验过：

```bash
# 翻正式（这一步才建 git tag：v0.2.4-c40 → 0c75562e）
gh release edit v0.2.4-c40 -R lilyco-42/StrongholdProtocolClient --draft=false
# 再逐个匿名 HEAD（不带任何 token）
for f in <六个文件名>; do
  curl -sS -I -L -o /dev/null -w '%{http_code}\n' \
    "https://github.com/lilyco-42/StrongholdProtocolClient/releases/download/v0.2.4-c40/$f"
done
```

实测：**六个全部 `200`**，且 `Content-Length` 与 Release 记录的 size **逐个相等**。

翻正式之后 `Latest` 指向它（这是 `docs/PACKAGING.md` 想要的状态：玩家落地页应当是客户端 Release，
不是 `payload-*`）。`payload-v0.2.4-c40` 因此退到第二位。

README 跟着换（PR #8 → squash `773f22e7`）：玩家表六个形态改名改大小、包体数字换成
`assets/` 13,655 个文件 / 833.1 MB、整包 874.2 MB / 14,314 个文件。

```bash
# 复核
gh release view v0.2.4-c40 -R lilyco-42/StrongholdProtocolClient --json isDraft,assets
gh release list -R lilyco-42/StrongholdProtocolClient -L 3
```


## 还没做的

- **真机验证**：六个形态都是"闸门全绿 + 包内自检过"，但没有一台真机跑过。c38 的 notes 里就写着
  "Android 3D 尚需真机验证"，c39 更是直接标成未验证的测试版 —— 这一刀同样没做。
- `docs/09` 的"已出厂"一节停在 **c12**，c33 ~ c40 这一长串都没补。
- `code.sha256` 可复现（§4）没做：目前没有"靠比对 code.sha256 做决定"的地方，所以没动。
- `public/fonts`（Bender / Novecento）在服务端网页版那条路上仍然 404（`docs/11`）——
  **与客户端无关**，客户端 payload 里字体是全的（§3）。
