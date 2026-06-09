// Kick posts chat events here. We forward !play/!boost straight into the
// streamer's Ably channel (zorbs:ch:<broadcaster>) - no queue, no polling.
const ABLY_KEY = process.env.ABLY_API_KEY || 'CtKemg.EbPCaQ:UkXWMenOtctecuS8DixPP3O6UimGDwW2UBlxk4gRoi0';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, note: 'POST only' });

  try {
    const body = req.body || {};
    const eventType = req.headers['kick-event-type'] || body?.type || body?.event || '';

    if (String(eventType).includes('chat.message')) {
      const data = body?.data || body;
      const username = data?.sender?.username || data?.chatter?.username || data?.user?.username || '';
      const broadcaster = (data?.broadcaster?.username || data?.broadcaster?.slug || '').toLowerCase();
      const message = (data?.content || data?.message || '').trim().toLowerCase();
      const isSub = !!(data?.sender?.identity?.badges?.some(b =>
        b.type === 'subscriber' || b.type === 'sub'));

      if (username && broadcaster && (message === '!play' || message === '!boost')) {
        const channel = 'zorbs:ch:' + broadcaster;
        const url = 'https://rest.ably.io/channels/' + encodeURIComponent(channel) + '/messages';
        await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + Buffer.from(ABLY_KEY).toString('base64'),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'kick', data: { name: username, cmd: message, isSub } }),
        });
      }
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(200).json({ ok: true, err: e.message });
  }
}
