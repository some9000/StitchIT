// The same pure kernel runs in the browser fallback and this worker.
'use strict';
importScripts('geometry.js', 'drawing-projection.js');
self.onmessage = function (event) {
  if (event.data.type !== 'bake') return;
  try {
    const result = S360.drawingProjection.projectPatches(event.data);
    self.postMessage({ type: 'result', ...result }, result.patches.map(tile => tile.data.buffer));
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || String(error) });
  }
};
