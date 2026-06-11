// Smoke test: simulate full races headlessly and assert no ball is permanently stuck.
// A ball "finishes" (hint near the end), "falls" (eliminated), or it's a BUG.
const { ZTRACK } = require('./public/v2/track.js');
const { ZPHYSICS } = require('./public/v2/physics.js');

async function runRace(seed, nBalls, maxSeconds) {
  const track = ZTRACK.generate(seed, 1100, nBalls);
  await ZPHYSICS.init(0.5);
  ZPHYSICS.clearBalls();
  ZPHYSICS.setTrack(track.collider, track.nodes, { forks: track.forks, branchColliders: track.branchColliders });

  // spawn grid like index.html
  const plat = track.platform;
  for (let i = 0; i < nBalls; i++) {
    const row = Math.floor(i / 6), col = i % 6;
    const idx = Math.max(1, Math.min(plat.endIdx - 2, 2 + row * 2));
    const n = track.nodes[idx];
    const lat = ((col + 0.5) / 6 - 0.5) * n.halfW * 1.7;
    ZPHYSICS.addBall('ball' + i, {
      x: n.pos.x + n.right.x * lat, y: n.pos.y + 0.75, z: n.pos.z + n.right.z * lat
    });
  }

  const dt = 1 / 60;
  const fallen = new Set();
  const lastProgress = {}, stuckSince = {};
  let rejoins = 0, commits = 0;
  for (let f = 0; f < maxSeconds * 60; f++) {
    ZPHYSICS.step(dt);
    for (const id of ZPHYSICS.checkFalls(12)) fallen.add(id);
    const snap = ZPHYSICS.snapshot();
    for (const [id, s] of Object.entries(snap)) {
      if (!s.alive) continue;
      if (s.branch) commits++;
      const p = s.progress;
      if (lastProgress[id] != null && p <= lastProgress[id]) {
        stuckSince[id] = (stuckSince[id] || 0) + dt;
      } else stuckSince[id] = 0;
      lastProgress[id] = p;
      if (isNaN(s.x) || isNaN(s.y)) throw new Error('NaN position for ' + id);
    }
  }
  const snap = ZPHYSICS.snapshot();
  const report = { seed, finished: 0, fell: fallen.size, stuck: [] };
  for (const [id, s] of Object.entries(snap)) {
    if (!s.alive) continue;
    if (s.progress >= track.nodes.length - 20) report.finished++;
    else if ((stuckSince[id] || 0) > 8) { const N = s.branch ? null : track.nodes; const nd = N ? N[Math.min(s.hint, N.length-1)] : null; report.stuck.push({ id, progress: Math.round(s.progress), of: track.nodes.length, noProgressFor: Math.round(stuckSince[id]) + 's', pos: {x:+s.x.toFixed(1),y:+s.y.toFixed(1),z:+s.z.toFixed(1)}, branch: s.branch, hint: s.hint, nodeKind: nd ? nd.kind : '?', nodeY: nd ? +nd.pos.y.toFixed(1) : null, nodeHalfW: nd ? +nd.halfW.toFixed(2) : null }); }
    else report.finished++; // still moving at cutoff = fine, just a slow race
  }
  report.forks = track.forks ? track.forks.length : 0;
  return report;
}

(async () => {
  let bad = 0;
  for (const seed of [12345, 777, 424242]) {
    const r = await runRace(seed, 12, 120);
    console.log(JSON.stringify(r));
    if (r.stuck.length) bad++;
  }
  console.log(bad === 0 ? 'ALL RACES CLEAN — NO STUCK BALLS' : 'STUCK BALLS FOUND: ' + bad + ' race(s)');
  process.exit(bad === 0 ? 0 : 1);
})();
// (diagnostic helper appended by test harness — prints details for stuck balls)
