import { createHash, timingSafeEqual } from 'node:crypto';
import { roomsSnapshot, API_VERSION } from './snapshot.mjs';

const JSON_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
});

function reply(req, res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { ...JSON_HEADERS, 'Content-Length': Buffer.byteLength(body) });
  res.end(req.method === 'HEAD' ? undefined : body);
}
function authenticated(header, token) {
  if (!token || typeof header !== 'string') return false;
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(header);
  if (!match) return false;
  const received = createHash('sha256').update(match[1]).digest();
  const expected = createHash('sha256').update(token).digest();
  return timingSafeEqual(received, expected);
}
function integerParam(raw, fallback, max) {
  if (raw === null) return fallback;
  if (!/^(0|[1-9][0-9]{0,4})$/.test(raw)) return null;
  const n = Number(raw);
  return n <= max ? n : null;
}

/**
 * A pure HTTP adapter. The only dependency is a live Lobby instance, captured
 * by the preload from the *existing* healthz stats method.
 * No WebSocket user joins, no API writes, and no private match data.
 */
export function createRoomApiHandler({ getLobby, token, maxRequestsPerMinute = 120, now = Date.now }) {
  const callers = new Map();
  return function handle(req, res) {
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD');
      return reply(req, res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } });
    }
    if (!authenticated(req.headers.authorization, token)) {
      return reply(req, res, 401, { ok: false, error: { code: 'UNAUTHORIZED' } });
    }
    const ip = req.socket?.remoteAddress ?? 'unknown';
    const t = now();
    const bucket = callers.get(ip);
    const count = bucket && t - bucket.at < 60_000 ? bucket.count + 1 : 1;
    callers.set(ip, { at: bucket && t - bucket.at < 60_000 ? bucket.at : t, count });
    if (callers.size > 4096) callers.clear();
    if (count > maxRequestsPerMinute) return reply(req, res, 429, { ok: false, error: { code: 'RATE_LIMITED' } });
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { return reply(req, res, 400, { ok: false, error: { code: 'BAD_QUERY' } }); }
    if (url.pathname !== '/v1/rooms' && !/^\/v1\/rooms\/[A-HJ-NP-Z]{4}$/.test(url.pathname)) {
      return reply(req, res, 404, { ok: false, error: { code: 'NOT_FOUND' } });
    }
    const mode = url.searchParams.get('mode') ?? 'coop';
    if (!['coop', 'solo', 'all'].includes(mode) || [...url.searchParams.keys()].some(x => !['mode', 'joinable', 'limit', 'offset'].includes(x))) {
      return reply(req, res, 400, { ok: false, error: { code: 'BAD_QUERY' } });
    }
    const joinable = url.searchParams.get('joinable');
    if (joinable !== null && !['0', '1'].includes(joinable)) {
      return reply(req, res, 400, { ok: false, error: { code: 'BAD_QUERY' } });
    }
    const limit = integerParam(url.searchParams.get('limit'), 50, 100);
    const offset = integerParam(url.searchParams.get('offset'), 0, 10000);
    if (limit === null || offset === null || limit === 0) return reply(req, res, 400, { ok: false, error: { code: 'BAD_QUERY' } });
    let rooms;
    try { rooms = roomsSnapshot(getLobby(), { mode, joinableOnly: joinable === '1' }); }
    catch { return reply(req, res, 503, { ok: false, error: { code: 'LOBBY_UNAVAILABLE' } }); }
    const timestamp = new Date(now()).toISOString();
    const code = url.pathname.slice('/v1/rooms/'.length);
    if (url.pathname !== '/v1/rooms') {
      const found = rooms.find(r => r.code === code);
      return reply(req, res, found ? 200 : 404, found
        ? { ok: true, schemaVersion: API_VERSION, generatedAt: timestamp, room: found }
        : { ok: false, error: { code: 'ROOM_NOT_FOUND' } });
    }
    return reply(req, res, 200, {
      ok: true, schemaVersion: API_VERSION, generatedAt: timestamp,
      total: rooms.length, offset, limit, rooms: rooms.slice(offset, offset + limit),
    });
  };
}
