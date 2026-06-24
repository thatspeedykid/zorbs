// Kick posts chat events here. We forward !play / !boost straight into the streamer's LIVE
// ZORBS race room (PartyKit), which spawns the chatter as a ball and applies their boost.
// (Previously this published to Ably, but nothing consumed it — the room is the right target.)
const PARTY_BASE = 'https://zorbs.thatspeedykid.partykit.dev/parties/main/';
const INJECT_SECRET = process.env.ZORBS_INJECT_SECRET || '';   // optional; locks down the inject endpoint

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, note: 'POST only' });

  try {
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const eventType = req.headers['kick-event-type'] || body?.type || body?.event || '';

    if (String(eventType).includes('chat.message')) {
      const data = body?.data || body;
      const username = data?.sender?.username || data?.chatter?.username || data?.user?.username || '';
      const broadcaster = (data?.broadcaster?.username || data?.broadcaster?.slug || data?.broadcaster?.channel_slug || '').toLowerCase();
      const message = (data?.content || data?.message || '').trim().toLowerCase();
      const badges = data?.sender?.identity?.badges || [];
      const isSub = !!badges.some(b => ['subscriber', 'sub', 'founder', 'og'].includes(b && b.type));

      if (username && broadcaster && (message === '!play' || message === '!boost')) {
        const room = broadcaster.replace(/[^a-z0-9_-]/g, '').slice(0, 32);
        const url = PARTY_BASE + encodeURIComponent(room);
        // On !play, pull the chatter's saved ball skin (chosen on the main dashboard) so their
        // custom ball shows up in the streamer's race. Best-effort — null if none / no DB.
        let skin = null;
        if (message === '!play') {
          try {
            const host = req.headers['x-forwarded-host'] || req.headers.host;
            const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
            const r = await fetch(`${proto}://${host}/api/leaderboard?skin=${encodeURIComponent(username)}`);
            if (r.ok) { const j = await r.json().catch(() => null); skin = (j && j.skin) || null; }
          } catch (_) {}
        }
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cmd: message === '!play' ? 'play' : 'boost',
            name: username, isSub, skin, secret: INJECT_SECRET,
          }),
        });
      }
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(200).json({ ok: true, err: e.message });
  }
}
