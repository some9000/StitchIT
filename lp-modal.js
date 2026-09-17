// lp-modal.js — Little-Planet preview modal
// ============================================================================
// This module owns:
//   - the modal's DOM wiring (open button, backdrop/cancel close, drag,
//     wheel zoom, double-click inversion, crop slider, JPG/PNG export)
//   - all little-planet interaction state (the _lp* variables)
//   - the little-planet pixel renderer itself (renderLittlePlanetPixels +
//     its _littlePlanetProg program cache; shader sources live in
//     shaders.js as S360.LITTLE_PLANET_VS/FS)
//
// Everything that needs the app's GL/state core is INJECTED via init():
//   ctx                      — accessor object from stitcher.js
//                              (getCurrentImg, getCfg, getScaleValue,
//                               getLastBaseName, renderPano, getPostEnabled,
//                               getRenderTexture, getFramebuffer)
//   stitchIfNeeded           — core pipeline entrypoint (stitcher.js)
//   renderWithPostProcessing — core pipeline entrypoint (stitcher.js)
//   triggerDownload          — blob download helper (stitcher.js)
//   shedNonEssentials()      — VRAM-shed hook with gl already bound
//
// Classic-script build (plain <script> tags, file://-safe, no ES modules) —
// same pattern as webgl-utils.js / settings.js / viewer.js. This file must be
// loaded BEFORE stitcher.js; stitcher.js calls S360.lpModal.init(...) inside
// its DOMContentLoaded handler.
// ============================================================================
window.S360 = window.S360 || {};
(function (S360) {
'use strict';
  const { createProgram, getQuadVAO, getPooledFBO, getPooledPostFBO } = S360;
  const { LITTLE_PLANET_VS, LITTLE_PLANET_FS } = S360;

  // ---- injected at init() ----------------------------------------------------
  let ctx = null;                      // app accessor object (stitcher.js)
  let stitchIfNeeded = null;           // core pipeline entrypoint (stitcher.js)
  let renderWithPostProcessing = null; // core pipeline entrypoint (stitcher.js)
  let triggerDownload = null;          // blob download helper (stitcher.js)
  let shedNonEssentials = null;        // VRAM shed hook (gl already bound)

  // Cached little-planet program — lives in this module's closure, so the
  // context-restore handler in stitcher.js resets it via
  // S360.lpModal.invalidateProgram().
  let _littlePlanetProg = null;

  // ---- DOM refs (fetched at init) -------------------------------------------
  let downloadBtn = null;
  let downloadJpgBtn = null;
  let downloadLittlePlanetBtn = null;
  let lpModal = null;
  let lpModalCanvas = null;
  let lpCancelBtn = null;
  let lpExportJpgBtn = null;
  let lpExportPngBtn = null;
  let lpCropSlider = null;
  let lpCropVal = null;
  let lpProjButtons = [];
  let lpInvertBtn = null;

  // ---- little planet preview modal state -------------------------------------
  let _lpZoom = 0.5;
  let _lpYaw = 0.0;
  let _lpDragging = false;
  let _lpPrevAngle = 0;
  let _lpWheelTimer = null;
  let _lpModalRaf = null;
  let _lpFineTimer = null;
  let _lpCanvasSize = 600;
  let _lpFlip = false;       // inverted little-planet projection (zenith at centre)
  let _lpProjType = 0;       // 0 = equidistant, 1 = stereographic, 2 = orthographic
  let _lpCrop = 1.0;         // Crop slider: uniform render scale >= 1 (trims the disc's outer ring)
  let _lpPreviousFocus = null;
  const LP_SETTLE_MS = 150;

  // ---- functions (shared-state reads arrive via ctx / injected deps) ---------

  // Renders the little-planet projection of the current stitch into a fresh
  // 2D canvas and returns it.
  let planetTarget = null;
  function renderLittlePlanetPixels(panoW, panoH, outW, outH, zoom, yaw, mirror, flip = false, crop = 1.0, projType = 0) {
    const gl = ctx.gl;
    stitchIfNeeded(panoW, panoH, true);

    let srcTex = ctx.getRenderTexture();
    let readFbo = ctx.getFramebuffer();

    if (ctx.getPostEnabled()) {
      const pooled = getPooledPostFBO(gl, panoW, panoH);
      renderWithPostProcessing(panoW, panoH, pooled.fbo, true);
      readFbo = pooled.fbo;
      srcTex = pooled.tex;
    }

    // Watermark is composited inside the little planet shader (yaw-free UVs
    // keep the decal centred in the image regardless of rotation or flip), so
    // the old pre-shader compositeWatermark() call is not needed here.

    const maxDim = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0]);
    let size = Math.min(outW || Math.round((panoW + panoH) / 1.5), maxDim);
    // Budget-aware cap: a square target at `size` costs size²·4 bytes of VRAM
    // for the FBO (plus a same-size canvas backing for the banded readback).
    // Shrink only when the global VRAM tracker says it will not fit — typical
    // sources (≤8K wide) are unaffected; huge ones render at the largest safe
    // size instead of risking a context loss, which would destroy the source
    // texture and force a full reload.  8 bytes/px = RGBA8 FBO + readback
    // canvas estimate.
    if (S360.gpuMem) {
      const maxByBudget = Math.floor(Math.sqrt(S360.gpuMem.headroom() / 8));
      if (maxByBudget >= 512) size = Math.min(size, maxByBudget);
    }
    const aspect = outW ? (outW / Math.max(1, outH)) : 1.0;

    if (!_littlePlanetProg) {
      _littlePlanetProg = createProgram(gl, LITTLE_PLANET_VS, LITTLE_PLANET_FS);
    }

    if (!planetTarget || planetTarget.width !== size) {
      const next = S360.createRenderTarget(gl, size, size, 'Little planet');
      planetTarget?.dispose();
      planetTarget = next;
    }
    const lpEntry = planetTarget;
    gl.bindFramebuffer(gl.FRAMEBUFFER, lpEntry.fbo);
    gl.viewport(0, 0, size, size);
    gl.useProgram(_littlePlanetProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(gl.getUniformLocation(_littlePlanetProg, 'u_tex'), 0);
    if (_littlePlanetProg._uZoom === undefined) {
      _littlePlanetProg._uZoom = gl.getUniformLocation(_littlePlanetProg, 'u_zoom');
      _littlePlanetProg._uYaw = gl.getUniformLocation(_littlePlanetProg, 'u_yaw');
      _littlePlanetProg._uAspect = gl.getUniformLocation(_littlePlanetProg, 'u_aspect');
      _littlePlanetProg._uMirror = gl.getUniformLocation(_littlePlanetProg, 'u_mirror');
      _littlePlanetProg._uProjType = gl.getUniformLocation(_littlePlanetProg, 'u_projType');
      _littlePlanetProg._uWmBOn = gl.getUniformLocation(_littlePlanetProg, 'u_wmBOn');
      _littlePlanetProg._uWmB = gl.getUniformLocation(_littlePlanetProg, 'u_wmB');
      _littlePlanetProg._uWmBSize = gl.getUniformLocation(_littlePlanetProg, 'u_wmBSize');
      _littlePlanetProg._uWmBAlpha = gl.getUniformLocation(_littlePlanetProg, 'u_wmBAlpha');
      _littlePlanetProg._uWmBRot = gl.getUniformLocation(_littlePlanetProg, 'u_wmBRot');
      _littlePlanetProg._uWmTOn = gl.getUniformLocation(_littlePlanetProg, 'u_wmTOn');
      _littlePlanetProg._uWmT = gl.getUniformLocation(_littlePlanetProg, 'u_wmT');
      _littlePlanetProg._uWmTSize = gl.getUniformLocation(_littlePlanetProg, 'u_wmTSize');
      _littlePlanetProg._uWmTAlpha = gl.getUniformLocation(_littlePlanetProg, 'u_wmTAlpha');
      _littlePlanetProg._uWmTRot = gl.getUniformLocation(_littlePlanetProg, 'u_wmTRot');
      _littlePlanetProg._uFlip = gl.getUniformLocation(_littlePlanetProg, 'u_flip');
      _littlePlanetProg._uCrop = gl.getUniformLocation(_littlePlanetProg, 'u_crop');
    }
    gl.uniform1f(_littlePlanetProg._uZoom, zoom || 1.0);
    gl.uniform1f(_littlePlanetProg._uYaw, yaw || 0.0);
    gl.uniform1f(_littlePlanetProg._uAspect, aspect);
    gl.uniform1f(_littlePlanetProg._uMirror, mirror ? -1.0 : 1.0);
    gl.uniform1i(_littlePlanetProg._uProjType, projType);
    gl.uniform1f(_littlePlanetProg._uFlip, flip ? 1.0 : 0.0);
    // Crop: guard against 0/NaN so a bad value can never blow up the projection.
    gl.uniform1f(_littlePlanetProg._uCrop, (typeof crop === 'number' && Number.isFinite(crop) && crop >= 1.0) ? crop : 1.0);
    // Watermark uniforms — the shader composites the decals at yaw-free UVs
    // so they stay centred in the image regardless of rotation or flip state.
    // Bottom (nadir) decal on texture unit 1, top (zenith) decal on unit 2.
    const slots = S360.stitchDecal.decals;
    if (slots.bottom.active) {
      gl.uniform1f(_littlePlanetProg._uWmBOn, 1.0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, slots.bottom.tex);
      gl.uniform1i(_littlePlanetProg._uWmB, 1);
      gl.uniform1f(_littlePlanetProg._uWmBSize, slots.bottom.size);
      gl.uniform1f(_littlePlanetProg._uWmBAlpha, slots.bottom.alpha);
      gl.uniform1f(_littlePlanetProg._uWmBRot, slots.bottom.rotDeg * Math.PI / 180.0);
    } else {
      gl.uniform1f(_littlePlanetProg._uWmBOn, 0.0);
    }
    if (slots.top.active) {
      gl.uniform1f(_littlePlanetProg._uWmTOn, 1.0);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, slots.top.tex);
      gl.uniform1i(_littlePlanetProg._uWmT, 2);
      gl.uniform1f(_littlePlanetProg._uWmTSize, slots.top.size);
      gl.uniform1f(_littlePlanetProg._uWmTAlpha, slots.top.alpha);
      gl.uniform1f(_littlePlanetProg._uWmTRot, slots.top.rotDeg * Math.PI / 180.0);
    } else {
      gl.uniform1f(_littlePlanetProg._uWmTOn, 0.0);
    }
    gl.bindVertexArray(getQuadVAO(gl));
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Read back WITHOUT the vertical flip that readFboToCanvas applies by
    // default: the little planet shader already outputs in canvas orientation
    // (the flip would rotate the result 180 degrees).
    return S360.readFboToCanvas(gl, lpEntry.fbo, size, size, 1024, false);
  }

  function _sizeLpCanvas() {
    if (!lpModalCanvas) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 96% (was 90%): the hint, crop slider and buttons now overlay the image
    // instead of stacking in flow, so the square can fill the modal.  The CSS
    // caps (.modal-content canvas max-width/height) use the same 96vw/96vh.
    const size = Math.max(200, Math.floor(Math.min(vw * 0.96, vh * 0.96)));
    _lpCanvasSize = size;
    lpModalCanvas.width = size;
    lpModalCanvas.height = size;
  }

  async function onDownloadLittlePlanet() {
    if (!ctx.getCurrentImg()) return;
    _lpPreviousFocus = document.activeElement;
    _lpZoom = 0.25;
    _lpYaw = 0.0;
    _lpDragging = false;
    _lpFlip = false; // fresh modal session starts in the standard projection
    _lpProjType = 0;   // reset to equidistant
    _lpCrop = 1.0;     // ...and un-cropped
    if (lpCropSlider) lpCropSlider.value = 100;
    if (lpCropVal) lpCropVal.textContent = '100%';
    lpProjButtons.forEach((button, index) => button.classList.toggle('active', index === 0));
    if (lpModal) lpModal.classList.remove('hidden');
    lpCancelBtn?.focus();
    _sizeLpCanvas();
    _scheduleLpPreview();
  }

  // Progressive rendering for the little planet modal, mirroring the main view's
  // pattern: coarse pass stitches at 1/4 source res for instant feedback during
  // interaction; fine pass stitches at full source res after a short settle delay.
  // Both passes output at display size (_lpCanvasSize) — the GPU's bilinear
  // filtering produces a clean upscale of the coarse stitch at near-zero cost.
  const LP_COARSE_DIV = 4;

  function _renderLpPreview(highRes = false) {
    if (!lpModalCanvas || !ctx.getCurrentImg()) return;
    const fullW = Math.round(ctx.getCurrentImg().width);
    const fullH = Math.round(fullW / 2);
    const s = _lpCanvasSize;
    if (highRes) {
      // Fine pass: stitch at full source res, render at 2× display size for
      // supersampled anti-aliasing, then downscale to the canvas via drawImage
      // which applies bilinear filtering — eliminates the pixellation artefacts
      // caused by the little planet's non-linear projection sampling.
      const hq = s * 2;
      const canvas = renderLittlePlanetPixels(fullW, fullH, hq, hq, _lpZoom, _lpYaw, ctx.getCfg().mirror3D, _lpFlip, _lpCrop, _lpProjType);
      const ctx2d = lpModalCanvas.getContext('2d');
      ctx2d.drawImage(canvas, 0, 0, s, s);
    } else {
      // Coarse pass: stitch at 1/4 source res (1/16th the pixels) for instant
      // feedback, then upscale to display size via canvas drawImage.
      const cw = Math.max(256, Math.round(fullW / LP_COARSE_DIV));
      const ch = Math.round(cw / 2);
      const canvas = renderLittlePlanetPixels(cw, ch, s, s, _lpZoom, _lpYaw, ctx.getCfg().mirror3D, _lpFlip, _lpCrop, _lpProjType);
      const ctx2d = lpModalCanvas.getContext('2d');
      ctx2d.drawImage(canvas, 0, 0, s, s);
    }
  }

  function _closeLpModal() {
    _lpDragging = false;
    planetTarget?.dispose(); planetTarget = null;
    if (lpModal) lpModal.classList.add('hidden');
    if (_lpModalRaf) { cancelAnimationFrame(_lpModalRaf); _lpModalRaf = null; }
    if (_lpFineTimer) { clearTimeout(_lpFineTimer); _lpFineTimer = null; }
    if (_lpWheelTimer) { clearTimeout(_lpWheelTimer); _lpWheelTimer = null; }
    if (_lpPreviousFocus?.isConnected) _lpPreviousFocus.focus();
    _lpPreviousFocus = null;
  }

  function _scheduleLpPreview() {
    _updateLpPreview();
  }

  function _updateLpPreview() {
    if (_lpModalRaf) return;
    _lpModalRaf = requestAnimationFrame(() => {
      _lpModalRaf = null;
      _renderLpPreview(false);
    });
    if (_lpFineTimer) clearTimeout(_lpFineTimer);
    _lpFineTimer = setTimeout(() => {
      _lpFineTimer = null;
      _renderLpPreview(true);
    }, LP_SETTLE_MS);
  }

  // Shared little-planet export: render at the current view state, encode,
  // download, then close the modal and restore the main view.
  async function lpExport(mime, quality, ext) {
    if (!ctx.getCurrentImg()) return;
    try {
      if (downloadBtn) downloadBtn.disabled = true;
      if (downloadJpgBtn) downloadJpgBtn.disabled = true;
      shedNonEssentials();
      const fullW = Math.round(ctx.getCurrentImg().width);
      const fullH = Math.round(fullW / 2);
      const size = ctx.getCurrentImg().width;
      const exportCanvas = renderLittlePlanetPixels(fullW, fullH, size, size, _lpZoom, _lpYaw, ctx.getCfg().mirror3D, _lpFlip, _lpCrop, _lpProjType);
      const blob = await new Promise((resolve, reject) => {
        exportCanvas.toBlob(b => b ? resolve(b) : reject(new Error('Export failed')), mime, quality);
      });
      triggerDownload(blob, `${ctx.getLastBaseName()}-little-planet.${ext}`);
    } catch (err) {
      console.error(err);
      S360.uiChrome.showToast('Little planet export failed: ' + (err?.message || err), { type: 'error' });
    } finally {
      if (downloadBtn) downloadBtn.disabled = false;
      if (downloadJpgBtn) downloadJpgBtn.disabled = false;
      _closeLpModal();
      ctx.renderPano();
    }
  }

  function _lpDoExportJpg() { return lpExport('image/jpeg', 0.85, 'jpg'); }
  function _lpDoExportPng() { return lpExport('image/png', undefined, 'png'); }

  // ---- init: capture injected deps, fetch DOM, wire all listeners.
  // Called by stitcher.js inside its DOMContentLoaded handler (DOM ready),
  // replacing the listener block that used to live there.
  function init(deps) {
    ctx = deps.ctx;
    stitchIfNeeded = deps.stitchIfNeeded;
    renderWithPostProcessing = deps.renderWithPostProcessing;
    triggerDownload = deps.triggerDownload;
    shedNonEssentials = deps.shedNonEssentials;

    downloadBtn = document.getElementById('downloadBtn');
    downloadJpgBtn = document.getElementById('downloadJpgBtn');
    downloadLittlePlanetBtn = document.getElementById('downloadLittlePlanetBtn');
    lpModal = document.getElementById('lpModal');
    lpModalCanvas = document.getElementById('lpModalCanvas');
    lpCancelBtn = document.getElementById('lpCancelBtn');
    lpExportJpgBtn = document.getElementById('lpExportJpgBtn');
    lpExportPngBtn = document.getElementById('lpExportPngBtn');
    lpCropSlider = document.getElementById('lpCrop');
    lpCropVal = document.getElementById('lpCropVal');
    lpProjButtons = [...document.querySelectorAll('[data-lp-projection]')];
    lpInvertBtn = document.getElementById('lpInvertBtn');

    if (downloadLittlePlanetBtn) downloadLittlePlanetBtn.addEventListener('click', onDownloadLittlePlanet, false);
    if (lpModal) {
      lpModal.addEventListener('click', e => {
        if (e.target === lpModal) _closeLpModal();
      });
      lpModal.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
          e.preventDefault();
          _closeLpModal();
          return;
        }
        if (e.key !== 'Tab') return;
        const focusable = [...lpModal.querySelectorAll('button, input')].filter(el => !el.disabled && el.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      });
    }
    if (lpCancelBtn) {
      lpCancelBtn.addEventListener('click', _closeLpModal);
      lpCancelBtn.addEventListener('touchstart', e => { e.preventDefault(); _closeLpModal(); });
    }
    if (lpExportJpgBtn) {
      lpExportJpgBtn.addEventListener('click', _lpDoExportJpg);
      lpExportJpgBtn.addEventListener('touchstart', e => { e.preventDefault(); _lpDoExportJpg(); });
      if (lpExportPngBtn) {
        lpExportPngBtn.addEventListener('click', _lpDoExportPng);
        lpExportPngBtn.addEventListener('touchstart', e => { e.preventDefault(); _lpDoExportPng(); });
      }
    }

    lpProjButtons.forEach(button => button.addEventListener('click', () => {
      _lpProjType = Number(button.dataset.lpProjection);
      lpProjButtons.forEach(candidate => candidate.classList.toggle('active', candidate === button));
      _updateLpPreview();
    }));
    if (lpInvertBtn) lpInvertBtn.addEventListener('click', () => { _lpFlip = !_lpFlip; _updateLpPreview(); });
    if (lpModalCanvas) {
      // Double-click toggles the inverted little-planet projection (zenith at
      // the disc centre, as if the source were rotated 180 degrees).  Exports
      // honour the current state so what you see is what you get.
      lpModalCanvas.addEventListener('dblclick', e => {
        e.preventDefault();
        _lpFlip = !_lpFlip;
        _updateLpPreview();
      });
      // Crop slider: uniform scale of the render past the canvas edge (NOT the
      // scroll wheel's centre-weighted zoom) — trims the outer ring where
      // tripod/horizon clutter sits.  Coarse preview updates immediately; the
      // fine pass follows after the settle delay inside _updateLpPreview.
      if (lpCropSlider) {
        lpCropSlider.addEventListener('input', () => {
          const pctVal = Math.max(100, Math.min(150, parseInt(lpCropSlider.value, 10) || 100));
          _lpCrop = pctVal / 100;
          if (lpCropVal) lpCropVal.textContent = pctVal + '%';
          _updateLpPreview();
        });
      }
      lpModalCanvas.addEventListener('wheel', e => {
        e.preventDefault();
        if (_lpWheelTimer) clearTimeout(_lpWheelTimer);
        _lpWheelTimer = setTimeout(() => { _lpWheelTimer = null; _scheduleLpPreview(); }, 300);
        const rect = lpModalCanvas.getBoundingClientRect();
        const relY = (e.clientY - rect.top) / rect.height;
        const t = Math.max(0, Math.min(1, (relY - 0.4) / 0.2));
        const invert = 1 - 2 * t;
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          _lpYaw += e.deltaX * 0.005 * invert;
        } else {
          const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
          _lpZoom *= factor;
          _lpZoom = Math.max(0.15, Math.min(1.5, _lpZoom));
        }
        _updateLpPreview();
      }, { passive: false });
      lpModalCanvas.addEventListener('mousedown', e => {
        _lpDragging = true;
        const rect = lpModalCanvas.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        _lpPrevAngle = Math.atan2(e.clientX - cx, -(e.clientY - cy));
        lpModalCanvas.style.cursor = 'grabbing';
        function onMouseMove(e) {
          if (!_lpDragging) return;
          const rect = lpModalCanvas.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const currentAngle = Math.atan2(e.clientX - cx, -(e.clientY - cy));
          let delta = currentAngle - _lpPrevAngle;
          if (delta > Math.PI) delta -= 2 * Math.PI;
          if (delta < -Math.PI) delta += 2 * Math.PI;
          _lpYaw -= delta;
          _lpPrevAngle = currentAngle;
          _updateLpPreview();
        }
        function onMouseUp() {
          _lpDragging = false;
          if (lpModalCanvas) lpModalCanvas.style.cursor = 'grab';
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
          _scheduleLpPreview();
        }
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      });
      lpModalCanvas.addEventListener('touchstart', e => {
        if (e.touches.length === 1) {
          _lpDragging = true;
          const rect = lpModalCanvas.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const t = e.touches[0];
          _lpPrevAngle = Math.atan2(t.clientX - cx, -(t.clientY - cy));
        }
      }, { passive: true });
      lpModalCanvas.addEventListener('touchmove', e => {
        if (!_lpDragging || e.touches.length !== 1) return;
        const rect = lpModalCanvas.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const t = e.touches[0];
        const currentAngle = Math.atan2(t.clientX - cx, -(t.clientY - cy));
        let delta = currentAngle - _lpPrevAngle;
        if (delta > Math.PI) delta -= 2 * Math.PI;
        if (delta < -Math.PI) delta += 2 * Math.PI;
        _lpYaw -= delta;
        _lpPrevAngle = currentAngle;
        _updateLpPreview();
      }, { passive: true });
      lpModalCanvas.addEventListener('touchend', () => { _lpDragging = false; _scheduleLpPreview(); });
    }
  }

  // The cached program belongs to the dead context after a WebGL context
  // loss; stitcher.js's restore handler calls this to drop it.
  function invalidateProgram() {
    planetTarget = null;
    _littlePlanetProg = null;
  }

  S360.lpModal = { init, invalidateProgram };
})(window.S360);
