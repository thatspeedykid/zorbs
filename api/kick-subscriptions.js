// Lists the Kick event subscriptions for the given access token,
// so the dashboard can verify chat webhooks are actually registered.
const KICK_CLIENT_ID = '01KTMSSQ3PNEAA8EYYX1T6T4CK';

export default async function handler(req, res) {
  const auth = req.headers['x-kick-token'] || req.query.token;
  if (!auth) return res.status(400).json({ error: 'missing token' });
  try {
    const r = await fetch('https://api.kick.com/public/v1/events/subscriptions', {
      headers: { 'Authorization': `Bearer ${auth}`, 'Client-Id': KICK_CLIENT_ID },
    });
    const data = await r.json();
    res.json({ ok: r.ok, status: r.status, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
