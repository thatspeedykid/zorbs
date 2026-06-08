// Vercel serverless function - handles Kick OAuth callback
// GET /api/kick-auth?code=xxx

const KICK_CLIENT_ID = '01KTMSSQ3PNEAA8EYYX1T6T4CK';
const KICK_SECRET = 'c4daf86f9492d0ac466af921c8846e5ed00b6bea0dc4fcda78607db5c0f93ad8';
const REDIRECT_URI = 'https://playzorbs.xyz/auth/kick/callback';

// Admin kick usernames - add yours here
const ADMIN_USERNAMES = ['marsscumbags'];

export default async function handler(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`/dashboard.html?error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return res.status(400).json({ error: 'No code provided' });
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://id.kick.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: KICK_CLIENT_ID,
        client_secret: KICK_SECRET,
        redirect_uri: REDIRECT_URI,
        code,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      throw new Error('No access token: ' + JSON.stringify(tokenData));
    }

    // Get user info from Kick
    const userRes = await fetch('https://api.kick.com/public/v1/users', {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Client-Id': KICK_CLIENT_ID,
      },
    });

    const userData = await userRes.json();
    const user = userData.data?.[0] || userData;

    const username = user.username || user.name || 'unknown';
    const kickId = user.user_id || user.id || '';
    const isAdmin = ADMIN_USERNAMES.includes(username.toLowerCase());
    // Anyone can be a "streamer" - they connect the bot to their channel
    // Role is determined by: admin list = admin, everyone else = user (streamer/chatter same thing)
    const role = isAdmin ? 'admin' : 'user';

    // Build session token (simple base64 for now - use JWT in prod)
    const session = Buffer.from(JSON.stringify({
      username,
      kickId,
      role,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      ts: Date.now(),
    })).toString('base64');

    // Redirect to dashboard with session
    res.redirect(`/dashboard.html?session=${encodeURIComponent(session)}&username=${encodeURIComponent(username)}&role=${role}`);

  } catch (err) {
    console.error('Kick auth error:', err);
    res.redirect(`/dashboard.html?error=${encodeURIComponent('Auth failed: ' + err.message)}`);
  }
}
