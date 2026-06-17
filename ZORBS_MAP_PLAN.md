# ZORBS → Marbles-on-Stream-style maps — research + plan

Researched from the Marbles on Stream (MoS) track-builder guide by Hidri (Steam) and the
official piece/obstacle list. This is the plan to get ZORBS from "two lanes with bumps" to
real MoS-style courses.

---

## 1. The one big idea

A MoS map is a **chain of distinct set-pieces**, each one a recognizable "thing" the marbles
go through: a funnel, a narrower, a jump, a mogul field, a spinner gauntlet, a split, a loop,
a finish. The fun comes from the **rhythm** of those pieces and the **shuffle** they cause in
the pack — not from a single continuous slide.

ZORBS today = one continuous ribbon (a whole-level loop) with weave + drops + bumpers sprinkled
on. That reads as "lanes with bumps" because there are no distinct set-pieces and no rhythm.

**Fix = a course director that strings together named SECTIONS, where the loop/split is just
ONE section type, not the whole level.**

Example target layout for a single level:
`start → funnel (gather) → mogul straight → SPLIT/loop → narrower (bottleneck) → jump (gap+landing)
→ spinner gauntlet → boost ramp → finish (with last-second switch)`

---

## 2. The MoS piece palette (what maps are built from)

**Structural**
- Start pad, Finish pad
- Straights, Turns (45° / 90°)
- Downhills (varying steepness)
- Transitions (smooth piece between two different pieces — stops marbles getting stuck)
- Stairs (with rounded transition pieces at each end)

**Flow-shapers** (these reshuffle the pack — the heart of a good race)
- **Funnels** — wide → narrow, gather marbles together
- **Narrowers** — pinch to single-file; act as a bottleneck, slowly meter marbles through
- **Splits** — two+ paths that rejoin (what we already have)

**Vertical / air**
- **Jumps + landings** — a gap with a ramp up and a landing pad
- **Ramps / Cannons** — angled launchers, adjustable angle + strength
- **Elevators** — lift marbles up
- **Loops** — vertical loop-de-loop (needs boosts to clear)
- Spirals / helix descents

**Terrain**
- **Moguls** — washboard bumps that jostle and separate marbles

## 3. The MoS obstacle palette

- **Pins** — bob up/down. Can BLOCK (if up when a marble arrives) or LAUNCH (set move-up time
  near 0 → flings marbles). Can be made stationary. The single most versatile obstacle.
- **Speed boosts** — pads. Can be ROTATED to launch marbles into the air, and can be HIDDEN
  (lift slightly off the floor → arrows invisible, effect remains → surprise launches).
- **Spinners / rotating posts ("dojos")** — spinning arms that knock marbles around.
- **Hammers** — rotating; only the head collides.
- **Wiggly / bamboo sticks** — flexible obstacles marbles push through.
- **Destructible cubes** — explode on impact; stack them for a big explosion / jumpscare.
- **Bongo pads** — bounce marbles + light up + play a note. Placed UNDER a glass floor they
  light up as marbles roll over (great on dark backgrounds).

## 4. Design rules that make MoS races good (the important part)

1. **Rhythm, not constant noise.** Alternate calm stretches (straights, gentle downhills) with
   event pieces (funnel, jump, gauntlet). Constant chaos is as boring as constant nothing.
2. **Bottlenecks = drama.** Funnels and narrowers bunch the pack and cause overtakes. Put one
   before a split or a jump so the entry is interesting.
3. **Launchers for air + chaos.** Fast-up pins and rotated/hidden boost pads make marbles fly.
   Use a narrower right before a jump so they launch straight, not sideways.
4. **Loops/hills need MULTIPLE spaced, lower-power boosts** — one maxed boost glitches the
   physics and marbles clip through. Space them so a marble always reaches the next one.
5. **No dead stops.** Never make the pack sit and wait (e.g. blocked behind debris). Feels bad.
6. **No open edges.** Gaps between pieces trap marbles — keep surfaces continuous.
7. **Finish with switch potential.** A funnel/scramble right at the line so the last second can
   change the winner. This is what makes clips.
8. **Keep it followable.** Too many overlapping paths is hard for a chase cam — one clear
   through-line with set-pieces beats spaghetti.

