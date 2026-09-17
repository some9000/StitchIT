// seam.js - main-thread access to content-aware seam selection.
// Owns CPU proxy construction (DOM canvas); the search itself is the pure
// kernel in seam-analysis.js, which also serves seam-worker.js. Geometry
// helpers live in geometry.js (S360 namespace).
window.S360 = window.S360 || {};
(function (S360) {
'use strict';
  // Adaptive proxy resolution for content-aware seam analysis: scale up to
  // 1920 px for large sources so the seam analysis has enough detail to
  // evaluate fine features (hair, text, thin branches); small sources are
  // never upscaled past their native size. GPU sources render straight to
  // this target in one pass (see stitch-seam.js), so both sizing decisions
  // come from this single helper.
  S360.seamProxyTargetWidth = function (sourceWidth) {
    return Math.min(1920, Math.max(640, sourceWidth / 3));
  };

  function makeProxy(img, targetWidth) {
    // Default (no targetWidth) uses the adaptive sizing above. Callers that
    // already hold a proxy at the target size pass the same target so the
    // resample stays 1:1 instead of shrinking back down.
    const w = Math.min(img.width, targetWidth || S360.seamProxyTargetWidth(img.width));
    const h = Math.max(1, Math.round(img.height * w / img.width));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    return { w, h, data: ctx.getImageData(0, 0, w, h).data, scale: w / img.width };
  }

  S360.makeProxy = makeProxy;

  // Finds a smooth closed path through the overlap belt. The result is one
  // normalised left-lens angle for every azimuth sample around the seam.
  S360.analyzeContentAwareSeam = function (img, cfg, gain = [1, 1, 1], targetWidth) {
    if (!img?.width || !img?.height) return null;
    const proxy = makeProxy(img, targetWidth);
    return S360.seamAnalysis.analyzeSeam(proxy, img.width, img.height, cfg, gain);
  };
})(window.S360);
