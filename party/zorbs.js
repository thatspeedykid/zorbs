// ZORBS authoritative race room (PartyKit).
//
// Server-authoritative the simple, robust way: the room owns (1) a race SCHEDULE and (2) the
// live PLAYER ROSTER, broadcasting both so every browser is locked to the SAME race + players.
// Each race is fully deterministic from its seed, so all clients run the identical sim from the
// shared seed, time-synced by the server clock — each just highlights its own marble.
//
// PRIVATE STREAMER LOBBIES (room id != "public") additionally support a CONTROL channel: the
// room owner (their dashboard, authed as the room name) can toggle autoplay, start/reset races,
// run custom-name races, set the join mode, and drive the OBS view (camera / music). The public
// room ignores all of this and just runs the open auto-loop.

const SLOT_MS = 95000;   // a new race every 95 seconds (auto-loop)
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
  constructor(party) {
    this.party = party;
    this.players = new Map();
    this.chatPlayers = new Map();   // chatters who typed !play (no browser) — keyed by lowercased name
    this.official = null;
    // private-lobby control state (defaults: autoplay OFF, everyone may join)
    this.control = { autoplay: false, joinMode: 'all' };
    this.directed = null;          // an owner-started race { id, seed, startTime, roster }
    this.owners = new Set();        // connection ids that authed as this room's owner
    this._dn = 0;                   // directed-race counter (unique id per start)
  }
  get isPublic() { return this.party.id === 'public'; }

  // the full roster broadcast to clients = browser players + chat (!play) players, de-duped by name
  rosterList() {
    const browser = [...this.players.values()];
    const seen = new Set(browser.map(p => String(p.name).toLowerCase()));
    const chat = [];
    for (const c of this.chatPlayers.values()) {
      if (seen.has(c.name.toLowerCase())) continue;
      chat.push({ id: 'chat:' + c.name, name: c.name, platform: 'kick', founder: false, isSub: !!c.isSub });
    }
    return browser.concat(chat);
  }

  onConnect(conn) {
    const msg = { type: 'welcome', id: conn.id, serverTime: Date.now(),
      race: currentRace(Date.now()), players: this.rosterList(),
      control: this.control,
      directed: (this.directed && this.directed.startTime + 8000 > Date.now()) ? this.directed : null };
    if (this.official && this.official.slot === currentRace(Date.now()).slot) msg.official = this.official;
    this.send(conn, msg);
  }

  onClose(conn) {
    this.owners.delete(conn.id);
    if (this.players.delete(conn.id)) this.broadcastPlayers();
  }

  onMessage(raw, sender) {
    let m; try { m = JSON.parse(raw); } catch (_) { return; }

    if (m.type === 'join') {
      const name = String(m.name || 'guest').slice(0, 16).replace(/[<>"]/g, '');
      const platform = ['kick','twitch','youtube','tiktok'].includes(m.platform) ? m.platform : 'guest';
      // join-mode gate (private rooms only): subs/followers modes require a signed-in account.
      // NOTE: real sub/follower verification needs the Kick API — for now this blocks guests.
      if (!this.isPublic && this.control.joinMode !== 'all' && platform !== 'kick') {
        this.send(sender, { type: 'denied', reason: this.control.joinMode });
        return;
      }
      const prev = this.players.get(sender.id);
      const founder = !!m.founder || !!(prev && prev.founder);
      this.players.set(sender.id, { id: sender.id, name, platform, founder });
      this.broadcastPlayers();

    } else if (m.type === 'boost') {
      this.party.broadcast(JSON.stringify({ type: 'boost', name: String(m.name || '').slice(0, 16), at: Date.now() + 220 }));

    } else if (m.type === 'result') {
      const slot = m.slot | 0;
      if (!this.official || this.official.slot !== slot) {
        const order = Array.isArray(m.order) ? m.order.slice(0, 32).map(s => String(s).slice(0, 16)) : [];
        this.official = { type: 'official', slot, order, finished: Math.max(0, Math.min(order.length, m.finished | 0)) };
        this.party.broadcast(JSON.stringify(this.official));
      }

    } else if (m.type === 'control-hello') {
      // dashboard claims ownership of this room. Pragmatic gate: the claimed name must equal the
      // room id (rooms are named after the streamer). TODO: verify the Kick token server-side.
      if (!this.isPublic && String(m.as || '').toLowerCase() === this.party.id) {
        this.owners.add(sender.id);
        this.send(sender, { type: 'controlState', autoplay: this.control.autoplay, joinMode: this.control.joinMode, owner: true });
      } else {
        this.send(sender, { type: 'controlState', autoplay: this.control.autoplay, joinMode: this.control.joinMode, owner: false });
      }

    } else if (m.type === 'control') {
      if (!this.owners.has(sender.id)) return;   // only the room owner may drive controls
      const a = m.action;
      if (a === 'set') {
        if (typeof m.autoplay === 'boolean') this.control.autoplay = m.autoplay;
        if (['all','subs','followers'].includes(m.joinMode)) this.control.joinMode = m.joinMode;
        this.broadcastControl();
      } else if (a === 'start') {
        this._dn++;
        const roster = Array.isArray(m.roster) ? m.roster.slice(0, 20).map(s => String(s).slice(0, 16)).filter(Boolean) : null;
        const countdown = Math.max(2, Math.min(20, (m.countdown | 0) || 6));
        this.directed = {
          id: this._dn,
          seed: (m.seed >>> 0) || seedForSlot(Date.now() + this._dn),
          startTime: Date.now() + countdown * 1000,
          roster: (roster && roster.length) ? roster : null,
        };
        this.party.broadcast(JSON.stringify({ type: 'directed', ...this.directed }));
      } else if (a === 'reset') {
        this.directed = null;
        this.party.broadcast(JSON.stringify({ type: 'reset' }));
      } else if (a === 'clearchat') {
        this.chatPlayers.clear();
        this.broadcastPlayers();
      } else if (a === 'view') {
        // camera / music for the OBS overlay — clients filter this to the OBS view only
        this.party.broadcast(JSON.stringify({ type: 'view', camera: m.camera, idx: m.idx | 0, muted: !!m.muted, has_muted: typeof m.muted === 'boolean' }));
      }

    } else if (m.type === 'ping') {
      this.send(sender, { type: 'pong', serverTime: Date.now(), race: currentRace(Date.now()) });
    }
  }

  broadcastControl() {
    this.party.broadcast(JSON.stringify({ type: 'controlState', autoplay: this.control.autoplay, joinMode: this.control.joinMode }));
  }
  broadcastPlayers() {
    this.party.broadcast(JSON.stringify({ type: 'players', players: this.rosterList() }));
  }
  send(conn, obj) { conn.send(JSON.stringify(obj)); }

  async onRequest(req) {
    // POST = chat injection from the Kick webhook (!play / !boost). GET = status page.
    if (req.method === 'POST') {
      let b = {}; try { b = await req.json(); } catch (_) {}
      const secret = (this.party.env && this.party.env.ZORBS_INJECT_SECRET) || '';
      if (secret && b.secret !== secret) {
        return new Response(JSON.stringify({ ok: false, error: 'bad secret' }), { status: 403, headers: { 'content-type': 'application/json' } });
      }
      const name = String(b.name || '').slice(0, 16).replace(/[<>"]/g, '').trim();
      if (!name) return new Response(JSON.stringify({ ok: false, error: 'no name' }), { headers: { 'content-type': 'application/json' } });

      if (b.cmd === 'play') {
        // join-mode gate: subs-only ignores non-subs. (followers = best-effort: any chatter, until
        // real follower lookup via the Kick API lands.)
        if (this.control.joinMode === 'subs' && !b.isSub) {
          return new Response(JSON.stringify({ ok: true, skipped: 'not-sub' }), { headers: { 'content-type': 'application/json' } });
        }
        if (this.chatPlayers.size < 60) this.chatPlayers.set(name.toLowerCase(), { name, isSub: !!b.isSub });
        this.broadcastPlayers();
        return new Response(JSON.stringify({ ok: true, joined: name, count: this.chatPlayers.size }), { headers: { 'content-type': 'application/json' } });
      } else if (b.cmd === 'boost') {
        this.party.broadcast(JSON.stringify({ type: 'boost', name, at: Date.now() + 220 }));
        return new Response(JSON.stringify({ ok: true, boosted: name }), { headers: { 'content-type': 'application/json' } });
      } else if (b.cmd === 'clear') {
        this.chatPlayers.clear(); this.broadcastPlayers();
        return new Response(JSON.stringify({ ok: true, cleared: true }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    }

    const r = currentRace(Date.now());
    return new Response(JSON.stringify({
      ok: true, room: this.party.id, players: this.rosterList().length, chat: this.chatPlayers.size,
      control: this.control, currentRace: r, serverTime: Date.now(),
      secondsToStart: Math.max(0, Math.round((r.startTime - Date.now()) / 1000)),
    }, null, 2), { headers: { 'content-type': 'application/json' } });
  }
}
