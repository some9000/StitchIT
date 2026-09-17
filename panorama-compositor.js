// One offscreen composition path for preview and equirectangular export.
'use strict';
window.S360 = window.S360 || {};
S360.createPanoramaCompositor = function (gl, { stitch, getTarget, post }) {
  const targets = [];
  function target(index, w, h) {
    let entry = targets[index];
    if (!entry || entry.width !== w || entry.height !== h) {
      const next = S360.createRenderTarget(gl, w, h, `Panorama composition ${index}`);
      entry?.dispose();
      targets[index] = entry = next;
    }
    return entry;
  }
  function trimTargets(count) {
    for (let i = targets.length - 1; i >= count; i--) targets[i].dispose();
    targets.length = count;
  }
  return {
    render(w, h, { processing, clean, decals = true }) {
      stitch(w, h, clean);
      let result = getTarget(), index = 0;
      if (processing) {
        result = target(index++, w, h);
        post(w, h, result.fbo, clean);
      }
      if (decals) {
        const slots = S360.stitchDecal.decals;
        for (const [slot, top] of [[slots.bottom, false], [slots.top, true]]) {
          if (!slot.active) continue;
          const next = target(index++, w, h);
          S360.compositeWatermark(gl, S360.stitchDecal.getWmProg, result.tex, w, h,
            next.fbo, slot.tex, slot.size, slot.alpha, slot.rotDeg, top);
          result = next;
        }
      }
      trimTargets(index);
      return result;
    },
    release() { targets.splice(0).forEach(entry => entry.dispose()); },
    invalidate() { targets.length = 0; },
  };
};
