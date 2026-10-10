// Stronghold Protocol external room API: conservative v1 snapshot.
// No mutations, no synthetic sessions, and no access to private match payloads.
export const API_VERSION = 1;
const CODE_RE = /^[A-HJ-NP-Z]{4}$/;

const safeName = (value) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 32)
  : '';

export function roomsSnapshot(lobby, { mode = 'coop', joinableOnly = false } = {}) {
  if (!(lobby?.rooms instanceof Map)) throw new Error('LOBBY_UNAVAILABLE');
  const entries = [];
  for (const [key, room] of lobby.rooms) {
    try {
      if (!room || room.disposed || room.match || room.matchCtx?.live) continue;
      const state = typeof room.toState === 'function' ? room.toState() : room;
      const code = String(state?.code ?? key).toUpperCase();
      if (!CODE_RE.test(code) || !['solo', 'coop'].includes(state?.mode)) continue;
      if (mode !== 'all' && state.mode !== mode) continue;
      const seats = Array.isArray(state.seats) ? state.seats : [];
      const capacity = state.mode === 'solo' ? 1 : 4;
      const players = seats.slice(0, capacity).flatMap((s, i) => {
        if (!s || s.left) return [];
        return [{
          seat: Number.isInteger(s.seat) ? s.seat : i,
          name: safeName(s.name),
          isBot: !!s.isBot,
          ready: !!s.ready,
          connected: !!s.connected,
          isHost: s.playerId != null && s.playerId === state.hostId,
        }];
      });
      const joinable = state.mode === 'coop' && players.length < capacity;
      if (joinableOnly && !joinable) continue;
      const difficulty = String(state.difficulty ?? '').slice(0, 32);
      entries.push({
        code, mode: state.mode, difficulty,
        status: 'waiting', capacity, occupancy: players.length,
        humans: players.filter(x => !x.isBot).length,
        bots: players.filter(x => x.isBot).length,
        joinable, players,
        strategy: { aiPicksLast: !!state.aiPicksLast },
        createdAt: Number.isFinite(room.createdAt) && room.createdAt > 0
          ? new Date(room.createdAt).toISOString() : null,
      });
    } catch {
      // One incompatible room must not interrupt snapshots of the others.
    }
  }
  entries.sort((a, b) => a.code.localeCompare(b.code));
  return entries;
}
