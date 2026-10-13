#!/usr/bin/env node
// 切流预检：站内代码真正引用的每一个 OSS 路径，在新桶上是不是真的拿得到。
// 为什么要有这条：把 dl.lain42.top 换成 dl.lilyco42.top 之前，只要有一个键不在桶里，
// 那个页面就是当场坏掉。而"我核过 54 个键全绿"并不覆盖这件事 —— 期望表来自
// 下载清单与 2026-09-28 那份 OSS 清单，**不等于**站内代码实际会去取哪些路径。
//
// 两类引用都要看：
//   1) 写全的 https://dl.lain42.top/… 字面量（正则能抓到）
//   2) 用 base 拼出来的（正则抓不到，只能把代码里出现的相对路径列进 CONCAT_KEYS）
//      这一份是要人工跟着站内代码维护的，漏了就是假绿。
//
// 用法：node scripts/check-cutover-readiness.mjs <Pages仓库路径>（必须给，CI 里给 checkout 出来的 'pages'）
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv } from 'node:process';

// git grep 在"零命中"时退出码是 1，execFileSync 会把它当异常抛出来。切流之后站内不再引用旧域名，
// 到那一天这几个 grep 必然有零命中的 —— 不包一层的话，这条预检会因为"引用都清干净了"而崩掉，
// 也就是崩在成功的那一刻（rc=1 看着像红，其实是脚本自己的毛病）。零命中是空结果，不是错误。
function gitGrep(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    if (e && e.status === 1) return String(e.stdout || '');
    throw e;
  }
}

const REPO = argv[2];
if (!REPO) {
  // 不再默认某个人的 Windows 路径：那样 CI 会像上一版闸门一样 ENOENT，
  // 而如果被 || 吞掉就永远没人发现。要么显式传目录，要么明确报错。
  console.error('用法: node scripts/check-cutover-readiness.mjs <Pages 仓库目录>');
  process.exit(2);
}
const BASE = 'https://dl.lilyco42.top/';
// 站内以 OSS + '…' 形式拼接出来的具体文件（2026-10-12 从 lyco_chat / models 页面里读出来的）
const CONCAT_KEYS = [
  'wasm/wllama/3.6.1/index.min.js',
  'wasm/wllama/3.6.1/wllama.wasm',
  'wasm/wllama/3.6.1/compat/wllama.js',
  'wasm/wllama/3.6.1/compat/wllama.wasm',
  'wasm/highs/1.15.3/build/highs.mjs',
];
// 这个数组现在是空的 —— 下面记的是它为什么曾经装着四条、以及一条条是怎么被清掉的。
// 它们当时的性质不是"切流会弄坏"，而是"已经坏了"：旧域名 dl.lain42.top 全回 403（OSS 账号停用），新桶回 404。
//   models/hf/catalog.json + wasm/transformers-js/3.8.1/transformers.bundle.mjs → tool/models 页
//     app.mjs:76 是 fetch(catalog.json, {mode:'cors'})：桶没配 CORS 时 R2 自定义域名不回任何
//     access-control-* 头，这一页光补键也不够（2026-10-13 已把 CORS 配上并实测到响应头，见下）。
//   wasm/wllama/3.6.1/compat/{wllama.js,wllama.wasm} → tool/lyco_chat 页（index.html:118-119 setCompat）
//     2026-10-13 已补齐并移出缺口清单：这两份**不是要自己构建的东西** —— 3.6.1 的 index.min.js 里
//     `WasmCompatFromCDN` 就写着它们来自 npm `@wllama/wllama-compat@3.6.1` 的 `wasm/wllama.{js,wasm}`，
//     我上一轮"上游没有 compat 产物，只能从源码构建"是假阴性（搜的是 wllama 包，没搜 @wllama/wllama-compat）。
//     现在桶里那份与 jsdelivr/unpkg 两次独立拉取逐字节一致，并已进 dl-mirror 期望表（src=extra，带 sha256）。
// 闸门语义不变：多一条新缺口 → 红；钉着的任何一条被补齐 → 也红并要求删条目。
//
// wasm/transformers-js/3.8.1/transformers.bundle.mjs 于 2026-10-13 补齐并移出清单：
//   生产者就是 Pages 仓自带的 tool/models/build-runtime.mjs，车道 build-hf-runtime.yml 跑它
//   （run 38346395050：bundle 870,563 B / 094392fc…，外加 app.mjs:130 需要的 4 个 ort 文件，
//   合计约 33.6 MB），产物已 --remote 灌进桶并从公网回读哈希一致。
//   注意强度：这是**按 lock 重建**的产物，钉住它只证明"lane 产物==桶里的对象"，不证明等于 OSS 原字节。
//
// models/hf/catalog.json 也于同日补齐（现在数组是空的 —— 这一步从此变成"站内引用必须全部可达"的硬闸门）：
//   内容由服务器上那份 sync_hf_models.py 的 build_catalog() 生成（本机跑它的副本，只把两处 base 换新域名），
//   配套的 29 个模型文件（839,471,805 B）按 /opt/lain42-model-sync/state.json 里的 pin 逐条校验后上架。
//   两个已知残留风险写在 docs/19：那份脚本仍硬编码旧域名（下次真发生模型变更时它会生成一份带死域名的目录，
//   且它的 ossutil 上架那一步会因 OSS 停用而响亮失败，不会静默）；这份 catalog 是一次性快照，不会自己跟着语料变。
const EXPECTED_MISSING = [];
// 提取器只认字面 URL，而测试源码习惯把点写成 `\.`` —— 2026-10-13 实测：用字面模式数 Pages 仓得 17 个文件 / 27 处，
// 允许转义形态后是 20 个文件 / 35 处，少算的 8 处全在 tests/ 里的断言上。测试断言本来就该跟着切流一起翻，
// 但如果**站内代码**哪天也用转义形态写这个域名，我的提取器就会悄悄漏掉那条键 —— 预检报"全覆盖"而实际漏键。
// 所以这里用 JS 正则以扫一遍全仓：非 tests/ 文件里出现"旧域名的转义形态"就报红，逼我修提取器或补清单。
// 只认**带反斜杠**的转义形态。第一版写成 /dl\\?\.lain42\\?\.top/（反斜杠可选），
// 结果 7 个正常写法的文件全被判成"提取器看不到" —— 一条天天红的闸门等于没有闸门。
const ESCAPED = /dl\\\.lain42\\\.top/g;
const fileList = gitGrep(['-C', REPO, 'grep', '-lI', 'lain42', '--', '.'])
  .split('\n').map((s) => s.trim()).filter(Boolean);
