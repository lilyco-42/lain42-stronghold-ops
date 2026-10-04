// 关闭运行中 Node 进程的 inspector。依次尝试几种方式。
let WS = globalThis.WebSocket;
if (typeof WS !== 'function') {
  const mod = await import('/opt/Stronghold-Protocol/node_modules/ws/index.js');
  WS = mod.WebSocket || mod.default;
}

const list = await (await fetch('http://127.0.0.1:9229/json/list')).json();
const t = list.find((x) => x.webSocketDebuggerUrl);
if (!t) { console.log('inspector 已关闭'); process.exit(0); }

const ws = new WS(t.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const myId = ++id;
    pending.set(myId, { res, rej });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  }
};

const attempts = [
  { name: 'process._debugEnd()', expr: 'process._debugEnd()', api: false },
  { name: "require('inspector').close()", expr: "require('inspector').close()", api: true },
  { name: 'process._debugProcess 回退', expr: "typeof process._debugEnd", api: false },
];

for (const a of attempts) {
  try {
    const r = await send('Runtime.evaluate', {
      expression: a.expr, awaitPromise: true, returnByValue: true, includeCommandLineAPI: a.api,
    });
    const val = r.result?.value ?? r.result?.description ?? JSON.stringify(r);
    console.log(`  [${a.name}] → ${JSON.stringify(val).slice(0, 120)}`);
    if (r.exceptionDetails) console.log(`      异常: ${r.exceptionDetails.text}`);
  } catch (e) {
    console.log(`  [${a.name}] → 调用失败: ${e.message.slice(0, 120)}`);
  }
  await new Promise((r) => setTimeout(r, 800));
  try {
    const still = await fetch('http://127.0.0.1:9229/json/list');
    if (still.ok) { /* 还开着，继续试 */ } else break;
  } catch { console.log('  ✓ 端口已不再响应 —— 已关闭'); break; }
}

try { ws.close(); } catch { /* ignore */ }
setTimeout(() => process.exit(0), 500);
