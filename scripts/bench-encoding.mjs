// 编码方案对比：拿真实的 m.public 帧（86 条 / 266.4 KB）跑一遍各种编码。
//
// 指标：总字节数、编码/解码耗时、**正确性**（解出来必须和原帧逐字段一致）。
// 增量方案（delta）是有状态的：编解码双方都要保留上一帧 —— 这一点会写在结论里。
import fs from 'node:fs';
import zlib from 'node:zlib';
import { pack as mpPack, unpack as mpUnpack } from 'file:///C:/Users/liuqi/.workbuddy-ai/binaries/node/workspace/node_modules/msgpackr/index.js';
import { Encoder as CborEncoder, decode as cborDecode } from 'file:///C:/Users/liuqi/.workbuddy-ai/binaries/node/workspace/node_modules/cbor-x/index.js';

const data = JSON.parse(fs.readFileSync('ws-frames.json', 'utf8'));
const frames = [];
for (const f of data.frames) {
  if (f.dir !== 'in' || !f.text) continue;
  try {
    const j = JSON.parse(f.payload);
    if (j.t === 'm.public') frames.push(j);
  } catch { /* skip */ }
}
console.log(`载入 m.public 帧: ${frames.length} 条\n`);

const J = (o) => Buffer.from(JSON.stringify(o), 'utf8');
const cbor = new CborEncoder({ mapsAsObjects: true, useRecords: false });

// ---------- 增量：深度 diff / apply（必须处理 key 消失：draft / unite 会消失）----------
function deepDiff(a, b) {
  if (a === null || typeof a !== 'object' || b === null || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
    return a === b ? undefined : b;
  }
  if (Array.isArray(b)) {
    return JSON.stringify(a) === JSON.stringify(b) ? undefined : b;
  }
  const out = {};
  let any = false;
  for (const k of Object.keys(b)) {
    const d = deepDiff(a?.[k], b[k]);
    if (d !== undefined) { out[k] = d; any = true; }
  }
  // 被删掉的 key 必须显式告诉对面，否则 apply 会留着旧值
  const del = Object.keys(a || {}).filter((k) => !(k in b));
  if (del.length) { out.$del = del; any = true; }
  return any ? out : undefined;
}
function applyDiff(a, patch) {
  if (patch === undefined) return a;
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...(a || {}) };
  if (Array.isArray(patch.$del)) for (const k of patch.$del) delete out[k];
  for (const k of Object.keys(patch)) {
    if (k === '$del') continue;
    out[k] = applyDiff(a?.[k], patch[k]);
  }
  return out;
}

// ---------- 基准框架 ----------
const results = [];

function bench(name, encode, decode, { stateful = false } = {}) {
  // ⚠️ 有状态编码器（增量）不能预热：预热跑一次 encode 会把 prev 推前一帧，
  //    正式循环再从头开始就对不上了。无状态方案才预热。
  if (!stateful) { try { encode(frames[0]); } catch { /* ignore */ } }

  const t0 = performance.now();
  const encoded = [];
  for (const f of frames) encoded.push(encode(f));
  const encMs = performance.now() - t0;

  const t1 = performance.now();
  let ok = true;
  for (let i = 0; i < frames.length; i++) {
    const back = decode(encoded[i]);
    if (JSON.stringify(back) !== JSON.stringify(frames[i])) { ok = false; break; }
  }
  const decMs = performance.now() - t1;

  const bytes = encoded.reduce((s, b) => s + b.length, 0);
  results.push({ name, bytes, encMs, decMs, ok });
}

bench('JSON（现状基线）', (f) => J(f), (b) => JSON.parse(b.toString('utf8')));
bench('JSON + deflate(1)', (f) => zlib.deflateRawSync(J(f), { level: 1 }), (b) => JSON.parse(zlib.inflateRawSync(b).toString('utf8')));
bench('JSON + deflate(6)', (f) => zlib.deflateRawSync(J(f), { level: 6 }), (b) => JSON.parse(zlib.inflateRawSync(b).toString('utf8')));
bench('JSON + brotli(5)', (f) => zlib.brotliCompressSync(J(f), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }), (b) => JSON.parse(zlib.brotliDecompressSync(b).toString('utf8')));

bench('MessagePack', (f) => mpPack(f), (b) => mpUnpack(b));
bench('MessagePack + deflate(1)', (f) => zlib.deflateRawSync(mpPack(f), { level: 1 }), (b) => mpUnpack(zlib.inflateRawSync(b)));

bench('CBOR', (f) => Buffer.from(cbor.encode(f)), (b) => cborDecode(b));
bench('CBOR + deflate(1)', (f) => zlib.deflateRawSync(Buffer.from(cbor.encode(f)), { level: 1 }), (b) => cborDecode(zlib.inflateRawSync(b)));

// 增量（有状态）
{
  let prev = null, prevOut = null;
  bench('增量 JSON',
    (f) => { const p = deepDiff(prev, f); prev = f; return J(p === undefined ? null : p); },
    (b) => { const p = JSON.parse(b.toString('utf8')); const out = applyDiff(prevOut, p); prevOut = out; return out; }, { stateful: true });
}
{
  let prev = null, prevOut = null;
  bench('增量 JSON + deflate(1)',
    (f) => { const p = deepDiff(prev, f); prev = f; return zlib.deflateRawSync(J(p === undefined ? null : p), { level: 1 }); },
    (b) => { const p = JSON.parse(zlib.inflateRawSync(b).toString('utf8')); const out = applyDiff(prevOut, p); prevOut = out; return out; }, { stateful: true });
}
{
  let prev = null, prevOut = null;
  bench('增量 MessagePack + deflate(1)',
    (f) => { const p = deepDiff(prev, f); prev = f; return zlib.deflateRawSync(mpPack(p === undefined ? null : p), { level: 1 }); },
    (b) => { const p = mpUnpack(zlib.inflateRawSync(b)); const out = applyDiff(prevOut, p); prevOut = out; return out; }, { stateful: true });
}

// ---------- 输出 ----------
const base = results[0].bytes;
console.log('方案'.padEnd(30) + '总字节'.padStart(10) + '省'.padStart(8) + '编码ms'.padStart(9) + '解码ms'.padStart(9) + '  正确');
console.log('-'.repeat(76));
for (const r of results) {
  const save = (100 * (1 - r.bytes / base)).toFixed(1) + '%';
  console.log(
    r.name.padEnd(30) +
    (r.bytes / 1024).toFixed(1).padStart(10) +
    save.padStart(8) +
    r.encMs.toFixed(1).padStart(9) +
    r.decMs.toFixed(1).padStart(9) +
    (r.ok ? '    ✓' : '    ✗ 数据不一致!')
  );
}
console.log('\n（86 帧合计；"省" 相对 JSON 基线）');

// 帧头开销：WebSocket 每帧 2-14 字节，permessage-deflate 每消息再带 4 字节尾
const n = frames.length;
console.log(`\n传输层开销估算（${n} 帧）：`);
console.log(`  WS 帧头 2-14B/帧  ≈ ${(n * 6 / 1024).toFixed(2)} KB（占 JSON 基线 ${(100 * n * 6 / base).toFixed(2)}%）`);
console.log(`  permessage-deflate 尾 4B/帧 ≈ ${(n * 4 / 1024).toFixed(2)} KB`);
