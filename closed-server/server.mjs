#!/usr/bin/env node
// server.mjs — 关服公告服务（原 sp.lain42.top / 150.158.38.174:3000 的位置）
//
// 为什么只要这一个程序：客户端的服务器选择器本来就有两条现成的渠道，正好承接这件事 ——
//
//   1) `GET /healthz` 的 `app` 字段就是选择器那一行上「原本显示版本号」的位置（`shell/picker.js`
//      把 /healthz 的 app 原样显示出来，用于区分「连错服务器」和「没有服务器」）。这里把它填成
//      「服务器已关闭」，玩家在客户端里看到的就是这句话。
//   2) `GET /servers.json` 是「这个服务器推荐哪些服务器」的渠道（`shell/serverList.js`，
//      `{ servers: [{ name, address, note? }] }`）。这里给出五个替代服，客户端会**自动**把它们
//      列进选择器，玩家点一下就能过去。
//   3) `/ws` 一律不升级：握手失败就是「这台已经不能打了」的既成事实，客户端会照常标红。
//
// 所以客户端一行都不用改、不用重新发版：跑起这个程序，已经装了客户端的人下次打开就能看到提示
// 和五个替代服。浏览器直接访问 http://150.158.38.174:3000/ 看到的是同一套内容的网页版。
//
// 零依赖（只用 node: 内置模块），Node 18+ 即可：
//   node server.mjs                    # 前台跑，默认 0.0.0.0:3000
//   PORT=3000 HOST=0.0.0.0 node server.mjs

import http from 'node:http';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

/** 客户端 /healthz 那一行显示的文本（原来是版本号）。 */
const CLOSED_TEXT = '服务器已关闭';

/** 替代服务器。`/servers.json` 会把它们推给客户端的选择器；网页版也是同一份清单。 */
const ALTERNATIVES = [
  {
    name: '独立版 · 萧扬',
    address: 'https://xymx1234.github.io/stronghold-standalone/',
    note: 'GitHub Pages 上的独立版，浏览器直接开',
  },
  { name: '网友服 · rainya', address: 'https://sp.rainya.me:10166/play' },
  { name: '网友服 · linxia', address: 'https://wei.linxia.dev/' },
  { name: '网友服 · stardust', address: 'https://ark-proto.stardust.matce.cn/', note: '协议原型服' },
  { name: '网友服 · xiaolubao', address: 'https://game.xiaolubao.com/' },
];

/** 一条公告；/healthz 的 notice 与网页版共用。 */
const NOTICE = '本服务器已停止服务，请到下列替代服务器游玩。';

// ---- 网页版（自包含，无外部资源；暗色，与游戏同一套观感） ----------------------------------------------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const page = ({ title, heading, body }) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="dark" />
<meta name="robots" content="noindex" />
<title>${esc(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; padding: 2rem 1.1rem 3rem;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    background: radial-gradient(1200px 600px at 50% -10%, #16211f 0%, #0c0f0e 60%);
    color: #e6ede9; font: 16px/1.65 "Noto Sans SC", -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  .card { width: 100%; max-width: 40rem; }
  h1 { margin: 0 0 .35rem; font-size: 1.6rem; letter-spacing: .02em; }
  h1 em { font-style: normal; color: #7fd4b4; }
  p { margin: .35rem 0 0; color: #a7b4ae; }
  .servers { list-style: none; margin: 1.5rem 0 0; padding: 0; display: grid; gap: .6rem; }
  .servers a {
    display: block; padding: .8rem 1rem; border: 1px solid #24312d; border-radius: .7rem;
    background: #121816; color: inherit; text-decoration: none; transition: border-color .15s, background .15s;
  }
  .servers a:hover { border-color: #3f6b5c; background: #16201d; }
  .servers b { display: block; font-weight: 600; }
  .servers span { display: block; margin-top: .15rem; font-size: .84rem; color: #7c8b85; word-break: break-all; }
  footer { margin-top: 1.8rem; font-size: .8rem; color: #5e6b66; }
</style>
</head>
<body>
  <main class="card">
    <h1>${heading}</h1>
    <p>${esc(NOTICE)}</p>
    <ul class="servers">
${ALTERNATIVES.map((s) => `      <li><a href="${esc(s.address)}" target="_blank" rel="noopener noreferrer"><b>${esc(s.name)}</b><span>${esc(s.address)}${s.note ? `　·　${esc(s.note)}` : ''}</span></a></li>`).join('\n')}
    </ul>
    <footer>卫戍协议：盟约 · 非官方同人作品 · 游戏素材版权归 上海鹰角网络 / Yostar 所有</footer>
  </main>
</body>
</html>
`;

// ---- HTTP ----------------------------------------------------------------------------------------------

function sendJson(res, code, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    // 打包好的客户端是跨源读这两个端点的（docs/SERVER-LIST.md）
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

function sendHtml(res, code, body) {
  const payload = Buffer.from(body);
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  let pathname = '/';
  let query = '';
  try {
    const u = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    pathname = u.pathname;
    query = u.search;
  } catch { /* 畸形请求按根路径处理 */ }

  // 预检（跨源读 /healthz 与 /servers.json）
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: 'method_not_allowed', notice: NOTICE });
    return;
  }

  // 选择器那一行：app 就是「原本显示版本号」的位置
  if (pathname === '/healthz') {
    sendJson(res, 200, {
      ok: true,
      app: CLOSED_TEXT,          // ← 客户端原样显示
      protocol: 1,
      closed: true,              // ← 给认得这个字段的客户端一个明确信号
      rooms: 0,
      matches: 0,
      sessions: 0,
      sockets: 0,
      notice: NOTICE,
      alternatives: ALTERNATIVES.map((a) => a.address),
    });
    return;
  }

  // 「这个服务器推荐哪些服务器」—— 客户端会自动列进选择器
  if (pathname === '/servers.json') {
    sendJson(res, 200, {
      servers: ALTERNATIVES.map((a) => (a.note ? { name: a.name, address: a.address, note: a.note } : { name: a.name, address: a.address })),
    });
    return;
  }

  // 真去打游戏的路径：一律不升级，让它就是「连不上」
  if (pathname === '/ws' || pathname.endsWith('/ws')) {
    sendJson(res, 404, { ok: false, error: 'server_closed', notice: NOTICE, alternatives: ALTERNATIVES.map((a) => a.address) });
    return;
  }

  // 网页版（也兜住 /index.html、/play 之类的常见入口）
  if (pathname === '/' || pathname === '/index.html' || pathname === '/play' || pathname === '/play/') {
    sendHtml(res, 200, page({ title: '服务器已关闭 · 卫戍协议：盟约', heading: '服务器<em>已关闭</em>', body: NOTICE }));
    return;
  }

  sendHtml(res, 404, page({ title: '页面不存在 · 卫戍协议：盟约', heading: '页面<em>不存在</em>', body: '这台服务器已经停止服务。' }));
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '::' || HOST === '0.0.0.0' ? 'all interfaces' : HOST;
  console.log(`[closed-server] 已启动 http://${shown}:${PORT}/`);
  console.log(`[closed-server] /healthz 的 app = 「${CLOSED_TEXT}」；/servers.json 推荐 ${ALTERNATIVES.length} 个替代服`);
  for (const a of ALTERNATIVES) console.log(`[closed-server]   · ${a.name} → ${a.address}`);
});

// 容器/systemd 里收到信号就干净退出
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[closed-server] 收到 ${sig}，正在关闭…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
