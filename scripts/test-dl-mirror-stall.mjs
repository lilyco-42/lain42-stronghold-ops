#!/usr/bin/env node
// check-dl-mirror.mjs 的失败路径回归测试（本地，零外网）。
// 起因：CI run 38234496095 里第 19 条（645 MiB）被"总时长 5 分钟"的 AbortSignal 掐死，
// 而异常没被接住 —— 整个 job 直接炸成 DOMException，日志里连"卡在第几条"都没打出来。
// 所以这条测试钉三件事：
//   1) 正向对照：服务端规矩地给 206（Range 探测）+ 200 整段（哈希回读）→ 闸门必须绿、退出码 0
//   2) 反向对照 A：Range 探测正常但整段 GET 只发头不发体（黑洞）→ 必须是 ✗ 行 + 原因 + 退出码 1，
//      不能是未捕获异常。少一个正向对照，这种测试只会证明"脚本挂了"。
//   3) 反向对照 B：键被删了（404）→ 浅模式必须指名是哪个键变红，而同表里健康的键仍判通过。
//      这条是在本机抓出一个 Windows 真 bug 的：判定为红时用 process.exit() 强退，
//      undici 的 keep-alive socket 还没关，libuv 断言 src\win\async.c:76 → 退出码 3221226505，
//      看起来像崩了而不是"闸门红了"。现在一律用 process.exitCode（Linux runner 上炸不出来，
//      而且失败路径在那边还从没红过 —— 两边都不测就等于没测）。
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const body = Buffer.from('dl-mirror-stall-fixture'.repeat(7), 'utf8'); // 168 B
const sha = createHash('sha256').update(body).digest('hex');

const work = join(tmpdir(), `dlmirror-test-${process.pid}`);
mkdirSync(join(work, 'scripts'), { recursive: true });
copyFileSync(join(here, 'check-dl-mirror.mjs'), join(work, 'scripts', 'check-dl-mirror.mjs'));
const tablePath = join(work, 'scripts', 'dl-mirror-expected.json');
const okItem = { key: 'a.bin', size: body.length, sha256: sha, ct: 'application/octet-stream', src: 'manifest', id: 'a' };
const writeTable = (items) =>
  writeFileSync(tablePath, JSON.stringify({ base: 'http://127.0.0.1:1', knownGaps: [], items }));
writeTable([okItem]);

function serve(stall) {
  const srv = createServer((req, res) => {
    // 只认 a.bin：其它键一律 404 —— 这样"键被删了"这条分支也有对照，浅模式必须抓到
    if (!req.url.startsWith('/a.bin')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (req.headers.range) {
      res.writeHead(206, {
        'content-range': `bytes 0-0/${body.length}`,
        'content-type': 'application/octet-stream',
        'content-length': '1',
      });
      res.end(body.subarray(0, 1));
      return;
    }
    if (stall) {
      // 只发头，正文永远不来：复刻"连得上、不回包"那种最难看的失败形态
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) });
    res.end(body);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}

function run(port) {
  // 必须异步 spawn：被测的那个 HTTP 服务跑在本进程里，spawnSync 会冻结事件循环，
  // 于是"正向对照"也变成超时 —— 第一版就是这么假红的。
  const child = spawn(
    process.execPath,
    [join(work, 'scripts', 'check-dl-mirror.mjs'), '--deep', 'all'],
    { env: { ...process.env, DL_MIRROR_BASE: `http://127.0.0.1:${port}`, DL_STALL_MS: '1500' } }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const killer = setTimeout(() => child.kill('SIGKILL'), 60000);
  return new Promise((resolve) =>
    child.on('close', (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr });
    })
  );
}

let bad = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) bad++;
};

{
  const { srv, port } = await serve(false);
  const r = await run(port);
  check(r.status === 0, '正向：整段回读应判定 sha256 一致并退出 0', `rc=${r.status} ${String(r.stderr).trim().slice(0, 90)}`);
  check(/sha256 与 manifest pin 一致/.test(r.stdout), '正向：应出现 HASH 行');
  srv.close();
}
{
  const { srv, port } = await serve(true);
  const r = await run(port);
  const all = r.stdout + r.stderr;
  check(r.status === 1, '反向：黑洞应让闸门以退出码 1 变红', `rc=${r.status}`);
  check(/原因=/.test(all), '反向：✗ 行要带上停顿原因', all.split('\n').find((l) => l.includes('原因='))?.slice(0, 120));
  check(!/DOMException|UnhandledPromiseRejection/.test(all), '反向：不许把未捕获异常抛给整个 job');
  check(/\[1\/1\]/.test(all), '反向：进度行要说明卡在第几条');
  srv.close();
}
{
  // 第三个对照：键被删掉。浅模式（每天那条车道）唯一的职责就是这个，
  // 前面两个对照都只碰深模式，没有它的话"每天全绿"其实没证明过自己能发现 404。
  writeTable([okItem, { ...okItem, key: 'gone.bin', id: 'gone' }]);
  const { srv, port } = await serve(false);
  const r = await run(port);
  const all = r.stdout + r.stderr;
  check(r.status === 1, '反向：键被删了要变红', `rc=${r.status}`);
  check(/gone\.bin.*http=404/s.test(all), '反向：✗ 行要指名是哪个键 + 404', all.split('\n').find((l) => l.includes('gone.bin'))?.slice(0, 100));
  check(/OK\s+a\.bin/.test(all), '反向：同一个表里健康的键仍要判通过');
  srv.close();
}
console.log(bad ? `\n${bad} 项失败` : '\n失败路径回归测试通过（正向 + 黑洞 + 缺键都有对照）');
process.exit(bad ? 1 : 0);
