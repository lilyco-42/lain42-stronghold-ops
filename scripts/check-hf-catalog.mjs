#!/usr/bin/env node
// 校验桶里那份 models/hf/catalog.json 是否还和它自己声明的语料一致。
//
// 为什么要单独立一条：catalog.json 是一次性快照（服务器那份生成器仍写旧域名，见 docs/19）。
// 它一旦和语料脱节 —— 有人重跑了同步、改了 revision、或误删某个 onnx —— 页面拿到目录、
// 下载时才 404，而现有 dl-mirror 车道只会逐个键比长度，看不出"目录说的键其实不存在"这种错配。
// 这里检查的是三者的一致性：目录里的 base 主机、每个文件键是否真能取到、声明字节是否等于实际字节。
//
// 用法：node scripts/check-hf-catalog.mjs            （读桶里的目录并全量核对）
//       node scripts/check-hf-catalog.mjs --selftest （先证明这条闸门自己会红）
import process from 'node:process';

const BASE = String(process.env.DL_MIRROR_BASE || 'https://dl.lilyco42.top').replace(/\/+$/, '');
const CATALOG = BASE + '/models/hf/catalog.json';
const CONTROL = BASE + '/lyco-dl/lyco-windows.zip';  // 正向对照：一个与本项目无关、但长期存在的键
const DEAD = 'dl.lain42.top';
const ALIVE_HOST = 'dl.lilyco42.top';
const EXPECT_RUNTIME_VERSION = '3.8.1';
const TIMEOUT_MS = Number(process.env.DL_CATALOG_TIMEOUT_MS || 25000);

const probe = async (url) => {
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const totalRaw = (r.headers.get('content-range') || '').split('/')[1] || '';
    const total = /^\d+$/.test(totalRaw) ? Number(totalRaw) : null;
    await r.body?.cancel().catch(() => {});
    return { status: r.status, total, ct: (r.headers.get('content-type') || '').split(';')[0] };
  } catch (e) {
    return { status: 'ERR', total: null, ct: String(e.cause?.message ?? e.message).slice(0, 40) };
  }
};

// 页面的消费契约（tool/models/app.mjs:79 就查这三条）—— 目录不满足它，页面直接拒绝渲染
function contractProblems(cat) {
  const p = [];
  if (cat.schemaVersion !== 1) p.push(`schemaVersion=${JSON.stringify(cat.schemaVersion)} 期望 1`);
  if (!Array.isArray(cat.models) || cat.models.length === 0) p.push('models 不是非空数组');
  const rv = cat.runtime && cat.runtime.version;
  if (rv !== EXPECT_RUNTIME_VERSION) p.push(`runtime.version=${JSON.stringify(rv)} 期望 ${EXPECT_RUNTIME_VERSION}`);
  for (const field of ['url', 'wasmBase']) {
    const u = String((cat.runtime && cat.runtime[field]) || '');
    if (!u) { p.push(`runtime.${field} 为空`); continue; }
    if (u.includes(DEAD)) p.push(`runtime.${field} 里是已停用的旧域名：${u}`);
    else {
      let host = '';
      try { host = new URL(u).host; } catch { p.push(`runtime.${field} 不是绝对 URL：${u}`); continue; }
      if (host !== ALIVE_HOST) p.push(`runtime.${field} 主机是 ${host}，不是 ${ALIVE_HOST}`);
    }
  }
  return p;
}

// 目录里每个模型文件 → 桶里应有的键（与 app.mjs 的 remoteHost + remotePathTemplate 拼法一致）
function keyFor(model, file) {
  return `models/hf/${model.id}/resolve/${model.revision}/${file.path}`;
}

async function checkCatalog(cat) {
  const problems = contractProblems(cat);
  const missing = [];
  const sizeMismatch = [];
  let files = 0;
  for (const m of cat.models || []) {
    let sum = 0;
    for (const f of m.files || []) {
      files += 1;
      sum += Number(f.bytes || 0);
      const p = await probe(BASE + '/' + keyFor(m, f));
      if (p.status !== 200 && p.status !== 206) { missing.push(`${keyFor(m, f)} → ${p.status} ${p.ct}`); continue; }
      if (p.total !== null && Number.isFinite(f.bytes) && p.total !== f.bytes) {
        sizeMismatch.push(`${keyFor(m, f)} 实际 ${p.total} B / 目录声明 ${f.bytes} B`);
      }
    }
    // 目录自己的 downloadBytes 与文件字节之和应当一致，不一致说明它是由半成型的 state 生成的
    if (Number.isFinite(m.downloadBytes) && m.downloadBytes !== sum) {
      problems.push(`${m.id}: downloadBytes=${m.downloadBytes} 与 files 之和 ${sum} 不符`);
    }
  }
  return { problems, missing, sizeMismatch, files, models: (cat.models || []).length };
}

