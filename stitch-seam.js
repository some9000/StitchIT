/**
 * Seam analysis worker management for content-aware seam detection.
 * Owns: seamWorker lifecycle, seam curve computation/upload, analysis scheduling.
 * Consumed by: stitcher.js (seam texture binding, render scheduling trigger).
 */
window.S360 = window.S360 || {};
S360.stitchSeam = (() => {
  'use strict';
  let _gl, _cfg, _getGainR, _scheduleRender;
  let _getCurrentImg, _getCurrentTexture;
  let _makeProxy, _gpuImageToProxyCanvas, _analyzeContentAwareSeam, _resolveAnalysisSource;
  let _markStitchDirty;

  // One shared seam-analysis worker; the latest analysis request wins.
  let _seamRequestGeneration = 0;
  const seamWorker = S360.createSingleFlightWorker({
    url: 'seam-worker.js',
    label: 'Seam analysis worker',
    onMessage(msg) {
      if (msg && msg.requestId !== undefined && msg.requestId !== _seamRequestGeneration) return;
      if (msg.type === 'result') {
        if (msg.curve && (!Array.isArray(msg.curve) && !ArrayBuffer.isView(msg.curve))) {
          console.warn('Seam analysis worker returned invalid curve type; using neutral seam.');
          _currentSeam = null;
        } else if (msg.curve && msg.curve.length < 2) {
          console.warn('Seam analysis worker returned a degenerate curve; using neutral seam.');
          _currentSeam = null;
        } else {
          _currentSeam = msg.curve ? { curve: msg.curve, angles: msg.angles, score: msg.score } : null;
        }
      } else if (msg.type === 'error') {
        console.warn('Seam analysis worker failed:', msg.message);
        _currentSeam = null;
      }
      uploadSeamCurve();
      _markStitchDirty();
      _scheduleRender();
    },
  });

  function getSeamProxyWidth(sourceWidth) {
    const fn = S360.seamProxyTargetWidth;
    if (typeof fn === 'function') return fn(sourceWidth);
    if (typeof fn === 'number') return fn;
    return Math.min(1920, Math.max(640, sourceWidth / 3));
  }

  const _neutralSeam = new Uint8Array(256).fill(Math.round(0.5 * 255));
  let _seamTexture = null;
  let _seamTextureWidth = 0;
  let _currentSeam = null;

  function uploadSeamCurve() {
    const curve = _currentSeam?.curve || _neutralSeam;
    const pixels = new Uint8Array(curve.length * 4);
    let created = false;
    for (let i = 0; i < curve.length; i++) {
      pixels[i * 4] = curve[i]; pixels[i * 4 + 3] = 255;
    }
    if (!_seamTexture || _seamTextureWidth !== curve.length) {
      if (_seamTexture) S360.deleteTrackedTexture(_gl, _seamTexture);
      _gl.activeTexture(_gl.TEXTURE0);
      _seamTexture = S360.createTrackedTexture(_gl, {
        width: curve.length, height: 1, label: 'Seam curve texture', bytesPerPixel: 4,
      }, () => _gl.texImage2D(_gl.TEXTURE_2D, 0, _gl.RGBA, curve.length, 1, 0, _gl.RGBA, _gl.UNSIGNED_BYTE, pixels));
      _seamTextureWidth = curve.length;
      created = true;
      _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_MIN_FILTER, _gl.LINEAR);
      _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_MAG_FILTER, _gl.LINEAR);
      _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_WRAP_S, _gl.REPEAT);
      _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_WRAP_T, _gl.CLAMP_TO_EDGE);
    } else {
      _gl.activeTexture(_gl.TEXTURE0);
      _gl.bindTexture(_gl.TEXTURE_2D, _seamTexture);
    }
    if (!created) {
      _gl.texSubImage2D(_gl.TEXTURE_2D, 0, 0, 0, curve.length, 1, _gl.RGBA, _gl.UNSIGNED_BYTE, pixels);
    }
  }

  function dispatchSeamAnalysis(analysisSource, proxyWidth, requestGeneration = _seamRequestGeneration) {
    const cpuSource = analysisSource.isGpuImage
      ? _gpuImageToProxyCanvas(_gl, analysisSource, proxyWidth)
      : analysisSource;
    const proxy = _makeProxy(cpuSource, proxyWidth);
    const buffer = proxy.data.buffer.slice(proxy.data.byteOffset, proxy.data.byteOffset + proxy.data.byteLength);
    seamWorker.request(() => seamWorker.post({
      type: 'analyze',
      requestId: requestGeneration,
      proxy: {
        w: proxy.w,
        h: proxy.h,
        data: buffer,
        scale: proxy.scale
      },
      imgWidth: cpuSource.width,
      imgHeight: cpuSource.height,
      cfg: _cfg,
      gain: _getGainR?.()?.gain || [1, 1, 1]
    }, [buffer]));
  }

  function updateContentAwareSeam(requestGeneration = _seamRequestGeneration) {
    if (requestGeneration !== _seamRequestGeneration) return;
    const currentImg = _getCurrentImg?.();
    if (!currentImg) return;
    const analysisSource = _resolveAnalysisSource(currentImg, _getCurrentTexture?.());
    const proxyWidth = getSeamProxyWidth(analysisSource.width);

    const worker = seamWorker.worker;
    if (!worker) {
      if (!_analyzeContentAwareSeam) return;
      try {
        _currentSeam = _analyzeContentAwareSeam(
          analysisSource.isGpuImage ? _gpuImageToProxyCanvas(_gl, analysisSource, proxyWidth) : analysisSource,
          _cfg, _getGainR?.()?.gain, proxyWidth);
      } catch (error) {
        console.warn('Content-aware seam analysis failed; using the neutral seam.', error);
        _currentSeam = null;
      }
      uploadSeamCurve();
      return;
    }

    dispatchSeamAnalysis(analysisSource, proxyWidth, requestGeneration);
  }

  let _seamAnalysisTimer = null;
  function scheduleContentAwareSeam() {
    const currentImg = _getCurrentImg?.();
    if (!currentImg) return;
    const requestGeneration = ++_seamRequestGeneration;
    if (_seamAnalysisTimer) clearTimeout(_seamAnalysisTimer);
    _seamAnalysisTimer = setTimeout(() => {
      _seamAnalysisTimer = null;
      if (requestGeneration !== _seamRequestGeneration) return;
      updateContentAwareSeam(requestGeneration);
      _markStitchDirty?.();
      _scheduleRender();
    }, 160);
  }

  return {
    init({ gl, cfg, getGainR, getCurrentImg, getCurrentTexture, scheduleRender, markStitchDirty, makeProxy, gpuImageToProxyCanvas, analyzeContentAwareSeam, resolveAnalysisSource }) {
      _gl = gl;
      _cfg = cfg;
      _getGainR = getGainR;
      _getCurrentImg = getCurrentImg;
      _getCurrentTexture = getCurrentTexture;
      _scheduleRender = scheduleRender;
      _markStitchDirty = markStitchDirty;
      _makeProxy = makeProxy;
      _gpuImageToProxyCanvas = gpuImageToProxyCanvas;
      _analyzeContentAwareSeam = analyzeContentAwareSeam;
      _resolveAnalysisSource = resolveAnalysisSource;
      // Bind the neutral fallback curve before the first render, so no stitch
      // ever samples a bare null seam texture while worker analysis is in
      // flight (the first result replaces it via uploadSeamCurve).
      uploadSeamCurve();
      return this;
    },

    updateContentAwareSeam,
    scheduleContentAwareSeam,

    getSeamTexture() { return _seamTexture; },

    // Cancels pending analysis for a source replacement. The previous curve
    // and texture stay live, so frames rendered before the new analysis
    // completes keep a plausible seam instead of sampling an empty texture.
    reset() {
      const wasBusy = seamWorker.busy || _seamAnalysisTimer !== null;
      _seamRequestGeneration++;
      seamWorker.cancel();
      if (_seamAnalysisTimer) clearTimeout(_seamAnalysisTimer);
      _seamAnalysisTimer = null;
      return wasBusy;
    },

    // Context loss/restoration: the texture is dead or must not survive, so
    // everything is dropped, not just pending work.
    clearForContextLoss() {
      const hadTexture = !!_seamTexture;
      _seamRequestGeneration++;
      seamWorker.cancel();
      if (_seamAnalysisTimer) clearTimeout(_seamAnalysisTimer);
      _seamAnalysisTimer = null;
      if (_seamTexture) S360.deleteTrackedTexture(_gl, _seamTexture);
      _seamTexture = null;
      _seamTextureWidth = 0;
      _currentSeam = null;
      // Rebind the neutral fallback whenever the context is usable again, so
      // the next render never samples a bare null texture. Context restore
      // re-enters this function with a live context; true context loss
      // (isContextLost) just drops the dead texture above.
      if (!_gl.isContextLost()) uploadSeamCurve();
      return hadTexture;
    },

    get isWorkerBusy() { return seamWorker.busy || _seamAnalysisTimer !== null; },
  };
})();
