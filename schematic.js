// schematic.js — lens schematic preview + white-balance eyedropper
// ============================================================================
// This module owns:
//   - the lens schematic thumbnail (canvas under Lens Geometry) and its
//     click-to-zoom large overlay (module-private overlay target)
//   - the Schematic toggle button and the crosshair cursor mode
//   - the white-balance eyedropper (Sample button + panorama click sampling)
//   - WB_LUT, the precomputed Kelvin lookup table
//   - the decoded schematic background reference (setSchematicBg/releaseSchematicBg)
//
// STATE SPLIT: schematicMode / schematicGuideX/Y / wbSampling STAY in
// stitcher.js because the core pipeline reads them directly (post-pass guard,
// stitchWebGL uniforms, uploadTexture reset) — this module reaches them via
// the ctx accessors. The background-cache canvases are module-private.
//
// Injected at init(): ctx (app accessors), markStitchDirty, and
// readWbSampleAt(nx, ny) — the GL pixel read stays in stitcher.js because it
// needs gl / framebuffer / renderTexture.
//
// Classic-script build: plain <script> tag before stitcher.js (file://-safe).
// ============================================================================
window.S360 = window.S360 || {};
(function (S360) {
'use strict';

  // ---- injected at init() ----------------------------------------------------
  let ctx = null;
  let markStitchDirty = null;
  let readWbSampleAt = null;

  // ---- DOM refs --------------------------------------------------------------
  let schematicBtn = null;
  let pickGrayBtn = null;
  let lensSchematicCanvas = null;
  let panoramaCanvas = null;
  let tempSlider = null;
  let tempVal = null;

  // ---- module-private state --------------------------------------------------
  let schematicBg = null;           // decoded reference frame for the background
  let schematicBgCache = null;      // offscreen canvas with static background + grid
  let schematicBgCacheValid = false;
  let schematicOverlayTarget = null; // large click-to-zoom overlay, when open

  // Precomputed white-balance lookup table (Helland approximation).
  // Matches the UI slider step of 50 K over 2000..12000.
  const WB_LUT = (() => {
    const lut = [];
    for (let k = 2000; k <= 12000; k += 50) {
      const t = k / 100.0;
      let wr, wg, wb;
      if (t <= 66.0) {
        wr = 255.0;
        wg = 99.4708025861 * Math.log(t) - 161.1195681661;
      } else {
        wr = 329.698727446 * Math.pow(t - 60.0, -0.1332047592);
        wg = 288.1221695283 * Math.pow(t - 60.0, -0.0755148492);
      }
      if (t >= 66.0) wb = 255.0;
      else if (t <= 19.0) wb = 0.0;
      else wb = 138.5177312231 * Math.log(t - 10.0) - 305.0447927307;
      lut.push({ k, wr: Math.max(wr, 1e-3), wg: Math.max(wg, 1e-3), wb: Math.max(wb, 1e-3) });
    }
    return lut;
  })();

  // ---- cursor (state reads via ctx) ------------------------------------------
  function updateCanvasCursor() {
    if (!panoramaCanvas) return;
    if (ctx.getWbSampling()) {
      panoramaCanvas.style.cursor = 'crosshair';
    } else if (ctx.getViewMode() === '3d') {
      panoramaCanvas.style.cursor = 'grab';
    } else if (ctx.getSchematicMode()) {
      panoramaCanvas.style.cursor = 'crosshair';
    } else {
      panoramaCanvas.style.cursor = '';
    }
  }

  // ---- white balance (state/UI reads via ctx) --------------------------------
  function setWbSampling(on) {
    ctx.setWbSampling(on);
    if (pickGrayBtn) pickGrayBtn.classList.toggle('active', on);
    updateCanvasCursor();
  }

  // Apply a white-balance temperature from a sampled pixel-average buffer.
  function applyWbFromSample(buf) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < buf.length; i += 4) {
      r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; n++;
    }
    r /= n; g /= n; b /= n;
    if (g <= 0) return;

    // Neutralise: solve for the Kelvin whose white point has the same r:g:b ratio
    // as the sampled cast. We search the precomputed LUT for the best match.
    let bestK = 6500, bestErr = Infinity;
    for (let i = 0; i < WB_LUT.length; i++) {
      const { wr, wg, wb } = WB_LUT[i];
      const err = Math.abs(r / g - wr / wg) + Math.abs(b / g - wb / wg);
      if (err < bestErr) { bestErr = err; bestK = WB_LUT[i].k; }
    }

    ctx.postUniforms.temperature = bestK;
    if (tempSlider) tempSlider.value = bestK;
    if (tempVal) tempVal.textContent = String(Math.round(bestK));
    S360.settings.scheduleLiveSave(ctx);
    if (ctx.getCurrentImg()) ctx.renderPano();
  }

  // ---- schematic background reference + cache --------------------------------
  function releaseSchematicBg() {
    if (schematicBg && typeof schematicBg.close === 'function') {
      try { schematicBg.close(); } catch (_) {}
    }
    schematicBg = null;
    invalidateSchematicBgCache();
  }

  // Adopts a decoded reference frame; ownership transfers to this module.
  function setSchematicBg(img) {
    releaseSchematicBg();
    schematicBg = img;
  }

  function invalidateSchematicBgCache() {
    schematicBgCacheValid = false;
    if (schematicBgCache) {
      const c = schematicBgCache;
      schematicBgCache = null;
      c.width = 0; c.height = 0;
    }
  }

  function buildSchematicBgCache(W, H) {
    const cache = document.createElement('canvas');
    cache.width = W; cache.height = H;
    const ctx2d = cache.getContext('2d');
    ctx2d.fillStyle = '#000';
    ctx2d.fillRect(0, 0, W, H);

    const img = ctx.getCurrentImg();
    const bgImg = (img && img.width > 0 && img.height > 0 && !img.isGpuImage)
      ? img : schematicBg;
    if (bgImg && bgImg.width > 0 && bgImg.height > 0) {
      const srcAspect = bgImg.width / bgImg.height;
      const cvsAspect = W / H;
      let dw, dh, dx, dy;
      if (srcAspect > cvsAspect) { dw = W; dh = W / srcAspect; dx = 0; dy = (H - dh) / 2; }
      else { dh = H; dw = H * srcAspect; dx = (W - dw) / 2; dy = 0; }
      ctx2d.drawImage(bgImg, dx, dy, dw, dh);
    }

    // Grid lines at 0.25 and 0.75 (static).
    ctx2d.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx2d.lineWidth = 1;
    ctx2d.setLineDash([4, 4]);
    ctx2d.beginPath();
    ctx2d.moveTo(W * 0.25, 0); ctx2d.lineTo(W * 0.25, H);
    ctx2d.moveTo(W * 0.75, 0); ctx2d.lineTo(W * 0.75, H);
    ctx2d.stroke();
    ctx2d.setLineDash([]);

    schematicBgCache = cache;
    schematicBgCacheValid = true;
  }

  function drawLensSchematic(target) {
    const c = target ? target.canvas : lensSchematicCanvas;
    if (!c) return;
    const ctx2d = target ? target.ctx : c.getContext('2d');
    const W = c.width, H = c.height;
    const cfg = ctx.getCfg();

    if (!schematicBgCacheValid || !schematicBgCache || schematicBgCache.width !== W || schematicBgCache.height !== H) {
      buildSchematicBgCache(W, H);
    }

    ctx2d.clearRect(0, 0, W, H);
    if (schematicBgCache) ctx2d.drawImage(schematicBgCache, 0, 0);

    // Source-image geometry (normalised 0-1).
    const cxL = cfg.centers.left[0],  cyL = cfg.centers.left[1];
    const cxR = cfg.centers.right[0], cyR = cfg.centers.right[1];
    // Pixel radii: 100% == image height == 0.25 * canvas width for a 2:1 source.
    const rMatchPx = (cfg.radius / 100) * 0.25 * W;                            // 180° ring (orange)
    const rOuterPx = Math.max(rMatchPx, (cfg.outerMargin / 100) * 0.25 * W);   // outer edge (blue)

    // Nominal full-overlap guide; each lens sees opposite radial positions.
    const beltPx = Math.max(2 * (rOuterPx - rMatchPx), 0);
    const innerPx = 2 * rMatchPx - rOuterPx;
    const band = S360.seamBand(cfg, 0.5);
    const clip = v => Math.max(0, Math.min(1, v));

    const sx = W, sy = H;
    // Scale strokes for the widget size (thumbnail=1, overlay scaled to ~¼).
    // The full-size overlay sits on the same geometry but at a much larger
    // pixel size, so halve its stroke weight for a cleaner, thinner line.
    const lw = (1 + (W / 280 - 1) * 0.15) * (target ? 0.5 : 1);
    const toX = nx => nx * sx;
    const toY = ny => (1 - ny) * sy;

    function drawLens(cx, cy, width, height, angle, right = false) {
      const loPx = innerPx + clip(right ? 1 - band.hi : band.lo) * beltPx;
      const hiPx = innerPx + clip(right ? 1 - band.lo : band.hi) * beltPx;
      const centerPx = innerPx + clip(right ? 1 - band.center : band.center) * beltPx;
      const cxPx = toX(cx);
      const cyPx = toY(cy);
      const angleRad = angle * Math.PI / 180;

      // Outer-margin circle (blue).
      ctx2d.strokeStyle = '#3b82f6';
      ctx2d.lineWidth = 2 * lw;
      ctx2d.beginPath();
      ctx2d.arc(cxPx, cyPx, rOuterPx, 0, Math.PI * 2);
      ctx2d.stroke();

      // 180° meeting ring (orange) — ellipse scaled by width factor.
      ctx2d.strokeStyle = '#f59e0b';
      ctx2d.lineWidth = 2 * lw;
      ctx2d.beginPath();
      ctx2d.ellipse(cxPx, cyPx, rMatchPx * width, rMatchPx * height, angleRad, 0, Math.PI * 2);
      ctx2d.stroke();

      // Green seam band (25% opacity) between its belt edges.
      if (hiPx > loPx + 0.5) {
        ctx2d.fillStyle = 'rgba(34, 197, 94, 0.25)';
        ctx2d.beginPath();
        ctx2d.ellipse(cxPx, cyPx, hiPx * width, hiPx * height, angleRad, 0, Math.PI * 2);
        ctx2d.ellipse(cxPx, cyPx, loPx * width, loPx * height, angleRad, 0, Math.PI * 2, true);
        ctx2d.fill();
      }

      // Green seam centerline (scales with the seam-width position to show shift).
      ctx2d.strokeStyle = '#22c55e';
      ctx2d.lineWidth = 2 * lw;
      ctx2d.setLineDash([3 * lw, 3 * lw]);
      ctx2d.beginPath();
      ctx2d.ellipse(cxPx, cyPx, centerPx * width, centerPx * height, angleRad, 0, Math.PI * 2);
      ctx2d.stroke();
      ctx2d.setLineDash([]);

      // Grey center lines rotated by angle.
      ctx2d.strokeStyle = 'rgba(255, 255, 255, 0.4)';
      ctx2d.lineWidth = 1 * lw;
      ctx2d.setLineDash([2 * lw, 2 * lw]);
      ctx2d.beginPath();
      // Horizontal line through center, rotated by angle
      const lineLen = rOuterPx * 1.1;
      const dx = Math.cos(angleRad) * lineLen;
      const dy = Math.sin(angleRad) * lineLen;
      ctx2d.moveTo(cxPx - dx, cyPx - dy);
      ctx2d.lineTo(cxPx + dx, cyPx + dy);
      // Perpendicular line
      const dx2 = Math.cos(angleRad + Math.PI / 2) * lineLen;
      const dy2 = Math.sin(angleRad + Math.PI / 2) * lineLen;
      ctx2d.moveTo(cxPx - dx2, cyPx - dy2);
      ctx2d.lineTo(cxPx + dx2, cyPx + dy2);
      ctx2d.stroke();
      ctx2d.setLineDash([]);
    }

    drawLens(cxL, cyL, 1 - cfg.width.left / 100, 1 - (cfg.height?.left ?? 0) / 100, cfg.angle.left);
    drawLens(cxR, cyR, 1 - cfg.width.right / 100, 1 - (cfg.height?.right ?? 0) / 100, cfg.angle.right, true);

    // Also render to the overlay if it's open (live updates when sliders change).
    // Only recurse from the thumbnail draw, not from the overlay draw itself.
    if (!target && schematicOverlayTarget) drawLensSchematic(schematicOverlayTarget);
  }

  // ---- init: capture deps, fetch DOM, wire the listeners ----------------------
  // Called by stitcher.js during DOMContentLoaded; replaces the wiring that
  // used to live inside stitcher.js's initControlListeners().
  function init(deps) {
    ctx = deps.ctx;
    markStitchDirty = deps.markStitchDirty;
    readWbSampleAt = deps.readWbSampleAt;
    schematicBtn = document.getElementById('schematicBtn');
    pickGrayBtn = document.getElementById('pickGrayBtn');
    lensSchematicCanvas = document.getElementById('lensSchematicCanvas');
    panoramaCanvas = document.getElementById('panoramaCanvas');
    tempSlider = document.getElementById('temperature');
    tempVal = document.getElementById('temperatureVal');

    // "Sample": enter a picking mode, then the user clicks any point of the
    // stitched (pre-post) panorama.
    if (pickGrayBtn) {
      pickGrayBtn.addEventListener('click', () => {
        if (!ctx.getCurrentImg()) { S360.uiChrome.showToast('Please load an image first.', { type: 'warning' }); return; }
        if (ctx.getWbSampling()) { setWbSampling(false); return; }
        setWbSampling(true);
      });
    }

    // Map a canvas click to the stitched FBO or the spherical camera ray and
    // white-balance from that spot (the GL pixel read is injected).
    panoramaCanvas.addEventListener('click', (e) => {
      if (!ctx.getCurrentImg()) return;

      if (!ctx.getWbSampling()) return;
      setWbSampling(false);

      // Normalised click position across the displayed (2:1 equirect) canvas.
      const rect = panoramaCanvas.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width;
      const ny = (e.clientY - rect.top) / rect.height;

      const sample = readWbSampleAt(nx, ny);
      if (!sample) {
        S360.uiChrome.showToast('Choose a point on the current panorama half.', { type: 'warning' });
        return;
      }
      applyWbFromSample(sample);
    });

    // Schematic overlay toggle.
    if (schematicBtn) {
      schematicBtn.addEventListener('click', () => {
        ctx.setSchematicMode(!ctx.getSchematicMode());
        schematicBtn.classList.toggle('active', ctx.getSchematicMode());
        schematicBtn.setAttribute('aria-pressed', String(ctx.getSchematicMode()));
        updateCanvasCursor();
        if (ctx.getCurrentImg()) {
          markStitchDirty();
          if (ctx.getSchematicMode() && ctx.getViewMode() === '3d') {
            S360.setViewMode('2d', ctx);
          } else {
            ctx.renderPano();
          }
        }
      });
    }

    // Clicking the lens schematic canvas toggles the large overlay.
    if (lensSchematicCanvas) {
      lensSchematicCanvas.style.cursor = 'zoom-in';
      lensSchematicCanvas.addEventListener('click', () => {
        const existing = document.getElementById('schematicOverlay');
        if (existing) {
          schematicOverlayTarget = null;
          existing.remove();
          return;
        }
        const container = document.getElementById('resultContainer') || document.body;
        const overlay = document.createElement('div');
        overlay.id = 'schematicOverlay';
        // Style like the viewport content: sits inside the container, black bg.
        overlay.style.cssText = 'position:absolute;inset:0;z-index:100;background:#000;display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
        const bigCanvas = document.createElement('canvas');
        // Fill container width like panoramaCanvas does.
        bigCanvas.style.cssText = 'max-width:100%;height:auto;display:block;';
        const srcAspect = lensSchematicCanvas.width / lensSchematicCanvas.height;
        // Set internal resolution from container width × devicePixelRatio.
        const containerW = container.clientWidth || 800;
        const dpr = window.devicePixelRatio || 1;
        bigCanvas.width = Math.round(containerW * dpr);
        bigCanvas.height = Math.round(containerW / srcAspect * dpr);
        bigCanvas.style.width = containerW + 'px';
        bigCanvas.style.height = Math.round(containerW / srcAspect) + 'px';
        overlay.appendChild(bigCanvas);
        // Store reference so drawLensSchematic can update it live.
        const bCtx = bigCanvas.getContext('2d');
        schematicOverlayTarget = { canvas: bigCanvas, ctx: bCtx };
        drawLensSchematic(schematicOverlayTarget);
        overlay.addEventListener('click', () => {
          schematicOverlayTarget = null;
          overlay.remove();
        });
        container.appendChild(overlay);
      });
    }
  }

  S360.schematic = { init, drawLensSchematic, setSchematicBg, releaseSchematicBg, invalidateSchematicBgCache, updateCanvasCursor };
})(window.S360);
