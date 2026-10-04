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

## ⚠️ 代价：几乎为零（**更正过一次结论**）

一开始我以为 CPU 从 9.9% 涨到 40% 是压缩的代价。**做 CPU profile 后发现是错的**：

```
对运行中的 stronghold 采样 30 秒（kill -USR1 开 inspector，不重启）
采样点 96053，idle 60.8% → 非 idle 39.2%（与实测 CPU 36% 吻合）

按模块（非 idle 占比）：
  60.6%  游戏模拟 server/sim        ← 真正的大头
  18.9%  对局逻辑 server/match
  10.6%  native/V8/GC
   2.1%  网络/大厅
   1.1%  压缩 zlib（permessage-deflate + node:zlib）
```

**压缩只占 1.1%**（≈ 总 CPU 的 0.4%）。CPU 涨的真正原因是**并发对局数增加** ——
`sim + match` 合计占 **79.5%**。之前那个 9.9% 是在事故刚恢复、多数人还在大厅时测的，
**没有可比性**。

**结论：permessage-deflate 的 CPU 代价可以忽略，不需要为它做应用层压缩。**

### 如果将来 CPU 真的成为瓶颈

| 方案 | 可行性 |
|---|---|
| **用上第二个核**（cluster / worker_threads 按房间分进程） | ⚠️ 房间在单进程内存里，需要架构改动 |
| 优化 sim 热点（`effectiveProfile` 3.5%、`_tickBuffs` 2.5%） | ❌ **不能碰** —— sim 与客户端逐位共享，改了有 desync 风险 |
| Node 运行时参数（`--max-semi-space-size`） | 收益很小（GC 只占 3.8%） |

**按 36% @ 440 人线性外推，要顶满一个核大约需要 ~1200 人。**

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
