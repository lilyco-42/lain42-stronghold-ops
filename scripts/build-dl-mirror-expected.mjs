// 生成 dl-mirror 的「期望表」并落到仓库里。
// 期望来源有两个，各自标注 provenance，免得以后把不同强度的断言混为一谈：
//   manifest：站内下载清单（唯一会变的输入，所以每次重新抓），含 size 与 sha256（强度最高，能验 pin）
//   csv     ：scripts/dl-mirror-csv-snapshot.json —— 2026-09-28 那份 OSS 清单的**冻结快照**，
//             含键名、Content-Type 和当年上传并回读校验过的文件尺寸（强度次一档）。
//             必须是仓库内的快照而不是 D:/Code/_staging 里的草稿：那条路径只有我本机有，
//             CI 里 readFileSync 直接 ENOENT，而工作流那一步用 `|| echo` 把失败吞成了 success，
//             于是这道防"我改漏"的闸门其实一次都没跑过。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

const MIME = {
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.msi': 'application/x-msdownload',
  '.apk': 'application/vnd.android.package-archive',
  '.zip': 'application/zip',
  '.gguf': 'application/octet-stream',
};
const extOf = (k) => {
  const b = basename(k);
  const i = b.lastIndexOf('.');
  return i < 0 ? '' : b.slice(i).toLowerCase();
};

const manifest = JSON.parse(
  execFileSync('curl', ['-sS', '--fail', '--compressed', '--max-time', '30', 'https://lain42.top/downloads/manifest.json'], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  })
);

const rows = [];
// mirror 主机不是桶的域名 = 这条还没走镜像，桶里没有对象可验。
// 2026-10-14 实测：站内 20 条 mirror 里 18 条已翻到 dl.lilyco42.top，2 条（lyco、lyco-jev）暂时回源站 lain42.top，
// 死域名 dl.lain42.top 已经 0 条。把"回源站"当成"桶里的键缺失"来报红是错的 —— 天天红的闸门等于没有闸门；
// 但也不能当没看见，所以单独记在 notMirrored 里，让它显式、可比对、可数。
const notMirrored = [];
for (const it of manifest.items) {
  const m = it.mirror;
  if (!m || !m.url) continue;
  const u = new URL(m.url);
  const key = u.pathname.replace(/^\//, '');
  if (u.host !== 'dl.lilyco42.top') {
    notMirrored.push({
      id: it.id,
      host: u.host,
      key,
      size: Number(m.size) || 0,
      sha256: m.sha256 ? String(m.sha256) : null,
      note: 'mirror 仍回源站（不是死域名），所以这条不进桶验收',
    });
    continue;
  }
  rows.push({
    key,
    size: Number(m.size) || 0,
    sha256: m.sha256 ? String(m.sha256) : null,
    ct: MIME[extOf(key)] || 'application/octet-stream',
    src: 'manifest',
    id: it.id,
  });
}

const snap = JSON.parse(readFileSync(here + 'dl-mirror-csv-snapshot.json', 'utf8'));
// 33 条 csv 资产当年只回读校验过、没处存哈希，所以之前只能断长度与类型。
// 现在 scripts/dl-mirror-csv-sha.json 存着"本机源文件与 R2 现对象双向算一致"的 sha256
// （由 scripts/pin-csv-assets.mjs 生成，两边不一致的键不会出现在里面）。
let csvSha = new Map();
if (existsSync(here + 'dl-mirror-csv-sha.json')) {
  csvSha = new Map(
    JSON.parse(readFileSync(here + 'dl-mirror-csv-sha.json', 'utf8')).rows.map((r) => [r.key, r.sha256])
  );
}
for (const r of snap.rows) {
  rows.push({ key: r.key, size: r.size, sha256: csvSha.get(r.key) ?? null, ct: r.ct, src: 'csv', id: r.key });
}

// 第三类：manifest 与 csv 都覆盖不到、但站内代码确实引用的键（wllama compat 那两个）。
// 这类必须"补一个就钉一个"，否则新入库的对象只剩长度与类型，内容坏了没人知道。
if (existsSync(here + 'dl-mirror-extra-pinned.json')) {
  for (const r of JSON.parse(readFileSync(here + 'dl-mirror-extra-pinned.json', 'utf8')).rows) {
    rows.push({ key: r.key, size: r.size, sha256: r.sha256, ct: r.ct, src: 'extra', id: r.key });
  }
}

const out = {
  // 故意不写 generatedAt / 时间戳：CI 里要拿「重新生成后的文件 vs 已提交的文件」做 diff
  // 来判断期望表是否落后于线上 manifest。带时间戳会让它每次都不同 → 闸门永远报警，
  // 而天天红的闸门等于没有闸门。
  base: 'https://dl.lilyco42.top',
  note:
    'manifest 项的 sha256 来自下载站清单本身；csv 项的 sha256 来自"本机当年上传的源文件"与"R2 现对象"双向计算相等' +
    '（见 dl-mirror-csv-sha.json / pin-csv-assets.mjs）。两类强度的来源不同，但都到了字节级；csv 那条不能声称与某个权威上游一致，' +
    '因为这些 npm/包文件本身没有存哈希的清单。extra 项（dl-mirror-extra-pinned.json）是站内拼出来、两张表都不覆盖的键，' +
    '哈希取自上游发布物本身，强度最高。',
  knownGaps: [],
  // 2026-10-14：lyco-jev 这条"等用户决定重钉"已经由站内自己解决了 —— manifest 现在自己钉
  // 1,155,579,350 B / 3b47b18b…（就是我量出来的源站那份 build），并把 mirror 指向源站而非死域名。
  // 所以它不再是"pin 冲突的缺口"，改记在 notMirrored（桶里没有它）。
  notMirrored,
  items: rows,
};
writeFileSync(here + 'dl-mirror-expected.json', JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(
  `写出 ${rows.length} 条（manifest ${rows.filter((r) => r.src === 'manifest').length}，csv ${rows.filter((r) => r.src === 'csv').length}，extra ${rows.filter((r) => r.src === 'extra').length}）；knownGaps=${out.knownGaps.length}`
);
