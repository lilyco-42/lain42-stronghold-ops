# 14. 抽查"已发布产物"里的入口页（不用下载 353 MB 整包）

## 1. 这条解决什么

`docs/09` 那五道闸门判的是**构建时**与**下载回来整包拆开后**。但有一类问题只想快速再确认一次：
**此刻玩家下载到的那份字节里，入口页到底还引没引站外字体？**
桌面 zip 是 353,439,776 B、APK 是 224,848,906 B，为看一个 6.6 KB 的 `index.html` 去拉整包不划算
（不是不能拉：16:47 实测在同一条命令里连续读完 OSS 的 195,809,375 B 与 GitHub 的 213,917,927 B，一分钟内完事 ——
**别把 `docs/12` 那个 3 Mbps ≈ 375 KB/s 安到这里，那个数是游戏机 `8.153.102.122` 的 eth0，OSS 是另一台 `47.101.28.199`**；
但整包读完仍然白花几十倍带宽，而且 CI 产物只保 7 天），所以 Range 三次就够。

zip 的中央目录在**文件尾部**，每条 entry 自己记着偏移与压缩大小，所以 Range 请求三次就够：
尾部 64 KB（拿 EOCD + 中央目录）→ 中央目录 → 那一条 entry 本身。实测总传输约 1 MB。

## 2. 命令

```
cd D:/Code/lain42-stronghold-ops
export MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1        # ⚠️ 见第 4 节，不加这条会读到假 0
python scripts/spotcheck-release-entry.py v0.1.3-compat desktop 'resources/www/index.html' \
  'fonts.googleapis.com' 'fonts.gstatic.com' '/webfonts/google/google.css' '<link'
python scripts/spotcheck-release-entry.py v0.1.3-compat android 'assets/public/index.html' \
  'fonts.googleapis.com' 'fonts.gstatic.com' '/webfonts/google/google.css' '<link'
```

条目路径写**子串**即可：桌面那份在 zip 里是 `build/desktop/win-unpacked/resources/www/index.html`（带 `build/` 前缀），
APK 那份是 `assets/public/index.html`。

## 3. 2026-10-05 16:09 实测（tag `v0.1.3-compat`，**已被 `v0.1.3-c11` 取代**，见第 6 节）

```
asset StrongholdProtocol-desktop-win-x64-0.1.3-compat.zip  353,439,776 B
build/desktop/win-unpacked/resources/www/index.html
  2,732 -> 6,684 B（method 8，字节数与中央目录一致 ✓）
  fonts.googleapis.com             2
  fonts.gstatic.com                1
  /webfonts/google/google.css      0
  <link                           27

asset Stronghold-0.1.3-compat-android-debug.apk  224,848,906 B
assets/public/index.html
  2,911 -> 6,684 B（method 8，字节数与中央目录一致 ✓）
  fonts.googleapis.com             2
  fonts.gstatic.com                1
  /webfonts/google/google.css      0
  <link                           27
```

两份入口页**未压缩字节数相同（6,684 B）**，因为都出自同一个 payload `payload-v0.1.3-c5`。
读法：外链仍在（2 + 1），本地样式表一次都没有（0）—— 也就是说**字形镜像还没到玩家手里**，
源头与闸门都在，缺的只是"用 c10 重跑一次 build-clients"那一步（`docs/09`、`docs/11` §9，要人点头）。
`<link` 出现 27 次是**正控制**：它证明解压出来的是真的 HTML 而不是一坨被截断的字节。

## 4. 一条会骗人的坑（Git Bash 改参数）

第一次跑的时候输出长这样：

```
  C:/Program Files/Git/webfonts/google/google.css 0
```

MSYS 会把以 `/` 开头的 argv 当路径转换，`/webfonts/google/google.css` 变成了 Windows 绝对路径，
于是那个 0 是"**没找到这串乱码键**"而不是"没有本地样式表引用"—— 结论看着对，判据是废的。
跑之前 `export MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1`（或换 cmd / 不带前导斜杠的键）。
和 `gh api /xxx` 被改写是同一族坑，见 `AGENTS.md` 的证据规则。

## 5. 脚本自带的两道自校验（不许跳过）

1. 本地头签名必须是 `PK\x03\x04`，否则直接退出 —— 偏移算错时输出会看着完全正常。
2. 解压后的**字节数**必须等于中央目录记的 uncompressed size，不等就退出（"抽取不完整，判读无效"）。

⚠️ 别把字符数当字节数：`index.html` 中央目录记 6,684 B，`decode('utf8')` 之后是 6,380 个字符，
差的 284 是中日韩字符（3 字节 1 字符）。脚本比的是字节。

这条**不是权威闸门**：它只看一个条目。权威判据仍然是整包下载后
`node tools/check-payload-offline.mjs <exe>/resources/www` 与 `node tools/check-payload-offline.mjs --zip <apk>`
（后者按 zip 条目扫全部文本文件，整包 grep 会漏 —— deflate 条目里搜不到字符串，见 `docs/09`）。

## 6. 2026-10-05 23:0x 复测（tag `v0.1.3-c11`，**这才是玩家该下的那两个文件**）

```
桌面 StrongholdProtocol-desktop-win-x64-0.1.3-c11.zip  360,850,482 B
  resources/www/index.html            2,739 -> 6,643 B   fonts.googleapis.com 0 · fonts.gstatic.com 0 · /webfonts/google/google.css 1
  resources/www/js/shell/picker.js    9,384 -> 28,636 B   orderCandidates(toWsUrl(raw) 1 · no-cors 2 · Promise.all(candidates.map 1
安卓 Stronghold-0.1.3-c11-android-debug.apk  232,320,951 B
  assets/public/index.html            2,924 -> 6,643 B   0 · 0 · 1
  assets/public/js/shell/picker.js   10,994 -> 28,636 B   1 · 2 · 1
（APK 里还有个 `org/apache/cordova/allowlist/index.html`，2,109 B，是 Cordova 自带示例页，三条计数都 0 —— 别把它当入口页）
```

三点判读：
- **入口页 6,684 → 6,643 B、外链 3 → 0**：字体镜像这条从"源头与闸门都就位、产物仍带外链"变成**已出厂**。
  这条挂了两个 release（compat 与它之前），现在只剩**网页版**还带外链（生产 `public/index.html` 是热文件，见 §09 与 `docs/12`）。
- 两个产物里的 `picker.js` 都是 28,636 B，等于客户端仓库 `main` 的 `shell/picker.js`，
  三个判据计数一致 —— 选择页修复确实在**玩家下到的字节**里，不只在 CI 的临时产物里。
- 上面这些数是 Range 三条 entry 读出来的（总传输约 1 MB）；同一晚也把两个产物**整包下载拆开**验过
  （`picker.js` sha256 `f06a8a86…0e02cdb`、`picker-core.js` `e1bde54f…16ff88e`、GitHub `digest` == 本机 `sha256sum`），
  两条路都要跑：Range 抽查便宜但只看一个条目，整包才配得上"发布完成"这句话。
