# ZORBS — Session Handoff (resume in a new chat)

This is a complete brain-dump of the ZORBS work so a fresh chat can continue with zero ramp-up.
Read top to bottom; the "Resume" section first, then the architecture.

---

## 0. HOW TO RESUME IN A NEW CHAT (do this first)

Paste this into the new chat:

> Continuing my ZORBS marble-race game. Clone is `github.com/thatspeedykid/zorbs`, I work in
> `public/beta/`. Read `ZORBS_HANDOFF.md` in the repo root for full context. Validate all track
> geometry in `node` before deploying (the sandbox can't run a browser/GPU). Push to `main` →
> Vercel auto-deploys to playzorbs.xyz/beta.

**Push access (GitHub PAT):** the repo pushes via a Personal Access Token embedded in the git
remote URL: `https://<YOUR_PAT>@github.com/thatspeedykid/zorbs.git`. I'm deliberately **not**
printing your token in this document — a token sitting in a shared/pasted doc is the #1 way they
leak (GitHub auto-revokes leaked PATs). To restore push in the new chat, paste your PAT directly
into that chat and have it run:
`git remote set-url origin https://<YOUR_PAT>@github.com/thatspeedykid/zorbs.git`
Your PAT is in your own setup / password manager from when we first wired this up.

**Other secrets (Kick / PartyKit / Vercel):** these are server-side env vars, NOT in the client
repo. None are needed for front-end track work — leave them alone.

---

## 1. WHAT ZORBS IS

A browser-based **marble-race streaming game** (like Marbles on Stream) for Kick. Marbles roll
**down a hill** (gravity-driven) through a procedurally generated track; viewers join from chat
and each gets a marble. Deterministic per seed (same seed = identical race) for fairness.

- **Stack:** Three.js r128 + Rapier3d-compat (physics), PartyKit (race rooms), Vercel (hosting),
  Kick (auth/chat).
- **Live beta:** https://playzorbs.xyz/beta
- **Repo:** https://github.com/thatspeedykid/zorbs  (branch `main`)
- **PartyKit host:** `zorbs.thatspeedykid.partykit.dev`
- **Owner:** Adrian — GitHub `thatspeedykid`, Kick `marsscumbags`, X `@MarsScumbags`.

---

## 2. REPO LAYOUT & DEPLOY

The **isolated beta build** lives in `public/beta/` and has its OWN copies of the libs (so the
live build is never touched):

| File | ~Size | Role |
|---|---|---|
| `public/beta/index.html` | 131 KB | The game: Three.js scene, camera, HUD, minimap, multiplayer, boot |
| `public/beta/track.js` | 29 KB | **Course director + centerline + mesh** (the procedural track) |
| `public/beta/forks.js` | 18 KB | **The split/fan generator** (the branching) |
| `public/beta/physics.js` | 23 KB | Rapier sim, floor support, fork lane-selection, bumpers |
| `public/beta/cosmetics.js` | 4 KB | Cosmetic hooks (deferred — do last) |

Live (untouched): `public/index.html`, `public/v2/*`, `public/play/*`. Dashboard: `public/dashboard.html`.
PartyKit server: `party/zorbs.js`.

**Deploy:** `git add … && git commit && git push origin main` → Vercel auto-deploys. Beta has
`no-store` headers (Vercel.json) so edits show on refresh instantly.

**VALIDATE BEFORE EVERY DEPLOY (critical — sandbox has no browser/GPU):**
```bash
cd public/beta
node --check forks.js && node --check track.js && node --check physics.js
# validate index inline JS:
awk '/^<script>$/{f=1;next} /^<\/script>/{f=0} f' index.html > /tmp/b.js && node --check /tmp/b.js
# run the generator headless to inspect geometry:
node -e 'const F=require("./forks.js").ZFORK; F.setDivergent(true); const {ZTRACK}=require("./track.js"); const t=ZTRACK.generate(SEED,800,20); /* inspect t.nodes, t.forks */'
```
Adrian can't see the result until it's live, and has low patience for blind iteration — so every
geometric change must be proven in `node` first (separation, no fall-through, monotonic descent,
no folds).

---

## 3. HOW THE TRACK IS BUILT (current architecture)

A level = a **section-rhythm course** that descends the whole way (gravity), with **one split**
that fans into multiple lanes.

### 3a. Course director — `track.js buildPlan(rng, total)`
Produces a SEQUENCE of sections with pacing (no two heavy pieces back-to-back):
`intro straight → [body: sweep / funnel / narrower / drop / spiral / tunnel, paced] → funnel
bottleneck → SPLIT-ZONE (the fan) → … → finish funnel (throat = finish line) → short outro`.
- All section kinds **descend** (gravity). `drop` = a *steeper* descent, NOT a valley.
- The split-zone is one `{kind:'straight', len 220-400, split:true}` section placed early-middle
  (`splitAt = body*0.28-0.40`) and **capped to the room left** so it never truncates.
- `isFinish:true` funnel → its throat node is tagged `finishLine` (see 3d).

### 3b. Centerline — `track.js buildCenterline()`
Lays nodes from the plan. Each node: `{pos, dir, right, up, halfW, bank, kind, forkZone, …}`.
- Strictly **monotonic descent** (heading.y stays negative; turns rotate around world-up so they
  never tip uphill). VERIFIED: zero uphill nodes.
- Section kinds handled: straight, sweep (turn), drop (steeper descent), funnel (V width pinch),
  narrower (held pinch), spiral (banked descending curl), tunnel.
- **Loop stops when the plan is exhausted** (`if (!sec) break;`) — no filler straights after the
  finish, so the post-finish rollout is short.
- `moguls` kind exists but is **removed from the rotation** (washboard created uphills — a marble
  can't climb. Do NOT re-add without making bumps gentler than the descent rate.)

### 3c. The FAN (the split) — `forks.js makeDivergentFork(mainNodes, splitIdx, rng, forkId, targetSteps)`
This is the centerpiece. The trunk opens into **N lanes** that spread WIDE, each winds its own
way, then they funnel back to the shared finish.
- **Lane count N: seeded random, weighted** ~10% single (returns null = no split, single descent),
  ~30/32/28% for 2/3/4 lanes. Capped to what fits without colliding (`roomMax`).
- **Wide spread:** outer lanes reach `maxOuter = SLOPE(0.62) * fanLenH`, set off the fan-out length
  so the fan-out splay is a fixed ~32° regardless of track length (no fold). Outer-to-outer spread
  ~120-190 units. Fewer lanes = wider apart (each reaches `maxOuter`).
- **Plateau shape:** fan OUT over first `RAMP(0.30)`, HOLD spread across the middle, funnel IN over
  the last RAMP. Smoothstep ends (no kink).
- **Per-lane wander:** each lane S-curves in its own area, but ONLY during the flat hold (where the
  spread adds no lateral slope), so wander can't stack on the fan-out and fold. ~200° cumulative
  turn per lane. Amplitude bounded so neighbours never touch.
- **Per-lane funnels:** each lane gets 0-2 width pinches (`R.wid[]`). Pinch only NARROWS (min ~44%),
  which only GROWS the gap to neighbours — can't cause overlap/fall-through. Full width at merges.
- **Every lane descends monotonically** (Y = spine Y + tiny tapered `slopeWave`, no valleys).
- **Walls / no fall-through:** each lane is walled on both sides; the wall between two lanes drops
  ONLY where they coincide (`gap < SAFEGAP=0.8`, i.e. they're within ~1.6 ball-diameters and the
  floors already overlap). A wall stops the ball regardless of how wide the void beyond it is, so
  balls can NEVER fall into the leaf interior. Fan OUTER edges always walled.
- **Spine through the fork:** `meshSkip` interior (lanes carry the floor), `noWalls` floor-bridges
  at the two ends.
- **Returns:** `{ id, splitIdx, branches{bid:nodes[]}, branchOrder[], laneCount, rejoinIdx{bid:end},
  ends[], end, flavor:'divergent' }`. (branchOrder is left→right, used by physics to bin lanes.)
- `buildForks` (forks.js) finds the marked `forkZone` span and calls this; if it returns null
  (single-lane), it SKIPS the fork (no legacy fallback) → that section stays a single descent.

### 3d. Finish — `track.js generate()`
`finish = nodes.find(n => n.finishLine) || last`. The finish line sits at the **funnel throat**
(field most bunched = photo finishes), with a short rollout after. Pinch kept gentle (min ~0.44)
so a full field never jams into a dead stop.

### 3e. Mesh / colliders / decorations / physics — generic over N lanes
- `track.js buildMesh(branch)` reads per-node `halfW` + per-side `noWallL/noWallR`. branchMeshes /
  branchColliders / obstacles / boosts all loop `for (const bid in f.branches)` — N-lane safe.
- `physics.js` FORK COMMIT (~line 273): a marble picks its lane by binning its lateral position at
  the split across `f.branchOrder` (was hardcoded 2-way A/B). Lane-follow + merge use rejoinIdx.
- `index.html` minimap (`computeMiniBounds` / `drawMinimap`) now includes + draws every branch.
- `index.html` decorations (`_decoPaths`, `_branchNodesById`) build rails/halos per branch.

---

## 4. EVERYTHING BUILT THIS SESSION (newest first)

1. **`?fresh=1` mode** — brand-new RANDOM track every race, auto-loops (boots a solo loop, new
   `Math.random` seed each race, restarts ~5s after each finish). The default `/beta` locks the
   seed to a 95s race slot (multiplayer fairness — all viewers running the sim see the same race),
   which is why refreshing showed the same seed. `?fresh=1` is the solo-streamer/testing path.
2. **On-screen seed + lane-count readout** (top-right, diagnostic) — confirms each race is a new
   track. *Can be removed when no longer needed.*
3. **Minimap shows the fan branches** — was only drawing the spine (meshSkip through the fork =
   broken line with a gap). Now measures + draws every lane.
4. **Lane count weighted toward fans** — uniform 1-4 made ~26% of real seeds single-track; now ~10%.
5. **Finish line at the funnel throat** — photo finishes; short rollout (was 70-90 nodes of coast).
6. **Funnels ON the lanes** — per-lane width bottlenecks (only narrow → safe).
7. **Random 1-4 lanes** — 1 = no split (single descent).
8. **Fan branches WIDE + per-lane wander** — outer lanes peel hard left/right and wind their own
   way (was parallel `| | | |`). Track lengthened to 760-959 nodes.
9. **Split is a WIDE FAN (3-4 lanes)** — replaced the 2-lane bow-and-rejoin "lens".
10. **Gravity-correct (monotonic descent)** — removed moguls (washboard uphills) and the split's
    Y valleys (down-then-climb-out traps marbles). Everything descends now.
11. **Section-rhythm director** — levels are a varied sequence of set-pieces, split demoted to one
    section (was: the whole level was one giant split).
12. (Earlier in session) split separation / fall-through / vertical-stacking fixes, per-route
    content, camera-follows-ball, decorations-follow-routes.

---

## 5. KEY INVARIANTS (don't break these)

- **Everything descends.** A marble can't roll uphill. Verify zero uphill nodes on the spine AND
  every lane before deploying. No valleys, no washboard that out-paces the descent.
- **No fall-through.** Wherever two lanes have a real gap, the wall between them is UP. Walls drop
  only where lanes coincide (gap < SAFEGAP). Verify: no node has `gap > ball-diameter` with the
  facing wall down.
- **No folds.** Forward progress (STEP) must dominate lateral motion. Verify min segment length
  between consecutive nodes stays well above 0.
- **Lanes merge at the same finish** (offset 0 at mouth and rejoin, full width at merges).
- **Deterministic per seed.** Never use `Math.random` in generation (only in `?fresh=1`'s seed
  pick). Same seed must always rebuild the identical track.
- **Verify in `node` before every deploy.** Adrian can't see results until live and is out of
  patience for blind iteration.

---

## 6. CURRENT STATE — what works

Track is a gravity-correct, fully-random-per-seed course: varied section sequence → a fan that's a
single descent ~10% of the time and a wide 2-4 lane spread ~90% of the time, each lane winding its
own path with its own funnels, all converging to a bunched photo-finish. Verified across 20-60
seeds each change: right lane counts, wide spread, no fall-through, no uphill, no folds, meshes +
physics + obstacles + minimap all N-lane aware. `?fresh=1` gives a new track every race.

The thing only Adrian can verify (no physics engine in the sandbox): that marbles actually flow
down the lanes and distribute across them. Geometry + data wiring are proven; the *feel* needs eyes
on real races.

---

## 7. WHAT'S NEXT (roadmap)

**Immediate / in-flight:** confirm `?fresh=1` gives fresh tracks every race (seed readout changes).

**Next feature — dynamic MoS obstacles** (the per-lane funnels are done; these are the rest):
- **Spinners** (rotating arms that knock marbles), **launch-pins** (pop-up that flings), **boost
  ramps** (angled boost pads that launch). These are **force/physics-based** — I can build their
  placement + shape and verify *that* in node, but the FEEL (fling strength, timing, jam vs launch)
  can't be simulated headlessly. **Build the structure, then tune live with Adrian watching.**
- Existing bumper system (`obstacles[]` + `getBumpers/processBumpers`, electric shock) is the hook
  to extend; per-lane bumpers already distribute 5-9 per lane.

**Later / polish:** light-up floor (bongo-pad effect) on drops; per-section materials so set-pieces
read distinct; true vertical loops/barrel rolls (BIG separate build — floor math assumes up≈world-up,
needs an orientation-aware physics path).

**Reference doc:** `ZORBS_MAP_PLAN.md` in the repo root (the Marbles-on-Stream design research).

---

## 8. DEV GOTCHAS / RULES

- Upload/read the current file before editing; verify syntax (`node --check`) before output.
- Never destructive git. Standard push: `git add → commit → push origin main`.
- Don't touch working sections when fixing a specific bug.
- `BALL_R = 0.5` (diameter 1.0) — sizing for gaps/walls.
- The legacy `makeFork` (lanes-only) path in forks.js is vestigial — divergent mode uses
  `makeDivergentFork` only; null = no fork (single lane).
- The small-Y non-loop fork mode was removed; all splits are wide fans now.
- Adrian is non-technical, action-oriented, communicates via screenshots, low tolerance for blind
  iterative failure. Prefer one focused decision question before a major architectural change;
  verify geometry in node; deliver one clean thing at a time.

---

*Generated end of session. The handoff + map-plan docs live in the repo root so any new chat can
read them directly.*
