#!/usr/bin/env node
// 把 dl.lain42.top（阿里云 OSS，2026-10-06 起账号停用，全对象 403 UserDisable）
// 里那批下载物搬到 Cloudflare R2，键名与 OSS 的公开路径**逐字一致**，
// 这样站内只需要换 host，不需要重排任何链接。
//
//   node scripts/r2-put-from-manifest.mjs --dry-run
//   node scripts/r2-put-from-manifest.mjs --stage /d/tmp/dl-stage --only 7zip,zed
//   node scripts/r2-put-from-manifest.mjs --bucket lain42-downloads
//
// 数据源是站内那份 manifest（唯一真相，30 个条目里 22 个有 mirror 块）：
// 每条 mirror 都带 size 与 sha256，所以「传对了」这件事是可证的，不靠肉眼。
// 沿用 oss-put-client.sh 的规矩：**传完必须回读校验 sha256**，坏文件没人会告诉你。
//
// 源文件不在本机就不要硬拉：实测 GitHub → 游戏机只有约 29 KB/s，3.06 GiB 要跑一整天。
// 正确两条腿：先把产物 stage 到本地目录（或服务器 /opt/dl-stage），再用这条脚本上 R2。
// 缺哪些、每条该用什么命令取，脚本会逐条打印出来。

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const MANIFEST_URL = 'https://lain42.top/downloads/manifest.json';
const DEFAULT_BUCKET = 'lain42-downloads';

const MIME = {
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.msi': 'application/x-msdownload',
  '.apk': 'application/vnd.android.package-archive',
  '.zip': 'application/zip',
  '.gguf': 'application/octet-stream',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.html': 'text/html',
};

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

const DRY = Boolean(arg('dry-run', false));
const BUCKET = arg('bucket', DEFAULT_BUCKET);
const STAGE = arg('stage', false) ? String(arg('stage')) : '';
const ONLY = arg('only', false) ? String(arg('only')).split(',').map((s) => s.trim()) : null;
const FORCE = Boolean(arg('force', false));

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function mimeFor(key) {
  return MIME[basename(key).slice(basename(key).lastIndexOf('.'))] || 'application/octet-stream';
}

