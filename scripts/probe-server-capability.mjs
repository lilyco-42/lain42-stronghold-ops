#!/usr/bin/env node
// 线级能力探测：/healthz.app 说的版本，服务器**代码**真的认不认这个动词？两者可以不一致。
//
// 为什么要有这个脚本（2026-10-05 实测到的事故）：线上 `/healthz.app` 已经是 `0.1.3`，但拿真 socket 问
// `room.spectate` / `room.kick` / `room.removeSpectator`，三个全部回答 `BAD_MSG unknown type …`；
// 而 `server/lobby.js:292` 明明有 `case 'room.spectate'` —— 缺的是 `shared/protocol.js` 里的类型登记，
// 消息在到达分发器之前就被 net.js 拒了。也就是说那次部署是**混合文件**：一部分 0.1.3、一部分 0.1.1。
// 客户端如果只信版本号，就会把入口点亮、玩家点下去报错。
//
// 用法（无需依赖，Node 24 自带 WebSocket）：
//   node scripts/probe-server-capability.mjs wss://sp.lain42.top/ws room.spectate room.kick room.removeSpectator room.join room.notARealVerb
// 判读：
//   handled      = 服务器认得这个类型（回了业务级错误，比如同盟不存在）
//   unknown type = 类型表里没有 —— 这台服务器**没有**这个能力，别看版本号
// 退出码：全部 handled 才 0；有任何 unknown 返回 2（最后那个自造动词必须 unknown，是这条检测的正控制）。
const url = process.argv[2] || 'wss://sp.lain42.top/ws';
const verbs = process.argv.slice(3);
const list = verbs.length ? verbs : ['room.spectate', 'room.kick', 'room.removeSpectator', 'room.notARealVerb'];

const ask = (verb) => new Promise((resolve) => {
  const ws = new WebSocket(url);
  let sent = false;
  const done = (verdict, detail) => { try { ws.close(); } catch { /* 已关 */ } resolve({ verb, verdict, detail }); };
  const timer = setTimeout(() => done('TIMEOUT', '没等到回复'), 12000);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', rid: 1, name: 'Probe', version: 1 })));
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (!sent && (m.t === 'welcome' || (m.t === 'ok' && m.rid === 1))) {
      sent = true;
      ws.send(JSON.stringify({ t: verb, rid: 2, code: 'ZZZZ' }));   // 故意用不可能存在的密钥：不建房间、不留状态
      return;
    }
    if (sent && (m.rid === 2 || m.t === 'error' || m.code)) {
      // ⚠️ 两个实测坑：错误回复确实带 rid（我一开始猜"BAD_MSG 不回 rid"是错的），
      // 真正让探测永远等不到答案的是 hello 里的 name —— 名字过长服务器直接不回 welcome（'CapabilityProbe' 无回复，
      // 'Probe' 正常）。所以这里既认 rid 也认 t==='error'，并且 name 保持短。
      clearTimeout(timer);
      const txt = `${m.code || ''} ${m.detail || ''}`;
      done(/unknown type|unhandled type/.test(txt) ? 'unknown' : 'handled', `${m.code || m.t}: ${m.detail || ''}`.trim());
    }
  });
  ws.addEventListener('error', (e) => { clearTimeout(timer); done('ERROR', String(e.message || e.type)); });
});

const out = [];
for (const v of list) out.push(await ask(v));       // 串行：一次一个连接，别给生产添负载
for (const r of out) console.log(`  ${r.verdict.padEnd(8)} ${r.verb.padEnd(22)} ${r.detail || ''}`);
// 正控制（`room.notA…`）永远该是 unknown —— 它不能算进"缺的能力"，否则这条脚本每次都在报一个假缺失。
const isControl = (r) => r.verb.startsWith('room.notA');
const unknown = out.filter((r) => r.verdict === 'unknown' && !isControl(r));
const control = out.filter(isControl);
if (control.some((c) => c.verdict !== 'unknown')) {
  console.log('⚠️ 正控制没生效：自造的动词本该 unknown —— 这台服务器的判读不可信，别用本脚本的结论。');
  process.exit(3);
}
console.log(`正控制：${control.length} 个自造动词全部 unknown（判据有效）。`);
console.log(unknown.length ? `结论：这台服务器缺 ${unknown.length} 个能力（看 verdict，别看 /healthz.app）。` : '结论：探测到的能力都在。');
process.exit(unknown.length ? 2 : 0);
