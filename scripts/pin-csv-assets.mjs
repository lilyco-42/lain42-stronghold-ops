#!/usr/bin/env node
// 给 33 条 csv 资产补上"能验证字节"这一层强度。
// 为什么现在才做：2026-09-28 上传时我逐条回读算过 sha256，但那个值只出现在当时终端的输出里，
// 没落到任何地方 —— 所以闸门只能断言长度与 Content-Type。本机源文件都还在，
// 于是把两边重新算一遍：本机文件 sha256 与 R2 现对象 sha256 **相等**的键才写进 pin 表。
// 不相等的键绝不静默改 pin —— 那是要报出来的事。
//
//   node scripts/pin-csv-assets.mjs            # 全量对账并写出 scripts/dl-mirror-csv-sha.json
//   node scripts/pin-csv-assets.mjs --only 3   # 只做前 3 条（快速自测）
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const snapPath = join(root, 'scripts/dl-mirror-csv-snapshot.json');
const outPath = join(root, 'scripts/dl-mirror-csv-sha.json');
const BASE = 'https://dl.lilyco42.top';
const ONLY = process.argv.includes('--only') ? Number(process.argv[process.argv.indexOf('--only') + 1]) : 0;

const localOf = (p) => p.replace(/\\/g, '/');
const snap = JSON.parse(readFileSync(snapPath, 'utf8'));
const rows = ONLY ? snap.rows.slice(0, ONLY) : snap.rows;

async function streamSha(key) {
  const res = await fetch(`${BASE}/${key}`, { signal: AbortSignal.timeout(180000) });
  if (!res.ok) return { status: res.status, bytes: 0, sha: null };
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

function localSha(path) {
  const h = createHash('sha256');
  h.update(readFileSync(path));
  return h.digest('hex');
}

const pinned = [];
const problems = [];
let miB = 0;
for (const r of rows) {
  const lp = localOf(r.localPath);
  if (!existsSync(lp)) {
    problems.push(`本机源文件不存在：${r.key} ← ${lp}`);
    continue;
  }
  const ls = statSync(lp).size;
  if (ls !== r.size) {
    problems.push(`本机文件尺寸与快照不符：${r.key} 快照 ${r.size} 实得 ${ls}（这份源文件被改过，不能拿来定 pin）`);
    continue;
  }
  const lsha = localSha(lp);
  const got = await streamSha(r.key);
  miB += (got.bytes || 0) / 1048576;
  if (got.status !== 200) {
    problems.push(`R2 取回失败：${r.key} http=${got.status}`);
    continue;
  }
  if (got.bytes !== r.size) {
    problems.push(`R2 长度不符：${r.key} 期望 ${r.size} 实得 ${got.bytes}`);
    continue;
  }
  if (got.sha !== lsha) {
    problems.push(`字节不一致：${r.key} 本机 ${lsha.slice(0, 16)}… vs R2 ${got.sha.slice(0, 16)}…`);
    continue;
  }
  pinned.push({ key: r.key, sha256: lsha, size: r.size });
  console.log(`✓ ${r.key} ${r.size}B 本机与 R2 一致`);
}

const out = {
  note:
    '33 条 csv 资产的 sha256 pin。来源不是第三方清单，而是"本机当年上传的那份文件"与"R2 现对象"双向算一遍并相等 ' +
    '—— 所以这条断言的强度是"两边一致"，不是"与某个权威上游一致"（这些包本来就没有清单存哈希）。' +
    '任何一个键两边不一致就不会出现在这里，并会在脚本输出里报错。',
  base: BASE,
  verifiedBy: 'scripts/pin-csv-assets.mjs',
  rows: pinned.sort((a, b) => (a.key < b.key ? -1 : 1)),
};
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(
  `\n对账 ${rows.length} 条，写入 pin ${pinned.length} 条（共回读 ${(miB / 1024).toFixed(2)} GiB）；不一致/跳过 ${problems.length} 条`
);
if (problems.length) {
  console.error('问题明细：\n' + problems.map((p) => '  ✗ ' + p).join('\n'));
  process.exit(1);
}
console.log(`已写 ${outPath}`);
