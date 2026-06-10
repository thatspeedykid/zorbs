// ZORBS v2 — Cosmetics & DLC hooks (skins, ring styles, spawn animations)
// Built as a registry from day one so paid content drops in later with zero refactor.
// Today: just a free default for each category. The ARCHITECTURE is the deliverable.

const ZCOSMETICS = (() => {

  // ---- BALL SKINS ----
  // Each skin: how the ball mesh looks. resolve() returns material params.
  const ballSkins = {
    classic: { name: 'Classic', tier: 'free', color: null /* uses player color */, metalness: 0.3, roughness: 0.4, emissive: 0.0 },
    // future paid examples (defined but gated):
    chrome:  { name: 'Chrome',  tier: 'sub',  color: 0xddddff, metalness: 1.0, roughness: 0.05, emissive: 0.0 },
    plasma:  { name: 'Plasma',  tier: 'paid', color: 0xff3399, metalness: 0.2, roughness: 0.1, emissive: 0.6 },
    void:    { name: 'Void',    tier: 'paid', color: 0x110022, metalness: 0.8, roughness: 0.2, emissive: 0.2 },
  };

  // ---- RING STYLES (the Saturn ring around each ball) ----
  const ringStyles = {
    none:     { name: 'None',     tier: 'free', enabled: false },
    halo:     { name: 'Halo',     tier: 'free', enabled: true, color: null, spin: 2.0 },
    orbit:    { name: 'Orbit',    tier: 'sub',  enabled: true, color: 0x00e5ff, spin: 3.2 },
    gyro:     { name: 'Gyro',     tier: 'paid', enabled: true, color: 0xffcc00, spin: 4.5 },
  };

  // ---- SPAWN ANIMATIONS ----
  // A spawn anim is a function(t in 0..1) -> { scale, yOffset, opacity }.
  // Lets us sell flashy entrances later. Default = simple pop-in.
  const spawnAnims = {
    popIn: {
      name: 'Pop In', tier: 'free',
      fn: (t) => ({ scale: easeOutBack(t), yOffset: 0, opacity: Math.min(1, t * 2) }),
    },
    dropIn: {
      name: 'Drop In', tier: 'sub',
      fn: (t) => ({ scale: 1, yOffset: (1 - easeOutBounce(t)) * 8, opacity: 1 }),
    },
    warpIn: {
      name: 'Warp In', tier: 'paid',
      fn: (t) => ({ scale: 0.4 + 0.6 * t, yOffset: 0, opacity: t, spin: (1 - t) * 20 }),
    },
  };

  function easeOutBack(t) { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
  function easeOutBounce(t) {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  }

  // entitlement check: is this player allowed this cosmetic?
  // isSub = Kick subscriber; owned = array of purchased item ids (future backend).
  function entitled(item, isSub, owned) {
    if (!item) return false;
    if (item.tier === 'free') return true;
    if (item.tier === 'sub') return !!isSub;
    if (item.tier === 'paid') return Array.isArray(owned) && owned.includes(item.name);
    return false;
  }

  // resolve what a given player actually gets, falling back to free defaults if not entitled
  function resolveForPlayer(prefs, isSub, owned) {
    prefs = prefs || {};
    const skin = ballSkins[prefs.skin] && entitled(ballSkins[prefs.skin], isSub, owned) ? ballSkins[prefs.skin] : ballSkins.classic;
    const ring = ringStyles[prefs.ring] && entitled(ringStyles[prefs.ring], isSub, owned) ? ringStyles[prefs.ring] : ringStyles.halo;
    const spawn = spawnAnims[prefs.spawn] && entitled(spawnAnims[prefs.spawn], isSub, owned) ? spawnAnims[prefs.spawn] : spawnAnims.popIn;
    return { skin, ring, spawn };
  }

  return {
    ballSkins, ringStyles, spawnAnims,
    entitled, resolveForPlayer,
    // for a future shop UI:
    catalog: () => ({ ballSkins, ringStyles, spawnAnims }),
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { ZCOSMETICS };
