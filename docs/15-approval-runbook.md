# 15. 需要点头的三件事：一条命令、预期读数、怎么回滚

这份文档只为缩短"下一个 AI / 你自己要不要动生产"的判断时间。**每条的预期读数都是 2026-10-05 本机实测**，
不是估计；执行前请按 `docs/13` 的核对单重跑一遍，因为线上一天里变过好几次。

红线（全程有效）：不重启线上服务、不直接编辑 `public/index.html` 这类热文件、exe/apk 只在 Actions 里编、
不覆盖已发布资产（Release 地址是永久的）、SSH 一律带 `-i ~/.ssh/lain42.pem`。

先量一眼现在有多少人在玩（这条只读，任何时候都能跑）：

```
curl -s https://sp.lain42.top/healthz | python -c "import json,sys;d=json.load(sys.stdin);print('app',d['app'],'humans',d['humans'],'matches',d['matches'])"
```
今天读到过：15:57 → 125 人 / 72 场；16:37 → 164 人 / 84 场；**17:08 → 180 人 / 96 场**（一直在涨，**不是低峰窗口**）。

---

## A. 上传 payload-c10 并跑 build-clients（出带镜像字体的新产物）

为什么值得做：源头与闸门都就位了，唯独玩家下到的还是旧 payload。16:09 用 Range 直接读过已发布两份字节里的
`index.html`：都是 **2 次 `fonts.googleapis.com` + 1 次 `fonts.gstatic.com`、本地样式表 0 次**（未压缩都恰好 6,684 B）。

```
gh release create payload-v0.1.3-c10 --draft=false --title 'payload v0.1.3-c10（字体镜像 + 0.1.3 最新基线）' \
  D:/Code/_artifacts/sp-client-payload-0.1.3-c10.tar.gz
gh workflow run build-clients.yml -R lilyco-42/StrongholdProtocolClient \
  -f payload_url='https://github.com/lilyco-42/StrongholdProtocolClient/releases/download/payload-v0.1.3-c10/sp-client-payload-0.1.3-c10.tar.gz' \
  -f server=sp.lain42.top -f expect_app=0.1.3
```

**必须显式传 `payload_url`**：workflow 的默认地址是 OSS 上那份 `sp-client-payload.tar.gz`（195,809,375 B，
15:40:49 CST 被换过），它内嵌 `build.json` 是 `describe:"v0.1.3-dirty"`、`dirty:true` —— 内容没问题（入口页 0 外链、镜像在包里），
但**出处追不到 commit**，新加的第五道闸门会直接把它拦下（实测 rc=1 并点名两条原因）。

跑之前本机已量的预期值（都会变，别照抄）：tar `221,350,850 B` / sha256 `234ee962…ec36`、
`describe v0.1.3-16-g603b94c`、`app 0.1.3`、`dirty false`、离线闸门 rc=0、出处闸门 rc=0、`corrosion` 切片 2 条。

**怎么算成功**（`gh run view <id> --json conclusion`，别用 `gh run watch` 的 shell 退出码）：
两个 job 都 success，且产物内三样齐全 —— `app.asar` 里 `resolveMediaPath` ≥1、payload `js/net.js` 里 `serverKey`、
APK 的 `assets/public/js/runtime-config.js` 含 `__SP_MEDIA_ALIAS__ = false`（桌面那份必须没有）。
再按 `docs/14` 抽查一次入口页：外链应从 2+1 变成 **0+0**，本地样式表从 0 变成 **1**。

**回滚 / 代价**：不碰生产；Release 资产一旦发出去地址就是永久的，所以**不要覆盖同名 tag**，错了就再发 c11。
GitHub Actions 产物只保 7 天，长期分发要另发 Release。

---

## B. 发布后拆包验收（判据已经写死在任务里）

```
cd D:/Code/StrongholdProtocolClient
node tools/check-payload-offline.mjs <解压后的 win-unpacked>/resources/www
node tools/check-payload-offline.mjs --zip <新的 app-debug.apk>          # APK 必须按 zip 条目扫：整包 grep 是 0 命中
```
判据：两条都 rc=0；`webfonts/google/` 下 112 个切片 + `google.css`；镜像与 `google.css` 里的 `url()` 一一对应。
桌面 `app.asar` 只有 29,619 B（4 个壳文件），**游戏 www 在它旁边的 `resources/www`**，别在 asar 里找字体。

---

## C. 给线上网页版重放 03b（OSS 前端 + 字体镜像）

现状：线上跑的那份 `public/index.html` 是 14:20:24 CST 覆盖式升级换上的**上游 0.1.3 版**，
镜像与 OSS 前端改写都不在里面。**17:08 现测**：`curl -s …/index.html` 共 6,304 B，
**2 次 `fonts.googleapis.com` + 1 次 `fonts.gstatic.com` + `/webfonts/google/google.css` 0 次**；
同一时刻 `/healthz` 是 `app 0.1.3`、**180 人 / 96 场**（uptime 5690 s → 进程起于 15:33 那次重启）。
6,304 B 这个尺寸可以当判别用：payload 里那份入口页是 6,684 B（差 380 B 就是那几行字体链接与本地样式表引用的差别），
重放之后线上抓下来的字节数应当**变掉**，同时外链归 0。
它是热文件，**不能直接编辑**。

预检已完成、都不需要碰生产：
- 补丁配对：`03b` 在 fork 树 clean、在纯净上游树 FUZZ 2（两棵树都要跑，`docs/13` §5b）；
- OSS 接管：`scripts/check-frontend-oss-mirror.py` 22/22 通过（负控制塞假 key → 21/22 + `HEAD 404` + rc=1）；
- 线链路上**没有任何 CSP 头**（`curl -sI` 实测只有 nosniff + Referrer-Policy），不存在"自托管被 font-src 拦"；
- 同一前端今天就在发自托管 css/woff2 且带 `public, max-age=86400`，`/webfonts/google/*` 不是新行为。

执行顺序（低峰窗口）：生成 OSS 版 → 并行页在真浏览器里比对 → 整份替换 `public/index.html` → 立刻
`curl -s https://sp.lain42.top/index.html` 数外链应为 0 次、`/webfonts/google/google.css` 应为 200。
**回滚**：替换前把线上那份 `index.html` 存成带时间戳的备份，回滚就是拷回去（它不需要重启，node 按磁盘发）。

⚠️ 一条会静默踩的坑：线上 checkout 的 git 状态**不能**当版本证据（HEAD 停在 `8b10625` 却有 177 个 ` M`），
而且 `shared/protocol.js`（md5 `a17f47ae…`）比任何 git 树都多一条手写的 `hello.z` 校验 —— 整份覆盖前要先 diff，
否则那行会消失（详见 `docs/12` §5）。

---

## D.（顺带）大厅注册修复要不要部署

代码与回归都在 `docs/10`；16:35 只用只读命令就能确认病灶仍在：unit 环境变量里没有 `SKIP_EMAIL_VERIFY`、
`data/site.json` 写 `true`、`wsgi.py` 里读取它的代码计数 0。动之前**必须**重新
`patch-lobby-skip-email-verify.py --dry-run`（今天 `wsgi.py` 被外部改过四次，md5 链见 `docs/10`）
+ `md5sum`，因为线上文件一天里就不是同一份了。重启代价只有大厅自己（`online-platform`，5000 端口），
游戏服是另一个进程 —— 但大厅一重启，正在注册的人会断，仍建议低峰。
