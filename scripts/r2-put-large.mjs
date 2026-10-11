#!/usr/bin/env node
// 大于 300 MiB 的下载物：wrangler r2 object put 会被硬拒
// （"Wrangler only supports uploading files up to 300 MiB in size"），
// 本机也没有 rclone / S3 密钥，所以走 r2-asset-asm Worker 的 R2 multipart：
//   1. 本地切成 ≤200 MiB 的分片，用 wrangler 落成桶里的临时对象（每片都低于上限）
//   2. Worker create → 逐片 uploadPart（字节从桶里读，不经过 Worker 请求体）→ complete
//   3. 整段拉回来算 sha256，与下载站 manifest 的 pin 比对，过了才删临时分片
//
//   node scripts/r2-put-large.mjs --stage D:/tmp/dl-final --only lyco-router-v13
//   node scripts/r2-put-large.mjs --fetch --only stronghold-protocol-windows
//
// 密钥在 C:/Users/liuqi/.r2-asm-token（或环境变量 R2_ASM_TOKEN），不进仓库。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, existsSync, rmSync, writeFileSync, openSync, readSync, closeSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const MANIFEST_URL = 'https://lain42.top/downloads/manifest.json';
const BUCKET = String(process.env.R2_BUCKET || 'lain42-dl');
const ASM = String(process.env.R2_ASM_URL || 'https://r2-asset-asm.m15178682641.workers.dev');
const CHUNK = Number(process.env.R2_CHUNK_BYTES || 200 * 1024 * 1024);

// 与 r2-put-from-manifest.mjs 同一套类型：装配时不能把原来的 Content-Type 覆盖成 octet-stream。
const MIME = {
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.msi': 'application/x-msdownload',
  '.apk': 'application/vnd.android.package-archive',
  '.zip': 'application/zip',
  '.gguf': 'application/octet-stream',
  '.json': 'application/json',
  '.tar': 'application/x-tar',
};
const mimeFor = (key) => MIME[basename(key).slice(basename(key).lastIndexOf('.'))] || 'application/octet-stream';

function token() {
  if (process.env.R2_ASM_TOKEN) return process.env.R2_ASM_TOKEN.trim();
  const f = 'C:/Users/liuqi/.r2-asm-token';
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  throw new Error('没有 ASM token：设 R2_ASM_TOKEN 或写 C:/Users/liuqi/.r2-asm-token');
}

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
const STAGE = arg('stage', false) ? String(arg('stage')).replaceAll('\\', '/') : '';
const ONLY = String(arg('only', '')).split(',').map((s) => s.trim()).filter(Boolean);
const DO_FETCH = Boolean(arg('fetch', false));
// 探针用：写到一个别的键上、并允许对小文件走分片路径，避免拿正式键做实验。
const DEST_KEY = arg('dest-key', false) ? String(arg('dest-key')) : '';
const FORCE = Boolean(arg('force', false)) || process.env.R2_FORCE === '1';

const W = (() => {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const cands = [process.env.WRANGLER_BIN, home && join(home, 'AppData/Roaming/npm/node_modules/wrangler/bin/wrangler.js')].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return { cmd: process.execPath, pre: [c] };
  return { cmd: 'npx', pre: ['--yes', 'wrangler'] };
})();

