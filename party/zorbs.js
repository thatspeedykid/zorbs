// ZORBS authoritative race room (PartyKit).
//
// Server-authoritative the simple, robust way: the room owns (1) a fixed race SCHEDULE — a
// fresh race every slot — and (2) the live PLAYER ROSTER. It broadcasts both to every
// connected browser, so everyone is locked to the SAME race + the SAME players. Because each
// race is fully deterministic from its seed, every client runs the identical sim from the
// shared seed, time-synced by the server clock — each just highlights its own marble.
//
// (If we ever see physics drift across machines, we upgrade this room to stream authoritative
// positions instead of the seed. For now, shared-seed + shared-clock is the milestone.)

const SLOT_MS = 95000;   // a new race every 95 seconds
const LOBBY_MS = 9000;   // join / countdown window before the gates open

function seedForSlot(slot) {
  let h = (slot ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
function currentRace(now) {
  const slot = Math.floor(now / SLOT_MS);
  return { slot, raceId: 'slot-' + slot, seed: seedForSlot(slot), startTime: slot * SLOT_MS + LOBBY_MS };
}

export default class ZorbsRoom {
  constructor(party) { this.party = party; this.players = new Map(); }

  // a browser connected — hand it the current race, the server clock (for sync), and roster
  onConnect(conn) {
    this.send(conn, { type: 'welcome', id: conn.id, serverTime: Date.now(),
      race: currentRace(Date.now()), players: [...this.players.values()] });
  }

  onClose(conn) { if (this.players.delete(conn.id)) this.broadcastPlayers(); }

  onMessage(raw, sender) {
    let m; try { m = JSON.parse(raw); } catch (_) { return; }
    if (m.type === 'join') {
      const name = String(m.name || 'guest').slice(0, 16).replace(/[<>"]/g, '');
      this.players.set(sender.id, { id: sender.id, name });
      this.broadcastPlayers();
    } else if (m.type === 'boost') {
      this.party.broadcast(JSON.stringify({ type: 'boost', name: String(m.name || '').slice(0, 16) }));
    } else if (m.type === 'ping') {
      this.send(sender, { type: 'pong', serverTime: Date.now(), race: currentRace(Date.now()) });
    }
  }

  broadcastPlayers() {
    this.party.broadcast(JSON.stringify({ type: 'players', players: [...this.players.values()] }));
  }
  send(conn, obj) { conn.send(JSON.stringify(obj)); }

  // Open the room URL in a browser to confirm it's live (returns JSON status).
  onRequest() {
    const r = currentRace(Date.now());
    return new Response(JSON.stringify({
      ok: true, room: this.party.id, players: this.players.size,
      currentRace: r, serverTime: Date.now(),
      secondsToStart: Math.max(0, Math.round((r.startTime - Date.now()) / 1000)),
    }, null, 2), { headers: { 'content-type': 'application/json' } });
  }
}
