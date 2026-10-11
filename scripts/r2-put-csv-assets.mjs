#!/usr/bin/env node
// 按当年 OSS 的资产清单（_staging/oss-assets-20260928.csv）把 wasm/* 那批运行时还原进 R2。
// 这批不在下载站 manifest 里：clang/chem/ffmpeg/opencv/magick/lp/lyco_chat 这些工具页
// 引用的是 wasm/<lib>/<版本>/…，OSS 停用后它们全断，把 downloads/* 灌完也修不好。
//
//   node scripts/r2-put-csv-assets.mjs --dry-run
//   node scripts/r2-put-csv-assets.mjs --bucket lain42-dl
//
// 清单给了「本地文件 → 键名 → Content-Type」三列，键名逐字沿用，
// 所以站内只需要把 host 从 dl.lain42.top 换成 dl.lilyco42.top。
// 每条都算 sha256，put 完再用 object get --file 拉回来比一次——清单里没有 hash，
// 所以这里保证的是「传上去的字节 == 本地字节」，不是「与 OSS 时代一致」。

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const CSV = 'D:/Code/_staging/oss-assets-20260928.csv';
const SEARCH_ROOTS = [
  'D:/Code/_staging/oss-packages',
  'D:/Code/lilyco-42.github.io/lyco/clang/wasm',
  'D:/Code/lilyco-42.github.io/tool/lyco_chat',
];

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
const DRY = Boolean(arg('dry-run', false));
const BUCKET = String(arg('bucket', 'lain42-dl'));

function resolveWrangler() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const cands = [
    process.env.WRANGLER_BIN,
    home && join(home, 'AppData/Roaming/npm/node_modules/wrangler/bin/wrangler.js'),
    '/usr/local/lib/node_modules/wrangler/bin/wrangler.js',
  ].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return { cmd: process.execPath, pre: [c] };
  return { cmd: 'npx', pre: ['--yes', 'wrangler'] };
}
const W = resolveWrangler();

function wrangler(args) {
  try {
    return execFileSync(W.cmd, [...W.pre, ...args], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new Error(`wrangler 失败：${[e?.stderr, e?.stdout, e?.message].filter(Boolean).join(' ').slice(0, 240)}`);
  }
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// 按 basename 在几个来源目录里找（清单里的 LocalPath 是 Windows 绝对路径，可能已经挪过位置）
function findByName(name) {
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === name) hits.push(p);
    }
  };
  for (const r of SEARCH_ROOTS) if (existsSync(r)) walk(r, 0);
  return hits;
}

function locate(row) {
  // 清单里是 Windows 绝对路径，直接反斜杠转正斜杠即可。
  // 别换成 /d/... 那种 git-bash 写法：Node 在 Windows 下会解析成 C:\d\... → existsSync 永远 false，
  // 于是每条都退化成"按文件名猜"，同名文件就会拿错（实测抓到过 30 B 的 index.js）。
  const direct = row.local.replaceAll('\\', '/');
  if (existsSync(direct)) return { path: direct, how: '清单原路径' };
  const name = basename(row.object);
  const hits = findByName(name);
  if (hits.length === 0) return { missing: true };
  // 用键名末尾三段做匹配打分，只接受唯一最优；有并列就停下来说明，不猜
  const segs = row.object.split('/');
  const tail = segs.slice(-3).join('/');
  const scored = hits
    .map((p) => {
      const q = p.replaceAll('\\', '/');
      const idx = q.lastIndexOf('/' + segs.slice(-2)[0] + '/');
      const suffix = idx === -1 ? '' : q.slice(idx + 1);
      return { p, exact: suffix === tail ? 2 : q.endsWith(tail) ? 1 : 0 };
    })
    .sort((a, b) => b.exact - a.exact);
  if (scored[0].exact === 0) {
    return { ambiguous: true, hits, note: `找不到与 ${tail} 对齐的候选` };
  }
  const best = scored.filter((s) => s.exact === scored[0].exact);
  if (best.length > 1) {
    return { ambiguous: true, hits: best.map((b) => b.p), note: `${tail} 有 ${best.length} 份并列` };
  }
  return { path: best[0].p, how: `按键名后缀匹配（清单原路径已不在）` };
}

const raw = readFileSync(CSV, 'utf8').replace(/^/, '');
const rows = raw
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((l) => l.match(/^"([^"]+)","([^"]+)","([^"]+)"$/))
  .filter(Boolean)
  .map((m) => ({ local: m[1], object: m[2], ct: m[3] }));

console.log(`清单 ${CSV} 解析出 ${rows.length} 条；目标桶 ${BUCKET}${DRY ? '（DRY-RUN 不写入）' : ''}`);
for (const r of rows) {
  if (!/^[A-Za-z0-9._/-]+$/.test(r.object)) console.log(`✗ 键名不合法：${r.object}`);
  else if (!/^[A-Za-z0-9.+/-]+$/.test(r.ct)) console.log(`✗ Content-Type 不合法：${r.ct}`);
}

let put = 0;
let skip = 0;
let bytes = 0;
const gone = [];

for (const r of rows) {
  const loc = locate(r);
  if (loc.missing || loc.ambiguous) {
    console.log(`✗ ${r.object} ← ${loc.missing ? `本地找不到 ${basename(r.object)}` : loc.note}`);
    if (loc.hits) console.log('    候选：' + loc.hits.slice(0, 4).join(' | '));
    gone.push(r.object);
    skip += 1;
    continue;
  }
  const buf = readFileSync(loc.path);
  const want = sha(buf);
  if (DRY) {
    console.log(`· ${r.object} ${buf.length} B ${r.ct} ← ${loc.how}`);
    put += 1;
    bytes += buf.length;
    continue;
  }
  wrangler(['r2', 'object', 'put', `${BUCKET}/${r.object}`, '--file', loc.path, '--content-type', r.ct, '--remote']);
  const out = join(tmpdir(), `csvget-${Date.now()}-${basename(r.object)}`);
  try {
    rmSync(out, { force: true });
  } catch {}
  wrangler(['r2', 'object', 'get', `${BUCKET}/${r.object}`, '--file', out, '--remote']);
  const back = readFileSync(out);
  rmSync(out, { force: true });
  if (sha(back) !== want || back.length !== buf.length) {
    console.log(`✗ ${r.object}: 回读不符 local=${want}/${buf.length} remote=${sha(back)}/${back.length}`);
    process.exitCode = 1;
    break;
  }
  console.log(`✓ ${r.object} ${buf.length} B ${r.ct}（${loc.how}）`);
  put += 1;
  bytes += buf.length;
}

console.log(`\n合计 ${rows.length} 条：写入/核对 ${put}，缺失 ${skip}，共 ${(bytes / 1048576).toFixed(1)} MiB`);
if (gone.length) console.log('本地已无、需要重建或另找的：\n  ' + gone.join('\n  '));
