// ZORBS Telemetry — shared by index.html, map-editor.html, and any future pages.
// Three jobs:
//   1. Catch all runtime errors (JS, promises, WebGL context lost, track/physics failures)
//   2. Store them in a localStorage ring buffer so diagnostics.html can show them
//   3. POST to /api/log for server-side capture (Vercel function logs)
//
// Game-specific hooks (ball-stuck, track-build timing) are injected by index.html
// via ZTELEM.game.*  after the game boots so this file has no THREE/physics dep.

const ZTELEM = (() => {
  const RING_MAX = 300;
  const LS_KEY   = 'zorbs_telem_v2';

  // ---- ring buffer ----
  function _load() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch(_) { return []; }
  }
  function _save(ring) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(ring.slice(-RING_MAX))); } catch(_) {}
  }

  // ---- deduplication + rate-limit ----
  const _seen = new Map();
  let _sentCount = 0;

  // safe accessor — many game vars exist only after the game boots
  const _g = (fn, def='') => { try { return fn(); } catch(_) { return def; } };

  function report(kind, msg, stack, extra) {
    try {
      const msgStr  = String(msg  || '').slice(0, 500);
      const stackStr= String(stack|| '').slice(0, 2000);
      const key = kind + '|' + msgStr.slice(0, 120);
      const now = Date.now();
      // dedupe: same key within 15 s = skip
      if (_seen.get(key) && now - _seen.get(key) < 15000) return;
      _seen.set(key, now);

      const rec = Object.assign({
        t:       new Date(now).toISOString(),
        kind,
        msg:     msgStr,
        stack:   stackStr,
        build:   _g(() => BUILD,   '?'),
        raceId:  _g(() => _raceId, ''),
        phase:   _g(() => phase,   ''),
        mapId:   _g(() => window._zorbsCustomMap && window._zorbsCustomMap.id, ''),
        page:    location.pathname,
        url:     location.href,
      }, extra || {});

      // always persist locally
      const ring = _load(); ring.push(rec); _save(ring);

      // server POST — capped at 60 per page load to avoid noise
      if (_sentCount < 60) {
        _sentCount++;
        const blob = new Blob([JSON.stringify(rec)], { type: 'application/json' });
        if (navigator.sendBeacon) { navigator.sendBeacon('/api/log', blob); }
        else fetch('/api/log', { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify(rec), keepalive:true }).catch(()=>{});
      }
    } catch(_) {}
  }

  // ---- global error hooks ----
  window.addEventListener('error', e =>
    report('js_error', e.message, e.error && e.error.stack,
      { src: e.filename || location.href, line: e.lineno, col: e.colno }));

  window.addEventListener('unhandledrejection', e => {
    const r = e.reason;
    report('promise_rejection', (r && r.message) || String(r), r && r.stack);
  });

  // WebGL context lost — big deal, renders go blank
  document.addEventListener('webglcontextlost', () =>
    report('webgl_context_lost', 'WebGL context lost — renders will be blank until restored'), true);

  document.addEventListener('webglcontextrestored', () =>
    report('webgl_context_restored', 'WebGL context restored'), true);

  // ---- ball-stuck detector ----
  // Call ZTELEM.game.startStuckWatch(getSnapFn, raceIdFn) at race start.
  // getSnapFn() must return { [id]: {hint, finished} } (same as ZPHYSICS.snapshot()).
  let _stuckTimer = null;
  const _stuckBaseline = new Map(); // id → {hint, ts}
  const _stuckReported = new Set();

  function _stopStuck() {
    if (_stuckTimer) { clearInterval(_stuckTimer); _stuckTimer = null; }
    _stuckBaseline.clear(); _stuckReported.clear();
  }

  function _startStuck(getSnap, getRaceId) {
    _stopStuck();
    _stuckTimer = setInterval(() => {
      try {
        const snap = getSnap(); if (!snap) return;
        const now = Date.now();
        for (const id in snap) {
          const s = snap[id];
          if (s.finished) { _stuckBaseline.delete(id); continue; }
          const base = _stuckBaseline.get(id);
          if (!base) { _stuckBaseline.set(id, { hint: s.hint, ts: now }); continue; }
          if (s.hint !== base.hint) { _stuckBaseline.set(id, { hint: s.hint, ts: now }); continue; }
          const stuckMs = now - base.ts;
          if (stuckMs > 8000 && !_stuckReported.has(id)) {
            _stuckReported.add(id);
            report('ball_stuck',
              `ball "${id}" stuck at hint=${s.hint} for ${Math.round(stuckMs/1000)}s`,
              '', { ballId: id, hint: s.hint, stuckMs,
                    raceId: _g(getRaceId, ''), branch: s.branch || '' });
          }
        }
      } catch(_) {}
    }, 2000);
  }

  // ---- track build timer ----
  // Wrap around ZTRACK.generate calls to catch slow builds + errors.
  function wrapTrackBuild(fn, seed, ...args) {
    const t0 = performance.now();
    try {
      const result = fn(seed, ...args);
      const ms = Math.round(performance.now() - t0);
      if (ms > 3000) report('track_build_slow', `seed=${seed} took ${ms}ms`, '', { seed, ms });
      return result;
    } catch(e) {
      report('track_build_error', `seed=${seed}: ${e && e.message}`, e && e.stack, { seed });
      throw e;
    }
  }

  // ---- public API ----
  function getAll()  { return _load(); }
  function clear()   { try { localStorage.removeItem(LS_KEY); } catch(_) {} }
  function summary() {
    const all = _load();
    const counts = {};
    for (const r of all) counts[r.kind] = (counts[r.kind] || 0) + 1;
    return { total: all.length, counts, latest: all.slice(-5) };
  }

  return {
    report,
    getAll,
    clear,
    summary,
    wrapTrackBuild,
    game: { startStuckWatch: _startStuck, stopStuckWatch: _stopStuck },
  };
})();

// backwards-compat alias — index.html already has some ZLOG.report() calls
const ZLOG = ZTELEM;
