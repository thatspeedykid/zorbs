// ZORBS Shared Session via Ably
// ONE global race session - everyone on playzorbs.xyz plays together
// First tab = HOST (runs physics, broadcasts state)
// All other tabs = VIEWERS (render received state)
// If host leaves, next viewer auto-promotes to host

const ZORBS_SESSION = (() => {
  const CHANNEL_NAME = 'zorbs:main';
  const BROADCAST_HZ = 20; // 20 state updates/sec
  const HOST_TIMEOUT = 4000; // 4s no heartbeat = host gone

  let ably, channel;
  let isHost = false;
  let lastHeartbeat = 0;
  let myId = Math.random().toString(36).slice(2);
  let broadcastTimer = null;
  let heartbeatTimer = null;
  let hostCheckTimer = null;
  let callbacks = {};
  let connected = false;

  async function init(apiKey, cbs) {
    callbacks = cbs;
    // Load Ably SDK dynamically
    await loadScript('https://cdn.ably.com/lib/ably.min-2.js');
    ably = new Ably.Realtime({ key: apiKey, clientId: myId });
    channel = ably.channels.get(CHANNEL_NAME);

    ably.connection.on('connected', () => {
      connected = true;
      console.log('[ZORBS] Connected to Ably');
      subscribeToMessages();
      // Wait 2s to see if there's already a host broadcasting
      setTimeout(electHost, 2000);
    });
  }

  function loadScript(src) {
    return new Promise(resolve => {
      if (window.Ably) return resolve();
      const s = document.createElement('script');
      s.src = src; s.onload = resolve;
      document.head.appendChild(s);
    });
  }

  function subscribeToMessages() {
    // Someone joined via chat/UI
    channel.subscribe('join', msg => {
      if (!isHost) {
        // Viewer: create ball locally so we see it
        if (callbacks.onJoin) callbacks.onJoin(msg.data.name, msg.data.isSub, msg.data.color);
      }
    });

    // Host broadcasting game state
    channel.subscribe('state', msg => {
      lastHeartbeat = Date.now();
      if (!isHost && callbacks.onState) callbacks.onState(msg.data);
    });

    // Host heartbeat (even when no balls)
    channel.subscribe('hb', () => {
      lastHeartbeat = Date.now();
    });

    // Kick chat commands routed through Ably
    channel.subscribe('kick', msg => {
      const { name, cmd, isSub } = msg.data;
      if (window.handleCmd) handleCmd(name, cmd, isSub);
      if (window.addChat) addChat(name, cmd, isSub);
    });

    // Host announces race events
    channel.subscribe('event', msg => {
      const { type, text, color } = msg.data;
      if (!isHost) {
        if (type === 'banner' && window.showBanner) showBanner(text, 2000);
        if (type === 'ko' && window.showKO) showKO(text, color);
        if (type === 'phase') { window.phase = text; }
      }
    });
  }

  function electHost() {
    if (Date.now() - lastHeartbeat > HOST_TIMEOUT) {
      becomeHost();
    } else {
      // Check periodically if host dies
      hostCheckTimer = setInterval(() => {
        if (Date.now() - lastHeartbeat > HOST_TIMEOUT) {
          clearInterval(hostCheckTimer);
          becomeHost();
        }
      }, 1000);
    }
  }

  function becomeHost() {
    if (isHost) return;
    isHost = true;
    console.log('[ZORBS] THIS TAB IS NOW HOST');
    if (callbacks.onBecomeHost) callbacks.onBecomeHost();

    // Broadcast state at 20fps
    broadcastTimer = setInterval(() => {
      if (!window.zorbs || !window.pathNodes) return;
      try {
        const state = {
          phase: window.phase || 'lobby',
          balls: window.zorbs.slice(0, 1000).map(z => ({
            n: z.name,
            c: z.color,
            s: z.isSub ? 1 : 0,
            x: +z.pos.x.toFixed(1),
            y: +z.pos.y.toFixed(1),
            z: +z.pos.z.toFixed(1),
            ni: z.nodeIdx || 0,
            f: z.finished ? 1 : 0,
            d: z.disqualified ? 1 : 0,
            r: z.rank || 0,
            kf: +(z.knockFlash || 0).toFixed(2),
          })),
        };
        channel.publish('state', state);
      } catch(e) {}
    }, 1000 / BROADCAST_HZ);

    // Heartbeat every 1.5s
    heartbeatTimer = setInterval(() => {
      channel.publish('hb', { id: myId });
    }, 1500);
  }

  // Publish that someone joined
  function publishJoin(name, isSub, color) {
    if (channel) channel.publish('join', { name, isSub, color });
  }

  // Publish a race event (banner, ko, phase change)
  function publishEvent(type, text, color) {
    if (channel && isHost) channel.publish('event', { type, text, color });
  }

  // Publish a Kick chat command (from webhook polling)
  function publishKickCmd(name, cmd, isSub) {
    if (channel && isHost) channel.publish('kick', { name, cmd, isSub });
  }

  function amHost() { return isHost; }
  function isConnected() { return connected; }

  return { init, publishJoin, publishEvent, publishKickCmd, amHost, isConnected };
})();
