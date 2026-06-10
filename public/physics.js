// ZORBS Rapier physics layer (host-only authoritative).
// Loads Rapier (WASM) from CDN at runtime. If it fails, ZPHYS.ready stays false and the
// game falls back to the legacy hand-rolled stepPhysics. Rapier handles all COLLISION
// (track, walls, ball-vs-ball); our game keeps applying a forward DRIVE force so balls
// always race forward and never stall when they lose velocity.
const ZPHYS = (() => {
  let RAPIER = null, world = null, ready = false;
  let trackCollider = null, trackBody = null;
  const bodies = new Map();   // name -> { body, collider }
  let BALL_R = 0.5;

  async function init(ballRadius) {
    BALL_R = ballRadius || 0.5;
    try {
      // rapier3d-compat: WASM inlined as base64, default export. +esm gives a clean module.
      const mod = await import('https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.17.3/+esm');
      RAPIER = mod.default || mod;
      await RAPIER.init();
      world = new RAPIER.World({ x: 0, y: -32.0, z: 0 }); // strong gravity = snappy marble feel
      ready = true;
      console.log('[ZPHYS] Rapier ready');
      window._physOk = true;
      return true;
    } catch (e) {
      console.warn('[ZPHYS] Rapier failed to load, using legacy physics:', e);
      window._physError = (e && e.message) ? e.message : String(e);
      ready = false;
      return false;
    }
  }

  // Build a single static trimesh collider from the track floor+wall triangles.
  // verts: Float32Array of xyz; indices: Uint32Array of triangle indices.
  function setTrack(vertices, indices) {
    if (!ready) return;
    if (trackBody) { world.removeRigidBody(trackBody); trackBody = null; trackCollider = null; }
    const bodyDesc = RAPIER.RigidBodyDesc.fixed();
    trackBody = world.createRigidBody(bodyDesc);
    const colDesc = RAPIER.ColliderDesc.trimesh(vertices, indices)
      .setRestitution(0.25).setFriction(0.4);
    trackCollider = world.createCollider(colDesc, trackBody);
  }

  function addBall(name, x, y, z) {
    if (!ready) return;
    if (bodies.has(name)) return;
    const bd = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setLinearDamping(0.25).setAngularDamping(0.4)
      .setCcdEnabled(true); // continuous collision so fast balls never tunnel through walls
    const body = world.createRigidBody(bd);
    const cd = RAPIER.ColliderDesc.ball(BALL_R)
      .setRestitution(0.55).setFriction(0.3).setDensity(1.0);
    const collider = world.createCollider(cd, body);
    bodies.set(name, { body, collider });
  }

  function removeBall(name) {
    if (!ready) return;
    const b = bodies.get(name);
    if (b) { world.removeRigidBody(b.body); bodies.delete(name); }
  }

  function hasBall(name){ return bodies.has(name); }

  // Apply a forward drive impulse (keeps the ball racing). dirx/dirz = track heading.
  function drive(name, dirx, dirz, force, maxSpeed) {
    if (!ready) return;
    const b = bodies.get(name); if (!b) return;
    const v = b.body.linvel();
    const hSpd = Math.hypot(v.x, v.z);
    // Always push toward the track direction
    b.body.applyImpulse({ x: dirx*force, y: 0, z: dirz*force }, true);
    // Soft speed clamp on horizontal only
    if (maxSpeed && hSpd > maxSpeed) {
      const s = maxSpeed / hSpd;
      b.body.setLinvel({ x: v.x*s, y: v.y, z: v.z*s }, true);
    }
  }

  // Generic impulse (boosts, hammer knocks, spike launches)
  function impulse(name, ix, iy, iz) {
    if (!ready) return;
    const b = bodies.get(name); if (!b) return;
    b.body.applyImpulse({ x: ix, y: iy, z: iz }, true);
  }

  function getPos(name) {
    if (!ready) return null;
    const b = bodies.get(name); if (!b) return null;
    const t = b.body.translation();
    return { x: t.x, y: t.y, z: t.z };
  }
  function getVel(name) {
    if (!ready) return null;
    const b = bodies.get(name); if (!b) return null;
    const v = b.body.linvel();
    return { x: v.x, y: v.y, z: v.z };
  }
  function setPos(name, x, y, z) {
    if (!ready) return;
    const b = bodies.get(name); if (!b) return;
    b.body.setTranslation({ x, y, z }, true);
    b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  }

  function step() { if (ready) world.step(); }

  function clearBalls(){
    if(!ready) return;
    for (const [name,b] of bodies){ world.removeRigidBody(b.body); }
    bodies.clear();
  }

  return {
    init, setTrack, addBall, removeBall, hasBall, drive, impulse,
    getPos, getVel, setPos, step, clearBalls,
    isReady: () => ready,
  };
})();
