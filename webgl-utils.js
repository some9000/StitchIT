// webgl-utils.js

// console.warn is a Chromium/Firefox extension, not part of the Web Console
// spec. Calling it on a runtime that lacks it would throw from inside error
// paths and mask the original failure, so alias log when it is missing.
// Console methods are writable in practice; if the assignment is refused,
// console.log is almost certainly unusable there as well.
if (typeof console.warn !== 'function') {
  try { console.warn = console.log; } catch (_) {}
}

window.S360 = window.S360 || {};
(function (S360) {
'use strict';

  // Canonical fullscreen-quad vertex shader shared by every full-screen pass
  // (stitch, post, blur, fusion, warp, decals, little planet). This module
  // loads before every consumer, so modules may reference S360.QUAD_VS at
  // definition time; do not copy this source into per-module constants.
  S360.QUAD_VS = `#version 300 es
    layout(location = 0) in vec2 a_position;
    out vec2 v_uv;
    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }`;

  // Diagnostic logging gate: normal runs stay silent. Enable with ?debug in
  // the URL or by setting S360.debug = true from the console. Guarded with
  // typeof so stub environments without a location stay safe.
  S360.debug = (typeof location !== 'undefined' && /[?&]debug(?=&|$)/.test(location.search));
  S360.debugLog = function () {
    if (S360.debug) console.log.apply(console, arguments);
  };

  S360.createProgram = function (gl, vsSource, fsSource) {
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, vsSource);
      gl.compileShader(vs);
      if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
          const log = gl.getShaderInfoLog(vs);
          console.error('❌ Vertex shader compile error:', log);
          console.error('Shader source:', vsSource);
          throw new Error('Vertex shader compile failed: ' + log);
      }

      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, fsSource);
      gl.compileShader(fs);
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
          const log = gl.getShaderInfoLog(fs);
          console.error('❌ Fragment shader compile error:', log);
          console.error('Shader source:', fsSource);
          throw new Error('Fragment shader compile failed: ' + log);
      }

      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
          const log = gl.getProgramInfoLog(prog);
          console.error('❌ Shader program link error:', log);
          throw new Error('Shader program link failed: ' + log);
      }
      // Shaders can be deleted after linking — frees GPU memory immediately.
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return prog;
  };

  // VAO for the fullscreen quad — core in WebGL2, avoids re-binding every draw.
  let _quadVAO = null;
  S360.getQuadVAO = function (gl) {
      if (!_quadVAO) {
          _quadVAO = gl.createVertexArray();
          gl.bindVertexArray(_quadVAO);
          const buf = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
              -1,-1,  1,-1, -1,1,
              -1,1,   1,-1,  1,1
          ]), gl.STATIC_DRAW);
          // Location 0 for a_position (matches shader layout if specified, otherwise bound via attrib location)
          gl.enableVertexAttribArray(0);
          gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
          gl.bindVertexArray(null);
      }
      return _quadVAO;
  };

  // Drops the cached fullscreen-quad VAO. Must be called when the WebGL context
  // is lost/restored: the VAO belongs to the old (dead) context, and because it
  // lives in this module's closure, an outside `_quadVAO = null` assignment can
  // NOT clear it — the stale VAO would silently break every draw afterwards.
  S360.invalidateSharedVAO = function () {
      _quadVAO = null;
  };

  S360.validateTextureSize = function (gl, w, h, label = 'Texture') {
      if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
          throw new Error(`${label} has invalid dimensions ${w}x${h}.`);
      }
      const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      if (w > maxTex || h > maxTex) {
          throw new Error(`${label} ${w}x${h} exceeds this GPU's ${maxTex}px texture limit.`);
      }
  };

  S360.assertFramebufferComplete = function (gl, label = 'Framebuffer') {
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error(`${label} is incomplete (WebGL status 0x${status.toString(16)}).`);
      }
  };

  // Rodrigues rotation and the other shared lens-geometry helpers live in
  // geometry.js (the canonical geometry module, also loadable by workers).

  // Owned GPU image passed between processing stages without readback/re-upload.
  // Ownership can be transferred exactly once to the application source texture.
  S360.createGpuImage = function (gl, texture, framebuffer, width, height, options = {}) {
      let owned = true;
      texture.width = width; texture.height = height;
      return {
          isGpuImage: true, texture, framebuffer, width, height,
          get consumed() { return !owned; },
          orientation: options.orientation || 'fbo',
          takeTexture() {
              if (!owned) throw new Error('GPU image ownership has already been transferred.');
              owned = false;
              const tex = texture;
              if (framebuffer) gl.deleteFramebuffer(framebuffer);
              framebuffer = null;
              this.texture = null; this.framebuffer = null;
              return tex;
          },
           dispose() {
               if (!owned) return;
               owned = false;
               if (texture) {
                   if (S360.deleteTrackedTexture) S360.deleteTrackedTexture(gl, texture);
                   else gl.deleteTexture(texture);
               }
               if (framebuffer) gl.deleteFramebuffer(framebuffer);
              texture = null; framebuffer = null;
              this.texture = null; this.framebuffer = null;
          }
      };
  };

  let _proxyCopyProgram = null;
  S360.invalidateGpuImagePrograms = function () { _proxyCopyProgram = null; };
  S360.gpuImageToProxyCanvas = function (gl, gpuImage, maxWidth = 512) {
      if (!gpuImage?.isGpuImage || !gpuImage.texture) throw new Error('A live GPU image is required.');
      const w = Math.min(maxWidth, gpuImage.width);
      const h = Math.max(1, Math.round(gpuImage.height * w / gpuImage.width));
      let tex = null, fbo = null;
      try {
          tex = S360.createTrackedTexture(gl, {
              width: w, height: h, label: 'GPU proxy target', bytesPerPixel: 4,
          }, () => gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h));
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          fbo = gl.createFramebuffer();
          if (!fbo) throw new Error('Cannot allocate GPU proxy framebuffer.');
          gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
          S360.assertFramebufferComplete(gl, 'GPU proxy target');
          if (!_proxyCopyProgram) {
              _proxyCopyProgram = S360.createProgram(gl,
                S360.QUAD_VS,
                `#version 300 es\nprecision highp float; in vec2 v_uv; out vec4 o; uniform sampler2D u_tex; void main(){o=texture(u_tex,v_uv);}`);
              _proxyCopyProgram._u = gl.getUniformLocation(_proxyCopyProgram, 'u_tex');
          }
          gl.useProgram(_proxyCopyProgram); gl.bindVertexArray(S360.getQuadVAO(gl));
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, gpuImage.texture);
          gl.uniform1i(_proxyCopyProgram._u, 0); gl.viewport(0, 0, w, h);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
          const tileH = Math.max(1, Math.min(1024, h));
          return S360.readFboToCanvas(gl, fbo, w, h, tileH);
      } finally {
          S360.deleteTrackedTexture(gl, tex);
          if (fbo && !gl.isContextLost()) gl.deleteFramebuffer(fbo);
      }
  };

  // Normalises an image for CPU-side analysis. A GPU image is exposed as the
  // { isGpuImage, texture, width, height } shim that estimateGainRFromSource,
  // gpuImageToProxyCanvas, and makeProxy already consume; CPU images pass
  // through unchanged. `liveTexture` supplies the texture of an uploaded GPU
  // image whose own .texture has already been transferred away.
  S360.resolveAnalysisSource = function (image, liveTexture) {
      if (image?.isGpuImage) {
          return {
              isGpuImage: true,
              texture: image.texture || liveTexture,
              width: image.width,
              height: image.height,
          };
      }
      return image;
  };

