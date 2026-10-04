# 01 · 事故复盘：全站 503 的完整因果链

**时间**：2026-10-04 19:05（发现）→ 19:06:47（恢复）
**表现**：玩家首页打不开，`/js/*.js` 全部 **503 Service Unavailable**，`htm.module.js` **502**
**关键迷惑点**：`stronghold` 进程**完全健康**（日志里正在正常开对局），但经反代全挂

---

## 排查路径（可复用）

### 第一步：先分清「后端挂了」还是「反代挂了」

```bash
# 直连后端
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5150/
# 经反代
curl -s -o /dev/null -w '%{http_code}\n' --resolve sp.lain42.top:443:127.0.0.1 https://sp.lain42.top/
```

结果：直连 **200**、经反代 **503** → 问题在反代层，不在游戏。

### 第二步：看反代日志的原始错误

```bash
journalctl -u pingap --since '3 min ago' | grep -i error | tail
```

拿到关键一行：

```
ERROR fail to proxy error= HTTPStatus context: No available upstream for sp
```

`No available upstream` = pingap 把上游标记为不可用了。**但直连是好的** → 说明 pingap 的
「健康检查」本身出了问题，而不是后端真的挂了。

### 第三步：看进程的资源限制

```bash
pgrep -x pingap                              # ⚠️ 不要用 pgrep -f 'pingap -c ...'，会匹配到自己的 bash
grep 'Max open files' /proc/$(pgrep -x pingap)/limits
ls /proc/$(pgrep -x pingap)/fd | wc -l
```

拿到决定性数据：

```
Max open files    1024  (软)     524288  (硬)
已用 FD:          1021
```

**1021 / 1024 —— 彻底耗尽。**

### 第四步：为什么是 1024

```bash
grep -n 'DefaultLimitNOFILE' /etc/systemd/system.conf
# 69:#DefaultLimitNOFILE=1024:524288     ← 被注释 = 用编译期默认
grep -vE '^\s*#|^\s*$' /etc/security/limits.conf
# * soft nofile 65535     ← 这个只对 PAM 登录会话生效，对 systemd 服务无效！
```

逐个 unit 验证，**全机服务都是 1024**：

```bash
for u in $(systemctl list-unit-files --type=service --plain | awk '{print $1}'); do
  echo "$u $(systemctl show $u -p LimitNOFILESoft --value)"
done | grep 1024 | head
```

---

## 完整因果链

```
systemd 编译期默认 DefaultLimitNOFILE=1024:524288
  （/etc/security/limits.conf 的 65535 对服务无效）
        ↓
每个服务软 FD 限额都是 1024
        ↓
pingap 代理 300+ WebSocket，每个连接占 2 个 FD（客户端侧 + 上游侧）
→ 322 连接 ≈ 644 FD，加文件/DNS/健康检查 → 1021/1024
        ↓
FD 耗尽 → "failed to create socket cause: No file descriptors available (os error 24)"
        ↓
★ pingap 连自己的健康检查都开不了 socket
        ↓
健康检查失败 → 上游被标记 down
        ↓
全站 503 "No available upstream"
        ↓
客户端疯狂重连（每个重试都要新 socket）→ FD 更紧张 → 更严重
        ↓
★★ 死循环：它自己永远恢复不了，因为健康检查也需要 FD
```

**★ 这两步是这个 bug 最阴的地方**：普通服务 FD 耗尽只是自己出错；
但**反代的健康检查也走网络**，所以耗尽 = 自我熔断 + 无法自愈。

---

## 修复（全程没重启任何服务）

```bash
# 1) 对运行中的进程立即生效
prlimit --pid $(pgrep -x pingap) --nofile=524288:524288

# 2) 持久化（下次启动也生效）
mkdir -p /etc/systemd/system/pingap.service.d
printf '[Service]\nLimitNOFILE=524288:524288\n' > /etc/systemd/system/pingap.service.d/nofile.conf
systemctl daemon-reload

# 3) 系统级根治（以后任何服务都不会再踩）
sed -i 's|^#DefaultLimitNOFILE=1024:524288$|DefaultLimitNOFILE=65535:524288|' /etc/systemd/system.conf
systemctl daemon-reexec          # 只重启 PID 1 自己，运行中的服务不受影响

# 4) 触发一次 autoreload，让上游熔断状态复位
touch /etc/pingap.toml
```

**验证**：起一个临时 unit 看它实际拿到的限额

```bash
systemd-run --unit=fd-probe --property=Type=oneshot --collect \
  /bin/sh -c 'grep "Max open files" /proc/self/limits > /run/fd-probe.out'
cat /run/fd-probe.out
# Max open files   65535   524288   ← ✓
```

---

## 事故的次生影响（值得记住）

FD 耗尽期间，15 个 `/data/*.json` 请求全部 503。而前端 `data.js` 把加载失败标记为
`missing`，`useGameData()` 又**把 `missing` 当成「已就绪」**：

```js
return names.every((n) => {
  const s = data.status(n);
  return s === 'ready' || s === 'missing';   // ← missing 也算就绪
});
```

结果：**页面看着正常（不再显示加载中），但内容永久空白且不自愈**。
玩家看到的是「选策略页右侧全空」—— 必须刷新才能恢复。

日志证据：所有 `/data/` 失败**集中在 19:06:34–19:06:36**，正是上游被标记 down 的窗口。

---

## 教训

1. **长连接代理服务，FD 用量必须和限额一起看。** 我当时查过 `ss -tn | grep -c ESTAB`
   看到 443 有 322 个连接，**没顺手查 FD 限额** —— 1021/1024 是明显的告警信号。
2. **`LimitNOFILE=` 只写一个值只设硬限额。** 必须写 `软:硬`。
3. **`/etc/security/limits.conf` 对 systemd 服务无效** —— 别以为配了 65535 就安全。
4. **反代的服务不能靠自身恢复** —— 健康检查也需要 FD。要有外部 watchdog（见 `sp-watchdog.sh`）。
