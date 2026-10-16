# closed-server — 关服公告服务

`sp.lain42.top`（以及后来接手的 `http://150.158.38.174:3000/`）**停止提供游戏服务**后，
在原地址上跑这一个程序：告诉还连过来的玩家「服务器已关闭」，并把他们引到替代服务器。

## 为什么客户端不用改

客户端的服务器选择器本来就有两条渠道，正好够用（见 `shell/picker.js`、`shell/serverList.js`）：

| 端点 | 客户端拿它干什么 | 本服务返回 |
|---|---|---|
| `GET /healthz` | 选择器那一行**原本显示版本号**的地方（`app` 字段）；同时用来区分「连错服务器」和「没有服务器」 | `app: "服务器已关闭"`、`closed: true`、`notice`、`alternatives` |
| `GET /servers.json` | 「这个服务器还推荐哪些服务器」——客户端会**自动**把它们列进选择器 | 五个替代服（`{ servers: [{ name, address, note? }] }`） |
| `GET /ws` | 真正开局用的 WebSocket | **一律不升级**（404）→ 客户端照常标红「连不上」 |
| `GET /` | 浏览器直接打开时看到的页面 | 同内容的网页版（自包含、暗色、五个可点链接） |

所以：**跑起这个程序，已经装了客户端的人下次打开就能看到提示与五个替代服，不需要重新发版。**
浏览器访问 `http://150.158.38.174:3000/` 看到的是同一套内容。

## 跑起来

零依赖，只用 Node 内置模块（Node 18+）：

```bash
node server.mjs                          # 默认 0.0.0.0:3000
PORT=3000 HOST=0.0.0.0 node server.mjs   # 显式指定
```

### systemd（推荐）

```ini
# /etc/systemd/system/sp-closed.service
[Unit]
Description=Stronghold Protocol — 关服公告页
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/sp-closed
ExecStart=/usr/bin/node /opt/sp-closed/server.mjs
Environment=PORT=3000
Environment=HOST=0.0.0.0
Restart=always
RestartSec=3
User=www-data
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sp-closed
sudo systemctl status sp-closed
```

### 临时前台跑（不开机自启）

```bash
cd /opt/sp-closed && nohup node server.mjs > closed.log 2>&1 &
```

## 自检

```bash
curl -s http://127.0.0.1:3000/healthz | head -c 200          # app 应为「服务器已关闭」
curl -s http://127.0.0.1:3000/servers.json                   # 应有五个替代服
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/ws   # 应为 404（不升级）
curl -sI http://127.0.0.1:3000/servers.json | grep -i access-control # 应有 Access-Control-Allow-Origin: *
```

## 改替代服务器清单

只改 `server.mjs` 顶部的 `ALTERNATIVES` 数组（`name` / `address` / 可选 `note`），重启即可。
网页版、`/healthz.alternatives`、`/servers.json` 三处都从这一份数组生成，不会走样。

## 端口与反代

- 直接对外：`PORT=3000 HOST=0.0.0.0`，防火墙放 3000。
- 走域名/反代（如 pingap）：把 `sp.example.com` 与 `:443` 全部转给本服务的 3000 即可；
  `/ws` 会返回 404（不是 101），这正是我们要的「不能打」。

## 注意

- 本服务**不提供服务器的任何游戏功能**，也不读 `data/`、`public/`，只回固定内容。
- `Cache-Control: no-store`：别让玩家或 CDN 把「已关闭」缓存成永久页。
- 若日后重开服：停掉本服务、把端口还给游戏进程即可，没有需要回滚的数据。
