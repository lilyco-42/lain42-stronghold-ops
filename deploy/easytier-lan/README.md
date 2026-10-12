# EasyTier LAN 部署产物（对应 docs/20-easytier-lan-m1.md §2）

2026-10-13 已部署到 sp.lain42.top 并验收通过。

## 实测验收（2026-10-13 00:45）

```
systemctl is-active easytier-lan easytier-lan-bridge   → active active
ip -o -4 addr | grep 10.126.126                        → tun0 10.126.126.1/24
ss -tlnp | grep -E ':5150|:11010'
  10.126.126.1:5150  socat          ← 桥
  0.0.0.0:11010      easytier-core  ← 监听
  127.0.0.1:5150     node22         ← 游戏服（未动）
curl http://10.126.126.1:5150/healthz
  → {"ok":true,"app":"0.2.4","sockets":57,...}   ← 端到端通
easytier-core RSS 31.5 MB / CPU 4.4%
```

## 踩坑记录（别重犯）

1. **`--private-mode` 在 2.6.4 是带值参数**：写裸 `--private-mode` 会
   `error: a value is required for '--private-mode <PRIVATE_MODE>'`（possible values: true, false）。
   必须写 `--private-mode true`。
2. **GitHub Release 直连不可用**：服务器直连 34 KB/s 且被 reset；本机走 Clash 代理
   也在 1.28 MB 处 `schannel: server closed abruptly`。**实测镜像 `gh.dev.438250.xyz`
   1.88 MB/s 最快**（ghfast.top 253 KB/s、gh-proxy.com 118 KB/s、ghproxy.net 76 KB/s）。
3. **阿里云内网 apt 源索引过期**：`apt-get install socat` 报 404，
   必须先 `apt-get update`。
4. **bridge 会先于 TUN 失败**：easytier0 未就绪时 socat 报
   `bind(5, {AF=2 10.126.126.1:5150}, 16): Cannot assign requested address`，
   靠 `Restart=on-failure` 自愈；部署后需 `systemctl restart easytier-lan-bridge` 一次确保绑定。
5. **虚拟网卡名是 `tun0`**，不是 `easytier0`（`--dev-name` 未设时的默认）。

## 重新部署

```bash
scp easytier-lan.service easytier-lan-bridge.service install-easytier-lan.sh root@sp.lain42.top:/tmp/
ssh root@sp.lain42.top 'bash /tmp/install-easytier-lan.sh'
```
凭据在 `/etc/easytier/env`（0600），已存在则不覆盖。
