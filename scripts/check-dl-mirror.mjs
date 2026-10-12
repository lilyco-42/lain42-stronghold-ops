#!/usr/bin/env node
// 公开下载镜像 dl.lilyco42.top 的持续验收闸门。
// 为什么要有这条：迁移当时是我一条条手工验的，做完就没人再管；
// 而站外链接一旦切过去，坏一个键就是用户 404。所以把断言固化进 CI。
//
//   node scripts/check-dl-mirror.mjs            # 只查头（状态/长度/类型/Range），CI 一天四次跑
//   node scripts/check-dl-mirror.mjs --deep 3   # 额外把最小的 3 条整段流式下载算 sha256
//   node scripts/check-dl-mirror.mjs --deep all # 所有带 manifest pin 的条目都整段哈希（每月一次，2.5 GiB 量级）
//
// 强度分两级，写在 expected.json 里，来源不同：
//   manifest 项：sha256 来自下载站清单 —— 能验到字节，且对得上第三方清单
//   csv 项：sha256 来自"本机源文件 vs R2 现对象双向一致"（scripts/dl-mirror-csv-sha.json）
//            —— 也能验到字节，但那是"两边同为那份上传内容"的一致性，不宣称与某个权威上游一致，
//            因为这些 npm 包文件从来没有存哈希的清单。
//   任何一项在 csv-sha 表里缺席，它就退回"只验长度与 Content-Type"。
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const exp = JSON.parse(readFileSync(join(root, 'scripts/dl-mirror-expected.json'), 'utf8'));
const BASE = process.env.DL_MIRROR_BASE || exp.base;
// base / 停顿阈值可以用环境变量覆盖，是为了让"链路卡住"这条分支能被真的测到：
// 上一版这条分支没被测过，异常直接掀掉整个 job 而不是一行 ✗（CI run 38234496095 就是这么红的）。
const STALL_ENV = Number(process.env.DL_STALL_MS || 0);
// --deep 允许数字或 "all"。用数字时它是"最小的 N 条"，所以清单新增条目会悄悄缩小覆盖面；
// 月度那条车道传 all，覆盖面由 expected.json 决定，不由工作流里的常数决定。
const DEEP_RAW = process.argv.includes('--deep') ? String(process.argv[process.argv.indexOf('--deep') + 1] || '3') : '0';
const DEEP_ALL = DEEP_RAW === 'all';
const DEEP = DEEP_ALL ? Infinity : Number(DEEP_RAW);
if (!DEEP_ALL && !Number.isFinite(DEEP)) {
  console.error(`--deep 只接受数字或 all，收到 ${DEEP_RAW}`);
  process.exit(2);
}
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

// 超时要用"停顿"而不是"总时长"：CI 实测第 19 条（645 MiB 的 gguf）在总时长 5 分钟的
// AbortSignal 下被掐死，而前面 378 MiB 那条只用了 7 秒 —— 大对象慢不代表会失败，
// 用总时长掐它就是在制造假故障。现在：连续 STALL_MS 拿不到任何字节才算链路死了，
// 另给一个很宽的总上限只是防"永远挂在那里"。异常一定要变成 ✗ 行，不能把整个 job 炸掉。
const STALL_MS = STALL_ENV > 0 ? STALL_ENV : 90_000;
const OVERALL_MS = 15 * 60_000;

async function streamSha(key) {
  const ac = new AbortController();
  const started = Date.now();
  let bytes = 0;
  let stallTimer = null;
  const resetStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => ac.abort(new Error(`连续 ${STALL_MS / 1000}s 没收到字节`)), STALL_MS);
  };
  const overall = setTimeout(() => ac.abort(new Error(`超过 ${OVERALL_MS / 60000} 分钟总上限`)), OVERALL_MS);
  resetStall();
  try {
    const res = await fetch(`${BASE}/${key}`, { signal: ac.signal });
    if (!res.ok) {
      // 不消费/取消响应体就 return，undici 会在进程退出时把这个半开的连接炸掉：
      // 本机测试里表现为退出码 3221226505（0xC0000409），而不是预期的 1 —— 断言全对但闸门"崩了"。
      await res.body?.cancel().catch(() => {});
      return { status: res.status, bytes: 0, sha: null };
    }
    const h = createHash('sha256');
    const rd = res.body.getReader();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      h.update(value);
      bytes += value.length;
      resetStall();
    }
    return { status: res.status, bytes, sha: h.digest('hex'), secs: (Date.now() - started) / 1000 };
  } catch (e) {
    return { status: 'ABORT', bytes, sha: null, err: String(e?.cause?.message ?? e?.message ?? e).slice(0, 80) };
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    clearTimeout(overall);
  }
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

