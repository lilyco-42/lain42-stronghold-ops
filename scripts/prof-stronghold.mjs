// 给运行中的 stronghold 做一次 CPU profile，找出真正的热点。
//
// 原理：`kill -USR1 <pid>` 会让 Node 在 127.0.0.1:9229 打开 inspector（不用重启），
// 然后用 CDP 连上去开 Profiler。全程只读，不影响服务。
//
// 用法：node prof-stronghold.mjs [秒数]
import fs from 'node:fs';

// WebSocket 实现：优先用运行时自带的全局（node ≥22），否则退回游戏自带的 ws 包
// （服务器上 node 可能是 v20；ws 是 CJS，导入后要取 .WebSocket 或 .default）
let WS = globalThis.WebSocket;
if (typeof WS !== 'function') {
  const mod = await import('/opt/Stronghold-Protocol/node_modules/ws/index.js');
  WS = mod.WebSocket || mod.default;
}
if (typeof WS !== 'function') {
  console.error('找不到可用的 WebSocket 实现');
  process.exit(1);
}

const SECS = Number(process.argv[2] || 25);
const PORT = 9229;

// 1) 找到 inspector 的 webSocketDebuggerUrl
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.find((t) => t.webSocketDebuggerUrl);
if (!target) {
  console.error('找不到 inspector target');
  process.exit(1);
}
console.log(`连接 ${target.title || 'node'} (${target.webSocketDebuggerUrl})`);

const ws = new WS(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const myId = ++id;
    pending.set(myId, { res, rej });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

await new Promise((r) => (ws.onopen = r));
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  }
};

console.log('Profiler.enable / start');
await send('Profiler.enable');
await send('Profiler.setSamplingInterval', { interval: 200 }); // 200µs 采样
await send('Profiler.start');

console.log(`采样 ${SECS} 秒...`);
await new Promise((r) => setTimeout(r, SECS * 1000));

const { profile } = await send('Profiler.stop');
console.log('采样完成，分析中...\n');

// 2) 把采样点归到函数上
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
for (const n of profile.nodes) self.set(n.id, n.hitCount || 0);

const totalHits = [...self.values()].reduce((a, b) => a + b, 0);

// 按函数聚合
const agg = new Map();
for (const [nid, hits] of self) {
  if (!hits) continue;
  const n = byId.get(nid);
  const cf = n.callFrame;
  const url = (cf.url || '').replace(/^file:\/\/\/opt\/Stronghold-Protocol\//, '');
  const key = `${cf.functionName || '(匿名)'}  @${url}:${cf.lineNumber + 1}`;
  agg.set(key, (agg.get(key) || 0) + hits);
}

// 按文件聚合
const byFile = new Map();
for (const [nid, hits] of self) {
  if (!hits) continue;
  const n = byId.get(nid);
  const url = (n.callFrame.url || '(native)').replace(/^file:\/\/\/opt\/Stronghold-Protocol\//, '').replace(/^node:/, 'node:');
  byFile.set(url, (byFile.get(url) || 0) + hits);
}

console.log('=== 按文件（self time 占比）===');
[...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).forEach(([f, h]) => {
  console.log(`  ${((h / totalHits) * 100).toFixed(1).padStart(5)}%  ${f}`);
});

console.log('\n=== 热点函数 TOP 20 ===');
[...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([k, h]) => {
  console.log(`  ${((h / totalHits) * 100).toFixed(1).padStart(5)}%  ${k}`);
});

// 3) 归类：压缩 / 序列化 / 模拟 / 其它
const bucket = { 压缩: 0, 序列化: 0, 模拟: 0, 网络: 0, 其它: 0 };
for (const [nid, hits] of self) {
  if (!hits) continue;
  const n = byId.get(nid);
  const f = (n.callFrame.functionName || '') + ' ' + (n.callFrame.url || '');
  if (/zlib|deflate|inflate|Deflate|Inflate|Zlib|zlib_|compress/i.test(f)) bucket.压缩 += hits;
  else if (/stringify|JSON\.|parse|serialize/i.test(f)) bucket.序列化 += hits;
  else if (/sim\/|Battle|spec\.js|simdata/i.test(f)) bucket.模拟 += hits;
  else if (/net\.js|WebSocket|socket|send|write/i.test(f)) bucket.网络 += hits;
  else bucket.其它 += hits;
}
console.log('\n=== 归类（粗略，按函数名/路径匹配）===');
for (const [k, v] of Object.entries(bucket).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${((v / totalHits) * 100).toFixed(1).padStart(5)}%  ${k}`);
}

fs.writeFileSync('/tmp/prof.cpuprofile', JSON.stringify(profile));
console.log(`\n采样点总数: ${totalHits}，完整 profile 存到 /tmp/prof.cpuprofile`);
ws.close();
process.exit(0);
