# 16. OSS 账号被停用（UserDisable）——现场、判据与影响面

2026-10-06 00:38 前后发现：`dl.lain42.top` 上**所有**对象都返回 403。用户确认原因是**账号欠费**。
这份记录的价值在于"怎么确认是账号级而不是我们配置错了"——那一步靠正控制，不靠猜。

## 1. 症状

```
https://dl.lain42.top/downloads/stronghold-protocol/…   → 403 application/xml
正文： <Code>UserDisable</Code> <Message>UserDisable</Message> <EC>0003-00000801</EC> <HostId>dl.lain42.top</HostId>
```

## 2. 判据：控制面活着、数据面全拒（这才叫账号停用）

在游戏机上跑（`ossutil` 用 `~/.ossutilconfig` 里的 AK，走 `-internal` endpoint）：

| 调用 | 结果 | 说明 |
|---|---|---|
| `ossutil ls`（列 bucket） | ✓ 列出 3 个 | 控制面还能用，AK 也没失效 |
| `ossutil stat oss://lain42-downloads` | ✓ 返回 bucket 元数据 | 不是"bucket 不存在"，也不是权限策略 |
| 读 `lain42-downloads` 里的对象 | ✗ 403 UserDisable | 数据面被拒 |
| 写 `lain42-downloads`（1 字节探针） | ✗ 403 UserDisable | 写也一样 |
| **读另一个 bucket `lain42` 的对象** | ✗ 403 UserDisable | **正控制：不是单个 bucket 的事，是账号** |

最后一行是关键。少了它，"这个 bucket 被单独处理了"和"整个账号停了"两种解释都成立，
而处置方式完全不同（前者查 bucket 策略/违规通知，后者查账单）。

## 3. 影响面（都是量出来的，不是"可能受影响"）

| 受影响 | 实测 |
|---|---|
| **网页版玩家的美术** | 生产 `data/assets.json` 里 `dl.lain42.top` 命中 **4506** 次、相对路径只有 **1** 次 → 新加载的网页玩家基本没图。客户端有 `Img fallback`，所以是"能玩、没图"，不是崩溃（浏览器实测：入口页 `site/ui/entry/bkg_01.png` 加载失败，文字与流程正常） |
| 玩家下载 exe/apk 的镜像链接 | `0.1.3-c11` 两条 403、`0.1.3-compat` 的 apk 也 403（它 23:0x 之前还是 200，所以停用发生在 **23:0x~23:4x** 之间） |
| 下载站页面与清单 | `lain42.top/downloads/` 与 `manifest.json` 都还是 200（**不同主机**），只是里面那条「下载镜像」按钮指向 403 |
| **游戏服务本身** | 没受影响：`/healthz` 200、`app 0.1.3`、`humans 254 · rooms 176`、`uptimeSec 33009`（≈9.2 h，没人重启）；机器 `up 19 days`、load 0.80、盘 75%、node 进程在 |
| 装机客户端（exe/apk/ios） | **不受影响**：美术音频字体全在安装包里，出厂闸门实测包内 `dl.lain42.top` 命中 0 |
| GitHub Release 三条产物 | 正常（206/200，digest 已核）——停用期间玩家只能走 GitHub |

## 4. 一个差点误判成"服务器挂了"的坑

同一时间我从本机测 `https://sp.lain42.top/healthz` 得到 **空响应**、`curl -I` 得到 **000**，SSH 也有一次
`Connection closed by … port 22` —— 看起来像游戏机出事。实际是**本机的代理/TUN 给了假 IP**：

```
nslookup sp.lain42.top  →  Address: 198.18.0.106      ← 198.18.0.0/15 是代理工具的 fake-IP 段
curl --resolve sp.lain42.top:443:8.153.102.122 https://sp.lain42.top/healthz  →  200，一切正常
```

**规则**：报"服务挂了"之前，必须①用真实 IP `--resolve` 再问一次，②换一个视角（服务器上/另一个网络）问一次。
两条都过才配说"down"。SSH 那次 `Connection closed` 复测也正常，是偶发。

## 5. 处置与恢复后要做的收尾

- 处置：阿里云控制台看**费用与成本**（欠费）与**消息中心 / 安全管控**（违规处理）。数据面被拒而控制面正常，
  这个形状最像欠费冻结。
- 恢复后要补的（当时被这次停用挡住）：
  1. c12 的 exe/apk 传 OSS（`scripts/oss-put-client.sh /opt/oss-stage/0.1.3-c12 0.1.3-c12`，文件已在服务器暂存目录，
     服务器侧 sha256 与本机逐字节核过）；
  2. 下载清单从 c11 换成 c12（`scripts/manifest-add-stronghold.py --ver 0.1.3-c12 --src-dir /opt/oss-stage/0.1.3-c12`，
     同 id 走**替换**，不会多出一行）；
  3. README 的产物数字换成 c12（iOS 的 `.ipa` 已经在 GitHub Release 上，不受影响）。
- **一条成本教训**：`oss-put-client.sh` 的"HTTP 回读校验"会整包下载 590 MB（走公网域名，计流量）。
  出厂一次 = 上传 590 MB + 回读 590 MB。回读是必要的（compat 那次就是靠它发现 zip 从来没传上去），
  但**不必整包**：改成 Range 抽样若干段 + 与 GitHub 的 `digest` 比对，同样能证明字节完好，流量降到千分之一以下。