// 自测：三个方向都要能红，否则这条闸门是空转的
async function selftest() {
  const base = {
    schemaVersion: 1,
    runtime: { version: EXPECT_RUNTIME_VERSION, url: `https://${ALIVE_HOST}/wasm/x.mjs`, wasmBase: `https://${ALIVE_HOST}/wasm/` },
    models: [{ id: 'Xenova/multilingual-e5-small', revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78', downloadBytes: 20006652, files: [{ path: 'config.json', bytes: 658 }] }],
  };
  let pass = 0, fail = 0;
  const say = (name, ok, extra) => { ok ? (pass += 1, console.log(`PASS ${name} ${extra || ''}`)) : (fail += 1, console.log(`FAIL ${name} ${extra || ''}`)); };

  // 0) 正向对照本身必须可达 —— 否则下面所有"取不到"都是探测器的错，不是目录的错
  const ctrl = await probe(CONTROL);
  say('对照键可达', ctrl.status === 200 || ctrl.status === 206, `${ctrl.status} ${ctrl.total}`);
  if (ctrl.status === 'ERR' || ctrl.status >= 500) {
    console.error('正向对照都失败 → 探测器不可信，自测作废');
    process.exitCode = 3;
    return;
  }

  // 1) 已知缺口应当被报成"缺失"（这条键今天确实 404）
  const gone = structuredClone(base);
  gone.models[0].files = [{ path: 'definitely-not-here-20261013.onnx', bytes: 1 }];
  const r1 = await checkCatalog(gone);
  say('取不到的键要变红', r1.missing.length === 1, JSON.stringify(r1.missing).slice(0, 120));

  // 2) 声明字节与实际字节不符要单独成一条，不能混进"缺失"
  const off = structuredClone(base);
  off.models[0].files = [{ path: 'config.json', bytes: 999999 }];
  const r2 = await checkCatalog(off);
  say('尺寸不符要单独报', r2.sizeMismatch.length === 1 && r2.missing.length === 0, JSON.stringify(r2.sizeMismatch).slice(0, 120));

  // 3) 旧域名重新出现在 runtime.url 里要红（这正是服务器那份脚本下次会生成的东西）
  const dead = structuredClone(base);
  dead.runtime.url = `https://${DEAD}/wasm/transformers-js/3.8.1/transformers.bundle.mjs`;
  const r3 = await checkCatalog(dead);
  say('旧域名回到目录里要红', r3.problems.some((x) => x.includes(DEAD)), JSON.stringify(r3.problems).slice(0, 140));

  console.log(`\n自测 ${pass} 通过 / ${fail} 失败`);
  if (fail) process.exitCode = 1;
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const r = await fetch(CATALOG, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (r.status !== 200) {
    console.error(`取不到 ${CATALOG} → ${r.status}`);
    process.exitCode = 3;
    return;
  }
  const cat = await r.json();
  const out = await checkCatalog(cat);
  console.log(`目录 ${out.models} 个模型 / ${out.files} 个文件，updatedAt=${cat.updatedAt}，runtime=${cat.runtime && cat.runtime.version}`);
  for (const x of out.problems) console.log('契约不符 ' + x);
  for (const x of out.missing) console.log('取不到 ' + x);
  for (const x of out.sizeMismatch) console.log('尺寸不符 ' + x);
  if (out.problems.length || out.missing.length || out.sizeMismatch.length) {
    console.error(`目录与语料不一致：契约 ${out.problems.length}、缺失 ${out.missing.length}、尺寸 ${out.sizeMismatch.length}`);
    process.exitCode = 1;
  } else {
    console.log(`catalog.json 自洽：${out.files} 个文件键全部可取且字节相符，base 仍是 ${ALIVE_HOST}`);
  }
}

await main();
