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
  const DROP_PER_STEP = 0.30; // average descent per node (the "downhill") — gentle so straights aren't steep
  const worldUp = v(0, 1, 0); // shared by buildCenterline and buildCustomBranchNodes

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
        // CALM recovery after a heavy piece — still give it some sweep so it's not dead straight
        if (r < 0.35) sec = { kind: 'straight', len: 10 + Math.floor(rng() * 10) };
        else { dir = -dir; sec = { kind: 'sweep', dir, sharp: 0.028 + rng() * 0.022, len: 28 + Math.floor(rng() * 20) }; }
        lastHeavy = false;
      } else {
        // EVENT pieces — weighted toward sweeping curves so the track feels alive,
        // not a flat straight road with occasional bumps.
        if (r < 0.38)      { dir = -dir; sec = { kind: 'sweep',  dir, sharp: 0.042 + rng() * 0.038, len: 34 + Math.floor(rng() * 26) }; lastHeavy = false; }
        else if (r < 0.56) { sec = { kind: 'funnel', len: 16 + Math.floor(rng() * 12), min: 0.40 + rng() * 0.16 }; lastHeavy = true; }
        else if (r < 0.70) { sec = { kind: 'narrower', len: 18 + Math.floor(rng() * 10), min: 0.34 + rng() * 0.10 }; lastHeavy = true; }
        else if (r < 0.84) { sec = { kind: 'drop', len: 14 + Math.floor(rng() * 12), drop: 1.0 + rng() * 1.0 }; lastHeavy = true; }
        else if (r < 0.95) { if (rng() > 0.35) dir = -dir; sec = { kind: 'spiral', dir, len: 32 + Math.floor(rng() * 16) }; lastHeavy = true; }
        else               { sec = { kind: 'tunnel', dir: rng() < 0.5 ? 1 : -1, len: 18 + Math.floor(rng() * 14) }; lastHeavy = false; }
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
  function buildCenterline(seed, targetNodes, ballCount, customPlan) {
    const rng = mulberry32(seed);
    // CUSTOM MAPS (map editor): when a hand-authored section plan is supplied, lay THAT instead of
    // the seeded course director. The plan is the same {kind,len,...} section list buildPlan emits,
    // so every downstream stage (mesh, physics, forks, obstacles) is untouched. We still ensure a
    // finish funnel + short runout exist so the line + photo-finish behave like a generated course.
    let plan;
    // customPlan may be a bare sections array OR the full map object {sections, obstacles}
    const rawSections = Array.isArray(customPlan) ? customPlan : (customPlan && Array.isArray(customPlan.sections) ? customPlan.sections : null);
    if (rawSections && rawSections.length) {
      // CUSTOM MAP: lay EXACTLY the authored sections — no injected funnel, no extra straight.
      // The finish line is marked on the last authored node after the loop (see below), so the
      // photo-finish line exists without adding any geometry the creator didn't place.
      plan = rawSections.map(s => Object.assign({}, s));
    } else {
      plan = buildPlan(rng, targetNodes);   // course director: deliberate section sequence
    }
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
    // CASCADE: a multi-tier shelf — flat treads separated by steep risers, balls tumble down.
    let cascadeLen = 1, cascadeSteps = 4;
    // ARENA: wide-open flat zone — halfW expands to arenaHalfW, nearly flat floor.
    let arenaHalfW = 14, arenaLen = 40;
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
        } else if (sec.kind === 'tunneldrop') {
          // enclosed steep plunge: a tunnel roof + a much steeper descent, for speed.
          moveKind = 'drop';
          targetTurn = (rng() - 0.5) * 0.02;
          targetBank = 0;
          extraDrop = sec.drop || 2.6;
          tunnel = true;
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
          spiralTurn = sec.dir * 0.030;
          targetTurn = spiralTurn;
          targetBank = sec.dir * 0.18;
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
        } else if (sec.kind === 'cascade') {
          moveKind = 'cascade';
          targetTurn = (rng() - 0.5) * 0.008;
          targetBank = 0;
          cascadeLen = sec.len;
          cascadeSteps = Math.max(2, Math.min(8, (sec.steps | 0) || 4));
          segLeft = sec.len;
        } else if (sec.kind === 'arena') {
          moveKind = 'arena';
          targetTurn = 0;
          targetBank = 0;
          arenaHalfW = Math.max(8, Math.min(30, +sec.w || 14));
          arenaLen = sec.len;
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
      let eDrop = extraDrop;
      if (moveKind === 'cascade') {
        const cp = 1 - (segLeft / cascadeLen);
        const ph = (cp * cascadeSteps) % 1;
        eDrop = ph > 0.68 ? 4.2 : -1.0;
      } else if (moveKind === 'arena') {
        eDrop = -0.85;   // nearly flat so balls roll gently across the surface
      }
      const dropTarget = -(DROP_PER_STEP * (1 + eDrop)) / STEP;
      const dropEase = moveKind === 'cascade' ? 0.30 : moveKind === 'arena' ? 0.06 : 0.10;
      heading.y += (dropTarget - heading.y) * dropEase;
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
        const np = 1 - (segLeft / narrowLen);
        const ramp = Math.min(1, np / 0.22, (1 - np) / 0.22);
        const e = Math.max(0, ramp); const es = e * e * (3 - 2 * e);
        widthFactor *= 1 - es * (1 - narrowMin);
      } else if (moveKind === 'arena') {
        // WIDEN to arenaHalfW over the first/last 15% of the section (smooth mouth), hold at max.
        const ap = 1 - (segLeft / arenaLen);
        const ramp = Math.min(1, ap / 0.15, (1 - ap) / 0.15);
        const es = ramp * ramp * (3 - 2 * ramp);
        widthFactor = 1 + (arenaHalfW / WIDTH - 1) * Math.max(0, es);
      }
      const halfW = WIDTH * widthFactor;

      const node = { pos: { x: pos.x, y: pos.y, z: pos.z }, dir: heading, right, up, halfW, bank, kind: moveKind, tunnel, forkZone: curForkZone };
      // FINISH LINE at the finish-funnel throat (tightest = field most bunched = photo finishes)
      if (curFinish && !finishMarked && moveKind === 'funnel' && funnelPos >= 0.5) { node.finishLine = true; finishMarked = true; }
      nodes.push(node);
      segLeft--;
    }
    // CUSTOM MAP: no finish-funnel throat, so mark the last real track node as the finish line.
    if (rawSections && rawSections.length && !finishMarked) {
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (!nodes[i].isPlatform) { nodes[i].finishLine = true; break; }
      }
    }
    return nodes;
  }

  // Turn the centerline into a triangle mesh (floor + two walls), welded seam-to-seam.
  // Returns { positions:Float32Array, indices:Uint32Array } in a single buffer,
  // plus separate arrays the renderer can use for materials if desired.
  // OUTER-PERIMETER occupancy tester. Given every ribbon in the track network (main + all
  // branches), returns covered(x,y,z,selfTag) -> true if that world point sits on some OTHER
  // ribbon's floor. Walls then spawn only on edges whose outward side is NOT covered — i.e.
  // the true outer silhouette of the whole network. Interior seams at junctions self-open.
  function buildOccupancy(groups) {
    const CELL = 6;
    const grid = new Map();
    for (const g of groups) {
      for (const n of g.nodes) {
        if (!n || n.meshSkip) continue;
        const gx = Math.floor(n.pos.x / CELL), gz = Math.floor(n.pos.z / CELL);
        const k = gx + ',' + gz;
        let arr = grid.get(k); if (!arr) { arr = []; grid.set(k, arr); }
        arr.push({ n, tag: g.tag });
      }
    }
    return function covered(px, py, pz, selfTag) {
      const gx = Math.floor(px / CELL), gz = Math.floor(pz / CELL);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const arr = grid.get((gx + dx) + ',' + (gz + dz));
        if (!arr) continue;
        for (const it of arr) {
          if (it.tag === selfTag) continue;   // never let a ribbon cover its own edge
          const n = it.n;
          const ex = px - n.pos.x, ey = py - n.pos.y, ez = pz - n.pos.z;
          if (Math.abs(ey) > 4) continue;
          const lat = ex * n.right.x + ez * n.right.z;
          const along = ex * n.dir.x + ez * n.dir.z;
          if (Math.abs(lat) <= n.halfW - 0.3 && Math.abs(along) <= 1.6) return true;
        }
      }
      return false;
    };
  }

  function buildMesh(nodes, opts) {
    const occupancy = opts && opts.occupancy;
    const selfTag = opts && opts.selfTag;
    const PROBE = 1.0;   // how far past a floor edge to look for neighbouring track
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
      const lw = add(lf, scale(bankUp, 2.8));          // left wall top (taller for more substance)
      const rw = add(rf, scale(bankUp, 2.8));          // right wall top
      const lc = add(lf, scale(bankUp, 4.5));          // left ceiling
      const rc = add(rf, scale(bankUp, 4.5));          // right ceiling
      const ld = add(lf, scale(bankUp, -2.2));         // left underside (skirt hides bumpers)
      const rd = add(rf, scale(bankUp, -2.2));         // right underside
      // Outer-perimeter test: a wall belongs on an edge only if NO other ribbon's floor
      // sits just beyond it. Probe a little past each floor edge; if covered, it's an
      // interior seam (a junction) and the wall is dropped automatically.
      let nwL = !!(n.noWalls || n.noWallL), nwR = !!(n.noWalls || n.noWallR);
      if (occupancy) {
        const lp = add(lf, scale(n.right, -PROBE));
        const rp = add(rf, scale(n.right, PROBE));
        if (occupancy(lp.x, lp.y, lp.z, selfTag)) nwL = true;
        if (occupancy(rp.x, rp.y, rp.z, selfTag)) nwR = true;
      }
      return { lf, rf, lw, rw, lc, rc, ld, rd, tunnel: !!n.tunnel,
        noWallL: nwL, noWallR: nwR };
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
        // underside skirt — extends below the floor so the track reads as a solid board, not a ribbon,
        // and hides bumpers/obstacles that are recessed beneath the track surface.
        pushQuad(wallPos, wallIdx, prev.ld, prev.lf, cur.lf, cur.ld, wvi); wvi += 4;  // left skirt
        pushQuad(wallPos, wallIdx, prev.rf, prev.rd, cur.rd, cur.rf, wvi); wvi += 4;  // right skirt
        pushQuad(wallPos, wallIdx, prev.rd, prev.ld, cur.ld, cur.rd, wvi); wvi += 4;  // bottom face
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
  function buildColliderBuffers(nodes, opts) {
    const m = buildMesh(nodes, opts);
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

  // Build branch nodes for an authored branch, starting from a fork node on the main track.
  // Mirrors the core of buildCenterline but with no platform or seeded randomness.
  function buildCustomBranchNodes(startNode, sections, branchId, side) {
    const nodes = [];
    side = side || 0;
    let pos = { x: startNode.pos.x, y: startNode.pos.y, z: startNode.pos.z };
    let heading = norm({ x: startNode.dir.x, y: startNode.dir.y, z: startNode.dir.z });
    // FAN-OUT: instead of angling the lane off a single point (which tears an empty wedge
    // between lanes and drops balls), ease this lane sideways into its own channel while
    // staying PARALLEL to the trunk. Parallel lanes have adjacent/overlapping floors, so the
    // split reads as a corridor widening into channels — no gaps, nothing to fall through.
    // The trunk is widened over the same span (in the fork builder) so the floor is solid.
    if (side) {
      const FAN = 20;
      const targetOff = side * WIDTH * 0.95;       // final channel offset from trunk centerline
      for (let k = 1; k <= FAN; k++) {
        const e0 = k / FAN, ease = e0*e0*(3-2*e0); // smoothstep 0..1
        heading.y += ((-(DROP_PER_STEP)/STEP) - heading.y) * 0.10; heading = norm(heading);
        pos = add(pos, scale(heading, STEP));
        const right = norm(cross(heading, worldUp));
        const up = norm(cross(right, heading));
        const off = targetOff * ease;
        nodes.push({ pos:{ x: pos.x + right.x*off, y: pos.y, z: pos.z + right.z*off },
          dir:{x:heading.x,y:heading.y,z:heading.z}, right, up,
          halfW: WIDTH, bank:0, kind:'fork', tunnel:false, branchId });
      }
      // hand the authored pieces a start position already shifted into the channel
      const right = norm(cross(heading, worldUp));
      pos = { x: pos.x + right.x*targetOff, y: pos.y, z: pos.z + right.z*targetOff };
    }
    let turn = 0;
    let funnelMin = 0.45, funnelLen = 1;
    let spiralTurn = 0, spiralLen = 1;
    let narrowMin = 0.38, narrowLen = 1;
    let cascadeLen = 1, cascadeSteps = 4;
    let arenaHalfW = 14, arenaLen = 1;
    for (const sec of sections) {
      const len = sec.len | 0; if (!len) continue;
      const mk = sec.kind || 'straight';
      let targetTurn = 0, extraDrop = 0, tunnel = false;
      if (mk === 'sweep')    { targetTurn = (sec.dir||1) * (sec.sharp||0.028); }
      if (mk === 'spiral')   { spiralTurn = (sec.dir||1)*0.030; spiralLen = len; targetTurn = spiralTurn; }
      if (mk === 'tunnel')   { targetTurn = (sec.dir||1)*0.012; tunnel = true; }
      if (mk === 'drop')     { extraDrop = sec.drop || 1.2; }
      if (mk === 'tunneldrop'){ extraDrop = sec.drop || 2.6; tunnel = true; }
      if (mk === 'cascade')  { cascadeLen = len; cascadeSteps = Math.max(2,Math.min(8,(sec.steps|0)||4)); }
      if (mk === 'funnel')   { funnelMin = sec.min||0.45; funnelLen = len; }
      if (mk === 'narrower') { narrowMin = sec.min||0.38; narrowLen = len; }
      if (mk === 'arena')    { arenaHalfW = Math.max(8,Math.min(30,+sec.w||14)); arenaLen = len; }
      let segLeft = len;
      while (segLeft > 0) {
        if (mk === 'spiral') targetTurn = spiralTurn;
        turn += (targetTurn - turn) * 0.12;
        const cosT = Math.cos(turn), sinT = Math.sin(turn);
        heading = norm({ x: heading.x*cosT - heading.z*sinT, y: heading.y, z: heading.x*sinT + heading.z*cosT });
        let eDrop = extraDrop;
        if (mk === 'cascade') { const cp=1-(segLeft/cascadeLen); const ph=(cp*cascadeSteps)%1; eDrop=ph>0.68?4.2:-1.0; }
        if (mk === 'arena') eDrop = -0.85;
        const dropTarget = -(DROP_PER_STEP*(1+eDrop))/STEP;
        const dropEase = mk==='cascade'?0.30:mk==='arena'?0.06:0.10;
        heading.y += (dropTarget - heading.y) * dropEase;
        heading = norm(heading);
        pos = add(pos, scale(heading, STEP));
        let widthFactor = 1.0;
        const ap = 1 - (segLeft / Math.max(1, len));
        if (mk === 'funnel')   { const throat = 1-Math.sin(ap*Math.PI)*(1-funnelMin); widthFactor=throat; }
        else if (mk === 'narrower') { const r=Math.min(1,ap/0.22,(1-ap)/0.22); const e=r*r*(3-2*r); widthFactor=1-e*(1-narrowMin); }
        else if (mk === 'spiral')   { const r=Math.min(1,ap/0.25,(1-ap)/0.25); const e=r*r*(3-2*r); widthFactor=1+0.45*e; }
        else if (mk === 'arena')    { const r=Math.min(1,ap/0.15,(1-ap)/0.15); const e=r*r*(3-2*r); widthFactor=1+(arenaHalfW/WIDTH-1)*Math.max(0,e); }
        else if (mk === 'tunnel' || mk === 'tunneldrop') widthFactor = 0.8;
        const halfW = WIDTH * widthFactor;
        const right = norm(cross(heading, worldUp));
        const up = norm(cross(right, heading));
        nodes.push({ pos:{x:pos.x,y:pos.y,z:pos.z}, dir:{x:heading.x,y:heading.y,z:heading.z},
          right, up, halfW, bank:0, kind:mk, tunnel, branchId });
        segLeft--;
      }
    }
    return nodes;
  }

  // Top-level: given a seed and a target length (seconds-ish), produce everything.
  function generate(seed, lengthNodes = 700, ballCount = 20, customPlan = null) {
    // for custom maps, size the node budget to the authored plan (sum of section lengths + slack)
    const _secs = Array.isArray(customPlan) ? customPlan : (customPlan && Array.isArray(customPlan.sections) ? customPlan.sections : null);
    // CUSTOM MAP: the author controls every obstacle by hand, so ALL the seeded/random obstacle,
    // boost, spinner and launch-pin generators are skipped — only the user's placed obstacles
    // (injected at the end of generate) appear on the track.
    const _isCustom = !!(_secs && _secs.length);
    if (_secs && _secs.length) {
      const sum = _secs.reduce((s, sec) => s + (sec.len | 0), 0);
      lengthNodes = Math.max(lengthNodes, sum + 120);
    }
    const nodes = buildCenterline(seed, lengthNodes, ballCount, customPlan);
    const platformEnd = nodes.findIndex(n => !n.isPlatform);
    const platStart = platformEnd < 0 ? 0 : platformEnd;

    // FORKS: build split routes as a post-pass (deterministic via the same seed stream).
    // Custom maps build their OWN forks from editor branches below — the seeded fork builder
    // (wells/sorters/vortex set-pieces) must NOT run, or it scans the custom centerline for
    // 'split' zones and injects gravity wells/vortex cones the author never placed.
    let forks = [], forkAtIdx = new Map();
    if (_ZFORK && !_isCustom) {
      const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
      const built = _ZFORK.buildForks(nodes, platStart, rng);
      forks = built.forks; forkAtIdx = built.forkAtIdx;
    }

    // CUSTOM BRANCHES: wire editor-authored branch exits into the fork/physics system.
    // Each editor branch becomes a divergent fork. All branches rejoin near the end of the
    // main track so balls always reach the finish.
    if (_isCustom && !Array.isArray(customPlan) && customPlan.branches && customPlan.branches.length) {
      // Group branches by fromSection — multiple branches on the same section share one fork.
      const branchGroups = new Map();
      for (const br of customPlan.branches) {
        if (!br.sections || !br.sections.length) continue;
        const key = br.fromSection | 0;
        if (!branchGroups.has(key)) branchGroups.set(key, []);
        branchGroups.get(key).push(br);
      }
      // Compute the main-track node index of the LAST node in each section.
      const sectionEndIdx = [];
      let nodeOffset = platStart;
      for (let si = 0; si < _secs.length; si++) {
        nodeOffset += _secs[si].len | 0;
        sectionEndIdx.push(Math.min(nodeOffset - 1, nodes.length - 1));
      }
      const rejoinNode = nodes.length - 8; // all branches rejoin near the finish
      for (const [fromSection, brs] of branchGroups) {
        if (fromSection < 0 || fromSection >= sectionEndIdx.length) continue;
        const forkNodeIdx = sectionEndIdx[fromSection];
        const forkNode = nodes[forkNodeIdx]; if (!forkNode) continue;
        const forkId = 'cbr_' + fromSection;
        // '__main__' sentinel lane keeps the main centerline flowing alongside the branches —
        // balls binned to it stay on main (handled in physics commit). Placed in the middle so
        // the main lane sits centrally and branches peel off to the sides.
        const branches = {}, rejoinIdx = {}, branchRejoin = {};
        const branchIds = [];
        let anyRejoin = false;
        for (let bi = 0; bi < brs.length; bi++) {
          const branchId = forkId + '_' + bi;
          branchIds.push(branchId);
          const bnodes = buildCustomBranchNodes(forkNode, brs[bi].sections, branchId, brs[bi].side || 0);
          branches[branchId] = bnodes;
          // Author chooses per branch: rejoin the main track, or run to its own separate finish.
          const isFinish = brs[bi].end === 'finish';
          branchRejoin[branchId] = !isFinish;
          const last = bnodes[bnodes.length - 1];
          if (isFinish) {
            // mark the branch's last node as its own finish line so the race detects finishers here
            if (last) { last.finishLine = true; last.branchFinish = true; }
          } else {
            // REJOIN: snap back to whichever MAIN node is physically nearest the branch's end
            // (authored branches don't curve back on their own, so pick the closest re-entry).
            let bestIdx = rejoinNode, bestD = Infinity;
            if (last) {
              for (let mi = forkNodeIdx + 1; mi < nodes.length; mi++) {
                const mn = nodes[mi]; if (!mn || mn.branchId) continue;
                const d = (mn.pos.x-last.pos.x)**2 + (mn.pos.y-last.pos.y)**2 + (mn.pos.z-last.pos.z)**2;
                if (d < bestD) { bestD = d; bestIdx = mi; }
              }
            }
            rejoinIdx[branchId] = bestIdx; anyRejoin = true;
          }
        }
        // Insert the main sentinel in the MIDDLE of the lane order so the main path stays
        // centered and authored branches peel off to either side. EXCEPT a 2-way split
        // (noMiddle) has no straight-through lane, so every marble bins to a real branch.
        // Read it PER GROUP (off this group's branches) so different splits in one track can be
        // 2-way or 3-way independently; fall back to the map-level flag for older maps.
        const noMiddle = brs.some(b => b.noMiddle) || !!customPlan.noMiddle;
        const mid = Math.floor(branchIds.length / 2);
        const branchOrder = noMiddle ? branchIds.slice()
          : branchIds.slice(0, mid).concat(['__main__'], branchIds.slice(mid));
        const fork = { id: forkId, splitIdx: forkNodeIdx, flavor: 'divergent', keepMain: true,
          rejoin: anyRejoin, branchRejoin, rejoinIdx, branches, branchOrder, laneCount: brs.length + 1,
          ends: branchIds.map(bid => branches[bid][branches[bid].length-1] || forkNode),
          end: rejoinNode };
        forks.push(fork);
        forkAtIdx.set(forkNodeIdx, fork);
        // WIDEN THE TRUNK over the fan-out span so its floor reaches under the lanes as they
        // ease apart — no wedge gap, nothing to fall through. The lanes fan to ~WIDTH*0.95 on
        // each side over ~20 nodes, so the corridor needs to roughly double through that span.
        // Easing 1->0 after the fan blends back to the normal main width.
        const FAN = 20, sideCount = branchIds.length;
        if (sideCount) {
          for (let k = 0; k <= FAN + 6; k++) {
            const nd = nodes[forkNodeIdx + k]; if (!nd) break;
            if (nd._baseHalfW == null) nd._baseHalfW = nd.halfW;
            const e0 = Math.min(1, k / FAN);                 // 0..1 across the fan
            const ease = e0 * e0 * (3 - 2 * e0);
            const grow = 1 + 0.95 * ease;                    // up to ~1.95x at full spread
            nd.halfW = Math.max(nd.halfW, nd._baseHalfW * grow);
          }
        }
        // NOTE: inner junction walls are opened by the outer-perimeter wall pass
        // (buildOccupancy + buildMesh) — any wall edge with other track floor beyond it is
        // dropped, so the widened trunk and the parallel lanes merge into one clean corridor.
      }
    }

    // BOOST PADS (F-Zero side strips). Deterministic via a separate rng so the layout is
    // untouched. MEDIUM mode: a pad zone roughly every ~70 nodes, ~14 nodes long, on BOTH
    // edges (forgiving — hug either side to catch it). Density/side become mode-driven later.
    const boosts = [];
    if (!_isCustom) {
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
    if (!_isCustom) {
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
    if (!_isCustom) for (const f of forks) {
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
    if (!_isCustom) for (const f of forks) {
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

    // LAUNCH-PINS: a flat pad embedded in the floor that fires a one-time upward+forward
    // impulse when a ball crosses it (a discrete event, unlike the continuous boost strips).
    // Tagged on nodes as n.launch = {power, fwdBoost} over a short span so physics can detect
    // entry. Sparse — bigger disruption than a bumper, so overdoing it stalls the race.
    // Skips the same hazards as boosts/obstacles (platform, fork, tunnel, existing boost/launch).
    const launchPins = [];
    if (!_isCustom) {
      const lrng = mulberry32((seed ^ 0x2f8a3c91) >>> 0);
      const GAP_MIN = 130, GAP_VAR = 90, PAD_LEN = 6;   // short pad, wide gaps (rare event)
      // RUNWAY CHECK: a launch sends the ball airborne for up to ~1s while the track keeps
      // descending underneath it — confirmed in simulation that a pin placed right before a
      // funnel/narrower pinch could land the ball outside the now-narrowed corridor, or just
      // never re-catch the floor before checkFalls() fires (a "successful" launch that
      // accidentally reads as falling off). Require the next RUNWAY nodes after the pad to
      // stay reasonably wide (no funnel/narrower) so there's always room to land safely.
      const RUNWAY = 60;
      const clearRunway = (arr, start) => {
        for (let k = 0; k < RUNWAY; k++) {
          const n2 = arr[start + k];
          if (!n2 || n2.kind === 'funnel' || n2.kind === 'narrower' || n2.tunnel) return false;
        }
        return true;
      };
      let i = platStart + 110;
      while (i < nodes.length - 70 - 60) {
        const nd = nodes[i];
        const bad = !nd || nd.isPlatform || nd.branchId || nd.kind === 'fork' || nd.tunnel ||
                    nd.boost || nd.meshSkip || /drum/.test(nd.kind || '');
        if (!bad) {
          let ok = true;
          for (let k = 0; k < PAD_LEN; k++) {
            const n2 = nodes[i + k];
            if (!n2 || n2.isPlatform || n2.branchId || n2.kind === 'fork' || n2.tunnel || n2.boost || n2.meshSkip) { ok = false; break; }
          }
          if (ok && !clearRunway(nodes, i + PAD_LEN)) ok = false;
          if (ok) {
            // power/fwdBoost are the "feel" knobs — tuned live, not blind-guessed here.
            const power = 7.5 + lrng() * 3.0;        // upward impulse strength
            const fwdBoost = 0.55 + lrng() * 0.35;    // extra forward kick fraction
            for (let k = 0; k < PAD_LEN; k++) nodes[i + k].launch = { power, fwdBoost };
            launchPins.push({ startIdx: i, endIdx: i + PAD_LEN - 1, power, fwdBoost });
            i += PAD_LEN + GAP_MIN + Math.floor(lrng() * GAP_VAR);
          } else { i += 10; }
        } else { i += 10; }
      }
      // Per-branch: each divergent lane gets at most ONE launch-pin (rare surprise per route)
      for (const f of forks) {
        if (f.flavor !== 'divergent' || !f.branches) continue;
        for (const bid in f.branches) {
          const arr = f.branches[bid];
          const tag = bid.charCodeAt(bid.length - 1);
          const prng = mulberry32((seed ^ 0x6a3f1d57 ^ (tag * 0xb5297a4d)) >>> 0);
          if (prng() > 0.45) continue;   // not every lane gets one
          const lo = 30, hi = arr.length - 30;
          let m = lo + Math.floor(prng() * (hi - lo - PAD_LEN));
          let ok = true;
          for (let k = 0; k < PAD_LEN; k++) { const n2 = arr[m + k]; if (!n2 || n2.meshSkip || n2.boost) { ok = false; break; } }
          if (ok && !clearRunway(arr, m + PAD_LEN)) ok = false;
          if (ok) {
            const power = 7.0 + prng() * 3.0;
            const fwdBoost = 0.5 + prng() * 0.4;
            for (let k = 0; k < PAD_LEN; k++) arr[m + k].launch = { power, fwdBoost };
            launchPins.push({ startIdx: m, endIdx: m + PAD_LEN - 1, power, fwdBoost, branchId: bid });
          }
        }
      }
    }

    // OUTER-PERIMETER occupancy: gather every full-width ribbon (main + authored branches)
    // so buildMesh can drop wall edges that have other track floor beyond them. Only built
    // when there are real branch ribbons to consider (authored custom maps); auto-gen forks
    // are lanesOnly / scripted and keep the legacy per-node wall flags untouched.
    let occ = null;
    {
      const groups = [{ tag: '__main__', nodes }];
      for (const f of forks) {
        if (f.lanesOnly) continue;
        for (const bid in f.branches) {
          if (f.branches[bid] && f.branches[bid].length >= 2) {
            groups.push({ tag: bid, nodes: f.branches[bid] });
          }
        }
      }
      if (groups.length > 1) occ = buildOccupancy(groups);
    }
    const mainMeshOpts = occ ? { occupancy: occ, selfTag: '__main__' } : undefined;

    // Build mesh for the main path, then add each fork's geometry.
    // lanesOnly forks (v2.1) live INSIDE the widened main corridor, so the main mesh
    // already covers their floor and outer walls — they only contribute the DIVIDER
    // wall. (Legacy ribbon-style forks would build full branch meshes.)
    const mesh = buildMesh(nodes, mainMeshOpts);
    const branchMeshes = [];
    for (const f of forks) {
      if (f.lanesOnly) {
        const empty = { positions: new Float32Array(0), indices: new Uint32Array(0) };
        branchMeshes.push({ branchId: f.id + '_divider',
          mesh: { floor: empty, walls: f.divider, roof: empty } });
      } else {
        for (const bid in f.branches) {
          if (!f.branches[bid] || f.branches[bid].length < 2) continue;
          branchMeshes.push({ branchId: bid,
            mesh: buildMesh(f.branches[bid], occ ? { occupancy: occ, selfTag: bid } : undefined) });
        }
        // SORTER CONE SURFACE: the radial cone mesh (built in forks.js) that gives the
        // funnel its actual curved, narrowing shape — this is what makes it LOOK like a
        // funnel instead of a road that happens to get narrower. Floor-only, visual.
        if (f.isSorter && f.coneFloorMesh) {
          const empty = { positions: new Float32Array(0), indices: new Uint32Array(0) };
          branchMeshes.push({ branchId: f.id + '_cone',
            mesh: { floor: f.coneFloorMesh, walls: empty, roof: empty } });
        }
        // SORTER HOLE-FLOOR: the slatted strips with real gaps where each tube begins
        // (built in forks.js) — visual only, walls/roof are empty since this piece is purely
        // the floor cosmetics that make the funnel actually look like it has holes in it.
        if (f.isSorter && f.holeFloorMesh) {
          const empty = { positions: new Float32Array(0), indices: new Uint32Array(0) };
          branchMeshes.push({ branchId: f.id + '_holes',
            mesh: { floor: f.holeFloorMesh, walls: empty, roof: empty } });
        }
        // GRAVITY WELL: the real radial cone-of-revolution surface plus the flat sorting
        // platform at the bottom (both built in forks.js, makeWellFork). Floor-only, visual
        // — the ball's actual path through the spiral is fully scripted in physics.js
        // (startWellOrbit/processWellOrbit), and track assignment off the platform is a flat
        // random roll, not driven by this mesh's shape at all.
        if (f.isWell && f.wellConeMesh) {
          const empty = { positions: new Float32Array(0), indices: new Uint32Array(0) };
          branchMeshes.push({ branchId: f.id + '_wellcone',
            mesh: { floor: f.wellConeMesh, walls: empty, roof: empty } });
        }
        if (f.isWell && f.wellPlatformMesh) {
          const empty = { positions: new Float32Array(0), indices: new Uint32Array(0) };
          branchMeshes.push({ branchId: f.id + '_wellplatform',
            mesh: { floor: f.wellPlatformMesh, walls: empty, roof: empty } });
        }
      }
    }

    // Collider: main walls/roof + every branch's walls/roof (floors stay analytic).
    // Branches with NO wall/roof geometry (e.g. the sorter's '_holes' entry, which is
    // floor-only visual cosmetics) are skipped entirely — an empty trimesh buffer crashes
    // Rapier's collider constructor.
    const collider = buildColliderBuffers(nodes, mainMeshOpts);
    const branchColliders = branchMeshes.map(bm => ({
      branchId: bm.branchId,
      buffers: (() => {
        // Well cone and platform are VISUAL ONLY.
        // The cone's exterior trimesh normals deflect balls outward on approach (wrong direction).
        // The platform trimesh normals face DOWN so it's transparent from above.
        // Physics for the well is 100% scripted (orbit) + a thick cylinder in setTrack.
        if (bm.branchId && (bm.branchId.endsWith('_wellcone') || bm.branchId.endsWith('_wellplatform'))) {
          return { positions: new Float32Array(0), indices: new Uint32Array(0) };
        }
        const positions = []; const indices = []; let base = 0;
        for (const part of [bm.mesh.walls, bm.mesh.roof]) {
          for (let k=0;k<part.positions.length;k++) positions.push(part.positions[k]);
          for (let k=0;k<part.indices.length;k++) indices.push(part.indices[k]+base);
          base += part.positions.length/3;
        }
        return { positions:new Float32Array(positions), indices:new Uint32Array(indices) };
      })()
    })).filter(bc => bc.buffers.indices.length > 0);

    // SPINNERS: rotating arm obstacles. Each spinner is a Y-axis kinematic body whose two arms
    // sweep across the track, knocking marbles sideways. Placed CENTER (no lateral offset) so
    // the arms reach both sides evenly. armLen capped at halfW*0.65 — one side always clear
    // at any moment during rotation. Sparser than bumpers (race can stall if overdone).
    // Own rng seed so the rest of the layout is untouched.
    const spinners = [];
    const pendulums = [];
    const vortexDiscs = [];
    if (!_isCustom) {
      const srng = mulberry32((seed ^ 0x1a2b3c4d) >>> 0);
      // SPACING RULE: a spinner must never land right next to a bumper post — back-to-back
      // they defeat each other's purpose (the spinner just slams the ball straight into the
      // post, or the post blocks the one lane the spinner left open). Keep a minimum node
      // gap from every existing bumper on the SAME node array (main vs main, or same branch).
      const MIN_GAP_FROM_BUMPER = 45;
      const tooCloseToBumper = (idx, branchId) => obstacles.some(ob =>
        (ob.branchId || null) === (branchId || null) && Math.abs(ob.idx - idx) < MIN_GAP_FROM_BUMPER);
      // Main path: ~1 spinner per 140 nodes, only on clear open track
      let i = platStart + 90;
      while (i < nodes.length - 80) {
        const nd = nodes[i];
        const bad = !nd || nd.isPlatform || nd.branchId || nd.kind === 'fork' || nd.tunnel ||
                    nd.boost || nd.meshSkip || /drum/.test(nd.kind || '') || tooCloseToBumper(i, null);
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
            if (nd && !nd.meshSkip && !tooCloseToBumper(m, bid)) {
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

    // CUSTOM MAP OBSTACLES: hand-placed obstacles from the map editor. Each has a t=0..1
    // position along the non-platform centerline plus an optional lateral side offset (-1..1).
    // Injected after all seeded/generated obstacles so they don't interfere with fork logic.
    // custom obstacles — only present when customPlan is the full map object (not a bare sections array)
    const _cobs = (!Array.isArray(customPlan) && customPlan && Array.isArray(customPlan.obstacles)) ? customPlan.obstacles : [];
    if (_cobs.length) {
      const trackNodes = nodes.filter(n => !n.isPlatform);
      const tLen = trackNodes.length;
      for (const co of _cobs) {
        const ni = Math.max(0, Math.min(tLen - 1, Math.round((co.t || 0) * (tLen - 1))));
        const nd = trackNodes[ni];
        if (!nd) continue;
        const sideF = Math.max(-0.85, Math.min(0.85, co.side || 0));
        const off = sideF * nd.halfW;
        const px = nd.pos.x + nd.right.x * off, py = nd.pos.y, pz = nd.pos.z + nd.right.z * off;
        const realIdx = platStart + ni;
        if (co.kind === 'bumper') {
          const rad = Math.max(0.35, Math.min(1.6, co.size || 0.65));
          if (!obstacles.some(o => Math.abs(o.pos.x - px) < 0.5 && Math.abs(o.pos.z - pz) < 0.5))
            obstacles.push({ pos: {x:px, y:py, z:pz}, radius: rad, height: 2.8, idx: realIdx });
        } else if (co.kind === 'spinner') {
          const rate = Math.max(0.8, Math.min(5, co.speed || 2.5));
          const armLen = co.size != null ? Math.max(0.8, Math.min(4.5, +co.size)) : Math.min(nd.halfW * 0.6, 4.5);
          spinners.push({ pos: {x:px, y:py, z:pz}, armLen, armHeight: 0.85,
            rate, dir: co.dir || 1, up: nd.up, fwd: nd.dir, idx: realIdx });
        } else if (co.kind === 'pendulum') {
          const rate = Math.max(0.5, Math.min(3.5, co.speed || 1.6));
          pendulums.push({ pos: {x:px, y:py, z:pz}, up: nd.up, fwd: nd.dir,
            rate, swing: 0.95, idx: realIdx });
        } else if (co.kind === 'vortex') {
          const radius = Math.max(1.5, Math.min(nd.halfW * 0.85, 5.5));
          const revolutions = Math.max(1, Math.min(4, co.revolutions || 1.5));
          const duration = Math.max(0.8, Math.min(3.0, co.duration || 1.4));
          vortexDiscs.push({ pos: {x:px, y:py, z:pz}, radius, revolutions, duration,
            dir: co.dir || 1, idx: realIdx });
        } else if (co.kind === 'boost') {
          const bl = Math.max(6, Math.min(28, (co.length || 14) | 0));
          let ok = true;
          for (let k = 0; k < bl && ok; k++) { if (!nodes[realIdx + k] || nodes[realIdx + k].boost) ok = false; }
          if (ok) {
            for (let k = 0; k < bl; k++) nodes[realIdx + k].boost = 2;
            boosts.push({ startIdx: realIdx, endIdx: realIdx + bl - 1, side: 2 });
          }
        } else if (co.kind === 'launch') {
          const ll = 6;
          let ok = true;
          for (let k = 0; k < ll && ok; k++) { if (!nodes[realIdx + k] || nodes[realIdx + k].boost || nodes[realIdx + k].launch) ok = false; }
          if (ok) {
            for (let k = 0; k < ll; k++) nodes[realIdx + k].launch = { power: 8, fwdBoost: 0.6 };
            launchPins.push({ startIdx: realIdx, endIdx: realIdx + ll - 1, power: 8, fwdBoost: 0.6 });
          }
        }
      }
    }

    return { seed, nodes, mesh, collider, start, finish, boosts, obstacles, spinners, pendulums, vortexDiscs, launchPins,
      platform: { startIdx: 0, endIdx: platStart },
      forks, forkAtIdx, branchMeshes, branchColliders };
  }

  return { generate, buildCenterline, buildMesh, buildColliderBuffers, mulberry32 };
})();

// Export for Node (server host) while staying a plain global in the browser.
if (typeof module !== 'undefined' && module.exports) module.exports = { ZTRACK };
