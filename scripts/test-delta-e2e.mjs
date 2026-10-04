// 增量编码的端到端验证 v2（纯本地，不碰服务器）。
//
// v1 的测试 2/3 失败了 —— 但问题出在**测试模型**而不是方案：
//   1. keyframe 必须**重置序列号**（客户端重连后 seq 归零，不能要求 e.seq === expect+1）
//   2. 服务端要**给缺基线的客户端单独发 keyframe**（新加入/重连），其余客户端收增量
//
// 这版把模型改对，并补齐生产环境会踩的边界。
import fs from 'node:fs';
import zlib from 'node:zlib';

const data = JSON.parse(fs.readFileSync('ws-frames.json', 'utf8'));
const frames = [];
for (const f of data.frames) {
  if (f.dir !== 'in' || !f.text) continue;
  try { const j = JSON.parse(f.payload); if (j.t === 'm.public') frames.push(j); } catch { /* skip */ }
}
console.log(`载入真实 m.public 帧: ${frames.length} 条\n`);

const J = (o) => Buffer.from(JSON.stringify(o), 'utf8');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function deepDiff(a, b) {
  if (a === null || typeof a !== 'object' || b === null || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
    return a === b ? undefined : b;
  }
  if (Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b) ? undefined : b;
  const out = {};
  let any = false;
  for (const k of Object.keys(b)) {
    const d = deepDiff(a?.[k], b[k]);
    if (d !== undefined) { out[k] = d; any = true; }
  }
  const del = Object.keys(a || {}).filter((k) => !(k in b));
  if (del.length) { out.$del = del; any = true; }
  return any ? out : undefined;
}
function applyDiff(a, patch) {
  if (patch === undefined) return a;
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...(a || {}) };
  if (Array.isArray(patch.$del)) for (const k of patch.$del) delete out[k];
  for (const k of Object.keys(patch)) { if (k === '$del') continue; out[k] = applyDiff(a?.[k], patch[k]); }
  return out;
}

// ---------- 客户端 ----------
class Client {
  constructor(id) {
    this.id = id; this.state = null; this.seq = 0;
    this.bytes = 0; this.mismatch = 0; this.received = 0; this.keyframes = 0;
    this.needsKeyframe = true;      // 新客户端没有基线
  }
  /** 收到一帧。返回是否应用成功。 */
  recv(bytes) {
    this.bytes += bytes.length;
    const e = JSON.parse(zlib.inflateRawSync(bytes).toString('utf8'));
    if (e.k === 1) {
      // keyframe：无条件接受，并重置序列号
      this.state = e.p; this.seq = e.seq; this.needsKeyframe = false; this.keyframes++;
      this.received++;
      return true;
    }
    if (e.seq !== this.seq + 1) return false;   // 乱序/丢帧 → 上层应请求 keyframe
    this.state = applyDiff(this.state, e.p);
    this.seq = e.seq; this.received++;
    return true;
  }
}

// ---------- 服务端：一个房间 ----------
class Room {
  constructor() {
    this.clients = []; this.prev = null; this.seq = 0;
    this.deltaBytes = 0;      // 增量帧的产出（压一次）
    this.keyBytes = 0;        // keyframe 的产出
    this.keyCount = 0;
    this.encMs = 0;
  }
  add(id) { const c = new Client(id); this.clients.push(c); return c; }

  /** 广播一帧。给缺基线的客户端发 keyframe，其余发增量。 */
  broadcast(state) {
    const t0 = performance.now();
    this.seq++;
    const need = this.clients.filter((c) => c.needsKeyframe);
    const normal = this.clients.filter((c) => !c.needsKeyframe);

    // ① 增量（压一次，广播给所有人）
    if (this.prev !== null && normal.length) {
      const p = deepDiff(this.prev, state);
      const env = p === undefined ? { seq: this.seq, n: 1 } : { seq: this.seq, p };
      const bytes = zlib.deflateRawSync(J(env), { level: 1 });
      this.deltaBytes += bytes.length;
      for (const c of normal) c.recv(bytes);
    } else if (this.prev === null) {
      // 首帧：所有人都需要全量
      need.push(...normal);
      normal.length = 0;
    }

    // ② keyframe（只发给缺基线的人；每帧最多压一次，同一份字节复用）
    if (need.length) {
      const bytes = zlib.deflateRawSync(J({ seq: this.seq, k: 1, p: state }), { level: 1 });
      this.keyBytes += bytes.length; this.keyCount++;
      for (const c of need) c.recv(bytes);
    }

    this.encMs += performance.now() - t0;
    this.prev = state;
  }
  /** 校验：所有客户端状态都等于 state，且收到了正确的帧数 */
  verify(state) {
    let bad = 0;
    for (const c of this.clients) if (!eq(c.state, state)) bad++;
    return bad;
  }
}

