// Unit tests for the LAN directory. Pure functions only — no network, no easytier.
//   node --test extensions/sp-lan-directory/directory.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePeerTable, inCidr, ipToInt, shapeRoom, buildDirectory, mapLimit } from './directory.mjs';

// Verbatim `easytier-cli peer` output from v2.6.4 (2026-10-13), one local node plus one remote.
const PEER_TABLE = `
| ipv4            | hostname | cost  | lat(ms) | loss | rx | tx | tunnel | NAT            | version        |
|-----------------|----------|-------|---------|------|----|----|--------|----------------|----------------|
| 10.126.126.1/24 | Lain42   | Local | -       | -    | -  | -  | -      | PortRestricted | 2.6.4-8428a89d |
| 10.126.126.57   | DESKTOP  | p2p   | 12.345  | 0.0  | 1  | 2  | udp    | FullCone       | 2.6.4-8428a89d |
`;

test('parsePeerTable reads ipv4/hostname/cost and skips header + separator', () => {
  const rows = parsePeerTable(PEER_TABLE);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { ip: '10.126.126.1', hostname: 'Lain42', cost: 'Local', nat: 'PortRestricted', version: '2.6.4-8428a89d' });
  assert.equal(rows[1].ip, '10.126.126.57');
  assert.equal(rows[1].hostname, 'DESKTOP');
  assert.equal(rows[1].cost, 'p2p');
});

test('parsePeerTable tolerates empty output and a header-only table', () => {
  assert.deepEqual(parsePeerTable(''), []);
  assert.deepEqual(parsePeerTable('| ipv4 | hostname | cost | nat |\n|---|---|---|---|\n'), []);
});

test('inCidr accepts the LAN range and rejects everything else', () => {
  assert.equal(inCidr('10.126.126.1', '10.126.126.0/24'), true);
  assert.equal(inCidr('10.126.126.255', '10.126.126.0/24'), true);
  assert.equal(inCidr('10.126.127.1', '10.126.126.0/24'), false);
  assert.equal(inCidr('127.0.0.1', '10.126.126.0/24'), false);
  assert.equal(inCidr('10.126.126.1', '0.0.0.0/0'), true);
  assert.equal(inCidr('not-an-ip', '10.126.126.0/24'), false);
  assert.equal(inCidr('10.126.126.1', 'bad/cidr'), false);
});

test('ipToInt is unsigned (no sign flip on 10.x and 192.x)', () => {
  assert.equal(ipToInt('10.126.126.1'), 10 * 16777216 + 126 * 65536 + 126 * 256 + 1);
  assert.equal(ipToInt('10.126.126.1'), 176061953);
  assert.equal(ipToInt('192.168.1.5'), 3232235781);
  assert.equal(ipToInt('255.255.255.255'), 4294967295);
});

test('shapeRoom marks an unreachable peer without inventing numbers', () => {
  const room = shapeRoom({ ip: '10.126.126.57', hostname: 'DESKTOP', cost: 'p2p', nat: 'FullCone' }, null, 5150, { selfIp: '10.126.126.1' });
  assert.equal(room.reachable, false);
  assert.equal(room.rooms, null);
  assert.equal(room.humans, null);
  assert.equal(room.joinable, false);
  assert.equal(room.self, false);
});

test('shapeRoom surfaces healthz counters and flags our own node', () => {
  const healthz = { ok: true, app: '0.2.4', build: 'a9c845b57db0', uptimeSec: 116552, sockets: 57, sessions: 108, rooms: 68, matches: 66, humans: 91, bots: 36, spectators: 0 };
  const room = shapeRoom({ ip: '10.126.126.1', hostname: 'Lain42', cost: 'Local', nat: 'PortRestricted' }, healthz, 5150, { selfIp: '10.126.126.1' });
  assert.equal(room.reachable, true);
  assert.equal(room.self, true);
  assert.equal(room.rooms, 68);
  assert.equal(room.humans, 91);
  assert.equal(room.sockets, 57);
  assert.equal(room.version, 'a9c845b57db0');
  assert.equal(room.joinable, true);
});

test('shapeRoom refuses a healthz that is not ok=true', () => {
  assert.equal(shapeRoom({ ip: '10.126.126.9' }, { ok: false }, 5150).reachable, false);
  assert.equal(shapeRoom({ ip: '10.126.126.9' }, { hello: 'world' }, 5150).reachable, false);
});

test('buildDirectory filters to the LAN, probes each peer, sorts reachable first', async () => {
  const peers = [
    { ip: '10.126.126.57', hostname: 'DESKTOP', cost: 'p2p', nat: 'FullCone' },
    { ip: '10.126.126.1', hostname: 'Lain42', cost: 'Local', nat: 'PortRestricted' },
    { ip: '192.168.1.5', hostname: 'NOT-LAN', cost: 'p2p', nat: '' }, // must be dropped
    { ip: '127.0.0.1', hostname: 'LOOPBACK', cost: 'p2p', nat: '' }, // must be dropped
  ];
  const seen = [];
  const probe = async (peer, { port }) => {
    seen.push(`${peer.ip}:${port}`);
    return peer.ip === '10.126.126.1' ? { ok: true, app: '0.2.4', rooms: 68, humans: 91, sockets: 57, build: 'abc' } : null;
  };
  const doc = await buildDirectory({ peers, selfIp: '10.126.126.1', probe, now: new Date('2026-10-13T00:00:00Z') });
  assert.deepEqual(seen.sort(), ['10.126.126.1:5150', '10.126.126.57:5150']);
  assert.equal(doc.network.peers, 2);
  assert.equal(doc.network.reachable, 1);
  assert.equal(doc.rooms[0].virtualIp, '10.126.126.1'); // reachable first
  assert.equal(doc.rooms[1].virtualIp, '10.126.126.57');
  assert.equal(doc.generatedAt, '2026-10-13T00:00:00.000Z');
  assert.equal(doc.schemaVersion, 1);
});

test('mapLimit preserves order and never exceeds the limit', async () => {
  let live = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 3, 2, 4], 2, async (n) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 1));
    live--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 30, 20, 40]);
  assert.ok(peak <= 2, `peak concurrency was ${peak}`);
});
