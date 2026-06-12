// ZORBS v2 — Physics core (host-agnostic, built on Rapier)
// THE KEY DESIGN: collision and propulsion are separate systems that never fight.
//   • Rapier owns COLLISION: the track is a solid trimesh, balls are rigid spheres,
//     they bounce off walls and each other for real. Gravity pulls them down the slope.
//   • OUR CODE owns DRIVE: each ball gets a force that ONLY ever points forward along
//     the track centerline — never sideways at a wall. So a ball bumps a wall (physics)
//     then keeps racing forward (drive). No magnet-to-edge. No stalling.
//   • Anti-conga: each ball has a slightly different target speed + a personal lane
//     offset, so the pack spreads laterally instead of stacking into one line.
//
// This module has NO rendering and NO THREE dependency, so the identical file runs
// in a browser tab today and in a Node server host tomorrow with zero changes.

const ZPHYSICS = (() => {
  let RAPIER = null;
  let world = null;
  let ready = false;
  let trackBody = null;
  const balls = new Map(); // id -> { body, drive, lane, speedMul, alive, branch }
  let nodes = null;        // main centerline for steering
  let forks = null;        // fork descriptors
  let branchNodes = {};    // branchId -> node array (separate from main)
  let BALL_R = 0.5;
  let lastError = null;

  // ---- load Rapier from CDN (browser) or require (node) ----
  async function load() {
    if (typeof require !== 'undefined' && typeof window === 'undefined') {
      // Node host path
      RAPIER = require('@dimforge/rapier3d-compat');
      await RAPIER.init();
      return true;
    }
    // Browser path: try a few CDNs, each with a timeout, log clearly.
    const CDNS = [
      'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.17.3/+esm',
      'https://esm.sh/@dimforge/rapier3d-compat@0.17.3',
    ];
    const withTimeout = (p, ms) => Promise.race([
      p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
    ]);
    for (const url of CDNS) {
      try {
        console.log('[ZPHYSICS] loading Rapier from', url);
        const mod = await withTimeout(import(/* @vite-ignore */ url), 12000);
        RAPIER = mod.default || mod;
        if (!RAPIER || !RAPIER.init) throw new Error('bad module shape: ' + Object.keys(mod).join(','));
        await RAPIER.init();
        console.log('[ZPHYSICS] ✅ Rapier loaded from', url);
        return true;
      } catch (e) {
        lastError = (e && e.message) || String(e);
        console.warn('[ZPHYSICS] ❌ failed', url, '-', lastError);
      }
    }
    return false;
  }

  async function init(ballRadius) {
    BALL_R = ballRadius || 0.5;
    const ok = await load();
    if (!ok) { ready = false; return false; }
    // gravity points straight down; the track slope turns that into forward motion
    world = new RAPIER.World({ x: 0, y: -26, z: 0 });
    balls.clear();        // stale bodies belong to a previous world — removing them
    trackBody = null;     // from a new world crashes the wasm. Fresh world, fresh refs.
    world.timestep = 1/60;             // FIXED timestep = smooth, no jitter
    // more solver iterations = stable resting contacts (less micro-bounce)
    if (world.integrationParameters) {
      world.integrationParameters.numSolverIterations = 8;
    }
    ready = true;
    return true;
  }

  // Install the track collider (walls/roof) + remember centerline + fork branches.
  // forkData = { forks, branchColliders } from the track generator (optional).
  function setTrack(colliderBuffers, centerline, forkData) {
    if (!ready) return;
    if (trackBody) { world.removeRigidBody(trackBody); trackBody = null; }
    nodes = centerline;
    forks = (forkData && forkData.forks) || null;
    branchNodes = {};
    if (forks) for (const f of forks) for (const bid in f.branches) branchNodes[bid] = f.branches[bid];

    const bd = RAPIER.RigidBodyDesc.fixed();
    trackBody = world.createRigidBody(bd);
    const mk = (buf) => {
      // friction 0.8 -> 0.3: high wall friction was scrubbing speed off any ball that
      // touched a wall, helping pile-ups stall. Walls should redirect, not brake.
      const cd = RAPIER.ColliderDesc.trimesh(buf.positions, buf.indices)
        .setRestitution(0.0).setFriction(0.3);
      world.createCollider(cd, trackBody);
    };
    mk(colliderBuffers);
    if (forkData && forkData.branchColliders) {
      for (const bc of forkData.branchColliders) mk(bc.buffers);
    }
  }

  // The node list a ball is currently following (its committed branch, or main path).
  function ballNodes(b) {
    return (b && b.branch && branchNodes[b.branch]) ? branchNodes[b.branch] : nodes;
  }

  // Smooth floor height at a position: interpolate the centerline between the nearest
  // node and the next, so the floor reads as a continuous ramp, not faceted triangles.
  // Catmull-Rom: smooth curve through 4 control points (C1 continuous = no stair steps)
  function catmull(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * (
      (2 * p1) +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
  }
  function smoothFloorY(pos, hint, nodeArr) {
    const N = nodeArr || nodes;
    if (!N) return pos.y;
    const i = Math.max(0, Math.min(N.length - 2, hint));
    const a = N[i], b = N[i + 1];
    // where is pos between node a and b? (projected onto the segment)
    const abx = b.pos.x - a.pos.x, abz = b.pos.z - a.pos.z;
    const apx = pos.x - a.pos.x, apz = pos.z - a.pos.z;
    const abLen2 = abx * abx + abz * abz || 1;
    let tt = (apx * abx + apz * abz) / abLen2;
    tt = Math.max(0, Math.min(1, tt));
    const y0 = N[Math.max(0, i - 1)].pos.y;
    const y1 = a.pos.y, y2 = b.pos.y;
    const y3 = N[Math.min(N.length - 1, i + 2)].pos.y;
    return catmull(y0, y1, y2, y3, tt);
  }

  // Find the nearest centerline node index to a position (search around a hint).
  function nearestNode(pos, hint, nodeArr) {
    const N = nodeArr || nodes;
    if (!N) return 0;
    let best = hint || 0, bestD = Infinity;
    const lo = Math.max(0, (hint || 0) - 8);
    const hi = Math.min(N.length - 1, (hint || 0) + 24);
    for (let i = lo; i <= hi; i++) {
      const n = N[i].pos;
      const dx = n.x - pos.x, dy = n.y - pos.y, dz = n.z - pos.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // Wide-window search for when we genuinely don't know where the ball is (rejoin,
  // de-localization recovery). Same as nearestNode but with a caller-chosen radius.
  function nearestNodeWide(pos, center, radius, nodeArr) {
    const N = nodeArr || nodes;
    if (!N) return 0;
    let best = Math.max(0, Math.min(N.length - 1, center || 0)), bestD = Infinity;
    const lo = Math.max(0, (center || 0) - radius);
    const hi = Math.min(N.length - 1, (center || 0) + radius);
    for (let i = lo; i <= hi; i++) {
      const n = N[i].pos;
      const dx = n.x - pos.x, dy = n.y - pos.y, dz = n.z - pos.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // Add a ball with a unique personality (speed + lane) for natural pack spread.
  function addBall(id, spawn) {
    if (!ready || balls.has(id)) return;
    const bd = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      .setLinearDamping(0.18)   // lower = balls keep momentum through contacts
      .setAngularDamping(0.5)
      .setCcdEnabled(true); // fast balls never tunnel through walls
    const body = world.createRigidBody(bd);
    const cd = RAPIER.ColliderDesc.ball(BALL_R * 1.5)   // collide at RING radius, not core
      .setRestitution(0.0).setFriction(0.5).setDensity(1.2);
    world.createCollider(cd, body);

    // deterministic-ish personality from the id hash
    let h = 0; for (let k = 0; k < id.length; k++) h = (h * 31 + id.charCodeAt(k)) | 0;
    const rnd = (Math.abs(h % 1000) / 1000);
    balls.set(id, {
      body,
      hint: 0,
      speedMul: 0.9 + rnd * 0.25,         // 0.90–1.15 target speed
      lane: (rnd - 0.5) * 1.4,            // preferred lateral offset, spreads the pack
      churnPhase: rnd * 6.2832,           // deterministic mixer-churn phase (no Math.random!)
      boost: 0,
      alive: true,
    });
  }

  function removeBall(id) {
    const b = balls.get(id);
    if (b) { world.removeRigidBody(b.body); balls.delete(id); }
  }
  function clearBalls() {
    for (const [, b] of balls) world.removeRigidBody(b.body);
    balls.clear();
  }

  function giveBoost(id, amount) {
    const b = balls.get(id); if (b) b.boost = Math.min(2.5, b.boost + (amount || 1));
  }

  const DRIVE_FORCE = 7.5;   // base forward push
  const LANE_PULL = 2.2;     // how strongly a ball seeks its preferred lane
  const MAX_SPEED = 26;
  const SPIRAL_DOWNFORCE = 6.0;     // extra downforce on spiral coils (keeps balls planted)
  const BOOST_PAD_STRENGTH = 1.3;   // forward boost from a side pad (MEDIUM mode tuning)

  // Fixed-timestep stepping with an accumulator. Call step(realDt) each frame;
  // it runs 0..N fixed sub-steps so physics is deterministic and smooth.
  function step(realDt) {
    if (!ready) return;
    // ONE step per frame at the real frame time (clamped). Simulation time advances
    // exactly with render time => no temporal aliasing => smooth at any refresh rate.
    const dt = Math.max(0.002, Math.min(0.033, realDt));
    world.timestep = dt;
    fixedStep(dt);
  }

  function fixedStep(dt) {
    for (const [, b] of balls) {
      if (!b.alive) continue;
      b.body.resetForces(true);   // clear last step's drive so forces don't compound
      const t = b.body.translation();

      // FORK COMMIT: if on the main path and we've reached a fork's split point, pick a
      // branch based on which way the ball is leaning, then follow ONLY that branch.
      if (!b.branch && forks) {
        for (const f of forks) {
          if (b.hint >= f.splitIdx - 1 && b.hint <= f.splitIdx + 1) {
            // lean = lateral position relative to the split node's right vector
            const sn = nodes[f.splitIdx];
            const latv = (t.x - sn.pos.x)*sn.right.x + (t.z - sn.pos.z)*sn.right.z;
            b.branch = latv < 0 ? f.id+'_A' : f.id+'_B';  // A=left, B=right
            b.branchFork = f;
            b.hint = 0;   // restart hint within the branch
            break;
          }
        }
      }

      const curNodes = ballNodes(b);
      b.hint = nearestNode(t, b.hint, curNodes);

      // DE-LOCALIZATION GUARD: if the ball is impossibly far from the node it thinks
      // it's at (knocked way back, bad rejoin, anything), the small hint window can
      // never recover. Detect it and do one wide re-search to re-localize.
      {
        const hn = curNodes[Math.min(b.hint, curNodes.length - 1)];
        const ddx = t.x - hn.pos.x, ddy = t.y - hn.pos.y, ddz = t.z - hn.pos.z;
        const lim = Math.max(20, hn.halfW * 5);
        if (ddx*ddx + ddy*ddy + ddz*ddz > lim*lim) {
          b.hint = nearestNodeWide(t, b.hint, 300, curNodes);
        }
      }

      // REJOIN: if following a branch that rejoins and we've hit its end, return to main.
      if (b.branch && b.branchFork && b.branchFork.rejoin && b.hint >= curNodes.length - 2) {
        // THE OLD BUG: this searched main from node 0 with a tiny window, so a ball
        // rejoining at main node ~450 got hint≈24, snapped to the wrong floor height,
        // and was lost forever. Now: search a wide window around the KNOWN merge index
        // the fork generator recorded for this branch.
        const guess = (b.branchFork.rejoinIdx && b.branchFork.rejoinIdx[b.branch] != null)
          ? b.branchFork.rejoinIdx[b.branch]
          : b.branchFork.splitIdx + curNodes.length;
        b.branch = null; b.branchFork = null;
        b.hint = nearestNodeWide(t, guess, 80, nodes);
      }

      const N = ballNodes(b);
      const n = N[Math.min(b.hint, N.length-1)];
      const nx = N[Math.min(b.hint + 1, N.length - 1)];
      // global progress for leader/cam: main hint, or split point + branch hint
      b.progress = b.branch && b.branchFork ? (b.branchFork.splitIdx + b.hint) : b.hint;

      // forward direction = toward the next node (down the track), NEVER sideways
      let fx = nx.pos.x - n.pos.x, fy = nx.pos.y - n.pos.y, fz = nx.pos.z - n.pos.z;
      const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;

      // lane-seek: nudge toward this ball's preferred offset from centerline (lateral only)
      const r = n.right;
      const offX = t.x - n.pos.x, offZ = t.z - n.pos.z;
      const curLat = offX * r.x + offZ * r.z;           // current lateral position
      // MIXER CHURN: inside the spinning bowl-drum, weaken the lane pull and push each
      // ball toward a WIDE wandering lane that drifts over time, so the pack spreads
      // across the whole bowl and tumbles instead of running single-file. The bowl still
      // funnels everyone to the exit under gravity, so this can't trap anyone.
      const inMixer = (n.kind === 'mixer');
      let lanePull = LANE_PULL, targetLane = b.lane;
      if (inMixer) {
        b._churn = (b._churn != null ? b._churn : b.churnPhase);  // deterministic start
        b._churn += dt * (1.5 + b.speedMul);            // each ball wanders at its own rate
        targetLane = Math.sin(b._churn) * n.halfW * 0.55; // sweep across the bowl (kept off the very edge)
        lanePull = LANE_PULL * 0.5;                       // looser so they drift, not snap
      }
      const latErr = (targetLane - curLat);             // toward preferred/churn lane
      const laneFx = r.x * latErr * lanePull;
      const laneFz = r.z * latErr * lanePull;

      const m = b.body.mass() || 1;
      // SPIRAL DOWNFORCE: tight downward coils can let a ball float off the curved surface;
      // a little extra downforce on spiral nodes keeps it planted (deliberately gentle).
      const downforce = (n.kind === 'spiral') ? SPIRAL_DOWNFORCE * m : 0;

      // BOOST PADS (F-Zero side strips): if this node is a pad and the ball is riding that
      // side near the edge, give it a forward burst — rewards hugging the boost line.
      if (n.boost) {
        const nearR = curLat >  n.halfW * 0.40;
        const nearL = curLat < -n.halfW * 0.40;
        const onPad = (n.boost === 2) ? (nearR || nearL) : (n.boost > 0 ? nearR : nearL);
        if (onPad) b.boost = Math.min(2.2, Math.max(b.boost, BOOST_PAD_STRENGTH));
      }

      // total drive: forward + gentle lane-seek + boost. Applied as a force each
      // fixed step (consistent), and kept modest so ball-ball contacts still win.
      const drive = DRIVE_FORCE * b.speedMul * (1 + b.boost);
      b.body.addForce({
        x: fx * drive + laneFx,
        y: -downforce,                   // gravity + (on spirals) a little extra downforce
        z: fz * drive + laneFz,
      }, true);

      // ANALYTIC SMOOTH FLOOR via VELOCITY (no teleport = no fake motion = no hop).
      // Compute how far the ball is from the smooth surface, and set its vertical
      // velocity to close that gap smoothly this step. Clamp upward pop so it can't hop.
      const tpos = b.body.translation();
      const floorY = smoothFloorY(tpos, b.hint, N) + BALL_R * 1.5;
      const gap = floorY - tpos.y;          // >0 means ball is below the surface
      const lv = b.body.linvel();
      // THE FLOOR ENDS AT THE TRACK EDGE. The analytic floor is infinite math — without
      // this check a ball knocked sideways past the edge kept gliding on an invisible
      // floor and ground against the OUTSIDE of the wall forever (the stuck-ball bug),
      // and "falls = elimination" could never trigger. On the track: smooth floor. Past
      // the edge: nothing under you — gravity takes over, checkFalls() eliminates you.
      // Platform is exempt (wide flat staging area, always supported).
      const edgeMargin = BALL_R * 1.6;      // a ball can hang slightly over the lip
      // On fork lanes the floor spans the whole widened corridor (n.corridorHalfW,
      // measured from the MAIN centerline) — only the divider separates lanes.
      const onSurface = n.isPlatform || (n.corridorHalfW != null
        ? Math.abs(curLat + n.laneOff) <= n.corridorHalfW + edgeMargin
        : Math.abs(curLat) <= n.halfW + edgeMargin);
      // GROUNDED = at or below the surface (within a small band). When grounded, rest the
      // ball ON the surface with zero vertical velocity. No gap-chasing = no vibration.
      if (onSurface && gap > -0.35) {        // touching or pressed into floor
        b._grounded = true;
        // place on the surface
        b.body.setTranslation({ x: tpos.x, y: floorY, z: tpos.z }, true);
        // SLOPE-FOLLOWING vertical velocity: look at where the floor is one step ahead
        // along the ball's actual motion, and descend at exactly that rate. The ball
        // rides the slope like a rail - it never separates, never flickers airborne.
        const aheadX = tpos.x + lv.x * dt;
        const aheadZ = tpos.z + lv.z * dt;
        const floorAhead = smoothFloorY({ x: aheadX, y: tpos.y, z: aheadZ }, b.hint, N) + BALL_R * 1.5;
        const slopeVy = (floorAhead - floorY) / dt;   // feed-forward, not feedback
        b.body.setLinvel({ x: lv.x, y: slopeVy, z: lv.z }, true);
      } else {
        b._grounded = false;
        // genuinely airborne (knocked up / off a drop / past the edge) - gravity wins
      }
      if (b.boost > 0) b.boost = Math.max(0, b.boost - dt * 0.8);

      // STUCK WATCHDOG: a live, grounded ball crawling below walking pace for several
      // seconds is wedged (pile-up jam, wall pin, funnel throat). Give it a firm shove
      // forward along the track plus a nudge back toward the centerline. Safety net for
      // any jam we haven't predicted — players should never see a permanently dead ball.
      const hs0 = Math.hypot(lv.x, lv.z);
      if (b._grounded && hs0 < 0.6) {
        b._stuckT = (b._stuckT || 0) + dt;
        if (b._stuckT > 2.5) {
          b._stuckT = 0;
          const m = b.body.mass() || 1;
          b.body.applyImpulse({
            x: (fx - r.x * Math.sign(curLat) * 0.4) * m * 5,
            y: 0.0,
            z: (fz - r.z * Math.sign(curLat) * 0.4) * m * 5,
          }, true);
        }
      } else {
        b._stuckT = 0;
      }

      // horizontal speed clamp so balls don't run away (vertical handled by floor logic)
      const v = b.body.linvel();
      const hs = Math.hypot(v.x, v.z);
      const cap = MAX_SPEED * (b.boost > 0 ? 1.5 : 1);
      if (hs > cap) {
        const s = cap / hs;
        b.body.setLinvel({ x: v.x * s, y: v.y, z: v.z * s }, true);
      }
    }
    world.step();
  }

  // Read all ball states - the REAL current physics position (no interpolation).
  function snapshot() {
    const out = {};
    for (const [id, b] of balls) {
      const t = b.body.translation();
      const lv = b.body.linvel();
      out[id] = { x: t.x, y: t.y, z: t.z, vx: lv.x, vz: lv.z, alive: b.alive, hint: b.hint, branch: b.branch||null, progress: b.progress||b.hint };
    }
    return out;
  }

  // Mark a ball eliminated (e.g. fell off). Keeps body briefly for the fall animation.
  function eliminate(id) {
    const b = balls.get(id); if (b) b.alive = false;
  }

  // Detect balls that have fallen well below the track (off the edge).
  function checkFalls(threshold) {
    const fallen = [];
    for (const [id, b] of balls) {
      if (!b.alive) continue;
      const t = b.body.translation();
      const N = ballNodes(b);
      const n = N[Math.min(b.hint, N.length-1)];
      if (t.y < n.pos.y - (threshold || 10)) { b.alive = false; fallen.push(id); }
    }
    return fallen;
  }

  // Which ball is furthest along the track (highest node index)? = current leader.
  function leader() {
    let bestId = null, bestP = -1;
    for (const [id, b] of balls) {
      const pr = b.progress != null ? b.progress : b.hint;
      if (b.alive && pr > bestP) { bestP = pr; bestId = id; }
    }
    return bestId;
  }

  return {
    init, setTrack, addBall, removeBall, clearBalls, giveBoost,
    step, snapshot, eliminate, checkFalls, leader,
    nearestNode,
    isReady: () => ready,
    getError: () => lastError,
    count: () => balls.size,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { ZPHYSICS };
