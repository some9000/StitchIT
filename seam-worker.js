// seam-worker.js - content-aware seam selection in a Web Worker.
// Thin transport: the analysis kernel lives in seam-analysis.js and the
// geometry helpers in geometry.js (both loaded via importScripts), so the
// worker path and seam.js's main-thread fallback run the same code.
// The main thread sends a proxy {w, h, data (ArrayBuffer), scale} plus
// imgWidth/imgHeight, cfg, and gain. The worker returns {curve, angles, score}
// or null on failure.
'use strict';
importScripts('geometry.js', 'seam-analysis.js');

self.onmessage = function (e) {
  const msg = e.data;
  if (msg.type !== 'analyze') return;
  try {
    // stitch-seam.js transfers the pixels as a raw ArrayBuffer; rebuild the
    // RGBA view the kernel expects (zero-copy view over the transferred buffer).
    const proxy = { ...msg.proxy, data: new Uint8ClampedArray(msg.proxy.data) };
    const result = S360.seamAnalysis.analyzeSeam(proxy, msg.imgWidth, msg.imgHeight, msg.cfg, msg.gain);
    if (result) {
      self.postMessage({ type: 'result', requestId: msg.requestId, curve: result.curve, angles: result.angles, score: result.score });
    } else {
      self.postMessage({ type: 'result', requestId: msg.requestId, curve: null });
    }
  } catch (err) {
    self.postMessage({ type: 'error', requestId: msg.requestId, message: err.message });
  }
};
