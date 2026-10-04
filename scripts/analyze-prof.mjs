// 深挖 cpuprofile：把所有「非 idle」的采样点按函数归类，特别找 zlib / 压缩相关。
import fs from 'node:fs';

const p = JSON.parse(fs.readFileSync('/tmp/prof.cpuprofile', 'utf8'));
const byId = new Map(p.nodes.map((n) => [n.id, n]));

const total = p.nodes.reduce((s, n) => s + (n.hitCount || 0), 0);

// 采样点归属：V8 的 hitCount 是 self time
const rows = [];
for (const n of p.nodes) {
  const h = n.hitCount || 0;
  if (!h) continue;
  const cf = n.callFrame;
  rows.push({
    h,
    fn: cf.functionName || '(匿名)',
    url: (cf.url || '').replace('file:///opt/Stronghold-Protocol/', ''),
    line: cf.lineNumber + 1,
  });
}

const idle = rows.filter((r) => r.fn === '(idle)').reduce((s, r) => s + r.h, 0);
const nonIdle = total - idle;
console.log(`采样点总数 ${total}，其中 idle ${idle}（${((idle / total) * 100).toFixed(1)}%）`);
console.log(`非 idle（真实工作量）${nonIdle} —— 下面所有百分比都以它为分母\n`);

// 1) 找压缩相关（函数名或 url）
const zlibRe = /zlib|deflate|inflate|compress|Zlib|Deflate|Inflate|Compress/i;
const z = rows.filter((r) => zlibRe.test(r.fn) || zlibRe.test(r.url));
const zHits = z.reduce((s, r) => s + r.h, 0);
console.log(`=== 压缩相关 ===`);
console.log(`  合计 ${zHits} 点 = 非 idle 的 ${((zHits / nonIdle) * 100).toFixed(2)}%`);
z.sort((a, b) => b.h - a.h).slice(0, 12).forEach((r) =>
  console.log(`    ${((r.h / nonIdle) * 100).toFixed(2).padStart(5)}%  ${r.fn}  @${r.url || '(native)'}:${r.line}`));

// 2) 全部非 idle 热点 TOP 25
console.log(`\n=== 非 idle 热点 TOP 25 ===`);
const agg = new Map();
for (const r of rows) {
  if (r.fn === '(idle)') continue;
  const k = `${r.fn}  @${r.url || '(native)'}:${r.line}`;
  agg.set(k, (agg.get(k) || 0) + r.h);
}
[...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([k, h]) =>
  console.log(`  ${((h / nonIdle) * 100).toFixed(2).padStart(5)}%  ${k}`));

// 3) 按模块归类
const buckets = new Map();
function bucket(r) {
  const u = r.url;
  if (zlibRe.test(r.fn) || zlibRe.test(u)) return '压缩 zlib';
  if (/^node:/.test(u)) return `Node 内部 ${u}`;
  if (!u) return 'native/V8/GC';
  if (/server\/sim\//.test(u)) return '游戏模拟 server/sim';
  if (/server\/match\//.test(u)) return '对局逻辑 server/match';
  if (/server\/(net|lobby|index|data)\.js/.test(u)) return '网络/大厅 server';
  return '其它 ' + u.split('/').slice(0, 2).join('/');
}
for (const r of rows) {
  if (r.fn === '(idle)') continue;
  const b = bucket(r);
  buckets.set(b, (buckets.get(b) || 0) + r.h);
}
console.log(`\n=== 按模块（非 idle 占比）===`);
[...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).forEach(([b, h]) =>
  console.log(`  ${((h / nonIdle) * 100).toFixed(1).padStart(5)}%  ${b}`));
