#!/usr/bin/env node
// 离线字体道的浏览器复测宿主：故意做成最笨的纯静态服务（一个路径 = 一个文件，没有别名、没有 rewrite），
// 因为要验的是"镜像字节在任何只会发静态文件的宿主上都能撑起页面"——Capacitor 与 Electron 壳的最坏情况。
//
//   node scripts/offline-font-lane.mjs <payloadDir> [port=47923]
//   然后打开 http://127.0.0.1:<port>/lane.html
//
// 页面只引 <payloadDir>/webfonts/google/google.css，不加载游戏 JS —— 全程不碰生产服务器。
// 判读（2026-10-05 17:04 对 payload-c10 实测）：字体请求 10 条全部来自本机端口、对 fonts.googleapis/gstatic 0 条；
// 421 个 face 里 loaded 17 个（16 Noto Sans SC 切片 + 1 Rajdhani）；拉丁行 649.16 vs 回退 771.91 px（镜像在用）；
// ⚠️ 中文行两边宽度相等（1026.63 / 1026.63）—— CJK 是 1 em 步进，宽度证不了中文，只能靠 loaded 切片 + sha256 字节相同。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] || '.');
const PORT = Number(process.argv[3] || 47923);
const MIRROR = path.join(ROOT, 'webfonts', 'google', 'google.css');
if (!fs.existsSync(MIRROR)) {
  console.error(`${MIRROR} 不存在 —— 这一份 payload 里没有字体镜像，先确认你指的是解包后的 www 根`);
  process.exit(2);
}
const MIME = { '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript' };
const PAGE = `<!doctype html><meta charset=utf-8><title>offline font lane</title>
<link rel="stylesheet" href="/webfonts/google/google.css">
<style>body{margin:0;background:#111;color:#eee;font-size:64px;line-height:1.2}
.row{white-space:nowrap;padding:8px}.mirror{font-family:"Noto Sans SC",sans-serif;font-weight:700}
.fb{font-family:sans-serif;font-weight:700}.raj{font-family:Rajdhani,sans-serif;font-weight:700}</style>
<div class="row mirror" id="m">卫戍协议盟约 · 中文正文样本 1234</div>
<div class="row fb" id="f">卫戍协议盟约 · 中文正文样本 1234</div>
<div class="row raj" id="r">Rajdhani 0123456789 AB</div>
<div class="row fb" id="rf">Rajdhani 0123456789 AB</div>
<script>
window.__lane = async () => {
  await document.fonts.ready;
  const w = (id) => { const rg = document.createRange(); rg.selectNodeContents(document.getElementById(id)); return +rg.getBoundingClientRect().width.toFixed(2); };
  const loaded = [...document.fonts].filter((f) => f.status === 'loaded');
  return { faces: document.fonts.size, loaded: loaded.length,
    noto: loaded.filter((f) => f.family.includes('Noto Sans SC')).length,
    rajdhani: loaded.filter((f) => f.family.includes('Rajdhani')).length,
    cjk_mirror: w('m'), cjk_fallback: w('f'), latin_mirror: w('r'), latin_fallback: w('rf') };
};
</script>`;

// 只发 ROOT 下面的文件；lane.html 是内存里生成的，不落盘（避免往 payload 目录里写东西）。
http.createServer((req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/' || p === '/lane.html') { res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(PAGE); return; }
  const abs = path.join(ROOT, p.replace(/^\/+/, ''));
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
  res.end(fs.readFileSync(abs));
}).listen(PORT, '127.0.0.1', () => console.log(`lane up: http://127.0.0.1:${PORT}/lane.html  root=${ROOT}`));
