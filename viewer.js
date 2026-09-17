// viewer.js
window.S360 = window.S360 || {};
(function (S360) {
'use strict';
  // Module-scoped viewer state. Nothing outside this module mutates these
  // directly; the S360.viewer accessors below are the public contract, so
  // callers can't accidentally rearrange the projection/camera bookkeeping.
  const viewerState = {
    sphere: null,           // interaction state { yaw, pitch, fov }
    sphereRaf: null,
    sphereProgram: null,
    proj: 1,                // projection blend s: 1 = rectilinear (flat), 0.5 = stereographic
    mirror: false,
    canvasWidth: 1,
    canvasHeight: 1,
    _listenersAttached: false,
  };

  const S = viewerState;

  // Public, read-only-ish view of viewer state. Consumers read the camera and
  // projection here instead of mutating a shared bag.
  S360.viewer = {
    getSphere: () => viewerState.sphere,
    getPanoramaUvAt(nx, ny) {
      if (!viewerState.sphere || nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
      let viewX = nx * 2.0 - 1.0;
      if (S360.compare?.isActive) {
        if (nx < 0.5) return null;
        viewX = nx * 4.0 - 3.0;
      }
      const aspect = (S360.compare?.isActive ? 0.5 : 1.0) *
        (viewerState.canvasWidth || 1) / Math.max(1, viewerState.canvasHeight || 1);
      const qx = viewX * aspect;
      const qy = 1.0 - ny * 2.0;
      const s = viewerState.proj;
      const fov = viewerState.sphere.fov;
      const cy = Math.cos(viewerState.sphere.yaw), sy = Math.sin(viewerState.sphere.yaw);
      const cp = Math.cos(viewerState.sphere.pitch), sp = Math.sin(viewerState.sphere.pitch);
      const fwd = [cp * sy, sp, cp * cy];
      // Match SPHERE_FS and drawing-projection.js exactly. The old opposite
      // cross-product order mirrored every CPU screen-to-panorama lookup.
      const right = [-fwd[2], 0, fwd[0]];
      const rightLength = Math.hypot(right[0], right[2]) || 1;
      right[0] /= rightLength; right[2] /= rightLength;
      const up = [
        right[1] * fwd[2] - right[2] * fwd[1],
        right[2] * fwd[0] - right[0] * fwd[2],
        right[0] * fwd[1] - right[1] * fwd[0],
      ];
      const qLength = Math.hypot(qx, qy);
      const theta = Math.atan(qLength * Math.tan(s * fov * 0.5)) / s;
      const k = Math.sin(theta) / Math.max(qLength, 1e-6);
      const ray = [
        fwd[0] * Math.cos(theta) + (right[0] * qx + up[0] * qy) * k,
        fwd[1] * Math.cos(theta) + (right[1] * qx + up[1] * qy) * k,
        fwd[2] * Math.cos(theta) + (right[2] * qx + up[2] * qy) * k,
      ];
      const lon = Math.atan2(ray[0], ray[2]);
      const lat = Math.asin(Math.max(-1, Math.min(1, ray[1])));
      const mirror = viewerState.mirror ? -1 : 1;
      return {
        u: (0.5 + mirror * lon / (2 * Math.PI) + 1) % 1,
        v: 0.5 + lat / Math.PI,
      };
    },
    setSphere: (s) => { viewerState.sphere = s; },
    getProj: () => viewerState.proj,
    setProj: (v) => { S360.drawing?.beforeViewChange(); viewerState.proj = v; },
    // Clamped pitch preset for the up/level/down buttons: applies to the live
    // sphere and reports whether there was one to move.
    setPitch(pitch) {
      S360.drawing?.beforeViewChange();
      if (!viewerState.sphere) return false;
      viewerState.sphere.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
      return true;
    },
    cancelSphereRaf() {
      if (viewerState.sphereRaf !== null) cancelAnimationFrame(viewerState.sphereRaf);
      viewerState.sphereRaf = null;
    },
  };

  // Allow looking straight up/down. We stop just short of the exact pole so the
  // sphere shader's cross(fwd, worldUp) never degenerates to a zero vector.
  const MAX_PITCH = Math.PI / 2 - 0.001;

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
    uniform sampler2D u_compareTex;
    uniform float u_compareOn;
    uniform vec2 u_res;
    uniform float u_yaw;
    uniform float u_pitch;
    uniform float u_fov;
    uniform bool u_mirror;
    uniform float u_projS; // projection blend s: 1 = rectilinear (flat), 0.5 = stereographic (spherical)
    // Live Processing support: when sampling the RAW stitch texture (i.e. the
    // processed full-res texture hasn't been rebuilt yet), the exact same
    // post pipeline as createPostProgram runs here so slider drags update the
    // 3D view in real time instead of showing the unprocessed image.
    uniform float u_postOn;
    uniform float u_exposure;
    uniform float u_gamma;
    uniform float u_sharpen;
    uniform float u_clarity;
    uniform float u_saturation;
    uniform float u_contrast;
    uniform float u_temp;
    uniform sampler2D u_blurLum;       // half-res blurred luminance (S360.ensureLumBlur)
    // Live watermark decals (S360.WM_GLSL / watermark.js). Two independent
    // slots: nadir (bottom, u_wm*B) and zenith (top, u_wm*T).
    uniform float u_wmBOn;
    uniform sampler2D u_wmB;
    uniform float u_wmBSize;
    uniform float u_wmBAlpha;
    uniform float u_wmBRot; // radians
    uniform float u_wmTOn;
    uniform sampler2D u_wmT;
    uniform float u_wmTSize;
    uniform float u_wmTAlpha;
    uniform float u_wmTRot; // radians
    // Warp deformation map: when active, offsets the texture UV lookup.
    uniform float u_warpOn;
    uniform sampler2D u_warpMap;
    uniform sampler2D u_warpLens;
    uniform sampler2D u_warpOther;
    uniform vec2 u_warpDim;   // map dimensions in pixels
    uniform vec2 u_srcDim;    // source/stitch texture dimensions
    const float PI = 3.14159265358979323846;

    ${S360.POST_GLSL}
    ${S360.WM_GLSL}

    float unpackWarp16(vec2 packed) {
      vec2 bytes = floor(packed * 255.0 + 0.5);
      return (bytes.x * 256.0 + bytes.y) / 65535.0;
    }
    vec2 fetchWarp(ivec2 coord) {
      coord = clamp(coord, ivec2(0), ivec2(u_warpDim) - ivec2(1));
      vec4 value = texelFetch(u_warpMap, coord, 0);
      return vec2(unpackWarp16(value.rg), unpackWarp16(value.ba));
    }
    vec2 sampleWarp(vec2 pixel) {
      vec2 q = clamp(pixel - 0.5, vec2(0.0), u_warpDim - 1.0);
      ivec2 lo = ivec2(floor(q));
      ivec2 hi = min(lo + ivec2(1), ivec2(u_warpDim) - ivec2(1));
      vec2 f = fract(q);
      vec2 top = mix(fetchWarp(lo), fetchWarp(ivec2(hi.x, lo.y)), f.x);
      vec2 bottom = mix(fetchWarp(ivec2(lo.x, hi.y)), fetchWarp(hi), f.x);
      return mix(top, bottom, f.y);
    }

    // (blurLum below is the half-res low-frequency luminance estimate built by
    // S360.ensureLumBlur — webgl-utils.js.)

    void main() {
      bool referenceSide = u_compareOn > 0.5 && v_ndc.x < 0.0;
      vec2 viewNdc = v_ndc;
      float viewWidth = u_res.x;
      if (u_compareOn > 0.5) {
        viewNdc.x = referenceSide ? v_ndc.x * 2.0 + 1.0 : v_ndc.x * 2.0 - 1.0;
        viewWidth *= 0.5;
      }
      float aspect = viewWidth / max(u_res.y, 1.0);
      float cy = cos(u_yaw), sy = sin(u_yaw);
      float cp = cos(u_pitch), sp = sin(u_pitch);
      vec3 fwd = vec3(cp * sy, sp, cp * cy);
      vec3 worldUp = vec3(0.0, 1.0, 0.0);
      vec3 right = normalize(cross(fwd, worldUp));
      vec3 up = cross(right, fwd);
      vec2 q_base = vec2(viewNdc.x * aspect, viewNdc.y);
      float t = tan(u_projS * u_fov * 0.5);
      float baseTheta = atan(length(q_base) * t) / u_projS;
      float baseK = sin(baseTheta) / max(length(q_base), 1e-6);
      vec3 baseRay = fwd * cos(baseTheta) + (right * q_base.x + up * q_base.y) * baseK;
      vec3 ray;
      {
        // Generalized projection: the pixel radius r(θ) = tan(s·θ)/tan(s·fov/2)
        // is exactly rectilinear at s = 1 and stereographic at s = 0.5, blending
        // smoothly between them (mirrors drawing-projection.js). s·fov/2 stays
        // below π/2 for every supported fov, so tan is always finite. The
        // centre pixel (q = 0) aims straight ahead; sin(θ)/|q| → T/s there.
        // Apply warp deformation map BEFORE ray computation: the map lives in
      // view pixel space and redirects each screen pixel to its original source.
      vec2 q_raw = q_base;
      if (u_warpOn > 0.5 && !referenceSide) {
        // NDC → view pixel → sample map → back to NDC
        vec2 pix = vec2((viewNdc.x + 1.0) * 0.5, (1.0 - viewNdc.y) * 0.5) * u_warpDim;
        vec2 orig = sampleWarp(pix);
        vec2 newNDC = vec2(orig.x * 2.0 - 1.0, 1.0 - orig.y * 2.0);
        q_raw = vec2(newNDC.x * aspect, newNDC.y);
      }
      float theta = atan(length(q_raw) * t) / u_projS;
      // Directions beyond the antipode repeat; leave that region unpaintable.
      if (theta >= PI - 1e-7) { fragColor = vec4(0.025, 0.025, 0.025, 1.0); return; }
      float k = sin(theta) / max(length(q_raw), 1e-6);
      ray = fwd * cos(theta) + (right * q_raw.x + up * q_raw.y) * k;
      }
      float lon = atan(baseRay.x, baseRay.z);
      float lat = asin(clamp(baseRay.y, -1.0, 1.0));
      float u = u_mirror ? (0.5 - lon / (2.0 * PI)) : (0.5 + lon / (2.0 * PI));
      float v = 0.5 + lat / PI;
      vec2 suv = vec2(u, v);
      vec3 color;
      // Warp overwrites color entirely, so skip the main stitch fetch on that path.
      if (u_warpOn > 0.5 && !referenceSide) {
        vec4 otherLens = texture(u_warpOther, suv);
        float warpLon = atan(ray.x, ray.z);
        float warpLat = asin(clamp(ray.y, -1.0, 1.0));
        float warpU = u_mirror ? (0.5 - warpLon / (2.0 * PI)) : (0.5 + warpLon / (2.0 * PI));
        vec4 movedLens = texture(u_warpLens, vec2(warpU, 0.5 + warpLat / PI));
        color = clamp(otherLens.rgb * otherLens.a * 0.5 + movedLens.rgb * movedLens.a, 0.0, 1.0);
      } else {
        // ImageBitmap uploads keep their top-row-first orientation regardless of
        // UNPACK_FLIP_Y_WEBGL, so normalize the standalone reference here.
        if (referenceSide) color = texture(u_compareTex, vec2(suv.x, 1.0 - suv.y)).rgb;
        else color = texture(u_tex, suv).rgb;
      }

      if (u_postOn > 0.5 && !referenceSide) {
        float blurLum = 0.0;
        if (u_sharpen > 0.0 || u_clarity > 0.0) blurLum = texture(u_blurLum, suv).r;
        color = s360ApplyPost(color, blurLum, u_exposure, u_gamma, u_sharpen, u_clarity,
                              u_saturation, u_contrast, u_temp);
      }

      if (u_wmBOn > 0.5 && !referenceSide) {
        color = s360CompositeWM(color, u_wmB, suv, u_wmBSize, u_wmBAlpha, u_wmBRot, 0.0);
      }
      if (u_wmTOn > 0.5 && !referenceSide) {
        color = s360CompositeWM(color, u_wmT, suv, u_wmTSize, u_wmTAlpha, u_wmTRot, 1.0);
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
        u_compareTex: gl.getUniformLocation(S.sphereProgram, 'u_compareTex'),
        u_compareOn: gl.getUniformLocation(S.sphereProgram, 'u_compareOn'),
        u_mirror: gl.getUniformLocation(S.sphereProgram, 'u_mirror'),
        u_projS: gl.getUniformLocation(S.sphereProgram, 'u_projS'),
        u_postOn:     gl.getUniformLocation(S.sphereProgram, 'u_postOn'),
        u_exposure:   gl.getUniformLocation(S.sphereProgram, 'u_exposure'),
        u_gamma:      gl.getUniformLocation(S.sphereProgram, 'u_gamma'),
        u_sharpen:    gl.getUniformLocation(S.sphereProgram, 'u_sharpen'),
        u_clarity:    gl.getUniformLocation(S.sphereProgram, 'u_clarity'),
        u_saturation: gl.getUniformLocation(S.sphereProgram, 'u_saturation'),
        u_contrast:   gl.getUniformLocation(S.sphereProgram, 'u_contrast'),
        u_temp:       gl.getUniformLocation(S.sphereProgram, 'u_temp'),
        u_blurLum:    gl.getUniformLocation(S.sphereProgram, 'u_blurLum'),
        u_wmBOn:      gl.getUniformLocation(S.sphereProgram, 'u_wmBOn'),
        u_wmB:        gl.getUniformLocation(S.sphereProgram, 'u_wmB'),
        u_wmBSize:    gl.getUniformLocation(S.sphereProgram, 'u_wmBSize'),
        u_wmBAlpha:   gl.getUniformLocation(S.sphereProgram, 'u_wmBAlpha'),
        u_wmBRot:     gl.getUniformLocation(S.sphereProgram, 'u_wmBRot'),
        u_wmTOn:      gl.getUniformLocation(S.sphereProgram, 'u_wmTOn'),
        u_wmT:        gl.getUniformLocation(S.sphereProgram, 'u_wmT'),
        u_wmTSize:    gl.getUniformLocation(S.sphereProgram, 'u_wmTSize'),
        u_wmTAlpha:   gl.getUniformLocation(S.sphereProgram, 'u_wmTAlpha'),
        u_wmTRot:     gl.getUniformLocation(S.sphereProgram, 'u_wmTRot'),
        u_warpOn:     gl.getUniformLocation(S.sphereProgram, 'u_warpOn'),
        u_warpMap:    gl.getUniformLocation(S.sphereProgram, 'u_warpMap'),
        u_warpLens:   gl.getUniformLocation(S.sphereProgram, 'u_warpLens'),
        u_warpOther:  gl.getUniformLocation(S.sphereProgram, 'u_warpOther'),
        u_warpDim:    gl.getUniformLocation(S.sphereProgram, 'u_warpDim'),
      };
    }
    return S.sphereProgram;
  };

  // Renders the sphere view into the MAIN canvas using the given equirect texture.
  // `opts`: { tex, yaw, pitch, fov, mirror, post, texSize, wmB, wmT }. Pure GPU
  // path; no CPU readback. When `post` is provided (the Processing uniform
  // values) the sphere shader applies the identical post pipeline inline — used
  // for real-time slider feedback while sampling the raw stitch texture. The
  // watermark decals (wmB / wmT) are composited inline unconditionally: they
  // must stay visible whether Processing is ON or OFF.
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
    viewerState.canvasWidth = panoramaCanvas.width;
    viewerState.canvasHeight = panoramaCanvas.height;
    viewerState.mirror = !!opts.mirror;
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
    gl.uniform1f(u.u_projS, opts.proj != null ? opts.proj : 1);
    const p = opts.post;
    gl.uniform1f(u.u_postOn, p ? 1 : 0);
    if (p) {
      gl.uniform1f(u.u_exposure, p.exposure);
      gl.uniform1f(u.u_gamma, p.gamma);
      gl.uniform1f(u.u_sharpen, p.sharpen);
      gl.uniform1f(u.u_clarity, p.clarity);
      gl.uniform1f(u.u_saturation, p.saturation);
      gl.uniform1f(u.u_contrast, p.contrast);
      gl.uniform1f(u.u_temp, p.temperature);
      // Half-res luminance blur for the unsharp mask (built in renderSphere).
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, opts.blurTex || opts.tex);
      gl.uniform1i(u.u_blurLum, 1);
    }
    // Watermark decals are independent of Processing — they must stay applied
    // whether post is on or off, so bind them unconditionally.
    const wmB = opts.wmB;
    gl.uniform1f(u.u_wmBOn, wmB ? 1 : 0);
    if (wmB) {
      gl.uniform1f(u.u_wmBSize, wmB.size);
      gl.uniform1f(u.u_wmBAlpha, wmB.alpha);
      gl.uniform1f(u.u_wmBRot, wmB.rot);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, wmB.tex);
      gl.uniform1i(u.u_wmB, 2);
    }
    const wmT = opts.wmT;
    gl.uniform1f(u.u_wmTOn, wmT ? 1 : 0);
    if (wmT) {
      gl.uniform1f(u.u_wmTSize, wmT.size);
      gl.uniform1f(u.u_wmTAlpha, wmT.alpha);
      gl.uniform1f(u.u_wmTRot, wmT.rot);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, wmT.tex);
      gl.uniform1i(u.u_wmT, 3);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, opts.tex);
    gl.uniform1i(u.u_tex, 0);
    const compareTex = opts.compareTex || null;
    gl.uniform1f(u.u_compareOn, compareTex ? 1 : 0);
    if (compareTex) {
      gl.activeTexture(gl.TEXTURE7);
      gl.bindTexture(gl.TEXTURE_2D, compareTex);
      gl.uniform1i(u.u_compareTex, 7);
    }
    // Warp deformation map: bind if an active warp session provides it.
    const warpTex = opts.warpTex || S360.viewWarp?._previewTex;
    const warpLensTex = opts.warpLensTex || S360.viewWarp?._previewLensTex;
    const warpOtherTex = opts.warpOtherTex || S360.viewWarp?._previewOtherTex;
    const warpDim = opts.warpDim || S360.viewWarp?._previewDim;
    const hasWarp = warpTex && warpLensTex && warpOtherTex && warpDim && warpDim[0] > 0;
    gl.uniform1f(u.u_warpOn, hasWarp ? 1 : 0);
    if (hasWarp) {
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, warpTex);
      gl.uniform1i(u.u_warpMap, 4);
      gl.uniform2f(u.u_warpDim, warpDim[0], warpDim[1]);
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, warpLensTex);
      gl.uniform1i(u.u_warpLens, 5);
      gl.activeTexture(gl.TEXTURE6);
      gl.bindTexture(gl.TEXTURE_2D, warpOtherTex);
      gl.uniform1i(u.u_warpOther, 6);
    }
    gl.bindVertexArray(S360.getQuadVAO(gl));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  // Single-context sphere viewer: the sphere is drawn into the MAIN panoramaCanvas
  // using the main gl context (see renderSphereInline / getSphereProgram). No
  // separate WebGL context, canvas, or texture upload is needed — the stitched
  // FBO texture is sampled directly.
  S360.initSphereViewer = function (gl, panoramaCanvas, ctx) {
     const s = S.sphere || { yaw: 0, pitch: 0, fov: Math.PI / 2 };
     S.sphere = s;

     // After a WebGL context loss S.sphere is nulled but the canvas element
     // (and its previously-attached listeners) survive. Track attachment so a
     // later re-init doesn't stack a second set of handlers.
     if (S._listenersAttached) return s;
     S._listenersAttached = true;

     let dragging = false, lx = 0, ly = 0;
     const onDown = (x, y) => {
       if (ctx.getViewMode() !== '3d') return;
       if (!ctx.getSphereInteractionEnabled()) return;
       dragging = true; lx = x; ly = y; panoramaCanvas.style.cursor = 'grabbing';
     };
     const onMove = (x, y) => {
       if (!dragging || ctx.getViewMode() !== '3d') return;
        if (!ctx.getSphereInteractionEnabled()) return;
       const dx = x - lx, dy = y - ly;
      lx = x; ly = y;
      const k = s.fov / Math.max(1, panoramaCanvas.clientHeight);
      // Grab-style panning: dragging right pulls the panorama right (scene
      // follows the cursor), matching the vertical drag behaviour.
      s.yaw += dx * k;
      s.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, s.pitch + dy * k));
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
       if (ctx.getViewMode() !== '3d') return;
       e.preventDefault();
        if (!ctx.getSphereInteractionEnabled()) return;
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
    const tex = ctx.getRenderTexture();
    if (!tex) return;
    const postLive = ctx.getPostEnabled();
    let blurTex = null;
    if (postLive) {
      const pu = ctx.postUniforms;
      if (pu.sharpen > 0 || pu.clarity > 0) {
        // Cached half-res luminance blur for the live unsharp mask. Cheap when
        // exposure/gamma haven't changed (saturation/contrast/sharpen drags skip it).
        blurTex = S360.ensureLumBlur(gl, tex, tex.width || 1, tex.height || 1, pu.exposure, pu.gamma).tex;
      } else {
        S360.invalidateBlurCache(gl);
        blurTex = tex;
      }
    }
    const toDecal = slot => slot.active
      ? { tex: slot.tex, size: slot.size, alpha: slot.alpha, rot: slot.rotDeg * Math.PI / 180 }
      : null;
    const slots = S360.stitchDecal.decals;
    S360.renderSphereInline(gl, panoramaCanvas, {
      tex, yaw: S.sphere.yaw, pitch: S.sphere.pitch, fov: S.sphere.fov, mirror: ctx.getCfg().mirror3D,
      proj: S.proj,
      compareTex: S360.compare?.getTexture?.() || null,
      post: postLive ? ctx.postUniforms : null,
      blurTex,
      wmB: toDecal(slots.bottom),
      wmT: toDecal(slots.top),
    });
  };

   S360.scheduleViewerUpdate = function (ctx) {
     const { getCurrentImg } = ctx;
     if (ctx.getViewMode() !== '3d' || !S.sphere || !getCurrentImg()) return;
     if (S.sphereRaf) return;
     S.sphereRaf = requestAnimationFrame(() => {
       S.sphereRaf = null;
       S360.renderSphere(ctx);
     });
   };

  S360.invalidateViewerResources = function () {
    if (S.sphereRaf !== null) cancelAnimationFrame(S.sphereRaf);
    S.sphereRaf = null;
    S.sphereProgram = null;
  };

  S360.setViewMode = function (mode, ctx) {
    const { gl, panoramaCanvas, renderPano, getViewModeBtn, getViewerContainer } = ctx;
    S360.drawing?.beforeViewChange();
    ctx.setViewModeValue(mode);
    if (mode === '3d') {
      if (!ctx.getCurrentImg()) {
        S360.uiChrome.showToast('Please load an image first.', { type: 'warning' });
        ctx.setViewModeValue('2d');
        return;
      }
      if (ctx.disableSchematic) ctx.disableSchematic();
      if (getViewerContainer()) getViewerContainer().classList.add('hidden');
      panoramaCanvas.classList.add('viewer-3d');
      // The 3D-only floating controls (projection slider, pitch presets) key
      // off this class on the canvas's container.
      panoramaCanvas.parentElement.classList.add('viewer3d');
      panoramaCanvas.style.cursor = 'grab';
      if (!S.sphere) S.sphere = S360.initSphereViewer(gl, panoramaCanvas, ctx);
       // Force the full-resolution re-stitch now: renderPano()'s 3D branch
       // re-stitches the offscreen FBO at full source resolution (the 2D preview
       // left it at PREVIEW_MAX_W), then renderSphere draws the
       // sphere from that full-res texture so 3D matches the 2D export.
       renderPano();
       S360.renderSphere(ctx);
      if (getViewModeBtn()) getViewModeBtn().textContent = '2D';
      // Show drawing controls when entering 3D mode
      if (S360.drawing) S360.drawing.showControls(true);
    } else {
      if (getViewerContainer()) getViewerContainer().classList.add('hidden');
      panoramaCanvas.classList.remove('viewer-3d');
      panoramaCanvas.parentElement.classList.remove('viewer3d');
      if (ctx.updateCanvasCursor) ctx.updateCanvasCursor();
      if (getViewModeBtn()) getViewModeBtn().textContent = '3D';
      renderPano(); // redraw the equirect onto the canvas
      // Hide drawing controls when leaving 3D mode
      if (S360.drawing) S360.drawing.showControls(false);
    }
  };
})(window.S360);
