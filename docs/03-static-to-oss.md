# 03 · 静态资源搬 OSS：三个必踩的坑

## 改了什么

把 `js/ css/ vendor/ fonts/ shared/` 从服务器搬到 OSS，
**服务器只留 `/sim` `/data` `/data.js` `/assets`**。

改了 **6 个文件**（不只 `index.html`）：

| 文件 | 改什么 |
|---|---|
| `public/index.html` | 26 处 `href`/`src` + importmap 的根绝对路径 → OSS 绝对地址 |
| `public/js/render/board3d/load.js` | `THREE_URL` |
| `public/js/render/app.js` | `VENDOR`（pixi / pixi-spine） |
| `public/js/ui/emotes.js` | `EMOTE_CSS_HREF` |
| `fonts/fonts.css` | **6 处 `url('/fonts/...')`** ← 漏了这个字体全挂 |
| `public/js/battle/runner.js` | `loadBrowserSim` 的 `base` → 服务器绝对地址 |

生成脚本：`scripts/build-oss-app.py`（构建 + 校验 + 产出 `index-oss.html`）

## 结果

| 路径 | 前 | 后 |
|---|---|---|
| `/js/` | 363 次 / 15s | 37 次 / 12s（**−87%**） |
| `/css/` | 75 次 | **0**（−100%） |
| `/vendor/` | 5 次 | 1 次（−80%） |
| `/shared/` | 22 次 | 2 次（−91%） |

**但出口带宽只降了约 4%** —— 因为 `/js` 大多是 304（本来就便宜），
而真正的大头是 WebSocket（76%），搬静态动不了它。

**主要收益是：服务器的静态请求量砍掉 ~90%**，省下 CPU 和连接 churn。

---

## 坑 1：相对导入会「逃出」URL 前缀

`js/screens/room.js` 里写着 `../../../shared/constants.js`。

- **在服务器上**：`/js/screens/` 往上 3 层 → `/`（**在根处被钳制**）→ `/shared/constants.js` ✓
- **在 OSS 的 `.../app/` 前缀下**：往上 3 层 → `.../stronghold-protocol/`（**没有钳制**）
  → `.../stronghold-protocol/shared/constants.js` ✗

**解法**：把 `shared/` 在**上一层再放一份**。

共 35 处逃逸引用，**全部指向 `shared/`**（constants 24 / protocol 7 / loadoutRecord 3 / media 1）。
用 `scripts/scan-escapes.py` 可以精确算出来。

> ⚠️ 判断逃逸**不要用 `posixpath.normpath`** —— 它会在根处钳制，把逃逸「吃掉」，
> 让你以为没问题。要用**真实文件系统路径**判断。

## 坑 2：`/sim` 绝对不能放进任何前缀

`server/sim/content/bands/meta.js` 里是 `../../../../shared/constants.js` ——
**同样依赖「在根处钳制」**，而且 sim 目录**深度不一致**（1~3 层），没法用统一的相对路径绕开。

**结论：`/sim` 必须留在服务器。**

## 坑 3：动态 `import()` 和 `fetch()` 的解析基准不一样

```js
import(`${base}spec.js`)            // ← 相对「模块自身 URL」→ 落到 OSS 域名根 ✗
fetchFn(`${dataBase}${n}.json`)     // ← 相对「页面 URL」→ sp.lain42.top ✓
```

所以 `base` 必须改成服务器的绝对地址，`dataBase` 不用改。

**但跨域 ESM 需要 CORS**，而 stronghold 一个 CORS 头都不返回
→ 在 pingap 加 `/sim` 的 location（`patches/pingap/locations-and-plugins.toml`）。

---

## 零风险的验证流程（关键）

因为改的是线上页面，**不能直接改 `index.html`**。做法：

```bash
# 1) 生成「指向 OSS 的副本」
python3 scripts/build-oss-app.py
#    → /opt/sp-oss-build/app/  （上传到 OSS）
#    → public/index-oss.html   （并行测试入口，玩家不受影响）

# 2) 上传
ossutil cp -r -f /opt/sp-oss-build/app oss://<bucket>/downloads/stronghold-protocol/app
ossutil cp -r -f /opt/sp-oss-build/shared oss://<bucket>/downloads/stronghold-protocol/shared

# 3) 用并行 URL 测（这一步抓到了 3 个 404）
#    https://sp.lain42.top/index-oss.html
node oss-e2e.mjs https://sp.lain42.top/index-oss.html
#    关键断言：dband=40、dorder=4、打到服务器的静态请求应为 0（或仅 2 个 /shared）、
#             failed=0、console err=0

# 4) 确认无误再切换
cp -a public/index.html public/index.html.bak-pre-oss-$(date +%F)
cp -f public/index-oss.html public/index.html
```

**测试时提前抓到的问题**（玩家全程没受影响）：

1. `.../stronghold-protocol/shared/constants.js` 404 —— 坑 1
2. `https://dl.lain42.top/sim/spec.js` 404 —— 坑 3
3. 3 个 `/sim/*` 仍然 404 —— 加 CORS 后解决

## ⚠️ 新的风险

现在**整个前端都依赖 OSS**。OSS 出问题 → 站点完全打不开（以前只影响素材）。

**回滚**：

```bash
cp public/index.html.bak-pre-oss-<日期> public/index.html
```
