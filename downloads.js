// downloads.js — main panorama export buttons (PNG / JPG)
// ============================================================================
// This module owns:
//   - the toolbar's Export PNG / Export JPG buttons and their full-resolution
//     export flows (VRAM shed -> offscreen render -> blob -> download)
//   - triggerDownload, the shared blob-download helper — exposed on the
//     module as S360.downloads.triggerDownload because stitch-ui.js's profile
//     export and lp-modal.js use it too
//
// Injected at init(): ctx (app accessors: gl, panoramaCanvas, getCurrentImg,
// getLastBaseName, renderPano), renderOffscreenPixels (core renderer), and
// shedNonEssentials() (VRAM-shed hook with gl already bound).
// renderFullAndExport / injectXMPMetadata come from exporter.js via the S360
// namespace directly.
//
// Classic-script build: plain <script> tag before stitcher.js (file://-safe).
// ============================================================================
window.S360 = window.S360 || {};
(function (S360) {
'use strict';
  const { renderFullAndExport, injectXMPMetadata } = S360;

  // ---- injected at init() ----------------------------------------------------
  let ctx = null;
  let renderOffscreenPixels = null;
  let streamOffscreenPixels = null;
  let shedNonEssentials = null;

  // ---- DOM refs --------------------------------------------------------------
  let downloadBtn = null;
  let downloadJpgBtn = null;

  // ---- shared blob-download helper -------------------------------------------
  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.body.appendChild(document.createElement('a'));
    a.href = url;
    a.download = filename;
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // ---- export flows ----------------------------------------------------------
  // Shared panorama export: VRAM shed -> offscreen render -> blob -> download.
  async function exportPanorama(mime, quality, injectXMP, ext) {
    try {
      if (downloadBtn) downloadBtn.disabled = true;
      if (downloadJpgBtn) downloadJpgBtn.disabled = true;
      await S360.drawing.flush();
      shedNonEssentials();
      let blob;
      if (mime === 'image/png' && streamOffscreenPixels && typeof CompressionStream !== 'undefined') {
        const fullW = Math.round(ctx.getCurrentImg().width);
        const { w, h } = S360.clampToGpuLimits(ctx.gl, fullW, Math.round(fullW / 2));
        const png = await streamOffscreenPixels(w, h);
        blob = await png.finish();
      } else {
        const { blob: b } = await renderFullAndExport(ctx.gl, ctx.panoramaCanvas, ctx.getCurrentImg(), renderOffscreenPixels, injectXMPMetadata, mime, quality, injectXMP);
        blob = b;
      }
      triggerDownload(blob, `${ctx.getLastBaseName()}-stitched.${ext}`);
    } catch (err) {
      console.error(err);
      S360.uiChrome.showToast('Export failed: ' + (err?.message || err), { type: 'error' });
    } finally {
      if (downloadBtn) downloadBtn.disabled = false;
      if (downloadJpgBtn) downloadJpgBtn.disabled = false;
      ctx.renderPano();
    }
  }

  function onDownloadPng() { return exportPanorama('image/png', 0.92, false, 'png'); }
  function onDownloadJpg() { return exportPanorama('image/jpeg', 0.95, true, 'jpg'); }

  // ---- init: capture deps, fetch DOM, wire the buttons -----------------------
  function init(deps) {
    ctx = deps.ctx;
    renderOffscreenPixels = deps.renderOffscreenPixels;
    streamOffscreenPixels = deps.streamOffscreenPixels;
    shedNonEssentials = deps.shedNonEssentials;
    downloadBtn = document.getElementById('downloadBtn');
    downloadJpgBtn = document.getElementById('downloadJpgBtn');
    if (downloadBtn) downloadBtn.addEventListener('click', onDownloadPng, false);
    if (downloadJpgBtn) downloadJpgBtn.addEventListener('click', onDownloadJpg, false);
  }

  S360.downloads = { init, triggerDownload };
})(window.S360);
