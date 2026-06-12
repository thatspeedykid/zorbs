import crypto from 'crypto';

// SERVER-AUTHORITATIVE RACE SEED.
// The client no longer picks its own seed (which would let a player host/choose their own
// race). The SERVER decides the race here. It's stateless (no database needed) and
// provably fair: the seed is HMAC(RACE_SECRET, raceId), so it's deterministic and can be
// re-verified later once the secret is revealed — the same commit/reveal idea as a
// provably-fair casino game.
//
// - GET /api/race                -> a brand-new server-chosen race (fresh random raceId)
// - GET /api/race?raceId=abc123  -> REPLAY a specific race (same raceId => same seed)
//
// To lock it down for real (so nobody can grind raceIds), set RACE_SECRET in the Vercel
// project env. Publishing sha256(RACE_SECRET) lets anyone verify past seeds after reveal.
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const secret = process.env.RACE_SECRET || 'zorbs-dev-secret-change-me';

  // The server owns the raceId. A client may pass one only to REPLAY a past race; a fresh
  // race always gets a server-generated, unpredictable id (time + random nonce).
  const replay = (req.query && req.query.raceId) ? String(req.query.raceId).slice(0, 64) : null;
  const raceId = replay || (Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex'));

  // deterministic seed from the secret + raceId
  const hmac = crypto.createHmac('sha256', secret).update(raceId).digest('hex');
  const seed = parseInt(hmac.slice(0, 8), 16) >>> 0;   // 32-bit uint, matches the generator

  // commitment: a hash of the secret, publishable now; the secret can be revealed later so
  // anyone can recompute HMAC(secret, raceId) and confirm the seed was never rigged.
  const secretCommit = crypto.createHash('sha256').update(secret).digest('hex');

  res.json({ raceId, seed, hmac, secretCommit, ts: Date.now() });
}
