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
    world = new RAPIER.World({ x: 0, y: -24, z: 0 });
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
      .setRestitution(0.18)
      .setFriction(0.55);
    world.createCollider(cd, trackBody);
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
      .setLinearDamping(0.35)
      .setAngularDamping(0.6)
      .setCcdEnabled(true); // fast balls never tunnel through walls
    const body = world.createRigidBody(bd);
    const cd = RAPIER.ColliderDesc.ball(BALL_R)
      .setRestitution(0.45).setFriction(0.4).setDensity(1.0);
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

  // Step the world once. dt is seconds. Applies drive BEFORE the physics solve.
  function step(dt) {
    if (!ready) return;
    for (const [, b] of balls) {
      if (!b.alive) continue;
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

      // total drive force: forward + gentle lane-seek + boost
      const drive = DRIVE_FORCE * b.speedMul * (1 + b.boost);
      const impulse = {
        x: (fx * drive + laneFx) * dt,
        y: (fy * drive) * dt,
        z: (fz * drive + laneFz) * dt,
      };
      b.body.applyImpulse(impulse, true);
      if (b.boost > 0) b.boost = Math.max(0, b.boost - dt * 0.8);

      // soft speed clamp on horizontal velocity so balls don't run away
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

  // Read all ball states (for rendering and for broadcasting to viewers).
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
