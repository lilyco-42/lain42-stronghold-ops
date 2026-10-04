import pw from 'file:///C:/Users/liuqi/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core/index.js';
import fs from 'node:fs';
const { chromium } = pw;

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--ignore-certificate-errors'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();

const frames = [];
page.on('websocket', (ws) => {
  console.log('WS 连接:', ws.url());
  ws.on('framereceived', (f) => {
    const p = typeof f.payload === 'string' ? f.payload : Buffer.from(f.payload).toString('base64');
    frames.push({ dir: 'in', text: typeof f.payload === 'string', len: Buffer.byteLength(p, 'utf8'), payload: p });
  });
  ws.on('framesent', (f) => {
    const p = typeof f.payload === 'string' ? f.payload : Buffer.from(f.payload).toString('base64');
    frames.push({ dir: 'out', text: typeof f.payload === 'string', len: Buffer.byteLength(p, 'utf8'), payload: p });
  });
});

const ct = async (t) => page.locator(`button:has-text("${t}")`).first().click({ timeout: 3000 }).then(() => true).catch(() => false);

await page.goto('https://sp.lain42.top/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(8000);
await page.fill('input', 'benchcap').catch(() => {});
await ct('开始'); await page.waitForTimeout(3000);
await ct('创建同盟'); await page.waitForTimeout(3000);
for (let i = 0; i < 3; i++) { if (!(await ct('添加 AI 队友'))) break; await page.waitForTimeout(1200); }
await ct('开始模拟'); await page.waitForTimeout(4000);

// 推进到对局：依次尝试常见的确认按钮
for (let round = 0; round < 8; round++) {
  for (const t of ['准备就绪', '就绪', '确认选择', '确认', '下一步', '跳过']) {
    if (await ct(t)) { console.log('  点击:', t); break; }
  }
  await page.waitForTimeout(6000);
  const t = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 70));
  console.log(`  [${round}] ${t}`);
}

// 采集 90 秒的真实对局流量
console.log('\n开始采集 90 秒...');
const t0 = frames.length;
await page.waitForTimeout(90000);
console.log(`采集到 ${frames.length - t0} 帧（对局中）`);

const summary = {
  capturedAt: new Date().toISOString(),
  total: frames.length,
  inCount: frames.filter((f) => f.dir === 'in').length,
  outCount: frames.filter((f) => f.dir === 'out').length,
  inBytes: frames.filter((f) => f.dir === 'in').reduce((s, f) => s + f.len, 0),
  outBytes: frames.filter((f) => f.dir === 'out').reduce((s, f) => s + f.len, 0),
  nonText: frames.filter((f) => !f.text).length,
};
console.log('\n=== 汇总 ===');
console.log(JSON.stringify(summary, null, 2));

// 类型分布：按 JSON 的 `t` 字段
const types = {};
for (const f of frames) {
  if (!f.text) continue;
  try { const j = JSON.parse(f.payload); const k = `${f.dir}:${j.t ?? '(无 t)'}`; types[k] = types[k] || { n: 0, bytes: 0 }; types[k].n++; types[k].bytes += f.len; } catch { /* ignore */ }
}
console.log('\n=== 消息类型分布（前 20）===');
Object.entries(types).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 20)
  .forEach(([k, v]) => console.log(`  ${k.padEnd(28)} ${String(v.n).padStart(6)} 条  ${(v.bytes / 1024).toFixed(1).padStart(8)} KB`));

fs.writeFileSync('ws-frames.json', JSON.stringify({ summary, frames }, null, 0));
console.log('\n已保存 ws-frames.json');
await browser.close();
