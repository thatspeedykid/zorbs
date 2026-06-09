// ZORBS Shared Session via Ably
// ONE global race - everyone on playzorbs.xyz in same session
// Host election: first tab to claim wins, others follow

const ZORBS_SESSION = (() => {
  const CHANNEL = 'zorbs:global-v1';
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
    ch.subscribe('hb', () => { lastHB = Date.now(); });

    // Full game state from host (positions of all balls)
    ch.subscribe('state', msg => {
      lastHB = Date.now();
      if (!isHost && callbacks.onState) callbacks.onState(msg.data);
    });

    // Someone joined (from any tab)
    ch.subscribe('join', msg => {
      lastHB = Date.now(); // host is alive if it published this
      if (!isHost && callbacks.onJoin) callbacks.onJoin(msg.data.name, msg.data.isSub, msg.data.color);
    });

    // Race events (start, end, KO, banner, seed)
    ch.subscribe('ev', msg => {
      if (isHost) return;
      const {t, v, c} = msg.data;
      // Viewer gets seed from host - build identical track
      if (t === 'seed' && window.initCourse && window._currentSeed !== v) {
        console.log('[ZORBS] Got seed from host:', v);
        window.initCourse(v);
        return;
      }
      if (t === 'phase'  && window.phase !== undefined) {
        window.phase = v;
        const el = document.getElementById('stxt');
        if (el) el.textContent = v.toUpperCase();
      }
      if (t === 'banner' && window.showBanner) showBanner(v, 2000);
      if (t === 'ko'     && window.showKO)     showKO(v, c);
      if (t === 'start'  && window.streamerStart && !isHost) {
        // Viewer: sync race start
        window.phase = 'racing';
      }
    });

    // Kick chat commands routed via host
    ch.subscribe('kick', msg => {
      const {name, cmd, isSub} = msg.data;
      if (window.handleCmd) handleCmd(name, cmd, isSub);
      if (window.addChat)   addChat(name, cmd, isSub);
    });

    // Watch for host death
    setInterval(() => {
      if (!isHost && lastHB > 0 && Date.now() - lastHB > HB_TIMEOUT) {
        console.log('[ZORBS] Host timeout - electing new host');
        lastHB = Date.now(); // reset to avoid double-elect
        electHost();
      }
    }, 1000);
  }

  function maybeElect() {
    // If no heartbeat received yet, we're likely the first tab = become host
    if (lastHB === 0) {
      electHost();
    }
    // else: a host is alive, stay as viewer
  }

  async function electHost() {
    // Check presence - oldest tab (lowest ts) becomes host
    try {
      const members = await new Promise((res, rej) =>
        ch.presence.get((err, m) => err ? rej(err) : res(m))
      );
      const myTs = myJoinTs;
      const oldest = members.reduce((min, m) => {
        const ts = m.data?.ts || 9999999999999;
        return ts < min ? ts : min;
      }, 9999999999999);
      if (myTs <= oldest) becomeHost();
    } catch(e) {
      // Fallback: just become host
      becomeHost();
    }
  }

  function becomeHost() {
    if (isHost) return;
    isHost = true;
    console.log('[ZORBS] I AM HOST');
    if (callbacks.onBecomeHost) callbacks.onBecomeHost();

    // Heartbeat
    setInterval(() => ch.publish('hb', {id: myId}), HB_INTERVAL);

    // Broadcast full game state at 20fps
    broadcastTimer = setInterval(() => {
      if (!window.zorbs || !window.pathNodes) return;
      try {
        ch.publish('state', {
          phase: window.phase || 'lobby',
          _seed: window._currentSeed,  // so late joiners get the seed
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

  return { init, publishJoin, publishEvent, publishKickCmd, amHost, isConnected };
})();
