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
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cmd: message === '!play' ? 'play' : 'boost',
            name: username, isSub, secret: INJECT_SECRET,
          }),
        });
      }
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(200).json({ ok: true, err: e.message });
  }
}
