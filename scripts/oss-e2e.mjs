import pw from 'file:///C:/Users/liuqi/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core/index.js';
const { chromium } = pw;

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--ignore-certificate-errors'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();

const errs = [];
const failed = [];
const fromServer = [];
const ossCount = { n: 0 };
const serverPaths = {};
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 180)); });
page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 180)));
page.on('requestfailed', (r) => failed.push(r.url().slice(0, 130) + ' :: ' + (r.failure()?.errorText || '?')));
page.on('request', (r) => {
  const u = r.url();
  if (/^https:\/\/sp\.lain42\.top\/(js|css|vendor|shared|fonts)\//.test(u)) {
    const p = u.replace('https://sp.lain42.top', '');
    fromServer.push(p);
    serverPaths[p] = (serverPaths[p] || 0) + 1;
  }
  if (/^https:\/\/dl\.lain42\.top\/.*\/app\//.test(u)) ossCount.n++;
});

const ct = async (t) => page.locator(`button:has-text("${t}")`).first().click({ timeout: 3000 }).then(() => true).catch(() => false);
const txt = async () => (await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 180)));

const TARGET = process.argv[2] || 'https://sp.lain42.top/index-oss.html';
await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(10000);
console.log('标题页:', await txt());

await page.fill('input', 'osscheck').catch(() => {});
await ct('开始'); await page.waitForTimeout(3000);
console.log('进入后:', await txt());

await ct('创建同盟'); await page.waitForTimeout(3000);
for (let i = 0; i < 3; i++) { if (!(await ct('添加 AI 队友'))) break; await page.waitForTimeout(1500); }
console.log('房间:', await txt());

await ct('开始模拟'); await page.waitForTimeout(3000);
for (const t of ['准备就绪', '就绪', '确认', '下一步']) { if (await ct(t)) break; }
await page.waitForTimeout(18000);
console.log('选策略页:', await txt());

const dom = await page.evaluate(() => ({
  screen: document.querySelector('.screen')?.className || '(无)',
  dorder: document.querySelectorAll('.dorder').length,
  dband: document.querySelectorAll('.dband').length,
  canvas: !!document.querySelector('canvas'),
}));
console.log('\nDOM:', JSON.stringify(dom));

console.log(`\n从 OSS 加载: ${ossCount.n} 个`);
console.log(`⚠ 打到服务器的静态请求: ${fromServer.length}`);
if (fromServer.length) {
  Object.entries(serverPaths).slice(0, 15).forEach(([p, c]) => console.log(`   ${c}× ${p}`));
}
console.log(`failed: ${failed.length}`); failed.slice(0, 8).forEach((s) => console.log('  ' + s));
console.log(`console err: ${errs.length}`); errs.slice(0, 8).forEach((s) => console.log('  ' + s));

await page.screenshot({ path: 'oss-e2e.png' });
await browser.close();
