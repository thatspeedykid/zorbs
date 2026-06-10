// ZORBS Ball Skins — registry for default + future paid/sub DLC skins.
// A skin defines how a ball's material/ring/trail look. Add new skins here;
// gate them by `tier` ('free' | 'sub' | 'paid') and unlock via entitlements later.
const ZSKINS = (() => {
  // Each skin: factory that returns { material, ringMaterial, trailColor, emissivePulse? }
  // ctx = { THREE, color, isSub, BALL_R }
  const registry = {
    // ── DEFAULT (free) ──
    classic: {
      id:'classic', name:'Classic', tier:'free',
      build({THREE,color,isSub}){
        return {
          material:new THREE.MeshStandardMaterial({
            color, roughness:0.12, metalness:0.85,
            emissive:color, emissiveIntensity:isSub?0.45:0.22
          }),
          ringColor:color, trailColor:color
        };
      }
    },
    // ── CHROME (sub) — mirror-like metal ──
    chrome: {
      id:'chrome', name:'Chrome', tier:'sub',
      build({THREE,color}){
        return {
          material:new THREE.MeshStandardMaterial({
            color:0xffffff, roughness:0.02, metalness:1.0,
            emissive:color, emissiveIntensity:0.15
          }),
          ringColor:0xffffff, trailColor:color
        };
      }
    },
    // ── PLASMA (paid) — glowing energy core ──
    plasma: {
      id:'plasma', name:'Plasma', tier:'paid',
      build({THREE,color,isSub}){
        return {
          material:new THREE.MeshStandardMaterial({
            color, roughness:0.3, metalness:0.2,
            emissive:color, emissiveIntensity:1.4
          }),
          ringColor:color, trailColor:color, pulse:true
        };
      }
    },
    // ── VOID (paid) — matte black with neon rim ──
    void: {
      id:'void', name:'Void', tier:'paid',
      build({THREE,color}){
        return {
          material:new THREE.MeshStandardMaterial({
            color:0x050508, roughness:0.5, metalness:0.9,
            emissive:color, emissiveIntensity:0.6
          }),
          ringColor:color, trailColor:color
        };
      }
    },
    // ── GOLD (paid) — premium ──
    gold: {
      id:'gold', name:'Gold', tier:'paid',
      build({THREE}){
        return {
          material:new THREE.MeshStandardMaterial({
            color:0xffd700, roughness:0.08, metalness:1.0,
            emissive:0xffaa00, emissiveIntensity:0.4
          }),
          ringColor:0xffd700, trailColor:0xffd700
        };
      }
    },
  };

  // Resolve which skin a player gets. For now: stored choice in localStorage,
  // validated against their tier. Later: server entitlements per Kick/Twitch user.
  function entitlementFor(name, isSub){
    // FUTURE: look up purchases for `name`. For now subs unlock 'chrome'.
    if(isSub) return ['classic','chrome'];
    return ['classic'];
  }

  function resolve(name, isSub){
    const owned = entitlementFor(name, isSub);
    let chosen = 'classic';
    try {
      const pref = JSON.parse(localStorage.getItem('zorbs_skin')||'null');
      if(pref && owned.includes(pref)) chosen = pref;
    } catch(e){}
    return registry[chosen] || registry.classic;
  }

  function get(id){ return registry[id] || registry.classic; }
  function all(){ return Object.values(registry); }
  function setPreference(id){ localStorage.setItem('zorbs_skin', JSON.stringify(id)); }

  return { resolve, get, all, setPreference, registry };
})();
