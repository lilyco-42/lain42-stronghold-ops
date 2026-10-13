#!/usr/bin/env node
// Stronghold LAN directory (v1) — a read-only HTTP adapter that lists game servers
// reachable on the EasyTier virtual LAN (see docs/20-easytier-lan-m1.md).
//
// Why it exists: once the virtual LAN is up a player can host a game on their own
// machine, but novices cannot be asked to exchange 10.126.126.x addresses. This
// service enumerates the peers of our EasyTier node, probes each for a Stronghold
// server on :5150, and publishes the result as JSON. The client's picker reads it.
//
// It is deliberately OUTSIDE the game repository and never touches the running game
// process: the only data sources are (1) `easytier-cli peer` and (2) each peer's
// public /healthz. No game code is imported, nothing is injected, nothing restarts.
//
// It is also NOT an authenticated endpoint, unlike extensions/sp-room-api: it only
// publishes virtual-LAN addresses and the same counters /healthz already exposes to
// anyone. Never add player names, room codes or tokens here — those belong to
// sp-room-api behind a bearer token.

import { execFile } from 'node:child_process';
import http from 'node:http';

/** The port our own server answers on. Kept as its own knob because everything else is derived
 *  from it: `SP_LAN_GAME_PORT` is what the deploy sets, `SP_LAN_GAME_PORTS` overrides the list. */
const PRIMARY_GAME_PORT = Number(process.env.SP_LAN_GAME_PORT ?? 5150);

const CONFIG = {
  port: Number(process.env.SP_LAN_DIRECTORY_PORT ?? 5188),
  bind: process.env.SP_LAN_DIRECTORY_BIND ?? '127.0.0.1',
  cidr: process.env.SP_LAN_CIDR ?? '10.126.126.0/24',
  gamePort: PRIMARY_GAME_PORT,
  gamePorts: parsePortList(process.env.SP_LAN_GAME_PORTS, PRIMARY_GAME_PORT),
  cli: process.env.SP_LAN_EASYTIER_CLI ?? '/usr/local/bin/easytier-cli',
  rpcPortal: process.env.SP_LAN_RPC_PORTAL ?? '127.0.0.1:15888',
  cacheMs: Number(process.env.SP_LAN_CACHE_MS ?? 3000),
  probeTimeoutMs: Number(process.env.SP_LAN_PROBE_TIMEOUT_MS ?? 800),
  probeConcurrency: Number(process.env.SP_LAN_PROBE_CONCURRENCY ?? 16),
  cliTimeoutMs: Number(process.env.SP_LAN_CLI_TIMEOUT_MS ?? 4000),
};

/**
 * Which ports to probe on each peer, in order. `SP_LAN_GAME_PORTS` (comma-separated) wins;
 * otherwise the primary port **plus the game server's own default**.
 *
 * Why the second port: our own server runs on 5150 (an env override), but a **player** who
 * hosts for their friends follows upstream `docs/DEPLOY.md` — which starts the server on its
 * default **3000**. Probing only 5150 made every player-hosted room invisible, i.e. the one
 * case this feature exists for (朋友自己开服、你们直连 → 不经过我们的服务器). The player must not
 * have to know a port number, so the directory looks at both.
 */
export function parsePortList(raw, primary = 5150) {
  const fromEnv = String(raw ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
  return [...new Set(fromEnv.length ? fromEnv : [primary, 3000])];
}

export const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ parsing */

/**
 * Parse the pipe table printed by `easytier-cli peer`.
 *
 * Shape (v2.6.4, header row then a dashed separator):
 *   | ipv4            | hostname | cost  | lat(ms) | loss | rx | tx | tunnel | NAT | version |
 *   | 10.126.126.1/24 | Lain42   | Local | -       | -    | -  | -  | -      | -   | 2.6.4-x |
 *
 * Columns are read positionally because the header names carry units (`lat(ms)`) and
 * have changed between releases; the first three columns have been stable.
 *
 * @param {string} text raw stdout
 * @returns {Array<{ip: string, hostname: string, cost: string, nat: string, version: string}>}
 */
export function parsePeerTable(text) {
  const rows = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 4) continue;
    const ip = cells[0].split('/')[0];
    if (!isIPv4(ip)) continue; // header row and dashed separator land here
    rows.push({ ip, hostname: cells[1] || '', cost: cells[2] || '', nat: cells[8] || '', version: cells[9] || '' });
  }
  return rows;
}

