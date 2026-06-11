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
    let funnelLen = 1, funnelPos = 0, spiralTurn = 0, spiralLen = 1, spiralCooldown = 0;
    // MIXER: one guaranteed spinning bowl-drum, forced in at ~38% through the course.
    // It's a wide multi-loop funnel (reuses the proven spiral physics) that balls churn
    // around and drain out the center of — gravity funnels everything down, so it can't
    // trap. A spinning cage is rendered around it for the bingo-mixer look.
    const mixerAt = Math.floor(targetNodes * 0.38);
    let mixerDone = false;

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
        // FORCED MIXER: once we pass the trigger point, the next new move is the mixer.
        if (!mixerDone && i >= mixerAt) {
          moveKind = 'mixer'; extraDrop = 0.32; funnelMin = 0; tunnel = false;
          const dir = rng() < 0.5 ? 1 : -1;
          spiralTurn = dir * 0.13;        // tight coil = many loops
          targetTurn = spiralTurn;
          targetBank = dir * 0.45;
          segLeft = 132;                  // ~2.5 full loops
          spiralLen = segLeft;
          mixerDone = true;
        } else {
        const r = rng();
        moveKind = 'straight'; extraDrop = 0; funnelMin = 0; tunnel = false;
        // MORE RANDOM: wider value ranges + an added SPIRAL move. Probabilities retuned
        // so no single feel dominates and every course plays differently.
        if (r < 0.24) {
          // straight-ish run (length varies a lot now)
          targetTurn = (rng() - 0.5) * 0.012;
          targetBank = 0;
          segLeft = 10 + Math.floor(rng() * 26);
        } else if (r < 0.52) {
          // sweeping turn (banked) — sharper range for more drama
          const dir = rng() < 0.5 ? 1 : -1;
          const sharp = 0.015 + rng() * 0.055;
          targetTurn = dir * sharp;
          targetBank = dir * Math.min(0.55, sharp * 9);
          segLeft = 14 + Math.floor(rng() * 28);
        } else if (r < 0.66) {
          // DROP: steep plunge
          moveKind = 'drop';
          targetTurn = (rng() - 0.5) * 0.02;
          targetBank = 0;
          extraDrop = 1.2 + rng() * 1.6;
          segLeft = 7 + Math.floor(rng() * 10);
        } else if (r < 0.78) {
          // FUNNEL: squeeze to a throat then reopen
          moveKind = 'funnel';
          targetTurn = (rng() - 0.5) * 0.012;
          targetBank = 0;
          funnelMin = 0.38 + rng() * 0.16;
          segLeft = 16 + Math.floor(rng() * 14);
          funnelLen = segLeft;
        } else if (r < 0.80 && spiralCooldown <= 0) {
          // SPIRAL DROP-FUNNEL — now RARE (cooldown prevents clustering) and gentler so
          // it doesn't create a catch-lip. The bump at spiral start/end was a hard step
          // in width (x1.6 applied instantly) and bank; both are eased now (see below).
          moveKind = 'spiral';
          const dir = rng() < 0.5 ? 1 : -1;
          spiralTurn = dir * (0.09 + rng() * 0.025);
          targetTurn = spiralTurn;
          targetBank = dir * 0.4;                       // gentler (was 0.6) — less catch
          extraDrop = 0.45 + rng() * 0.25;
          segLeft = 40 + Math.floor(rng() * 22);
          spiralLen = segLeft;
          spiralCooldown = 220;                         // no another spiral for ~220 nodes
        } else if (r < 0.86) {
          // TUNNEL: enclosed run with a ceiling (capped so it doesn't dominate)
          moveKind = 'tunnel';
          const dir = rng() < 0.5 ? 1 : -1;
          targetTurn = dir * (rng() * 0.025);
          targetBank = 0;
          tunnel = true;
          segLeft = 16 + Math.floor(rng() * 16);
        } else {
          // leftover (incl. spiral slot when on cooldown) -> a sweeping banked turn,
          // keeping courses varied instead of defaulting to more tunnels.
          const dir = rng() < 0.5 ? 1 : -1;
          const sharp = 0.02 + rng() * 0.05;
          targetTurn = dir * sharp;
          targetBank = dir * Math.min(0.55, sharp * 9);
          segLeft = 14 + Math.floor(rng() * 24);
        }
        }
      }

      // hold the spiral/mixer's strong turn for its whole duration (don't ease it away)
      if (moveKind === 'spiral' || moveKind === 'mixer') targetTurn = spiralTurn;
      if (spiralCooldown > 0) spiralCooldown--;

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
      } else if (moveKind === 'spiral') {
        // EASE the bowl width in over the first 25% and out over the last 25% so there
        // is no hard step (the 'bump' you saw). smoothstep on both ends.
        const sp = 1 - (segLeft / spiralLen);            // 0..1 through the spiral
        const ramp = Math.min(1, sp/0.25, (1-sp)/0.25);  // 0 at ends, 1 in the middle
        const e = Math.max(0, ramp); const es = e*e*(3-2*e);
        widthFactor *= 1 + 0.45 * es;                    // up to +45% in the middle only
      } else if (moveKind === 'mixer') {
        // MIXER BOWL: much wider than a spiral (the drum interior), eased in/out.
        const sp = 1 - (segLeft / spiralLen);
        const ramp = Math.min(1, sp/0.2, (1-sp)/0.2);
        const e = Math.max(0, ramp); const es = e*e*(3-2*e);
        widthFactor *= 1 + 1.3 * es;                     // up to +130% = big bowl
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
    let vDist = 0;             // cumulative distance along track for the V coordinate
    for (let i = 0; i < nodes.length; i++) {
      const cur = ring(nodes[i]);
      if (prev) {
        const vPrev = vDist;
        vDist += 0.35;          // grid cell pitch along the track
        const vCur = vDist;
        pushQuad(floorPos, floorIdx, prev.lf, prev.rf, cur.rf, cur.lf, vi); vi += 4;
        // UVs matching the quad's vertex order (prev.lf, prev.rf, cur.rf, cur.lf):
        floorUV.push(0, vPrev,  1, vPrev,  1, vCur,  0, vCur);
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

    // MIXER DESCRIPTOR: find the mixer nodes and compute the bowl center / radius / top
    // & bottom Y so the renderer can place a spinning cage around it. The spiral coils
    // around a center point; we approximate it as the midpoint of the node bounding box.
    let mixer = null;
    const mIdx = [];
    for (let i = 0; i < nodes.length; i++) if (nodes[i].kind === 'mixer') mIdx.push(i);
    if (mIdx.length > 4) {
      // CENTROID (not bbox midpoint): a spiral coils around a center point; the average
      // of the node XZ positions lands on that center, so the cage wraps the bowl.
      let sx=0, sz=0, minY=1e9, maxY=-1e9;
      for (const i of mIdx) { const p = nodes[i].pos; sx+=p.x; sz+=p.z;
        minY=Math.min(minY,p.y); maxY=Math.max(maxY,p.y); }
      const cx = sx/mIdx.length, cz = sz/mIdx.length;
      // radius = mean distance from centroid to the coil nodes (+ track width)
      let rsum=0; for (const i of mIdx){ const p=nodes[i].pos; rsum += Math.hypot(p.x-cx, p.z-cz); }
      const radius = rsum/mIdx.length + WIDTH;
      mixer = { cx, cz, yTop: maxY, yBottom: minY, radius,
        startIdx: mIdx[0], endIdx: mIdx[mIdx.length-1] };
    }

    // FORKS: build split routes as a post-pass (deterministic via the same seed stream)
    let forks = [], forkAtIdx = new Map();
    if (_ZFORK) {
      const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
      const built = _ZFORK.buildForks(nodes, platStart, rng);
      forks = built.forks; forkAtIdx = built.forkAtIdx;
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

    const start = nodes[0];
    const finish = nodes[nodes.length - 1];
    return { seed, nodes, mesh, collider, start, finish, mixer,
      platform: { startIdx: 0, endIdx: platStart },
      forks, forkAtIdx, branchMeshes, branchColliders };
  }

  return { generate, buildCenterline, buildMesh, buildColliderBuffers, mulberry32 };
})();

// Export for Node (server host) while staying a plain global in the browser.
if (typeof module !== 'undefined' && module.exports) module.exports = { ZTRACK };
