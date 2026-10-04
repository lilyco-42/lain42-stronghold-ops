# 07 · Spine 模型 gzip 化：再省 77% 的模型传输

> **零风险、不改代码、不用重启。** 已完成。

## 为什么做

干员模型很大：

| 类型 | 数量 | 中位 | 最大 |
|---|---|---|---|
| 干员 `op/**/*.skel` | 273 | **183 KB** | **1365 KB** |
| 敌人 `enemy/**/*.skel` | — | 46 KB | 757 KB |
| 皮肤 `token/**/*.skel` | 13 | 16 KB | 673 KB |

一整套干员模型目录 **180 KB – 680 KB**。高延迟玩家（截图里那个「465」很可能是 465ms 延迟）
加载一个 680 KB 的模型要好几秒 —— 这段时间游戏显示**菱形占位符**。

## 压缩率实测

```
类型      原始        压缩后      省
.skel   10895 KB    2464 KB   77.4%   ← 关键
.atlas    306 KB      58 KB   81.0%
.png     5774 KB    5444 KB    5.7%   ← 已压缩，**不动**
```

## 做法

在 OSS 上用 `Content-Encoding: gzip` 存一份 `.skel` / `.atlas`：

```bash
# 1) 本地 gzip 到暂存目录（保持路径结构）
find spine -type f \( -name '*.skel' -o -name '*.atlas' \) | while read f; do
  mkdir -p "/opt/sp-gz/$(dirname "$f")"
  gzip -6 -c "$f" > "/opt/sp-gz/$f"
done

# 2) 上传时带上 Content-Encoding
ossutil cp -r -f /opt/sp-gz/spine \
  oss://<bucket>/downloads/stronghold-protocol/site/spine \
  --meta 'Content-Encoding:gzip' -e oss-cn-shanghai-internal.aliyuncs.com
```

> `ossutil cp --meta` 的官方帮助里给的示例正好就是
> `Cache-Control:no-cache#Content-Encoding:gzip`。

脚本：`scripts/gzip-spine-to-oss.sh`

## 结果

| | |
|---|---|
| 处理文件 | **1058 个**（529 `.skel` + 529 `.atlas`） |
| 总体积 | **86.3 MB → 20.0 MB（−76.9%）** |
| 上传耗时 | 11 秒（内网端点） |

单个大模型：

```
char_1012_skadi2.skel   1397714 B → 404051 B  (−71%)
char_4039_horn.skel     1316948 B → 210069 B  (−84%)
```

## 验证

1. **无损**：抽查 12 个文件（含 5 个最大干员模型），
   `curl --compressed` 解压后的 **md5 与原始文件完全一致**
2. **响应头正确**：`Content-Encoding: gzip` + 压缩后的 `Content-Length`
3. **浏览器透明解压**：Playwright 跑完整战斗流程，**21 个 spine 请求全部 200**，
   游戏正常渲染，零 console 错误
4. 服务 200、542 玩家不受影响

## ⚠️ 注意事项

- **`.png` 不要压**（只省 5.7%，纯浪费 CPU）
- **只对浏览器玩家有效** —— APK / 桌面版的资源是内嵌的，不走 OSS
- **回滚**：原始文件在服务器磁盘上（`/opt/Stronghold-Protocol/public/assets/spine/`），
  不带 `--meta` 重新上传即可
- **上游更新素材后要重跑** —— 新增的 `.skel`/`.atlas` 是未压缩的
  （所以脚本写成了幂等的一键脚本）

## 为什么这条路比改游戏代码好

| 方案 | 效果 | 代价 |
|---|---|---|
| **OSS gzip（本方案）** | 模型传输 **−77%** | 零 —— 不改代码、不重启、可回滚 |
| 改游戏代码压缩 | 同样效果 | 改 `media.js` + 每次上游更新重打补丁 |
| 升级带宽 | 模型加载变快 | 花钱 |

**浏览器对 `Content-Encoding: gzip` 是透明解压的** —— 客户端代码完全不用知道这件事。
