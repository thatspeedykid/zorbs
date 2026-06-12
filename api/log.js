// CLIENT ERROR LOGGER — browsers POST runtime errors here so we can see what's breaking in
// the wild and fix the game from real data as it runs without us watching. Stateless: it
// writes to the function console, which Vercel captures in its Logs / Observability view.
// (Swap in a database or a logging service later if we want searchable history + alerts.)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    body = body || {};
    const s = (v, n) => String(v == null ? '' : v).slice(0, n);
    const rec = {
      t: new Date().toISOString(),
      build: s(body.build, 16),
      kind: s(body.kind, 24),            // error | promise | manual
      msg: s(body.msg, 500),
      stack: s(body.stack, 1800),
      src: s(body.url, 300),
      line: body.line | 0, col: body.col | 0,
      raceId: s(body.raceId, 80),
      phase: s(body.phase, 24),
      ua: s(req.headers && req.headers['user-agent'], 200),
    };
    // Vercel captures this in the project's function logs / observability dashboard.
    console.error('[ZORBS_CLIENT_ERROR]', JSON.stringify(rec));
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[ZORBS_LOG_FAIL]', e && e.message);
    return res.status(200).json({ ok: false });
  }
}
