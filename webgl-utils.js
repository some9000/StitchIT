// webgl-utils.js

window.S360 = window.S360 || {};
(function (S360) {

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

  // Rodrigues rotation — shared by seam.js and stitcher.js.
  S360.rotateAroundAxis = function (v, axis, angle) {
      const c = Math.cos(angle), s = Math.sin(angle);
      const [ax, ay, az] = axis;
      const dot = v[0] * ax + v[1] * ay + v[2] * az;
      return [
          v[0] * c + s * (ay * v[2] - az * v[1]) + (1 - c) * ax * dot,
          v[1] * c + s * (az * v[0] - ax * v[2]) + (1 - c) * ay * dot,
          v[2] * c + s * (ax * v[1] - ay * v[0]) + (1 - c) * az * dot
      ];
  };

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
              if (texture) gl.deleteTexture(texture);
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
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      S360.assertFramebufferComplete(gl, 'GPU proxy target');
      if (!_proxyCopyProgram) {
          _proxyCopyProgram = S360.createProgram(gl,
            `#version 300 es\nlayout(location=0) in vec2 a_position; out vec2 v_uv; void main(){v_uv=a_position*.5+.5;gl_Position=vec4(a_position,0,1);}`,
            `#version 300 es\nprecision highp float; in vec2 v_uv; out vec4 o; uniform sampler2D u_tex; void main(){o=texture(u_tex,v_uv);}`);
          _proxyCopyProgram._u = gl.getUniformLocation(_proxyCopyProgram, 'u_tex');
      }
      gl.useProgram(_proxyCopyProgram); gl.bindVertexArray(S360.getQuadVAO(gl));
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, gpuImage.texture);
      gl.uniform1i(_proxyCopyProgram._u, 0); gl.viewport(0, 0, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      const canvas = S360.readFboToCanvas(gl, fbo, w, h, Math.min(256, h));
      gl.deleteTexture(tex); gl.deleteFramebuffer(fbo);
      return canvas;
  };

  // FBO/Texture pool to avoid repeated allocation during slider interaction
  const fboPool = new Map(); // key: `${width}x${height}`
  const postFboPool = new Map(); // key: `${width}x${height}` for post-processing
  const lfPool = new Map(); // key: `${width}x${height}` for low-frequency textures
  // Each of the three independent pools gets 128 MiB, so their combined cached
  // storage remains near 384 MiB instead of growing without bound.
  const POOL_BUDGET = 128 * 1024 * 1024;
  let poolClock = 0;

  function deleteEntry(gl, entry) {
      if (entry.tex) gl.deleteTexture(entry.tex);
      if (entry.fbo) gl.deleteFramebuffer(entry.fbo);
      if (entry.lfTex) gl.deleteTexture(entry.lfTex);
      if (entry.lfFbo) gl.deleteFramebuffer(entry.lfFbo);
      if (entry.lfTmpTex) gl.deleteTexture(entry.lfTmpTex);
      if (entry.lfTmpFbo) gl.deleteFramebuffer(entry.lfTmpFbo);
      // Untrack from the global GPU memory budget when the entry is destroyed.
      if (entry._memId && S360.gpuMem) S360.gpuMem.untrack(entry._memId);
  }

  function evictFor(gl, map, incomingBytes, keepKey) {
      let used = 0;
      map.forEach(e => { used += e.bytes || 0; });
      while (used + incomingBytes > POOL_BUDGET && map.size) {
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
      clearMap(lfPool);
  };

  S360.getPooledFBO = function (gl, w, h) {
      const key = `${w}x${h}`;
      S360.validateTextureSize(gl, w, h, 'Stitch target');
      if (!fboPool.has(key)) {
          const bytes = w * h * 4;
          evictFor(gl, fboPool, bytes, key);
          // Proactively shed non-essential caches if the global budget is tight.
          if (S360.gpuMem) S360.gpuMem.shed(gl, bytes);
          const tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
          const fbo = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
          S360.assertFramebufferComplete(gl, 'Stitch target');
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          const memId = `fbo:${key}`;
          fboPool.set(key, { tex, fbo, width: w, height: h, bytes, used: ++poolClock, _memId: memId });
          if (S360.gpuMem) S360.gpuMem.track(memId, bytes, `Stitch FBO ${key}`);
      }
      const entry = fboPool.get(key); entry.used = ++poolClock; return entry;
  };

  S360.getPooledPostFBO = function (gl, w, h) {
      const key = `${w}x${h}`;
      S360.validateTextureSize(gl, w, h, 'Post-processing target');
      if (!postFboPool.has(key)) {
          const bytes = w * h * 4;
          evictFor(gl, postFboPool, bytes, key);
          if (S360.gpuMem) S360.gpuMem.shed(gl, bytes);
          const tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
          const fbo = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
          S360.assertFramebufferComplete(gl, 'Post-processing target');
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          const memId = `post:${key}`;
          postFboPool.set(key, { tex, fbo, width: w, height: h, bytes, used: ++poolClock, _memId: memId });
          if (S360.gpuMem) S360.gpuMem.track(memId, bytes, `Post FBO ${key}`);
      }
      const entry = postFboPool.get(key); entry.used = ++poolClock; return entry;
  };

  S360.getPooledLF = function (gl, lfW, lfH) {
      const key = `${lfW}x${lfH}`;
      S360.validateTextureSize(gl, lfW, lfH, 'Low-frequency target');
      if (!lfPool.has(key)) {
          const bytes = lfW * lfH * 8;
          evictFor(gl, lfPool, bytes, key);
          if (S360.gpuMem) S360.gpuMem.shed(gl, bytes);
          const mkTex = () => {
              const t = gl.createTexture();
              gl.bindTexture(gl.TEXTURE_2D, t);
              gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, lfW, lfH);
              return t;
          };
          const lfTmpTex = mkTex();
          const lfTmpFbo = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, lfTmpFbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, lfTmpTex, 0);
          const lfTex = mkTex();
          const lfFbo = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, lfFbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, lfTex, 0);
          S360.assertFramebufferComplete(gl, 'Low-frequency target');
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          const memId = `lf:${key}`;
          lfPool.set(key, { lfTex, lfFbo, lfTmpTex, lfTmpFbo, width: lfW, height: lfH, bytes, used: ++poolClock, _memId: memId });
          if (S360.gpuMem) S360.gpuMem.track(memId, bytes, `LF texture ${key}`);
      }
      const entry = lfPool.get(key); entry.used = ++poolClock; return entry;
  };

  // Reads a full off-screen FBO's pixels into a canvas using horizontal bands
  // ("tiles") instead of one giant w*h*4 allocation. Getting the whole frame in
  // a single readPixels can OOM/trigger context-loss on very large outputs
  // (e.g. a 16k x 8k export is a 512 MB buffer on its own). Tiling keeps the
  // transient allocation bounded (a few MB per band) and flips rows so the
  // canvas keeps the source's top-row-first orientation (GL origin is bottom-left,
  // so framebuffer row j lands on canvas row h-1-j).
  S360.readFboToCanvas = function (gl, fbo, w, h, tileH = 1024) {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(w, h);
      const data = img.data;
      const rowBytes = w * 4;
      const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      const prevVp = gl.getParameter(gl.VIEWPORT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, w, h);
      for (let y = 0; y < h; y += tileH) {
          const th = Math.min(tileH, h - y);
          const tile = new Uint8Array(rowBytes * th);
          gl.readPixels(0, y, w, th, gl.RGBA, gl.UNSIGNED_BYTE, tile);
          for (let j = 0; j < th; j++) {
              const srcOff = j * rowBytes;
              const dstOff = (h - 1 - (y + j)) * rowBytes;
              data.set(tile.subarray(srcOff, srcOff + rowBytes), dstOff);
          }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
      gl.viewport(prevVp[0], prevVp[1], prevVp[2], prevVp[3]);
      ctx.putImageData(img, 0, 0);
      return canvas;
  };

  // ---------------------------------------------------------------------------
  // Half-resolution luminance blur used as the low-frequency estimate for the
  // unsharp mask. Precomputing this turns the old ~40-tap-per-pixel inline
  // sharpening into ONE extra texture fetch in the post/sphere shaders. The
  // blur bakes the current exposure+gamma (matching the original math) and is
  // cached: it only re-renders when the source texture, its size, or
  // exposure/gamma change — so saturation/contrast/sharpen drags are nearly free.
  // ---------------------------------------------------------------------------
  let _lumBlur = null;      // { tex, fbo, tmpTex, tmpFbo, w, h, srcTex, exposure, gamma }
  let _lumBlurProg = null;

  const LUMBLUR_VS = `#version 300 es
    layout(location = 0) in vec2 a_position;
    out vec2 v_uv;
    void main() { v_uv = a_position * 0.5 + 0.5; gl_Position = vec4(a_position, 0.0, 1.0); }`;

  const LUMBLUR_FS = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 fragColor;
    uniform sampler2D u_tex;
    uniform vec2 u_step;      // direction * texel (pre-scaled)
    uniform float u_exposure;
    uniform float u_gamma;
    float L(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
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
  S360.invalidateBlurCache = function (gl) {
       if (gl && _lumBlur) {
           gl.deleteTexture(_lumBlur.tex);     gl.deleteFramebuffer(_lumBlur.fbo);
           gl.deleteTexture(_lumBlur.tmpTex);  gl.deleteFramebuffer(_lumBlur.tmpFbo);
       }
       if (_lumBlur && S360.gpuMem) {
           const bytes = (_lumBlur.w || 0) * (_lumBlur.h || 0) * 4 * 2; // two RGBA8 targets
           S360.gpuMem.untrack('lumBlur');
       }
       _lumBlur = null;
       _lumBlurProg = null;
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
      // A previous version saved inside the render-if block, but cache creation
      // called gl.bindFramebuffer(FRAMEBUFFER, null) which clobbered the caller's
      // FBO before the save captured it.  This caused the post-processing draw to
      // go to the screen canvas (flash) while the off-screen FBO stayed empty
      // (black export) whenever the blur cache was invalidated by a size change.
      const prevFb       = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      const prevViewport = gl.getParameter(gl.VIEWPORT);
      const prevActive   = gl.getParameter(gl.ACTIVE_TEXTURE);
      const prevTex0     = gl.getParameter(gl.TEXTURE_BINDING_2D);

      let needsRender = false;

      if (!_lumBlur || _lumBlur.srcTex !== srcTex || _lumBlur.w !== bw || _lumBlur.h !== bh) {
          // Deleting within a LIVE context is safe: our cached names remain
          // allocated (we hold references), so no other allocation can have
          // captured them. After a context loss the wrappers are dead and
          // deleting could hit recycled names on the fresh context — skip.
          if (_lumBlur && !gl.isContextLost()) {
              gl.deleteTexture(_lumBlur.tex);     gl.deleteFramebuffer(_lumBlur.fbo);
              gl.deleteTexture(_lumBlur.tmpTex);  gl.deleteFramebuffer(_lumBlur.tmpFbo);
          }
          const mkTarget = (tw, th) => {
              const t = gl.createTexture();
              gl.bindTexture(gl.TEXTURE_2D, t);
              gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, tw, th);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
              const fb = gl.createFramebuffer();
              gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
              gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
              return { t, fb };
          };
          const a = mkTarget(bw, bh);
          const b = mkTarget(bw, bh);
          // exposure/gamma left undefined => the param check below forces a render.
          _lumBlur = { tex: a.t, fbo: a.fb, tmpTex: b.t, tmpFbo: b.fb, w: bw, h: bh, srcTex };
          if (S360.gpuMem) S360.gpuMem.track('lumBlur', bw * bh * 4 * 2, `Lum blur ${bw}×${bh}`);
          needsRender = true;
      }

      if (needsRender || _lumBlur.exposure !== exposure || _lumBlur.gamma !== gamma) {
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
          gl.bindFramebuffer(gl.FRAMEBUFFER, _lumBlur.tmpFbo);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
          // Vertical pass: tmp -> tex
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, _lumBlur.tmpTex);
          gl.uniform2f(u.u_step, 0.0, 0.5 / bh);
          gl.bindFramebuffer(gl.FRAMEBUFFER, _lumBlur.fbo);
          gl.drawArrays(gl.TRIANGLES, 0, 6);

          _lumBlur.exposure = exposure;
          _lumBlur.gamma = gamma;
      }

      // Restore caller state — always, regardless of which blocks ran.
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
      gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
      gl.activeTexture(prevActive);
      gl.bindTexture(gl.TEXTURE_2D, prevTex0);

      return _lumBlur;
  };
})(window.S360);
