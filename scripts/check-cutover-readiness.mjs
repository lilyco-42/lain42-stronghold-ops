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
// 用法：node scripts/check-cutover-readiness.mjs <Pages仓库路径>（必须给，CI 里给 checkout 出来的 'pages'）
import { execFileSync } from 'node:child_process';
import { argv } from 'node:process';

const REPO = argv[2];
if (!REPO) {
  // 不再默认某个人的 Windows 路径：那样 CI 会像上一版闸门一样 ENOENT，
  // 而如果被 || 吞掉就永远没人发现。要么显式传目录，要么明确报错。
  console.error('用法: node scripts/check-cutover-readiness.mjs <Pages 仓库目录>');
  process.exit(2);
}
const BASE = 'https://dl.lilyco42.top/';
// 站内以 OSS + '…' 形式拼接出来的具体文件（2026-10-12 从 lyco_chat / models 页面里读出来的）
const CONCAT_KEYS = [
  'wasm/wllama/3.6.1/index.min.js',
  'wasm/wllama/3.6.1/wllama.wasm',
  'wasm/wllama/3.6.1/compat/wllama.js',
  'wasm/wllama/3.6.1/compat/wllama.wasm',
  'wasm/highs/1.15.3/build/highs.mjs',
];
// 已知缺口 = 切流决定还没做的四条。把它们钉在这里，闸门才有意义：
//   · 出现第五条新缺口 → 红（这才是"漂移检测"）
//   · 这四条里有任何一条被补齐 → 也红（提醒把这里删掉，否则缺口清单会过期）
// 决定之后把整个数组清空，这一步就变成"站内引用必须全部可达"的硬闸门。
const EXPECTED_MISSING = [
  'models/hf/catalog.json',
  'wasm/transformers-js/3.8.1/transformers.bundle.mjs',
  'wasm/wllama/3.6.1/compat/wllama.js',
  'wasm/wllama/3.6.1/compat/wllama.wasm',
];
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

const newMissing = [];
const stillMissing = [];
const healed = [];
let reachable = 0;
for (const k of [...keys].sort()) {
  const p = await probe(k);
  const isFile = /\.[a-z0-9]{2,5}$/i.test(k);
  const gone = p.code !== 200 && p.code !== 206;
  if (!gone) {
    reachable += 1;
    console.log(`OK   ${String(p.code).padEnd(4)} ${(p.total || '-').padEnd(11)} ${k}`);
    if (EXPECTED_MISSING.includes(k)) healed.push(k);
  } else if (!isFile) {
    console.log(`（前缀，不是文件）${String(p.code).padEnd(4)} ${k}`);
  } else if (EXPECTED_MISSING.includes(k)) {
    stillMissing.push(k);
    console.log(`已知缺口 ${String(p.code).padEnd(4)} ${k}`);
  } else {
    newMissing.push(k);
    console.log(`NEW-MISS ${String(p.code).padEnd(4)} ${k}`);
  }
}

console.log(`\n引用 ${keys.size} 条：可达 ${reachable}，已知缺口 ${stillMissing.length}，新缺口 ${newMissing.length}`);
// 两个方向都要报：新缺口是"又要多坏一页"，被补齐是"这里的清单过期了，删掉它"。
// 只报前者会让缺口清单永远悄悄烂在里面。
if (newMissing.length) {
  console.error('出现新的缺口（切过去就是 404）：\n  ' + newMissing.join('\n  '));
  process.exitCode = 1;
}
if (healed.length) {
  console.error('这些键已经能取到了，请把 EXPECTED_MISSING 里对应条目删掉：\n  ' + healed.join('\n  '));
  process.exitCode = process.exitCode || 1;
}
if (!newMissing.length && !healed.length && !process.exitCode) {
  console.log(`站内引用在新桶上除已知 ${EXPECTED_MISSING.length} 条缺口外全部可达`);
}
