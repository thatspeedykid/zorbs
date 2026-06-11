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
      }
      const halfW = WIDTH * widthFactor;

      nodes.push({ pos, dir: heading, right, up, halfW, bank, kind: moveKind, tunnel });
      segLeft--;
    }
    return nodes;
  }

  // POST-PASS: splice a drop-through drum into the finished (baseline) centerline. Done
  // AFTER generation so it does NOT perturb the proven procedural layout — we just lower
  // everything past the splice point and insert the chamber's centerline + descriptor.
  function spliceDrum(nodes, seed) {
    const DRUM_DEPTH = 30, DRUM_R = WIDTH * 2.4;
    // splice ~38% through, but not on a tunnel/funnel/spiral node (need a clean shelf)
    let s = Math.floor(nodes.length * 0.38);
    for (let g = 0; g < 60 && s < nodes.length-20; g++) {
      const k = nodes[s].kind;
      if ((k === 'straight' || k === 'turn') && !nodes[s].tunnel) break;
      s++;
    }
    const drng = mulberry32((seed ^ 0x6d2b79f5) >>> 0);   // separate stream: no layout shift
    const top = nodes[s];
    const cx = top.pos.x, cz = top.pos.z, topY = top.pos.y;
    const bottomY = topY - DRUM_DEPTH;

    // lower everything AFTER the splice by the drum depth (creates the vertical gap)
    for (let i = s + 1; i < nodes.length; i++) nodes[i].pos.y -= DRUM_DEPTH;

    // flatten + widen a short entry shelf leading into the drum centre
    const entryIdx = Math.max(1, s - 6);
    for (let i = entryIdx; i <= s; i++) {
      nodes[i].pos.y = topY; nodes[i].bank = 0;
      nodes[i].halfW = Math.max(nodes[i].halfW, WIDTH * 1.7);
      nodes[i].kind = 'drum_entry';
    }
    // the vertical DROP node (straight down the axis); mesh skips this degenerate quad
    const dir = top.dir, right = norm(cross(dir, v(0,1,0)));
    const dropNode = { pos:{x:cx,y:bottomY,z:cz}, dir, right, up:v(0,1,0),
      halfW: DRUM_R, bank:0, kind:'drum_drop', tunnel:false, meshSkip:true };
    nodes.splice(s + 1, 0, dropNode);
    const landingIdx = s + 2;   // first node after the inserted drop
    // flatten + widen the landing shelf so balls catch and the track continues
    for (let i = landingIdx; i < Math.min(nodes.length, landingIdx + 8); i++) {
      nodes[i].pos.y = bottomY; nodes[i].bank = 0;
      nodes[i].halfW = Math.max(nodes[i].halfW, WIDTH * 1.6);
      nodes[i].kind = 'drum_landing';
    }
    if (nodes[landingIdx]) nodes[landingIdx].meshSkip = true;   // skip the drop->landing bridge

    // 2–3 exit holes around the bottom (separate RNG so layout is untouched)
    const holeCount = 2 + Math.floor(drng() * 2);
    const holes = [];
    const a0 = drng() * Math.PI * 2;
    for (let h = 0; h < holeCount; h++) {
      const ang = a0 + h * (Math.PI*2/holeCount);
      holes.push({ x: cx + Math.cos(ang)*DRUM_R*0.45, z: cz + Math.sin(ang)*DRUM_R*0.45, r: DRUM_R*0.22, ang });
    }
    return { cx, cz, topY, bottomY, radius: DRUM_R, holes,
      entryIdx, dropIdx: s + 1, landingIdx };
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
      // meshSkip: the vertical drop into the drum and the bridge to the landing must NOT
      // be meshed (they'd be a degenerate vertical wall). The drum chamber covers them.
      if (prev && !nodes[i].meshSkip) {
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

    // DROP-THROUGH DRUM: splice it into the finished baseline centerline (post-pass, so
    // the proven procedural layout is untouched), then build the chamber collider
    // geometry: a containment WALL, a concave FLOOR with the 2–3 exit holes punched out,
    // and a solid catch PAD below. Spinning vanes are added in physics (kinematic).
    let drum = spliceDrum(nodes, seed);
    if (drum) {
      const SEG = 36, R = drum.radius, topY = drum.topY, botY = drum.bottomY;
      // ---- WALL: open cylinder trimesh ----
      const wp = [], wi = [];
      for (let i = 0; i < SEG; i++) {
        const a0 = (i/SEG)*Math.PI*2, a1 = ((i+1)/SEG)*Math.PI*2;
        const x0 = drum.cx+Math.cos(a0)*R, z0 = drum.cz+Math.sin(a0)*R;
        const x1 = drum.cx+Math.cos(a1)*R, z1 = drum.cz+Math.sin(a1)*R;
        const b = wp.length/3;
        wp.push(x0,topY,z0, x1,topY,z1, x1,botY,z1, x0,botY,z0);
        wi.push(b,b+1,b+2, b,b+2,b+3);
      }
      // ---- FLOOR: concave disc (edge higher → funnels inward) with holes punched out ----
      const fp = [], fi = [];
      const NR = 9, floorBase = botY + 4.0;
      const inHole = (x,z) => drum.holes.some(h => Math.hypot(x-h.x, z-h.z) < h.r);
      const fy = (r) => floorBase + (r/R)*(r/R)*3.0;     // gentle bowl, +3 at the rim
      for (let j = 0; j < NR; j++) {
        const r0 = (j/NR)*R, r1 = ((j+1)/NR)*R;
        for (let i = 0; i < SEG; i++) {
          const a0 = (i/SEG)*Math.PI*2, a1 = ((i+1)/SEG)*Math.PI*2;
          const cxm = drum.cx+Math.cos((a0+a1)/2)*((r0+r1)/2);
          const czm = drum.cz+Math.sin((a0+a1)/2)*((r0+r1)/2);
          if (inHole(cxm, czm)) continue;                // gap = exit hole
          const p = (rr,aa)=>[drum.cx+Math.cos(aa)*rr, fy(rr), drum.cz+Math.sin(aa)*rr];
          const A=p(r0,a0),B=p(r1,a0),C=p(r1,a1),D=p(r0,a1);
          const b = fp.length/3;
          fp.push(...A,...B,...C,...D);
          fi.push(b,b+1,b+2, b,b+2,b+3);
        }
      }
      // ---- PAD: a solid flat disc just below the holes. Catches balls dropping through
      // ANY hole (the holes ring the whole drum), so none can fall off and die. The track
      // continues forward from here. radius slightly over the drum so nothing slips past.
      const pp = [], pi = [], padR = R + 3, padY = botY;
      for (let i = 0; i < SEG; i++) {
        const a0 = (i/SEG)*Math.PI*2, a1 = ((i+1)/SEG)*Math.PI*2;
        const b = pp.length/3;
        pp.push(drum.cx, padY, drum.cz,
                drum.cx+Math.cos(a0)*padR, padY, drum.cz+Math.sin(a0)*padR,
                drum.cx+Math.cos(a1)*padR, padY, drum.cz+Math.sin(a1)*padR);
        pi.push(b, b+1, b+2);
      }
      drum.wall  = { positions:new Float32Array(wp), indices:new Uint32Array(wi) };
      drum.floor = { positions:new Float32Array(fp), indices:new Uint32Array(fi) };
      drum.pad   = { positions:new Float32Array(pp), indices:new Uint32Array(pi) };
      drum.floorBase = floorBase; drum.padY = padY;
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
    return { seed, nodes, mesh, collider, start, finish, drum,
      platform: { startIdx: 0, endIdx: platStart },
      forks, forkAtIdx, branchMeshes, branchColliders };
  }

  return { generate, buildCenterline, buildMesh, buildColliderBuffers, mulberry32 };
})();

// Export for Node (server host) while staying a plain global in the browser.
if (typeof module !== 'undefined' && module.exports) module.exports = { ZTRACK };
