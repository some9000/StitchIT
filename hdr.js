// hdr.js
window.S360 = window.S360 || {};
(function (S360) {
  const MAX_FRAMES = 16; // static upper bound for the dynamic-indexing shader

  // Probe whether the current driver supports dynamically-indexed sampler arrays
  // in fragment shaders.  Returns true if a test shader compiles and links.
  // Result is memoised after the first call.
  let _dynamicIdxCached = null;
  function supportsDynamicSamplerIndexing(gl) {
    if (_dynamicIdxCached !== null) return _dynamicIdxCached;
    const vs = `#version 300 es
      layout(location = 0) in vec2 a_position;
      void main() { gl_Position = vec4(a_position, 0.0, 1.0); }`;
    const fs = `#version 300 es
      precision highp float;
      out vec4 fragColor;
      uniform sampler2D u_frames[4];
      uniform int u_idx;
      void main() {
        vec4 c = texture(u_frames[u_idx], vec2(0.5));
        fragColor = c;
      }`;
    const prog = gl.createProgram();
    const vShader = gl.createShader(gl.VERTEX_SHADER);
    const fShader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(vShader, vs); gl.compileShader(vShader);
    gl.shaderSource(fShader, fs); gl.compileShader(fShader);
    gl.attachShader(prog, vShader); gl.attachShader(prog, fShader); gl.linkProgram(prog);
    const ok = gl.getProgramParameter(prog, gl.LINK_STATUS);
    gl.deleteProgram(prog); gl.deleteShader(vShader); gl.deleteShader(fShader);
    _dynamicIdxCached = !!ok;
    return _dynamicIdxCached;
  }

  // Single dynamic-indexing shader for all batch sizes.  Uses a fixed maximum
  // sampler array and breaks out of the loop once u_count samples have been
  // fused.  Falls back to the unrolled per-count shader on drivers that don't
  // support dynamic sampler indexing.
  S360.createHdrFuseProgramDynamic = function (gl) {
      const vs = `#version 300 es
        layout(location = 0) in vec2 a_position;
        out vec2 v_uv;
        void main() { v_uv = a_position * 0.5 + 0.5; gl_Position = vec4(a_position, 0.0, 1.0); }`;

      const fs = `#version 300 es
        precision highp float;
        in vec2 v_uv;
        out vec4 fragColor;
        uniform sampler2D u_frames[${MAX_FRAMES}];
        uniform int u_count;
        uniform float u_sigma;
        uniform float u_center;
        uniform float u_base;
        uniform float u_scale;
        uniform sampler2D u_prev;
        uniform vec2 u_offsets[${MAX_FRAMES}];
        uniform float u_gains[${MAX_FRAMES}];
        uniform vec2 u_imageSize;
        uniform int u_robust;
        uniform float u_robustThreshold;
        uniform int u_wrapX;
        vec3 srgbToLinear(vec3 c) {
          bvec3 low = lessThanEqual(c, vec3(0.04045));
          vec3 lo = c / 12.92;
          vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
          return mix(hi, lo, low);
        }
        void main() {
          float inv2Sig2 = 1.0 / (2.0 * u_sigma * u_sigma);
          vec3 acc = vec3(0.0);
          float wsum = 0.0;
          vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
          vec4 prev = texture(u_prev, v_uv);
          for (int i = 0; i < ${MAX_FRAMES}; i++) {
            if (i >= u_count) break;
            vec2 sampleUv = uv + u_offsets[i] / u_imageSize;
            if (u_wrapX == 1) sampleUv.x = fract(sampleUv.x);
            vec3 encoded = texture(u_frames[i], sampleUv).rgb;
            vec3 originalLinear = srgbToLinear(encoded);
            vec3 c = originalLinear * u_gains[i];
            vec3 d = encoded - vec3(u_center);
            float w = u_base + (1.0 - u_base) * exp(-dot(d, d) * inv2Sig2);
            if (u_robust == 1 && prev.a > 1e-6) {
              vec3 prevMean = prev.rgb / prev.a;
              float residual = length(c - prevMean) / 1.7320508;
              w *= min(1.0, u_robustThreshold / max(residual, 1e-6));
            }
            acc += c * w;
            wsum += w;
          }
          acc *= u_scale;
          wsum *= u_scale;
          acc += prev.rgb;
          wsum += prev.a;
          fragColor = vec4(acc, wsum);
        }`;

      return S360.createProgram(gl, vs, fs);
  };

  // Builds the exposure-fusion program once.  Tries dynamic sampler indexing
  // first; if the driver rejects it, falls back to the unrolled per-count shader.
  S360.createHdrFuseProgramFor = function (gl, count) {
      if (count <= MAX_FRAMES && supportsDynamicSamplerIndexing(gl)) {
          return S360.createHdrFuseProgramDynamic(gl);
      }
      // Fallback: unrolled per-count shader.
      const vs = `#version 300 es
        layout(location = 0) in vec2 a_position;
        out vec2 v_uv;
        void main() { v_uv = a_position * 0.5 + 0.5; gl_Position = vec4(a_position, 0.0, 1.0); }`;

      let body = '';
      for (let i = 0; i < count; i++) {
          body += `
        if (${i} < u_count) {
          vec2 sampleUv${i} = uv + u_offsets[${i}] / u_imageSize;
          if (u_wrapX == 1) sampleUv${i}.x = fract(sampleUv${i}.x);
          vec3 encoded${i} = texture(u_frames[${i}], sampleUv${i}).rgb;
          vec3 originalLinear${i} = srgbToLinear(encoded${i});
          vec3 c${i} = originalLinear${i} * u_gains[${i}];
          vec3 d${i} = encoded${i} - vec3(u_center);
          float w${i} = u_base + (1.0 - u_base) * exp(-dot(d${i}, d${i}) * inv2Sig2);
          if (u_robust == 1 && prev.a > 1e-6) {
            vec3 prevMean${i} = prev.rgb / prev.a;
            float residual${i} = length(c${i} - prevMean${i}) / 1.7320508;
            w${i} *= min(1.0, u_robustThreshold / max(residual${i}, 1e-6));
          }
          acc += c${i} * w${i};
          wsum += w${i};
        }`;
      }

      const fs = `#version 300 es
        precision highp float;
        in vec2 v_uv;
        out vec4 fragColor;
        uniform sampler2D u_frames[${count}];
        uniform int u_count;
        uniform float u_sigma;
        uniform float u_center;
        uniform float u_base;
        uniform float u_scale;
        uniform sampler2D u_prev;
        uniform vec2 u_offsets[${count}];
        uniform float u_gains[${count}];
        uniform vec2 u_imageSize;
        uniform int u_robust;
        uniform float u_robustThreshold;
        uniform int u_wrapX;
        vec3 srgbToLinear(vec3 c) {
          bvec3 low = lessThanEqual(c, vec3(0.04045));
          vec3 lo = c / 12.92;
          vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
          return mix(hi, lo, low);
        }
        void main() {
          float inv2Sig2 = 1.0 / (2.0 * u_sigma * u_sigma);
          vec3 acc = vec3(0.0);
          float wsum = 0.0;
          vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
          vec4 prev = texture(u_prev, v_uv);
          ${body}
          acc *= u_scale;
          wsum *= u_scale;
          acc += prev.rgb;
          wsum += prev.a;
          fragColor = vec4(acc, wsum);
        }`;

      const prog = S360.createProgram(gl, vs, fs);
      prog._maxFrames = count;
      return prog;
  };

  // One fusion program per batch size (the sampler array is sized at compile time),
  // with uniform locations cached the first time it is used.  If the driver supports
  // dynamic sampler indexing, a single shared program is reused for all batch sizes.
  S360.getHdrFuseProgram = function (gl, count, hdrFusePrograms) {
      if (!S360._hdrDynamicSupported) {
        S360._hdrDynamicSupported = supportsDynamicSamplerIndexing(gl);
      }
      if (S360._hdrDynamicSupported) {
        if (!hdrFusePrograms._dynamicProg) {
          const prog = S360.createHdrFuseProgramDynamic(gl);
          prog._u = {};
          for (let i = 0; i < MAX_FRAMES; i++) prog._u[`u_frames[${i}]`] = gl.getUniformLocation(prog, `u_frames[${i}]`);
          for (let i = 0; i < MAX_FRAMES; i++) {
              prog._u[`u_offsets[${i}]`] = gl.getUniformLocation(prog, `u_offsets[${i}]`);
              prog._u[`u_gains[${i}]`] = gl.getUniformLocation(prog, `u_gains[${i}]`);
          }
          prog._u.u_count  = gl.getUniformLocation(prog, 'u_count');
          prog._u.u_sigma  = gl.getUniformLocation(prog, 'u_sigma');
          prog._u.u_center = gl.getUniformLocation(prog, 'u_center');
          prog._u.u_base   = gl.getUniformLocation(prog, 'u_base');
          prog._u.u_scale  = gl.getUniformLocation(prog, 'u_scale');
          prog._u.u_prev   = gl.getUniformLocation(prog, 'u_prev');
          prog._u.u_imageSize = gl.getUniformLocation(prog, 'u_imageSize');
          prog._u.u_robust = gl.getUniformLocation(prog, 'u_robust');
          prog._u.u_robustThreshold = gl.getUniformLocation(prog, 'u_robustThreshold');
          prog._u.u_wrapX = gl.getUniformLocation(prog, 'u_wrapX');
          hdrFusePrograms._dynamicProg = prog;
        }
        return hdrFusePrograms._dynamicProg;
      }
      let prog = hdrFusePrograms.get(count);
      if (!prog) {
          prog = S360.createHdrFuseProgramFor(gl, count);
          prog._u = {};
          for (let i = 0; i < count; i++) prog._u[`u_frames[${i}]`] = gl.getUniformLocation(prog, `u_frames[${i}]`);
          for (let i = 0; i < count; i++) {
              prog._u[`u_offsets[${i}]`] = gl.getUniformLocation(prog, `u_offsets[${i}]`);
              prog._u[`u_gains[${i}]`] = gl.getUniformLocation(prog, `u_gains[${i}]`);
          }
          prog._u.u_count  = gl.getUniformLocation(prog, 'u_count');
          prog._u.u_sigma  = gl.getUniformLocation(prog, 'u_sigma');
          prog._u.u_center = gl.getUniformLocation(prog, 'u_center');
          prog._u.u_base   = gl.getUniformLocation(prog, 'u_base');
          prog._u.u_scale  = gl.getUniformLocation(prog, 'u_scale');
          prog._u.u_prev   = gl.getUniformLocation(prog, 'u_prev');
          prog._u.u_imageSize = gl.getUniformLocation(prog, 'u_imageSize');
          prog._u.u_robust = gl.getUniformLocation(prog, 'u_robust');
          prog._u.u_robustThreshold = gl.getUniformLocation(prog, 'u_robustThreshold');
          prog._u.u_wrapX = gl.getUniformLocation(prog, 'u_wrapX');
          hdrFusePrograms.set(count, prog);
      }
      return prog;
  };

  // Normalizes the accumulated (weighted-sum / weight-sum) pair back to a colour.
  S360.createNormalizeProgram = function (gl) {
      const vs = `#version 300 es
        layout(location = 0) in vec2 a_position;
        out vec2 v_uv;
        void main() { v_uv = a_position * 0.5 + 0.5; gl_Position = vec4(a_position, 0.0, 1.0); }`;
      const fs = `#version 300 es
        precision highp float;
        in vec2 v_uv;
        out vec4 fragColor;
        uniform sampler2D u_acc;
        void main() {
          // Store in the same orientation as a top-row Canvas upload. The former
          // readback path performed this flip on the CPU before re-upload.
          vec4 a = texture(u_acc, vec2(v_uv.x, 1.0 - v_uv.y));
          float w = max(a.a, 1e-6);
          vec3 linear = clamp(a.rgb / w, 0.0, 1.0);
          bvec3 low = lessThanEqual(linear, vec3(0.0031308));
          vec3 lo = linear * 12.92;
          vec3 hi = 1.055 * pow(linear, vec3(1.0 / 2.4)) - 0.055;
          fragColor = vec4(mix(hi, lo, low), 1.0);
        }`;
      return S360.createProgram(gl, vs, fs);
  };

  // Filmic tone mapping (ACES approximation) applied to the merged radiance
  // before sRGB encoding.  The brightness slider now acts as an exposure
  // control in stops (×2 per unit) so dragging it feels photographic.
  // At brightness = 0 the exposure multiplier is 1× and the ACES curve
  // gently compresses highlights while lifting shadows — a natural default.
  S360.createToneMapProgram = function (gl) {
      const vs = `#version 300 es
        layout(location = 0) in vec2 a_position;
        out vec2 v_uv;
        void main() { v_uv = a_position * 0.5 + 0.5; gl_Position = vec4(a_position, 0.0, 1.0); }`;
      const fs = `#version 300 es
        precision highp float;
        in vec2 v_uv;
        out vec4 fragColor;
        uniform sampler2D u_acc;
        uniform float u_bright; // exposure in stops (0 = 1×, +1 = 2×, −1 = 0.5×)
        void main() {
          vec4 a = texture(u_acc, vec2(v_uv.x, 1.0 - v_uv.y));
          float w = max(a.a, 1e-6);
          vec3 rad = a.rgb / w;
          // Exposure adjustment
          rad *= pow(2.0, u_bright);
          // ACES filmic tone mapping (Stephen Hill approximation)
          vec3 num = rad * (2.51 * rad + 0.03);
          vec3 den = rad * (2.43 * rad + 0.59) + 0.14;
          vec3 outC = clamp(num / den, 0.0, 1.0);
          // Linear → sRGB
          bvec3 low = lessThanEqual(outC, vec3(0.0031308));
          vec3 lo = outC * 12.92;
          vec3 hi = 1.055 * pow(outC, vec3(1.0 / 2.4)) - 0.055;
          fragColor = vec4(mix(hi, lo, low), 1.0);
        }`;
      return S360.createProgram(gl, vs, fs);
  };

  // Fuses one batch of equally-sized frame textures into an accumulator FBO,
  // adding to the previous batches' accumulator (ping-pong between two FBOs).
  S360.fuseBatch = function (gl, prog, frameTex, batchCount, w, h, prevTex, outFbo, uScale, cfg, frameInfo, robust, wrapX) {
      gl.useProgram(prog);
      gl.bindVertexArray(S360.getQuadVAO(gl));
      const u = prog._u;
      for (let i = 0; i < batchCount; i++) {
          gl.activeTexture(gl.TEXTURE0 + i);
          gl.bindTexture(gl.TEXTURE_2D, frameTex[i]);
          gl.uniform1i(u[`u_frames[${i}]`], i);
          const info = frameInfo[i] || { offset: [0, 0], exposureGain: 1 };
          // Analysis offsets are top-row image coordinates. X keeps its sign;
          // texture V runs bottom-up here, so only Y is inverted.
          gl.uniform2f(u[`u_offsets[${i}]`], info.offset[0], -info.offset[1]);
          gl.uniform1f(u[`u_gains[${i}]`], info.exposureGain || 1);
      }
      gl.uniform1i(u.u_count, batchCount);
      gl.uniform1f(u.u_sigma, cfg.hdr.sigma);
      gl.uniform1f(u.u_center, cfg.hdr.bellCenter);
      gl.uniform1f(u.u_base, cfg.hdr.base);
      gl.uniform1f(u.u_scale, uScale);
      gl.uniform2f(u.u_imageSize, w, h);
      gl.uniform1i(u.u_robust, robust ? 1 : 0);
      gl.uniform1f(u.u_robustThreshold, 0.15);
      gl.uniform1i(u.u_wrapX, wrapX ? 1 : 0);
      gl.activeTexture(gl.TEXTURE0 + batchCount);
      gl.bindTexture(gl.TEXTURE_2D, prevTex);
      gl.uniform1i(u.u_prev, batchCount);
      gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo);
      gl.viewport(0, 0, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  // Half-float (RGBA16F) accumulation target, cleared to zero, used for the
  // running HDR exposure-fusion sum (ping-ponged between two of these).
  //
  // The previous RGBA8 accumulator re-quantised the weighted sum back to 8-bit
  // after every batch, so when many exposures are fused the rounding error
  // compounds and shows up as banding / colour tint (worst in shadow tones).
  // Half-float keeps precision across all batches; the final normalize pass
  // (createNormalizeProgram) clamps the result back to 8-bit output. RGBA16F is
  // only color-renderable when EXT_color_buffer_float is present, so we probe
  // for it once and fall back to RGBA8 on older GPUs/drivers.
  const _hdrState = new WeakMap();
  function getHdrState(gl) {
      let state = _hdrState.get(gl);
      if (!state) {
          state = { format: undefined, fusePrograms: new Map(), normalize: null, toneMap: null };
          _hdrState.set(gl, state);
      }
      return state;
  }

  S360.invalidateHdrPrograms = function (gl) {
      if (gl) _hdrState.delete(gl);
      _dynamicIdxCached = null;  // re-probe after context loss
  };

  S360.getHdrFinalProgram = function (gl, toneMap) {
      const state = getHdrState(gl);
      const key = toneMap ? 'toneMap' : 'normalize';
      if (!state[key]) {
          const prog = toneMap ? S360.createToneMapProgram(gl) : S360.createNormalizeProgram(gl);
          prog._u = { u_acc: gl.getUniformLocation(prog, 'u_acc') };
          if (toneMap) prog._u.u_bright = gl.getUniformLocation(prog, 'u_bright');
          state[key] = prog;
      }
      return state[key];
  };

  S360.makeAccumTarget = function (gl, tw, th) {
      S360.validateTextureSize(gl, tw, th, 'Fusion accumulator');
      const state = getHdrState(gl);
      if (state.format === undefined) {
          state.format = gl.getExtension('EXT_color_buffer_float') ? gl.RGBA16F : gl.RGBA8;
      }
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, state.format, tw, th);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      S360.assertFramebufferComplete(gl, 'Fusion accumulator');
      gl.viewport(0, 0, tw, th);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { tex, fbo, bytesPerPixel: state.format === gl.RGBA16F ? 8 : 4 };
  };

  S360.chooseMergeBatchSize = function (gl, w, h, requested = 4, budgetBytes = 768 * 1024 * 1024) {
      const units = Math.max(1, gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) - 1);
      const pixels = w * h;
      const accumBpp = gl.getExtension('EXT_color_buffer_float') ? 8 : 4;
      const fixedBytes = pixels * (accumBpp * 2 + 4);
      const affordable = Math.max(1, Math.floor((budgetBytes - fixedBytes) / Math.max(1, pixels * 4)));
      return Math.max(1, Math.min(requested, units, affordable));
  };

  // Main HDR processing function.
  // `modeLabel` (default 'HDR') lets the same GPU fusion loop be reused for
  // other merge types (e.g. the floating-point image stack in blend.js) with
  // progress messages that reflect the actual operation.
  S360.processAndMergeHDR = async function (gl, cfg, canvas, fileList, setLoading, scaleSource, loadImageFromFile, MAX_HDR_FRAMES = 64, MERGE_BATCH = 4, modeLabel = 'HDR', shouldCancel = null, analysis = null) {
      if (!fileList || fileList.length === 0) return;

      const totalFiles = fileList.length;
      if (totalFiles > MAX_HDR_FRAMES) {
          alert(`${modeLabel} merge supports up to ${MAX_HDR_FRAMES} frames; ${totalFiles} were selected.`);
          return;
      }

      const uScale = 1.0 / totalFiles;
      let w = 0, h = 0;
      let acc = null, tmp = null;
      let outTex = null, outFbo = null;
      const frameTex = [];
      const batchInfo = [];
      const robust = modeLabel === 'Stack';
      const checkCancelled = () => {
          if ((shouldCancel && shouldCancel()) || gl.isContextLost()) {
              throw new DOMException('Processing cancelled.', 'AbortError');
          }
      };
      const disposeTarget = target => {
          if (!target) return;
          gl.deleteTexture(target.tex); gl.deleteFramebuffer(target.fbo);
      };

      try {
          let processed = 0;
          let batchSize = MERGE_BATCH;
          let prog = null;
          while (processed < totalFiles) {
              checkCancelled();
              // The first decoded frame establishes dimensions and a memory-safe batch size.
              const desiredEnd = Math.min(processed + batchSize, totalFiles);
              for (let fileIndex = processed; fileIndex < desiredEnd; fileIndex++) {
                  checkCancelled();
                  setLoading(true, `Loading ${modeLabel} frame ${fileIndex + 1} of ${totalFiles}...`);
                  await new Promise(requestAnimationFrame);
                  let decoded = null, img = null;
                  try {
                      decoded = await loadImageFromFile(fileList[fileIndex]);
                      checkCancelled();
                      img = scaleSource(decoded);
                      if (img !== decoded) S360.releaseImage(decoded);
                      decoded = null;
                      S360.validateTextureSize(gl, img.width, img.height, `${modeLabel} frame ${fileIndex + 1}`);
                      if (w === 0) {
                          w = img.width; h = img.height;
                          batchSize = S360.chooseMergeBatchSize(gl, w, h, MERGE_BATCH);
                          acc = S360.makeAccumTarget(gl, w, h);
                          tmp = S360.makeAccumTarget(gl, w, h);
                          prog = S360.getHdrFuseProgram(gl, batchSize, getHdrState(gl).fusePrograms);
                      } else if (img.width !== w || img.height !== h) {
                          throw new Error(`${modeLabel} frame ${fileIndex + 1} is ${img.width}x${img.height}; expected ${w}x${h}.`);
                      }
                      const t = gl.createTexture();
                      if (!t) throw new Error('The GPU could not allocate a source texture.');
                      gl.activeTexture(gl.TEXTURE0 + frameTex.length);
                      gl.bindTexture(gl.TEXTURE_2D, t);
                      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
                      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                      frameTex.push(t);
                      const info = analysis?.frames?.[fileIndex] || { offset: [0, 0], exposureGain: 1, confidence: 1 };
                      const sx = w / Math.max(1, info.sourceSize?.[0] || w);
                      const sy = h / Math.max(1, info.sourceSize?.[1] || h);
                      const scaledInfo = { ...info, offset: [info.offset[0] * sx, info.offset[1] * sy] };
                      // Ignore unreliable registration rather than applying a damaging shift.
                      batchInfo.push(info.confidence < 0.08 ? { ...scaledInfo, offset: [0, 0] } : scaledInfo);
                  } finally {
                      S360.releaseImage(decoded);
                      S360.releaseImage(img);
                  }
                  if (frameTex.length >= batchSize) break;
              }

              checkCancelled();
              setLoading(true, `Fusing ${modeLabel} batch ${Math.floor(processed / batchSize) + 1} of ${Math.ceil(totalFiles / batchSize)}...`);
              await new Promise(requestAnimationFrame);
              S360.fuseBatch(gl, prog, frameTex, frameTex.length, w, h, acc.tex, tmp.fbo, uScale, cfg, batchInfo, robust && processed > 0, !!analysis?.stitched);
              const st = acc; acc = tmp; tmp = st;
              processed += frameTex.length;
              frameTex.splice(0).forEach(t => gl.deleteTexture(t));
              batchInfo.length = 0;
          }

          checkCancelled();
          // Tone mapping is applied for HDR merges (base < 1) to compress
          // dynamic range. The plain blend (base = 1, equal weights) skips it
          // to preserve the original tone curve for noise reduction.
          const useToneMap = cfg.hdr && cfg.hdr.base < 1;
          const finalProg = S360.getHdrFinalProgram(gl, useToneMap);
          outTex = gl.createTexture();
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, outTex);
          gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          outFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex, 0);
          S360.assertFramebufferComplete(gl, `${modeLabel} output`);
          gl.useProgram(finalProg); gl.bindVertexArray(S360.getQuadVAO(gl));
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, acc.tex);
          gl.uniform1i(finalProg._u.u_acc, 0);
          if (useToneMap) gl.uniform1f(finalProg._u.u_bright, cfg.hdr.brightness || 0);
          gl.viewport(0, 0, w, h); gl.drawArrays(gl.TRIANGLES, 0, 6);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          // Transfer the finished texture to the next GPU stage. The caller adopts
          // it as currentTexture, avoiding a full readPixels -> Canvas -> upload.
          const result = S360.createGpuImage(gl, outTex, outFbo, w, h, { orientation: 'fbo' });
          outTex = null; outFbo = null;
          return result;
      } finally {
          frameTex.forEach(t => gl.deleteTexture(t));
          disposeTarget(acc); disposeTarget(tmp);
          if (outTex) gl.deleteTexture(outTex);
          if (outFbo) gl.deleteFramebuffer(outFbo);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
  };
})(window.S360);