export function isIPv4(s) {
  const parts = String(s).split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

export function ipToInt(ip) {
  return String(ip).split('.').reduce((acc, p) => (acc << 8) + Number(p), 0) >>> 0;
}

/** @param {string} ip @param {string} cidr like `10.126.126.0/24` */
export function inCidr(ip, cidr) {
  const [net, bitsRaw] = String(cidr).split('/');
  if (!isIPv4(ip) || !isIPv4(net)) return false;
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(net) & mask);
}

/* ------------------------------------------------------------------- probing */

/**
 * Shape one peer's /healthz answer into a directory entry. Pure: no I/O, so the
 * rules are unit-testable without a network.
 *
 * @param {{ip: string, hostname: string, cost: string, nat: string, version: string}} peer
 * @param {any} healthz parsed /healthz JSON, or null when unreachable
 * @param {number} port
 * @param {{selfIp?: string, now?: Date}} [ctx]
 */
export function shapeRoom(peer, healthz, port, ctx = {}) {
  const base = {
    virtualIp: peer.ip,
    port,
    hostname: peer.hostname || '',
    self: Boolean(ctx.selfIp && peer.ip === ctx.selfIp),
    link: { cost: peer.cost || '', nat: peer.nat || '' },
    reachable: false,
    app: null,
    version: null,
    uptimeSec: null,
    rooms: null,
    humans: null,
    bots: null,
    spectators: null,
    sockets: null,
    joinable: false,
    checkedAt: (ctx.now ?? new Date()).toISOString(),
  };
  if (!healthz || healthz.ok !== true) return base;
  const rooms = numOrNull(healthz.rooms);
  const humans = numOrNull(healthz.humans);
  const sockets = numOrNull(healthz.sockets);
  return {
    ...base,
    reachable: true,
    app: typeof healthz.app === 'string' ? healthz.app : null,
    version: typeof healthz.build === 'string' ? healthz.build : null,
    uptimeSec: numOrNull(healthz.uptimeSec),
    rooms,
    humans,
    bots: numOrNull(healthz.bots),
    spectators: numOrNull(healthz.spectators),
    sockets,
    // "joinable" here only means "the process answered and has a live socket"; whether
    // a room is actually open is the game's own business (see sp-room-api for that).
    joinable: rooms !== null && sockets !== null && sockets > 0,
  };
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Probe one peer for a Stronghold server, trying each port in order.
 *
 * Returns `{ port, healthz }` for the **first** port that answers with `ok: true`, or `null`.
 * Reporting the port is the whole point: the room the picker shows must be dialled on the
 * port that actually answered, not on a global guess. Never throws — unreachable is the
 * normal case for most peers, and a peer with nothing on 5150 simply falls through to 3000.
 */
export async function probePeer(peer, { ports = CONFIG.gamePorts, timeoutMs = CONFIG.probeTimeoutMs, fetchImpl = fetch } = {}) {
  for (const port of ports) {
    const url = `http://${peer.ip}:${port}/healthz`;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
      if (!res.ok) continue;
      const healthz = await res.json();
      if (healthz && healthz.ok === true) return { port, healthz };
    } catch {
      // nothing listening on this port (or it timed out): try the next one
    }
  }
  return null;
}

/** Run `fn` over `items` with a bounded number of concurrent calls, preserving order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ------------------------------------------------------------------ collection */

/** Read the peer table from easytier-cli. Throws on a non-zero exit. */
export function readPeers({ cli = CONFIG.cli, rpcPortal = CONFIG.rpcPortal, timeoutMs = CONFIG.cliTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cli, ['-p', rpcPortal, 'peer'], { timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(err);
      else resolve(parsePeerTable(stdout));
    });
  });
}

