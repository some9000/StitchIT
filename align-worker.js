// align-worker.js - registration worker for frame alignment.
// Thin transport: the registration kernel lives in frame-registration.js
// (importScripts), so the worker path and align.js's main-thread fallback run
// the same code. Receives transferable grayscale proxy buffers, posts back
// registrations.
'use strict';
importScripts('frame-registration.js');

self.onmessage = function (e) {
  try {
    const { proxies, referenceIndex, wrap } = e.data;
    for (const p of proxies) {
      p.gray = new Float32Array(p.buffer);
      Object.assign(p, S360.frameRegistration.computeGradients(p.gray, p.w, p.h));
    }
    const ref = proxies[referenceIndex];
    const registrations = proxies.map((p, i) =>
      i === referenceIndex
        ? { dx: 0, dy: 0, confidence: 1 }
        : S360.frameRegistration.register(ref, p, wrap)
    );
    self.postMessage({ registrations });
  } catch (error) {
    self.postMessage({ error: error.message || String(error) });
  }
};
