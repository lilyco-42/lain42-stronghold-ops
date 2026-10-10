import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { roomsSnapshot } from './snapshot.mjs';
import { createRoomApiHandler } from './api.mjs';

const TOKEN = 'a'.repeat(48);
const seat = (seat, playerId, name, isBot = false) =>
  ({ seat, playerId, name, isBot, ready: true, connected: true });
const room = (code, { match = null, aiPicksLast = false, mode = 'coop' } = {}) => ({
  code, match, mode, disposed: false, createdAt: 1_700_000_000_000,
  toState() {
    return {
      code, mode, difficulty: 'HARD', inMatch: !!match, aiPicksLast,
      hostId: 'secret-host-id',
      seats: [seat(0, 'secret-host-id', '玩家A'), seat(1, 'secret-2', 'AI·阿米娅', true), null, null],
    };
  },
});
const lobby = () => ({ rooms: new Map([
  ['ABCD', room('ABCD', { aiPicksLast: true })],
  ['EFGH', room('EFGH', { match: {} })],
  ['JKLM', room('JKLM', { mode: 'solo' })],
]) });

test('only waiting coop rooms; no player IDs or session secrets; does not mutate originals', () => {
  const source = lobby();
  const before = source.rooms.get('ABCD').toState().seats[0].name;
  const rows = roomsSnapshot(source);
  assert.deepEqual(rows.map(x => x.code), ['ABCD']);
  assert.equal(rows[0].humans, 1);
  assert.equal(rows[0].bots, 1);
  assert.equal(rows[0].capacity, 4);
  assert.equal(rows[0].joinable, true);
  assert.equal(rows[0].players[0].isHost, true);
  assert.equal(rows[0].strategy.aiPicksLast, true);
  assert.equal(JSON.stringify(rows).includes('secret-host-id'), false);
  assert.equal(source.rooms.get('ABCD').toState().seats[0].name, before);
  assert.equal(roomsSnapshot(source, { mode: 'all' }).length, 2);
});

test('resilient to incompatible room objects', () => {
  const source = lobby();
  source.rooms.set('MNOP', { toState() { throw new Error('bad layout'); } });
  assert.equal(roomsSnapshot(source).length, 1);
  assert.throws(() => roomsSnapshot(null), /LOBBY_UNAVAILABLE/);
});

test('HTTP auth, paging, singular lookup, headers, missing lobby, methods and rate limit', async () => {
  const srv = createServer(createRoomApiHandler({ getLobby: lobby, token: TOKEN, maxRequestsPerMinute: 7 }));
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  const root = 'http://127.0.0.1:' + srv.address().port;
  const request = (path, opts = {}) => fetch(root + path, opts);
  const auth = { Authorization: 'Bearer ' + TOKEN };
  try {
    assert.equal((await request('/v1/rooms')).status, 401);
    assert.equal((await request('/v1/rooms', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    const ok = await request('/v1/rooms?limit=1', { headers: auth });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('cache-control'), /no-store/);
    assert.equal(ok.headers.get('access-control-allow-origin'), null);
    const body = await ok.json();
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.rooms.length, 1);
    assert.equal(body.rooms[0].code, 'ABCD');
    const item = await request('/v1/rooms/ABCD', { headers: auth });
    assert.equal((await item.json()).room.code, 'ABCD');
    assert.equal((await request('/v1/rooms/EFGH', { headers: auth })).status, 404);
    assert.equal((await request('/v1/rooms?mode=invalid', { headers: auth })).status, 400);
    assert.equal((await request('/v1/rooms', { method: 'POST', headers: auth })).status, 405);
    assert.equal((await request('/v1/rooms', { method: 'HEAD', headers: auth })).status, 200);
    assert.equal((await request('/v1/rooms', { headers: auth })).status, 429);
  } finally { srv.closeAllConnections(); await new Promise(resolve => srv.close(resolve)); }
});

test('unavailable in-process lobby returns 503 not an invented empty list', async () => {
  const srv = createServer(createRoomApiHandler({ getLobby: () => null, token: TOKEN }));
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  try {
    const resp = await fetch('http://127.0.0.1:' + srv.address().port + '/v1/rooms', { headers: { Authorization: 'Bearer ' + TOKEN } });
    assert.equal(resp.status, 503);
    assert.equal((await resp.json()).error.code, 'LOBBY_UNAVAILABLE');
  } finally { srv.closeAllConnections(); await new Promise(resolve => srv.close(resolve)); }
});
