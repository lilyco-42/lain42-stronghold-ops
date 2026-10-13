// Unit tests for the LAN directory. Pure functions only — no network, no easytier.
//   node --test extensions/sp-lan-directory/directory.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePeerTable, inCidr, ipToInt, shapeRoom, buildDirectory, mapLimit, parsePortList, probePeer } from './directory.mjs';

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
  const probe = async (peer, { ports }) => {
    seen.push(`${peer.ip}:${ports[0]}`);
    return peer.ip === '10.126.126.1'
      ? { port: ports[0], healthz: { ok: true, app: '0.2.4', rooms: 68, humans: 91, sockets: 57, build: 'abc' } }
      : null;
  };
  const doc = await buildDirectory({ peers, selfIp: '10.126.126.1', probe, now: new Date('2026-10-13T00:00:00Z') });
  assert.deepEqual(seen.sort(), ['10.126.126.1:5150', '10.126.126.57:5150']);
  assert.equal(doc.network.peers, 2);
  assert.equal(doc.network.reachable, 1);
  assert.equal(doc.network.port, 5150);
  assert.deepEqual(doc.network.ports, [5150, 3000]);
  assert.equal(doc.rooms[0].virtualIp, '10.126.126.1'); // reachable first
  assert.equal(doc.rooms[1].virtualIp, '10.126.126.57');
  assert.equal(doc.generatedAt, '2026-10-13T00:00:00.000Z');
  assert.equal(doc.schemaVersion, 1);
});

test('buildDirectory reports the port each peer actually answered on (player-hosted :3000)', async () => {
  // The regression this covers: our own server runs on 5150, but a player who hosts for their
  // friends follows upstream DEPLOY.md and lands on the game's default 3000. Probing only 5150
  // made every player-hosted room invisible — the exact case the feature exists for.
  const peers = [
    { ip: '10.126.126.1', hostname: 'Lain42', cost: 'Local', nat: '' },
    { ip: '10.126.126.77', hostname: 'FRIEND', cost: 'p2p', nat: '' },
  ];
  const probe = async (peer) => {
    if (peer.ip === '10.126.126.1') return { port: 5150, healthz: { ok: true, app: '0.2.5', rooms: 5, sockets: 9, build: 'x' } };
    if (peer.ip === '10.126.126.77') return { port: 3000, healthz: { ok: true, app: '0.2.5', rooms: 1, sockets: 2, build: 'y' } };
    return null;
  };
  const doc = await buildDirectory({ peers, selfIp: '10.126.126.1', probe });
  const byIp = Object.fromEntries(doc.rooms.map((r) => [r.virtualIp, r]));
  assert.equal(byIp['10.126.126.1'].port, 5150);
  assert.equal(byIp['10.126.126.77'].port, 3000); // ← the fix: the room carries the answering port
  assert.equal(byIp['10.126.126.77'].reachable, true);
  assert.equal(byIp['10.126.126.77'].joinable, true);
});

test('buildDirectory still accepts the legacy single `port` form', async () => {
  let got;
  const probe = async (peer, { ports }) => { got = ports; return null; };
  const doc = await buildDirectory({ peers: [{ ip: '10.126.126.1', hostname: 'Lain42', cost: 'Local', nat: '' }], port: 4000, probe });
  assert.deepEqual(got, [4000]);
  assert.equal(doc.network.port, 4000);
  assert.deepEqual(doc.network.ports, [4000]);
  assert.equal(doc.rooms[0].port, 4000);
});

test('parsePortList: env wins, otherwise primary + the game default 3000, deduped', () => {
  assert.deepEqual(parsePortList(undefined, 5150), [5150, 3000]);
  assert.deepEqual(parsePortList('', 5150), [5150, 3000]);
  assert.deepEqual(parsePortList('7000, 7001', 5150), [7000, 7001]);
  assert.deepEqual(parsePortList('5150,5150,3000', 5150), [5150, 3000]);
  assert.deepEqual(parsePortList('abc,,0,99999,-1,3000', 5150), [3000]);
  assert.deepEqual(parsePortList(undefined, 3000), [3000]); // primary IS the default: no duplicate
});

test('probePeer tries each port in order and returns the first that answers ok', async () => {
  const tried = [];
  const fetchImpl = async (url) => {
    tried.push(url);
    if (url.includes(':3000')) return { ok: true, json: async () => ({ ok: true, app: '0.2.5' }) };
    throw new Error('ECONNREFUSED'); // 5150: nothing listening
  };
  const hit = await probePeer({ ip: '10.126.126.77' }, { ports: [5150, 3000], fetchImpl });
  assert.deepEqual(tried, ['http://10.126.126.77:5150/healthz', 'http://10.126.126.77:3000/healthz']);
  assert.equal(hit.port, 3000);
  assert.equal(hit.healthz.app, '0.2.5');
});

test('probePeer returns null when every port fails, or answers non-2xx / ok!==true', async () => {
  const refuse = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal(await probePeer({ ip: '10.126.126.9' }, { ports: [5150, 3000], fetchImpl: refuse }), null);
  const nonOk = async () => ({ ok: false, json: async () => ({ ok: true }) });
  assert.equal(await probePeer({ ip: '10.126.126.9' }, { ports: [5150], fetchImpl: nonOk }), null);
  const notStronghold = async () => ({ ok: true, json: async () => ({ hello: 'world' }) });
  assert.equal(await probePeer({ ip: '10.126.126.9' }, { ports: [5150], fetchImpl: notStronghold }), null);
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
