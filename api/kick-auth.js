import crypto from 'crypto';

const KICK_CLIENT_ID = process.env.KICK_CLIENT_ID || '01KTMSSQ3PNEAA8EYYX1T6T4CK';
const KICK_SECRET = process.env.KICK_CLIENT_SECRET || 'c4daf86f9492d0ac466af921c8846e5ed00b6bea0dc4fcda78607db5c0f93ad8';
const REDIRECT_URI = 'https://www.playzorbs.xyz/auth/kick/callback';
// Admins. Override/extend via ZORBS_ADMIN_USERNAMES (comma-separated) — must match api/maps.js.
const ADMIN_USERNAMES = (process.env.ZORBS_ADMIN_USERNAMES || 'marsscumbags')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Sign the session so api/maps.js can trust the role field without a live Kick call.
// Must use the SAME secret + field order as isAdminSession() in api/maps.js.
const SIGN_SECRET = process.env.ZORBS_SESSION_SECRET || KICK_SECRET;
function signSession(o) {
  return crypto.createHmac('sha256', SIGN_SECRET)
    .update(`${o.username}|${o.role}|${o.kickId}|${o.ts}`).digest('hex');
}

export default async function handler(req, res) {
  const { code, state, error, verifier } = req.query;
  if (error) return res.redirect(`/dashboard.html?error=${encodeURIComponent(error)}`);
  if (!code) return res.status(400).json({ error: 'No code provided' });

  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: KICK_CLIENT_ID,
      client_secret: KICK_SECRET,
      redirect_uri: REDIRECT_URI,
      code,
    });
    // Include code_verifier if provided (PKCE)
    if (verifier) body.append('code_verifier', verifier);

    const tokenRes = await fetch('https://id.kick.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const tokenText = await tokenRes.text();
    let tokenData = {};
    try { tokenData = JSON.parse(tokenText); } catch(e) {
      throw new Error('Kick token exchange failed (' + tokenRes.status + '): ' + tokenText.slice(0,120));
    }
    if (!tokenData.access_token) throw new Error('No token: ' + JSON.stringify(tokenData));

    const userRes = await fetch('https://api.kick.com/public/v1/users', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'Client-Id': KICK_CLIENT_ID },
    });
    const userText = await userRes.text();
    let userData = {};
    try { userData = JSON.parse(userText); } catch(e) {
      throw new Error('Kick user lookup failed (' + userRes.status + '): ' + userText.slice(0,120));
    }
    const user = userData.data?.[0] || userData;
    const username = (user.username || user.name || 'unknown').toLowerCase();
    const role = ADMIN_USERNAMES.includes(username) ? 'admin' : 'user';

    const sessObj = {
      username, role, kickId: user.user_id || '',
      accessToken: tokenData.access_token, ts: Date.now(),
    };
    sessObj.sig = signSession(sessObj);   // tamper-evident signature over username|role|kickId|ts
    const session = Buffer.from(JSON.stringify(sessObj)).toString('base64');

    res.redirect(`/dashboard.html?session=${encodeURIComponent(session)}&username=${encodeURIComponent(username)}&role=${role}`);
  } catch (err) {
    res.redirect(`/dashboard.html?error=${encodeURIComponent(err.message)}`);
  }
}
