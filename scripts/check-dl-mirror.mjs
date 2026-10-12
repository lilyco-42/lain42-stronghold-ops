#!/usr/bin/env node
// 公开下载镜像 dl.lilyco42.top 的持续验收闸门。
// 为什么要有这条：迁移当时是我一条条手工验的，做完就没人再管；
// 而站外链接一旦切过去，坏一个键就是用户 404。所以把断言固化进 CI。
//
//   node scripts/check-dl-mirror.mjs            # 只查头（状态/长度/类型/Range），CI 每天跑
//   node scripts/check-dl-mirror.mjs --deep 3   # 额外把最小的 3 条整段流式下载算 sha256
//
// 强度分两级，写在 expected.json 里，不混为一谈：
//   manifest 项：能验到 sha256（deep 模式），因为 manifest 自己带 pin
//   csv 项：只能验长度与 Content-Type —— 当年上传后回读过 sha256，但没有任何地方存着期望值，
//            所以这里绝不假称"验证了字节"。
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const exp = JSON.parse(readFileSync(join(root, 'scripts/dl-mirror-expected.json'), 'utf8'));
const BASE = exp.base;
const DEEP = process.argv.includes('--deep') ? Number(process.argv[process.argv.indexOf('--deep') + 1] || 3) : 0;
const gapIds = new Set((exp.knownGaps || []).map((g) => g.id));

const norm = (s) => String(s || '').split(';')[0].trim().toLowerCase();
const fails = [];
const notes = [];
let checked = 0;
let skipped = 0;

async function probe(key) {
  const res = await fetch(`${BASE}/${key}`, {
    method: 'GET',
    headers: { Range: 'bytes=0-0' },
    signal: AbortSignal.timeout(30000),
    redirect: 'follow',
  });
  const total = Number((res.headers.get('content-range') || '').split('/')[1]) || 0;
  await res.arrayBuffer();
  return {
    status: res.status,
    ct: norm(res.headers.get('content-type')),
    total,
    ranges: res.status === 206 ? 'range-ok' : (norm(res.headers.get('accept-ranges')) === 'bytes' ? 'header-only' : 'none'),
  };
}

async function streamSha(key) {
  const res = await fetch(`${BASE}/${key}`, { signal: AbortSignal.timeout(1200000) });
  if (!res.ok) return { status: res.status };
  const h = createHash('sha256');
  let bytes = 0;
  const rd = res.body.getReader();
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    h.update(value);
    bytes += value.length;
  }
  return { status: res.status, bytes, sha: h.digest('hex') };
}

for (const it of exp.items) {
  if (gapIds.has(it.id)) {
    skipped += 1;
    notes.push(`SKIP ${it.id} —— 已知待定，见 expected.json 的 knownGaps`);
    continue;
  }
  let p;
  try {
    p = await probe(it.key);
  } catch (e) {
    fails.push(`${it.key} 抓取异常 ${String(e.message).slice(0, 60)}`);
    continue;
  }
  const problems = [];
  if (p.status !== 206 && p.status !== 200) problems.push(`http=${p.status}`);
  if (it.ct && p.ct !== norm(it.ct)) problems.push(`ct=${p.ct || '空'} 期望 ${norm(it.ct)}`);
  if (it.size && p.total && p.total !== it.size) problems.push(`长度 ${p.total} != manifest ${it.size}`);
  if (p.ranges === 'none') problems.push('Range 不被接受（无法断点续传）');
  checked += 1;
  if (problems.length) fails.push(`${it.key}  ${problems.join('; ')}`);
  else notes.push(`OK   ${it.key} ${p.status} ${p.total || '?'}B ${p.ct} ${p.ranges}`);
}

if (DEEP) {
  const hashable = exp.items
    .filter((i) => i.sha256 && !gapIds.has(i.id))
    .sort((a, b) => a.size - b.size)
    .slice(0, DEEP);
  for (const it of hashable) {
    const got = await streamSha(it.key);
    const ok = got.status === 200 && got.bytes === it.size && got.sha === it.sha256;
    if (ok) notes.push(`HASH ${it.key} ${got.bytes}B sha256 与 manifest pin 一致`);
    else fails.push(`HASH ${it.key} http=${got.status} bytes=${got.bytes}/${it.size} sha=${String(got.sha).slice(0, 16)}… 期望 ${String(it.sha256).slice(0, 16)}…`);
  }
}

console.log(notes.join('\n'));
console.log(`\n断言 ${checked} 个键，跳过已知待定 ${skipped} 个，失败 ${fails.length} 个${DEEP ? `（deep=${DEEP} 已做整段哈希）` : '（浅模式：只验状态/长度/类型/Range）'}`);
if (fails.length) {
  console.error('失败明细：\n' + fails.map((f) => '  ✗ ' + f).join('\n'));
  process.exit(1);
}
if (checked < exp.items.length - skipped) {
  console.error(`断言条数对不上：checked=${checked} 应=${exp.items.length - skipped}`);
  process.exit(1);
}
console.log('dl-mirror 全部通过');