// One shared worker, latest request wins. request() posts `dispatch`
// immediately when the worker is free, or queues it as the single pending job
// while busy; only the most recent queued job runs when the worker frees up.
// Returns true when the job was dispatched/queued, false when the worker could
// not be created (the caller runs its own synchronous fallback). cancel()
// terminates the worker and drops any pending job.
S360.createSingleFlightWorker = function ({ url, onMessage, label }) {
    let worker = null, busy = false, pending = null;
    let workerUnavailable = false; // cached after first construction failure or file:// detection
    let constructionWarned = false;

    // Detect file:// or other worker-hostile origins once, so we don't retry
    // construction on every request(). In those environments Worker throws
    // synchronously; we cache the result and skip the try/catch entirely.
    const isFileProtocol = (() => {
        try { return location.protocol === 'file:'; } catch (_) { return false; }
    })();

    const warn = (msg) => console.warn(`${label}:`, msg);
    const warnConstruction = (e) => {
        if (constructionWarned) return;
        constructionWarned = true;
        warn(`${e}. Falling back to main-thread processing.`);
    };

    function ensure() {
        if (worker) return worker;
        if (workerUnavailable) return null;
        if (isFileProtocol) {
            workerUnavailable = true;
            if (!constructionWarned) {
                constructionWarned = true;
                warn('file:// origin — workers unavailable. Using main-thread fallback.');
            }
            return null;
        }
        try {
            worker = new Worker(url);
            worker.onmessage = (e) => {
                // Progress heartbeats must not release the single-flight slot:
                // the worker is still busy and the final result arrives later.
                if (e && e.data && e.data.type === 'progress') {
                    try { onMessage(e.data); } catch (err) { warn(err?.message || err); }
                    return;
                }
                busy = false;
                try { onMessage(e.data); } catch (err) { warn(err?.message || err); }
                const run = pending;
                if (run) { pending = null; run(); }
            };
            worker.onerror = (err) => {
                warn(err);
                const failed = worker;
                const queued = pending;
                worker = null; busy = false; pending = null;
                if (failed) { failed.onmessage = failed.onerror = null; failed.terminate(); }
                onMessage({ type: 'error', message: err.message || String(err) });
                // A newer request may have been queued while the failed job
                // was running. Recreate the worker and replay that latest job.
                if (queued && ensure()) queued();
            };
        } catch (e) {
            workerUnavailable = true;
            warnConstruction(e);
            worker = null;
        }
        return worker;
    }

    return {
        get worker() { return ensure(); },
        get busy() { return busy; },
        get unavailable() { return workerUnavailable; },
        post(payload, transfer) { worker?.postMessage(payload, transfer); },
        request(dispatch) {
            if (!ensure()) return false;
            if (busy) { pending = () => { busy = true; dispatch(); }; return true; }
            busy = true;
            dispatch();
            return true;
        },
        cancel() {
            if (worker) { worker.onmessage = null; worker.onerror = null; worker.terminate(); }
            worker = null; busy = false; pending = null;
        },
    };
};

  // FBO/Texture pool to avoid repeated allocation during slider interaction
  const fboPool = new Map(); // key: `${width}x${height}`
  const postFboPool = new Map(); // key: `${width}x${height}` for post-processing
  // Each cache is bounded independently. Scale off the global GPU memory budget
  // when available so capable GPUs keep more targets pooled while weak ones
  // spare VRAM.
  function getPoolBudget() {
    if (S360.gpuMem) return Math.max(64 * 1024 * 1024, Math.floor(S360.gpuMem.budget() * 0.08));
    return 128 * 1024 * 1024;
  }
  let poolClock = 0;

  function deleteEntry(gl, entry) {
      if (entry.tex) S360.deleteTrackedTexture(gl, entry.tex);
      if (entry.fbo && !gl.isContextLost()) gl.deleteFramebuffer(entry.fbo);
  }

  function evictFor(gl, map, incomingBytes, keepKey) {
      let used = 0;
      map.forEach(e => { used += e.bytes || 0; });
      while (used + incomingBytes > getPoolBudget() && map.size) {
          let victimKey = null, victim = null;
          map.forEach((entry, key) => {
              if (key !== keepKey && (!victim || entry.used < victim.used)) {
                  victimKey = key; victim = entry;
              }
          });
          if (!victim) break;
          deleteEntry(gl, victim);
          map.delete(victimKey);
          used -= victim.bytes || 0;
      }
  }

  S360.resetPools = function (gl) {
      function clearMap(map) {
          map.forEach(entry => {
              deleteEntry(gl, entry);
          });
          map.clear();
      }
      clearMap(fboPool);
      clearMap(postFboPool);
  };

  // Creates (or LRU-reuses) one pooled RGBA8 FBO in `map`, keyed by size.
  // Sampler params — equirect semantics shared by the stitch and post targets:
  // WRAP_S = REPEAT makes the hardware bilinear filter blend texel W-1 into
  // texel 0 at the ±π azimuth boundary (the sphere/export shaders sample
  // u = 0.5 + lon/2π, which hits exactly 0 and 1 there — both the same
  // physical direction), removing the hard vertical seam line at the 360°
  // wrap point (REPEAT on NPOT is legal in WebGL2). WRAP_T stays CLAMP: v = 0/1
  // are the poles, which must NOT blend across the top/bottom edge — and CLAMP
  // on T also fixes a subtle border artifact: fullscreen-blit edge taps no
  // longer blend the top row with the bottom row. Explicit LINEAR filters keep
  // the texture complete: texStorage2D allocates only level 0, so the default
  // NEAREST_MIPMAP_LINEAR would leave it mipmap-incomplete (undefined sampling).
  function pooledEntry(gl, map, w, h, label) {
    const key = `${w}x${h}`;
    S360.validateTextureSize(gl, w, h, label);
    if (!map.has(key)) {
      const bytes = w * h * 4;
      evictFor(gl, map, bytes, key);
      let tex = null, fbo = null;
      try {
        tex = S360.createTrackedTexture(gl, { width: w, height: h, label: `${label} ${key}`, bytesPerPixel: 4 }, () => {
          gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
        });
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        fbo = gl.createFramebuffer();
        if (!fbo) throw new Error(`Cannot allocate ${label} framebuffer.`);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        S360.assertFramebufferComplete(gl, label);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        map.set(key, { tex, fbo, width: w, height: h, bytes, used: ++poolClock });
      } catch (error) {
        S360.deleteTrackedTexture(gl, tex);
        if (fbo && !gl.isContextLost()) gl.deleteFramebuffer(fbo);
        throw error;
      }
    }
    const entry = map.get(key); entry.used = ++poolClock; return entry;
  }

  S360.getPooledFBO = function (gl, w, h) {
    return pooledEntry(gl, fboPool, w, h, 'Stitch FBO');
  };

  S360.getPooledPostFBO = function (gl, w, h) {
    return pooledEntry(gl, postFboPool, w, h, 'Post FBO');
  };

  // Reads a full off-screen FBO's pixels into a canvas using horizontal bands
  // ("tiles") instead of one giant w*h*4 allocation. Getting the whole frame in
  // a single readPixels can OOM/trigger context-loss on very large outputs
  // (e.g. a 16k x 8k export is a 512 MB buffer on its own). Tiling keeps the
  // transient allocation bounded (a few MB per band).
  //
  // `flip` (default) reverses rows so the canvas keeps the source's
  // top-row-first orientation (GL origin is bottom-left, so framebuffer row j
  // lands on canvas row h-1-j). Shaders that already output canvas orientation
  // (little planet) pass flip=false to keep rows as read.
  //
  // Buffer strategy: one shared ArrayBuffer backs both a Uint8Array (for
  // gl.readPixels) and a Uint8ClampedArray (for ImageData) via typed-array
  // views on the same memory. The row-flip writes into the flip half of the
  // same buffer so both gl.readPixels and putImageData are zero-copy for
  // full tiles. The final partial tile (if any) is handled with a one-off
  // view so ImageData gets a correctly-sized buffer.
  S360.readFboToCanvas = function (gl, fbo, w, h, tileH = 1024, flip = true) {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      const prevVp = gl.getParameter(gl.VIEWPORT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, w, h);

      const rowBytes = w * 4;
      const tileBytes = rowBytes * tileH;
      // Single allocation: first half = readPixels target ("tile"),
      // second half = row-flip output ("flip"). Both are views on the
      // same ArrayBuffer so no inter-buffer copies are needed.
      const buf = new ArrayBuffer(tileBytes * 2);
      const tile = new Uint8Array(buf, 0, tileBytes);          // gl.readPixels writes here
      const flipU8 = new Uint8Array(buf, tileBytes, tileBytes); // row-flip writes here
      // Clamped view of the flip half — shares the same bytes, no copy.
      // Used directly by ImageData for full tiles.
      const flipClamped = new Uint8ClampedArray(buf, tileBytes, tileBytes);

      for (let y = 0; y < h; y += tileH) {
        const th = Math.min(tileH, h - y);
        gl.readPixels(0, y, w, th, gl.RGBA, gl.UNSIGNED_BYTE, tile);
        const dstY = flip ? h - y - th : y;
        let imgData;
        if (!flip) {
          // Rows are already in canvas order: ImageData views the read buffer
          // directly (zero copy).
          imgData = new ImageData(new Uint8ClampedArray(buf, 0, rowBytes * th), w, th);
        } else {
          for (let j = 0; j < th; j++) {
            flipU8.set(tile.subarray(j * rowBytes, (j + 1) * rowBytes), (th - 1 - j) * rowBytes);
          }
          imgData = th === tileH
            ? new ImageData(flipClamped, w, tileH)                 // full tile: zero copy
            : new ImageData(new Uint8ClampedArray(buf, tileBytes, rowBytes * th), w, th);
        }
        ctx.putImageData(imgData, 0, dstY);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
      gl.viewport(prevVp[0], prevVp[1], prevVp[2], prevVp[3]);
      return canvas;
  };

  // Reads a full off-screen FBO into a streaming PNG writer using horizontal
  // bands instead of one giant w*h*4 allocation. Peak memory stays bounded to
  // the tile size. `flip` (default true) reverses rows so the PNG keeps the
  // source's top-row-first orientation (GL origin is bottom-left).
  S360.streamFboToPng = async function (gl, fbo, w, h, tileH = 1024, flip = true) {
      const png = S360.streamingPng.create(w, h);
      const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      const prevVp = gl.getParameter(gl.VIEWPORT);
            try {
                gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
                gl.viewport(0, 0, w, h);

                const rowBytes = w * 4;
                const tileBytes = rowBytes * tileH;
                const buf = new ArrayBuffer(tileBytes * 2);
                const tile = new Uint8Array(buf, 0, tileBytes);
                const flipU8 = new Uint8Array(buf, tileBytes, tileBytes);

                const numTiles = Math.ceil(h / tileH);
                for (let i = 0; i < numTiles; i++) {
                    const pngY = i * tileH;
                    const th = Math.min(tileH, h - pngY);
                    const srcY = flip ? h - pngY - th : pngY;
                    gl.readPixels(0, srcY, w, th, gl.RGBA, gl.UNSIGNED_BYTE, tile);
                    let data;
                    if (flip) {
                        for (let j = 0; j < th; j++) {
                            flipU8.set(tile.subarray(j * rowBytes, (j + 1) * rowBytes), (th - 1 - j) * rowBytes);
                        }
                        data = th === tileH ? flipU8 : new Uint8Array(buf, tileBytes, rowBytes * th);
                    } else {
                        data = new Uint8Array(buf, 0, rowBytes * th);
                    }
                    await png.write({ top: pngY, rows: th, data });
                }
                return png;
            } catch (error) {
                await png.abort();
                throw error;
            } finally {
                gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
                gl.viewport(prevVp[0], prevVp[1], prevVp[2], prevVp[3]);
      }
  };

  // ---------------------------------------------------------------------------
  // Half-resolution luminance blur used as the low-frequency estimate for the
  // unsharp mask. Precomputing this turns ~40-tap-per-pixel inline
  // sharpening into ONE extra texture fetch in the post/sphere shaders. The
  // blur bakes the current exposure+gamma (matching the original math) and is
  // cached: it only re-renders when the source texture, its size, or
  // exposure/gamma change — so saturation/contrast/sharpen drags are nearly free.
  // ---------------------------------------------------------------------------
  // Two-slot LRU cache. The post pass runs at preview
  // size AND at full pano size (and the live 3D sphere pass samples the same
  // stitch texture at full size), so a single slot delete/recreated its pair
  // of blur targets on every preview <-> full / 2D <-> 3D alternation. Slots
  // are keyed by source-texture identity + half-res size so the two patterns
  // coexist; a third pattern evicts the least-recently-used slot. Each
  // full-size slot costs about panoW*panoH*2 bytes, hence the hard cap.
  const LUM_BLUR_MAX_SLOTS = 2;
  const _lumBlurSlots = new Map();   // 'texId:bwxbh' -> { tex, fbo, tmpTex, tmpFbo, w, h, srcTex, exposure, gamma }
  const _lumTexIds = new WeakMap();  // WebGLTexture -> stable small id for the slot key
  let _lumTexIdNext = 1;
  let _lumBlurProg = null;

  function _lumSlotKey(srcTex, bw, bh) {
    let id = _lumTexIds.get(srcTex);
    if (id === undefined) { id = _lumTexIdNext++; _lumTexIds.set(srcTex, id); }
    return id + ':' + bw + 'x' + bh;
  }

  const LUMBLUR_VS = S360.QUAD_VS;

  const LUMBLUR_FS = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 fragColor;
    uniform sampler2D u_tex;
    uniform vec2 u_step;      // direction * texel (pre-scaled)
    uniform float u_exposure;
    uniform float u_gamma;
    float L(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    void main() {
      float w0 = 0.227027, w1 = 0.194595, w2 = 0.121621, w3 = 0.054054, w4 = 0.016216;
      vec3 c = texture(u_tex, v_uv).rgb * u_exposure;
      float s = L(pow(c, vec3(u_gamma))) * w0;
      vec2 o;
      o = v_uv + u_step;      s += L(pow(texture(u_tex, o).rgb * u_exposure, vec3(u_gamma))) * w1;
      o = v_uv - u_step;      s += L(pow(texture(u_tex, o).rgb * u_exposure, vec3(u_gamma))) * w1;
      o = v_uv + u_step*2.0;  s += L(pow(texture(u_tex, o).rgb * u_exposure, vec3(u_gamma))) * w2;
      o = v_uv - u_step*2.0;  s += L(pow(texture(u_tex, o).rgb * u_exposure, vec3(u_gamma))) * w2;
      o = v_uv + u_step*3.0;  s += L(pow(texture(u_tex, o).rgb * u_exposure, vec3(u_gamma))) * w3;
      o = v_uv - u_step*3.0;  s += L(pow(texture(u_tex, o).rgb * u_exposure, vec3(u_gamma))) * w3;
      o = v_uv + u_step*4.0;  s += L(pow(texture(u_tex, o).rgb * u_exposure, vec3(u_gamma))) * w4;
      o = v_uv - u_step*4.0;  s += L(pow(texture(u_tex, o).rgb * u_exposure, vec3(u_gamma))) * w4;
      fragColor = vec4(vec3(s), 1.0);
    }`;

  // Context-loss recovery (no gl): just drop the references — the objects died
  // with the context, and deleting by name on a fresh context is unsafe.
  //
  // Ownership release (gl provided): deletes the cached targets. Call this ONLY
  // while the objects are guaranteed alive and BEFORE any other subsystem
  // deletes/reallocates textures (see uploadTexture), otherwise WebGL name
  // recycling makes the delete hit someone else's object.
  // Frees every cached slot. Returns the total gpuMem-tracked bytes released
  // (0 when the tracker is absent) so the VRAM-shed path can book it as freed.
  S360.invalidateBlurCache = function (gl) {
    let freedTracked = 0;
    _lumBlurSlots.forEach((slot, key) => {
      freedTracked += S360.trackedTextureBytes(slot?.tex) + S360.trackedTextureBytes(slot?.tmpTex);
      if (gl && slot && !gl.isContextLost()) {
        S360.deleteTrackedTexture(gl, slot.tex);     gl.deleteFramebuffer(slot.fbo);
        S360.deleteTrackedTexture(gl, slot.tmpTex);  gl.deleteFramebuffer(slot.tmpFbo);
      } else if (gl && slot) {
        // Context lost: FBO names are dead but still need deleting to free driver state;
        // texture tracking records must be dropped manually since deleteTrackedTexture
        // skips gl.deleteTexture when the context is lost.
        gl.deleteFramebuffer(slot.fbo);
        gl.deleteFramebuffer(slot.tmpFbo);
        S360.forgetTrackedTexture(slot?.tex);
        S360.forgetTrackedTexture(slot?.tmpTex);
      }
    });
    _lumBlurSlots.clear();
    _lumBlurProg = null;
    return freedTracked;
  };

  // Returns the cache object whose `.tex` holds the blurred luminance of srcTex
  // at half resolution. Fully state-safe: framebuffer binding, unit-0 texture,
  // active texture unit, and viewport are saved/restored. (The caller must
  // still re-select its own PROGRAM afterwards — this helper binds its own.)
  S360.ensureLumBlur = function (gl, srcTex, w, h, exposure, gamma) {
      const bw = Math.max(1, w >> 1);
      const bh = Math.max(1, h >> 1);

      if (!_lumBlurProg) {
          _lumBlurProg = S360.createProgram(gl, LUMBLUR_VS, LUMBLUR_FS);
          _lumBlurProg._u = {
              u_tex:      gl.getUniformLocation(_lumBlurProg, 'u_tex'),
              u_step:     gl.getUniformLocation(_lumBlurProg, 'u_step'),
              u_exposure: gl.getUniformLocation(_lumBlurProg, 'u_exposure'),
              u_gamma:    gl.getUniformLocation(_lumBlurProg, 'u_gamma'),
          };
      }

      // Save ALL caller state up-front — before either `if` block can touch it.
      // Cache creation binds FRAMEBUFFER to null (target allocation), so a save
      // captured after that block would restore the wrong binding and send the
      // post-processing draw to the screen canvas (flash) while the off-screen
      // FBO stayed empty (black export) whenever the blur cache was invalidated
      // by a size change.
      const prevFb       = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      const prevViewport = gl.getParameter(gl.VIEWPORT);
      const prevActive   = gl.getParameter(gl.ACTIVE_TEXTURE);
      const prevTex0     = gl.getParameter(gl.TEXTURE_BINDING_2D);

      let needsRender = false;

      const key = _lumSlotKey(srcTex, bw, bh);
      let slot = _lumBlurSlots.get(key);

      if (slot) {
          // LRU refresh: re-insert so this slot becomes the most recently used.
          _lumBlurSlots.delete(key);
          _lumBlurSlots.set(key, slot);
      } else {
          // Make room before creating a new pattern's targets. Evicting our
          // own cached slot within a LIVE context is safe: our names remain
          // allocated (we hold references), so no other allocation can have
          // captured them. After a context loss the wrappers are dead and
          // deleting could hit recycled names on the fresh context — skip.
          while (_lumBlurSlots.size >= LUM_BLUR_MAX_SLOTS) {
              const oldestKey = _lumBlurSlots.keys().next().value;
              const oldest = _lumBlurSlots.get(oldestKey);
              if (oldest && gl && !gl.isContextLost()) {
                  S360.deleteTrackedTexture(gl, oldest.tex);     gl.deleteFramebuffer(oldest.fbo);
                  S360.deleteTrackedTexture(gl, oldest.tmpTex);  gl.deleteFramebuffer(oldest.tmpFbo);
               }
               if (oldest && (!gl || gl.isContextLost())) {
                   S360.forgetTrackedTexture(oldest.tex); S360.forgetTrackedTexture(oldest.tmpTex);
               }
              _lumBlurSlots.delete(oldestKey);
          }
          const mkTarget = (tw, th, phase) => {
              let t = null, fb = null;
              try {
                  t = S360.createTrackedTexture(gl, {
                      width: tw, height: th, label: `Lum blur ${phase} ${tw}×${th}`, bytesPerPixel: 4,
                  }, () => gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, tw, th));
                  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                  // The panorama wraps horizontally but clamps at the poles.
                  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
                  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                  fb = gl.createFramebuffer();
                  if (!fb) throw new Error(`Cannot allocate lum blur ${phase} framebuffer.`);
                  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
                  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
                  S360.assertFramebufferComplete(gl, `Lum blur ${phase}`);
                  return { t, fb };
              } catch (error) {
                  S360.deleteTrackedTexture(gl, t);
                  if (fb && !gl.isContextLost()) gl.deleteFramebuffer(fb);
                  throw error;
              }
          };
          let a = null, b = null;
          try {
              a = mkTarget(bw, bh, 'result');
              b = mkTarget(bw, bh, 'scratch');
          } catch (error) {
              if (a) { S360.deleteTrackedTexture(gl, a.t); gl.deleteFramebuffer(a.fb); }
              if (b) { S360.deleteTrackedTexture(gl, b.t); gl.deleteFramebuffer(b.fb); }
              throw error;
          }
          // exposure/gamma left undefined => the param check below forces a render.
          slot = { tex: a.t, fbo: a.fb, tmpTex: b.t, tmpFbo: b.fb, w: bw, h: bh, srcTex };
          _lumBlurSlots.set(key, slot);
          needsRender = true;
      }

      if (needsRender || slot.revision !== (srcTex.contentRevision || 0) || slot.exposure !== exposure || slot.gamma !== gamma) {
          gl.useProgram(_lumBlurProg);
          gl.bindVertexArray(S360.getQuadVAO(gl));
          gl.viewport(0, 0, bw, bh);
          const u = _lumBlurProg._u;
          gl.uniform1f(u.u_exposure, exposure);
          gl.uniform1f(u.u_gamma, gamma);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, srcTex);
          gl.uniform1i(u.u_tex, 0);
          // Horizontal pass: src -> tmp (step scaled x0.5 to keep the apparent
          // blur radius consistent when sampling at half resolution).
          gl.uniform2f(u.u_step, 0.5 / bw, 0.0);
          gl.bindFramebuffer(gl.FRAMEBUFFER, slot.tmpFbo);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
          // Vertical pass: tmp -> tex
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, slot.tmpTex);
          gl.uniform2f(u.u_step, 0.0, 0.5 / bh);
          gl.bindFramebuffer(gl.FRAMEBUFFER, slot.fbo);
          gl.drawArrays(gl.TRIANGLES, 0, 6);

          slot.revision = srcTex.contentRevision || 0;
          slot.exposure = exposure;
          slot.gamma = gamma;
      }

      // Restore caller state — always, regardless of which blocks ran.
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
      gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
      gl.activeTexture(prevActive);
      gl.bindTexture(gl.TEXTURE_2D, prevTex0);

      return slot;
  };

  // Cooperative yield for long-running async pipelines (exposure fusion, frame
  // analysis, first-render handoff): prefers requestAnimationFrame so the
  // browser can paint the loading overlay, but races a short timer because
  // rAF NEVER FIRES while the tab is hidden — an awaited rAF there stalls the
  // whole pipeline until the user switches back. When the tab is hidden there
  // is nothing to paint, so resolve immediately and keep processing at full
  // speed (real async boundaries — image decode, worker messages — still pump
  // the event loop, so cancellation checks stay live). Defined here because
  // webgl-utils.js loads before every consumer (align.js, exposure-fusion.js, stitcher.js).
  S360.yieldToUI = function () {
      if (typeof document !== 'undefined' && document.hidden) return Promise.resolve();
      return new Promise(resolve => {
          let settled = false;
          const finish = () => { if (!settled) { settled = true; resolve(); } };
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish);
          setTimeout(finish, 64); // safety net when rAF is starved or unsupported
      });
  };
})(window.S360);
