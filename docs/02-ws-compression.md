# 02 · WebSocket 压缩：唯一的「大头」优化

## 改了什么

上游 `server/index.js:613` 写死了压缩关闭：

```js
const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD,
                                  perMessageDeflate: false, clientTracking: false });
```

改成：

```js
const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, clientTracking: false,
  perMessageDeflate: {
    threshold: 512,                                  // 小于 512B 的消息不压（避免小包反而变大）
    zlibDeflateOptions: { level: 1, memLevel: 7 },   // 拿 CPU 换速度：level 1 比 6 快得多，体积差不多
    serverNoContextTakeover: true,                   // 不复用压缩上下文，省内存
    clientNoContextTakeover: true,
  } });
```

补丁：`patches/game/01-ws-compression.patch`
应用脚本：`scripts/sp-apply-ws-compress.sh`

## 为什么值得改

先用 tcpdump 抓 loopback（`lo:5150` 是**明文 HTTP**，能看到请求路径）算出流量构成：

| 类型 | 速率 | 占比 |
|---|---|---|
| **WebSocket 游戏状态** | ~350 KB/s | **76%** |
| 静态文件 | ~113 KB/s | 24% |

而游戏状态是 **JSON 文本**（实测 305 帧里**非文本帧 = 0**），JSON 的 key 重复率极高
→ deflate 天然适合。

抓真实帧做基准（86 条 `m.public`，占全部流量 **85%**）：

| 方案 | 86 帧合计 | 省 |
|---|---|---|
| JSON（基线） | 266.4 KB | 0% |
| **JSON + deflate(1)** | **79.4 KB** | **70.2%** |
| JSON + brotli(5) | 70.8 KB | 73.4% |
| MessagePack（裸二进制） | 206.5 KB | 22.5% |
| MessagePack + deflate(1) | 78.3 KB | 70.6% |

**几个反直觉的结论**：

- **换二进制格式（msgpack/CBOR/protobuf）收益 ≈ 0** —— deflate 已经把 key 重复消掉了，
  加上二进制反而**略大**（78.3 vs 79.4，msgpack 的整数编码不如 JSON 文本对 deflate 友好）
- **brotli 只多省 3.2%，但编码 CPU 贵 6 倍**（33.7ms vs 5.8ms）→ 在 2 核机器上不值

## 实测效果

```
握手确认：
  HTTP/1.1 101 Switching Protocols
  Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover; client_no_context_takeover
```

| 指标 | 压缩前 | 压缩后 |
|---|---|---|
| **每玩家流量** | **1570 B/s** | **450 B/s（−71%）** |
| 出口带宽（418 人） | ~656 KB/s | **183 KB/s** |
| 距 3 Mbps 稳态上限 | 175% 超载 | **49%（有余量）** |

每玩家流量是稳定指标 —— 两次独立测量一致（290 人时 450 B/s，418 人时也是 450 B/s）。

## ⚠️ 代价：CPU +4.4×

| | 压缩前 | 压缩后 |
|---|---|---|
| stronghold CPU | 9.9% | **37–49%**（均值 ~43%） |
| 内存 RSS | 203 MB | 233 MB |

**根因**：`permessage-deflate` 是**每连接压缩一次**。418 个连接 → 同一条 `m.public`
被压 418 遍（严格说是每个房间的每个收件人各一遍）。**CPU 随玩家数线性增长。**

**换算**：40% of one core（2 核）→ 约 **1000 人**会顶满一个核。

### 下一步（当 CPU 成为瓶颈时）

把压缩**从传输层搬到应用层**：压**一次**、广播 N 次。

- CPU 降 ~N 倍（N = 每房间玩家数，通常 4）
- 带宽不变
- 而且和「增量编码」天然契合 —— 增量本来就是「算一次、发多人」

本地基准测试显示：**增量 JSON + deflate(1) 能把字节再降 58%**（79.4 → 33.3 KB / 86 帧）。
详见 `docs/04-measurements.md`。

## ⚠️ 部署注意

**必须重启 stronghold 才生效**，而**对局状态只在内存里，没有落盘**
→ 重启 = **丢掉所有进行中的对局**（不是掉线几秒）。

所以 `scripts/sp-apply-ws-compress.sh` 默认只在「后端连接数 = 0」时才动手：

```bash
# 等没人在线时自动应用（timer 每 5 分钟查一次）
systemctl enable --now sp-ws-compress.timer

# 强制执行（会踢掉所有对局，慎用）
sp-apply-ws-compress.sh --force
```

脚本自带：备份 → 内容锚定替换 → `node --check` → 重启 → 验证 200 → 失败自动回滚 →
成功后**停用自己的 timer**。

## 顺带发现（对以后有用）

`m.public` 的数据画像：

- **一个浮点数都没有**（str 79 / int 45 / bool 30 / null 6）→ 浮点量化这条路不存在
- 25 个顶层 key，**每帧平均 19.6 个没变**；只有 `serverNow`(100%)、`players`(68%)、
  `fields`(60%) 频繁变 → **增量潜力大**
- ⚠️ `draft` 和 `unite` 这两个 key **会消失** → 增量编码**必须处理 key 删除**，
  否则 apply 会留着旧值（我第一版就栽在这，正确性校验直接报 ✗）