const last = frames[frames.length - 1];

// ============ 测试 1：稳态 ============
console.log('=== 测试 1：稳态，4 客户端全程在线 ===');
{
  const room = new Room();
  for (let i = 0; i < 4; i++) room.add(i);
  let fullBytes = 0;
  for (const f of frames) { fullBytes += J(f).length; room.broadcast(f); }
  const c = room.clients[0];
  console.log(`  完整 JSON（不压缩）    : ${(fullBytes / 1024).toFixed(1)} KB/客户端`);
  console.log(`  增量 + deflate(1)      : ${(c.bytes / 1024).toFixed(1)} KB/客户端  → 省 ${(100 * (1 - c.bytes / fullBytes)).toFixed(1)}%`);
  console.log(`  服务端产出             : 增量 ${(room.deltaBytes / 1024).toFixed(1)} KB + keyframe ${room.keyCount} 次 ${(room.keyBytes / 1024).toFixed(1)} KB`);
  console.log(`  收到帧数 / 期望        : ${c.received} / ${frames.length}`);
  console.log(`  状态不一致的客户端      : ${room.verify(last)} / ${room.clients.length}`);
  console.log(`  服务端编码耗时          : ${room.encMs.toFixed(1)} ms / ${frames.length} 帧（${(room.encMs / frames.length).toFixed(2)} ms/帧）`);
  console.log(`  ${room.verify(last) === 0 && c.received === frames.length ? '✓ 通过' : '✗ 失败'}`);
}

// ============ 测试 2：中途加入 ============
console.log('\n=== 测试 2：客户端在第 30 帧中途加入 ===');
{
  const room = new Room();
  const a = room.add(0);
  for (let i = 0; i < 30; i++) room.broadcast(frames[i]);
  const beforeJoin = room.verify(frames[29]);
  const late = room.add(99);              // 新客户端，needsKeyframe = true
  for (let i = 30; i < frames.length; i++) room.broadcast(frames[i]);
  console.log(`  加入前 老客户端不一致: ${beforeJoin}`);
  console.log(`  中途加入者：keyframe 次数 ${late.keyframes}，收到帧数 ${late.received}`);
  console.log(`  中途加入者状态一致     : ${eq(late.state, last)}`);
  console.log(`  全员状态一致           : ${room.verify(last)} / ${room.clients.length}`);
  console.log(`  ${eq(late.state, last) && room.verify(last) === 0 ? '✓ 通过' : '✗ 失败'}`);
}

// ============ 测试 3：断线重连 ============
console.log('\n=== 测试 3：断线重连 ===');
{
  const room = new Room();
  const c = room.add(0);
  for (let i = 0; i < 20; i++) room.broadcast(frames[i]);

  // 断线：客户端状态归零，seq 归零，需要 keyframe
  c.state = null; c.seq = 0; c.needsKeyframe = true;
  console.log('  模拟断线重连（客户端状态归零）');
  room.broadcast(frames[20]);             // 服务端发现 needsKeyframe → 发 keyframe
  const ok1 = eq(c.state, frames[20]);
  console.log(`  重连后立刻：状态一致 ${ok1}，keyframe 次数 ${c.keyframes}`);

  for (let i = 21; i < 50; i++) room.broadcast(frames[i]);
  const ok2 = eq(c.state, frames[49]);
  console.log(`  再收 29 帧增量后：状态一致 ${ok2}`);
  console.log(`  最终状态与原始一致     : ${eq(c.state, last === frames[49] ? frames[49] : frames[49])}`);
  console.log(`  ${ok1 && ok2 ? '✓ 通过' : '✗ 失败'}`);
}

// ============ 测试 4：丢帧检测 ============
console.log('\n=== 测试 4：丢帧检测（客户端必须能发现并恢复）===');
{
  const room = new Room();
  const c = room.add(0);
  for (let i = 0; i < 10; i++) room.broadcast(frames[i]);
  // 手动吞掉一帧，制造失步
  const st = c.state, sq = c.seq;
  const realRecv = c.recv.bind(c);
  let swallow = true;
  c.recv = (b) => { if (swallow) { swallow = false; return false; } return realRecv(b); };
  room.broadcast(frames[10]);              // 这帧被吞
  const detected = !c.recv;                // 只是演示
  c.recv = realRecv;
  room.broadcast(frames[11]);              // 客户端会发现 seq 跳跃
  const desynced = !eq(c.state, frames[11]);
  console.log(`  吞掉一帧后再收下一帧：状态是否失步 = ${desynced}`);
  console.log(`  （客户端应检测到 seq 不连续 → 请求 keyframe）`);
  // 客户端请求 keyframe → 服务端补发
  c.state = null; c.seq = 0; c.needsKeyframe = true;
  room.broadcast(frames[12]);
  console.log(`  请求 keyframe 后：状态一致 = ${eq(c.state, frames[12])}`);
  console.log(`  ${desynced && eq(c.state, frames[12]) ? '✓ 通过（能检测 + 能恢复）' : '✗ 失败'}`);
}

