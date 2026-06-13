const KICK_CLIENT_ID = process.env.KICK_CLIENT_ID || '01KTMSSQ3PNEAA8EYYX1T6T4CK';
const KICK_SECRET = process.env.KICK_CLIENT_SECRET || 'c4daf86f9492d0ac466af921c8846e5ed00b6bea0dc4fcda78607db5c0f93ad8';
const REDIRECT_URI = 'https://www.playzorbs.xyz/auth/kick/game-callback';
const ADMIN_USERNAMES = ['marsscumbags'];

export default async function handler(req, res) {
  const { code, verifier } = req.query;
  if (!code) return res.status(400).json({ error: 'No code' });

  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: KICK_CLIENT_ID,
      client_secret: KICK_SECRET,
      redirect_uri: REDIRECT_URI,
      code,
    });
    if (verifier) body.append('code_verifier', verifier);

    const tokenRes = await fetch('https://id.kick.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const token = await tokenRes.json();
    if (!token.access_token) return res.json({ error: 'Token failed: ' + JSON.stringify(token) });

    const userRes = await fetch('https://api.kick.com/public/v1/users', {
      headers: { 'Authorization': `Bearer ${token.access_token}`, 'Client-Id': KICK_CLIENT_ID },
    });
    const userData = await userRes.json();
    const user = userData.data?.[0] || userData;
    const username = (user.username || user.name || 'KickUser').toLowerCase();
    const role = ADMIN_USERNAMES.includes(username) ? 'admin' : 'user';
    // return the SAME session shape the dashboard uses → one login works site-wide
    const session = { username, role, kickId: user.user_id || '', accessToken: token.access_token, ts: Date.now() };
    res.json({ session, username, isSub: false });
  } catch (e) {
    res.json({ error: e.message });
  }
}
