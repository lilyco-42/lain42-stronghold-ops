// Opt-in, process-local observation adapter for Stronghold Protocol.
// Usage: NODE_OPTIONS="--import=/opt/sp-room-api/preload.mjs" node server/index.js
// This module is outside the game repository and touches no tracked game file.
import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRoomApiHandler } from './api.mjs';

const gameRoot = resolve(process.env.SP_ROOM_GAME_ROOT || process.cwd());
const tokenFile = process.env.SP_ROOM_API_TOKEN_FILE || '/etc/sp-room-api/token';
const bindHost = '127.0.0.1'; // Fixed loopback, never expose the secret room codes directly.
const port = Number(process.env.SP_ROOM_API_PORT || 5187);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('SP_ROOM_API_PORT invalid');

// Fail closed on missing credentials, but do not print the secret.
const fileInfo = statSync(tokenFile);
if (process.platform !== 'win32' && (fileInfo.mode & 0o077)) {
  throw new Error('SP_ROOM_API_TOKEN_FILE permissions must be 0600');
}
const token = readFileSync(tokenFile, 'utf8').trim();
if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('SP_ROOM_API_TOKEN_FILE must contain a random base64url token');

// Import the exact ESM module that the game will also import.
// Hook ONLY its already-public stats method, preserving its result and side effects.
const { Lobby } = await import(pathToFileURL(resolve(gameRoot, 'server/lobby.js')).href);
if (typeof Lobby?.prototype?.stats !== 'function') throw new Error('Unsupported Lobby contract: stats() is missing');
if (typeof Lobby?.prototype?.getRoom !== 'function') throw new Error('Unsupported Lobby contract: getRoom() is missing');
let lobby = null;
const original = Lobby.prototype.stats;
if (original.__spRoomApiPatched) throw new Error('Room bridge already attached');
const wrapped = function (...args) {
  lobby = this;
  return Reflect.apply(original, this, args);
};
wrapped.__spRoomApiPatched = true;
Lobby.prototype.stats = wrapped;

const api = createServer(createRoomApiHandler({ getLobby: () => lobby, token }));
api.on('error', error => {
  console.error('[sp-room-api] loopback listener unavailable:', error.code || error.message);
  // Failed bridge must be observable, not silently treated as successful.
  process.exitCode = 1;
});
api.listen(port, bindHost, () => {
  console.log('[sp-room-api] room observer ready on loopback port', port);
});
