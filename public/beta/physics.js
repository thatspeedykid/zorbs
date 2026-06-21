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
  // electric bumpers: energy charges up each post; at the top it discharges, shocking nearby balls
  let bumpers = [];
  let bumpSimT = 0;
  const BUMP_RISE_CYCLE = 4.2, SHOCK_KICK = 9, SHOCK_UP = 5;   // seconds for one full hide→rise→hold→retract cycle
  // spinners: kinematic arms that rotate around a Y post and physically bat marbles sideways
  let spinners = [];

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
    // OBSTACLES: bumper pillars that RETRACT into the track and rise back up on a slow
    // cycle — telegraphed, not a permanent wall. Previously these were static colliders
    // baked directly into the fixed trackBody, which meant they could never move after
    // creation. Now each post is its own kinematicPositionBased body (like a spinner)
    // so its Y can be animated every frame: hidden flush with the floor → rises slowly →
    // holds up briefly → retracts back down. While retracted (at or below the floor) it
    // physically cannot block a ball, matching the visual of it being "in" the track.
    // BURIED FOOT: the collider extends well below the node's raw Y (see prior comment
    // history) so even at full extension its base is always under the real analytic floor
    // — no gap a ball could wedge into.
    const POST_BURY = 4.0;        // how far below the anchor the collider extends downward
    bumpers = [];
    if (forkData && forkData.obstacles) {
      forkData.obstacles.forEach((ob, k) => {
        const totalH = ob.height + POST_BURY;
        const spBd = RAPIER.RigidBodyDesc.kinematicPositionBased()
          .setTranslation(ob.pos.x, ob.pos.y, ob.pos.z);   // Y updated every frame in processBumpers
        const body = world.createRigidBody(spBd);
        // Collider is centered on the body's local origin; local Y offset places it so the
        // TOP of the cylinder sits at +ob.height above the body's translation when fully up,
        // and the BURIED base hangs POST_BURY below — same geometry as before, just on a
        // body we can now move instead of a fixed offset baked into the static mesh.
        const localCenterY = ob.height / 2 - POST_BURY / 2;
        const cd = RAPIER.ColliderDesc.cylinder(totalH / 2, ob.radius)
          .setTranslation(0, localCenterY, 0)
          .setRestitution(0.45).setFriction(0.2);
        world.createCollider(cd, body);
        bumpers.push({
          body, basePos: { x: ob.pos.x, y: ob.pos.y, z: ob.pos.z }, height: ob.height,
          shockR: ob.radius + 1.8, off: (k * 0.7) % BUMP_RISE_CYCLE, last: 0, charge: 0,
          riseY: 0,   // current vertical offset (0 = fully retracted/hidden, ob.height = fully up)
        });
      });
    }
    // SPINNERS: kinematic rigid bodies that rotate around a Y-axis post. Each spinner has
    // two arm colliders (box shapes) that the solver pushes marbles with automatically —
    // no manual impulse injection needed. We rotate the kinematic body each step by setting
    // its next rotation; Rapier's solver handles the contact response.
    spinners = [];
    if (forkData && forkData.spinners) {
      for (const sp of forkData.spinners) {
        // Arms sweep at ball-center height: ball sits on floor, center = floor + BALL_R.
        const ARM_H = BALL_R;   // hub height = ball radius above floor
        const ARM_W = 0.28;
        const armL = sp.armLen;
        // BASE ORIENTATION: align the spinner's local Y (spin axis) to the track's local
        // "up" at this node, and local X (arm rest direction) to the track's "right"
        // (fwd × up) so the spin PLANE matches the floor's tilt/bank instead of staying
        // world-flat. Without this, on a banked or descending section the arm dips below
        // or pokes through the floor as it rotates.
        const up = sp.up || { x: 0, y: 1, z: 0 };
        const fwd = sp.fwd || { x: 0, y: 0, z: 1 };
        // right = up × fwd (this handedness, with columns [right|up|fwd2], gives a proper
        // rotation matrix — determinant +1). fwd2 = right × up re-orthogonalizes fwd against
        // the (possibly non-perpendicular) up so the frame is exactly orthonormal.
        let rx = up.y*fwd.z - up.z*fwd.y, ry = up.z*fwd.x - up.x*fwd.z, rz = up.x*fwd.y - up.y*fwd.x;
        let rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
        const fx2 = ry*up.z - rz*up.y, fy2 = rz*up.x - rx*up.z, fz2 = rx*up.y - ry*up.x;
        // Rotation matrix columns: [right | up | fwd2]
        const m00 = rx, m01 = up.x, m02 = fx2;
        const m10 = ry, m11 = up.y, m12 = fy2;
        const m20 = rz, m21 = up.z, m22 = fz2;
        // Standard matrix->quaternion (Shepperd's method), each branch produces a unit quat.
        const trace = m00 + m11 + m22;
        let bqx, bqy, bqz, bqw;
        if (trace > 0) {
          const s = Math.sqrt(trace + 1.0) * 2;
          bqw = 0.25 * s; bqx = (m21 - m12) / s; bqy = (m02 - m20) / s; bqz = (m10 - m01) / s;
        } else if (m00 > m11 && m00 > m22) {
          const s = Math.sqrt(1.0 + m00 - m11 - m22) * 2;
          bqw = (m21 - m12) / s; bqx = 0.25 * s; bqy = (m01 + m10) / s; bqz = (m02 + m20) / s;
        } else if (m11 > m22) {
          const s = Math.sqrt(1.0 + m11 - m00 - m22) * 2;
          bqw = (m02 - m20) / s; bqx = (m01 + m10) / s; bqy = 0.25 * s; bqz = (m12 + m21) / s;
        } else {
          const s = Math.sqrt(1.0 + m22 - m00 - m11) * 2;
          bqw = (m10 - m01) / s; bqx = (m02 + m20) / s; bqy = (m12 + m21) / s; bqz = 0.25 * s;
        }
        const spBd = RAPIER.RigidBodyDesc.kinematicPositionBased()
          .setTranslation(sp.pos.x, sp.pos.y + ARM_H, sp.pos.z)
          .setRotation({ x: bqx, y: bqy, z: bqz, w: bqw });
        const spBody = world.createRigidBody(spBd);
        const mkArm = (signX) => {
          const cd = RAPIER.ColliderDesc.cuboid(armL * 0.5, ARM_H * 0.5, ARM_W)
            .setTranslation(signX * armL * 0.5, 0, 0)
            .setRestitution(0.25)   // gentle deflect, not a violent launch
            .setFriction(0.05);
          world.createCollider(cd, spBody);
        };
        mkArm(1); mkArm(-1);
        spinners.push({
          body: spBody,
          pos: { x: sp.pos.x, y: sp.pos.y + ARM_H, z: sp.pos.z },
          baseQuat: { x: bqx, y: bqy, z: bqz, w: bqw },
          rate: sp.rate,
          dir: sp.dir,
          angle: 0,
          armLen: armL,
        });
      }
    }
  }   // end setTrack

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
    // Window widened (was -8..+24) for extra margin: a ball on a steep drop/spiral or one
    // that's just been knocked by a spinner/launch-pin can advance several nodes per frame;
    // too-narrow a window let the hint quietly fall behind and get stuck re-confirming a
    // stale node (see the vertical de-localization guard above this call site).
    const lo = Math.max(0, (hint || 0) - 8);
    const hi = Math.min(N.length - 1, (hint || 0) + 40);
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
    const collider = world.createCollider(cd, body);

    // deterministic-ish personality from the id hash
    let h = 0; for (let k = 0; k < id.length; k++) h = (h * 31 + id.charCodeAt(k)) | 0;
    const rnd = (Math.abs(h % 1000) / 1000);
    balls.set(id, {
      body,
      collider,
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
    processSpinners(dt);   // set kinematic positions BEFORE the solver step (required by Rapier)
    processBumpers(dt);    // bumpers are now kinematic too — same ordering requirement
    fixedStep(dt);
  }

  // Quaternion multiply: a * b (Hamilton product, both {x,y,z,w})
  function quatMul(a, b) {
    return {
      x: a.w*b.x + a.x*b.w + a.y*b.z - a.z*b.y,
      y: a.w*b.y - a.x*b.z + a.y*b.w + a.z*b.x,
      z: a.w*b.z + a.x*b.y - a.y*b.x + a.z*b.w,
      w: a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z,
    };
  }

  // Advance each spinner's kinematic rotation by dt. Rapier's solver handles the rest:
  // the kinematic body sweeps through the ball's position and pushes it via contact.
  // The final rotation = baseQuat (aligns spin plane to track tilt/bank) composed with
  // a local-Y spin quaternion (the actual rotation) — so the arms sweep IN the track's
  // local plane instead of a world-flat plane that clips through banked/sloped floors.
  function processSpinners(dt) {
    if (!spinners.length) return;
    for (const sp of spinners) {
      sp.angle += sp.dir * sp.rate * dt;
      const ha = sp.angle * 0.5;
      const s = Math.sin(ha), c = Math.cos(ha);
      const spinQuat = { x: 0, y: s, z: 0, w: c };   // spin around LOCAL Y (post-base-rotation)
      const q = sp.baseQuat ? quatMul(sp.baseQuat, spinQuat) : spinQuat;
      sp.body.setNextKinematicTranslation(sp.pos);
      sp.body.setNextKinematicRotation(q);
    }
  }

  // Electric bumpers: a charge rises up each post (sawtooth 0→1). When it wraps (reaches the
  // top) the bumper DISCHARGES, shocking every ball within reach with a chaotic launch.
  // RISE/RETRACT CYCLE: a smoothstep ease through four phases so the post telegraphs its
  // danger instead of just standing there the whole race —
  //   hidden (flush with floor, harmless) → RISE (slow, visible warning) → HOLD (fully up,
  //   this is the only window it can actually hit a ball) → RETRACT (slow) → repeat.
  // riseFrac returned is 0 (fully retracted) to 1 (fully risen).
  function bumperRiseFrac(t01) {
    const HIDE = 0.10, RISE = 0.30, HOLD = 0.20, RETRACT = 0.30;  // fractions of BUMP_RISE_CYCLE, sums to 0.90 + trailing hide
    const sstep = (e) => e * e * (3 - 2 * e);
    if (t01 < HIDE) return 0;
    if (t01 < HIDE + RISE) return sstep((t01 - HIDE) / RISE);
    if (t01 < HIDE + RISE + HOLD) return 1;
    if (t01 < HIDE + RISE + HOLD + RETRACT) return 1 - sstep((t01 - HIDE - RISE - HOLD) / RETRACT);
    return 0;
  }

  function processBumpers(dt) {
    if (!bumpers.length) return;
    bumpSimT += dt;
    for (const bm of bumpers) {
      const t01 = ((bumpSimT + bm.off) % BUMP_RISE_CYCLE) / BUMP_RISE_CYCLE;
      const frac = bumperRiseFrac(t01);
      bm.riseY = frac * bm.height;
      // Move the kinematic body so the post's WORLD position rises out of / sinks into the
      // floor. At frac=0 the collider's TOP needs to sit MEANINGFULLY below the floor (not
      // just flush with it — flush still reads as a visible sliver from most camera angles,
      // see the screenshot), and at frac=1 it's exactly the original static height/position,
      // unchanged from before this feature. HIDE_DEPTH must match the renderer's value.
      const HIDE_DEPTH = 1.4;
      const topOffset = -HIDE_DEPTH + frac * (bm.height + HIDE_DEPTH);   // 0 -> -HIDE_DEPTH, height -> height
      bm.body.setNextKinematicTranslation({
        x: bm.basePos.x, y: bm.basePos.y - bm.height + topOffset, z: bm.basePos.z,
      });
      // SHOCK ZAP: only while fully risen (frac===1, i.e. inside the HOLD window) does the
      // post actually discharge — matches the idea that the danger window is the brief
      // moment it's all the way up, not the whole cycle.
      const fullyUp = frac >= 0.999;
      if (fullyUp && !bm.wasFullyUp) {
        for (const [, b] of balls) {
          if (!b.alive) continue;
          const t = b.body.translation();
          const dx = t.x - bm.basePos.x, dz = t.z - bm.basePos.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < bm.shockR * bm.shockR) {
            const d = Math.sqrt(d2) || 0.001;
            const v = b.body.linvel();
            b.body.setLinvel({ x: v.x + (dx / d) * SHOCK_KICK, y: Math.max(v.y, 0) + SHOCK_UP, z: v.z + (dz / d) * SHOCK_KICK }, true);
          }
        }
      }
      bm.wasFullyUp = fullyUp;
      bm.charge = frac;   // exposed for the renderer (now means "how risen", not "sawtooth charge")
    }
  }

  // ================= GRAVITY WELL ORBIT (scripted, not physics-driven) =================
  // A ball enters tangentially, spirals down a shrinking radius for a fixed duration while
  // circling multiple times, then exits through whichever of the N holes its final angle
  // lands on. Position is set directly each frame (setTranslation/setLinvel) rather than
  // letting Rapier's solver handle it — chosen deliberately for reliability: a ball can
  // never fly out of the well, get stuck on its wall, or behave unpredictably, at the cost
  // of it not being "real" physics (no wobble/bounce off the cone surface).
  function startWellOrbit(b, well, t) {
    // Convert the ball's current world position into (radius, angle) around the well's
    // vertical axis (centerX, centerZ at well.cx/cz), so the spiral starts exactly where
    // the ball actually is — no snapping/teleporting into position.
    const dx = t.x - well.cx, dz = t.z - well.cz;
    // CLAMP TO rOuter: confirmed in a screenshot — a ball could enter the well-detection
    // window (entryIdx ± 3, for margin against fast movement) slightly off-angle or
    // off-timing from the geometrically "ideal" entry point, putting its ACTUAL distance
    // from the well's center beyond rOuter — outside where the cone mesh visually exists at
    // all. The spiral then eased its radius down from that too-large r0, so for the first
    // stretch of the orbit the ball was floating in genuinely empty space with no track
    // under it, before the shrinking radius eventually brought it back inside the visible
    // cone. Clamping r0 to [rInner*1.05, rOuter] guarantees the orbit only ever happens
    // within the radius range the mesh actually covers.
    const r0 = Math.max(well.rInner * 1.05, Math.min(well.rOuter, Math.hypot(dx, dz)));
    const ang0 = Math.atan2(dz, dx);
    // ORBIT DIRECTION: fixed PER WELL (not per ball) — every ball in the same well spins
    // the same way, set once when the well is built (well.dir) and reused here. Originally
    // this was computed per-ball from each ball's own incoming velocity, which sounds more
    // "physical" but in practice produced near-identical results for every ball anyway
    // (balls from a normal spawn grid arrive with very similar headings), so it added no
    // real variety while making the well's spin direction inconsistent ball-to-ball, which
    // would have looked wrong visually (different balls spinning opposite ways in the same
    // funnel). well.dir is computed once in forks.js and seeded with the track.
    const dir = well.dir;
    // PER-BALL SPREAD: confirmed in simulation that balls entering close together (the
    // normal spawn-grid case) arrive at nearly identical angles, and with a fully
    // deterministic scripted spiral, identical entries produce identical exits — every
    // ball landed in the SAME hole, no real sorting at all, then piled up catastrophically
    // in that one branch's tube. Each ball gets its own random extra spin on top of the
    // well's base revolution count, which is what actually spreads otherwise-identical
    // entries across different final angles (and therefore different holes) — same idea
    // as how real coins spread out from tiny physical differences, just injected directly
    // since this orbit is scripted rather than simulated.
    const revJitter = (Math.random() - 0.5) * 1.4;   // up to ±0.7 of a full extra revolution
    if (global.__traceWell) console.log('WELL ENTER id='+b._id+' dir='+dir+' ang0='+ang0.toFixed(2)+' revJitter='+revJitter.toFixed(2));
    // COLLISION OFF DURING THE ORBIT: confirmed in simulation — even with per-ball revolution
    // jitter spreading balls across different final holes, two balls can still by chance end
    // up close together (same branch, or just transiently near each other) WHILE one or both
    // are being forcibly repositioned every frame via setTranslation. That's a teleport into
    // sudden deep overlap from Rapier's point of view, and the solver's very next step throws
    // a violent separation impulse at it — which read as "two balls collided and one got
    // flung off the edge," confirmed by tracing two balls' distance dropping to ~4.5 units
    // right before one died. The orbit is independent/scripted per ball anyway (no ball is
    // supposed to interact with another while spiraling), so the honest fix is to just turn
    // off this ball's collider for the duration — re-enabled the instant it exits.
    b.collider.setEnabled(false);
    b.inWell = {
      well, r0, ang0, dir, revJitter,
      t: 0,                                   // elapsed seconds in the orbit
      duration: well.duration,
      y0: t.y,
    };
    b.branch = null;   // not on any branch yet — committed only once the spiral finishes
  }

  function processWellOrbit(b, dt) {
    const W = b.inWell;
    W.t += dt;
    const u = Math.min(1, W.t / W.duration);          // 0 -> 1 over the orbit's duration
    const ease = u * u * (3 - 2 * u);                  // smoothstep: gentle start/end, no jolt
    const well = W.well;
    // Each ball uses the well's base revolution count PLUS its own jitter (set once at
    // entry, see startWellOrbit) — this is what spreads otherwise-identical entry angles
    // across different final angles/holes instead of every ball landing in the same one.
    const totalRev = well.revolutions + W.revJitter;
    const radius = W.r0 + (well.rInner - W.r0) * ease;
    const y = W.y0 + (well.yBottom - W.y0) * ease;
    const ang = W.ang0 + W.dir * totalRev * 6.2832 * ease;
    const x = well.cx + Math.cos(ang) * radius;
    const z = well.cz + Math.sin(ang) * radius;
    // Velocity is set to the spiral's own instantaneous tangent+radial direction (numerical
    // derivative via a tiny forward-step) so that if the orbit ends or is interrupted, the
    // ball's linvel already points the right way instead of whatever it had on entry.
    const u2 = Math.min(1, (W.t + dt) / W.duration);
    const ease2 = u2 * u2 * (3 - 2 * u2);
    const radius2 = W.r0 + (well.rInner - W.r0) * ease2;
    const y2 = W.y0 + (well.yBottom - W.y0) * ease2;
    const ang2 = W.ang0 + W.dir * totalRev * 6.2832 * ease2;
    const x2 = well.cx + Math.cos(ang2) * radius2, z2 = well.cz + Math.sin(ang2) * radius2;
    b.body.setTranslation({ x, y, z }, true);
    b.body.setLinvel({ x: (x2 - x) / dt, y: (y2 - y) / dt, z: (z2 - z) / dt }, true);

    if (u >= 1) {
      // SPIRAL DONE: bin the final angle into one of N holes (equal angular slices around
      // the circle), then hand off to that branch's tube exactly like the sorter's commit —
      // same downstream code (node-following, lane-pull, spinners/bumpers/launch-pins on
      // the branch) with zero changes needed there.
      let frac = ang / 6.2832; frac -= Math.floor(frac); if (frac < 0) frac += 1;  // 0..1 around the circle
      const idx = Math.min(well.branchOrder.length - 1, Math.floor(frac * well.branchOrder.length));
      b.branch = well.branchOrder[idx];
      b.branchFork = well;
      b.hint = 0;
      b.collider.setEnabled(true);   // back to normal collision now that it's committed
      b.inWell = null;
    }
  }

  function fixedStep(dt) {
    for (const [, b] of balls) {
      if (!b.alive) continue;
      b.body.resetForces(true);   // clear last step's drive so forces don't compound
      const t = b.body.translation();

      // GRAVITY WELL: a scripted spiral, not a node-follow. When a ball (not already
      // spiraling) reaches a well fork's entry index, it's handed off entirely to
      // processWellOrbit() — position/rotation driven directly each frame in a shrinking
      // spiral, completely bypassing the normal node-following/lane-pull/drive logic below
      // for as long as the orbit lasts. This is the SCRIPTED approach (not real physics on
      // a sloped collider) — guaranteed predictable, no risk of a ball flying out of the
      // well or getting stuck on it.
      if (b.inWell) {
        processWellOrbit(b, dt);
        continue;   // skip the rest of this ball's normal step entirely while spiraling
      }
      if (!b.branch && forks) {
        const well = forks.find(f => f.isWell && b.hint >= f.entryIdx - 3 && b.hint <= f.entryIdx + 3);
        if (well) {
          startWellOrbit(b, well, t);
          continue;
        }
      }

      // FORK COMMIT: if on the main path and we've reached a fork's split point, pick a
      // lane based on the ball's lateral position, then follow ONLY that lane.
      // SORTER FORKS commit at the THROAT (f.throatIdx), not splitIdx — that's where the
      // bowl has actually narrowed down to the holes, and the holes are spread according
      // to the bowl's own geometry (can be wider than the trunk's width back at splitIdx).
      // Binning at splitIdx against the wrong width would pick a hole that doesn't match
      // where the ball visually ends up relative to the holes once it reaches the bottom.
      // Legacy fan forks (no throatIdx) keep committing at splitIdx exactly as before.
      if (!b.branch && forks) {
        for (const f of forks) {
          if (f.isWell) continue;   // wells are committed exclusively via startWellOrbit
                                      // above (entryIdx, not splitIdx/throatIdx) — without
                                      // this exclusion this loop's fallback-to-splitIdx commit
                                      // raced the well's own entry check and usually won
                                      // (splitIdx sits BEFORE entryIdx), skipping the orbit
                                      // entirely and committing the ball to a random lane
                                      // the instant it crossed splitIdx.
          const commitIdx = (f.throatIdx != null) ? f.throatIdx : f.splitIdx;
          if (b.hint >= commitIdx - 1 && b.hint <= commitIdx + 1) {
            const sn = nodes[commitIdx];
            const latv = (t.x - sn.pos.x)*sn.right.x + (t.z - sn.pos.z)*sn.right.z;
            const order = f.branchOrder;
            if (order && order.length) {
              // bin lateral position into one of N fan lanes (left→right). commitHalfW (set
              // on sorter-fork throat nodes) reflects the actual hole-spread radius, which can
              // be wider than the throat's own narrow visual halfW — fall back to halfW for
              // legacy fan forks where the two are the same thing.
              const hw = sn.commitHalfW || sn.halfW || 7;
              let frac = (latv / hw + 1) / 2;            // 0 (far left) .. 1 (far right)
              frac = Math.max(0, Math.min(0.99999, frac));
              b.branch = order[Math.floor(frac * order.length)];
            } else {
              b.branch = latv < 0 ? f.id+'_A' : f.id+'_B';   // legacy two-lane fallback
            }
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
        // VERTICAL-ONLY CHECK: the combined-distance check above is calibrated for being
        // knocked sideways (where halfW*5 is a sensible lateral budget), but it's far too
        // loose for vertical drift — a ball that's merely fallen behind its hint on a
        // descending track can rack up |ddy| > 20 while staying perfectly on-lane, never
        // tripping the combined check, and the narrow nearestNode() window (hint-8..hint+24)
        // can get stuck re-confirming the same stale hint forever once the ball is physically
        // past its search range. That silent drift is exactly what eventually trips
        // checkFalls() and erroneously eliminates a ball that never actually fell off
        // anything. A tight standalone Y check catches it long before that.
        const vlim = 10;   // a healthy ball should rarely be >10 units below its hint's Y
        if (ddx*ddx + ddy*ddy + ddz*ddz > lim*lim || ddy < -vlim) {
          b.hint = nearestNodeWide(t, b.hint, 300, curNodes);
        }
      }

      // WELL STUB MERGE: a non-real well branch is a short stub (see makeWellFork) — once
      // a ball reaches its end, snap it onto the well's REAL branch (the one that actually
      // continues/rejoins the main path) at a random point along that branch's own length,
      // invisibly. This must run BEFORE the generic REJOIN check below: that check's
      // fallback guess (splitIdx + curNodes.length, projected onto the MAIN node list) is
      // only sane for branches that physically continue forward from the split — a well's
      // stub branches dive in a completely different direction/depth, so the generic
      // fallback would guess a wildly wrong location (the original fall-through bug this
      // session already fixed once for the real branch; stubs need their own explicit path
      // rather than relying on that same fallback by omission).
      if (b.branch && b.branchFork && b.branchFork.isWell && b.branch !== b.branchFork.realBranchId
          && b.hint >= curNodes.length - 2) {
        const realArr = branchNodes[b.branchFork.realBranchId];
        if (realArr && realArr.length) {
          // land somewhere in the back 60% of the real branch's length — never right at its
          // very start (would look like teleporting ahead of where it should be) and never
          // past its own end.
          const landIdx = Math.floor(realArr.length * (0.35 + Math.random() * 0.55));
          b.branch = b.branchFork.realBranchId;
          b.hint = landIdx;
          const ln = realArr[Math.min(landIdx, realArr.length - 1)];
          b.body.setTranslation({ x: ln.pos.x, y: ln.pos.y + 0.05, z: ln.pos.z }, true);
        } else {
          // defensive fallback if something's missing — behave like the generic rejoin
          b.branch = null; b.branchFork = null;
          b.hint = nearestNodeWide(t, b.branchFork.splitIdx + curNodes.length, 80, nodes);
        }
        // BUGFIX: curNodes (captured above, before this block ran) still refers to the OLD
        // stub array's length. Without this continue, the very next check (generic REJOIN,
        // right below) re-tests b.hint >= curNodes.length-2 using that STALE length against
        // the ball's NEW b.hint (an index into the much-longer real branch) — which is
        // almost always still true, so it immediately re-triggers on the same frame and
        // sends the ball through the generic rejoin's fallback guess onto the MAIN path at
        // a nonsensical position. Confirmed in simulation: this was firing on effectively
        // every stub-branch ball, which is why the whole well regression suite (339/340)
        // broke the moment this stub-merge feature was added. Skipping the rest of this
        // ball's step for the frame it merges is harmless — one frame of using its old
        // velocity is imperceptible, and next frame everything reads fresh or branch.
        continue;
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
      } else if (n.kind === 'sorter') {
        // SORTER BOWL APPROACH: the trunk is narrowing down toward the throat/holes. Pull
        // gently toward center (not too hard — the ball's natural lateral position here is
        // exactly what decides WHICH hole it falls through, so a heavy-handed snap-to-center
        // would homogenize everyone into the same hole instead of preserving the spread that
        // makes the sort meaningful). Just strong enough to stop unbounded drift before the
        // narrowing floor edge can catch someone who was riding the original wide trunk edge.
        targetLane = b.lane;
        lanePull = LANE_PULL * 1.3;
      } else if (n.kind === 'tube') {
        // SORTER DROP-TUBE: a ball just committed to this lane by falling through a hole —
        // it can be carrying meaningful uncontrolled lateral momentum from that fall, and
        // the tube itself is intentionally narrow (visually reads as a chute). Pull hard
        // toward dead-center (not the ball's personal lane offset — there's no room for
        // individual spread in a tube) so it recenters fast instead of drifting toward the
        // tube's tight walls. Confirmed in simulation: without this, tube nodes fell through
        // to the default (weakest) lane pull and a ball could drift ~9+ units off-center
        // before the tube widened enough to forgive it, going airborne/off-edge the whole way.
        targetLane = 0;
        lanePull = LANE_PULL * 2.5;
      } else if (n.kind === 'route') {
        // DIVERGENT ROUTES: keep the ball in the inner band (clear of the gap edge) but
        // let it keep some lateral spread so balls don't clump and pile up at the exit.
        targetLane = Math.max(-n.halfW*0.5, Math.min(n.halfW*0.5, b.lane * 0.6));
        lanePull = LANE_PULL * 2.0;
      } else if (n.kind === 'funnel' || n.kind === 'narrower') {
        // FUNNEL/NARROWER PINCH: the corridor can shrink well below a ball's normal lane
        // offset (b.lane up to ±0.7, plus whatever lateral velocity it's carrying from pack
        // jostling). A handful of balls were getting caught right at the narrowest point of
        // a pinch and falling off the edge (confirmed in simulation: curLat ~2-3 against a
        // halfW that had shrunk to ~3.7) — the default lane pull just wasn't reacting fast
        // enough relative to how quickly the corridor closes in. Pull harder AND tighten the
        // target band proportionally to how narrow the corridor currently is, so the ball is
        // already centering well before the pinch reaches its minimum.
        const squeeze = Math.max(0.35, Math.min(1, n.halfW / 7.0));   // 1 = full width, lower = tighter pinch
        targetLane = Math.max(-n.halfW*0.6, Math.min(n.halfW*0.6, b.lane * squeeze));
        lanePull = LANE_PULL * 1.8;
      }
      const latErr = (targetLane - curLat);             // toward preferred/churn lane
      // DAMPING: the lane-seek was pure-proportional (force ∝ position error only), which
      // is an undamped spring — every frame it overshoots the target, swings past, gets
      // pulled back, overshoots again, and on 'route' nodes (lanePull doubled to 4.4 for
      // divergent fork lanes) the overshoot GROWS frame over frame instead of settling,
      // producing a real, escalating side-to-side zig-zag down the whole branch (confirmed
      // in simulation: curLat swinging roughly ±3 to ±4.4 and widening). Adding a term
      // proportional to LATERAL VELOCITY (a standard PD controller) brakes the ball as it
      // approaches the target instead of slamming through it, so it settles instead of
      // oscillating. Velocity is split into along-forward and along-right components; only
      // the lateral (right) component is damped — forward speed is untouched.
      const lv0 = b.body.linvel();
      const latVel = lv0.x * r.x + lv0.z * r.z;          // current lateral velocity
      const LANE_DAMP = 0.55;                            // damping ratio relative to lanePull
      const laneFx = r.x * (latErr * lanePull - latVel * lanePull * LANE_DAMP);
      const laneFz = r.z * (latErr * lanePull - latVel * lanePull * LANE_DAMP);

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

      // LAUNCH-PINS: a discrete one-time pop, not a continuous force. Triggers once per
      // pad crossing (cooldown via b._launchCD keyed to this node range so re-entering
      // the SAME pad next frame can't re-fire, but a different pad later still can).
      // _launchT is a brief grace window during which the floor-snap below is skipped,
      // so the upward impulse actually gets to arc instead of being clamped back to the
      // surface on the very next line.
      if (n.launch && (!b._launchCD || b._launchCD <= 0)) {
        const m2 = b.body.mass() || 1;
        const lv0 = b.body.linvel();
        b.body.applyImpulse({
          x: fx * n.launch.fwdBoost * n.launch.power * m2,
          y: n.launch.power * m2,
          z: fz * n.launch.fwdBoost * n.launch.power * m2,
        }, true);
        b._launchCD = 1.2;     // seconds before this ball can trigger another launch-pin
        b._launchT = 0.5;      // seconds of grace where floor-snap is suppressed (let it arc)
        b._launchRecoverT = 2.5;  // generous window AFTER the arc to actively re-catch the floor
        b._justLaunched = true;   // one-shot edge for the renderer to trigger a flash
      }
      if (b._launchCD > 0) b._launchCD -= dt;
      if (b._launchT > 0) b._launchT -= dt;
      if (b._launchRecoverT > 0) b._launchRecoverT -= dt;

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
      // LAUNCH GRACE: while b._launchT is counting down, skip the snap entirely so the
      // upward impulse from a launch-pin actually arcs instead of being clamped back to
      // the floor on the very next physics step (the bug this exists to avoid).
      const inLaunchGrace = b._launchT > 0;
      // POST-LAUNCH RE-CATCH: confirmed in simulation that a launch on a long, gently
      // descending section can leave the ball airborne well past the no-snap grace window
      // (the floor keeps dropping underneath it for longer than the ballistic arc takes to
      // come back down), and the standard tight gap>-0.35 threshold then never lets it
      // re-catch the floor before checkFalls() eliminates a ball that was never actually off
      // the track. _launchRecoverT gives a short, separate window AFTER a launch where the
      // re-catch tolerance is much looser (it can snap back to the floor from further away),
      // recovering from a long arc instead of leaving it purely to gravity vs. a fixed band.
      const recoverGap = (b._launchRecoverT > 0) ? -4.0 : -0.35;
      if (!inLaunchGrace && onSurface && gap > recoverGap) {        // touching or pressed into floor
        b._grounded = true;
        b._launchRecoverT = 0;   // re-caught — recovery window spent
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
      out[id] = { x: t.x, y: t.y, z: t.z, vx: lv.x, vz: lv.z, alive: b.alive, hint: b.hint, branch: b.branch||null, progress: b.progress||b.hint, boost: b.boost||0, justLaunched: !!b._justLaunched };
      b._justLaunched = false;   // one-shot edge — cleared right after this snapshot reads it
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
      if (b.inWell) continue;   // mid-orbit: Y is scripted and legitimately drops fast
                                  // (yTop -> yBottom over the spiral) — comparing that
                                  // against b.hint's STALE pre-well node reference (the
                                  // ball isn't following any node list while orbiting)
                                  // produced false "fell off the track" eliminations
                                  // mid-spiral, on a completely successful, intentional drop.
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
    getBumpers: () => bumpers,
    getSpinners: () => spinners,
    step, snapshot, eliminate, checkFalls, leader,
    nearestNode,
    isReady: () => ready,
    getError: () => lastError,
    count: () => balls.size,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { ZPHYSICS };
