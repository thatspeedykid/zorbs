// ZORBS Audio Engine - procedural synthwave music + SFX via Web Audio API.
// No files: everything synthesized. Autoplay-safe (arms on first user gesture).
const ZAUDIO = (() => {
  let ctx = null, master = null, musicGain = null, sfxGain = null;
  let musicOn = true, sfxOn = true, started = false;
  let loopTimer = null, step = 0;

  function init() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();   master.gain.value = 0.6;  master.connect(ctx.destination);
    musicGain = ctx.createGain(); musicGain.gain.value = 0.32; musicGain.connect(master);
    sfxGain = ctx.createGain();   sfxGain.gain.value = 0.32; sfxGain.connect(master);
  }

  function resume() {
    if (ctx && ctx.state === 'suspended') return ctx.resume();
    return Promise.resolve();
  }

  // ── SFX: short synthesized blips ───────────────────────
  function blip(freq, dur, type='sine', vol=0.5, slideTo=null) {
    if (!ctx || !sfxOn) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + dur);
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g); g.connect(sfxGain);
    o.start(); o.stop(ctx.currentTime + dur);
  }
  function noiseBurst(dur, vol=0.4, hp=800) {
    if (!ctx || !sfxOn) return;
    const n = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate*dur, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i=0;i<d.length;i++) d[i] = (Math.random()*2-1);
    n.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type='highpass'; f.frequency.value=hp;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime+dur);
    n.connect(f); f.connect(g); g.connect(sfxGain);
    n.start(); n.stop(ctx.currentTime+dur);
  }

  const SFX = {
    boost:  () => { blip(220, 0.25, 'sawtooth', 0.5, 880); },
    zap:    () => { noiseBurst(0.12, 0.4, 1200); blip(140,0.1,'square',0.4); },
    smash:  () => { blip(90, 0.22, 'square', 0.6, 40); noiseBurst(0.1,0.3,300); },
    spike:  () => { blip(180,0.15,'sawtooth',0.5,1400); },
    launch: () => { blip(160,0.4,'sawtooth',0.55,1320); },
    pad:    () => { blip(440,0.18,'triangle',0.5,1760); },
    finish: () => { [523,659,784,1047].forEach((f,i)=>setTimeout(()=>blip(f,0.3,'triangle',0.5),i*90)); },
    eliminated: () => { blip(300,0.4,'sawtooth',0.5,60); },
    countbeep: () => { blip(660,0.12,'square',0.45); },
    go:     () => { blip(880,0.5,'sawtooth',0.6,1760); [0,90,180].forEach((d,i)=>setTimeout(()=>blip([523,659,880][i],0.4,'triangle',0.5),d)); },
    join:   () => { blip(523,0.1,'sine',0.3,784); },
  };

  // ── MUSIC: 16-step synthwave loop (bass + arp + kick) ──
  const SCALE = [110, 130.81, 146.83, 164.81, 196, 220, 261.63]; // A minor-ish
  const BASS  = [0,0,3,3, 5,5,2,2, 0,0,3,3, 4,4,2,2];
  const ARP   = [0,2,4,6, 4,2,0,2, 3,5,4,2, 5,4,2,0];

  function playStep() {
    if (!ctx || !musicOn || ctx.state !== 'running') return;
    const t = ctx.currentTime + 0.02;
    // Kick on quarters
    if (step % 4 === 0) {
      const o=ctx.createOscillator(), g=ctx.createGain();
      o.frequency.setValueAtTime(140,t); o.frequency.exponentialRampToValueAtTime(45,t+0.13);
      g.gain.setValueAtTime(0.7,t); g.gain.exponentialRampToValueAtTime(0.001,t+0.16);
      o.connect(g); g.connect(musicGain); o.start(t); o.stop(t+0.16);
    }
    // Bass
    const bo=ctx.createOscillator(), bg=ctx.createGain();
    bo.type='sawtooth'; bo.frequency.value=SCALE[BASS[step]]/2;
    bg.gain.setValueAtTime(0.18,t); bg.gain.exponentialRampToValueAtTime(0.001,t+0.22);
    const bf=ctx.createBiquadFilter(); bf.type='lowpass'; bf.frequency.value=600;
    bo.connect(bf); bf.connect(bg); bg.connect(musicGain); bo.start(t); bo.stop(t+0.24);
    // Arp lead
    const ao=ctx.createOscillator(), ag=ctx.createGain();
    ao.type='square'; ao.frequency.value=SCALE[ARP[step]]*2;
    ag.gain.setValueAtTime(0.06,t); ag.gain.exponentialRampToValueAtTime(0.001,t+0.18);
    ao.connect(ag); ag.connect(musicGain); ao.start(t); ao.stop(t+0.2);
    step = (step+1) % 16;
  }

  function startMusic() {
    if (!ctx) return;
    if (loopTimer) return;
    const bpm = 124, stepMs = (60000/bpm)/4;
    loopTimer = setInterval(playStep, stepMs);
    console.log('[ZAUDIO] music loop started, ctx:', ctx.state);
  }
  function stopMusic() { if (loopTimer){ clearInterval(loopTimer); loopTimer=null; } }

  // Public API
  function arm() {
    init();
    const go = () => {
      if (!ctx || ctx.state !== 'running') return;
      started = true;
      if (musicOn && !loopTimer) startMusic();
    };
    resume().then(go).catch(go);
    setTimeout(go, 150);
    setTimeout(go, 500);
    setTimeout(go, 1200);
  }
  let _lastSfx = 0, _sfxCount = 0, _sfxWindow = 0;
  function play(name) {
    if(!ctx) init();
    if(!SFX[name]) return;
    const now = performance.now();
    // Rate-limit: at most 4 sfx per 250ms window (prevents pack-collision noise wall)
    if(now - _sfxWindow > 250){ _sfxWindow = now; _sfxCount = 0; }
    if(_sfxCount >= 4) return;
    _sfxCount++;
    resume().then(()=>SFX[name]()).catch(()=>SFX[name]());
  }
  function toggleMusic() {
    musicOn = !musicOn;
    if (musicOn) startMusic(); else stopMusic();
    return musicOn;
  }
  function toggleSfx() { sfxOn = !sfxOn; return sfxOn; }
  function setMusicVol(v){ if(musicGain) musicGain.gain.value = v; }

  return { arm, play, toggleMusic, toggleSfx, setMusicVol, isMusicOn:()=>musicOn };
})();
