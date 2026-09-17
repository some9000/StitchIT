// lens-alignment-worker.js — Nelder-Mead lens alignment optimiser.
// Loads shared pure kernels via importScripts so the
// main-thread fallback and worker share one kernel.
'use strict';
importScripts('geometry.js', 'lens-alignment-kernel.js', 'lens-geometry-kernel.js');

self.onmessage = function (e) {
  const msg = e.data;
  if (msg.type !== 'optimize' && msg.type !== 'optimizeGeometry') return;
  try {
    const proxy = { w: msg.proxy.w, h: msg.proxy.h, data: new Uint8ClampedArray(msg.proxy.data), scale: msg.proxy.scale };
    const kernel = msg.type === 'optimizeGeometry' ? S360.lensGeometryKernel : S360.lensAlignmentKernel;
    const args = msg.type === 'optimizeGeometry'
      ? [proxy, msg.imgWidth, msg.imgHeight, msg.cfg, msg.options]
      : [proxy, msg.imgWidth, msg.imgHeight, msg.cfg, msg.gain || [1, 1, 1], undefined];
    const result = kernel.optimize(...args,
      (fraction) => {
        // Kernel reports 0..1 across both passes. Throttle so only ~10%
        // steps cross the worker boundary.
        if (typeof fraction !== 'number' || !isFinite(fraction)) return;
        const f = Math.max(0, Math.min(1, fraction));
        if (typeof self.__lensAlignLastSent === 'undefined') self.__lensAlignLastSent = -1;
        if (f - self.__lensAlignLastSent >= 0.05 || f >= 1) {
          self.__lensAlignLastSent = f;
          self.postMessage({ type: 'progress', fraction: f });
        }
      });
    self.__lensAlignLastSent = -1;
    self.postMessage({ type: 'result', ...result });
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