async function loadManifest() {
  const local = arg('manifest', false) ? String(arg('manifest')) : '';
  if (local) return JSON.parse(readFileSync(local, 'utf8'));
  // 这里必须用 curl 而不是 fetch：2026-10-11 实测线上 pingap 对静态文件同时回
  // Content-Length 与 Transfer-Encoding: chunked（违反 RFC 9112 §6.1），
  // Node 的严格 HTTP 解析器直接拒绝，curl 则容忍。
  const body = execFileSync('curl', ['-sS', '--fail', '--compressed', '--max-time', '30', MANIFEST_URL], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(body);
}

// 键名 = URL 的完整 path（去掉开头的 /）。**不能**只剥掉 mirrorBase：
// mirrorBase 自带 /downloads，剥完会变成 downloads/ 以下的相对键，
// 换成 R2 自定义域名后 URL path 与键名不再逐字相等，站内链接就全断了。
function keyOf(item, mirrorBase) {
  const url = new URL(String(item.mirror.url || ''));
  const basePath = new URL(mirrorBase).pathname.replace(/\/$/, '');
  if (!url.pathname.startsWith(basePath + '/')) {
    throw new Error(`${item.id}: ${url.pathname} 不在 ${basePath}/ 下`);
  }
  return url.pathname.replace(/^\//, '');
}

// Windows 上 execFileSync('npx') 会 EINVAL（.cmd 需要 shell），所以优先用 node 直接跑
// 已全局安装的 wrangler 入口；找不到才退回 npx（POSIX）。WRANGLER_BIN 可显式指定。
function resolveWrangler() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const cands = [
    process.env.WRANGLER_BIN,
    home && join(home, 'AppData/Roaming/npm/node_modules/wrangler/bin/wrangler.js'),
    home && join(home, '.npm-global/lib/node_modules/wrangler/bin/wrangler.js'),
    '/usr/local/lib/node_modules/wrangler/bin/wrangler.js',
    '/opt/homebrew/lib/node_modules/wrangler/bin/wrangler.js',
  ].filter(Boolean);
  for (const c of cands) {
    if (existsSync(c)) return { cmd: process.execPath, pre: [c] };
  }
  return { cmd: 'npx', pre: ['--yes', 'wrangler'] };
}
const W = resolveWrangler();

function wrangler(args) {
  try {
    return execFileSync(W.cmd, [...W.pre, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const detail = [e && e.stderr, e && e.stdout, e && e.message].filter(Boolean).join('\n');
    throw new Error(`wrangler 调用失败（${W.cmd} ${W.pre.join(' ')} ${args.join(' ')}）：\n${detail}`);
  }
}

// 回读：把对象拉回临时文件算 sha256。对象不存在时 wrangler 会非零退出。
// 注意 --remote 模式下要显式给 --file，--persist-to 只管本地模式（踩过一次）。
function readBackSha(key) {
  const out = join(tmpdir(), `r2read-${Date.now()}-${basename(key)}`);
  try {
    rmSync(out, { force: true });
  } catch {}
  wrangler(['r2', 'object', 'get', `${BUCKET}/${key}`, '--file', out, '--remote']);
  try {
    return { sha: sha256(readFileSync(out)), bytes: statSync(out).size };
  } finally {
    rmSync(out, { force: true });
  }
}

function upload(key, file) {
  wrangler([
    'r2', 'object', 'put', `${BUCKET}/${key}`,
    '--file', file,
    '--content-type', mimeFor(key),
    '--remote',
  ]);
}

const manifest = await loadManifest();
const base = manifest.mirrorBase;
const items = manifest.items.filter((i) => i.mirror && i.mirror.url);
const wanted = ONLY ? items.filter((i) => ONLY.includes(i.id)) : items;

console.log(`manifest ${base} · updatedAt ${manifest.updatedAt} · 镜像条目 ${items.length}/${manifest.items.length}`);
if (ONLY) console.log(`--only ${ONLY.join(',')} → 命中 ${wanted.length} 条`);
if (!wanted.length) {
  console.log('没有可做的条目。可用 id：' + items.map((i) => i.id).join(','));
  process.exit(2);
}
if (DRY) console.log('DRY-RUN：只解析与取源检查，不碰 R2');

let done = 0;
let skipped = 0;
const needStage = [];

for (const it of wanted) {
  let key;
  try {
    key = keyOf(it, base);
  } catch (e) {
    console.log(`✗ ${it.id}: ${e.message}`);
    skipped += 1;
    continue;
  }
  const name = basename(key);
  const want = it.mirror.sha256;
  const declared = it.mirror.size;
  const staged = STAGE ? join(STAGE, name) : '';

  if (!want || !/^[0-9a-f]{64}$/.test(String(want))) {
    console.log(`✗ ${it.id}: manifest 里没有可信 sha256，跳过`);
    skipped += 1;
    continue;
  }

  if (!staged || !existsSync(staged)) {
    console.log(`… ${it.id}: 没有本地源文件（stage=${STAGE || '未给'}）`);
    needStage.push({ id: it.id, key, name, declared, fallback: it.mirror.fallback || it.official || '' });
    skipped += 1;
    continue;
  }

  const bytes = statSync(staged).size;
  if (bytes !== declared) {
    console.log(`✗ ${it.id}: 尺寸不符 期望 ${declared} 实得 ${bytes} → ${staged}`);
    skipped += 1;
    continue;
  }
  const got = sha256(readFileSync(staged));
  if (got !== want) {
    console.log(`✗ ${it.id}: sha256 不符\n    期望 ${want}\n    实得 ${got}\n    文件 ${staged}`);
    skipped += 1;
    continue;
  }

  if (DRY) {
    console.log(`✓ ${it.id}: 源文件校验通过（${bytes} B）→ 会写 ${BUCKET}/${key}`);
    done += 1;
    continue;
  }

  if (!FORCE) {
    try {
      const pre = readBackSha(key);
      if (pre.sha === want) {
        console.log(`= ${it.id}: R2 上已有同一 sha256，跳过（--force 可强推）`);
        done += 1;
        continue;
      }
    } catch {}
  }

  console.log(`→ ${it.id}: put ${BUCKET}/${key} (${bytes} B, ${mimeFor(key)})`);
  upload(key, staged);
  const back = readBackSha(key);
  if (back.sha !== want || back.bytes !== declared) {
    console.log(`✗ ${it.id}: 回读不符 期望 ${want}/${declared} 实得 ${back.sha}/${back.bytes}`);
    process.exitCode = 1;
    break;
  }
  console.log(`✓ ${it.id}: 回读 sha256 一致`);
  done += 1;
}


if (needStage.length) {
  console.log('\n需要用下面任一条腿先把源文件取到本地（manifest 的 sha256 会替你把关）：');
  for (const n of needStage) {
    console.log(`  ${n.id}\t${n.key}\t${(n.declared / 1048576).toFixed(1)} MiB\t${n.fallback}`);
  }
  console.log('\nGitHub 上的条目可以这样取（releases API 给的就是直链）：');
  console.log("  gh api repos/<owner>/<repo>/releases/tags/<tag> --jq '.assets[] | [.name,.size,.browser_download_url] | @tsv'");
}

const total = items.reduce((a, i) => a + (i.mirror.size || 0), 0);
console.log(
  `\n合计 ${wanted.length} 条：处理 ${done}，跳过 ${skipped}；全量镜像声明 ${(total / 1073741824).toFixed(2)} GiB` +
    `${DRY ? '（DRY-RUN，未写入）' : ''}`,
);
