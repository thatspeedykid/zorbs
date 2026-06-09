// ZORBS Shared Session via Ably
// ONE global race - everyone on playzorbs.xyz in same session
// Host election: first tab to claim wins, others follow

const ZORBS_SESSION = (() => {
  let CHANNEL = 'zorbs:global-v1';
  function setChannel(name){ if(!ably) CHANNEL = name; }
  const HB_INTERVAL = 1500;
  const HB_TIMEOUT  = 5000;
  const ELECT_DELAY = 2500; // wait this long for existing host before claiming

  let ably, ch;
  let isHost    = false;
  let myJoinTs  = Date.now();
  let myId      = Math.random().toString(36).slice(2);
  let lastHB    = 0;
  let callbacks = {};
  let broadcastTimer = null;

  async function init(key, cbs) {
    callbacks = cbs;
    await loadScript('https://cdn.ably.com/lib/ably.min-2.js');
    ably = new Ably.Realtime({
      key,
      clientId: myId,
      recover: (_, cb) => cb(true), // recover state on reconnect
    });
    ably.connection.on('connected', () => {
      ch = ably.channels.get(CHANNEL);
      subscribe();
      // Enter presence with join timestamp so oldest tab wins election
      ch.presence.enter({ ts: myJoinTs });
      // Wait ELECT_DELAY to see if a host is already broadcasting
      setTimeout(maybeElect, ELECT_DELAY);
    });
  }

  function loadScript(src) {
    return new Promise(r => {
      if (window.Ably) return r();
      const s = document.createElement('script');
      s.src = src; s.onload = r;
      document.head.appendChild(s);
    });
  }

  function subscribe() {
    // Host heartbeat
    ch.subscribe('hb', msg => { if (msg.clientId !== myId) lastHB = Date.now(); });

    // Full game state from host (positions of all balls)
    ch.subscribe('state', msg => {
      lastHB = Date.now();
      if (isHost && msg.clientId !== myId) {
        // Another host is broadcasting state. Tie-break: lower clientId stays host.
        if (msg.clientId < myId) { console.log('[ZORBS] Another host detected - demoting'); demoteToViewer(); }
        return;
      }
      if (!isHost && callbacks.onState) callbacks.onState(msg.data);
    });

    // Someone joined (from any tab) - EVERYONE processes this, especially host
    ch.subscribe('join', msg => {
      // Don't process our own join (we already added ourselves locally)
      if (msg.clientId === myId) return;
      if (callbacks.onJoin) callbacks.onJoin(msg.data.name, msg.data.isSub, msg.data.color);
    });

    // Race events (start, end, KO, banner, seed, chat)
    ch.subscribe('ev', msg => {
      const {t, v, c} = msg.data;
      // Chat sync - show on all tabs
      if (t === 'chat') {
        try {
          const {name, text, isSub} = JSON.parse(v);
          if(window.addChat) addChat(name, text, isSub);
          // Non-host tabs also process commands
          if(!isHost && window.handleCmd) handleCmd(name, text, isSub);
        } catch(e) {}
        return;
      }
      if (isHost) return;
      // Viewer gets seed from host - build identical track
      if (t === 'seed') {
        console.log('[ZORBS] Got seed from host:', v, 'current:', window._currentSeed, 'phase:', window.phase);
        // ONLY rebuild if seed actually changed AND we're not mid-race
        if(window._currentSeed !== v && window.phase !== 'racing' && window.phase !== 'countdown') {
          console.log('[ZORBS] Rebuilding course with new seed:', v);
          window._currentSeed = v;
          window._courseBuilt = false;
          if(window.initCourse) window.initCourse(v);
        }
        return;
      }
      if (t === 'phase' && window.phase !== undefined) {
        window.phase = v;
        window._lastKnownPhase = v;
        const el = document.getElementById('stxt');
        if (el) el.textContent = v.toUpperCase();
      }
      if (t === 'count') {
        if (window.showCountdown) window.showCountdown(v >= 0 ? v : null);
        return;
      }
      if (t === 'winner') {
        if(window.showBanner) showBanner('🏆 WINNER: '+v, 4500);
        setTimeout(()=>{ if(window.showEndLeaderboard) showEndLeaderboard(); }, 4500);
        setTimeout(()=>{ if(window.resetRace) resetRace(); }, 16000);
      }
      if (t === 'finish') {
        if(window.showKO) showKO('🏁 #'+c+': '+v, 0xffff00);
        // Mark ball as finished
        if(window.zorbs) {
          const z = window.zorbs.find(z=>z.name===v);
          if(z){ z.finished=true; z.rank=c; }
        }
      }
      if (t === 'banner' && window.showBanner) showBanner(v, 2000);
      if (t === 'ko'     && window.showKO)     showKO(v, c);
      if (t === 'start'  && window.streamerStart && !isHost) {
        // Viewer: sync race start
        window.phase = 'racing';
      }
    });

    // Remote control from dashboard (start race, camera, reset)
    ch.subscribe('ctl', msg => {
      const {cmd, val} = msg.data || {};
      if (window.handleRemoteCtl) window.handleRemoteCtl(cmd, val);
    });

    // Kick chat commands routed via host
    ch.subscribe('kick', msg => {
      const {name, cmd, isSub} = msg.data;
      if (window.handleCmd) handleCmd(name, cmd, isSub);
      if (window.addChat)   addChat(name, cmd, isSub);
    });

    // Host death handled by periodic runElection (presence drops dead tabs)
  }

  // Deterministic election: every 2s check presence; member with lowest
  // (ts, clientId) tuple is THE host. Self-heals split-brain both ways.
  function maybeElect() {
    runElection();
    setInterval(runElection, 2000);
  }

  function runElection() {
    ch.presence.get((err, members) => {
      if (err || !members || members.length === 0) {
        // Can't see presence - if no heartbeats either, claim host
        if (lastHB === 0 && !isHost) becomeHost();
        return;
      }
      // Sort by join ts, tie-break clientId - first is the rightful host
      const sorted = members.slice().sort((a, b) => {
        const ta = a.data?.ts ?? Infinity, tb = b.data?.ts ?? Infinity;
        if (ta !== tb) return ta - tb;
        return (a.clientId || '').localeCompare(b.clientId || '');
      });
      const rightfulHost = sorted[0].clientId;
      if (rightfulHost === myId && !isHost) {
        becomeHost();
      } else if (rightfulHost !== myId && isHost) {
        console.log('[ZORBS] Not rightful host - demoting');
        demoteToViewer();
      } else if (rightfulHost !== myId && !isHost && !window.IS_VIEWER) {
        window.IS_VIEWER = true;
        if (callbacks.onConfirmViewer) callbacks.onConfirmViewer();
      }
    });
  }

  function demoteToViewer() {
    isHost = false;
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    window.IS_HOST = false;
    window.IS_VIEWER = true;
    if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null; }
    if (callbacks.onConfirmViewer) callbacks.onConfirmViewer();
  }

  function becomeHost() {
    if (isHost) return;
    isHost = true;
    window._hostSince = Date.now();
    console.log('[ZORBS] I AM HOST at', new Date().toLocaleTimeString());
    if (callbacks.onBecomeHost) callbacks.onBecomeHost();

    heartbeatTimer = setInterval(() => ch.publish('hb', {id: myId, ts: myJoinTs}), HB_INTERVAL);

    // Broadcast full game state at 20fps
    broadcastTimer = setInterval(() => {
      if (!window.zorbs || !window.pathNodes) return;
      try {
        ch.publish('state', {
          phase: window.phase || 'lobby',
          _seed: window._currentSeed,
          balls: window.zorbs.map(z => ({
            n:  z.name,
            c:  z.color,
            s:  z.isSub ? 1 : 0,
            x:  +z.pos.x.toFixed(1),
            y:  +z.pos.y.toFixed(1),
            z:  +z.pos.z.toFixed(1),
            ni: z.nodeIdx || 0,
            f:  z.finished    ? 1 : 0,
            d:  z.disqualified? 1 : 0,
            r:  z.rank || 0,
          })),
        });
      } catch(e) {}
    }, 50); // 20fps
  }

  function publishJoin(name, isSub, color) {
    if (ch) ch.publish('join', {name, isSub, color});
  }

  function publishEvent(type, val, color) {
    if (ch && isHost) ch.publish('ev', {t: type, v: val, c: color});
  }

  function publishKickCmd(name, cmd, isSub) {
    if (ch && isHost) ch.publish('kick', {name, cmd, isSub});
  }

  function amHost()      { return isHost; }
  function isConnected() { return ably?.connection.state === 'connected'; }

  return { init, setChannel, publishJoin, publishEvent, publishKickCmd, amHost, isConnected };
})();
