// COMMUNITY MAP STORE — backed by Vercel KV / Upstash Redis (REST API).
//
// Maps are the section plans authored in the /beta/ map editor. Users submit; admins review;
// approved maps enter the community rotation (the Randomizer + per-streamer map selection).
//
//   POST /api/maps  { action:'submit', map }                 -> save a pending map (author submit)
//   GET  /api/maps?id=<id>                                    -> one map (full plan, for play/test)
//   GET  /api/maps?list=approved                              -> approved community maps (metadata)
//   GET  /api/maps?list=mine&author=<name>                    -> that author's maps (any status)
//   GET  /api/maps?list=pending&admin=<key>                   -> review queue (ADMIN ONLY)
//   POST /api/maps  { action:'review', id, approve, admin }   -> approve/deny a map (ADMIN ONLY)
//   POST /api/maps  { action:'feature', id, admin }           -> pin as featured map (ADMIN ONLY)
//
// No-ops gracefully (configured:false) until a DB is connected, so nothing breaks.

function kvEnv() {
  let url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
    || process.env.STORAGE_REDIS_REST_URL || process.env.STORAGE_KV_REST_API_URL
    || process.env.REDIS_REST_URL;
  let token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
    || process.env.STORAGE_REDIS_REST_TOKEN || process.env.STORAGE_KV_REST_API_TOKEN
    || process.env.REDIS_REST_TOKEN;
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

const clean = (s, n) => String(s == null ? '' : s).slice(0, n || 40).replace(/[<>\r\n]/g, '');

// Admin gate: the ZORBS_ADMIN_KEY env var must match the `admin` field. If unset, admin ops are
// refused (fail-closed) rather than open to everyone.
function isAdmin(key) {
  const k = process.env.ZORBS_ADMIN_KEY || '';
  return !!k && key === k;
}

// The set of section kinds the track builder understands. Anything else is dropped on save so a
// malicious/buggy editor can't inject arbitrary fields into the generator.
const SECTION_KINDS = ['straight', 'sweep', 'drop', 'funnel', 'narrower', 'moguls', 'spiral', 'tunnel'];

// Sanitize one authored section into the minimal shape the generator reads. Numeric params are
// clamped so no single section can blow up the node budget or the geometry.
function sanitizeSection(s) {
  if (!s || typeof s !== 'object') return null;
  const kind = SECTION_KINDS.includes(s.kind) ? s.kind : 'straight';
  const out = { kind, len: Math.max(6, Math.min(320, (s.len | 0) || 20)) };
  if (kind === 'sweep' || kind === 'spiral' || kind === 'tunnel') out.dir = s.dir < 0 ? -1 : 1;
  if (kind === 'sweep') out.sharp = Math.max(0.01, Math.min(0.12, +s.sharp || 0.05));
  if (kind === 'funnel' || kind === 'narrower') out.min = Math.max(0.25, Math.min(0.9, +s.min || 0.45));
  if (kind === 'drop') out.drop = Math.max(0.4, Math.min(3, +s.drop || 1.2));
  if (s.split === true) out.split = true;
  return out;
}

const OBSTACLE_KINDS = ['bumper', 'spinner', 'boost', 'launch'];
function sanitizeObstacle(o) {
  if (!o || typeof o !== 'object') return null;
  if (!OBSTACLE_KINDS.includes(o.kind)) return null;
  const out = {
    kind: o.kind,
    t: Math.max(0, Math.min(1, +o.t || 0)),
    side: Math.max(-1, Math.min(1, +o.side || 0)),
    dir: o.dir < 0 ? -1 : 1,
  };
  // optional per-obstacle tuning (clamped to the same ranges the generator enforces)
  if (o.kind === 'bumper' && o.size != null) out.size = Math.max(0.35, Math.min(1.6, +o.size || 0.65));
  if (o.kind === 'spinner' && o.speed != null) out.speed = Math.max(0.8, Math.min(5, +o.speed || 2.5));
  if (o.kind === 'boost' && o.length != null) out.length = Math.max(6, Math.min(28, (o.length | 0) || 14));
  return out;
}

// thumbnail: a small top-down PNG data URL snapshot from the editor. Kept short so a single oversized
// payload can't bloat the store; dropped if it isn't a reasonable data: image URL.
function sanitizeThumb(t) {
  if (typeof t !== 'string') return '';
  if (!/^data:image\/(png|jpeg|webp);base64,/.test(t)) return '';
  return t.length <= 200000 ? t : '';
}

function sanitizeMap(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sections = Array.isArray(raw.sections)
    ? raw.sections.map(sanitizeSection).filter(Boolean).slice(0, 80) : [];
  if (sections.length < 2) return null;   // too short to be a real course
  const obstacles = Array.isArray(raw.obstacles)
    ? raw.obstacles.map(sanitizeObstacle).filter(Boolean).slice(0, 60) : [];
  return {
    name: clean(raw.name, 40) || 'Untitled Track',
    author: clean(raw.author, 24) || 'anon',
    difficulty: ['easy', 'medium', 'hard'].includes(raw.difficulty) ? raw.difficulty : 'medium',
    description: clean(raw.description, 140),
    theme: clean(raw.theme, 20),
    tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 6).map(t => clean(t, 16)) : [],
    thumb: sanitizeThumb(raw.thumb),
    sections, obstacles,
  };
}

