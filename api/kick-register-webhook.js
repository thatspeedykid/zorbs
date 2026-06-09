const KICK_CLIENT_ID = '01KTMSSQ3PNEAA8EYYX1T6T4CK';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  
  const { accessToken, broadcasterUserId } = req.body;
  if (!accessToken || !broadcasterUserId) {
    return res.status(400).json({ error: 'Missing accessToken or broadcasterUserId' });
  }

  try {
    // Subscribe to chat.message.sent webhook
    const resp = await fetch('https://api.kick.com/public/v1/events/subscriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Client-Id': KICK_CLIENT_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        events: [
          { name: 'chat.message.sent', version: 1 },
          { name: 'channel.subscription.new', version: 1 },
          { name: 'channel.subscription.renewal', version: 1 },
        ],
        method: 'webhook',
        broadcaster_user_id: parseInt(broadcasterUserId),
      }),
    });

    const data = await resp.json();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
