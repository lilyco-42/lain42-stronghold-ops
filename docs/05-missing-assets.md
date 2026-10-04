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
