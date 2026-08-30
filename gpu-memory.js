// gpu-memory.js — Centralized GPU VRAM budget tracker
//
// Every texture / FBO allocation in the app registers here so we can enforce a
// global VRAM budget and proactively evict non-essential caches *before* the GPU
// runs out of memory and triggers a context loss (which destroys all resources
// and forces a full recovery cycle).
//
// Design priorities:
//   1. Prevent context loss from OOM — the single biggest reliability risk.
//   2. Keep the 2D preview responsive by shedding only non-essential caches.
//   3. Provide visibility — S360.gpuMem.log() dumps a console table.

window.S360 = window.S360 || {};
(function (S360) {

  // ---- budget estimation ----

  let _budget = 0;   // estimated usable VRAM in bytes
  let _total = 0;    // currently tracked bytes
  const _entries = new Map(); // id -> { bytes, label }
  let _shedCallback = null;   // app-level callback to free non-essentials
  let _warnCallback = null;   // UI-level callback for user-facing warnings
  let _warnedAt = 0;          // throttle warnings (don't spam)

  // Estimate usable VRAM from the GPU's reported capabilities.  There is no
  // direct query for total VRAM in WebGL; we use MAX_TEXTURE_SIZE as a proxy
  // (larger textures → more VRAM) and leave headroom for the browser compositor,
  // video decode buffers, and other tabs.
  function _estimateBudget(gl) {
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    // Heuristic:
    //   MAX_TEXTURE_SIZE >= 16384 → ≥4 GiB VRAM → budget ~2.5 GiB
    //   MAX_TEXTURE_SIZE >= 8192  → ≥2 GiB VRAM → budget ~1.25 GiB
    //   MAX_TEXTURE_SIZE >= 4096  → ≥1 GiB VRAM → budget ~600 MiB
    //   else                     → ≤512 MiB    → budget ~300 MiB
    let raw;
    if      (maxTex >= 16384) raw = 2.5 * 1024 * 1024 * 1024;
    else if (maxTex >= 8192)  raw = 1.25 * 1024 * 1024 * 1024;
    else if (maxTex >= 4096)  raw = 600 * 1024 * 1024;
    else                     raw = 300 * 1024 * 1024;
    return Math.floor(raw);
  }

  // ---- public API ----

  S360.gpuMem = {
    /** Initialise the tracker.  Call once after getting the GL context. */
    init(gl) {
      _budget = _estimateBudget(gl);
      console.log(`🎮 GPU memory budget estimated at ${(_budget / 1048576).toFixed(0)} MiB (MAX_TEXTURE_SIZE=${gl.getParameter(gl.MAX_TEXTURE_SIZE)})`);
    },

    /** Override the budget (e.g. user preference or device-specific value). */
    setBudget(bytes) { _budget = bytes; },

    /** Current estimated budget in bytes. */
    budget() { return _budget; },

    /** Current tracked usage in bytes. */
    total() { return _total; },

    /** Free headroom in bytes. */
    headroom() { return Math.max(0, _budget - _total); },

    /** True if `needed` bytes can be allocated without exceeding budget. */
    willFit(needed) { return (_total + needed) <= _budget; },

    /** Ratio of used / budget (0–1+). */
    pressure() { return _budget > 0 ? _total / _budget : 0; },

    /** Look up a tracked entry by id. Returns { bytes, label } or null. */
    getEntry(id) { return _entries.get(id) || null; },

    // ---- tracking ----

    /** Register or update a named allocation. */
    track(id, bytes, label) {
      if (_entries.has(id)) _total -= _entries.get(id).bytes;
      _entries.set(id, { bytes: bytes || 0, label: label || id });
      _total += bytes || 0;
    },

    /** Remove a named allocation. */
    untrack(id) {
      if (_entries.has(id)) {
        _total -= _entries.get(id).bytes;
        _entries.delete(id);
      }
    },

    /** Update just the byte count of an existing entry. */
    updateBytes(id, bytes) {
      if (_entries.has(id)) {
        _total -= _entries.get(id).bytes;
        _entries.get(id).bytes = bytes;
        _total += bytes;
      }
    },

    // ---- memory pressure ----

    /**
     * Register a callback that will be invoked when a large allocation would
     * exceed the budget.  The callback receives `(gl, neededBytes)` and should
     * free non-essential GPU resources (lum blur cache, LF textures, old pool
     * entries, etc.) to make room.  The callback may be called repeatedly as
     * the app tries to find headroom.
     */
    onShed(fn) { _shedCallback = fn; },

    /**
     * Register a UI-level callback for user-facing warnings.  Called with a
     * message string when memory pressure exceeds thresholds.
     */
    onWarn(fn) { _warnCallback = fn; },

    /**
     * Attempt to free `needed` bytes by invoking the shed callback.  Returns
     * true if enough headroom was freed (or already existed).
     */
    shed(gl, needed) {
      if (this.willFit(needed)) return true;
      if (_shedCallback) _shedCallback(gl, needed);
      if (this.willFit(needed)) return true;
      // Throttle warnings to once per 3 seconds
      const now = Date.now();
      if (_warnCallback && now - _warnedAt > 3000) {
        _warnedAt = now;
        const mb = (needed / 1048576).toFixed(0);
        const total = (this.total() / 1048576).toFixed(0);
        const bud = (this.budget() / 1048576).toFixed(0);
        _warnCallback(`GPU memory pressure: need ${mb} MiB more (using ${total} / ${bud} MiB).  Reducing quality to prevent context loss.`);
      }
      return this.willFit(needed);
    },

    // ---- diagnostics ----

    /** Dump a summary table to the console. */
    log() {
      const rows = [];
      let total = 0;
      _entries.forEach((e, id) => {
        rows.push({ 'Allocation': e.label || id, 'Bytes': e.bytes, 'MiB': (e.bytes / 1048576).toFixed(1) });
        total += e.bytes;
      });
      rows.sort((a, b) => b.Bytes - a.Bytes);
      console.group(`🎮 GPU Memory — ${(total / 1048576).toFixed(1)} / ${(_budget / 1048576).toFixed(0)} MiB (${(total / _budget * 100).toFixed(0)}%)`);
      console.table(rows);
      console.groupEnd();
      return { total, budget: _budget, entries: [..._entries.entries()].map(([id, e]) => ({ id, ...e })) };
    },

    /** Reset all tracking (call on context loss / restore). */
    reset() {
      _entries.clear();
      _total = 0;
    },
  };

})(window.S360);
