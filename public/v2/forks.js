// ZORBS v2 — Forks / split routes (host-agnostic, post-pass on the centerline)
// A fork takes a point on the main path and splits it into TWO branches. Each branch is
// its own little centerline (its own nodes with a branchId). Branches either:
//   • REJOIN the main path later, or
//   • lead to SEPARATE finishes (the path stays split to the end).
// Flavor is randomized: risk/reward (one short+steep, one long+safe), roughly-equal
// variety, or one-branch-has-obstacles (flagged for the obstacle pass later).
//
// Design that avoids the old fork bugs:
//   • Each branch is a SEPARATE node list — never interleaved into one array, so a ball
//     on branch A can't snap to branch B's nodes.
//   • A ball stores which branch it's committed to; physics searches only that branch.
//   • The split is a Y: a short entry pad, then two lanes that diverge cleanly with a
//     solid divider between them, so balls physically pick a side.

const ZFORK = (() => {

  const v = (x, y, z) => ({ x, y, z });
  const add = (a, b) => v(a.x + b.x, a.y + b.y, a.z + b.z);
  const scale = (a, s) => v(a.x * s, a.y * s, a.z * s);
  const len = (a) => Math.hypot(a.x, a.y, a.z) || 1;
  const norm = (a) => { const l = len(a); return v(a.x / l, a.y / l, a.z / l); };
  const cross = (a, b) => v(a.y*b.z-a.z*b.y, a.z*b.x-a.x*b.z, a.x*b.y-a.y*b.x);
  const worldUp = v(0, 1, 0);

  // Build a straight-ish branch of N nodes starting at a pose, drifting laterally to
  // 'sideOffset' over the run, descending at dropRate, optionally narrower/steeper.
  function buildBranch(startPose, opts) {
    const { steps, sideOffset, dropRate, halfW, branchId, kind } = opts;
    const nodes = [];
    let pos = v(startPose.pos.x, startPose.pos.y, startPose.pos.z);
    let heading = norm(v(startPose.dir.x, startPose.dir.y, startPose.dir.z));
    const right0 = norm(cross(heading, worldUp));

    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      // ease the lateral drift in then straighten (smooth S to the side)
      const driftEase = Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.5); // 0..1 ease-out
      const lateralStep = (sideOffset / steps) * (driftEase * 1.8);
      // descend
      heading.y += (-dropRate - heading.y) * 0.12;
      heading = norm(heading);
      pos = add(pos, scale(heading, 1.3));            // STEP matches track.js
      pos = add(pos, scale(right0, lateralStep));     // drift sideways
      const right = norm(cross(heading, worldUp));
      const up = norm(cross(right, heading));
      nodes.push({ pos: v(pos.x,pos.y,pos.z), dir: v(heading.x,heading.y,heading.z),
        right, up, halfW, bank: 0, kind: kind || 'branch', tunnel: false, branchId });
    }
    return nodes;
  }

  // Create one fork rooted at mainNodes[splitIdx]. Returns the fork descriptor.
  // rng = seeded function from track.js so forks are deterministic.
  function makeFork(mainNodes, splitIdx, rng, forkId, rejoin) {
    const root = mainNodes[splitIdx];
    const flavor = ['risk','equal','obstacle'][Math.floor(rng()*3)];

    // branch lengths/feel depend on flavor
    let aSteps, bSteps, aDrop, bDrop, aHalf, bHalf, aObstacle = false, bObstacle = false;
    const baseHalf = root.halfW * 0.62;   // each lane narrower than the main track
    if (flavor === 'risk') {
      // A = short + steep + narrow (risky shortcut); B = long + gentle + wide (safe)
      aSteps = 28 + Math.floor(rng()*10); aDrop = 0.55; aHalf = baseHalf*0.85;
      bSteps = aSteps + 18 + Math.floor(rng()*14); bDrop = 0.28; bHalf = baseHalf*1.1;
    } else if (flavor === 'obstacle') {
      // A = clear; B = obstacle-laden (flagged for the obstacle pass)
      aSteps = 34 + Math.floor(rng()*12); aDrop = 0.36; aHalf = baseHalf;
      bSteps = aSteps; bDrop = 0.36; bHalf = baseHalf; bObstacle = true;
    } else {
      // equal-ish variety
      aSteps = 32 + Math.floor(rng()*12); aDrop = 0.34; aHalf = baseHalf;
      bSteps = aSteps + Math.floor((rng()-0.5)*8); bDrop = 0.34; bHalf = baseHalf;
    }

    const branchA = buildBranch(root, { steps:aSteps, sideOffset:-root.halfW*1.3,
      dropRate:aDrop, halfW:aHalf, branchId: forkId+'_A', kind:'fork' });
    const branchB = buildBranch(root, { steps:bSteps, sideOffset: root.halfW*1.3,
      dropRate:bDrop, halfW:bHalf, branchId: forkId+'_B', kind:'fork' });

    branchA.forEach(n => n.obstacle = aObstacle);
    branchB.forEach(n => n.obstacle = bObstacle);

    return {
      id: forkId, splitIdx, flavor, rejoin,
      branches: { [forkId+'_A']: branchA, [forkId+'_B']: branchB },
      // where branches end (for rejoin: bridge back to main; for split: separate finishes)
      endA: branchA[branchA.length-1],
      endB: branchB[branchB.length-1],
    };
  }

  // Pick fork locations along the main path and build them. Avoid the platform and the
  // very end; space them out. Returns { forks:[...], forkAtIdx: Map(splitIdx->fork) }.
  function buildForks(mainNodes, platformEndIdx, rng) {
    const forks = [];
    const forkAtIdx = new Map();
    const minGap = 120;                    // nodes between forks
    let i = platformEndIdx + 80;
    let n = 0;
    while (i < mainNodes.length - 140) {
      if (rng() < 0.6) {
        const rejoin = rng() < 0.6;        // 60% rejoin, 40% separate finish
        const fork = makeFork(mainNodes, i, rng, 'fork'+(n++), rejoin);
        forks.push(fork);
        forkAtIdx.set(i, fork);
        i += minGap + Math.floor(rng()*80);
      } else {
        i += 40;
      }
    }
    return { forks, forkAtIdx };
  }

  return { buildForks, makeFork, buildBranch };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { ZFORK };
