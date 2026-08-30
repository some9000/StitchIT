// image.js
window.S360 = window.S360 || {};
(function (S360) {
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

  // Releases a decoded image held during stacked/HDR merges. Handles the
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
      const r = Math.min(img.width * 0.25, img.height * 0.5) * cfg.radiusScale * s;
      // Corresponding samples around the outer overlap annulus. Median channel
      // ratios reject scene changes, clipping and moving subjects far better than
      // comparing unrelated whole-hemisphere averages.
      const ratios = [[], [], []], costs = [];
      const sample = (x, y, c) => data[(Math.round(y) * sw + Math.round(x)) * 4 + c] / 255;
      for (let a = 0; a < 360; a += 2) {
        const t = a * Math.PI / 180;
        for (const rr of [0.78, 0.88, 0.95]) {
          const dx = Math.sin(t) * r * rr, dy = -Math.cos(t) * r * rr;
          // Opposing lenses see the overlap with horizontal direction reversed.
          const lx = cxL + dx, ly = cyL + dy, rx = cxR - dx, ry = cyR + dy;
          if (lx < 1 || lx >= sw - 1 || rx < 1 || rx >= sw - 1 || ly < 1 || ly >= sh - 1 || ry < 1 || ry >= sh - 1) continue;
          let cost = 0, valid = true;
          for (let c = 0; c < 3; c++) {
            const l = sample(lx, ly, c), rv = sample(rx, ry, c);
            if (l < 0.03 || l > 0.97 || rv < 0.03 || rv > 0.97) { valid = false; break; }
            ratios[c].push(l / rv); cost += Math.abs(l - rv);
          }
          if (valid) costs.push({ angle: t, cost });
        }
      }
      const median = values => {
        if (!values.length) return 1;
        values.sort((a, b) => a - b);
        return values[values.length >> 1];
      };
      const gain = ratios.map(v => Math.min(2, Math.max(0.5, median(v))));
      // Circularly smooth costs and choose the quietest seam longitude.
      let seamPhase = 0, best = Infinity;
      for (let a = 0; a < 360; a += 4) {
        const t = a * Math.PI / 180;
        let sum = 0, n = 0;
        for (const p of costs) {
          const d = Math.atan2(Math.sin(p.angle - t), Math.cos(p.angle - t));
          if (Math.abs(d) < 0.18) { sum += p.cost; n++; }
        }
        if (n && sum / n < best) { best = sum / n; seamPhase = t; }
      }
      return { gain, seamPhase };
    } catch (e) {
      console.warn('⚠️ gainR estimate failed:', e);
    }
    return { gain: [1, 1, 1], seamPhase: 0 };
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

  // Upscales an Image/Canvas by the given factor using a 3-lobe Lanczos kernel
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

    // Create source texture from input image
    const srcTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, img.width, img.height);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Intermediate texture for horizontal pass
    const intermediateTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, intermediateTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, img.height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const intermediateFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, intermediateFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, intermediateTex, 0);
    S360.assertFramebufferComplete(gl, 'Lanczos horizontal target');

    // Horizontal pass
    const lhProg = S360.getLanczosHProgram(gl);
    gl.useProgram(lhProg);
    gl.bindVertexArray(S360.getQuadVAO(gl));
    gl.viewport(0, 0, w, img.height);
    const uH = lhProg._u;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(uH.u_tex, 0);
    gl.uniform2f(uH.u_inputSize, img.width, img.height);
    gl.uniform2f(uH.u_outputSize, w, img.height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Final texture for vertical pass
    const finalTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, finalTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const finalFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, finalFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, finalTex, 0);
    S360.assertFramebufferComplete(gl, 'Lanczos vertical target');

    // Vertical pass
    const lvProg = S360.getLanczosVProgram(gl);
    gl.useProgram(lvProg);
    gl.bindVertexArray(S360.getQuadVAO(gl));
    gl.viewport(0, 0, w, h);
    const uV = lvProg._u;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, intermediateTex);
    gl.uniform1i(uV.u_tex, 0);
    gl.uniform2f(uV.u_inputSize, w, img.height);
    gl.uniform2f(uV.u_outputSize, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Read back in horizontal bands straight onto the canvas — bounded peak
    // memory (no full-size intermediate buffer), row order preserved exactly.
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    gl.bindFramebuffer(gl.FRAMEBUFFER, finalFbo);
    const BAND = 1024;
    for (let y = 0; y < h; y += BAND) {
      const bh = Math.min(BAND, h - y);
      const band = new Uint8Array(w * 4 * bh);
      gl.readPixels(0, y, w, bh, gl.RGBA, gl.UNSIGNED_BYTE, band);
      ctx.putImageData(new ImageData(new Uint8ClampedArray(band.buffer), w, bh), 0, y);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Cleanup
    gl.deleteTexture(srcTex);
    gl.deleteTexture(intermediateTex);
    gl.deleteFramebuffer(intermediateFbo);
    gl.deleteTexture(finalTex);
    gl.deleteFramebuffer(finalFbo);

    return canvas;
  };

  // Scale source image by the user-selected factor (1-2x). Applied to ALL modes
  // at load time — single, HDR, and merge. No further scaling happens downstream.
  // Uses a 3-lobe Lanczos kernel via WebGL for superior high-frequency preservation.
  S360.scaleSource = function (gl, img, scaleValue, MAX_TEX_SIZE) {
    return S360.scaleSourceLanczos(gl, img, scaleValue, MAX_TEX_SIZE);
  };
})(window.S360);
