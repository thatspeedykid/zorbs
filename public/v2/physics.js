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
  const balls = new Map(); // id -> { body, drive, lane, speedMul, alive }
  let nodes = null;        // centerline for steering
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
    world.timestep = 1/60;             // FIXED timestep = smooth, no jitter
    // more solver iterations = stable resting contacts (less micro-bounce)
    if (world.integrationParameters) {
      world.integrationParameters.numSolverIterations = 8;
    }
    ready = true;
    return true;
  }

  // Install the track as a solid trimesh collider, and remember the centerline.
  function setTrack(colliderBuffers, centerline) {
    if (!ready) return;
    if (trackBody) { world.removeRigidBody(trackBody); trackBody = null; }
    nodes = centerline;
    const bd = RAPIER.RigidBodyDesc.fixed();
    trackBody = world.createRigidBody(bd);
    const cd = RAPIER.ColliderDesc
      .trimesh(colliderBuffers.positions, colliderBuffers.indices)
      .setRestitution(0.0)        // no bounce off the track surface = no hopping
      .setFriction(0.8);          // grip so balls roll instead of skid
    world.createCollider(cd, trackBody);
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
  function smoothFloorY(pos, hint) {
    if (!nodes) return pos.y;
    const i = Math.max(0, Math.min(nodes.length - 2, hint));
    const a = nodes[i], b = nodes[i + 1];
    // where is pos between node a and b? (projected onto the segment)
    const abx = b.pos.x - a.pos.x, abz = b.pos.z - a.pos.z;
    const apx = pos.x - a.pos.x, apz = pos.z - a.pos.z;
    const abLen2 = abx * abx + abz * abz || 1;
    let t = (apx * abx + apz * abz) / abLen2;
    t = Math.max(0, Math.min(1, t));
    // Catmull-Rom through the 4 surrounding nodes' heights = smooth ramp, no facets
    const y0 = nodes[Math.max(0, i - 1)].pos.y;
    const y1 = a.pos.y, y2 = b.pos.y;
    const y3 = nodes[Math.min(nodes.length - 1, i + 2)].pos.y;
    return catmull(y0, y1, y2, y3, t);
  }

  // Find the nearest centerline node index to a position (search around a hint).
  function nearestNode(pos, hint) {
    if (!nodes) return 0;
    let best = hint || 0, bestD = Infinity;
    const lo = Math.max(0, (hint || 0) - 8);
    const hi = Math.min(nodes.length - 1, (hint || 0) + 24);
    for (let i = lo; i <= hi; i++) {
      const n = nodes[i].pos;
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
      b.hint = nearestNode(t, b.hint);
      const n = nodes[b.hint];
      const nx = nodes[Math.min(b.hint + 1, nodes.length - 1)];

      // forward direction = toward the next node (down the track), NEVER sideways
      let fx = nx.pos.x - n.pos.x, fy = nx.pos.y - n.pos.y, fz = nx.pos.z - n.pos.z;
      const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;

      // lane-seek: nudge toward this ball's preferred offset from centerline (lateral only)
      const r = n.right;
      const offX = t.x - n.pos.x, offZ = t.z - n.pos.z;
      const curLat = offX * r.x + offZ * r.z;           // current lateral position
      const latErr = (b.lane - curLat);                 // toward preferred lane
      const laneFx = r.x * latErr * LANE_PULL;
      const laneFz = r.z * latErr * LANE_PULL;

      // total drive: forward + gentle lane-seek + boost. Applied as a force each
      // fixed step (consistent), and kept modest so ball-ball contacts still win.
      const drive = DRIVE_FORCE * b.speedMul * (1 + b.boost);
      b.body.addForce({
        x: fx * drive + laneFx,
        y: 0,                            // NO vertical drive - gravity keeps them planted
        z: fz * drive + laneFz,
      }, true);

      // ANALYTIC SMOOTH FLOOR via VELOCITY (no teleport = no fake motion = no hop).
      // Compute how far the ball is from the smooth surface, and set its vertical
      // velocity to close that gap smoothly this step. Clamp upward pop so it can't hop.
      const tpos = b.body.translation();
      const floorY = smoothFloorY(tpos, b.hint) + BALL_R * 1.5;
      const gap = floorY - tpos.y;          // >0 means ball is below the surface
      const lv = b.body.linvel();
      // GROUNDED = at or below the surface (within a small band). When grounded, rest the
      // ball ON the surface with zero vertical velocity. No gap-chasing = no vibration.
      if (gap > -0.35) {                     // touching or pressed into floor
        b._grounded = true;
        // place on the surface
        b.body.setTranslation({ x: tpos.x, y: floorY, z: tpos.z }, true);
        // SLOPE-FOLLOWING vertical velocity: look at where the floor is one step ahead
        // along the ball's actual motion, and descend at exactly that rate. The ball
        // rides the slope like a rail - it never separates, never flickers airborne.
        const aheadX = tpos.x + lv.x * dt;
        const aheadZ = tpos.z + lv.z * dt;
        const floorAhead = smoothFloorY({ x: aheadX, y: tpos.y, z: aheadZ }, b.hint) + BALL_R * 1.5;
        const slopeVy = (floorAhead - floorY) / dt;   // feed-forward, not feedback
        b.body.setLinvel({ x: lv.x, y: slopeVy, z: lv.z }, true);
      } else {
        b._grounded = false;
        // genuinely airborne (knocked up / off a drop) - gravity brings it down
      }
      if (b.boost > 0) b.boost = Math.max(0, b.boost - dt * 0.8);

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
      out[id] = { x: t.x, y: t.y, z: t.z, alive: b.alive, hint: b.hint };
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
      const n = nodes[b.hint];
      if (t.y < n.pos.y - (threshold || 10)) { b.alive = false; fallen.push(id); }
    }
    return fallen;
  }

  // Which ball is furthest along the track (highest node index)? = current leader.
  function leader() {
    let bestId = null, bestHint = -1;
    for (const [id, b] of balls) {
      if (b.alive && b.hint > bestHint) { bestHint = b.hint; bestId = id; }
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
