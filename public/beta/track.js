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
    const plan = [];
    let used = 0, lastDir = rng() < 0.5 ? 1 : -1, sinceIntense = 9, sinceSplit = 0;
    const intro = 20 + Math.floor(rng() * 12);
    plan.push({ kind: 'straight', len: intro }); used += intro;
    const outro = 40 + Math.floor(rng() * 28);          // long final tail
    const body = total - outro;
    while (used < body - 18) {
      sinceIntense++; sinceSplit++;
      const remaining = body - used;
      // SPLIT ZONE: a long straight run, marked so the fork-placer can split the track into two
      // separate diverging ribbons here (divergent forks need a near-straight section). Regular
      // cadence so every course actually branches.
      if (sinceSplit >= 3 && remaining > 140) {
        const len = 94 + Math.floor(rng() * 20);
        plan.push({ kind: 'straight', len, split: true }); used += len;
        sinceSplit = 0; continue;
      }
      const roll = rng();
      let sec;
      if (roll < 0.60) {
        // BIG sweeping arc — always flip direction (clean S-curves) and CAP the total arc so a
        // sweep never curls past ~95° onto its own path (that self-overlap was the tangled knot).
        lastDir = -lastDir;
        const sharp = 0.022 + rng() * 0.022;                  // 0.022–0.044
        let len = 34 + Math.floor(rng() * 22);                // 34–56
        len = Math.min(len, Math.floor(1.65 / sharp));        // arc ≤ ~95° → no loop-back
        sec = { kind: 'sweep', dir: lastDir, sharp, len };
      } else if (roll < 0.70) {                          // short straight breather
        sec = { kind: 'straight', len: 10 + Math.floor(rng() * 12) };
      } else if (roll < 0.82 && sinceIntense > 2) {      // funnel
        sec = { kind: 'funnel', len: 16 + Math.floor(rng() * 14), min: 0.4 + rng() * 0.15 };
      } else if (roll < 0.91 && sinceIntense > 3) {      // drop
        sec = { kind: 'drop', len: 8 + Math.floor(rng() * 9), drop: 1.1 + rng() * 1.4 }; sinceIntense = 0;
      } else if (roll < 0.96 && sinceIntense > 4) {      // spiral (rare, spaced)
        if (rng() > 0.30) lastDir = -lastDir;
        sec = { kind: 'spiral', dir: lastDir, len: 28 + Math.floor(rng() * 12) }; sinceIntense = 0;
      } else {                                           // tunnel
        sec = { kind: 'tunnel', dir: rng() < 0.5 ? 1 : -1, len: 16 + Math.floor(rng() * 14) };
      }
      if (sec.len > remaining) sec.len = Math.max(8, remaining);
      plan.push(sec); used += sec.len;
    }
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
    let curForkZone = false;   // true while laying a marked split-zone (for divergent forks)


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
        const sec = plan[planIdx++] || { kind: 'straight', len: 20 };
        moveKind = 'straight'; extraDrop = 0; funnelMin = 0; tunnel = false;
        curForkZone = (sec.kind === 'straight' && sec.split === true);
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
        } else {
          // straight — split-zones are forced DEAD straight so divergent forks don't fan/twist
          targetTurn = sec.split ? 0 : (rng() - 0.5) * 0.012;
          targetBank = 0;
          segLeft = sec.len;
        }
      }

      // hold the spiral's strong turn for its whole duration (don't ease it away)
      if (moveKind === 'spiral') targetTurn = spiralTurn;
      if (spiralCooldown > 0) spiralCooldown--;

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
      // inside a split-zone, kill any leftover turn/bank from the prior sweep FAST so the section
      // is truly straight by the time the divergent fork splits it (no fan/twist).
      if (curForkZone) { turn *= 0.74; bank *= 0.5; }

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
      }
      const halfW = WIDTH * widthFactor;

      nodes.push({ pos, dir: heading, right, up, halfW, bank, kind: moveKind, tunnel, forkZone: curForkZone });
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
      if (nodes[i].meshSkip) { prev = null; continue; }   // gap — no floor/walls here
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
              nd.tunnel || /drum/.test(nd.kind || '')) { ok = false; break; }
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
    return { seed, nodes, mesh, collider, start, finish, boosts, obstacles,
      platform: { startIdx: 0, endIdx: platStart },
      forks, forkAtIdx, branchMeshes, branchColliders };
  }

  return { generate, buildCenterline, buildMesh, buildColliderBuffers, mulberry32 };
})();

// Export for Node (server host) while staying a plain global in the browser.
if (typeof module !== 'undefined' && module.exports) module.exports = { ZTRACK };