function newId() {
  return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// metadata-only view (no full section plan) for list endpoints
function meta(m) {
  if (!m) return null;
  return {
    id: m.id, name: m.name, author: m.author, difficulty: m.difficulty,
    description: m.description, tags: m.tags, theme: m.theme,
    status: m.status, plays: m.plays || 0, rating: m.rating || 0, votes: m.votes || 0,
    up: m.up || 0, down: m.down || 0, thumb: m.thumb || '',
    featured: !!m.featured, sectionCount: (m.sections || []).length, created: m.created,
  };
}

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
  if (req.query && req.query.status) return res.status(200).json({ ok: true, configured });
  if (!configured) return res.status(200).json({ ok: false, configured: false, maps: [], map: null });

  try {
    if (req.method === 'GET') {
      // one map (full plan)
      const id = clean(req.query.id, 24);
      if (id) {
        const raw = await redis(['GET', 'zmap:' + id]);
        let m = null; if (raw) { try { m = JSON.parse(raw); } catch (_) {} }
        if (m && m.status === 'approved') { redis(['HINCRBY', 'zmapplays', id, 1]).catch(() => {}); }
        return res.status(200).json({ ok: true, map: m });
      }

      const list = clean(req.query.list, 16) || 'approved';

      if (list === 'pending') {
        if (!isAdmin(clean(req.query.admin, 80))) return res.status(403).json({ ok: false, error: 'admin only' });
        const ids = (await redis(['ZREVRANGE', 'zmaps:pending', '0', '99'])) || [];
        const rows = ids.length ? await pipeline(ids.map(i => ['GET', 'zmap:' + i])) : [];
        const maps = rows.map(r => { try { return meta(JSON.parse(r)); } catch (_) { return null; } }).filter(Boolean);
        return res.status(200).json({ ok: true, maps });
      }

      if (list === 'mine') {
        const author = clean(req.query.author, 24).toLowerCase();
        if (!author) return res.status(400).json({ ok: false, error: 'no author' });
        const ids = (await redis(['ZREVRANGE', 'zmaps:by:' + author, '0', '99'])) || [];
        const rows = ids.length ? await pipeline(ids.map(i => ['GET', 'zmap:' + i])) : [];
        const maps = rows.map(r => { try { return meta(JSON.parse(r)); } catch (_) { return null; } }).filter(Boolean);
        return res.status(200).json({ ok: true, maps });
      }

      // approved community maps (default)
      const ids = (await redis(['ZREVRANGE', 'zmaps:approved', '0', '99'])) || [];
      const rows = ids.length ? await pipeline(ids.map(i => ['GET', 'zmap:' + i])) : [];
      const maps = rows.map(r => { try { return meta(JSON.parse(r)); } catch (_) { return null; } }).filter(Boolean);
      return res.status(200).json({ ok: true, maps });
    }

    // ---- POST ----
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    body = body || {};
    const action = clean(body.action, 16);

    if (action === 'submit') {
      const m = sanitizeMap(body.map);
      if (!m) return res.status(400).json({ ok: false, error: 'invalid map' });
      m.id = newId();
      m.status = 'pending';
      m.created = Date.now();
      m.plays = 0; m.rating = 0; m.votes = 0; m.up = 0; m.down = 0; m.featured = false;
      await pipeline([
        ['SET', 'zmap:' + m.id, JSON.stringify(m)],
        ['ZADD', 'zmaps:pending', String(m.created), m.id],
        ['ZADD', 'zmaps:by:' + m.author.toLowerCase(), String(m.created), m.id],
      ]);
      return res.status(200).json({ ok: true, id: m.id });
    }

    if (action === 'review') {
      if (!isAdmin(clean(body.admin, 80))) return res.status(403).json({ ok: false, error: 'admin only' });
      const id = clean(body.id, 24);
      const raw = await redis(['GET', 'zmap:' + id]);
      let m = null; if (raw) { try { m = JSON.parse(raw); } catch (_) {} }
      if (!m) return res.status(404).json({ ok: false, error: 'not found' });
      const approve = !!body.approve;
      m.status = approve ? 'approved' : 'denied';
      m.reviewed = Date.now();
      const cmds = [['SET', 'zmap:' + id, JSON.stringify(m)], ['ZREM', 'zmaps:pending', id]];
      if (approve) cmds.push(['ZADD', 'zmaps:approved', String(Date.now()), id]);
      else cmds.push(['ZREM', 'zmaps:approved', id]);
      await pipeline(cmds);
      return res.status(200).json({ ok: true, status: m.status });
    }

    if (action === 'feature') {
      if (!isAdmin(clean(body.admin, 80))) return res.status(403).json({ ok: false, error: 'admin only' });
      const id = clean(body.id, 24);
      const raw = await redis(['GET', 'zmap:' + id]);
      let m = null; if (raw) { try { m = JSON.parse(raw); } catch (_) {} }
      if (!m) return res.status(404).json({ ok: false, error: 'not found' });
      m.featured = !m.featured;
      await pipeline([['SET', 'zmap:' + id, JSON.stringify(m)]]);
      return res.status(200).json({ ok: true, featured: m.featured });
    }

    if (action === 'rate') {
      // post-race thumbs up/down. Anonymous + best-effort (no per-user dedupe), so a single rating
      // nudges the score; `rating` is the up-share (0..1) used to rank the best community maps.
      const id = clean(body.id, 24);
      const raw = await redis(['GET', 'zmap:' + id]);
      let m = null; if (raw) { try { m = JSON.parse(raw); } catch (_) {} }
      if (!m || m.status !== 'approved') return res.status(404).json({ ok: false, error: 'not found' });
      const up = body.vote === 'up' || body.vote === 1 || body.up === true;
      if (up) m.up = (m.up || 0) + 1; else m.down = (m.down || 0) + 1;
      m.votes = (m.up || 0) + (m.down || 0);
      m.rating = m.votes ? +((m.up || 0) / m.votes).toFixed(3) : 0;
      await pipeline([
        ['SET', 'zmap:' + id, JSON.stringify(m)],
        // rank approved maps by a wilson-ish score so well-liked maps surface first
        ['ZADD', 'zmaps:approved', String(Math.round(m.rating * 1000) + m.votes), id],
      ]);
      return res.status(200).json({ ok: true, up: m.up, down: m.down, rating: m.rating });
    }

    if (action === 'delete') {
      // a creator may delete their OWN map; an admin may delete any.
      const id = clean(body.id, 24);
      const raw = await redis(['GET', 'zmap:' + id]);
      let m = null; if (raw) { try { m = JSON.parse(raw); } catch (_) {} }
      if (!m) return res.status(404).json({ ok: false, error: 'not found' });
      const requester = clean(body.author, 24).toLowerCase();
      const admin = isAdmin(clean(body.admin, 80));
      if (!admin && (!requester || requester !== String(m.author || '').toLowerCase()))
        return res.status(403).json({ ok: false, error: 'not your map' });
      await pipeline([
        ['DEL', 'zmap:' + id],
        ['ZREM', 'zmaps:pending', id],
        ['ZREM', 'zmaps:approved', id],
        ['ZREM', 'zmaps:by:' + String(m.author || '').toLowerCase(), id],
      ]);
      return res.status(200).json({ ok: true, deleted: id });
    }

    return res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e), maps: [], map: null });
  }
}
