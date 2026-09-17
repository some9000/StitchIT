// Explicit ownership for tracked textures and render targets. Allocations reserve
// budget before touching the driver; callers transfer or dispose each texture once.
window.S360 = window.S360 || {};
(function (S360) {
'use strict';
  const textureMemory = new WeakMap();

  function bytesFor(width, height, depth, bytesPerPixel) {
    return Math.max(1, width) * Math.max(1, height) * Math.max(1, depth) * bytesPerPixel;
  }

  function reserve(gl, bytes, label) {
    const memory = S360.gpuMem;
    if (!memory || memory.budget() <= 0 || memory.shed(gl, bytes)) return;
    const need = (bytes / 1048576).toFixed(1);
    const free = (memory.headroom() / 1048576).toFixed(1);
    throw new Error(`${label} needs ${need} MiB of GPU memory, but only ${free} MiB is safely available.`);
  }

  S360.createTrackedTexture = function (gl, options, allocate) {
    const target = options.target || gl.TEXTURE_2D;
    const width = options.width, height = options.height, depth = options.depth || 1;
    const label = options.label || 'Texture', bytes = bytesFor(width, height, depth, options.bytesPerPixel || 4);
    S360.validateTextureSize(gl, width, height, label);
    reserve(gl, bytes, label);
    const tex = gl.createTexture();
    if (!tex) throw new Error(`Cannot allocate ${label}.`);
    const memId = Symbol(label);
    try {
      gl.bindTexture(target, tex);
      allocate(tex, target);
      const error = typeof gl.getError === 'function' ? gl.getError() : gl.NO_ERROR;
      if (gl.isContextLost?.() || (typeof gl.NO_ERROR === 'number' && error !== gl.NO_ERROR)) {
        throw new Error(`${label} allocation failed on the GPU (${error}).`);
      }
      textureMemory.set(tex, { memId, bytes, label });
      S360.gpuMem?.track(memId, bytes, label);
      tex.width = width; tex.height = height;
      return tex;
    } catch (error) {
      gl.deleteTexture(tex);
      S360.gpuMem?.untrack(memId);
      throw error;
    }
  };

  S360.trackedTextureBytes = function (tex) {
    return textureMemory.get(tex)?.bytes || 0;
  };

  S360.relabelTrackedTexture = function (tex, label) {
    const entry = textureMemory.get(tex);
    if (!entry) return;
    entry.label = label;
    S360.gpuMem?.track(entry.memId, entry.bytes, label);
  };

  S360.forgetTrackedTexture = function (tex) {
    const entry = textureMemory.get(tex);
    if (!entry) return;
    S360.gpuMem?.untrack(entry.memId);
    textureMemory.delete(tex);
  };

  S360.deleteTrackedTexture = function (gl, tex) {
    if (!tex) return;
    S360.forgetTrackedTexture(tex);
    if (!gl.isContextLost?.()) gl.deleteTexture(tex);
  };

  S360.createRenderTarget = function (gl, width, height, label, wrap = gl.CLAMP_TO_EDGE, options = {}) {
    let tex = null, fbo = null;
    const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    function dispose() {
      if (tex) S360.deleteTrackedTexture(gl, tex);
      if (fbo) gl.deleteFramebuffer(fbo);
      tex = fbo = null;
    }
    function take() {
      if (!tex) throw new Error(`${label} texture ownership has already been transferred.`);
      const taken = { texture: tex, framebuffer: fbo };
      tex = fbo = null;
      return taken;
    }
    function takeTexture() {
      const taken = take();
      if (taken.framebuffer) gl.deleteFramebuffer(taken.framebuffer);
      return taken.texture;
    }
    try {
      const internalFormat = options.internalFormat || gl.RGBA8;
      const filter = options.filter || gl.LINEAR;
      tex = S360.createTrackedTexture(gl, { width, height, label, bytesPerPixel: options.bytesPerPixel || 4 }, () => {
        gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, width, height);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      });
      fbo = gl.createFramebuffer();
      if (!fbo) throw new Error(`Cannot allocate ${label} framebuffer.`);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      S360.assertFramebufferComplete(gl, label);
      return { tex, fbo, width, height, dispose, take, takeTexture };
    } catch (error) { dispose(); throw error; }
    finally { gl.bindFramebuffer(gl.FRAMEBUFFER, previous); }
  };
})(window.S360);