/**
 * Build the whole directory document. Exported so tests can drive it with fakes.
 *
 * `ports` is the list each peer is probed on (see `parsePortList`); `port` is accepted as the
 * legacy single-port form so an older caller keeps working. Each room reports **the port that
 * answered for that peer** — the picker dials `virtualIp:room.port`, so a player-hosted server
 * on 3000 becomes joinable without anyone configuring anything.
 *
 * @param {{peers: any[], selfIp?: string, ports?: number[], port?: number, probe?: Function, now?: Date}} o
 */
export async function buildDirectory({ peers, selfIp = '', ports, port, probe = probePeer, now = new Date(), concurrency = CONFIG.probeConcurrency } = {}) {
  const probePorts = Array.isArray(ports) && ports.length ? ports : Number.isInteger(port) ? [port] : CONFIG.gamePorts;
  const candidates = peers.filter((p) => inCidr(p.ip, CONFIG.cidr));
  const hits = await mapLimit(candidates, concurrency, (p) => probe(p, { ports: probePorts }));
  const rooms = candidates.map((p, i) => shapeRoom(p, hits[i]?.healthz ?? null, hits[i]?.port ?? probePorts[0], { selfIp, now }));
  rooms.sort((a, b) => Number(b.reachable) - Number(a.reachable) || ipToInt(a.virtualIp) - ipToInt(b.virtualIp));
  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    // `port` stays as the primary (the official server's) so a reader that only knows that
    // field still gets a sane answer; `ports` is the full probe list, additive to schema v1.
    network: { cidr: CONFIG.cidr, port: probePorts[0], ports: probePorts, peers: candidates.length, reachable: rooms.filter((r) => r.reachable).length },
    rooms,
  };
}

/* -------------------------------------------------------------------- service */

let cache = { at: 0, doc: null };

export async function collect({ now = new Date() } = {}) {
  if (cache.doc && now.getTime() - cache.at < CONFIG.cacheMs) return cache.doc;
  const peers = await readPeers();
  const selfIp = peers.find((p) => p.cost === 'Local')?.ip ?? '';
  const doc = await buildDirectory({ peers, selfIp, now });
  cache = { at: now.getTime(), doc };
  return doc;
}

function send(res, status, body, extra = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*', // the picker fetches this cross-origin from file:// and app://
    'x-content-type-options': 'nosniff',
    ...extra,
  });
  res.end(text);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const head = req.method === 'HEAD';
    // The picker may send a JSON-ish request from file:// / app://; answer the preflight
    // instead of letting it fail as a 405 (a real trap: fetch then only reports "Failed to fetch").
    if (req.method === 'OPTIONS') return send(res, 204, '', { 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-allow-headers': 'accept, content-type' });
    if (req.method !== 'GET' && !head) return send(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } });
    if (path === '/v1/health') {
      try {
        const peers = await readPeers();
        return send(res, 200, { ok: true, schemaVersion: SCHEMA_VERSION, easytier: 'ok', peers: peers.length });
      } catch (err) {
        return send(res, 503, { ok: false, error: { code: 'EASYTIER_UNAVAILABLE', message: String(err?.message ?? err) } });
      }
    }
    if (path === '/v1/rooms') {
      try {
        const doc = await collect();
        return send(res, 200, head ? { ...doc, rooms: [] } : doc);
      } catch (err) {
        return send(res, 503, { ok: false, error: { code: 'EASYTIER_UNAVAILABLE', message: String(err?.message ?? err) } });
      }
    }
    return send(res, 404, { ok: false, error: { code: 'NOT_FOUND' } });
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const server = createServer();
  server.listen(CONFIG.port, CONFIG.bind, () => {
    console.log(`sp-lan-directory listening on http://${CONFIG.bind}:${CONFIG.port} (cidr ${CONFIG.cidr}, game ports ${CONFIG.gamePorts.join(',')})`);
  });
}
