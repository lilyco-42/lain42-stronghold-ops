#!/usr/bin/env node
// 切流预检：站内代码真正引用的每一个 OSS 路径，在新桶上是不是真的拿得到。
// 为什么要有这条：把 dl.lain42.top 换成 dl.lilyco42.top 之前，只要有一个键不在桶里，
// 那个页面就是当场坏掉。而"我核过 54 个键全绿"并不覆盖这件事 —— 期望表来自
// 下载清单与 2026-09-28 那份 OSS 清单，**不等于**站内代码实际会去取哪些路径。
//
// 两类引用都要看：
//   1) 写全的 https://dl.lain42.top/… 字面量（正则能抓到）
//   2) 用 base 拼出来的（正则抓不到，只能把代码里出现的相对路径列进 CONCAT_KEYS）
//      这一份是要人工跟着站内代码维护的，漏了就是假绿。
//
// 用法：node scripts/check-cutover-readiness.mjs [Pages仓库路径]
import { execFileSync } from 'node:child_process';
import { argv } from 'node:process';

const REPO = argv[2] || 'D:/Code/lilyco-42.github.io';
const BASE = 'https://dl.lilyco42.top/';
// 站内以 OSS + '…' 形式拼接出来的具体文件（2026-10-12 从 lyco_chat / models 页面里读出来的）
const CONCAT_KEYS = [
  'wasm/wllama/3.6.1/index.min.js',
  'wasm/wllama/3.6.1/wllama.wasm',
  'wasm/wllama/3.6.1/compat/wllama.js',
  'wasm/wllama/3.6.1/compat/wllama.wasm',
  'wasm/highs/1.15.3/build/highs.mjs',
];
// 正向对照：今天整段验过 sha256 的对象，它若拿不到就是本脚本或网络坏了，不是桶空了
const CONTROL = 'lyco-dl/lyco-windows.zip';

const grep = execFileSync(
  'git',
  ['-C', REPO, 'grep', '-hI', '-oE', 'https://dl\\.lain42\\.top/[A-Za-z0-9_.\\/-]+', '--', '.'],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
);
const keys = new Set(CONCAT_KEYS);
for (const line of grep.split('\n')) {
  const m = line.trim().match(/^https:\/\/dl\.lain42\.top\/(.+)$/);
  if (m) keys.add(m[1].replace(/\/+$/, ''));
}

const probe = async (k) => {
  try {
    const r = await fetch(BASE + k, { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(25000) });
    const total = (r.headers.get('content-range') || '').split('/')[1] || '-';
    await r.body?.cancel().catch(() => {});
    return { code: r.status, total };
  } catch (e) {
    return { code: 'ERR', total: String(e.cause?.message ?? e.message).slice(0, 40) };
  }
};

const ctrl = await probe(CONTROL);
if (ctrl.code !== 200 && ctrl.code !== 206) {
  console.error(`正向对照都失败（${ctrl.code} ${ctrl.total}）→ 探测不可信，本次结论作废`);
  process.exitCode = 3;
}
console.log(`正向对照 ${CONTROL} → ${ctrl.code}`);

const fileish = [];
const prefix = [];
for (const k of [...keys].sort()) {
  const p = await probe(k);
  const line = `${String(p.code).padEnd(4)} ${(p.total || '-').padEnd(11)} ${k}`;
  if (p.code === 200 || p.code === 206) console.log('OK   ' + line);
  else if (/\.[a-z0-9]{2,5}$/i.test(k)) {
    fileish.push(line);
    console.log('MISS ' + line);
  } else {
    prefix.push(line);
    console.log('（前缀，不是文件）' + line);
  }
}
console.log(`\n合计 ${keys.size} 条：拿不到的"看起来是文件"的 ${fileish.length} 条，目录前缀 ${prefix.length} 条`);
if (fileish.length) {
  console.error('这些键切过去就是 404，先补进桶或让那一页继续指向原处：\n  ' + fileish.join('\n  '));
  process.exitCode = 1;
} else if (!process.exitCode) {
  console.log('站内引用的路径在新桶上全部可达');
}
