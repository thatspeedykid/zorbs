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
    if (lenF < 60) return null;                  // need room for a fan to open AND funnel back in

    const base = mainNodes[splitIdx].halfW;
    let spanH = 0;
    for (let k = splitIdx; k < end; k++) { const a = mainNodes[k].pos, b = mainNodes[k+1].pos; spanH += Math.hypot(b.x-a.x, b.z-a.z); }
    const STEPH = spanH / lenF || 1.2;

    // ================= WIDE FAN =================
    // The trunk opens into N lanes that SPREAD OUT, run parallel for the middle stretch (room to drop
    // funnels/obstacles onto each lane later), then FUNNEL back in to the shared finish point. Every
    // lane descends monotonically — gravity carries the marbles the whole way down.
    const LW = base;                                  // each lane is full track width
    const SAFEGAP = 0.8;                              // drop the wall between two lanes only where they coincide
    const foldHalf = 0.49 * (lenF * 0.5) * STEPH;     // widest a lane may sit before the splay would fold (~26°)
    const wantSpacing = 2 * LW + base * 1.3;          // lane center-to-center: a clear visible gap between lanes
    let N = 4;                                         // aim for 4 lanes; drop to 3/2 only if there isn't room
    while (N > 2 && ((N - 1) / 2) * wantSpacing > foldHalf) N--;
    const spacing = Math.min(wantSpacing, foldHalf / Math.max(0.5, (N - 1) / 2));
    const offs = [];
    for (let i = 0; i < N; i++) offs.push((i - (N - 1) / 2) * spacing);   // symmetric lane offsets, left→right

    // PLATEAU shape: fan OUT over the first RAMP, HOLD the lanes spread across the middle, FUNNEL IN
    // over the last RAMP. Smoothstep ends so the lanes leave/return to the trunk without a kink.
    const RAMP = 0.34;
    const sstep = (a, b, x) => { if (a === b) return x < a ? 0 : 1; let t = (x - a) / (b - a); t = Math.max(0, Math.min(1, t)); return t*t*(3-2*t); };
    const shape = (k) => { const t = k / lenF; if (t < RAMP) return sstep(0, RAMP, t); if (t > 1 - RAMP) return 1 - sstep(1 - RAMP, 1, t); return 1; };
    const eTaper = (t) => { const er = Math.min(1, t / 0.16, (1 - t) / 0.16); const e = Math.max(0, er); return e*e*(3-2*e); };

    const mkWave = (amp, maxFreq) => {
      const comps = [], n = 2 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) comps.push({ f: 1 + Math.floor(rng() * maxFreq), p: rng() * 6.2832, a: 0.5 + rng() });
      const tot = comps.reduce((s, c) => s + c.a, 0) || 1;
      return (t) => { let s = 0; for (const c of comps) s += c.a * Math.sin(c.f * 6.2832 * t + c.p); return (s / tot) * Math.sin(Math.PI * t) * amp; };
    };
    const bump = (t, at, w) => { const z = (t - at) / w; return Math.exp(-z * z); };

    // ---- build the N lanes: lateral spread + a little bank/Y character, strictly descending ----
    const route = [];
    for (let i = 0; i < N; i++) {
      const turnWave = mkWave(base * 0.30, 4), slopeWave = mkWave(2.0, 2);
      const feats = []; const nf = 2 + Math.floor(rng() * 3);
      for (let j = 0; j < nf; j++) {
        const at = 0.20 + 0.60 * (j + rng()) / nf, s = rng() < 0.5 ? -1 : 1;
        feats.push({ at, w: 0.05 + rng()*0.03, lat: s*base*(0.25 + rng()*0.20), bank: s*(1.0 + rng()*0.8) });
      }
      const lat = [], yy = [], bnk = [];
      for (let k = 0; k <= lenF; k++) {
        const t = k / lenF, eT = eTaper(t);
        let L = offs[i] * shape(k) + turnWave(t) * eT * 0.5;   // spread (dominant) + small character
        let Y = slopeWave(t) * eT, Bk = 0;                      // gentle monotonic Y wiggle — never a valley
        for (const f of feats) { const g = bump(t, f.at, f.w) * eT; L += f.lat * g; Bk += f.bank * g; }
        lat.push(L); yy.push(Y); bnk.push(Bk);
      }
      route.push({ lat, yy, bnk });
    }

    // ---- lane node lists; a wall sits between two lanes wherever they have separated ----
    const branches = {}, branchOrder = [];
    for (let i = 0; i < N; i++) {
      const bid = forkId + '_' + i; branchOrder.push(bid);
      const R = route[i], raw = [];
      for (let k = 0; k <= lenF; k++) { const m = mainNodes[splitIdx + k];
        raw.push({ x: m.pos.x + m.right.x * R.lat[k], y: m.pos.y + R.yy[k], z: m.pos.z + m.right.z * R.lat[k] }); }
      const nlist = [];
      for (let k = 0; k <= lenF; k++) {
        const c = raw[k], nx = raw[Math.min(lenF, k+1)], pv = raw[Math.max(0, k-1)];
        let dir = norm(v(nx.x - pv.x, nx.y - pv.y, nx.z - pv.z));
        if (Math.hypot(nx.x - pv.x, nx.z - pv.z) < 1e-4) { const md = mainNodes[splitIdx + k].dir; dir = norm(v(md.x, md.y, md.z)); }
        const right = norm(cross(dir, worldUp)), up = norm(cross(right, dir));
        const node = { pos: v(c.x, c.y, c.z), dir, right, up, halfW: LW, bank: 0, kind: 'route', tunnel: false, branchId: bid };
        // gap to the lane on each side (lower offset = left = noWallL, higher offset = right = noWallR)
        const gapL = i > 0     ? (R.lat[k] - LW) - (route[i-1].lat[k] + LW) : 1e9;
        const gapR = i < N - 1 ? (route[i+1].lat[k] - LW) - (R.lat[k] + LW) : 1e9;
        if (i > 0     && gapL < SAFEGAP) node.noWallL = true;   // inner wall drops only where lanes coincide
        if (i < N - 1 && gapR < SAFEGAP) node.noWallR = true;   // the fan's OUTER edges stay walled always
        nlist.push(node);
      }
      const BANK_GAIN = 5.0, BANK_MAX = 0.34;
      for (let k = 1; k < lenF; k++) {
        const h0 = Math.atan2(nlist[k-1].dir.x, nlist[k-1].dir.z), h1 = Math.atan2(nlist[k+1].dir.x, nlist[k+1].dir.z);
        let dh = h1 - h0; while (dh > Math.PI) dh -= 6.2832; while (dh < -Math.PI) dh += 6.2832;
        const b = dh * BANK_GAIN + R.bnk[k];
        nlist[k].bank = Math.max(-BANK_MAX, Math.min(BANK_MAX, b)) * Math.sin(Math.PI * k / lenF);
      }
      branches[bid] = nlist;
    }

    // ---- spine through the fan: floor-only bridges at the two ends, open interior (lanes carry it) ----
    for (let k = 0; k <= lenF; k++) {
      const m = mainNodes[splitIdx + k];
      if (m._baseHalfW == null) m._baseHalfW = m.halfW;
      if (k === 0 || k === lenF) m.noWalls = true; else m.meshSkip = true;
    }

    const rejoinIdx = {}, ends = [];
    for (const bid of branchOrder) { rejoinIdx[bid] = end; ends.push(branches[bid][lenF]); }
    return { id: forkId, splitIdx, flavor: 'divergent', rejoin: true, lanesOnly: false,
      branches, branchOrder, laneCount: N, rejoinIdx, ends, end };
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
