// Coarse frame coalescing and final-frame debounce have independent lifetimes.
'use strict';
window.S360 = window.S360 || {};
S360.createRenderScheduler = function ({ render, hasSource, settleMs = 200 }) {
  let frame = null, fine = null;
  let generation = 0;
  function cancelFine() {
    if (fine !== null) clearTimeout(fine);
    fine = null;
  }
  function currentGeneration() {
    return generation;
  }
  return {
    schedule() {
      const token = ++generation;
      cancelFine();
      fine = setTimeout(() => {
        if (token !== currentGeneration()) return;
        fine = null;
        if (hasSource()) render(false);
      }, settleMs);
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        if (token !== currentGeneration()) {
          frame = null;
          return;
        }
        frame = null;
        if (hasSource()) render(true);
      });
    },
    cancelFine,
    cancel() {
      generation++;
      cancelFine();
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    },
    summary() {
      return {
        generation,
        queued: frame !== null || fine !== null,
        frame: frame !== null,
        fine: fine !== null,
      };
    },
  };
};
