// lens-alignment.js — automatic lens alignment and radial geometry calibration.
// Owns the shared high-resolution source proxy and worker handoff. Pure kernels
// adjust either the eight per-lens alignment controls or radius/margin/feather.
window.S360 = window.S360 || {};
S360.lensAlignment = (() => {
  'use strict';

  let _gl, _cfg, _getCurrentImg, _getCurrentTexture, _getGainR;
  let _makeProxy, _gpuImageToProxyCanvas, _resolveAnalysisSource;

  // Keep enough source detail for the 0.001 centre and 0.05 geometry steps.
  // This is deliberately higher than the content-aware seam proxy because
  // alignment compares the same locations repeatedly across many candidates.
  const PROXY_WIDTH = 4096;
  const WORKER_STALL_MS = 15000;

  const worker = S360.createSingleFlightWorker({
    url: 'lens-alignment-worker.js',
    label: 'Lens alignment worker',
    onMessage(msg) {
      // Progress heartbeats keep the single-flight slot open; anything else
      // resolves the in-flight request.
      if (msg && msg.type === 'progress') {
        armWorkerWatchdog();
        if (_pendingProgress) {
          try { _pendingProgress(msg.fraction); } catch (_) { /* callback is UI-owned */ }
        }
        return;
      }
      if (_pendingResolve) {
        const resolve = _pendingResolve;
        clearWorkerWatchdog();
        _pendingResolve = null;
        _pendingProgress = null;
        resolve(msg);
      }
    },
  });

  let _pendingResolve = null;
  let _pendingProgress = null;
  let _workerWatchdog = null;
  let _fallbackMode = false;
  let _analysisRunning = false;

  async function runExclusive(run) {
    if (_analysisRunning) return { error: 'Another lens analysis is already running' };
    _analysisRunning = true;
    try { return await run(); }
    finally { _analysisRunning = false; }
  }

  function clearWorkerWatchdog() {
    if (_workerWatchdog !== null) clearTimeout(_workerWatchdog);
    _workerWatchdog = null;
  }

  function armWorkerWatchdog() {
    clearWorkerWatchdog();
    if (!_pendingResolve) return;
    _workerWatchdog = setTimeout(() => {
      const resolve = _pendingResolve;
      _pendingResolve = null;
      _pendingProgress = null;
      _workerWatchdog = null;
      worker.cancel();
      resolve?.({ type: 'error', message: 'Alignment worker stopped responding' });
    }, WORKER_STALL_MS);
  }

  function currentParams() {
    const c = _cfg;
    return {
      centerL: c.centers.left[0], centerR: c.centers.right[0],
      widthL: c.width.left, widthR: c.width.right,
      heightL: c.height.left, heightR: c.height.right,
      angleL: c.angle.left, angleR: c.angle.right,
    };
  }

  function buildProxy() {
    const img = _getCurrentImg();
    if (!img) return null;
    const analysisSource = _resolveAnalysisSource(img, _getCurrentTexture?.());
    const cpuSource = analysisSource.isGpuImage
      ? _gpuImageToProxyCanvas(_gl, analysisSource, PROXY_WIDTH)
      : analysisSource;
    const proxy = _makeProxy(cpuSource, PROXY_WIDTH);
    // A GPU source is first read back at proxy size. makeProxy then sees that
    // smaller canvas as its source and reports scale=1, even though geometry
    // below remains in original-image pixels. Preserve the original coordinate
    // scale so projected samples land on the proxy instead of its clamped edge.
    if (analysisSource.isGpuImage) proxy.scale = proxy.w / analysisSource.width;
    return { proxy, imgWidth: analysisSource.width, imgHeight: analysisSource.height };
  }

  function dispatch(proxy, imgWidth, imgHeight, cfg, gain, onProgress, type = 'optimize', options = null) {
    const buffer = proxy.data.buffer.slice(proxy.data.byteOffset, proxy.data.byteOffset + proxy.data.byteLength);
    const payload = {
      type,
      proxy: { w: proxy.w, h: proxy.h, data: buffer, scale: proxy.scale },
      imgWidth, imgHeight,
      cfg: {
        centers: { left: [...cfg.centers.left], right: [...cfg.centers.right] },
        width: { ...cfg.width }, height: { ...cfg.height }, angle: { ...cfg.angle },
        radius: cfg.radius, outerMargin: cfg.outerMargin, rollDeg: { ...cfg.rollDeg },
        horizon: { ...cfg.horizon },
      },
      gain,
      options,
    };
    return new Promise(resolve => {
      _pendingResolve = resolve;
      _pendingProgress = (fraction) => {
        // 0.10..0.95 maps the worker search onto the UI bar: proxy build took
        // 0..0.10, the final apply step takes 0.95..1.
        if (typeof fraction === 'number' && isFinite(fraction)) {
          onProgress && onProgress(0.10 + 0.85 * Math.max(0, Math.min(1, fraction)));
        }
      };
      const dispatched = worker.request(() => worker.post(payload, [buffer]));
      if (!dispatched) {
        clearWorkerWatchdog();
        _pendingResolve = null;
        _pendingProgress = null;
        resolve({ type: 'error', message: 'Worker unavailable' });
      } else {
        armWorkerWatchdog();
      }
    });
  }

  function runFallback(proxy, imgWidth, imgHeight, cfg, gain, onProgress, type = 'optimize', options = null) {
    const kernel = type === 'optimizeGeometry' ? S360.lensGeometryKernel : S360.lensAlignmentKernel;
    if (!kernel?.optimizeAsync) {
      // Kernel not loaded (shouldn't happen on main thread, but guard anyway).
      return Promise.resolve({ type: 'error', message: 'Kernel unavailable' });
    }
    const yieldFn = () => new Promise(r => setTimeout(r, 0));
    const reportProgress = onProgress && ((fraction) => {
      onProgress(0.10 + 0.85 * Math.max(0, Math.min(1, fraction)));
    });
    const args = type === 'optimizeGeometry'
      ? [proxy, imgWidth, imgHeight, cfg, options, reportProgress, yieldFn]
      : [proxy, imgWidth, imgHeight, cfg, gain, undefined, reportProgress, yieldFn];
    return kernel
      .optimizeAsync(...args)
      .then(result => ({ type: 'result', ...result }))
      .catch(err => ({ type: 'error', message: err?.message || String(err) }));
  }

  // Runs the auto-alignment. Resolves with { params, confidence, ... } on
  // success, or { explored } (no params) when the search ran but the current
  // values were already the best. `onProgress` receives 0..1.
  async function autoAlignImpl(onProgress) {
    const img = _getCurrentImg();
    if (!img) return { explored: 0 };

    onProgress && onProgress(0.05);
    let prepared = null;
    try {
      prepared = buildProxy();
    } catch (err) {
      return { explored: 0, error: err?.message || String(err) };
    }
    if (!prepared) return { explored: 0 };
    const { proxy, imgWidth, imgHeight } = prepared;

    onProgress && onProgress(0.1);
    const gain = _getGainR?.()?.gain || [1, 1, 1];
    const cfgSnapshot = {
      centers: { left: [..._cfg.centers.left], right: [..._cfg.centers.right] },
      width: { ..._cfg.width }, height: { ..._cfg.height }, angle: { ..._cfg.angle },
      radius: _cfg.radius, outerMargin: _cfg.outerMargin, rollDeg: { ..._cfg.rollDeg }, horizon: { ..._cfg.horizon },
    };

    let msg;
    if (_fallbackMode) {
      msg = await runFallback(proxy, imgWidth, imgHeight, cfgSnapshot, gain, onProgress);
    } else {
      msg = await dispatch(proxy, imgWidth, imgHeight, cfgSnapshot, gain, onProgress);
      if (msg.type === 'error') {
        // Worker failed — retry on main thread.
        _fallbackMode = true;
        msg = await runFallback(proxy, imgWidth, imgHeight, cfgSnapshot, gain, onProgress);
      }
    }

    if (_getCurrentImg() !== img) return { error: 'Source changed during lens analysis' };

    onProgress && onProgress(0.95);

    if (!msg || msg.type !== 'result' || !msg.params) {
      return {
        explored: (msg && msg.evaluations) || 0,
        error: msg?.type === 'error' ? msg.message : undefined,
      };
    }
    if (!(msg.optimizedValue < msg.baselineValue)) {
      // Optimiser found no better point: keep the user's values untouched,
      // but report how many variants were tested as proof the run happened.
      return { explored: msg.evaluations || 0 };
    }

    onProgress && onProgress(1.0);
    const improvementPct = msg.baselineValue > 0
      ? (msg.baselineValue - msg.optimizedValue) / msg.baselineValue * 100
      : 0;
    return {
      params: msg.params, confidence: msg.confidence, iterations: msg.iterations,
      evaluations: msg.evaluations || 0,
      baselineValue: msg.baselineValue, optimizedValue: msg.optimizedValue,
      improvementPct,
    };
  }

  async function autoGeometryImpl(onProgress, local) {
    const img = _getCurrentImg();
    if (!img) return { explored: 0 };
    onProgress?.(0.05);
    let prepared;
    try { prepared = buildProxy(); }
    catch (err) { return { error: err?.message || String(err) }; }
    if (!prepared) return { explored: 0 };
    const { proxy, imgWidth, imgHeight } = prepared;
    onProgress?.(0.1);
    const cfgSnapshot = {
      centers: { left: [..._cfg.centers.left], right: [..._cfg.centers.right] },
      width: { ..._cfg.width }, height: { ..._cfg.height }, angle: { ..._cfg.angle },
      radius: _cfg.radius, outerMargin: _cfg.outerMargin, rollDeg: { ..._cfg.rollDeg }, horizon: { ..._cfg.horizon },
    };
    const options = {
      gain: _getGainR?.()?.gain || [1, 1, 1],
      ...(local ? { local: true,
      radiusMin: Math.max(80, _cfg.radius - 1.5), radiusMax: Math.min(100, _cfg.radius + 1.5),
      outerMin: Math.max(80, _cfg.outerMargin - 1.5), outerMax: Math.min(100, _cfg.outerMargin + 1.5),
      seamMin: Math.max(20, Math.round(_cfg.blend.seamWidth * 100) - 1),
      seamMax: Math.min(90, Math.round(_cfg.blend.seamWidth * 100) + 1),
      } : {}),
    };
    let msg;
    if (_fallbackMode) {
      msg = await runFallback(proxy, imgWidth, imgHeight, cfgSnapshot, null, onProgress, 'optimizeGeometry', options);
    } else {
      msg = await dispatch(proxy, imgWidth, imgHeight, cfgSnapshot, null, onProgress, 'optimizeGeometry', options);
      if (msg.type === 'error') {
        _fallbackMode = true;
        msg = await runFallback(proxy, imgWidth, imgHeight, cfgSnapshot, null, onProgress, 'optimizeGeometry', options);
      }
    }
    if (_getCurrentImg() !== img) return { error: 'Source changed during lens analysis' };
    onProgress?.(0.98);
    if (!msg || msg.type !== 'result' || !msg.params) {
      return { error: msg?.message || 'Geometry analysis returned no result' };
    }
    if (msg.matches < 8 || msg.confidence < 0.12 || !Number.isFinite(msg.correlation)) {
      return { explored: msg.matches || 0, confidence: msg.confidence || 0 };
    }
    onProgress?.(1);
    return { params: msg.params, confidence: msg.confidence, matches: msg.matches,
      correlation: msg.correlation, uniqueness: msg.uniqueness };
  }

  function autoAlign(onProgress) {
    return runExclusive(() => autoAlignImpl(onProgress));
  }

  function autoGeometry(onProgress) {
    return runExclusive(() => autoGeometryImpl(onProgress, false));
  }

  function improveGeometry(onProgress) {
    return runExclusive(() => autoGeometryImpl(onProgress, true));
  }

  return {
    init({ gl, cfg, getCurrentImg, getCurrentTexture, getGainR, makeProxy, gpuImageToProxyCanvas, resolveAnalysisSource }) {
      _gl = gl;
      _cfg = cfg;
      _getCurrentImg = getCurrentImg;
      _getCurrentTexture = getCurrentTexture;
      _getGainR = getGainR;
      _makeProxy = makeProxy;
      _gpuImageToProxyCanvas = gpuImageToProxyCanvas;
      _resolveAnalysisSource = resolveAnalysisSource;
      // Detect worker availability once.
      try {
        if (location.protocol === 'file:') _fallbackMode = true;
      } catch (_) { _fallbackMode = true; }
      return this;
    },
    autoAlign,
    autoGeometry,
    improveGeometry,
    get isWorkerUnavailable() { return _fallbackMode; },
  };
})(window.S360);

