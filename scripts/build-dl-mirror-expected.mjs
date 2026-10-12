// 生成 dl-mirror 的「期望表」并落到仓库里（CI 不能依赖 _staging 草稿目录，
// 否则清单一旦清理，这条闸门就变成了没人能复现的断言）。
// 期望来源有两个，各自标注 provenance，免得以后把不同强度的断言混为一谈：
//   manifest：站内下载清单，含 size 与 sha256（强度最高，能验 pin）
//   csv     ：2026-09-28 那份 OSS 资产清单，含键名与 Content-Type，
//             size 取我当时上传并回读校验过的本地文件尺寸（强度次一档）
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

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
for (const it of manifest.items) {
  const m = it.mirror;
  if (!m || !m.url) continue;
  const key = new URL(m.url).pathname.replace(/^\//, '');
  rows.push({
    key,
    size: Number(m.size) || 0,
    sha256: m.sha256 ? String(m.sha256) : null,
    ct: MIME[extOf(key)] || 'application/octet-stream',
    src: 'manifest',
    id: it.id,
  });
}

const csv = readFileSync('D:/Code/_staging/oss-assets-20260928.csv', 'utf8').replace(/^/, '');
const localRoot = (p) => p.replaceAll('\\', '/');
for (const line of csv.trim().split(/\r?\n/).slice(1)) {
  const m = line.match(/^"([^"]+)","([^"]+)","([^"]+)"$/);
  if (!m) continue;
  let size = 0;
  try {
    size = statSync(localRoot(m[1])).size;
  } catch {
    /* 源文件已被清理：只断言可达与类型 */
  }
  rows.push({ key: m[2], size, sha256: null, ct: m[3], src: 'csv', id: m[2] });
}

const out = {
  // 故意不写 generatedAt / 时间戳：CI 里要拿「重新生成后的文件 vs 已提交的文件」做 diff
  // 来判断期望表是否落后于线上 manifest。带时间戳会让它每次都不同 → 闸门永远报警，
  // 而天天红的闸门等于没有闸门。
  base: 'https://dl.lilyco42.top',
  note: 'sha256 只来自下载站 manifest；csv 项当年已逐条上传并回读校验，这里只锁长度与 Content-Type。',
  knownGaps: [
    { id: 'lyco', why: 'mirror.url 本就指向源站 lain42.top/lyco-dl/…，不是 OSS 对象，无需迁' },
    { id: 'lyco-jev', why: 'manifest 钉 623029300 B；源站文件自 Oct 3 起是 1155579350 B，pin 那份只在停用的 OSS → 等用户决定' },
    { id: 'cute-pet', why: 'pin 801aa079… vs GitHub 现资产 0cd6f668…（同尺寸不同字节），重钉还是顶用等用户决定' },
  ],
  items: rows,
};
writeFileSync('D:/Code/lain42-stronghold-ops/scripts/dl-mirror-expected.json', JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(
  `写出 ${rows.length} 条（manifest ${rows.filter((r) => r.src === 'manifest').length}，csv ${rows.filter((r) => r.src === 'csv').length}）；knownGaps=${out.knownGaps.length}`
);
