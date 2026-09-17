// image.js
window.S360 = window.S360 || {};
(function (S360) {
'use strict';
  S360.loadImageFromFile = function (file) {
    // Native, off-main-thread decode via createImageBitmap instead of
    // FileReader.readAsDataURL + HTMLImageElement. For large multi-frame merges
    // this (a) avoids the ~33% overhead of base64 data URLs, (b) keeps JPEG
    // decoding off the UI thread so the page stays responsive while stacking
    // many large images, and (c) works from a file:// URL because it takes the
    // Blob directly (no fetch/CORS). imageOrientation 'from-image' preserves
    // the EXIF-aware behaviour the old Image path had.
    if (typeof createImageBitmap !== 'function') {
      // Very old runtime: fall back to the original data-URL + Image path.
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = ev => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = ev.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }
    return createImageBitmap(file, {
      imageOrientation: 'from-image',
      premultiplyAlpha: 'none', // match canvas/texImage2D (non-premultiplied) handling
    });
  };

  // Releases a decoded image held during stack/exposure-fusion merges. Handles the
  // different resource types loadImageFromFile/scaleSource may return:
  //  - ImageBitmap -> .close() frees the decoded bitmap.
  //  - HTMLImageElement/Image -> clearing src drops the decoded bitmap.
  //  - canvas -> nothing to free; left for GC.
  S360.releaseImage = function (img) {
    if (!img) return;
    if (typeof img.close === 'function') {
      try { img.close(); } catch (e) {}
    } else if (img.src !== undefined) {
      img.src = '';
    }
  };

  S360.estimateGainR = function (img, cfg) {
    try {
      const sw = Math.min(img.width, 512);
      const sh = Math.max(1, Math.round(sw * (img.height / img.width)));
      const c = document.createElement('canvas');
      c.width = sw; c.height = sh;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, sw, sh);
      const data = ctx.getImageData(0, 0, sw, sh).data;
      const s = sw / img.width; // uniform scale (aspect preserved)
      const cxL = img.width * cfg.centers.left[0] * s;
      const cyL = img.height * cfg.centers.left[1] * s;
      const cxR = img.width * cfg.centers.right[0] * s;
      const cyR = img.height * cfg.centers.right[1] * s;
      // Sample along the overlap belt annulus (between the 180° ring and the
      // outer-margin edge), where both lenses see the same scene.
      const base = Math.min(img.width * 0.25, img.height * 0.5) * s;
      const rMatch = base * (cfg.radius / 100);
      const rOuter = base * (cfg.outerMargin / 100);
      const beltPx = rOuter - rMatch;
      // Corresponding samples around the outer overlap annulus. Median channel
      // ratios reject scene changes, clipping and moving subjects far better than
      // comparing unrelated whole-hemisphere averages.
      const ratios = [[], [], []];
      const sample = (x, y, c) => data[(Math.round(y) * sw + Math.round(x)) * 4 + c] / 255;
      for (let a = 0; a < 360; a += 2) {
        const t = a * Math.PI / 180;
        for (const frac of [0.25, 0.5, 0.75]) {
          const rr = rMatch + frac * beltPx;
          const dx = Math.sin(t) * rr, dy = -Math.cos(t) * rr;
          // Opposing lenses see the overlap with horizontal direction reversed.
          const lx = cxL + dx, ly = cyL + dy, rx = cxR - dx, ry = cyR + dy;
          if (lx < 1 || lx >= sw - 1 || rx < 1 || rx >= sw - 1 || ly < 1 || ly >= sh - 1 || ry < 1 || ry >= sh - 1) continue;
          // Drop a sample entirely when either side is near clipping — its
          // channel ratio would bias the medians below.
          for (let c = 0; c < 3; c++) {
            const l = sample(lx, ly, c), rv = sample(rx, ry, c);
            if (l < 0.03 || l > 0.97 || rv < 0.03 || rv > 0.97) break;
            ratios[c].push(l / rv);
          }
        }
      }
      const gain = ratios.map(v => {
        if (!v.length) return 1;
        v.sort((a, b) => a - b);
        const med = v[(v.length - 1) >> 1];
        const mad = v.reduce((s, x) => s + Math.abs(x - med), 0) / v.length;
        const lo = med - 3.5 * Math.max(mad, 0.02);
        const hi = med + 3.5 * Math.max(mad, 0.02);
        const inliers = v.filter(x => x >= lo && x <= hi);
        if (!inliers.length) return Math.min(2, Math.max(0.5, med));
        inliers.sort((a, b) => a - b);
        return Math.min(2, Math.max(0.5, inliers[(inliers.length - 1) >> 1]));
      });
      return { gain };
    } catch (e) {
      console.warn('⚠️ gainR estimate failed:', e);
    }
    return { gain: [1, 1, 1] };
  };

  S360.estimateGainRFromSource = function (gl, source, cfg) {
    if (source?.isGpuImage) {
      const proxy = S360.gpuImageToProxyCanvas(gl, source, 512);
      return S360.estimateGainR(proxy, cfg);
    }
    return S360.estimateGainR(source, cfg);
  };

  // Lanczos upscaling program cache (per gl)
  let _lanczosHProg = null;
  let _lanczosVProg = null;

  S360.getLanczosHProgram = function (gl) {
    if (!_lanczosHProg) {
      _lanczosHProg = S360.createProgram(gl, S360.LANCZOS_VS, S360.LANCZOS_H_FS);
      _lanczosHProg._u = {
        u_tex:        gl.getUniformLocation(_lanczosHProg, 'u_tex'),
        u_inputSize:  gl.getUniformLocation(_lanczosHProg, 'u_inputSize'),
        u_outputSize: gl.getUniformLocation(_lanczosHProg, 'u_outputSize'),
      };
    }
    return _lanczosHProg;
  };

  S360.getLanczosVProgram = function (gl) {
    if (!_lanczosVProg) {
      _lanczosVProg = S360.createProgram(gl, S360.LANCZOS_VS, S360.LANCZOS_V_FS);
      _lanczosVProg._u = {
        u_tex:        gl.getUniformLocation(_lanczosVProg, 'u_tex'),
        u_inputSize:  gl.getUniformLocation(_lanczosVProg, 'u_inputSize'),
        u_outputSize: gl.getUniformLocation(_lanczosVProg, 'u_outputSize'),
      };
    }
    return _lanczosVProg;
  };

  // Upscales an Image/Canvas by the given factor using a 4-lobe Lanczos kernel
  // implemented as a separable WebGL fragment shader. Returns a new Canvas with
  // the upscaled result. This preserves significantly more high-frequency detail
  // than Canvas 2D's bicubic (imageSmoothingQuality: 'high').
  S360.scaleSourceLanczos = function (gl, img, scaleValue, MAX_TEX_SIZE) {
    if (scaleValue <= 1) return img;

    S360.validateTextureSize(gl, img.width, img.height, 'Source image');

    const factor = Math.min(scaleValue, MAX_TEX_SIZE / img.width, MAX_TEX_SIZE / img.height);
    const w = Math.round(img.width * factor);
    const h = Math.round(img.height * factor);
    S360.validateTextureSize(gl, w, h, 'Scaled image');

    let srcTex = null, horizontal = null, vertical = null;
    try {
      // UNPACK_FLIP_Y = false ON PURPOSE: the image's first (top) row is stored
      // at texture v = 0. Every consumer that works in image-pixel space (the
      // lens math / workers, y = 0 at image top) must convert via
      // sampleSource's 1 - y/H in shaders.js — that pair of inversions is what
      // keeps panos upright (see the comment there and orientation-selftest.js).
      // The watermark upload uses the OPPOSITE setting for its own reasons.
      srcTex = S360.createTrackedTexture(gl, {
        width: img.width, height: img.height, label: 'Lanczos source texture', bytesPerPixel: 4,
      }, () => {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, img.width, img.height);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, img);
      });
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      horizontal = S360.createRenderTarget(gl, w, img.height, 'Lanczos horizontal');

      // Horizontal pass: src -> horizontal.
      const lhProg = S360.getLanczosHProgram(gl);
      gl.useProgram(lhProg);
      gl.bindFramebuffer(gl.FRAMEBUFFER, horizontal.fbo);
      gl.bindVertexArray(S360.getQuadVAO(gl));
      gl.viewport(0, 0, w, img.height);
      const uH = lhProg._u;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(uH.u_tex, 0);
      gl.uniform2f(uH.u_inputSize, img.width, img.height);
      gl.uniform2f(uH.u_outputSize, w, img.height);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // The horizontal target contains everything the second pass needs. Drop
      // the uploaded input before reserving the much larger final target so HD
      // scaling never retains all three textures at once.
      S360.deleteTrackedTexture(gl, srcTex);
      srcTex = null;
      vertical = S360.createRenderTarget(gl, w, h, 'Lanczos vertical');

      // Vertical pass: horizontal -> vertical.
      const lvProg = S360.getLanczosVProgram(gl);
      gl.useProgram(lvProg);
      gl.bindFramebuffer(gl.FRAMEBUFFER, vertical.fbo);
      gl.bindVertexArray(S360.getQuadVAO(gl));
      gl.viewport(0, 0, w, h);
      const uV = lvProg._u;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, horizontal.tex);
      gl.uniform1i(uV.u_tex, 0);
      gl.uniform2f(uV.u_inputSize, w, img.height);
      gl.uniform2f(uV.u_outputSize, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Readback consumes only the vertical result.
      horizontal.dispose();
      horizontal = null;

      // Read back in horizontal bands straight onto the canvas — bounded peak
      // memory (no full-size intermediate buffer), row order preserved exactly
      // (the source was uploaded with UNPACK_FLIP_Y = false, see above).
      return S360.readFboToCanvas(gl, vertical.fbo, w, h, 1024, false);
    } finally {
      // Explicitly owned: every intermediate is released even when a later
      // allocation or GL call fails mid-pipeline.
      if (srcTex) S360.deleteTrackedTexture(gl, srcTex);
      horizontal?.dispose();
      vertical?.dispose();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  };

  // Resize a decoded source when explicitly requested, or clamp it to the GPU's
  // texture limit. HD enlarges each decoded input before registration and fusion.
  S360.scaleSource = function (gl, img, scaleValue, MAX_TEX_SIZE) {
    const longest = Math.max(img.width, img.height);
    if (longest > MAX_TEX_SIZE) {
      const canvas = document.createElement('canvas');
      const factor = MAX_TEX_SIZE / longest;
      canvas.width = Math.max(1, Math.floor(img.width * factor));
      canvas.height = Math.max(1, Math.floor(img.height * factor));
      const paint = canvas.getContext('2d');
      if (!paint) throw new Error('Cannot prepare a GPU-sized source image.');
      paint.imageSmoothingEnabled = true;
      paint.imageSmoothingQuality = 'high';
      paint.drawImage(img, 0, 0, canvas.width, canvas.height);
      S360.uiChrome?.appendConsoleLine?.(
        `source resized to GPU limit (${canvas.width}x${canvas.height}); Lanczos HD unavailable`,
        'warn'
      );
      return canvas;
    }
    return S360.scaleSourceLanczos(gl, img, scaleValue, MAX_TEX_SIZE);
  };

  S360.invalidateLanczosPrograms = function () { _lanczosHProg = null; _lanczosVProg = null; };
})(window.S360);
