// ZORBS v2 — Cosmetics & DLC hooks (skins, ring styles, spawn animations)
// Built as a registry from day one so paid content drops in later with zero refactor.
// Today: just a free default for each category. The ARCHITECTURE is the deliverable.

const ZCOSMETICS = (() => {

  // ---- BALL SKINS ----
  // Each skin: how the ball mesh looks. resolve() returns material params.
  const ballSkins = {
    classic: { name: 'Classic', tier: 'free', style: 'metal',  color: null /* player color */, metalness: 0.55, roughness: 0.3,  emissive: 0.25 },
    // premium skins — gated, render via their `style` in index.html:
    chrome:  { name: 'Chrome',  tier: 'sub',  style: 'metal',  color: 0xeef2ff, metalness: 1.0, roughness: 0.05, emissive: 0.0 },
    galaxy:  { name: 'Galaxy',  tier: 'paid', style: 'galaxy', color: 0x2a1b4a, metalness: 0.3, roughness: 0.4, emissive: 0.5 },
    lava:    { name: 'Lava',    tier: 'paid', style: 'lava',   color: 0x401005, metalness: 0.2, roughness: 0.6, emissive: 0.9 },
    glass:   { name: 'Glass',   tier: 'sub',  style: 'glass',  color: 0xbfe9ff, metalness: 0.0, roughness: 0.05, emissive: 0.05 },
    marble:  { name: 'Marble',  tier: 'free', style: 'marble', color: 0xf5f0e8, metalness: 0.0, roughness: 0.55, emissive: 0.0 },
    crystal: { name: 'Crystal', tier: 'sub',  style: 'crystal',color: 0x88ffee, metalness: 0.1, roughness: 0.02, emissive: 0.3 },
    phantom: { name: 'Phantom', tier: 'sub',  style: 'phantom',color: 0x8844cc, metalness: 0.3, roughness: 0.2,  emissive: 0.6 },
    rainbow: { name: 'Rainbow', tier: 'paid', style: 'rainbow',color: null,     metalness: 0.2, roughness: 0.15, emissive: 0.7 },
    solar:   { name: 'Solar',   tier: 'paid', style: 'solar',  color: 0xffcc00, metalness: 0.4, roughness: 0.3,  emissive: 1.0 },
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