const blind = [];
for (const rel of fileList) {
  if (rel.startsWith('tests/')) continue;
  let txt = '';
  try {
    txt = readFileSync(join(REPO, rel), 'utf8');
  } catch {
    continue; // 二进制或读不到：这条不是"看不到旧域名"，跳过
  }
  if (ESCAPED.test(txt)) blind.push(rel);
  ESCAPED.lastIndex = 0;
}
if (blind.length) {
  console.error('这些文件用转义形态引用旧域名，本脚本的提取器看不见它们（补进 CONCAT_KEYS 或改提取正则）：\n  ' + blind.join('\n  '));
  process.exitCode = process.exitCode || 1;
} else {
  console.log('转义形态核对：非测试文件里没有提取器看不到的旧域名引用（tests/ 里的断言另算，切流时同批翻）');
}

const CONTROL = 'lyco-dl/lyco-windows.zip';

const grep = gitGrep(['-C', REPO, 'grep', '-hI', '-oE', 'https://dl\\.lain42\\.top/[A-Za-z0-9_.\\/-]+', '--', '.']);
const keys = new Set(CONCAT_KEYS);
for (const line of grep.split('\n')) {
  const m = line.trim().match(/^https:\/\/dl\.lain42\.top\/(.+)$/);
  if (m) keys.add(m[1].replace(/\/+$/, ''));
}

const probe = async (k) => {
  try {
    const r = await fetch(BASE + k, { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(25000) });
    const total = (r.headers.get('content-range') || '').split('/')[1] || '-';
    await r.body?.cancel().catch(() => {});
    return { code: r.status, total };
  } catch (e) {
    return { code: 'ERR', total: String(e.cause?.message ?? e.message).slice(0, 40) };
  }
};

const ctrl = await probe(CONTROL);
if (ctrl.code !== 200 && ctrl.code !== 206) {
  console.error(`正向对照都失败（${ctrl.code} ${ctrl.total}）→ 探测不可信，本次结论作废`);
  process.exitCode = 3;
}
console.log(`正向对照 ${CONTROL} → ${ctrl.code}`);

// 桶 CORS 是 tool/models 这类 fetch(..., {mode:'cors'}) 页面的硬前置：2026-10-13 已在桶上设好
// （deploy/r2-dl-cors.json，npx wrangler r2 bucket cors set lain42-dl --file deploy/r2-dl-cors.json -y）。
// 但"设过"不等于"现在还在" —— 它不在仓库里，谁都能在 Cloudflare 控制台一键删掉，所以每天探一次真实响应头。
const corsRes = await fetch(BASE + CONTROL, {
  headers: { Origin: 'https://lain42.top', Range: 'bytes=0-0' },
  signal: AbortSignal.timeout(25000),
});
const acao = corsRes.headers.get('access-control-allow-origin');
const expose = corsRes.headers.get('access-control-expose-headers') || '';
await corsRes.body?.cancel().catch(() => {});
// Content-Range 必须在 expose 里：下载页算进度要读它，缺了就是 206 也拿不到总长。
const corsOk = (corsRes.status === 200 || corsRes.status === 206) && !!acao && /Content-Range/i.test(expose);
console.log(`桶 CORS：status=${corsRes.status} ACAO=${acao ?? '(无)'} Content-Range在expose里=${/Content-Range/i.test(expose)}`);

