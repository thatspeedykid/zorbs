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
  constructor(party) { this.party = party; this.players = new Map(); this.official = null; }

  // a browser connected — hand it the current race, the server clock (for sync), and roster
  onConnect(conn) {
    const msg = { type: 'welcome', id: conn.id, serverTime: Date.now(),
      race: currentRace(Date.now()), players: [...this.players.values()] };
    // if a result was just locked for the race currently ending, include it so late arrivals agree
    if (this.official && this.official.slot === currentRace(Date.now()).slot) msg.official = this.official;
    this.send(conn, msg);
  }

  onClose(conn) { if (this.players.delete(conn.id)) this.broadcastPlayers(); }

  onMessage(raw, sender) {
    let m; try { m = JSON.parse(raw); } catch (_) { return; }
    if (m.type === 'join') {
      const name = String(m.name || 'guest').slice(0, 16).replace(/[<>"]/g, '');
      const platform = ['kick','twitch','youtube'].includes(m.platform) ? m.platform : 'guest';
      this.players.set(sender.id, { id: sender.id, name, platform });
      this.broadcastPlayers();
    } else if (m.type === 'boost') {
      // stamp a shared apply-time ~220ms out so every client applies it at the SAME synced
      // moment (keeps their sims + leaderboards identical instead of drifting on net latency).
      this.party.broadcast(JSON.stringify({ type: 'boost', name: String(m.name || '').slice(0, 16), at: Date.now() + 220 }));
    } else if (m.type === 'result') {
      // FIRST result reported for a given race slot becomes the OFFICIAL outcome for everyone.
      const slot = m.slot | 0;
      if (!this.official || this.official.slot !== slot) {
        const order = Array.isArray(m.order) ? m.order.slice(0, 32).map(s => String(s).slice(0, 16)) : [];
        this.official = { type: 'official', slot, order, finished: Math.max(0, Math.min(order.length, m.finished | 0)) };
        this.party.broadcast(JSON.stringify(this.official));
      }
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
