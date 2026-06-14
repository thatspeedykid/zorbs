// PERSISTENT GLOBAL LEADERBOARD — backed by Vercel KV (Upstash Redis REST API).
//
//   POST /api/leaderboard   body { kickId, username, place }   -> record one race result
//   GET  /api/leaderboard                                      -> global top players
//   GET  /api/leaderboard?user=<kickId>                        -> top players + that user's record
//
// To enable: create a KV store in the Vercel dashboard (Storage -> Create -> KV) and connect
// it to this project. Vercel auto-injects KV_REST_API_URL + KV_REST_API_TOKEN. Until then this
// endpoint returns { configured:false } and the game/dashboard degrade gracefully (local stats
// still work). Nothing here can ever break gameplay — the client calls are fire-and-forget.

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function redis(cmd) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j ? j.result : null;
}

async function pipeline(cmds) {
  if (!KV_URL || !KV_TOKEN || !cmds.length) return [];
  const r = await fetch(KV_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
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

  if (!KV_URL || !KV_TOKEN) {
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
      u.updated = Date.now();

      await pipeline([
        ['SET', key, JSON.stringify(u)],
        ['ZADD', 'zlb', String(u.wins || 0), kickId],
      ]);
      return res.status(200).json({ ok: true, you: u });
    }

    // GET — global top 25 (by wins) + optional specific user record
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