const newMissing = [];
const stillMissing = [];
const healed = [];
let reachable = 0;
for (const k of [...keys].sort()) {
  const p = await probe(k);
  const isFile = /\.[a-z0-9]{2,5}$/i.test(k);
  const gone = p.code !== 200 && p.code !== 206;
  if (!gone) {
    reachable += 1;
    console.log(`OK   ${String(p.code).padEnd(4)} ${(p.total || '-').padEnd(11)} ${k}`);
    if (EXPECTED_MISSING.includes(k)) healed.push(k);
  } else if (!isFile) {
    console.log(`（前缀，不是文件）${String(p.code).padEnd(4)} ${k}`);
  } else if (EXPECTED_MISSING.includes(k)) {
    stillMissing.push(k);
    console.log(`已知缺口 ${String(p.code).padEnd(4)} ${k}`);
  } else {
    newMissing.push(k);
    console.log(`NEW-MISS ${String(p.code).padEnd(4)} ${k}`);
  }
}

// CONCAT_KEYS 是手工维护的，手工清单会烂：站内新增一条 OSS + 'x/y.js' 就悄悄不被覆盖。
// 所以这里从代码里把"某个名字含 OSS/BASE 的变量 + 字面量"的拼接全抓出来，
// 凡是长得像资源文件的（.js/.mjs/.wasm/.json）却不在我们探测集合里的，直接算新缺口。
// 拼接字面量的前缀要能让裸名 `OSS` 也匹配上：写成 `[A-Za-z_][A-Za-z0-9_]*(OSS|…)` 时
// `OSS + 'wllama/…'` 一条都抓不到（'O' 被首位吃掉后剩余部分对不上分组），
// 第一版因此只报"1 条"，是个近乎空转的漂移检查 —— 现在前缀用零次。
const concat = gitGrep(['-C', REPO, 'grep', '-hI', '-oE', '[A-Za-z0-9_]*(OSS|BASE|Base)[A-Za-z0-9_]* *\\+ *[\'"`][^\'"`]+[\'"`]', '--', '.']);
const seen = new Set();
const unpinned = [];
for (const line of concat.split('\n')) {
  const m = line.match(/[\'"`]([^\'"`]+)[\'"`]\s*$/);
  if (!m) continue;
  const lit = m[1].replace(/^\//, '');
  if (!/\.(js|mjs|wasm|json)$/i.test(lit)) continue;
  if (seen.has(lit)) continue;
  seen.add(lit);
  // 站内拼出来的字面量是相对 base 的（base 里有 …/wasm/ 也有 …/models/hf/），
  // 所以只要有任何一条被探测的键以它结尾就算覆盖；否则就是清单漏维护。
  if (![...keys].some((k) => k === lit || k.endsWith('/' + lit))) unpinned.push(lit);
}
if (unpinned.length) {
  console.error('代码里新出现的拼接键，脚本没覆盖（把 CONCAT_KEYS 补上再切流）：\n  ' + unpinned.join('\n  '));
  process.exitCode = 1;
} else {
  console.log(`拼接清单核对：代码里 ${seen.size} 条资源字面量全部已被覆盖（CONCAT_KEYS ${CONCAT_KEYS.length} 条）`);
}

console.log(`\n引用 ${keys.size} 条：可达 ${reachable}，已知缺口 ${stillMissing.length}，新缺口 ${newMissing.length}`);
// 两个方向都要报：新缺口是"又要多坏一页"，被补齐是"这里的清单过期了，删掉它"。
// 只报前者会让缺口清单永远悄悄烂在里面。
if (newMissing.length) {
  console.error('出现新的缺口（切过去就是 404）：\n  ' + newMissing.join('\n  '));
  process.exitCode = 1;
}
if (healed.length) {
  console.error('这些键已经能取到了，请把 EXPECTED_MISSING 里对应条目删掉：\n  ' + healed.join('\n  '));
  process.exitCode = process.exitCode || 1;
}
if (!corsOk) {
  console.error(
    `桶 CORS 不可用（status=${corsRes.status} ACAO=${acao ?? '(无)'} expose=${expose || '(无)'}）` +
      '→ 站内 fetch 会直接被浏览器拦掉，先重新应用 deploy/r2-dl-cors.json'
  );
  process.exitCode = process.exitCode || 1;
}
if (!newMissing.length && !healed.length && corsOk && !process.exitCode) {
  console.log(`站内引用在新桶上除已知 ${EXPECTED_MISSING.length} 条缺口外全部可达`);
}
