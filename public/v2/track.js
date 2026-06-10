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
  const STEP = 2.2;           // distance between centerline nodes
  const DROP_PER_STEP = 0.42; // average descent per node (the "downhill")

  // Build the centerline as an array of nodes:
  //   { pos, dir, right, up, halfW, bank }  — everything physics & mesh need.
  function buildCenterline(seed, targetNodes) {
    const rng = mulberry32(seed);
    const nodes = [];

    // start pointing forward (+z), slightly downhill
    let pos = v(0, 0, 0);
    let heading = norm(v(0, -0.18, 1)); // initial downhill direction

    // a "turn rate" that eases in and out so curves are smooth, not kinked
    let turn = 0;          // current yaw rate (radians/step)
    let targetTurn = 0;    // where turn is easing toward
    let segLeft = 0;       // steps remaining in the current move
    let bank = 0;          // current banking angle
    let targetBank = 0;

    const worldUp = v(0, 1, 0);

    for (let i = 0; i < targetNodes; i++) {
      // start a new move when the current one runs out
      if (segLeft <= 0) {
        const r = rng();
        if (r < 0.40) {
          // straight-ish run
          targetTurn = (rng() - 0.5) * 0.01;
          targetBank = 0;
          segLeft = 14 + Math.floor(rng() * 18);
        } else if (r < 0.80) {
          // sweeping turn (banked)
          const dir = rng() < 0.5 ? 1 : -1;
          const sharp = 0.018 + rng() * 0.040;
          targetTurn = dir * sharp;
          targetBank = dir * Math.min(0.5, sharp * 9); // bank into the curve
          segLeft = 16 + Math.floor(rng() * 22);
        } else {
          // steeper plunge (more downhill, mild wiggle)
          targetTurn = (rng() - 0.5) * 0.03;
          targetBank = 0;
          segLeft = 10 + Math.floor(rng() * 12);
        }
      }

      // ease turn and bank toward their targets (smooth transitions)
      turn += (targetTurn - turn) * 0.12;
      bank += (targetBank - bank) * 0.10;

      // rotate heading around world-up by 'turn'
      const cosT = Math.cos(turn), sinT = Math.sin(turn);
      const hx = heading.x * cosT - heading.z * sinT;
      const hz = heading.x * sinT + heading.z * cosT;
      heading = v(hx, heading.y, hz);

      // enforce downhill: keep a downward component on y
      heading.y += (-DROP_PER_STEP / STEP - heading.y) * 0.08;
      heading = norm(heading);

      // advance
      pos = add(pos, scale(heading, STEP));

      // right vector (perpendicular, in the horizontal-ish plane)
      const right = norm(cross(heading, worldUp));
      // up vector for the ribbon, tilted by bank
      const up = norm(cross(right, heading));

      // gentle width variation makes the course read as less uniform
      const halfW = WIDTH * (0.9 + 0.18 * Math.sin(i * 0.06));

      nodes.push({ pos, dir: heading, right, up, halfW, bank });
      segLeft--;
    }
    return nodes;
  }

  // Turn the centerline into a triangle mesh (floor + two walls), welded seam-to-seam.
  // Returns { positions:Float32Array, indices:Uint32Array } in a single buffer,
  // plus separate arrays the renderer can use for materials if desired.
  function buildMesh(nodes) {
    const floorPos = [];
    const wallPos = [];
    const floorIdx = [];
    const wallIdx = [];

    // For each node compute the left/right floor edge and the wall-top edge,
    // applying bank (tilt) so turns lean inward.
    function ring(n) {
      const bankUp = applyBank(n);
      const lf = add(n.pos, scale(n.right, -n.halfW)); // left floor
      const rf = add(n.pos, scale(n.right, n.halfW));  // right floor
      const lw = add(lf, scale(bankUp, 1.5));          // left wall top
      const rw = add(rf, scale(bankUp, 1.5));          // right wall top
      return { lf, rf, lw, rw };
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
    let vi = 0;     // floor vertex counter
    let wvi = 0;    // wall vertex counter
    for (let i = 0; i < nodes.length; i++) {
      const cur = ring(nodes[i]);
      if (prev) {
        // floor quad: prev.lf, prev.rf, cur.rf, cur.lf
        pushQuad(floorPos, floorIdx, prev.lf, prev.rf, cur.rf, cur.lf, vi); vi += 4;
        // left wall quad: prev.lf, prev.lw, cur.lw, cur.lf
        pushQuad(wallPos, wallIdx, prev.lf, prev.lw, cur.lw, cur.lf, wvi); wvi += 4;
        // right wall quad: prev.rf, prev.rw, cur.rw, cur.rf
        pushQuad(wallPos, wallIdx, prev.rf, prev.rw, cur.rw, cur.rf, wvi); wvi += 4;
      }
      prev = cur;
    }

    return {
      floor: { positions: new Float32Array(floorPos), indices: new Uint32Array(floorIdx) },
      walls: { positions: new Float32Array(wallPos), indices: new Uint32Array(wallIdx) },
    };
  }

  function pushQuad(pos, idx, a, b, c, d, base) {
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  // Build a combined collider buffer (floor + walls) for the physics engine.
  function buildColliderBuffers(nodes) {
    const m = buildMesh(nodes);
    const positions = [];
    const indices = [];
    let base = 0;
    for (const part of [m.floor, m.walls]) {
      for (let k = 0; k < part.positions.length; k++) positions.push(part.positions[k]);
      for (let k = 0; k < part.indices.length; k++) indices.push(part.indices[k] + base);
      base += part.positions.length / 3;
    }
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
  }

  // Top-level: given a seed and a target length (seconds-ish), produce everything.
  function generate(seed, lengthNodes = 700) {
    const nodes = buildCenterline(seed, lengthNodes);
    const mesh = buildMesh(nodes);
    const collider = buildColliderBuffers(nodes);
    const start = nodes[0];
    const finish = nodes[nodes.length - 1];
    return { seed, nodes, mesh, collider, start, finish };
  }

  return { generate, buildCenterline, buildMesh, buildColliderBuffers, mulberry32 };
})();

// Export for Node (server host) while staying a plain global in the browser.
if (typeof module !== 'undefined' && module.exports) module.exports = { ZTRACK };
