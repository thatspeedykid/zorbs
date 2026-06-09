// ZORBS Session Manager - shared session via Ably
// One tab = HOST (runs physics, broadcasts state)
// Everyone else = VIEWER (renders received state)

const ZORBS_SESSION = (() => {
  const CHANNEL = 'zorbs-main-session';
  const STATE_INTERVAL = 50; // broadcast every 50ms = 20fps
  const HOST_TIMEOUT = 3000;  // 3s without heartbeat = host is gone

  let ably = null;
  let channel = null;
  let isHost = false;
  let lastHostbeat = 0;
  let hostCheckInterval = null;
  let broadcastInterval = null;
  let onJoinCallback = null;
  let onStateCallback = null;
  let onHostChangeCallback = null;
  let myId = Math.random().toString(36).slice(2);
  let playerCount = 0;

  function init(apiKey, callbacks) {
    onJoinCallback    = callbacks.onJoin;    // someone joined: (name, isSub)
    onStateCallback   = callbacks.onState;   // got game state from host
    onHostChangeCallback = callbacks.onHostChange; // we became host

    // Load Ably SDK
    const script = document.createElement('script');
    script.src = 'https://cdn.ably.com/lib/ably.min-2.js';
    script.onload = () => connect(apiKey);
    document.head.appendChild(script);
  }

  function connect(apiKey) {
    ably = new Ably.Realtime({ key: apiKey, clientId: myId });
    channel = ably.channels.get(CHANNEL);

    channel.subscribe('join', msg => {
      const { name, isSub } = msg.data;
      if (onJoinCallback) onJoinCallback(name, isSub);
      playerCount++;
      updatePlayerCount();
    });

    channel.subscribe('leave', msg => {
      playerCount = Math.max(0, playerCount - 1);
      updatePlayerCount();
    });

    channel.subscribe('state', msg => {
      // Only viewers process state messages from host
      if (!isHost && onStateCallback) {
        lastHostbeat = Date.now();
        onStateCallback(msg.data);
      }
    });

    channel.subscribe('heartbeat', msg => {
      if (!isHost) lastHostbeat = Date.now();
    });

    channel.subscribe('chat', msg => {
      const { name, text, isSub } = msg.data;
      if (window.addChat) addChat(name, text, isSub);
    });

    // Get presence count
    channel.presence.get((err, members) => {
      if (!err) playerCount = members.length;
      updatePlayerCount();
    });
    channel.presence.enter({ id: myId });

    // Listen for presence changes
    channel.presence.subscribe('enter', () => { playerCount++; updatePlayerCount(); });
    channel.presence.subscribe('leave', () => { playerCount = Math.max(0, playerCount-1); updatePlayerCount(); });

    // Wait a moment then check if there's a host
    setTimeout(checkForHost, 1500);
  }

  function checkForHost() {
    // If no heartbeat received in HOST_TIMEOUT, become host
    if (Date.now() - lastHostbeat > HOST_TIMEOUT) {
      becomeHost();
    } else {
      // Start checking if host goes away
      hostCheckInterval = setInterval(() => {
        if (Date.now() - lastHostbeat > HOST_TIMEOUT) {
          clearInterval(hostCheckInterval);
          becomeHost();
        }
      }, 1000);
    }
  }

  function becomeHost() {
    if (isHost) return;
    isHost = true;
    console.log('[ZORBS] This tab is now HOST');
    if (onHostChangeCallback) onHostChangeCallback(true);

    // Broadcast game state at 20fps
    broadcastInterval = setInterval(() => {
      if (!window.zorbs || !window.phase) return;
      const state = {
        phase: window.phase,
        balls: window.zorbs.map(z => ({
          name: z.name,
          col: z.color,
          isSub: z.isSub,
          x: +z.pos.x.toFixed(2),
          y: +z.pos.y.toFixed(2),
          z: +z.pos.z.toFixed(2),
          vx: +z.vel.x.toFixed(2),
          vy: +z.vel.y.toFixed(2),
          vz: +z.vel.z.toFixed(2),
          nodeIdx: z.nodeIdx,
          finished: z.finished,
          dq: z.disqualified,
          rank: z.rank,
          flash: z.knockFlash || 0,
        })),
        t: Date.now(),
      };
      channel.publish('state', state);
    }, STATE_INTERVAL);

    // Heartbeat every second so viewers know we're alive
    setInterval(() => channel.publish('heartbeat', { id: myId }), 1000);
  }

  function updatePlayerCount() {
    const el = document.getElementById('cnt');
    if (el) el.textContent = playerCount + ' online';
  }

  function publishJoin(name, isSub) {
    if (channel) channel.publish('join', { name, isSub });
  }

  function publishChat(name, text, isSub) {
    if (channel) channel.publish('chat', { name, text, isSub });
  }

  function isHostTab() { return isHost; }

  return { init, publishJoin, publishChat, isHostTab };
})();
