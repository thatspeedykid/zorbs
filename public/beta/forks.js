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
    const RAMP = 0.30;                                // fraction spent fanning OUT / funnelling IN
    const sstep = (a, b, x) => { if (a === b) return x < a ? 0 : 1; let t = (x - a) / (b - a); t = Math.max(0, Math.min(1, t)); return t*t*(3-2*t); };
    const shape = (k) => { const t = k / lenF; if (t < RAMP) return sstep(0, RAMP, t); if (t > 1 - RAMP) return 1 - sstep(1 - RAMP, 1, t); return 1; };
    const eTaper = (t) => { const er = Math.min(1, t / 0.16, (1 - t) / 0.16); const e = Math.max(0, er); return e*e*(3-2*e); };

    // The outer lanes peel WIDE to the left/right. maxOuter is set straight off the fan-out length so
    // the fan-out slope is a fixed ~SLOPE regardless of track length (no fold). The middle lanes stay
    // central. Each lane then WANDERS in its own area during the spread before funnelling back.
    const SLOPE = 0.62;                               // lateral run / forward run during the fan-out (~32°)
    const fanLenH = RAMP * lenF * STEPH;              // horizontal distance of the fan-out
    const maxOuter = SLOPE * fanLenH;                 // how far the outermost lane reaches left/right
    const minSpacing = 2 * LW + base * 0.8;           // lanes must stay at least this far apart (center-to-center)
    // how many lanes FIT side-by-side without colliding (largest count whose spacing >= minSpacing)
    let roomMax = 4;
    while (roomMax >= 2 && (2 * maxOuter / (roomMax - 1)) < minSpacing) roomMax--;
    // RANDOM lane count per seed, weighted toward fans: ~10% single, the rest 2-4 lanes. Capped to
    // what fits. N=1 means NO split (single descending path) — kept as a rare surprise, not the norm.
    const wr = rng();
    const want = wr < 0.10 ? 1 : wr < 0.40 ? 2 : wr < 0.72 ? 3 : 4;
    let N = Math.min(want, roomMax);
    if (N < 2) return null;
    const spacing = 2 * maxOuter / (N - 1);
    const offs = [];
    for (let i = 0; i < N; i++) offs.push((i - (N - 1) / 2) * spacing);   // symmetric lane offsets, left→right
    // CENTER LANE FIX: for odd N the middle lane has offs=0 (it runs on the spine and never
    // diverges visually). Give it a seeded offset of ~35-45% of spacing toward one side so
    // it reads as a clearly distinct path between the outer lanes.
    if (N % 2 === 1) {
      const cIdx = (N - 1) / 2;
      const cSign = rng() < 0.5 ? 1 : -1;
      offs[cIdx] = cSign * spacing * (0.35 + rng() * 0.10);   // 35–45% of spacing, seeded side
    }

    // WANDER is active ONLY in the flat HOLD (where the spread adds no lateral slope), so its turns
    // never stack on the fan-out slope and fold the lane. Amplitude is bounded so neighbours can't touch.
    const holdNodes = Math.max(1, (1 - 2 * RAMP) * lenF);
    const wanderAmp = Math.max(0, Math.min(0.05 * holdNodes, (spacing - 2 * LW) * 0.34, maxOuter * 0.5));
    const holdWin = (t) => sstep(RAMP * 0.6, RAMP, t) * (1 - sstep(1 - RAMP, 1 - RAMP * 0.6, t));

    const mkWave = (amp, maxFreq) => {
      const comps = [], n = 2 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) comps.push({ f: 1 + Math.floor(rng() * maxFreq), p: rng() * 6.2832, a: 0.5 + rng() });
      const tot = comps.reduce((s, c) => s + c.a, 0) || 1;
      return (t) => { let s = 0; for (const c of comps) s += c.a * Math.sin(c.f * 6.2832 * t + c.p); return (s / tot) * Math.sin(Math.PI * t) * amp; };
    };

    // ---- build the N lanes: WIDE spread + its own wander in-region; strictly descending ----
    const route = [];
    for (let i = 0; i < N; i++) {
      // each lane's own low-frequency S-curve wander (different per lane via random phase)
      const wc = []; const wn = 1 + Math.floor(rng() * 2);
      for (let j = 0; j < wn; j++) wc.push({ f: 1 + Math.floor(rng() * 2), p: rng() * 6.2832, a: 0.5 + rng() });
      const wtot = wc.reduce((s, c) => s + c.a, 0) || 1;
      const wander = (t) => { let s = 0; for (const c of wc) s += c.a * Math.sin(c.f * 6.2832 * t + c.p); return (s / wtot) * wanderAmp; };
      const slopeWave = mkWave(2.0, 2);
      // per-lane FUNNELS: 0-2 width pinches (bottlenecks) in the spread region. They only NARROW the
      // lane, so the gap to neighbouring lanes only grows — never causes overlap or fall-through.
      const ffeats = []; const fcount = Math.floor(rng() * 3);   // 0, 1, or 2 funnels on this lane
      for (let j = 0; j < fcount; j++) {
        const narrower = rng() < 0.4;
        ffeats.push({ at: 0.28 + 0.44 * rng(), w: narrower ? 0.07 + rng()*0.05 : 0.045 + rng()*0.03, minW: 0.44 + rng()*0.16 });
      }
      const lat = [], yy = [], bnk = [], wid = [];
      for (let k = 0; k <= lenF; k++) {
        const t = k / lenF, eT = eTaper(t);
        const L = offs[i] * shape(k) + wander(t) * holdWin(t) * eT;   // wide spread + in-region wander
        const Y = slopeWave(t) * eT;                                   // gentle monotonic Y wiggle (no valley)
        let wmul = 1;                                                  // width pinch from this lane's funnels
        for (const ff of ffeats) { const z = (t - ff.at) / ff.w; wmul = Math.min(wmul, 1 - (1 - ff.minW) * Math.exp(-z * z)); }
        lat.push(L); yy.push(Y); bnk.push(0); wid.push(LW * wmul);
      }
      route.push({ lat, yy, bnk, wid });
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
        const node = { pos: v(c.x, c.y, c.z), dir, right, up, halfW: R.wid[k], bank: 0, kind: 'route', tunnel: false, branchId: bid };
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

    // ---- spine through the fan: skip mesh entirely (branches carry all floor+walls) ----
    // The outer branch walls at k=0 and k=lenF are widened to match the spine so there's
    // no visible seam or gap at the junction. Spine meshSkip from k=0..lenF inclusive.
    for (let k = 0; k <= lenF; k++) {
      const m = mainNodes[splitIdx + k];
      if (m._baseHalfW == null) m._baseHalfW = m.halfW;
      // Keep the two MOUTH nodes (k=0, k=lenF) as real mesh — buildMesh needs a valid
      // 'prev' to connect the spine's last good quad INTO the fork, and a valid node to
      // connect OUT of it on the far side. Skipping them left a floating gap (no quad)
      // right where the spine met the fan. Only the strict interior is skipped (lanes
      // carry their own floor/walls there).
      if (k > 0 && k < lenF) m.meshSkip = true;
    }
    // Widen the outermost branch nodes at mouths (k=0 and k=lenF) to cover the full spine
    // width, so the branch wall meets the spine wall flush with no gap.
    const outerL = branchOrder[0], outerR = branchOrder[branchOrder.length - 1];
    for (const bid of branchOrder) {
      const arr = branches[bid];
      const isLeft = bid === outerL, isRight = bid === outerR;
      for (const ki of [0, lenF]) {
        const nd = arr[ki], spine = mainNodes[splitIdx + ki];
        // At mouths, widen this lane out to the spine's outer half-width so walls flush
        // The outermost lanes are responsible for covering the full outer wall span.
        if (isLeft) { nd.halfW = Math.max(nd.halfW, Math.abs(route[0].lat[ki]) + spine.halfW * 0.15); }
        if (isRight) { nd.halfW = Math.max(nd.halfW, Math.abs(route[N-1].lat[ki]) + spine.halfW * 0.15); }
        // Remove inner walls at mouths so adjacent branches merge cleanly
        if (!isLeft)  nd.noWallL = true;
        if (!isRight) nd.noWallR = true;
      }
    }

    const rejoinIdx = {}, ends = [];
    for (const bid of branchOrder) { rejoinIdx[bid] = end; ends.push(branches[bid][lenF]); }
    return { id: forkId, splitIdx, flavor: 'divergent', rejoin: true, lanesOnly: false,
      branches, branchOrder, laneCount: N, rejoinIdx, ends, end };
  }

  // ================= SORTER FORK (v3) =================
  // Replaces the flat fan-out mouth with a literal sorting funnel: the trunk narrows into
  // a bowl, the bowl floor has N holes (one per lane), and whichever hole a ball is over
  // when it reaches the bottom is the lane it commits to — same lateral-bin commit logic
  // physics.js already uses, just fed by a bowl instead of a flat fork-mouth node. Each
  // branch's first stretch is a steep, visibly-falling drop-tube that curves back level
  // into the SAME wide-spread-and-wander body the old fan used — so everything downstream
  // (spinners/bumpers/launch-pins/funnels on the branch, mesh/collider building, minimap,
  // physics commit-binning) is completely unchanged. Only the geometry of the mouth and the
  // first ~14 nodes of each branch differ from makeDivergentFork.
  function makeSorterFork(mainNodes, splitIdx, rng, forkId, targetSteps) {
    const steps = targetSteps || (58 + Math.floor(rng() * 16));
    const end = Math.min(mainNodes.length - 6, splitIdx + steps);
    const lenF = end - splitIdx;
    if (lenF < 60) return null;            // need room for the bowl + tubes + body + funnel-back

    const base = mainNodes[splitIdx].halfW;
    let spanH = 0;
    for (let k = splitIdx; k < end; k++) { const a = mainNodes[k].pos, b = mainNodes[k+1].pos; spanH += Math.hypot(b.x-a.x, b.z-a.z); }
    const STEPH = spanH / lenF || 1.2;

    // ---- lane count: same weighting as the old fan (10% single / 30/32/28% for 2/3/4) ----
    const LW = base;
    // HOLE WIDTH FIX: the cone wasn't actually narrowing (confirmed: halfW only shrank from
    // 7.52 to 7.26 across the whole bowl — basically a flat road). Root cause: hole spacing
    // was based on 0.42*LW (a big fraction of the FULL lane width), so packing even 2 holes
    // side by side already needed almost the trunk's entire width, leaving the throat nowhere
    // to actually narrow TO. A hole only needs to be wide enough for a ball plus a little
    // margin — not a full lane — so size it off the ball radius instead. The tube itself can
    // still widen back out to a full lane once it's clear of its neighbors (see TUBE_NODES
    // below); only the tight point right at the hole needs to be ball-sized.
    const holeHalfWBase = Math.max(1.3, LW * 0.10);   // small and ball-scaled (ball radius 0.5,
                                                        // so 1.3 is still ~2.6x ball diameter), with a sane floor
    const BOWL_NODES = 16;                  // approach-taper + cone-narrow, shared trunk geometry
    const TUBE_NODES = 13;                  // steep drop + re-level, PER BRANCH
    // roomMax: how many holes can physically fit packed together at the throat. Each needs
    // roughly 2*holeHalfWBase of its own lateral room, so this is a real physical limit now
    // (not the near-no-op it was when sized off the full lane width).
    let roomMax = 4;
    while (roomMax >= 2 && (holeHalfWBase * (roomMax * 1.1)) > base * 1.7) roomMax--;
    const wr = rng();
    const want = wr < 0.10 ? 1 : wr < 0.40 ? 2 : wr < 0.72 ? 3 : 4;
    let N = Math.min(want, roomMax);
    if (N < 2) return null;

    // ================= TRUNK: a REAL CONE FUNNEL, not a widened flat road =================
    // Two earlier attempts both missed the actual shape of a funnel: first a bowl that
    // NARROWED past where the holes were (a gap in space), then a bowl that WIDENED into a
    // flat platform with notches cut in it (no sense of falling at all — see screenshot,
    // looked like ramps dangling under a deck). A real funnel does the opposite of both:
    // it starts at the trunk's normal width and CONTINUOUSLY NARROWS, with the walls
    // sloping inward, down to a tight throat — like the kitchen funnel it's modeled on.
    // The holes sit packed close together right at that narrow throat (not spread wide),
    // so a ball naturally slides/spirals toward the center as the cone narrows underneath
    // it, and whichever tight hole it ends up over decides its branch.
    const sstep = (a, b, x) => { if (a === b) return x < a ? 0 : 1; let t = (x - a) / (b - a); t = Math.max(0, Math.min(1, t)); return t*t*(3-2*t); };
    const throatHalfW = Math.max(base * 0.16, holeHalfWBase * (N * 1.1));  // just wide enough to fit all N holes snugly side by side — now genuinely narrow
    // CONE_DROP: how much EXTRA the floor plunges (beyond the track's normal per-node
    // descent) as it narrows — this is what makes it read as falling INTO a funnel rather
    // than just driving down a narrowing road. Scales with the cone's own width so small
    // and large funnels both feel proportional.
    const CONE_DROP = (base - throatHalfW) * 1.4;
    for (let k = 0; k <= BOWL_NODES; k++) {
      const m = mainNodes[splitIdx + k];
      if (m._baseHalfW == null) m._baseHalfW = m.halfW;
      const t = k / BOWL_NODES;
      const narrow = sstep(0, 1, t);
      // CONTINUOUS NARROW from the trunk's own width down to the tight throat — never wider
      // than the trunk at any point, unlike the previous (wrong) widening version.
      m.halfW = m._baseHalfW + (throatHalfW - m._baseHalfW) * narrow;
      // extra plunge on top of the node's existing position, eased in so it starts gently
      // and steepens toward the throat (a real cone's walls get steeper near the spout)
      m.pos.y -= CONE_DROP * (narrow * narrow);
      m.kind = 'sorter';
      m.sorterHoles = null;
    }
    const throatNode0 = mainNodes[splitIdx + BOWL_NODES];
    // Holes packed in a tight row spanning just inside the throat's own (already narrow)
    // width — this is the actual fix for "no funnel, ramps in the wrong place": previously
    // holeOffs were computed from totally separate geometry (maxOuter, based on a desired
    // spread) with no relationship to where the cone actually narrows to. Now they're a
    // direct fraction of throatHalfW, guaranteed to fit, guaranteed close together.
    const holeSpan = throatHalfW * 0.78;
    const holeOffs = [];
    for (let i = 0; i < N; i++) holeOffs.push(N > 1 ? (i - (N - 1) / 2) * (2 * holeSpan / (N - 1)) : 0);
    throatNode0.sorterHoles = holeOffs.slice();
    throatNode0.commitHalfW = throatHalfW;

    // ---- CONE SURFACE MESH: a true radial cone (not a flat strip), built independently of
    // the regular per-node left/right floor strip. Each ring around the cone is drawn at
    // the node's actual (narrowing) halfW, but swept through several angular SEGMENTS
    // rather than just two edge points — that's what makes it read as a curved funnel
    // surface instead of a flat road that happens to get narrower. The regular straight-
    // strip floor for these nodes is skipped (meshSkip) so this is the only floor drawn. ----
    const CONE_SEGMENTS = 10;        // angular resolution of the funnel wall
    const coneMeshPos = [], coneMeshIdx = [];
    let coneBase = 0;
    const pushTri = (a, b, c) => {
      coneMeshPos.push(a.x,a.y,a.z, b.x,b.y,b.z, c.x,c.y,c.z);
      coneMeshIdx.push(coneBase, coneBase+1, coneBase+2);
      coneBase += 3;
    };
    // ring(k, ang) -> a point on the cone's surface at node k, swept angle 'ang' across the
    // node's local right/up plane (ang=-1 is the far-left floor edge, +1 far-right, with a
    // cosine sweep so the cross-section bulges down into a rounded basin between them,
    // rather than a flat V — closer to the photo's smooth conical bowl).
    const ringPoint = (k, ang) => {
      const m = mainNodes[splitIdx + k];
      const lateral = ang * m.halfW;
      const dip = (1 - Math.cos(ang * Math.PI * 0.5)) * m.halfW * 0.35;   // rounds the cross-section into a basin
      return v(m.pos.x + m.right.x * lateral, m.pos.y - dip, m.pos.z + m.right.z * lateral);
    };
    for (let k = 0; k < BOWL_NODES; k++) {
      for (let s = 0; s < CONE_SEGMENTS; s++) {
        const a0 = -1 + (2 * s) / CONE_SEGMENTS, a1 = -1 + (2 * (s + 1)) / CONE_SEGMENTS;
        const p00 = ringPoint(k, a0), p01 = ringPoint(k, a1);
        const p10 = ringPoint(k + 1, a0), p11 = ringPoint(k + 1, a1);
        pushTri(p00, p10, p11);
        pushTri(p00, p11, p01);
      }
      mainNodes[splitIdx + k].meshSkip = true;   // the cone mesh is the only floor here
    }
    const coneFloorMesh = { positions: new Float32Array(coneMeshPos), indices: new Uint32Array(coneMeshIdx) };

    // ---- THROAT DISC: the small flat ring at the very bottom of the cone, with the N
    // holes cut into it as real gaps — same slatted-strip technique as before, just now
    // operating on a TIGHT throat instead of a wide platform, which is the actual fix. ----
    const HOLE_NODES = Math.min(6, BOWL_NODES - 1);
    const holeMeshPos = [], holeMeshIdx = [];
    let holeBase = 0;
    const pushQuadLocal = (a, b, c, d) => {
      holeMeshPos.push(a.x,a.y,a.z, b.x,b.y,b.z, c.x,c.y,c.z, d.x,d.y,d.z);
      holeMeshIdx.push(holeBase, holeBase+1, holeBase+2, holeBase, holeBase+2, holeBase+3);
      holeBase += 4;
    };
    const holeHalfW = holeHalfWBase * 0.92;   // slightly inside the tube's own width so the tube wall is just visible at the rim, not floating past the gap edge
    for (let k = BOWL_NODES - HOLE_NODES; k < BOWL_NODES; k++) {
      const m0 = mainNodes[splitIdx + k], m1 = mainNodes[splitIdx + k + 1];
      const tOpen0 = Math.max(0, (k - (BOWL_NODES - HOLE_NODES)) / HOLE_NODES);
      const tOpen1 = Math.max(0, (k + 1 - (BOWL_NODES - HOLE_NODES)) / HOLE_NODES);
      const open0 = sstep(0, 1, tOpen0), open1 = sstep(0, 1, tOpen1);
      const edges0 = [-m0.halfW], edges1 = [-m1.halfW];
      for (const off of holeOffs) {
        edges0.push(off - holeHalfW * open0, off + holeHalfW * open0);
        edges1.push(off - holeHalfW * open1, off + holeHalfW * open1);
      }
      edges0.push(m0.halfW); edges1.push(m1.halfW);
      for (let i = 0; i < edges0.length - 1; i += 2) {
        const aL = edges0[i], aR = edges0[i+1], bL = edges1[i], bR = edges1[i+1];
        if (aR - aL < 0.02 && bR - bL < 0.02) continue;
        const p = (m, off) => v(m.pos.x + m.right.x * off, m.pos.y, m.pos.z + m.right.z * off);
        pushQuadLocal(p(m0, aL), p(m0, aR), p(m1, bR), p(m1, bL));
      }
    }
    const holeFloorMesh = { positions: new Float32Array(holeMeshPos), indices: new Uint32Array(holeMeshIdx) };

    // ================= PER-BRANCH: drop-tube (steep + visible) -> body (old fan's lane shape) =================
    const branches = {}, branchOrder = [];
    const throatNode = throatNode0;
    const bodyStart = BOWL_NODES + TUBE_NODES;          // where the old fan's wander/funnel body begins
    const bodyLen = lenF - bodyStart;
    if (bodyLen < 20) return null;                       // not enough room left for a real body

    // body shape helpers (same math as the old fan, scoped to [bodyStart, lenF])
    const RAMP = 0.30;
    const shape = (k) => { const t = (k - bodyStart) / (bodyLen); if (t < RAMP) return sstep(0, RAMP, t); if (t > 1 - RAMP) return 1 - sstep(1 - RAMP, 1, t); return 1; };
    const eTaper = (t) => { const er = Math.min(1, t / 0.16, (1 - t) / 0.16); const e = Math.max(0, er); return e*e*(3-2*e); };
    const bodySLOPE = 0.62, bodyFanLenH = RAMP * bodyLen * STEPH, bodyMaxOuter = bodySLOPE * bodyFanLenH;
    const holdNodes = Math.max(1, (1 - 2 * RAMP) * bodyLen);
    // bodySpacing computed just below — wanderAmp needs it for the "neighbours can't touch"
    // bound, so it's derived first from the body's own lane layout instead of the funnel's
    // old (now-removed) wide hole spacing.
    const bodySpacingForWander = N > 1 ? 2 * bodyMaxOuter / (N - 1) : bodyMaxOuter;
    const wanderAmp = Math.max(0, Math.min(0.05 * holdNodes, (bodySpacingForWander - 2 * LW) * 0.34, bodyMaxOuter * 0.5));
    const holdWin = (t) => sstep(RAMP * 0.6, RAMP, t) * (1 - sstep(1 - RAMP, 1 - RAMP * 0.6, t));
    const mkWave = (amp, maxFreq) => {
      const comps = [], n = 2 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) comps.push({ f: 1 + Math.floor(rng() * maxFreq), p: rng() * 6.2832, a: 0.5 + rng() });
      const tot = comps.reduce((s, c) => s + c.a, 0) || 1;
      return (t) => { let s = 0; for (const c of comps) s += c.a * Math.sin(c.f * 6.2832 * t + c.p); return (s / tot) * Math.sin(Math.PI * t) * amp; };
    };
    // re-derive each lane's body offset relative to bodyStart (same symmetric layout as holes,
    // possibly re-spread a bit wider than the tight holes since the body has more room)
    const bodyMaxSpread = bodyMaxOuter;
    const bodySpacing = N > 1 ? 2 * bodyMaxSpread / (N - 1) : 0;
    const bodyOffs = [];
    for (let i = 0; i < N; i++) bodyOffs.push((i - (N - 1) / 2) * bodySpacing);
    if (N % 2 === 1) {
      const cIdx = (N - 1) / 2;
      const cSign = rng() < 0.5 ? 1 : -1;
      bodyOffs[cIdx] = cSign * bodySpacing * (0.35 + rng() * 0.10);
    }

    for (let i = 0; i < N; i++) {
      const bid = forkId + '_' + i; branchOrder.push(bid);
      const holeOff = holeOffs[i];
      const nlist = [];

      // ---- DROP-TUBE: steep near-vertical fall from the throat, curving back to level ----
      // Heading dives toward straight-down over the first half of the tube, then eases back
      // up toward the trunk's forward direction over the second half — a visible "fell
      // through, now recovering" arc, landing right where the body section picks up.
      let pos = v(throatNode.pos.x + throatNode.right.x * holeOff, throatNode.pos.y, throatNode.pos.z + throatNode.right.z * holeOff);
      const fwd0 = norm(v(throatNode.dir.x, throatNode.dir.y, throatNode.dir.z));
      let heading = v(fwd0.x, fwd0.y, fwd0.z);
      const tubeHW = holeHalfWBase;        // matches the hole it actually fell through — was LW*0.42
                                            // (way wider than the hole), now sized exactly to it
      for (let k = 0; k < TUBE_NODES; k++) {
        const t = k / TUBE_NODES;
        // dive steep over the first 55%, recover over the back 45% (smooth, no kink)
        const diveT = sstep(0, 0.55, t);
        const recoverT = sstep(0.45, 1, t);
        const targetDip = -0.92;           // near-vertical at the steepest point
        const dip = targetDip * diveT * (1 - recoverT) + (-0.30) * recoverT;  // settle to the body's normal descent
        heading.y += (dip - heading.y) * 0.35;
        heading = norm(heading);
        pos = add(pos, scale(heading, STEPH));
        const right = norm(cross(heading, worldUp));
        const up = norm(cross(right, heading));
        // width: starts at the tight tube width, eases to the body's lane width by the end
        const hw = tubeHW + (LW - tubeHW) * sstep(0.5, 1, t);
        nlist.push({
          pos: v(pos.x, pos.y, pos.z), dir: v(heading.x, heading.y, heading.z), right, up,
          halfW: hw, bank: 0, kind: 'tube', tunnel: false, branchId: bid,
          // tubes are fully enclosed (walled all the way round, no inner-merge logic needed —
          // they're far apart right after the bowl) until they widen into the body.
        });
      }

      // ---- BODY: same wander/funnel-pinch shape the old fan used, picking up from the tube's end ----
      const tubeEnd = nlist[nlist.length - 1];
      const wc = []; const wn = 1 + Math.floor(rng() * 2);
      for (let j = 0; j < wn; j++) wc.push({ f: 1 + Math.floor(rng() * 2), p: rng() * 6.2832, a: 0.5 + rng() });
      const wtot = wc.reduce((s, c) => s + c.a, 0) || 1;
      const wander = (t) => { let s = 0; for (const c of wc) s += c.a * Math.sin(c.f * 6.2832 * t + c.p); return (s / wtot) * wanderAmp; };
      const slopeWave = mkWave(2.0, 2);
      const ffeats = []; const fcount = Math.floor(rng() * 3);
      for (let j = 0; j < fcount; j++) {
        const narrower = rng() < 0.4;
        ffeats.push({ at: 0.28 + 0.44 * rng(), w: narrower ? 0.07 + rng()*0.05 : 0.045 + rng()*0.03, minW: 0.44 + rng()*0.16 });
      }
      const raw = [];
      // DEPTH CARRY: the tube already dove well below the trunk centerline (that's the
      // whole point — a dramatic visible drop). The body must pick up from EXACTLY that
      // depth, not snap back to the trunk's height, or there's a 1-2 unit upward teleport
      // at the tube/body seam. extraDepth is how far below the trunk the tube landed; it
      // decays smoothly to 0 over the first RAMP*1.4 fraction of the body (a bit slower
      // than the lateral ease-in, so the vertical recovery reads as smooth, not abrupt),
      // by which point the lane is back on the trunk's natural ongoing descent and free to
      // ride the small Y-wiggle like every other section.
      const tubeM0 = mainNodes[splitIdx + bodyStart];
      const extraDepth = tubeEnd.pos.y - tubeM0.pos.y;   // negative: how far below trunk the tube ended
      for (let k = bodyStart; k <= lenF; k++) {
        const m = mainNodes[splitIdx + k];
        const t = (k - bodyStart) / bodyLen, eT = eTaper(t);
        // body offset is RELATIVE TO THE TUBE'S LANDING SPOT, not the trunk centerline —
        // it eases from the tube's exit position into the body's normal wide-spread shape
        // over the first RAMP fraction, exactly like the old fan eased out of the mouth.
        const bodyTarget = bodyOffs[i] * shape(k) + wander(t) * holdWin(t) * eT;
        const easeFromTube = 1 - sstep(0, RAMP * 0.7, t);
        const tubeLat = (tubeEnd.pos.x - m.pos.x) * m.right.x + (tubeEnd.pos.z - m.pos.z) * m.right.z;
        const L = bodyTarget * (1 - easeFromTube) + tubeLat * easeFromTube;
        const Y = slopeWave(t) * eT;
        const depthCarry = extraDepth * (1 - sstep(0, RAMP * 1.4, t));   // smoothly recover to 0
        let wmul = 1;
        for (const ff of ffeats) { const z = (t - ff.at) / ff.w; wmul = Math.min(wmul, 1 - (1 - ff.minW) * Math.exp(-z * z)); }
        // Y BASE: the main centerline's OWN steadily-descending Y at this index (m.pos.y),
        // plus the depth carried over from the tube (recovering to 0), plus the small
        // wiggle on top — matches the original fan's invariant (steady descent dominates
        // the wiggle) while still landing exactly where the tube left off, no seam.
        raw.push({ x: m.pos.x + m.right.x * L, y: m.pos.y + depthCarry + Y, z: m.pos.z + m.right.z * L, w: LW * wmul });
      }
      for (let k = 0; k < raw.length; k++) {
        const c = raw[k], nx = raw[Math.min(raw.length - 1, k + 1)], pv = raw[Math.max(0, k - 1)];
        let dir = norm(v(nx.x - pv.x, nx.y - pv.y, nx.z - pv.z));
        if (Math.hypot(nx.x - pv.x, nx.z - pv.z) < 1e-4) dir = norm(v(tubeEnd.dir.x, tubeEnd.dir.y, tubeEnd.dir.z));
        const right = norm(cross(dir, worldUp)), up = norm(cross(right, dir));
        nlist.push({ pos: v(c.x, c.y, c.z), dir, right, up, halfW: c.w, bank: 0, kind: 'route', tunnel: false, branchId: bid });
      }

      // banking through the body (same as the old fan)
      const bodyOffsetInList = TUBE_NODES;
      const BANK_GAIN = 5.0, BANK_MAX = 0.34;
      for (let k = bodyOffsetInList + 1; k < nlist.length - 1; k++) {
        const h0 = Math.atan2(nlist[k-1].dir.x, nlist[k-1].dir.z), h1 = Math.atan2(nlist[k+1].dir.x, nlist[k+1].dir.z);
        let dh = h1 - h0; while (dh > Math.PI) dh -= 6.2832; while (dh < -Math.PI) dh += 6.2832;
        nlist[k].bank = Math.max(-BANK_MAX, Math.min(BANK_MAX, dh * BANK_GAIN)) * Math.sin(Math.PI * (k - bodyOffsetInList) / (nlist.length - bodyOffsetInList));
      }

      // wall gaps between lanes in the BODY region only (tubes are far apart and self-walled)
      branches[bid] = nlist;
    }

    // body-region wall-merge logic, same SAFEGAP rule as the old fan, applied only to the
    // body nodes (index >= TUBE_NODES in each branch's list)
    const SAFEGAP = 0.8;
    for (let i = 0; i < N; i++) {
      const bid = branchOrder[i], nlist = branches[bid];
      for (let k = TUBE_NODES; k < nlist.length; k++) {
        const bk = k - TUBE_NODES;
        if (i > 0) {
          const left = branches[branchOrder[i-1]][k];
          const gapL = Math.hypot(nlist[k].pos.x - left.pos.x, nlist[k].pos.z - left.pos.z) - nlist[k].halfW - left.halfW;
          if (gapL < SAFEGAP) nlist[k].noWallL = true;
        }
        if (i < N - 1) {
          const right = branches[branchOrder[i+1]][k];
          const gapR = Math.hypot(right.pos.x - nlist[k].pos.x, right.pos.z - nlist[k].pos.z) - nlist[k].halfW - right.halfW;
          if (gapR < SAFEGAP) nlist[k].noWallR = true;
        }
      }
    }

    // mark the trunk fully meshSkip from the throat onward (branches carry their own floor
    // from here — there is no shared floor past the bowl, only N independent tubes)
    for (let k = BOWL_NODES + 1; k <= lenF; k++) {
      const m = mainNodes[splitIdx + k];
      m.meshSkip = true;
    }

    const rejoinIdx = {}, ends = [];
    for (const bid of branchOrder) { rejoinIdx[bid] = end; ends.push(branches[bid][branches[bid].length - 1]); }
    return { id: forkId, splitIdx, flavor: 'divergent', rejoin: true, lanesOnly: false,
      branches, branchOrder, laneCount: N, rejoinIdx, ends, end, isSorter: true, throatIdx: splitIdx + BOWL_NODES,
      coneFloorMesh, holeFloorMesh };
  }

  // ================= GRAVITY WELL FORK (v4) =================
  // The actual "coin funnel" toy mechanic: a ball arrives moving forward, enters a circular
  // well, and SPIRALS — orbiting the center multiple times while both its radius and height
  // shrink — before dropping through whichever of N holes its final angle lands on. This is
  // a fundamentally different mechanic from makeSorterFork (which bins a ball's lateral
  // position once at a flat/conical mouth): here the ball's actual path bends into a curve
  // and circles, which is the part a flat node-strip can never represent — so the orbit
  // itself is handled entirely in physics.js as a SCRIPTED motion (startWellOrbit /
  // processWellOrbit), not by walking a node list. This function only needs to: (1) place
  // the well's center/geometry, (2) mark where physics should intercept the ball
  // (entryIdx), and (3) build the post-well branches — which reuse the exact same
  // tube-then-body shape makeSorterFork uses, just starting from the well's exit ring
  // instead of from flat hole offsets.
  function makeWellFork(mainNodes, splitIdx, rng, forkId, targetSteps) {
    const steps = targetSteps || (58 + Math.floor(rng() * 16));
    const end = Math.min(mainNodes.length - 6, splitIdx + steps);
    const lenF = end - splitIdx;
    if (lenF < 50) return null;            // need room for the approach + well + branches

    const base = mainNodes[splitIdx].halfW;
    let spanH = 0;
    for (let k = splitIdx; k < end; k++) { const a = mainNodes[k].pos, b = mainNodes[k+1].pos; spanH += Math.hypot(b.x-a.x, b.z-a.z); }
    const STEPH = spanH / lenF || 1.2;
    const LW = base;

    const wr = rng();
    const want = wr < 0.10 ? 1 : wr < 0.40 ? 2 : wr < 0.72 ? 3 : 4;
    let N = want;
    if (N < 2) return null;   // a 1-lane "well" wouldn't read as a sort at all — skip, same as the sorter

    // ---- APPROACH: a short straight run leading into the well's rim, so the ball arrives
    // at a predictable point moving in a predictable direction (tangent to the rim). ----
    const APPROACH_NODES = 10;
    for (let k = 0; k <= APPROACH_NODES; k++) {
      const m = mainNodes[splitIdx + k];
      m.kind = 'sorter';   // reuse the same lane-pull treatment as the sorter's bowl approach
    }
    const entryNode = mainNodes[splitIdx + APPROACH_NODES];
    const entryIdx = splitIdx + APPROACH_NODES;

    // ---- WELL GEOMETRY: center sits ahead of the entry point along its current heading,
    // offset so the entry node sits exactly on the rim (rOuter). ----
    const rOuter = LW * 2.6;             // wide enough to feel like a real basin, not a pinch
    const rInner = Math.max(1.6, LW * 0.22);   // tight throat where the holes live
    const fwd = norm(v(entryNode.dir.x, entryNode.dir.y, entryNode.dir.z));
    const cx = entryNode.pos.x + fwd.x * rOuter;
    const cz = entryNode.pos.z + fwd.z * rOuter;
    const yTop = entryNode.pos.y;
    const DROP = (rOuter - rInner) * 1.3 + LW * 1.5;   // total descent through the well — generous, reads as a real drop
    const yBottom = yTop - DROP;
    const revolutions = 2.4 + rng() * 1.3;     // 2.4–3.7 full loops, like a real coin funnel
    const duration = 2.6 + rng() * 0.9;        // seconds the spiral lasts — tuned live if needed
    // ORBIT DIRECTION: seeded once per well (every ball that enters spins the same way —
    // see physics.js startWellOrbit for why this moved from a per-ball computation).
    const dir = rng() < 0.5 ? 1 : -1;

    // ---- WELL CONE MESH: an actual cone of revolution — a full 360° sweep at each height
    // ring, narrowing from rOuter down to rInner — unlike the earlier (broken) sorter
    // attempt, which only offset a flat strip sideways and could never look like a real
    // funnel from any angle. This is true polar geometry: every ring is a full circle. ----
    const CONE_RINGS = 14, CONE_SEGS = 28;
    const coneMeshPos = [], coneMeshIdx = [];
    let coneBase = 0;
    const pushTri = (a, b, c) => {
      coneMeshPos.push(a.x,a.y,a.z, b.x,b.y,b.z, c.x,c.y,c.z);
      coneMeshIdx.push(coneBase, coneBase+1, coneBase+2);
      coneBase += 3;
    };
    // ringPoint(ringT, ang) -> a point on the cone's surface. ringT 0=rim (rOuter,yTop),
    // ringT 1=throat (rInner,yBottom). A gentle spiral-groove offset is added to the radius
    // so the surface itself visually hints at the spiral path balls actually take.
    const ringPoint = (ringT, ang) => {
      const ease = ringT * ringT * (3 - 2 * ringT);
      const r = rOuter + (rInner - rOuter) * ease;
      const y = yTop + (yBottom - yTop) * ease;
      const groove = Math.sin(ang * 5 + ringT * revolutions * 6.2832) * (rOuter - rInner) * 0.02;
      return v(cx + Math.cos(ang) * (r + groove), y, cz + Math.sin(ang) * (r + groove));
    };
    for (let ri = 0; ri < CONE_RINGS; ri++) {
      const t0 = ri / CONE_RINGS, t1 = (ri + 1) / CONE_RINGS;
      for (let s = 0; s < CONE_SEGS; s++) {
        const a0 = (s / CONE_SEGS) * 6.2832, a1 = ((s + 1) / CONE_SEGS) * 6.2832;
        const p00 = ringPoint(t0, a0), p01 = ringPoint(t0, a1);
        const p10 = ringPoint(t1, a0), p11 = ringPoint(t1, a1);
        pushTri(p00, p10, p11);
        pushTri(p00, p11, p01);
      }
    }
    const wellConeMesh = { positions: new Float32Array(coneMeshPos), indices: new Uint32Array(coneMeshIdx) };
    // small flat throat disc at the very bottom, with N holes cut in (same slatted-gap
    // technique as the sorter's throat disc, just operating on a circular ring instead of
    // a straight strip — built from short radial wedges between consecutive holes).
    const holeMeshPos = [], holeMeshIdx = [];
    let holeBase = 0;
    const pushQuadLocal = (a, b, c, d) => {
      holeMeshPos.push(a.x,a.y,a.z, b.x,b.y,b.z, c.x,c.y,c.z, d.x,d.y,d.z);
      holeMeshIdx.push(holeBase, holeBase+1, holeBase+2, holeBase, holeBase+2, holeBase+3);
      holeBase += 4;
    };
    const holeAngWidth = Math.min(0.9, (2 * Math.PI / N) * 0.35);   // angular width of each hole's gap
    const discOuterR = rInner * 1.4, discInnerR = rInner * 0.35;
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * 6.2832 + holeAngWidth, a1 = ((i + 1) / N) * 6.2832 - holeAngWidth;
      if (a1 <= a0) continue;   // holes wide enough to have eaten this whole wedge
      const WEDGE_SEGS = 4;
      for (let s = 0; s < WEDGE_SEGS; s++) {
        const wa0 = a0 + (a1 - a0) * (s / WEDGE_SEGS), wa1 = a0 + (a1 - a0) * ((s + 1) / WEDGE_SEGS);
        const pOuter0 = v(cx + Math.cos(wa0) * discOuterR, yBottom, cz + Math.sin(wa0) * discOuterR);
        const pOuter1 = v(cx + Math.cos(wa1) * discOuterR, yBottom, cz + Math.sin(wa1) * discOuterR);
        const pInner0 = v(cx + Math.cos(wa0) * discInnerR, yBottom, cz + Math.sin(wa0) * discInnerR);
        const pInner1 = v(cx + Math.cos(wa1) * discInnerR, yBottom, cz + Math.sin(wa1) * discInnerR);
        pushQuadLocal(pInner0, pOuter0, pOuter1, pInner1);
      }
    }
    const wellHoleFloorMesh = { positions: new Float32Array(holeMeshPos), indices: new Uint32Array(holeMeshIdx) };

    // ---- N holes arranged in a ring at rInner, equal angular slices (matches the binning
    // physics.js does on the ball's final orbit angle). Branches start at each hole. ----
    const branches = {}, branchOrder = [];
    const BRANCH_LEN = Math.max(40, lenF - APPROACH_NODES - 6);
    for (let i = 0; i < N; i++) {
      const bid = forkId + '_' + i; branchOrder.push(bid);
      const holeAng = (i / N) * 6.2832;
      const hx = cx + Math.cos(holeAng) * rInner, hz = cz + Math.sin(holeAng) * rInner;
      // outward-facing tangent direction at this hole — branches lead AWAY from the well's
      // center, radially outward, which reads naturally as "exiting" the funnel.
      const outDir = norm(v(Math.cos(holeAng), -0.55, Math.sin(holeAng)));
      const nlist = [];
      let pos = v(hx, yBottom, hz);
      let heading = v(outDir.x, outDir.y, outDir.z);
      const TUBE_NODES = 11;
      // TUBE WIDTH FIX: confirmed in simulation that two balls landing in the same branch
      // (still possible even with per-ball revolution jitter spreading entries — it's random
      // chance, not guaranteed separation) get forced into violent contact in a tube sized
      // for exactly one ball (radius 0.5, collider ring radius 0.75), and the resulting
      // separation impulse flings one of them off the edge. A tube needs room for at least
      // two ball-colliders side by side with margin: 2 * 0.75 * ~2 = ~3 minimum. The hole
      // at the very top (where it visually reads as "one ball, one hole") stays tight —
      // only the tube's WIDTH widens quickly just below the hole, which still looks like a
      // single-ball drop from above while giving real room once two balls are both inside.
      const tubeHW = Math.max(3.0, LW * 0.18);
      for (let k = 0; k < TUBE_NODES; k++) {
        const t = k / TUBE_NODES;
        const recoverT = sstepW(0.35, 1, t);
        heading.y += ((-0.30) - heading.y) * 0.3 * recoverT + ((outDir.y) - heading.y) * 0.3 * (1 - recoverT);
        heading = norm(heading);
        pos = add(pos, scale(heading, STEPH));
        const right = norm(cross(heading, worldUp));
        const up = norm(cross(right, heading));
        const hw = tubeHW + (LW - tubeHW) * sstepW(0.4, 1, t);
        nlist.push({ pos: v(pos.x, pos.y, pos.z), dir: v(heading.x, heading.y, heading.z), right, up,
          halfW: hw, bank: 0, kind: 'tube', tunnel: false, branchId: bid });
      }
      // BODY: simple gentle descending continuation (same per-node style as everywhere else
      // on the track) for the remainder of this fork's length, so it merges back into the
      // normal main-path generation afterward.
      const tubeEnd = nlist[nlist.length - 1];
      let bpos = v(tubeEnd.pos.x, tubeEnd.pos.y, tubeEnd.pos.z);
      let bheading = v(tubeEnd.dir.x, tubeEnd.dir.y, tubeEnd.dir.z);
      for (let k = 0; k < BRANCH_LEN; k++) {
        bheading.y += (-0.30 - bheading.y) * 0.08;
        bheading = norm(bheading);
        bpos = add(bpos, scale(bheading, STEPH));
        const right = norm(cross(bheading, worldUp));
        const up = norm(cross(right, bheading));
        nlist.push({ pos: v(bpos.x, bpos.y, bpos.z), dir: v(bheading.x, bheading.y, bheading.z), right, up,
          halfW: LW, bank: 0, kind: 'route', tunnel: false, branchId: bid });
      }
      branches[bid] = nlist;
    }

    // mark the approach-to-rim span meshSkip past the entry point — there is no main-path
    // floor inside the well itself; the well's own visual mesh (built separately, see
    // buildWellMesh) is the only thing drawn there.
    for (let k = APPROACH_NODES + 1; k <= lenF; k++) {
      const m = mainNodes[splitIdx + k];
      if (m) m.meshSkip = true;
    }

    const ends = [];
    for (const bid of branchOrder) ends.push(branches[bid][branches[bid].length - 1]);
    return {
      id: forkId, splitIdx, flavor: 'divergent', rejoin: false, lanesOnly: false, isWell: true,
      branches, branchOrder, laneCount: N, ends, end,
      entryIdx, cx, cz, rOuter, rInner, yTop, yBottom, duration, revolutions, dir,
      wellConeMesh, wellHoleFloorMesh,
    };
  }
  // local smoothstep helper for makeWellFork (same shape as 'sstep' used elsewhere, kept
  // separate so makeWellFork has no ordering dependency on where it's defined relative to
  // makeSorterFork's local sstep)
  function sstepW(a, b, x) { if (a === b) return x < a ? 0 : 1; let t = (x - a) / (b - a); t = Math.max(0, Math.min(1, t)); return t*t*(3-2*t); }

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
        // MIX: roughly a third of splits are the gravity well (the actual coin-funnel
        // spiral), the rest stay the simpler flat-mouth sorter — variety race to race,
        // per direction, rather than every split being the (more elaborate) well.
        const useWell = USE_DIVERGENT && rng() < 0.35;
        const fork = useWell
          ? makeWellFork(mainNodes, at, rng, 'fork'+n, targetSteps)
          : USE_DIVERGENT
            ? makeSorterFork(mainNodes, at, rng, 'fork'+n, targetSteps)   // may be null = NO split (1 lane)
            : makeFork(mainNodes, at, rng, 'fork'+n, true);
        if (fork) {
          n++;
          forks.push(fork);
          forkAtIdx.set(at, fork);
          lastForkEnd = fork.splitIdx + (fork.flavor === 'divergent' ? (span + 30) : 90);
        }
        i = zEnd;   // skip past this zone whether or not a fork was placed
      }
    }
    return { forks, forkAtIdx };
  }

  return { buildForks, makeFork, makeDivergentFork, makeSorterFork, makeWellFork, buildBranch, setDivergent: (b) => { USE_DIVERGENT = !!b; } };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { ZFORK };
