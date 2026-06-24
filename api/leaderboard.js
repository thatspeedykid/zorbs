// PERSISTENT GLOBAL LEADERBOARD — backed by Vercel KV / Upstash Redis (REST API).
//
//   POST /api/leaderboard   body { kickId, username, place }   -> record one race result
//   GET  /api/leaderboard                                      -> global top players
//   GET  /api/leaderboard?user=<kickId>                        -> top players + that user's record
//   GET  /api/leaderboard?status=1                             -> { configured: true|false }
//
// Works with any Upstash/KV integration regardless of the env-var PREFIX Vercel assigns:
// it first checks the common names, then auto-discovers the Upstash REST URL + token from
// the environment. No-ops gracefully (configured:false) until a DB is connected, so the
// game and dashboard never break.

function kvEnv() {
  let url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
    || process.env.STORAGE_REDIS_REST_URL || process.env.STORAGE_KV_REST_API_URL
    || process.env.REDIS_REST_URL;
  let token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
    || process.env.STORAGE_REDIS_REST_TOKEN || process.env.STORAGE_KV_REST_API_TOKEN
    || process.env.REDIS_REST_TOKEN;
  // Auto-discover: any *_URL that is an https upstash REST endpoint, plus a long *_TOKEN.
  if (!url || !token) {
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v !== 'string') continue;
      if (!url && /URL$/i.test(k) && v.startsWith('https://') && v.includes('upstash.io')) url = v;
      if (!token && /TOKEN$/i.test(k) && v.length > 24 && !/\s/.test(v)) token = v;
    }
  }
  return { url, token };
}

async function redis(cmd) {
  const { url, token } = kvEnv();
  if (!url || !token) return null;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j ? j.result : null;
}

async function pipeline(cmds) {
  const { url, token } = kvEnv();
  if (!url || !token || !cmds.length) return [];
  const r = await fetch(url + '/pipeline', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) return [];
  const j = await r.json().catch(() => []);
  return Array.isArray(j) ? j.map((x) => (x ? x.result : null)) : [];
}

const clean = (s) => String(s == null ? '' : s).slice(0, 40).replace(/[<>\r\n]/g, '');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  const { url, token } = kvEnv();
  const configured = !!(url && token);

  if (req.query && req.query.status) {
    return res.status(200).json({ ok: true, configured });
  }

  // BALL SKIN lookup by Kick username (used by the chat !play webhook so a chatter's ball
  // shows the skin they chose on the dashboard). Returns null gracefully if no DB / no skin.
  const skinUser = clean(req.query && req.query.skin).toLowerCase();
  if (skinUser) {
    if (!configured) return res.status(200).json({ ok: true, skin: null });
    try {
      const s = await redis(['GET', 'zskin:' + skinUser]);
      return res.status(200).json({ ok: true, skin: s || null });
    } catch (e) {
      return res.status(200).json({ ok: true, skin: null });
    }
  }

  if (!configured) {
    return res.status(200).json({ ok: false, configured: false, leaderboard: [], you: null });
  }

  try {
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
      body = body || {};
      const kickId = clean(body.kickId);
      const username = clean(body.username);
      const place = parseInt(body.place, 10); // 1 = win, 0 = DNF

      // SKIN SAVE (no race recorded): { username, skin } [, kickId]. Keyed by username so the
      // chat !play webhook (which only knows the username) can look it up.
      if (body.skin !== undefined && body.place === undefined) {
        const uname = username.toLowerCase();
        if (!uname) return res.status(400).json({ ok: false, error: 'missing user' });
        const skin = clean(body.skin).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 16);
        const cmds = [['SET', 'zskin:' + uname, skin]];
        if (kickId) {
          const raw = await redis(['GET', 'zuser:' + kickId]);
          let u = {}; if (raw) { try { u = JSON.parse(raw); } catch (_) { u = {}; } }
          u.skin = skin; u.username = username; u.kickId = kickId; u.updated = Date.now();
          cmds.push(['SET', 'zuser:' + kickId, JSON.stringify(u)]);
        }
        await pipeline(cmds);
        return res.status(200).json({ ok: true, skin });
      }

      if (!kickId || !username) return res.status(400).json({ ok: false, error: 'missing user' });

      const key = 'zuser:' + kickId;
      const raw = await redis(['GET', key]);
      let u = {};
      if (raw) { try { u = JSON.parse(raw); } catch (_) { u = {}; } }

      u.kickId = kickId;
      u.username = username;
      u.races = (u.races || 0) + 1;
      if (place === 1) u.wins = (u.wins || 0) + 1;
      if (place >= 1 && place <= 3) u.podiums = (u.podiums || 0) + 1;
      if (place >= 1 && (!u.best || place < u.best)) u.best = place;
      // BETA TESTERS: everyone who plays before v1.0 is flagged + timestamped, so they qualify
      // for the founder/beta custom ball. Flip BETA_OPEN to false at v1.0 launch to close it.
      const BETA_OPEN = true;
      if (BETA_OPEN && !u.betaSince) { u.beta = true; u.betaSince = Date.now(); }
      u.updated = Date.now();

      await pipeline([
        ['SET', key, JSON.stringify(u)],
        ['ZADD', 'zlb', String(u.wins || 0), kickId],
        ['LPUSH', 'zhist:' + kickId, JSON.stringify({ place: (place >= 1 ? place : 0), ts: Date.now() })],
        ['LTRIM', 'zhist:' + kickId, '0', '49'],
      ]);
      return res.status(200).json({ ok: true, you: u });
    }

    // race history for one user (MY RACES table)
    const histId = clean(req.query && req.query.history);
    if (histId) {
      const rows = (await redis(['LRANGE', 'zhist:' + histId, '0', '49'])) || [];
      const history = rows.map((r) => { try { return JSON.parse(r); } catch (_) { return null; } }).filter(Boolean);
      return res.status(200).json({ ok: true, history });
    }

    const top = (await redis(['ZREVRANGE', 'zlb', '0', '24', 'WITHSCORES'])) || [];
    const ids = [];
    for (let i = 0; i < top.length; i += 2) ids.push(top[i]);

    let leaderboard = [];
    if (ids.length) {
      const rows = await pipeline(ids.map((id) => ['GET', 'zuser:' + id]));
      leaderboard = rows.map((raw, i) => {
        let u = {};
        if (raw) { try { u = JSON.parse(raw); } catch (_) {} }
        return {
          kickId: ids[i],
          username: u.username || ids[i],
          wins: u.wins || 0,
          races: u.races || 0,
          podiums: u.podiums || 0,
          best: u.best || null,
          beta: !!u.beta,
        };
      });
    }

    let you = null;
    const askId = clean(req.query && req.query.user);
    if (askId) {
      const raw = await redis(['GET', 'zuser:' + askId]);
      if (raw) { try { you = JSON.parse(raw); } catch (_) {} }
    }

    return res.status(200).json({ ok: true, configured: true, leaderboard, you });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e), leaderboard: [], you: null });
  }
}
