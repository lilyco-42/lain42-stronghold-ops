# 05 · 补齐上游缺失的素材

## 症状

玩家截图里 boss 位置显示成**菱形占位符**。查 `data/assets.json` 引用了 4451 个文件，
本地 `public/assets/` 有 3995 个 —— 差 17 个，**而且 OSS 上也没有**（是原项目下载时就缺的）。

## 缺的是什么

| 类别 | 数量 | 具体 |
|---|---|---|
| **boss / enemy spine** | 4 | `enemy_1001_bigbo.skel`（**就是那个菱形**）、`enemy_10028_vtswd`、`enemy_10042_prtrop`、`enemy_10098_crhro` |
| **token 皮肤 spine** | 11 | 那刻皮肤（`epoque_17/27/50`）、`witch_3`、音律联觉（`ambienceSynesthesia_4/6`）、`iteration_6` |
| **盟约图标** | 1 | `bond/kazimierzShip.png`（卡西米尔） |
| **乐队卡** | 1 | `band/band_pepe.png`（佩佩） |

**关键点**：`enemy_1001_bigbo` 的 `.atlas` 和 `.png` **都在**，**唯独缺 `.skel`**（骨架数据）
→ 模型渲染不出来 → 退化成菱形占位符。

## 上游来源映射（可复用）

| 类别 | 仓库 | 路径 |
|---|---|---|
| enemy spine | `isHarryh/Ark-Models` | `models_enemies/<num>_<name>/` |
| token 皮肤 | `fexli/ArknightsResource` | `spine/<id>/<id>_<variant>/Front/` |
| band 图标 | `ArknightsAssets2`(cn 分支) | `assets/dyn/ui/autochess/[uc]autochesscommon/arts/bandicon/icon_<id>.png` |
| bond 盟约 | `fexli/ArknightsResource` | `camplogo/logo_<camp>.png` → **缩放到 96×96** |

脚本：`scripts/fix-missing-spine.py`

## 补漏过程中的两个坑

### 坑 1：token 皮肤的路径推断错了

第一次按 `spine/<id>/<variant>/Spine|Front/` 找 → 11 个全 404。
实际路径是 **`spine/<id>/<id>_<variant>/Front/`**（变体目录名带前缀）。

### 坑 2：推 OSS 时 `tar` 的 `./` 前缀被当成了对象名的一部分

`tar tzf` 列出的路径带 `./` 前缀，直接拼进 OSS key 就变成了
`site/./spine/...` → **本地明明补齐了，前端请求 OSS 还是 404**。

```bash
# 错的
tar tzf pkg.tar.gz | while read f; do ossutil cp "$f" "oss://.../site/$f"; done
# 对的
tar tzf pkg.tar.gz | sed 's|^\./||' | while read f; do ossutil cp "$f" "oss://.../site/$f"; done
```

**排查提示**：如果「本地文件在、前端还是 404」，先查 OSS 上是不是多了个 `./` 目录。

## 另一件：表情素材

`data/emotes.json` 里 6 个套组 × 6 张表情图，走 `localAsset()` 读
`data/local-assets.json`。而**按项目设计这些图只能从本地游戏客户端提取**
（`tools/setup.mjs --local`），公开下载源根本不碰它
→ 所以这个部署里两个文件都不存在，交流面板一直是**空框**。

替代来源：`ArknightsAssets2`(cn) 的
`assets/dyn/ui/emoticon/theme/[uc]<themeId>/icon/<picId>.png` —— **36 张一张不少**。

**防丢失**：`public/assets/local/` + `data/local-assets.json` 打包传到 OSS
（`sp-local-assets.tar.gz`），并在 `deploy.sh` 里插入**步骤 2b** 自动恢复 ——
否则每次重新 clone 仓库都会把表情弄丢（这两个路径都在 `.gitignore` 里）。

## ⚠️ 版权

素材版权归**鹰角网络 / Yostar**，**不适用 GPL**，仅限个人非商业自用，**请勿再分发**。
详见上游 [NOTICE.md](https://github.com/sganggs/Stronghold-Protocol/blob/master/NOTICE.md)。

## 追加（2026-10-05 14:31 实测）：网页版与打包客户端的美术**集合不一样**

把线上磁盘的文件清单和打包 payload 的清单对了一遍（同一 locale、去掉 CR 之后用 `comm`）：
线上 `public/assets` **3995** 个文件，payload **4050** 个，差集正好 **55 个**，全是 0.1.3 新引用的那批：
`ui/emoticon/**` 36 个 + `ui/guide/**` 19 个（`prod-only` 差集为 0，即线上没有 payload 里没有的东西）。

逐个按清单里的地址探了一遍，结论是**分层的，不是一句"素材挂了"**：

| 东西 | 网页版实际拿到的 | 怎么测的 |
|---|---|---|
| 表情 `ui/emoticon/**` | **正常** | 面板读的是 `data/local-assets.json`（相对路径），`/assets/local/emoticon/basic/pic_happy_battle.png` → **200** |
| 攻略页 `ui/guide/**` | **看不到截图，退化成官方 tips 文字** | `assets.json` 把它列成 OSS 地址 → `HEAD` **404**；磁盘上也没有 → `/assets/ui/guide/autochess_shop_1.png` **404**；`public/js/ui/guide.js` 的注释与 `guideStage` 逻辑本来就写了"每个地址都失败就显示 `config.tips`" |
| 角色/敌人立绘 | **正常** | 清单里的真实对象 `HEAD` 200（抽样 `site/char/avatar/char_1012_skadi2.png`），OSS 上 4506 条地址在位 |

所以这 **不是 14:20 覆盖式升级造成的新故障**，是这批美术从来没被传到 OSS / 没进线上的 local 清单；
打包客户端因为有 4050 个文件在设备上，攻略页是完整的。**给网页玩家补齐**要做两件事（都动 OSS/线上，需点头）：
把 55 个文件按 `site/ui/...` 前缀传 OSS（`tools/apply-oss-assets.mjs` 那套流程），并给线上 `data/local-assets.json`
加 `guide` 组（现在它只有 36 条 emoticon、0 条 guide）。补齐前不要报"攻略页坏了"——它是**设计内的文字降级**。

