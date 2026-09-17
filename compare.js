// Owns the optional stitched reference used by the synchronized split 3D view.
// init({ctx}) wires the Compare button/file input and retains a display-sized
// canvas so its GPU texture can be restored without keeping the full decode.
window.S360 = window.S360 || {};
(function (S360) {
'use strict';
  let ctx, button, input, container;
  let decoded = null, texture = null, active = false, job = 0;
  const MAX_REFERENCE_WIDTH = 4096;

  function prepareReference(image) {
    const gl = ctx.gl;
    const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const cssWidth = container?.clientWidth || 0;
    const displayCap = cssWidth
      ? Math.max(2048, Math.ceil(cssWidth * Math.max(1, window.devicePixelRatio || 1) * 4))
      : MAX_REFERENCE_WIDTH;
    const width = Math.max(1, Math.min(image.width, maxTexture, MAX_REFERENCE_WIDTH, displayCap));
    const height = Math.max(1, Math.round(image.height * width / image.width));
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const paint = canvas.getContext('2d', { alpha: false });
    if (!paint) throw new Error('Cannot prepare the comparison image.');
    paint.imageSmoothingEnabled = true;
    paint.imageSmoothingQuality = 'high';
    paint.drawImage(image, 0, 0, width, height);
    return canvas;
  }

  function updateUI() {
    if (!button || !container) return;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    container.classList.toggle('compare-active', active);
    S360.drawing?.syncViewSize?.();
  }

  function dropTexture() {
    if (texture) S360.deleteTrackedTexture(ctx.gl, texture);
    texture = null;
  }

  function upload() {
    dropTexture();
    if (!decoded || ctx.gl.isContextLost()) return;
    const gl = ctx.gl;
    S360.validateTextureSize(gl, decoded.width, decoded.height, 'Comparison image');
    let candidate = null;
    try {
      gl.activeTexture(gl.TEXTURE0);
      candidate = S360.createTrackedTexture(gl, {
        width: decoded.width, height: decoded.height, label: 'Comparison texture', bytesPerPixel: 4,
      }, () => {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, decoded.width, decoded.height);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, decoded);
      });
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(`Comparison upload failed on the GPU (${error}).`);
      texture = candidate;
    } catch (error) {
      if (candidate) S360.deleteTrackedTexture(gl, candidate);
      throw error;
    }
  }

  function close() {
    job++;
    active = false;
    dropTexture();
    S360.releaseImage(decoded); decoded = null;
    if (input) input.value = '';
    updateUI();
    if (ctx?.getViewMode() === '3d') S360.renderSphere(ctx);
  }

  async function load(file) {
    const id = ++job;
    button.disabled = true;
    let image = null;
    try {
      image = await S360.loadImageFromFile(file);
      if (id !== job) { S360.releaseImage(image); return; }
      const ratio = image.width / Math.max(1, image.height);
      if (ratio < 1.8 || ratio > 2.2) throw new Error('Comparison images must be stitched 2:1 panoramas.');
      const prepared = prepareReference(image);
      S360.releaseImage(image); image = null;
      dropTexture();
      S360.releaseImage(decoded);
      decoded = prepared;
      upload();
      active = true;
      updateUI();
      S360.setViewMode('3d', ctx);
      S360.renderSphere(ctx);
    } catch (error) {
      S360.releaseImage(image);
      S360.uiChrome.showToast(error?.message || String(error), { type: 'error' });
      if (!texture) {
        active = false;
        S360.releaseImage(decoded); decoded = null;
        updateUI();
      }
    } finally {
      if (id === job) button.disabled = false;
    }
  }

  function init(deps) {
    ctx = deps.ctx;
    button = document.getElementById('compareBtn');
    input = document.getElementById('compareReferenceLoader');
    container = document.getElementById('resultContainer');
    button.addEventListener('click', () => {
      if (active) close();
      else { input.value = ''; input.click(); }
    });
    input.addEventListener('change', () => { if (input.files?.[0]) load(input.files[0]); });
    ctx.panoramaCanvas.addEventListener('webglcontextlost', () => {
      S360.forgetTrackedTexture(texture);
      texture = null;
    });
    ctx.panoramaCanvas.addEventListener('webglcontextrestored', () => {
      if (!active || !decoded) return;
      try { upload(); S360.renderSphere(ctx); }
      catch (error) { close(); S360.uiChrome.showToast('Comparison could not be restored: ' + error.message, { type: 'error' }); }
    });
    updateUI();
  }

  S360.compare = { init, close, getTexture: () => active ? texture : null, get isActive() { return active; } };
})(window.S360);
