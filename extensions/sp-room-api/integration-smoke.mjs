// Real in-process smoke using the *actual* game Lobby and HTTP handler.
// Runs in a throwaway child process; never touches the production service.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(process.argv[2] || '.');
const port = await new Promise((resolvePort, reject) => {
  const srv = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const value = srv.address().port; srv.close(() => resolvePort(value));
  });
});
const tmp = mkdtempSync(join(tmpdir(), 'sp-room-api-'));
const token = randomBytes(32).toString('base64url');
const file = join(tmp, 'token');
writeFileSync(file, token, { mode: 0o600 });
const childJS = String.raw`
const { startServer } = await import('./server/index.js');
const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
await fetch(srv.url + '/healthz'); // capture actual Lobby via its unchanged stats()
const session = { playerId: 'test-host-secret', name: '烟花测试', connected: true, roomCode: null, limitKey: null };
const created = srv.lobby.create(session, { mode: 'coop', difficulty: 'hard' });
if (!created.ok) throw Error('Unable to create isolated test room');
console.log('SMOKE_READY');
process.stdin.resume();
`;
const child = spawn(process.execPath, ['--import', pathToFileURL(resolve('extensions/sp-room-api/preload.mjs')).href, '--input-type=module', '-e', childJS], {
  cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: {
    ...process.env, SP_ROOM_GAME_ROOT: root, SP_ROOM_API_PORT: String(port),
    SP_ROOM_API_TOKEN_FILE: file,
  },
});
let logs = '';
child.stdout.on('data', b => { logs += String(b); });
child.stderr.on('data', b => { logs += String(b); });
try {
  for (let i = 0; i < 80 && !logs.includes('SMOKE_READY'); i++) {
    if (child.exitCode != null) throw new Error('Child exited: ' + logs.slice(-1200));
    await delay(150);
  }
  if (!logs.includes('SMOKE_READY')) throw new Error('Timed out: ' + logs.slice(-1600));
  const api = 'http://127.0.0.1:' + port + '/api/bot/v1/rooms';
  const blocked = await fetch(api);
  if (blocked.status !== 401) throw new Error('Unauthenticated API not blocked: ' + blocked.status);
  const res = await fetch(api, { headers: { Authorization: 'Bearer ' + token } });
  const body = await res.json();
  if (res.status !== 200 || body.schemaVersion !== 1 || body.rooms.length !== 1 || body.rooms[0].players[0].name !== '烟花测试')
    throw new Error('Bad real Lobby snapshot: ' + JSON.stringify(body).slice(0, 1800));
  if (JSON.stringify(body).includes('test-host-secret')) throw new Error('Player ID leaked');
  console.log('REAL_LOBBY_SMOKE_OK', JSON.stringify({ code: body.rooms[0].code, mode: body.rooms[0].mode, occupancy: body.rooms[0].occupancy }));
} finally {
  child.kill('SIGKILL');
  rmSync(tmp, { recursive: true, force: true });
}
