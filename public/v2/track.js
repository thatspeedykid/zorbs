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
  const STEP = 1.3;           // finer spacing = smaller facets, smoother look
  const DROP_PER_STEP = 0.42; // average descent per node (the "downhill")

  // Build the centerline as an array of nodes:
  //   { pos, dir, right, up, halfW, bank }  — everything physics & mesh need.
  function buildCenterline(seed, targetNodes, ballCount) {
    const rng = mulberry32(seed);
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
    let funnelLen = 1, funnelPos = 0;

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
        const r = rng();
        moveKind = 'straight'; extraDrop = 0; funnelMin = 0; tunnel = false;
        if (r < 0.32) {
          // straight-ish run
          targetTurn = (rng() - 0.5) * 0.01;
          targetBank = 0;
          segLeft = 14 + Math.floor(rng() * 18);
        } else if (r < 0.62) {
          // sweeping turn (banked)
          const dir = rng() < 0.5 ? 1 : -1;
          const sharp = 0.018 + rng() * 0.040;
          targetTurn = dir * sharp;
          targetBank = dir * Math.min(0.5, sharp * 9);
          segLeft = 16 + Math.floor(rng() * 22);
        } else if (r < 0.74) {
          // DROP: steep plunge straight down-ish, narrow & fast
          moveKind = 'drop';
          targetTurn = (rng() - 0.5) * 0.015;
          targetBank = 0;
          extraDrop = 1.4 + rng() * 1.2;   // much steeper descent
          segLeft = 8 + Math.floor(rng() * 8);
        } else if (r < 0.86) {
          // FUNNEL: track squeezes narrow then opens back up (bunches the pack)
          moveKind = 'funnel';
          targetTurn = (rng() - 0.5) * 0.01;
          targetBank = 0;
          funnelMin = 0.42 + rng() * 0.12; // squeeze to ~45% width at the throat
          segLeft = 18 + Math.floor(rng() * 10);
          funnelLen = segLeft;
        } else {
          // TUNNEL: enclosed run with a ceiling (visual + keeps balls in)
          moveKind = 'tunnel';
          const dir = rng() < 0.5 ? 1 : -1;
          targetTurn = dir * (rng() * 0.02);
          targetBank = 0;
          tunnel = true;
          segLeft = 20 + Math.floor(rng() * 16);
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
      if (moveKind === 'funnel') {
        funnelPos = 1 - (segLeft / funnelLen);        // 0..1 across the funnel
        const throat = 1 - Math.sin(funnelPos * Math.PI) * (1 - funnelMin); // V then back
        widthFactor *= throat;
      }
      const halfW = WIDTH * widthFactor;

      nodes.push({ pos, dir: heading, right, up, halfW, bank, kind: moveKind, tunnel });
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
      return { lf, rf, lw, rw, lc, rc, tunnel: !!n.tunnel };
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
    for (let i = 0; i < nodes.length; i++) {
      const cur = ring(nodes[i]);
      if (prev) {
        pushQuad(floorPos, floorIdx, prev.lf, prev.rf, cur.rf, cur.lf, vi); vi += 4;
        // taller walls inside tunnels (use ceiling height as wall top there)
        const pLW = prev.tunnel ? prev.lc : prev.lw, pRW = prev.tunnel ? prev.rc : prev.rw;
        const cLW = cur.tunnel ? cur.lc : cur.lw,  cRW = cur.tunnel ? cur.rc : cur.rw;
        pushQuad(wallPos, wallIdx, prev.lf, pLW, cLW, cur.lf, wvi); wvi += 4;
        pushQuad(wallPos, wallIdx, prev.rf, pRW, cRW, cur.rf, wvi); wvi += 4;
        // ceiling only where BOTH ends are tunnel
        if (prev.tunnel && cur.tunnel) {
          pushQuad(roofPos, roofIdx, prev.lc, prev.rc, cur.rc, cur.lc, rvi); rvi += 4;
        }
      }
      prev = cur;
    }

    return {
      floor: { positions: new Float32Array(floorPos), indices: new Uint32Array(floorIdx) },
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
    const mesh = buildMesh(nodes);
    const collider = buildColliderBuffers(nodes);
    const start = nodes[0];
    const finish = nodes[nodes.length - 1];
    // the platform spans the leading isPlatform nodes
    const platformEnd = nodes.findIndex(n => !n.isPlatform);
    return { seed, nodes, mesh, collider, start, finish,
      platform: { startIdx: 0, endIdx: platformEnd < 0 ? 0 : platformEnd } };
  }

  return { generate, buildCenterline, buildMesh, buildColliderBuffers, mulberry32 };
})();

// Export for Node (server host) while staying a plain global in the browser.
if (typeof module !== 'undefined' && module.exports) module.exports = { ZTRACK };
