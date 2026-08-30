// viewer.js
window.S360 = window.S360 || {};
(function (S360) {
  // Viewer-owned mutable state. Also touched by stitcher on new-source load and
  // WebGL context loss (see handleContextRestored / uploadTexture). Stitcher
  // reads/writes these via S360.viewerShared.* so the two stay in sync.
  S360.viewerShared = {
    sphere: null,           // interaction state { yaw, pitch, fov }
    sphereRaf: null,
    sphereFullTimer: null,
    sphereProgram: null,
    panoFullTex: null, panoFullFbo: null, panoFullW: 0, panoFullH: 0,
    panoWMTex: null, panoWMFbo: null, // watermarked full-res equirect (3D view)
    panoFullDirty: true,
  };

  const S = S360.viewerShared;

  const SPHERE_VS = `#version 300 es
    layout(location = 0) in vec2 a_pos;
    out vec2 v_ndc;
    void main() {
      v_ndc = a_pos;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  const SPHERE_FS = `#version 300 es
    precision highp float;
    in vec2 v_ndc;
    out vec4 fragColor;
    uniform sampler2D u_tex;
    uniform vec2 u_res;
    uniform float u_yaw;
    uniform float u_pitch;
    uniform float u_fov;
    uniform bool u_mirror;
    // Live Processing support: when sampling the RAW stitch texture (i.e. the
    // processed full-res texture hasn't been rebuilt yet), the exact same
    // post pipeline as createPostProgram runs here so slider drags update the
    // 3D view in real time instead of showing the unprocessed image.
    uniform float u_postOn;
    uniform float u_exposure;
    uniform float u_gamma;
    uniform float u_sharpen;
    uniform float u_saturation;
    uniform float u_contrast;
    uniform float u_temp;
    uniform sampler2D u_blurLum; // half-res blurred luminance (S360.ensureLumBlur)
    // Live watermark decal (S360.WM_GLSL / watermark.js).
    uniform float u_wmOn;
    uniform sampler2D u_wm;
    uniform float u_wmSize;
    uniform float u_wmAlpha;
    uniform float u_wmRot; // radians
    const float PI = 3.14159265358979323846;

    ${S360.POST_GLSL}
    ${S360.WM_GLSL}

    // (blurLum below is the half-res low-frequency luminance estimate built by
    // S360.ensureLumBlur — webgl-utils.js.)

    void main() {
      float aspect = u_res.x / max(u_res.y, 1.0);
      float t = tan(u_fov * 0.5);
      float cy = cos(u_yaw), sy = sin(u_yaw);
      float cp = cos(u_pitch), sp = sin(u_pitch);
      vec3 fwd = vec3(cp * sy, sp, cp * cy);
      vec3 worldUp = vec3(0.0, 1.0, 0.0);
      vec3 right = normalize(cross(fwd, worldUp));
      vec3 up = cross(right, fwd);
      vec3 ray = normalize(fwd + v_ndc.x * t * aspect * right + v_ndc.y * t * up);
      float lon = atan(ray.x, ray.z);
      float lat = asin(clamp(ray.y, -1.0, 1.0));
      float u = u_mirror ? (0.5 - lon / (2.0 * PI)) : (0.5 + lon / (2.0 * PI));
      float v = 0.5 + lat / PI;
      vec2 suv = vec2(u, v);
      vec3 color = texture(u_tex, suv).rgb;

      if (u_postOn > 0.5) {
        float blurLum = texture(u_blurLum, suv).r;
        color = s360ApplyPost(color, blurLum, u_exposure, u_gamma, u_sharpen,
                              u_saturation, u_contrast, u_temp);
      }

      if (u_wmOn > 0.5) {
        color = s360CompositeWM(color, u_wm, suv, u_wmSize, u_wmAlpha, u_wmRot);
      }

      fragColor = vec4(color, 1.0);
    }
  `;

  // ---- Main-context spherical renderer ----
  // Compiles the same equirect->sphere ray-march shader against the MAIN gl
  // context (instead of the sphere viewer's separate context) so the 3D view can
  // sample the stitched FBO texture directly — no readback / re-upload / CPU flip.
  S360.getSphereProgram = function (gl) {
    if (!S.sphereProgram) {
      S.sphereProgram = S360.createProgram(gl, SPHERE_VS, SPHERE_FS);
      S.sphereProgram._u = {
        u_res:    gl.getUniformLocation(S.sphereProgram, 'u_res'),
        u_yaw:    gl.getUniformLocation(S.sphereProgram, 'u_yaw'),
        u_pitch:  gl.getUniformLocation(S.sphereProgram, 'u_pitch'),
        u_fov:    gl.getUniformLocation(S.sphereProgram, 'u_fov'),
        u_tex:    gl.getUniformLocation(S.sphereProgram, 'u_tex'),
        u_mirror: gl.getUniformLocation(S.sphereProgram, 'u_mirror'),
        u_postOn:     gl.getUniformLocation(S.sphereProgram, 'u_postOn'),
        u_exposure:   gl.getUniformLocation(S.sphereProgram, 'u_exposure'),
        u_gamma:      gl.getUniformLocation(S.sphereProgram, 'u_gamma'),
        u_sharpen:    gl.getUniformLocation(S.sphereProgram, 'u_sharpen'),
        u_saturation: gl.getUniformLocation(S.sphereProgram, 'u_saturation'),
        u_contrast:   gl.getUniformLocation(S.sphereProgram, 'u_contrast'),
        u_temp:       gl.getUniformLocation(S.sphereProgram, 'u_temp'),
        u_blurLum:    gl.getUniformLocation(S.sphereProgram, 'u_blurLum'),
        u_wmOn:       gl.getUniformLocation(S.sphereProgram, 'u_wmOn'),
        u_wm:         gl.getUniformLocation(S.sphereProgram, 'u_wm'),
        u_wmSize:     gl.getUniformLocation(S.sphereProgram, 'u_wmSize'),
        u_wmAlpha:    gl.getUniformLocation(S.sphereProgram, 'u_wmAlpha'),
        u_wmRot:      gl.getUniformLocation(S.sphereProgram, 'u_wmRot'),
      };
    }
    return S.sphereProgram;
  };

  // Renders the sphere view into the MAIN canvas using the given equirect texture.
  // `opts`: { tex, yaw, pitch, fov, mirror, post, texSize }. Pure GPU path; no
  // CPU readback. When `post` is provided (the Processing uniform values) the
  // sphere shader applies the identical post pipeline inline — used for
  // real-time slider feedback while sampling the raw stitch texture.
  S360.renderSphereInline = function (gl, panoramaCanvas, opts) {
    const prog = S360.getSphereProgram(gl);
    const dpr = window.devicePixelRatio || 1;
    const dw = Math.max(1, Math.round(panoramaCanvas.clientWidth * dpr));
    const dh = Math.max(1, Math.round(panoramaCanvas.clientHeight * dpr));
    if (panoramaCanvas.width !== dw || panoramaCanvas.height !== dh) {
      panoramaCanvas.width = dw;
      panoramaCanvas.height = dh;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, panoramaCanvas.width, panoramaCanvas.height);
    // The main context is shared with the stitch path, which leaves the stitch
    // program active. Without re-selecting the sphere program here, the post-
    // stitch draw uses the wrong shader — the view only updates when re-entering
    // 3D mode (which re-creates/uses the sphere program). So always re-bind it.
    gl.useProgram(prog);
    const u = S.sphereProgram._u;
    gl.uniform2f(u.u_res, panoramaCanvas.width, panoramaCanvas.height);
    gl.uniform1f(u.u_yaw, opts.yaw || 0);
    gl.uniform1f(u.u_pitch, opts.pitch || 0);
    gl.uniform1f(u.u_fov, opts.fov != null ? opts.fov : Math.PI / 2);
    gl.uniform1i(u.u_mirror, opts.mirror ? 1 : 0);
    const p = opts.post;
    gl.uniform1f(u.u_postOn, p ? 1 : 0);
    if (p) {
      gl.uniform1f(u.u_exposure, p.exposure);
      gl.uniform1f(u.u_gamma, p.gamma);
      gl.uniform1f(u.u_sharpen, p.sharpen);
      gl.uniform1f(u.u_saturation, p.saturation);
      gl.uniform1f(u.u_contrast, p.contrast);
      gl.uniform1f(u.u_temp, p.temperature);
      // Half-res luminance blur for the unsharp mask (built in renderSphere).
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, opts.blurTex || null);
      gl.uniform1i(u.u_blurLum, 1);
      const wmo = opts.wm;
      gl.uniform1f(u.u_wmOn, wmo ? 1 : 0);
      if (wmo) {
        gl.uniform1f(u.u_wmSize, wmo.size);
        gl.uniform1f(u.u_wmAlpha, wmo.alpha);
        gl.uniform1f(u.u_wmRot, wmo.rot);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, wmo.tex);
        gl.uniform1i(u.u_wm, 2);
      }
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, opts.tex);
    gl.uniform1i(u.u_tex, 0);
    gl.bindVertexArray(S360.getQuadVAO(gl));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  // Single-context sphere viewer: the sphere is drawn into the MAIN panoramaCanvas
  // using the main gl context (see renderSphereInline / getSphereProgram). No
  // separate WebGL context, canvas, or texture upload is needed — the stitched
  // FBO texture is sampled directly.
  S360.initSphereViewer = function (gl, panoramaCanvas, ctx) {
     const s = { yaw: 0, pitch: 0, fov: Math.PI / 2 };

     // After a WebGL context loss S.sphere is nulled but the canvas element
     // (and its previously-attached listeners) survive. Track attachment so a
     // later re-init doesn't stack a second set of handlers.
     if (S._listenersAttached) return s;
     S._listenersAttached = true;

     let dragging = false, lx = 0, ly = 0;
    const onDown = (x, y) => {
      if (ctx.getViewMode() !== '3d') return;
      dragging = true; lx = x; ly = y; panoramaCanvas.style.cursor = 'grabbing';
    };
    const onMove = (x, y) => {
      if (!dragging || ctx.getViewMode() !== '3d') return;
      const dx = x - lx, dy = y - ly;
      lx = x; ly = y;
      const k = s.fov / Math.max(1, panoramaCanvas.clientHeight);
      // Grab-style panning: dragging right pulls the panorama right (scene
      // follows the cursor), matching the vertical drag behaviour.
      s.yaw += dx * k;
      s.pitch = Math.max(-1.4, Math.min(1.4, s.pitch + dy * k));
      S360.renderSphere(ctx);
    };
    const onUp = () => {
      dragging = false;
      if (ctx.updateCanvasCursor) ctx.updateCanvasCursor();
      else panoramaCanvas.style.cursor = 'grab';
    };

    panoramaCanvas.addEventListener('mousedown', e => onDown(e.clientX, e.clientY));
    window.addEventListener('mousemove', e => onMove(e.clientX, e.clientY));
    window.addEventListener('mouseup', onUp);
    panoramaCanvas.addEventListener('wheel', e => {
      e.preventDefault();
      s.fov *= (1 + Math.sign(e.deltaY) * 0.1);
      s.fov = Math.max(0.35, Math.min(2.2, s.fov));
      S360.renderSphere(ctx);
    }, { passive: false });
    panoramaCanvas.addEventListener('touchstart', e => {
      if (e.touches.length === 1) onDown(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    panoramaCanvas.addEventListener('touchmove', e => {
      if (e.touches.length === 1) onMove(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    panoramaCanvas.addEventListener('touchend', onUp);

    return s;
  };

  S360.renderSphere = function (ctx) {
    const { gl, panoramaCanvas } = ctx;
    if (!S.sphere || ctx.getViewMode() !== '3d') return;
    // The sphere ALWAYS samples the raw stitch and grades/composites live:
    // post via s360ApplyPost, watermark decal via s360CompositeWM. No baked
    // textures on the display path.
    const tex = S360.getSphereSourceTexture(ctx);
    if (!tex) return;
    const postLive = ctx.getPostEnabled();
    let blurTex = null;
    if (postLive) {
      const pu = ctx.postUniforms;
      // Cached half-res luminance blur for the live unsharp mask. Cheap when
      // exposure/gamma haven't changed (saturation/contrast/sharpen drags skip it).
      blurTex = S360.ensureLumBlur(gl, tex, tex.width || 1, tex.height || 1, pu.exposure, pu.gamma).tex;
    }
    S360.renderSphereInline(gl, panoramaCanvas, {
      tex, yaw: S.sphere.yaw, pitch: S.sphere.pitch, fov: S.sphere.fov, mirror: ctx.getCfg().mirror3D,
      post: postLive ? ctx.postUniforms : null,
      blurTex,
      wm: ctx.getWmLoaded() ? { tex: ctx.getWmTex(), size: ctx.getWmSize(), alpha: ctx.getWmAlpha(), rot: ctx.getWmRotDeg() * Math.PI / 180 } : null,
    });
  };

  // Builds the full-resolution, post-processed equirect entirely on the GPU in the
  // main context (no readback, no CPU flip, no re-upload). The result lives in
  // panoFullTex/panoFullFbo and is sampled directly by the 3D viewer.
  S360.buildFullResPano = function (ctx) {
    const { gl, panoramaCanvas, MAX_TEX_SIZE, getCfg, getCurrentImg, getPostEnabled,
            getWmLoaded, getWmTex, getWmSize, getWmAlpha, getWmRotDeg, getWmProg,
            getRenderTexture, renderWithPostProcessing, stitchIfNeeded } = ctx;
    if (!getCurrentImg()) return;
    const fullW0 = Math.min(getCurrentImg().width, MAX_TEX_SIZE);
    const fullH0 = Math.round(fullW0 / 2);
    const { w, h } = S360.clampToGpuLimits(gl, fullW0, fullH0);

    // The baked equirect exists ONLY for the watermark decal. Without a watermark
    // the sphere grades the raw stitch live in-shader (cheaper, and immune to
    // bake-ordering issues), so skip the bake entirely. Stale baked textures are
    // dropped by reference only — deleting them here is unsafe for the same
    // WebGL name-recycling reasons documented in webgl-utils.js.
    const wmActive = getWmLoaded() && getWmTex();
    if (!wmActive) {
      S.panoFullTex = null; S.panoFullFbo = null;
      S.panoWMTex = null;   S.panoWMFbo = null;
      S.panoFullW = 0; S.panoFullH = 0;
      S.panoFullDirty = false;
      return;
    }

    if ((!S.panoFullTex || S.panoFullW !== w || S.panoFullH !== h)) {
      if (S.panoFullTex) { gl.deleteTexture(S.panoFullTex); gl.deleteFramebuffer(S.panoFullFbo); }
      S.panoFullTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, S.panoFullTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      S.panoFullFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, S.panoFullFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, S.panoFullTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      S.panoFullW = w; S.panoFullH = h;
    }

    // Ensure the shared stitch FBO is at full resolution.
    stitchIfNeeded(w, h, true);

    if (getPostEnabled()) renderWithPostProcessing(w, h, S.panoFullFbo);

    if (getWmLoaded() && getWmTex()) {
      if (!S.panoWMTex || S.panoFullW !== w || S.panoFullH !== h) {
        if (S.panoWMTex) { gl.deleteTexture(S.panoWMTex); gl.deleteFramebuffer(S.panoWMFbo); }
        S.panoWMTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, S.panoWMTex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        S.panoWMFbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, S.panoWMFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, S.panoWMTex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      const srcTex = getPostEnabled() ? S.panoFullTex : getRenderTexture();
      S360.compositeWatermark(gl, getWmProg(), srcTex, w, h, S.panoWMFbo, getWmTex(), getWmSize(), getWmAlpha(), getWmRotDeg());
    }

    S.panoFullW = w; S.panoFullH = h;
    S.panoFullDirty = false;
  };

  // Step 3: the 3D view always samples the RAW stitch texture — grading and the
  // watermark decal are applied live in SPHERE_FS.
  S360.getSphereSourceTexture = function (ctx) {
    return ctx.getRenderTexture();
  };

  // Rebuild path retired: the 3D view grades + composites live in-shader, so a
  // "refresh" is just an immediate sphere redraw.
  S360.refreshSphereFromTexture = function (ctx) {
    S360.renderSphere(ctx);
  };

  // Retired with the full-res bake — kept as a no-op so existing call sites
  // (slider handlers, wm handlers) stay valid without changes.
  S360.scheduleSphereFullResRefresh = function () {};

  S360.scheduleViewerUpdate = function (ctx) {
    const { getCurrentImg } = ctx;
    if (ctx.getViewMode() !== '3d' || !S.sphere || !getCurrentImg()) return;
    if (S.sphereRaf) return;
    S.sphereRaf = requestAnimationFrame(() => {
      S.sphereRaf = null;
      S360.renderSphere(ctx);
    });
    S360.scheduleSphereFullResRefresh(ctx);
  };

  S360.setViewMode = function (mode, ctx) {
    const { gl, panoramaCanvas, renderPano, getViewModeBtn, getViewerContainer } = ctx;
    ctx.setViewModeValue(mode);
    if (mode === '3d') {
      if (!ctx.getCurrentImg()) {
        alert('Please load an image first.');
        ctx.setViewModeValue('2d');
        return;
      }
      if (ctx.disableSchematic) ctx.disableSchematic();
      if (getViewerContainer()) getViewerContainer().classList.add('hidden');
      panoramaCanvas.classList.add('viewer-3d');
      panoramaCanvas.style.cursor = 'grab';
      if (!S.sphere) S.sphere = S360.initSphereViewer(gl, panoramaCanvas, ctx);
      // Force the full-resolution re-stitch now: renderPano()'s 3D branch
      // re-stitches the offscreen FBO at full source resolution (the 2D preview
      // left it at PREVIEW_MAX_W), then refreshSphereFromTexture draws the
      // sphere from that full-res texture so 3D matches the 2D export.
      S.panoFullDirty = true;
      renderPano();
      S360.refreshSphereFromTexture(ctx);
      if (getViewModeBtn()) getViewModeBtn().textContent = '2D';
    } else {
      if (getViewerContainer()) getViewerContainer().classList.add('hidden');
      panoramaCanvas.classList.remove('viewer-3d');
      if (ctx.updateCanvasCursor) ctx.updateCanvasCursor();
      if (getViewModeBtn()) getViewModeBtn().textContent = '3D';
      // Release full-res viewer textures — they're only needed in 3D view.
      // This frees significant VRAM (up to 1 GiB for 16K sources) and the
      // textures will be rebuilt lazily if the user switches back to 3D.
      if (S.panoFullTex) { gl.deleteTexture(S.panoFullTex); S.panoFullTex = null; }
      if (S.panoFullFbo) { gl.deleteFramebuffer(S.panoFullFbo); S.panoFullFbo = null; }
      if (S.panoWMTex) { gl.deleteTexture(S.panoWMTex); S.panoWMTex = null; }
      if (S.panoWMFbo) { gl.deleteFramebuffer(S.panoWMFbo); S.panoWMFbo = null; }
      S.panoFullW = 0; S.panoFullH = 0;
      S.panoFullDirty = true; // rebuild if switching back to 3D
      renderPano(); // redraw the equirect onto the canvas
    }
  };
})(window.S360);
