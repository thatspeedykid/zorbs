// ZORBS v2 — Track generator (host-agnostic, no rendering dependency)
// Produces a DOWNHILL descent: the track always loses height, so gravity does the work
// and balls stay planted. Output is pure data: a centerline of nodes + a triangle mesh
// for the floor and walls. The same function runs in a browser tab or a Node server.
//
// Design goals that fix the old bugs:
//  - ONE continuous centerline (no interleaved parallel node sets => no snapping)
//  - Banked turns (the floor tilts into curves) so balls lean in instead of climbing the wall
//  - Seamless mesh: every segment shares its boundary ring with the next (no cracks)
//  - Deterministic from a seed (all tabs/server build the identical course)

const ZTRACK = (() => {
  // ZFORK is a global in the browser; require it in node.
  const _ZFORK = (typeof ZFORK !== 'undefined') ? ZFORK
    : (typeof require !== 'undefined' ? require('./forks.js').ZFORK : null);

  // ---- seeded RNG (mulberry32) so every client builds the same course ----
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // small vector helpers (plain objects, no THREE)
  const v = (x, y, z) => ({ x, y, z });
  const add = (a, b) => v(a.x + b.x, a.y + b.y, a.z + b.z);
  const scale = (a, s) => v(a.x * s, a.y * s, a.z * s);
  const len = (a) => Math.hypot(a.x, a.y, a.z) || 1;
  const norm = (a) => { const l = len(a); return v(a.x / l, a.y / l, a.z / l); };
  const cross = (a, b) => v(
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x
  );

  // The course is a list of "moves" the path makes. Each move advances the centerline.
  // We bias every move to lose a little height (downhill).
  const WIDTH = 7.0;          // track half-width baseline
  const STEP = 1.3;           // finer spacing = smaller facets, smoother look
  const DROP_PER_STEP = 0.42; // average descent per node (the "downhill")

  // COURSE DIRECTOR: instead of rolling a random move every time a segment ends, pre-compose a
  // deliberate SEQUENCE of sections — intro straight → snaking sweeps (alternating direction, the
  // S-curves) with spaced-out drops/spirals/funnels/tunnels → a long final straight. Deterministic
  // from the seed. Each section just feeds the same move params the old random block used, so all
  // the downstream machinery (mesh, physics, forks, boosts, obstacles) is untouched.
  function buildPlan(rng, total) {
    // SECTION-RHYTHM DIRECTOR (MoS-style): a level is a SEQUENCE of distinct set-pieces with
    // pacing — calm stretches between events, never two heavy pieces back-to-back, ONE split
    // somewhere in the middle (fed by a funnel bottleneck), and a funnel scramble at the finish
    // for last-second switch-ups. The split is now just one section, not the whole level.
    const plan = [];
    const intro = 22 + Math.floor(rng() * 10);
    const outro = 16 + Math.floor(rng() * 8);   // short rollout AFTER the finish line (line is at the throat)
    plan.push({ kind: 'straight', len: intro });

    const body = Math.max(220, total - intro - outro - 24); // reserve ~24 for finish scramble
    let used = 0;
    const splitAt = body * (0.28 + rng() * 0.12);  // place the split early-middle so it always fits
    let splitPlaced = false;
    let lastHeavy = false;
    let dir = rng() < 0.5 ? 1 : -1;

    while (used < body - 30) {
      const remaining = body - used;
      // --- place the ONE split, with a funnel bottleneck leading into it ---
      if (!splitPlaced && used >= splitAt && remaining > 250) {
        const fl = 16 + Math.floor(rng() * 8);
        plan.push({ kind: 'funnel', len: fl, min: 0.42 + rng() * 0.12 }); used += fl;
        // long enough to fan out WIDE, wander, funnel in — but always capped to the room left
        const sl = Math.max(220, Math.min(280 + Math.floor(rng() * 120), (body - used) - 45));
        plan.push({ kind: 'straight', len: sl, split: true }); used += sl;
        splitPlaced = true; lastHeavy = true;
        continue;
      }
      let sec;
      const r = rng();
      if (lastHeavy) {
        // forced CALM after a heavy piece (straight or a gentle sweep)
        if (r < 0.5) sec = { kind: 'straight', len: 14 + Math.floor(rng() * 12) };
        else { dir = -dir; sec = { kind: 'sweep', dir, sharp: 0.018 + rng() * 0.014, len: 26 + Math.floor(rng() * 16) }; }
        lastHeavy = false;
      } else {
        // EVENT piece — all of these keep the track DESCENDING (gravity carries the marbles);
        // none of them go uphill. 'drop' is a steeper descent, not a valley.
        if (r < 0.30)      { dir = -dir; sec = { kind: 'sweep',  dir, sharp: 0.026 + rng() * 0.020, len: 28 + Math.floor(rng() * 18) }; lastHeavy = false; }
        else if (r < 0.52) { sec = { kind: 'funnel', len: 16 + Math.floor(rng() * 12), min: 0.40 + rng() * 0.16 }; lastHeavy = true; }
        else if (r < 0.70) { sec = { kind: 'narrower', len: 18 + Math.floor(rng() * 10), min: 0.34 + rng() * 0.10 }; lastHeavy = true; }
        else if (r < 0.86) { sec = { kind: 'drop', len: 12 + Math.floor(rng() * 10), drop: 0.9 + rng() * 0.9 }; lastHeavy = true; }
        else if (r < 0.96) { if (rng() > 0.4) dir = -dir; sec = { kind: 'spiral', dir, len: 28 + Math.floor(rng() * 12) }; lastHeavy = true; }
        else               { sec = { kind: 'tunnel', dir: rng() < 0.5 ? 1 : -1, len: 16 + Math.floor(rng() * 12) }; lastHeavy = false; }
      }
      if (sec.len > remaining - 8) sec.len = Math.max(8, remaining - 8);
      plan.push(sec); used += sec.len;
    }
    // safety: if the level was too short to cross splitAt, force a split now
    if (!splitPlaced) {
      const sl = Math.max(280, body - used - 10);
      plan.push({ kind: 'straight', len: sl, split: true });
    }
    // FINISH SCRAMBLE: a funnel right before the line; the line sits at its throat so the field is
    // bunched as it crosses (photo finishes). Pinch kept gentle (no jam) — placement does the work.
    plan.push({ kind: 'funnel', len: 22 + Math.floor(rng() * 10), min: 0.44 + rng() * 0.10, isFinish: true });
    plan.push({ kind: 'straight', len: outro });
    return plan;
  }

  // Build the centerline as an array of nodes:
  //   { pos, dir, right, up, halfW, bank }  — everything physics & mesh need.
  function buildCenterline(seed, targetNodes, ballCount) {
    const rng = mulberry32(seed);
    const plan = buildPlan(rng, targetNodes);   // course director: deliberate section sequence
    let planIdx = 0;
    const nodes = [];
    ballCount = ballCount || 20;

    // START PLATFORM: flat, wide staging area sized to the field.
    // Default sized for 20 balls; grows in length as the field grows.
    // Rows of ~6 balls; platform fits ceil(balls/6) rows with breathing room.
    const rows = Math.max(4, Math.ceil(ballCount / 6));
    const platformNodes = Math.max(10, Math.min(60, 8 + rows * 2)); // length scales w/ field
    const platformHalfW = Math.max(WIDTH, WIDTH * (0.6 + ballCount / 60)); // width scales too

    // start pointing forward (+z), slightly downhill
    let pos = v(0, 0, 0);
    let heading = norm(v(0, -0.18, 1)); // initial downhill direction

    // a "turn rate" that eases in and out so curves are smooth, not kinked
    let turn = 0;          // current yaw rate (radians/step)
    let targetTurn = 0;    // where turn is easing toward
    let segLeft = 0;       // steps remaining in the current move
    let bank = 0;          // current banking angle
    let targetBank = 0;
    let moveKind = 'straight', extraDrop = 0, funnelMin = 0, tunnel = false;
    let funnelLen = 1, funnelPos = 0, spiralTurn = 0, spiralLen = 1, spiralCooldown = 0;
    // MOGULS: washboard bumps laid into the floor across a section (jostle + separate the pack).
    let moguAmp = 0, moguStep = 0, moguPhase = 0, moguLen = 1;
    // NARROWER: hard width pinch to single-file that holds (a bottleneck), then reopens.
    let narrowMin = 1, narrowLen = 1;
    let curFinish = false, finishMarked = false;   // mark the finish line at the finish-funnel throat
    let curForkZone = false;   // true while laying a marked split-zone (for divergent forks)
    // GENTLE LEVEL WINDING: a smooth low-frequency turn applied through the split-zone so the whole
    // loop bends instead of running dead straight. Amplitude kept tiny (radius >> route offset) so
    // the offset routes follow the bend without the inner one folding/fanning.
    const windComps = [];
    { const wn = 1 + Math.floor(rng() * 2);
      for (let i = 0; i < wn; i++) windComps.push({ f: 0.6 + rng() * 0.9, p: rng() * 6.2832, a: 0.5 + rng() }); }
    const windTot = windComps.reduce((s, c) => s + c.a, 0) || 1;
    const WIND_AMP = 0.0022;
    let splitN = 0, splitLen0 = 1;


    const worldUp = v(0, 1, 0);

    // lay the flat start platform (no descent, extra wide)
    for (let i = 0; i < platformNodes; i++) {
      pos = add(pos, scale(v(0,0,1), STEP)); // straight, flat, +z
      const right = norm(cross(v(0,0,1), worldUp));
      const up = v(0,1,0);
      nodes.push({ pos: {x:pos.x,y:pos.y,z:pos.z}, dir: v(0,0,1), right, up,
        halfW: platformHalfW, bank: 0, kind: 'platform', tunnel: false, isPlatform: true });
    }
    // after the platform, tip into the downhill
    heading = norm(v(0, -0.18, 1));

    for (let i = 0; i < targetNodes; i++) {
      // start a new move when the current one runs out
      if (segLeft <= 0) {
        // COURSE DIRECTOR drives the next move — pop the next planned section and set the same
        // move params the old random block used. Fallback to a straight if the plan is exhausted.
        const sec = plan[planIdx++];
        if (!sec) break;   // plan fully laid (track ends just after the short finish runout) — no filler
        moveKind = 'straight'; extraDrop = 0; funnelMin = 0; tunnel = false;
        curForkZone = (sec.kind === 'straight' && sec.split === true);
        curFinish = !!sec.isFinish;
        if (sec.kind === 'sweep') {
          targetTurn = sec.dir * sec.sharp;
          targetBank = sec.dir * Math.min(0.66, sec.sharp * 11);   // stronger bank → balls carry speed through
          segLeft = sec.len;
        } else if (sec.kind === 'drop') {
          moveKind = 'drop';
          targetTurn = (rng() - 0.5) * 0.02;
          targetBank = 0;
          extraDrop = sec.drop;
          segLeft = sec.len;
        } else if (sec.kind === 'funnel') {
          moveKind = 'funnel';
          targetTurn = (rng() - 0.5) * 0.012;
          targetBank = 0;
          funnelMin = sec.min;
          segLeft = sec.len;
          funnelLen = sec.len;
        } else if (sec.kind === 'spiral') {
          moveKind = 'spiral';
          spiralTurn = sec.dir * (0.045 + rng() * 0.015);
          targetTurn = spiralTurn;
          targetBank = sec.dir * 0.22;
          extraDrop = 0.3 + rng() * 0.18;
          segLeft = sec.len;
          spiralLen = sec.len;
        } else if (sec.kind === 'tunnel') {
          moveKind = 'tunnel';
          targetTurn = sec.dir * (rng() * 0.025);
          targetBank = 0;
          tunnel = true;
          segLeft = sec.len;
        } else if (sec.kind === 'moguls') {
          moveKind = 'moguls';
          targetTurn = (rng() - 0.5) * 0.010;   // basically straight
          targetBank = 0;
          moguAmp = 1.0 + rng() * 0.6;           // bump height (felt, not a launch)
          moguStep = 0.32 + rng() * 0.12;        // radians/node → ~14-18 nodes per bump (gentle crest)
          moguPhase = 0;
          moguLen = sec.len;
          segLeft = sec.len;
        } else if (sec.kind === 'narrower') {
          moveKind = 'narrower';
          targetTurn = (rng() - 0.5) * 0.010;
          targetBank = 0;
          narrowMin = sec.min;                   // throat width fraction (held, not a V)
          narrowLen = sec.len;
          segLeft = sec.len;
        } else {
          // straight — split-zones now WIND gently (set per-node below); plain straights stay ~level
          targetTurn = sec.split ? 0 : (rng() - 0.5) * 0.012;
          targetBank = 0;
          segLeft = sec.len;
          if (sec.split) { splitN = 0; splitLen0 = sec.len; }
        }
      }

      // hold the spiral's strong turn for its whole duration (don't ease it away)
      if (moveKind === 'spiral') targetTurn = spiralTurn;
      if (spiralCooldown > 0) spiralCooldown--;

      // gentle level winding through the split-zone (varies smoothly so the whole loop bends)
      if (curForkZone) {
        const tw = splitLen0 > 0 ? splitN / splitLen0 : 0;
        let w = 0; for (const c of windComps) w += c.a * Math.sin(c.f * 6.2832 * tw + c.p);
        targetTurn = (w / windTot) * WIND_AMP;
        splitN++;
      }

      // ease turn and bank toward their targets (smooth transitions)
      turn += (targetTurn - turn) * 0.12;
      bank += (targetBank - bank) * 0.10;
      // SAFETY: never let the bank exceed what the CURRENT turn can hold. A banked floor
      // with no turn under it just dumps the whole field off the low side — this was the
      // rare "everyone falls at one node" wipe (bank lags the turn as a sweep eases into a
      // straight/spiral, leaving an over-banked flat). Capping bank to the turn rate means
      // it always eases out together with the turn. Banking on real turns is unaffected.
      const bankCap = Math.abs(turn) * 13 + 0.05;
      if (bank >  bankCap) bank =  bankCap;
      if (bank < -bankCap) bank = -bankCap;
      // inside a split-zone, damp stray BANK but let the gentle wind turn stand (the loop bends).
      if (curForkZone) { bank *= 0.5; }

      // rotate heading around world-up by 'turn'
      const cosT = Math.cos(turn), sinT = Math.sin(turn);
      const hx = heading.x * cosT - heading.z * sinT;
      const hz = heading.x * sinT + heading.z * cosT;
      heading = v(hx, heading.y, hz);

      // enforce downhill: keep a downward component on y (steeper during a DROP)
      const dropTarget = -(DROP_PER_STEP * (1 + extraDrop)) / STEP;
      heading.y += (dropTarget - heading.y) * 0.10;
      heading = norm(heading);

      // advance
      pos = add(pos, scale(heading, STEP));

      // right vector (perpendicular, in the horizontal-ish plane)
      const right = norm(cross(heading, worldUp));
      // up vector for the ribbon, tilted by bank
      const up = norm(cross(right, heading));

      // width: gentle base variation; funnel squeezes to a throat then reopens
      let widthFactor = 0.9 + 0.18 * Math.sin(i * 0.06);
      // WIDEN BANKED TURNS: the harder the bank, the faster/sharper the turn, so give the
      // pack more room to hold the line instead of flinging off the high side at speed.
      widthFactor += Math.abs(bank) * 0.9;
      if (moveKind === 'funnel') {
        funnelPos = 1 - (segLeft / funnelLen);        // 0..1 across the funnel
        const throat = 1 - Math.sin(funnelPos * Math.PI) * (1 - funnelMin); // V then back
        widthFactor *= throat;
      } else if (moveKind === 'spiral') {
        // EASE the bowl width in over the first 25% and out over the last 25% so there
        // is no hard step (the 'bump' you saw). smoothstep on both ends.
        const sp = 1 - (segLeft / spiralLen);            // 0..1 through the spiral
        const ramp = Math.min(1, sp/0.25, (1-sp)/0.25);  // 0 at ends, 1 in the middle
        const e = Math.max(0, ramp); const es = e*e*(3-2*e);
        widthFactor *= 1 + 0.45 * es;                    // up to +45% in the middle only
      } else if (moveKind === 'narrower') {
        // PINCH to single-file and HOLD (a bottleneck), easing in/out so there's no hard step.
        const np = 1 - (segLeft / narrowLen);            // 0..1 through the narrower
        const ramp = Math.min(1, np / 0.22, (1 - np) / 0.22); // 0 at ends, 1 across the middle
        const e = Math.max(0, ramp); const es = e * e * (3 - 2 * e);
        widthFactor *= 1 - es * (1 - narrowMin);          // hold ~narrowMin across the plateau
      }
      const halfW = WIDTH * widthFactor;

      const node = { pos: { x: pos.x, y: pos.y, z: pos.z }, dir: heading, right, up, halfW, bank, kind: moveKind, tunnel, forkZone: curForkZone };
      // FINISH LINE at the finish-funnel throat (tightest = field most bunched = photo finishes)
      if (curFinish && !finishMarked && moveKind === 'funnel' && funnelPos >= 0.5) { node.finishLine = true; finishMarked = true; }
      nodes.push(node);
      segLeft--;
    }
    return nodes;
  }

  // Turn the centerline into a triangle mesh (floor + two walls), welded seam-to-seam.
  // Returns { positions:Float32Array, indices:Uint32Array } in a single buffer,
  // plus separate arrays the renderer can use for materials if desired.
  function buildMesh(nodes) {
    const floorPos = [];
    const floorUV = [];
    const wallPos = [];
    const floorIdx = [];
    const wallIdx = [];
    const roofPos = [];
    const roofIdx = [];

    // For each node compute the left/right floor edge and the wall-top edge,
    // applying bank (tilt) so turns lean inward.
    function ring(n) {
      const bankUp = applyBank(n);
      const lf = add(n.pos, scale(n.right, -n.halfW)); // left floor
      const rf = add(n.pos, scale(n.right, n.halfW));  // right floor
      const lw = add(lf, scale(bankUp, 1.5));          // left wall top
      const rw = add(rf, scale(bankUp, 1.5));          // right wall top
      const lc = add(lf, scale(bankUp, 3.2));          // left ceiling
      const rc = add(rf, scale(bankUp, 3.2));          // right ceiling
      return { lf, rf, lw, rw, lc, rc, tunnel: !!n.tunnel,
        noWallL: !!(n.noWalls || n.noWallL), noWallR: !!(n.noWalls || n.noWallR) };
    }
    function applyBank(n) {
      // rotate the up vector around the heading by the bank angle
      const c = Math.cos(n.bank), s = Math.sin(n.bank);
      // Rodrigues-lite around dir axis for the right/up pair
      const u = n.up, r = n.right;
      return norm(v(
        u.x * c + r.x * s,
        u.y * c + r.y * s,
        u.z * c + r.z * s
      ));
    }

    let prev = null;
    let vi = 0, wvi = 0, rvi = 0;
    let vDist = 0;             // cumulative distance along track for the V coordinate
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].meshSkip) { prev = null; continue; }   // gap — no floor/walls here
      const cur = ring(nodes[i]);
      if (prev) {
        const vPrev = vDist;
        vDist += 0.35;          // grid cell pitch along the track
        const vCur = vDist;
        pushQuad(floorPos, floorIdx, prev.lf, prev.rf, cur.rf, cur.lf, vi); vi += 4;
        // UVs matching the quad's vertex order (prev.lf, prev.rf, cur.rf, cur.lf):
        floorUV.push(0, vPrev,  1, vPrev,  1, vCur,  0, vCur);
        // walls — each side can be dropped independently (open Y mouth, leaf edges kept)
        const pLW = prev.tunnel ? prev.lc : prev.lw, pRW = prev.tunnel ? prev.rc : prev.rw;
        const cLW = cur.tunnel ? cur.lc : cur.lw,  cRW = cur.tunnel ? cur.rc : cur.rw;
        if (!prev.noWallL && !cur.noWallL) { pushQuad(wallPos, wallIdx, prev.lf, pLW, cLW, cur.lf, wvi); wvi += 4; }
        if (!prev.noWallR && !cur.noWallR) { pushQuad(wallPos, wallIdx, prev.rf, pRW, cRW, cur.rf, wvi); wvi += 4; }
        // ceiling only where BOTH ends are tunnel
        if (prev.tunnel && cur.tunnel) {
          pushQuad(roofPos, roofIdx, prev.lc, prev.rc, cur.rc, cur.lc, rvi); rvi += 4;
        }
      }
      prev = cur;
    }

    return {
      floor: { positions: new Float32Array(floorPos), indices: new Uint32Array(floorIdx), uvs: new Float32Array(floorUV) },
      walls: { positions: new Float32Array(wallPos), indices: new Uint32Array(wallIdx) },
      roof:  { positions: new Float32Array(roofPos), indices: new Uint32Array(roofIdx) },
    };
  }

  function pushQuad(pos, idx, a, b, c, d, base) {
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  // Build collider buffers. We make TWO: the full one (unused now) and a WALLS+ROOF
  // ONLY one. The floor is handled analytically (smooth height follow) so balls glide
  // instead of catching on floor triangle seams. Walls stay real physics.
  function buildColliderBuffers(nodes) {
    const m = buildMesh(nodes);
    const positions = [];
    const indices = [];
    let base = 0;
    for (const part of [m.walls, m.roof]) {   // NO floor in the collider
      for (let k = 0; k < part.positions.length; k++) positions.push(part.positions[k]);
      for (let k = 0; k < part.indices.length; k++) indices.push(part.indices[k] + base);
      base += part.positions.length / 3;
    }
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
  }

  // Top-level: given a seed and a target length (seconds-ish), produce everything.
  function generate(seed, lengthNodes = 700, ballCount = 20) {
    const nodes = buildCenterline(seed, lengthNodes, ballCount);
    const platformEnd = nodes.findIndex(n => !n.isPlatform);
    const platStart = platformEnd < 0 ? 0 : platformEnd;

    // FORKS: build split routes as a post-pass (deterministic via the same seed stream)
    let forks = [], forkAtIdx = new Map();
    if (_ZFORK) {
      const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
      const built = _ZFORK.buildForks(nodes, platStart, rng);
      forks = built.forks; forkAtIdx = built.forkAtIdx;
    }

    // BOOST PADS (F-Zero side strips). Deterministic via a separate rng so the layout is
    // untouched. MEDIUM mode: a pad zone roughly every ~70 nodes, ~14 nodes long, on BOTH
    // edges (forgiving — hug either side to catch it). Density/side become mode-driven later.
    const boosts = [];
    {
      const brng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
      const GAP_MIN = 55, GAP_VAR = 40, LEN_MIN = 12, LEN_VAR = 8;
      let i = platStart + 30;
      while (i < nodes.length - 40) {
        const len = LEN_MIN + Math.floor(brng() * LEN_VAR);
        let ok = true;
        for (let k = 0; k < len; k++) {
          const nd = nodes[i + k];
          if (!nd || nd.isPlatform || nd.branchId || nd.kind === 'fork' ||
              nd.tunnel || nd.meshSkip || /drum/.test(nd.kind || '')) { ok = false; break; }
        }
        if (ok) {
          const side = 2;   // MEDIUM: both edges boost
          for (let k = 0; k < len; k++) nodes[i + k].boost = side;
          boosts.push({ startIdx: i, endIdx: i + len - 1, side });
          i += len + GAP_MIN + Math.floor(brng() * GAP_VAR);
        } else {
          i += 10;
        }
      }
    }

    // OBSTACLES (bumper pillars): static posts balls bounce off / weave around. Own rng stream
    // so the rest of the layout is untouched. Placed on open nodes — never on platform, forks,
    // tunnels, boost zones or gaps — offset across the width, with a gap between clusters.
    const obstacles = [];
    {
      const orng = mulberry32((seed ^ 0x5bd1e995) >>> 0);
      let i = platStart + 70;
      while (i < nodes.length - 60) {
        const nd = nodes[i];
        const bad = !nd || nd.isPlatform || nd.branchId || nd.kind === 'fork' || nd.tunnel ||
                    nd.boost || nd.meshSkip || /drum/.test(nd.kind || '');
        if (!bad) {
          // ONE bumper, pushed to a side so there's always a clear lane past it — never a pair
          // across the throat (that was stopping the race). Alternate sides; big gaps between.
          const side = (obstacles.length % 2 === 0) ? 1 : -1;
          const off = side * nd.halfW * (0.35 + orng() * 0.25);   // 0.35–0.6 out from center
          obstacles.push({
            pos: { x: nd.pos.x + nd.right.x * off, y: nd.pos.y, z: nd.pos.z + nd.right.z * off },
            radius: 0.6 + orng() * 0.18,
            height: 2.6,
            idx: i,
          });
          i += 85 + Math.floor(orng() * 70);                       // wide gap (was 45–95) → no clustering
        } else {
          i += 8;
        }
      }
    }

    // PER-ROUTE OBSTACLES: each loop route gets its OWN electric bumpers — fully random every race
    // and different per side (medium density). Branch floors are analytic, so a world-positioned
    // bumper cylinder rides the route fine. Junction zones (meshSkip) and route ends are skipped,
    // and each post is pushed to one side so there's always a clear lane past it.
    for (const f of forks) {
      if (f.flavor !== 'divergent' || !f.branches) continue;
      for (const bid in f.branches) {
        const arr = f.branches[bid];
        const tag = bid.charCodeAt(bid.length - 1);
        const prng = mulberry32((seed ^ 0x7f4a7c15 ^ (tag * 0x9e3779b1)) >>> 0);
        const lo = 18, hi = arr.length - 18;
        let m = lo + Math.floor(prng() * 30), cnt = 0;
        while (m < hi) {
          const nd = arr[m];
          if (nd && !nd.meshSkip) {
            const side = (cnt % 2 === 0) ? 1 : -1;
            const off = side * nd.halfW * (0.30 + prng() * 0.30);
            obstacles.push({
              pos: { x: nd.pos.x + nd.right.x * off, y: nd.pos.y, z: nd.pos.z + nd.right.z * off },
              radius: 0.6 + prng() * 0.18, height: 2.6, idx: m, branchId: bid,
            });
            cnt++;
            // occasionally drop a second post just after, on the opposite side (a little gauntlet)
            if (prng() < 0.35 && m + 6 < hi) {
              const nd2 = arr[m + 4 + Math.floor(prng() * 4)];
              if (nd2 && !nd2.meshSkip) {
                const off2 = -side * nd2.halfW * (0.30 + prng() * 0.30);
                obstacles.push({ pos: { x: nd2.pos.x + nd2.right.x * off2, y: nd2.pos.y, z: nd2.pos.z + nd2.right.z * off2 },
                  radius: 0.6 + prng() * 0.18, height: 2.6, idx: m + 4, branchId: bid });
              }
            }
            m += 36 + Math.floor(prng() * 42);                     // denser (was 55–105)
          } else m += 8;
        }
      }
    }

    // PER-ROUTE BOOST PADS: each route gets its own boost strips — random per race & per side.
    // Physics reads the ball's CURRENT (branch) node .boost, so setting it on branch nodes applies
    // the burst; boost zones are tagged with branchId so the chevron renderer draws them on the route.
    for (const f of forks) {
      if (f.flavor !== 'divergent' || !f.branches) continue;
      for (const bid in f.branches) {
        const arr = f.branches[bid];
        const tag = bid.charCodeAt(bid.length - 1);
        const prng = mulberry32((seed ^ 0x51ed270b ^ (tag * 0x85ebca77)) >>> 0);
        const lo = 24, hi = arr.length - 24;
        let i = lo + Math.floor(prng() * 50);
        while (i < hi) {
          const len = 12 + Math.floor(prng() * 8);
          let ok = (i + len) < hi;
          for (let k = 0; ok && k < len; k++) { const nd = arr[i + k]; if (!nd || nd.meshSkip || nd.boost) ok = false; }
          if (ok && prng() < 0.72) {
            for (let k = 0; k < len; k++) arr[i + k].boost = 2;
            boosts.push({ startIdx: i, endIdx: i + len - 1, side: 2, branchId: bid });
            i += len + 60 + Math.floor(prng() * 55);
          } else i += 12;
        }
      }
    }

    // Build mesh for the main path, then add each fork's geometry.
    // lanesOnly forks (v2.1) live INSIDE the widened main corridor, so the main mesh
    // already covers their floor and outer walls — they only contribute the DIVIDER
    // wall. (Legacy ribbon-style forks would build full branch meshes.)
    const mesh = buildMesh(nodes);
    const branchMeshes = [];
    for (const f of forks) {
      if (f.lanesOnly) {
        const empty = { positions: new Float32Array(0), indices: new Uint32Array(0) };
        branchMeshes.push({ branchId: f.id + '_divider',
          mesh: { floor: empty, walls: f.divider, roof: empty } });
      } else {
        for (const bid in f.branches) {
          branchMeshes.push({ branchId: bid, mesh: buildMesh(f.branches[bid]) });
        }
      }
    }

    // Collider: main walls/roof + every branch's walls/roof (floors stay analytic).
    const collider = buildColliderBuffers(nodes);
    const branchColliders = branchMeshes.map(bm => ({
      branchId: bm.branchId,
      buffers: (() => {
        // walls+roof only, same as main
        const positions = []; const indices = []; let base = 0;
        for (const part of [bm.mesh.walls, bm.mesh.roof]) {
          for (let k=0;k<part.positions.length;k++) positions.push(part.positions[k]);
          for (let k=0;k<part.indices.length;k++) indices.push(part.indices[k]+base);
          base += part.positions.length/3;
        }
        return { positions:new Float32Array(positions), indices:new Uint32Array(indices) };
      })()
    }));

    // SPINNERS: rotating arm obstacles. Each spinner is a Y-axis kinematic body whose two arms
    // sweep across the track, knocking marbles sideways. Placed CENTER (no lateral offset) so
    // the arms reach both sides evenly. armLen capped at halfW*0.65 — one side always clear
    // at any moment during rotation. Sparser than bumpers (race can stall if overdone).
    // Own rng seed so the rest of the layout is untouched.
    const spinners = [];
    {
      const srng = mulberry32((seed ^ 0x1a2b3c4d) >>> 0);
      // Main path: ~1 spinner per 140 nodes, only on clear open track
      let i = platStart + 90;
      while (i < nodes.length - 80) {
        const nd = nodes[i];
        const bad = !nd || nd.isPlatform || nd.branchId || nd.kind === 'fork' || nd.tunnel ||
                    nd.boost || nd.meshSkip || /drum/.test(nd.kind || '');
        if (!bad) {
          const armLen = Math.min(nd.halfW * 0.65, 5.5);   // always leaves one side open
          spinners.push({
            pos: { x: nd.pos.x, y: nd.pos.y, z: nd.pos.z },   // dead-center on track
            armLen,
            armHeight: 0.85,    // arm cross-section half-height (ball radius 0.5 → sits at ~floor+0.85)
            rate: 1.8 + srng() * 2.0,    // 1.8–3.8 rad/s — tuneable live
            dir: srng() < 0.5 ? 1 : -1,  // CW or CCW
            // Local track orientation at this node — the spin AXIS is the track's local
            // "up" (which tilts with bank), and the spin PLANE's zero-heading is the track's
            // forward direction. Without this the arm spins flat in world-space and clips
            // through a banked/descending floor.
            up: { x: nd.up.x, y: nd.up.y, z: nd.up.z },
            fwd: { x: nd.dir.x, y: nd.dir.y, z: nd.dir.z },
            idx: i,
          });
          i += 120 + Math.floor(srng() * 60);   // 120–180 node gap (sparse)
        } else {
          i += 10;
        }
      }
      // Per-branch spinners: each divergent lane gets 1-2 spinners mid-route
      for (const f of forks) {
        if (f.flavor !== 'divergent' || !f.branches) continue;
        for (const bid in f.branches) {
          const arr = f.branches[bid];
          const tag = bid.charCodeAt(bid.length - 1);
          const prng = mulberry32((seed ^ 0xdeadbeef ^ (tag * 0xc2b2ae35)) >>> 0);
          const lo = 22, hi = arr.length - 22;
          let m = lo + Math.floor(prng() * 20);
          let cnt = 0;
          while (m < hi && cnt < 2) {
            const nd = arr[m];
            if (nd && !nd.meshSkip) {
              const armLen = Math.min(nd.halfW * 0.65, 4.5);
              spinners.push({
                pos: { x: nd.pos.x, y: nd.pos.y, z: nd.pos.z },
                armLen,
                armHeight: 0.85,
                rate: 2.0 + prng() * 2.2,
                dir: prng() < 0.5 ? 1 : -1,
                up: { x: nd.up.x, y: nd.up.y, z: nd.up.z },
                fwd: { x: nd.dir.x, y: nd.dir.y, z: nd.dir.z },
                idx: m,
                branchId: bid,
              });
              cnt++;
              m += 50 + Math.floor(prng() * 40);
            } else m += 8;
          }
        }
      }
    }

    const start = nodes[0];
    const finish = nodes.find(n => n.finishLine) || nodes[nodes.length - 1];
    return { seed, nodes, mesh, collider, start, finish, boosts, obstacles, spinners,
      platform: { startIdx: 0, endIdx: platStart },
      forks, forkAtIdx, branchMeshes, branchColliders };
  }

  return { generate, buildCenterline, buildMesh, buildColliderBuffers, mulberry32 };
})();

// Export for Node (server host) while staying a plain global in the browser.
if (typeof module !== 'undefined' && module.exports) module.exports = { ZTRACK };
