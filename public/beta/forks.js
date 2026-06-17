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

  let USE_DIVERGENT = false;   // off by default — safe lane-forks. Toggle for testing.

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
    const rootHalfW = startPose.halfW;   // start as wide as the main track...

    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      // ...and taper down to the lane width over the first 30% (a clean Y mouth).
      // Without this, a ball at the split was instantly "outside" the narrow lane
      // and the floor edge-check would drop it.
      const taper = Math.min(1, t / 0.3);
      const hw = rootHalfW + (halfW - rootHalfW) * (taper * taper * (3 - 2 * taper));
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
        right, up, halfW: hw, bank: 0, kind: kind || 'branch', tunnel: false, branchId });
    }
    return nodes;
  }

  // TRUE DIVERGENT ROUTES: two separate ribbons that bow far apart and rejoin. Fixes the
  // old wedge/wall-crossing bugs with: (1) a wide Y-MOUTH pad at each end where the floor
  // covers everything and balls get pulled onto their route, (2) routes that stay far
  // enough apart in the middle that their walls never touch, (3) the main path's floor
  // SKIPPED in the middle (meshSkip) so there's nothing to cross. Each branch node carries
  // corridor-floor support over the mouths and standard floor over the divergent middle.
  function makeDivergentFork(mainNodes, splitIdx, rng, forkId, targetSteps) {
    const steps = targetSteps || (58 + Math.floor(rng() * 16));
    const end = Math.min(mainNodes.length - 6, splitIdx + steps);
    const lenF = end - splitIdx;
    if (lenF < 34) return null;                 // too short to diverge cleanly
    const LOOP = lenF > 150;                     // whole-level loop vs a small Y feature
    // Only diverge on STRAIGHT-ish runs (a curve twists the ribbons into a fan). The loop spine
    // is force-straight by the director, so loop forks skip this gate.
    let turnAcc = 0;
    for (let k = splitIdx; k < end; k++) {
      const a = mainNodes[k].dir, b = mainNodes[k+1].dir;
      const dot = Math.max(-1, Math.min(1, a.x*b.x + a.y*b.y + a.z*b.z));
      turnAcc += Math.acos(dot);
    }
    if (!LOOP && turnAcc > 0.22) return null;    // ~13° total — must be genuinely straight or it fans
    // STRAIGHTNESS GATE (small forks only — the loop spine is force-straight by the director).
    if (!LOOP && turnAcc > 0.30) return null;

    const base = mainNodes[splitIdx].halfW;
    let spanLen = 0;
    for (let k = splitIdx; k < end; k++) { const a = mainNodes[k].pos, b = mainNodes[k+1].pos; spanLen += Math.hypot(b.x-a.x, b.z-a.z); }

    // ---------- TUNABLES (all the shape lives here) ----------
    const LW    = base;                                        // routes are full track width
    const BULGE = LOOP ? Math.min(spanLen * 0.11, 55)          // how far the routes curve apart (capped)
                       : base * 2.4;
    const ASYM  = 0.72;                                        // route B curves a bit less → organic, not mirrored

    // The two routes BOTH start at the stem's end point (offset 0) and CURVE APART — a real fork.
    // Because they share the stem's end node, they're connected to it by construction (no pad, no
    // sideways handoff, no seam). Smooth sine bow for the loop; soft hump for a small Y.
    const shape = LOOP
      ? (k) => Math.sin(Math.PI * k / lenF)
      : (k) => { const t = 1 - Math.abs(2*k/lenF - 1); return t*t*(3-2*t); };
    const centerOff = (k, sign) => sign * (sign < 0 ? 1 : ASYM) * BULGE * shape(k);
    // The two routes overlap near the mouth (both still ~centered); their INNER walls would cross
    // there, so drop them until the routes have clearly separated — with a margin that also covers
    // the per-route weave, so the weave can never push them into each other while a wall is up.
    const WEAVEMARGIN = base * 3;
    const innerCrosses = (k) => (BULGE * shape(k) * (1 + ASYM) - 2 * LW - WEAVEMARGIN) < 0;

    // ---------- BRANCHES: two routes, each with its OWN character + random FEATURES ----------
    const mkWave = (amp, maxFreq) => {
      const comps = [], n = 2 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) comps.push({ f: 1 + Math.floor(rng() * maxFreq), p: rng() * 6.2832, a: 0.5 + rng() });
      const tot = comps.reduce((s, c) => s + c.a, 0) || 1;
      return (t) => { let s = 0; for (const c of comps) s += c.a * Math.sin(c.f * 6.2832 * t + c.p); return (s / tot) * Math.sin(Math.PI * t) * amp; };
    };
    const bump = (t, at, w) => { const z = (t - at) / w; return Math.exp(-z * z); };
    // a few strong random FEATURES per route (kept clear of the mouth/merge): tight HAIRPIN turns,
    // steep DROPS, CLIMBS, and hard-banked TWISTS — so each route actually plays differently.
    const mkFeatures = () => {
      if (!LOOP) return [];
      const fs = [], n = 2 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) {
        const at = 0.24 + rng() * 0.52, w = 0.05 + rng() * 0.05, r = rng(), s = rng() < 0.5 ? -1 : 1;
        if (r < 0.34)      fs.push({ at, w,       lat: s * base * (1.6 + rng()*1.2), dy: 0,               bank: s * 0.55 });  // hairpin
        else if (r < 0.58) fs.push({ at, w,       lat: 0,                            dy: -(5 + rng()*6),  bank: 0 });          // steep drop
        else if (r < 0.78) fs.push({ at, w,       lat: 0,                            dy: (4 + rng()*5),   bank: 0 });          // climb
        else               fs.push({ at, w: w*0.7, lat: s * base * 0.8,              dy: -(2 + rng()*3),  bank: s * 0.95 });   // twist
      }
      return fs;
    };

    // build each route's lateral offset + elevation + feature-bank arrays
    const route = {};
    for (const key of ['A', 'B']) {
      const sign = key === 'A' ? -1 : 1;
      const turnWave = mkWave(base * 1.5, 4), slopeWave = mkWave(5, 3), feats = mkFeatures();
      const lat = [], yy = [], bnk = [];
      for (let k = 0; k <= lenF; k++) {
        const t = k / lenF;
        let L = centerOff(k, sign) + turnWave(t), Y = slopeWave(t), Bk = 0;
        for (const f of feats) { const g = bump(t, f.at, f.w); L += f.lat * g; Y += f.dy * g; Bk += f.bank * g; }
        lat.push(L); yy.push(Y); bnk.push(Bk);
      }
      route[key] = { lat, yy, bnk };
    }

    const branches = {};
    const SAFEGAP = base * 1.2;   // min clearance between the routes' inner edges; below it, drop the inner wall
    for (const key of ['A', 'B']) {
      const sign = key === 'A' ? -1 : 1;
      const bid = forkId + '_' + key;
      const R = route[key];
      const raw = [];
      for (let k = 0; k <= lenF; k++) {
        const m = mainNodes[splitIdx + k];
        raw.push({ x: m.pos.x + m.right.x * R.lat[k], y: m.pos.y + R.yy[k], z: m.pos.z + m.right.z * R.lat[k] });
      }
      const nlist = [];
      for (let k = 0; k <= lenF; k++) {
        const c = raw[k], nx = raw[Math.min(lenF, k + 1)], pv = raw[Math.max(0, k - 1)];
        let dir = norm(v(nx.x - pv.x, nx.y - pv.y, nx.z - pv.z));
        if (Math.hypot(nx.x - pv.x, nx.z - pv.z) < 1e-4) { const md = mainNodes[splitIdx + k].dir; dir = norm(v(md.x, md.y, md.z)); }
        const right = norm(cross(dir, worldUp));
        const up = norm(cross(right, dir));
        const node = { pos: v(c.x, c.y, c.z), dir, right, up, halfW: LW, bank: 0, kind: 'route', tunnel: false, branchId: bid };
        // ACTUAL inner-edge gap between the two routes — robust against any feature swing
        const gap = (route.B.lat[k] - LW) - (route.A.lat[k] + LW);
        if (gap < SAFEGAP) { if (sign < 0) node.noWallR = true; else node.noWallL = true; }
        nlist.push(node);
      }
      // BANK = path curvature + explicit feature twist, tapered at the ends.
      const BANK_GAIN = 5.0, BANK_MAX = 0.34;
      for (let k = 1; k < lenF; k++) {
        const h0 = Math.atan2(nlist[k-1].dir.x, nlist[k-1].dir.z);
        const h1 = Math.atan2(nlist[k+1].dir.x, nlist[k+1].dir.z);
        let dh = h1 - h0; while (dh > Math.PI) dh -= 6.2832; while (dh < -Math.PI) dh += 6.2832;
        const b = dh * BANK_GAIN + R.bnk[k];
        nlist[k].bank = Math.max(-BANK_MAX, Math.min(BANK_MAX, b)) * Math.sin(Math.PI * k / lenF);
      }
      branches[bid] = nlist;
    }

    // ---------- MAIN SPINE through the fork ----------
    // Routes share the stem's end node (offset 0), so the stem flows straight into them with no
    // gap. The spine keeps ONLY the split & merge nodes as floor-only bridges; the middle is the
    // open loop interior. No spine walls in the fork, no width changes.
    for (let k = 0; k <= lenF; k++) {
      const m = mainNodes[splitIdx + k];
      if (m._baseHalfW == null) m._baseHalfW = m.halfW;
      if (k === 0 || k === lenF) m.noWalls = true;   // floor-only bridge from stem/outro into the routes
      else m.meshSkip = true;
    }

    return {
      id: forkId, splitIdx, flavor: 'divergent', rejoin: true, lanesOnly: false,
      branches,
      rejoinIdx: { [forkId + '_A']: end, [forkId + '_B']: end },
      endA: branches[forkId + '_A'][lenF], endB: branches[forkId + '_B'][lenF],
    };
  }

  // Create one fork rooted at mainNodes[splitIdx]. Returns the fork descriptor.
  // rng = seeded function from track.js so forks are deterministic.
  //
  // ARCHITECTURE (v2.1): a fork is a SPLIT SECTION OF THE MAIN CORRIDOR, not a
  // separate ribbon flying off sideways. The old approach built branches that drifted
  // out of the main corridor — their walls crossed at the Y mouth (balls jammed into
  // the wedge) and they passed straight through the main track's wall collider
  // (balls ground against it forever). Both were stuck-ball bugs seen on stream.
  // Now: the main corridor WIDENS over the fork region, a DIVIDER WALL rises down
  // the middle, and the two lanes are offset copies of the main centerline. Walls
  // can never cross, balls can never leave the corridor, and the lanes merge back
  // perfectly because they ARE the main path. Flavor variety (steep shortcuts etc.)
  // returns with the obstacle pass — lanes carry the obstacle flag already.
  function makeFork(mainNodes, splitIdx, rng, forkId, rejoin) {
    const flavor = ['risk','equal','obstacle'][Math.floor(rng()*3)];
    const steps = 46 + Math.floor(rng() * 22);
    const end = Math.min(mainNodes.length - 5, splitIdx + steps);
    const len = end - splitIdx;
    const WIDEN = 1.7;          // corridor grows to 1.7x width at the heart of the split
    const obstacleLane = flavor === 'obstacle' ? (rng() < 0.5 ? 'A' : 'B') : null;

    const branchA = [], branchB = [];
    const divPos = [], divIdx = [];
    let divBase = 0;
    let prevDivTop = null, prevDivBot = null;
    const DIV_H = 1.5;

    for (let k = 0; k <= len; k++) {
      const m = mainNodes[splitIdx + k];
      const t = k / len;
      // ramp 0→1 over the first 30%, hold, then 1→0 over the last 30% (smooth split + merge)
      const rampIn = Math.min(1, t / 0.3), rampOut = Math.min(1, (1 - t) / 0.3);
      const e0 = Math.min(rampIn, rampOut);
      const ease = e0 * e0 * (3 - 2 * e0);   // smoothstep

      // WIDEN the main corridor itself (forks run before the mesh/collider build, so
      // the widened walls and floor are generated automatically — no separate ribbon)
      if (m._baseHalfW == null) m._baseHalfW = m.halfW;
      m.halfW = m._baseHalfW * (1 + (WIDEN - 1) * ease);

      // lane centerlines: offset copies of the main node, easing apart and back
      const off = m.halfW * 0.5 * ease;
      const laneHW = (m.halfW * 0.5 - 0.25) * ease + m._baseHalfW * (1 - ease);
      const mk = (sign, bid, obst) => ({
        pos: v(m.pos.x + m.right.x * off * sign, m.pos.y, m.pos.z + m.right.z * off * sign),
        dir: v(m.dir.x, m.dir.y, m.dir.z),
        right: v(m.right.x, m.right.y, m.right.z),
        up: v(m.up.x, m.up.y, m.up.z),
        halfW: laneHW, bank: m.bank, kind: 'fork', tunnel: false,
        branchId: bid, obstacle: obst,
        // FLOOR SUPPORT IS THE WHOLE WIDENED CORRIDOR, not just this lane. During the
        // split/merge the lane centerline sweeps sideways faster than lane-pull can
        // drag a ball, so checking support against the lane alone wrongly dropped
        // balls mid-merge. The real floor spans the corridor — record it.
        laneOff: off * sign,        // this lane's offset from the main centerline
        corridorHalfW: m.halfW,     // widened corridor half-width at this node
      });
      branchA.push(mk(-1, forkId+'_A', obstacleLane === 'A'));
      branchB.push(mk( 1, forkId+'_B', obstacleLane === 'B'));

      // DIVIDER WALL down the main centerline wherever the lanes are meaningfully split
      if (ease > 0.2) {
        const bot = v(m.pos.x, m.pos.y, m.pos.z);
        const top = v(m.pos.x, m.pos.y + DIV_H * Math.min(1, ease * 1.6), m.pos.z);
        if (prevDivBot) {
          divPos.push(prevDivBot.x, prevDivBot.y, prevDivBot.z,
                      prevDivTop.x, prevDivTop.y, prevDivTop.z,
                      top.x, top.y, top.z,
                      bot.x, bot.y, bot.z);
          divIdx.push(divBase, divBase+1, divBase+2, divBase, divBase+2, divBase+3);
          divBase += 4;
        }
        prevDivBot = bot; prevDivTop = top;
      } else { prevDivBot = prevDivTop = null; }
    }

    return {
      id: forkId, splitIdx, flavor, rejoin: true, lanesOnly: true,
      branches: { [forkId+'_A']: branchA, [forkId+'_B']: branchB },
      rejoinIdx: { [forkId+'_A']: end, [forkId+'_B']: end },
      divider: { positions: new Float32Array(divPos), indices: new Uint32Array(divIdx) },
      endA: branchA[branchA.length-1],
      endB: branchB[branchB.length-1],
    };
  }

  // Pick fork locations along the main path and build them. Avoid the platform and the
  // very end; space them out. Returns { forks:[...], forkAtIdx: Map(splitIdx->fork) }.
  function buildForks(mainNodes, platformEndIdx, rng) {
    const forks = [];
    const forkAtIdx = new Map();
    let n = 0, lastForkEnd = -1e9;
    for (let i = platformEndIdx + 2; i < mainNodes.length - 60; i++) {
      const inZone = mainNodes[i].forkZone && !(mainNodes[i-1] && mainNodes[i-1].forkZone);
      if (inZone && (i - lastForkEnd) > 60) {
        // measure how far this split-zone runs; a giant zone => the whole-level loop fork
        let zEnd = i; while (zEnd < mainNodes.length && mainNodes[zEnd].forkZone) zEnd++;
        const at = i + 16;
        const span = zEnd - at - 6;
        const targetSteps = span > 34 ? span : undefined;   // span the entire zone
        const fork = (USE_DIVERGENT && makeDivergentFork(mainNodes, at, rng, 'fork'+n, targetSteps))
                     || makeFork(mainNodes, at, rng, 'fork'+n, true);
        n++;
        forks.push(fork);
        forkAtIdx.set(at, fork);
        lastForkEnd = fork.splitIdx + (fork.flavor === 'divergent' ? (span + 30) : 90);
        i = zEnd;
      }
    }
    return { forks, forkAtIdx };
  }

  return { buildForks, makeFork, makeDivergentFork, buildBranch, setDivergent: (b) => { USE_DIVERGENT = !!b; } };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { ZFORK };