function wrangler(args) {
  try {
    return execFileSync(W.cmd, [...W.pre, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(`wrangler 失败：${[e?.stderr, e?.stdout, e?.message].filter(Boolean).join(' ').slice(0, 300)}`);
  }
}

async function asm(pathname, params) {
  const q = new URLSearchParams(params).toString();
  const res = await fetch(`${ASM}${pathname}?${q}`, {
    headers: { 'x-asm-token': token() },
    signal: AbortSignal.timeout(600000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${pathname} → ${res.status} ${body.slice(0, 240)}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${pathname} 返回不是 JSON：${body.slice(0, 200)}`);
  }
}

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function slice(src, start, len, dest) {
  const fd = openSync(src, 'r');
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, start + got);
    if (n <= 0) break;
    got += n;
  }
  closeSync(fd);
  if (got !== len) throw new Error(`切片长度不符：要 ${len} 读到 ${got}`);
  writeFileSync(dest, buf);
}

async function assemble(key, srcFile, contentType) {
  const size = statSync(srcFile).size;
  const n = Math.ceil(size / CHUNK);
  const chunkKeys = [];
  const tmp = join(tmpdir(), `asmcut-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    for (let i = 0; i < n; i += 1) {
      const len = Math.min(CHUNK, size - i * CHUNK);
      const f = join(tmp, `part${i + 1}`);
      slice(srcFile, i * CHUNK, len, f);
      const ck = `_asm/${basename(key)}-${size}.part${i + 1}`;
      console.log(`  切${i + 1}/${n} ${len} B → put ${ck}`);
      wrangler(['r2', 'object', 'put', `${BUCKET}/${ck}`, '--file', f, '--content-type', 'application/octet-stream', '--remote']);
      chunkKeys.push(ck);
      rmSync(f, { force: true });
    }
    const created = await asm('/assemble', { key, contentType, srcKeys: JSON.stringify(chunkKeys) });
    console.log(`  assembled ${created.partCount} 片 etags=${(created.etags || []).map((e) => String(e).slice(0, 10)).join(',')}`);
  } finally {
    for (const ck of chunkKeys) {
      try {
        wrangler(['r2', 'object', 'delete', `${BUCKET}/${ck}`, '--remote']);
      } catch (e) {
        console.log(`  ! 临时分片没删掉 ${ck}：${e.message}`);
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

const manifest = JSON.parse(execFileSync('curl', ['-sS', '--fail', '--compressed', '--max-time', '30', MANIFEST_URL], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
const items = manifest.items.filter((i) => i.mirror && i.mirror.url);
const targets = ONLY.length ? items.filter((i) => ONLY.includes(i.id)) : items;
if (!targets.length) {
  console.log('没有匹配项。可用 id：' + items.map((i) => i.id).join(','));
  process.exit(2);
}
console.log(`目标 ${targets.length} 条；桶 ${BUCKET}；装配器 ${ASM}`);

let done = 0;
for (const it of targets) {
  const manifestKey = new URL(it.mirror.url).pathname.replace(/^\//, '');
  // 源文件名永远按 manifest 的键算；--dest-key 只改写入目标（探针用），不能顺带改找文件的名字
  const key = DEST_KEY || manifestKey;
  const name = basename(manifestKey);
  const want = String(it.mirror.sha256 || '');
  const size = Number(it.mirror.size);
  if (!/^[0-9a-f]{64}$/.test(want)) {
    console.log(`✗ ${it.id}: manifest 里没有可信 sha256`);
    continue;
  }
  if (size <= 300 * 1024 * 1024 && !FORCE) {
    console.log(`· ${it.id}: ${(size / 1048576).toFixed(1)} MiB 在 wrangler 上限内，请用 r2-put-from-manifest.mjs`);
    continue;
  }
  let src = STAGE ? join(STAGE, name) : '';
  if (!src || !existsSync(src)) {
    if (!DO_FETCH) {
      console.log(`✗ ${it.id}: 没有本地源文件（--stage 给目录，或加 --fetch 从 GitHub 取）`);
      continue;
    }
    // 有的条目 GitHub 地址在 official 而不是 fallback（stronghold 两条就是这样）
    const m = String(it.mirror.fallback || it.official || '').match(/github\.com\/([^/]+)\/([^/]+)\/releases\/tag\/([^/]+)/);
    if (!m) {
      console.log(`✗ ${it.id}: fallback 不是 GitHub release，无法自动取源`);
      continue;
    }
    const tsv = execFileSync('gh', ['api', `repos/${m[1]}/${m[2]}/releases/tags/${m[3]}`, '--jq', '.assets[] | [.name,.size,.browser_download_url] | @tsv'], { encoding: 'utf8' });
    const hit = tsv.split('\n').map((l) => l.split('\t')).find((r) => r[0] === name);
    if (!hit) {
      console.log(`✗ ${it.id}: release ${m[3]} 里没有 ${name}`);
      continue;
    }
    // --fetch 而没给 --stage 时，落到一个临时目录，否则 curl 的 -o 拿到空串直接用法错误
    if (!src) {
      const d = join(tmpdir(), 'r2large-stage');
      mkdirSync(d, { recursive: true });
      src = join(d, name);
    }
    execFileSync('curl', ['-sSL', '--fail', '--max-time', '3000', '-o', src, hit[2]], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  if (statSync(src).size !== size) {
    console.log(`✗ ${it.id}: 尺寸不符 期望 ${size} 实得 ${statSync(src).size}`);
    continue;
  }
  const localSha = sha(src);
  if (localSha !== want) {
    console.log(`✗ ${it.id}: 源文件 sha256 不符\n    期望 ${want}\n    实得 ${localSha}`);
    continue;
  }
  console.log(`→ ${it.id}: ${(size / 1048576).toFixed(1)} MiB 分片装配 ${BUCKET}/${key}`);
  const t0 = Date.now();
  await assemble(key, src, mimeFor(key));
  const out = join(tmpdir(), `asmback-${Date.now()}-${name}`);
  wrangler(['r2', 'object', 'get', `${BUCKET}/${key}`, '--file', out, '--remote']);
  const back = statSync(out).size;
  const backSha = sha(out);
  rmSync(out, { force: true });
  if (back !== size || backSha !== want) {
    console.log(`✗ ${it.id}: 装配后回读不符 size ${back}/${size} sha ${backSha.slice(0, 12)}…/${want.slice(0, 12)}…`);
    process.exitCode = 1;
    break;
  }
  console.log(`✓ ${it.id}: 回读 sha256 与 pin 一致（${((Date.now() - t0) / 1000).toFixed(0)} s）`);
  done += 1;
}
console.log(`\n完成 ${done}/${targets.length}`);
