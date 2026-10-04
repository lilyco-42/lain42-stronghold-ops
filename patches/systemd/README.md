# systemd 侧改动

四个文件，都是「写进去就生效、不用重启业务」的类型。

---

## 1. `/etc/systemd/system.conf` —— 根因修复

```diff
-#DefaultLimitNOFILE=1024:524288
+DefaultLimitNOFILE=65535:524288
```

改完执行 `systemctl daemon-reexec`（**只重启 PID 1 自己，不动任何运行中的服务**）。

### 为什么这是根因

systemd 的编译期默认值是 `1024:524288`（软 1024 / 硬 524288）。
Debian 的 `/etc/security/limits.conf` 里通常写着 `* soft nofile 65535`，
但**那只对 PAM 登录会话生效，对 systemd 服务完全无效**。

所以这台机器上**每一个服务**启动时拿到的软限额都是 1024：

```bash
$ systemctl show <任意 unit> -p LimitNOFILESoft
LimitNOFILESoft=1024
```

pingap 代理 300+ 个 WebSocket 长连接，每个占 2 个 FD（客户端侧 + 上游侧）
→ 322 连接 ≈ 644 FD，再加文件/DNS/健康检查，**1021 就在天花板下**。

### 死循环（这才是真正致命的地方）

```
FD 耗尽（os error 24 EMFILE）
  → pingap 连自己的「健康检查」都开不了 socket
  → 健康检查失败 → 上游被标记 down
  → 全站 503 "No available upstream"
  → 客户端疯狂重连 → 开更多 socket → 更多 EMFILE
```

**它自己永远恢复不了**，因为健康检查本身也需要 FD。

### ⚠️ 关键坑

`LimitNOFILE=` **只写一个值只设「硬」限额**。必须写 `软:硬` 两段：

```ini
LimitNOFILE=524288:524288     # 对
LimitNOFILE=524288            # 错 —— 软限额还是 1024
```


## 2. `pingap.service.d/nofile.conf` —— 双保险

上面的系统级默认是「以后新起的服务」生效；pingap 当时已经在跑了，
所以额外给它一个 drop-in，值比系统默认更高。

用 `prlimit` 可以对**运行中的进程**立即生效，不用重启：

```bash
prlimit --pid $(pgrep -x pingap) --nofile=524288:524288
```


## 3~5. `*-oom-protect.conf` —— OOM 保护

起因：`oom_score_adj` 里只有 `postgres`(-900)、`dockerd`(-500) 有保护，
**游戏、反代、redis 全是 0** —— 真 OOM 时内核会「随机挑一个」杀，
可能杀掉游戏或数据库。

| 服务 | OOMScoreAdjust | 理由 |
|---|---|---|
| stronghold | **-900** | 游戏本体，最不能死 |
| pingap | **-800** | 反代，它挂了全站打不开 |
| redis-server | **-500** | 缓存/会话 |

> ⚠️ **pingap 是反代，绝对不能停它** —— 所有 443 流量都过它。
> 「关掉其他服务省资源」时，pingap 和 stronghold 必须在白名单里。

写入后立即对运行中的进程生效（`echo <值> > /proc/<pid>/oom_score_adj`），
drop-in 保证下次重启也保持。