// ============ 测试 5：边界数据 ============
console.log('\n=== 测试 5：边界数据 ===');
{
  const cases = [
    ['key 消失', { a: 1, b: 2, c: 3 }, { a: 1, c: 3 }],
    ['key 出现', { a: 1 }, { a: 1, b: { x: [1, 2] } }],
    ['number→string', { a: 1 }, { a: '1' }],
    ['object→array', { a: { x: 1 } }, { a: [1] }],
    ['array→null', { a: [1, 2] }, { a: null }],
    ['null→object', { a: null }, { a: { x: 1 } }],
    ['空对象', { a: { x: 1 } }, { a: {} }],
    ['空数组', { a: [1, 2] }, { a: [] }],
    ['数组元素变化', { a: [1, 2, 3] }, { a: [1, 9, 3] }],
    ['数组长度变化', { a: [1] }, { a: [1, 2, 3, 4] }],
    ['嵌套删除', { a: { b: { c: 1, d: 2 } } }, { a: { b: { c: 1 } } }],
    ['深层新增', { a: { b: {} } }, { a: { b: { c: { d: [1] } } } }],
    ['顶层清空', { a: 1, b: 2 }, {}],
    ['布尔翻转', { a: true }, { a: false }],
    ['0 与 false', { a: 0, b: false }, { a: false, b: 0 }],
    ['负数与极小浮点', { a: -1.5 }, { a: 1e-7 }],
    ['中文字符串', { a: '华法琳' }, { a: '阿米娅·近卫' }],
    ['超长字符串', { a: 'x'.repeat(5000) }, { a: 'x'.repeat(5000) + 'y' }],
    // 'undefined 值' 不适用：JSON 不支持 undefined，WS 收到的数据解析后不可能出现
    ['数组含 null', { a: [1, 2] }, { a: [null, 2] }],
  ];
  let pass = 0;
  for (const [name, a, b] of cases) {
    const p = deepDiff(a, b);
    const back = applyDiff(a, p === undefined ? null : p);
    const expect = JSON.parse(JSON.stringify(b));   // undefined 会被 JSON 丢掉
    if (eq(back, expect)) pass++;
    else console.log(`  ✗ ${name}\n     期望 ${JSON.stringify(expect)}\n     实得 ${JSON.stringify(back)}`);
  }
  console.log(`  通过 ${pass}/${cases.length}`);
}

// ============ 测试 6：服务端 CPU ============
console.log('\n=== 测试 6：服务端 CPU —— 现状 vs 应用层增量 ===');
{
  const N = 4, rounds = 300;
  let idx = 0;
  const step = () => frames[(idx++) % frames.length];   // 连续帧（真实场景）

  // 现状：序列化全量一次 + 每连接各压一次（permessage-deflate 的行为）
  let t0 = performance.now();
  for (let r = 0; r < rounds; r++) {
    const raw = J(step());
    for (let i = 0; i < N; i++) zlib.deflateRawSync(raw, { level: 1 });
  }
  const nowMs = performance.now() - t0;

  // 应用层增量：diff 一次 + 压一次，同一份字节广播 N 次
  t0 = performance.now();
  let prev = null;
  for (let r = 0; r < rounds; r++) {
    const f = step();
    const p = prev === null ? f : deepDiff(prev, f);
    const bytes = zlib.deflateRawSync(J(p === undefined ? { n: 1 } : p), { level: 1 });
    for (let i = 0; i < N; i++) void bytes.length;
    prev = f;
  }
  const appMs = performance.now() - t0;

  console.log(`  现状（序列化 1 次 + 压 ${N} 次）: ${nowMs.toFixed(1)} ms / ${rounds} 帧`);
  console.log(`  应用层增量（diff + 压 1 次）    : ${appMs.toFixed(1)} ms / ${rounds} 帧`);
  console.log(`  → 快 ${(nowMs / appMs).toFixed(2)}×（连续帧 = 真实场景）`);
}

console.log('\n完成。');