---

## 5. Gap analysis — ZORBS today vs MoS

| MoS has | ZORBS has | Status |
|---|---|---|
| Section rhythm (chain of set-pieces) | one whole-level loop | **missing — biggest gap** |
| Funnels | `funnel` kind exists in old director, unused in loop | bring back |
| Narrowers (bottleneck) | width pinch possible | easy to add |
| Moguls (washboard) | nothing | easy to add |
| Jumps + landings (gaps) | nothing | medium |
| Spinners / dojos | nothing | add as obstacle |
| Launch pins | bumpers (shock only) | add launch mode |
| Boost ramps | flat boost pads only | add angle |
| Loops (vertical) | nothing (floor assumes up=up) | hard |
| Splits | yes (the loop) | keep, demote to one section |
| Last-second finish scramble | plain finish | add |

When I switched ZORBS to the whole-level loop, the old course director (which DID have funnels,
sweeps, drops, spirals, tunnels) got replaced by `[stem, split-zone, outro]`. So the loop levels
actually *lost* the variety the engine already supported. Step 1 is mostly restoring + extending
that director with the loop as one option.

---

## 6. The plan (prioritized)

### Phase 1 — Section rhythm (biggest impact, do first)
Rebuild the course director so a level is a **sequence of SECTIONS** drawn from a palette, with
sane pacing rules (calm → event → calm). The split/loop becomes one section type that can appear
0–1 times, not the entire level. Each section is a self-contained, recognizable set-piece.
- Sections: `straight`, `downhill`, `turn`, `funnel`, `narrower`, `moguls`, `jump`, `split/loop`,
  `spinner_gauntlet`, `boost_ramp`, `finish_scramble`.
- Pacing: never two heavy sections back-to-back; bottleneck before split/jump; scramble at the end.

### Phase 2 — New terrain pieces (node-verifiable, low risk)
- **Moguls** — sinusoidal bumps across a straight; jostle + separate the pack.
- **Funnel** — restore: wide entry tapering to a narrow exit.
- **Narrower** — hard pinch to ~1–2 marble widths, then re-widen (the bottleneck).
- **Jump** — a gap: ramp up, NO floor for N nodes, landing pad. Needs air-time tuning.

### Phase 3 — New dynamic obstacles (additive, low risk)
- **Spinner** — rotating arm collider at a node (like the bumper system but rotating + always-on).
- **Launch pin** — timed pop-up cylinder that flings marbles up (extend the bumper system).
- **Boost ramp** — boost pad on an up-angled piece = a jump launcher.
- **Hammer** — swinging arm (head-only collision).

### Phase 4 — Polish / feel
- **Finish scramble** — a funnel or mogul patch right at the line for last-second switches.
- **Light-up floor** — floor panels glow as marbles pass (bongo-pad effect) for the stream look.
- Per-section materials/colors so each set-piece reads as distinct.

---

## 7. Difficulty / risk notes

- **Quick + safe (verify geometry in node, no physics risk):** moguls, funnels, narrowers,
  spinners, boost ramps, finish scramble, light-up floor.
- **Medium:** jumps (gaps need landing alignment + air-time tuning so marbles clear and land),
  launch pins (timing/force tuning so it's fun not random-feeling).
- **Hard / separate project:** true vertical **loops** and barrel rolls. The current floor support
  is analytic and assumes "up ≈ world up," so a marble can't run on the inside of an upside-down
  surface without a different (tube/orientation-aware) floor + physics path. Doable, but it's its
  own build — not a quick add.

---

## 8. Suggested first move when you wake up

Pick the starting point:
- **A) Section rhythm first** (restructure the director) — the change that most makes it "feel
  like MoS." Everything else slots into it.
- **B) Terrain pieces first** (moguls + funnel + narrower) — fast visible wins on the current
  layout, then wire them into the rhythm after.
- **C) Obstacles first** (spinners + launch pins + boost ramps) — most immediate "stuff happening."

My recommendation: **A then B then C.** The section system is the backbone — once it exists,
moguls/funnels/spinners just become section/obstacle types that drop in, and every level
automatically gets MoS-style pacing instead of one long slide.