let hashed = 0;
let hashWanted = 0;
if (DEEP) {
  const hashable = exp.items
    .filter((i) => i.sha256 && !gapIds.has(i.id))
    .sort((a, b) => a.size - b.size)
    .slice(0, DEEP);
  hashWanted = hashable.length;
  console.log(`deep=${DEEP_RAW}：准备整段哈希 ${hashWanted} 条，共 ${(hashable.reduce((a, b) => a + b.size, 0) / 1048576).toFixed(1)} MiB`);
  for (const it of hashable) {
    const t0 = Date.now();
    const got = await streamSha(it.key);
    const ms = Date.now() - t0 || 1;
    const rate = ((got.bytes || 0) / 1048576 / (ms / 1000)).toFixed(1);
    const ok = got.status === 200 && got.bytes === it.size && got.sha === it.sha256;
    hashed += 1;
    // 大对象跑到十几分钟时，日志里必须能看出"现在在第几条、已经取了多少"，否则只能看到一个空转的 job
    console.log(
      `  [${hashed}/${hashWanted}] ${it.key} http=${got.status} ${((got.bytes || 0) / 1048576).toFixed(1)}MiB ` +
        `${(ms / 1000).toFixed(1)}s ${rate}MiB/s ${ok ? 'sha 一致' : got.err ? '异常 ' + got.err : '待比对'}`
    );
    if (ok) notes.push(`HASH ${it.key} ${got.bytes}B sha256 与 manifest pin 一致`);
    else fails.push(
      `HASH ${it.key} http=${got.status} bytes=${got.bytes}/${it.size} sha=${String(got.sha).slice(0, 16)}… ` +
        `期望 ${String(it.sha256).slice(0, 16)}…${got.err ? ' 原因=' + got.err : ''}`
    );
  }
}

console.log(notes.join('\n'));
const pinnedTotal = exp.items.filter((i) => i.sha256 && !gapIds.has(i.id)).length;
console.log(
  `\n断言 ${checked} 个键（其中 ${pinnedTotal} 个有 sha256 可验），跳过已知待定 ${skipped} 个，失败 ${fails.length} 个${
    DEEP ? `（deep=${DEEP_RAW} 已做整段哈希 ${hashed} 条）` : '（浅模式：只验状态/长度/类型/Range）'
  }`
);
// 这里一律用 process.exitCode 而不是 process.exit()：exit() 会在 undici 的 keep-alive socket
// 还开着的时候强退，Windows 上直接触发 libuv 断言
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:76
// 于是"闸门判定为红"变成退出码 3221226505（0xC0000409），断言内容全对但看起来像崩了。
// Linux runner 上看不出这个问题（那里强退不炸），而失败路径本身在 CI 里还从没红过 —— 两边都不测就等于没测。
if (fails.length) {
  console.error('失败明细：\n' + fails.map((f) => '  ✗ ' + f).join('\n'));
  process.exitCode = 1;
}
if (checked < exp.items.length - skipped) {
  console.error(`断言条数对不上：checked=${checked} 应=${exp.items.length - skipped}`);
  process.exitCode = 1;
}
// all 模式下不许出现"只哈希了子集却报全通过"：覆盖面由 expected.json 里有没有 pin 决定
if (DEEP_ALL) {
  const pinnedAll = exp.items.filter((i) => i.sha256 && !gapIds.has(i.id)).length;
  if (hashed !== pinnedAll) {
    console.error(`deep=all 应该哈希 ${pinnedAll} 条，实际 ${hashed} 条`);
    process.exitCode = 1;
  }
}
if (!process.exitCode) console.log('dl-mirror 全部通过');
