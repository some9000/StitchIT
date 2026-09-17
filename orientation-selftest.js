// orientation-selftest.js — synthetic vertical-orientation tripwire (QW#12)
//
// The app's upright panoramas rest on a deliberate PAIR of vertical inversions
// that cancel (see the ORIENTATION CONVENTION comment at sampleSource in
// shaders.js):
//   #1  sampleSource(): v = 1 - y/H          (mirrored source fetch)
//   #2  main():         pyNorm = 1 - v_uv.y  (pano assembled pole-flipped)
// plus the unflipped source upload (UNPACK_FLIP_Y = false) that both assume.
// Each element is load-bearing only as a group: change ONE alone and every
// panorama renders upside-down — with nothing in the code explaining why.
//
// This test builds a synthetic dual-fisheye source (each lens circle's TOP
// half red, BOTTOM half blue), stitches it through the REAL VS_SOURCE /
// FS_SOURCE with the REAL lens basis (S360.lensBasis), the REAL uniform
// formulas and the REAL upload convention, reads back through the REAL
// readFboToCanvas, and asserts: image-TOP content lands at pano-TOP.
//
// Coverage: source upload -> stitch shader -> FBO -> readback. The post pass
// samples the FBO directly (orientation-preserving), so exports/previews are
// proxied by this. NOT covered: the sphere and Little-Planet shaders' own
// pano-sampling conventions (separately verified in the code audit).
//
// RUN:  open index.html with ?selftest   (e.g. index.html?selftest)
//   or: S360.runOrientationSelfTest()    from the console.
// It creates its own WebGL2 context and never touches app state.

window.S360 = window.S360 || {};
(function (S360) {
'use strict';

  S360.runOrientationSelfTest = function () {
    const SRC_W = 512, SRC_H = 256;   // dual-fisheye layout: two side-by-side circles
    const PANO_W = 256, PANO_H = 128; // small equirect output — fast, sufficient

    // -- 1. Synthetic source -------------------------------------------------
    const src = document.createElement('canvas');
    src.width = SRC_W; src.height = SRC_H;
    const sc = src.getContext('2d');
    sc.fillStyle = '#000';
    sc.fillRect(0, 0, SRC_W, SRC_H);
    const centers = { left: [0.25, 0.5], right: [0.75, 0.5] };
    const radius = Math.min(SRC_W * 0.25, SRC_H * 0.5) * 1.0; // stitcher's formula: capture = outerMargin (100%)
    [centers.left, centers.right].forEach(([nx, ny]) => {
      const cx = nx * SRC_W, cy = ny * SRC_H;
      // Canvas arcs: angle 3*PI/2 points screen-UP (y grows downward), so
      // PI..2PI sweeps the TOP half — red; 0..PI sweeps the BOTTOM — blue.
      sc.fillStyle = '#f00';
      sc.beginPath(); sc.arc(cx, cy, radius, Math.PI, 2 * Math.PI); sc.closePath(); sc.fill();
      sc.fillStyle = '#00f';
      sc.beginPath(); sc.arc(cx, cy, radius, 0, Math.PI); sc.closePath(); sc.fill();
    });

    // -- 2. Own GL context (never the app's) ----------------------------------
    const glc = document.createElement('canvas');
    glc.width = PANO_W; glc.height = PANO_H;
    const gl = glc.getContext('webgl2', { antialias: false, depth: false });
    if (!gl) { console.warn('[selftest] WebGL2 unavailable — cannot run'); return false; }

    const prog = S360.createProgram(gl, S360.VS_SOURCE, S360.FS_SOURCE);
    gl.useProgram(prog);
    const uNames = ['u_image', 'u_imageLF', 'u_seamCurve', 'u_gainR', 'u_showSeam',
      'u_srcSize', 'u_centersL', 'u_centersR', 'u_radius', 'u_halfFov', 'u_f',
      'u_matchNorm', 'u_beltNorm', 'u_seamWidth', 'u_seamShift', 'u_axisL', 'u_upL', 'u_rightL',
      'u_axisR', 'u_upR', 'u_rightR',
      'u_schematicMode', 'u_rollL', 'u_rollR',
      'u_widthL', 'u_heightL', 'u_angleL', 'u_widthR', 'u_heightR', 'u_angleR',
      'u_guideOn', 'u_guidePos'];
    const u = {};
    uNames.forEach(n => { u[n] = gl.getUniformLocation(prog, n); });

    // -- 3. Textures: the REAL upload convention -------------------------------
    const setTexParams = () => {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    };
    // UNPACK_FLIP_Y = false — must mirror image.js / stitcher.js exactly.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    const srcTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    setTexParams();
    // LF twin: bind the SAME image (a blur of red stays red), so the both-hit
    // low-frequency blend cannot darken the assertion bands.
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    // Seam curve: 1x1 neutral gray — the seam weights only matter in the
    // horizontal overlap belt, away from the top/bottom assertion bands.
    const seamTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, seamTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([128, 128, 128, 255]));
    setTexParams();
    gl.uniform1i(u.u_image, 0);
    gl.uniform1i(u.u_imageLF, 1);
    gl.uniform1i(u.u_seamCurve, 2);

    // -- 4. Uniforms — stitcher.js's exact formulas ----------------------------
    const lens = S360.lensParams({ radius: 95, outerMargin: 100 }, Math.min(SRC_W * 0.25, SRC_H * 0.5));
    const Lb = S360.lensBasis(false, { rollDeg: { left: 0, right: 0 } });
    const Rb = S360.lensBasis(true,  { rollDeg: { left: 0, right: 0 } });
    gl.uniform3fv(u.u_gainR, [1, 1, 1]);
    gl.uniform1i(u.u_showSeam, 0);
    gl.uniform2f(u.u_srcSize, SRC_W, SRC_H);
    gl.uniform2f(u.u_centersL, SRC_W * centers.left[0], SRC_H * centers.left[1]);
    gl.uniform2f(u.u_centersR, SRC_W * centers.right[0], SRC_H * centers.right[1]);
    gl.uniform1f(u.u_radius, lens.radiusOuter);
    gl.uniform1f(u.u_halfFov, lens.halfFov);
    gl.uniform1f(u.u_f, lens.f);
    gl.uniform1f(u.u_matchNorm, lens.matchNorm);
    gl.uniform1f(u.u_beltNorm, lens.beltNorm);
    gl.uniform1f(u.u_seamWidth, 0.5);
    gl.uniform1f(u.u_seamShift, 0);
    gl.uniform3fv(u.u_axisL, Lb.axis);  gl.uniform3fv(u.u_upL, Lb.up);  gl.uniform3fv(u.u_rightL, Lb.right);
    gl.uniform3fv(u.u_axisR, Rb.axis);  gl.uniform3fv(u.u_upR, Rb.up);  gl.uniform3fv(u.u_rightR, Rb.right);
    gl.uniform1i(u.u_schematicMode, 0);
    gl.uniform1f(u.u_rollL, 0);
    gl.uniform1f(u.u_rollR, 0);
    gl.uniform1f(u.u_widthL, 1.0);
    gl.uniform1f(u.u_heightL, 1.0);
    gl.uniform1f(u.u_angleL, 0);
    gl.uniform1f(u.u_widthR, 1.0);
    gl.uniform1f(u.u_heightR, 1.0);
    gl.uniform1f(u.u_angleR, 0);
    gl.uniform1i(u.u_guideOn, 0);
    gl.uniform2f(u.u_guidePos, 0, 0);

    // -- 5. Render the stitch pass into an FBO ---------------------------------
    const outTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, outTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, PANO_W, PANO_H);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex, 0);
    S360.assertFramebufferComplete(gl, 'Selftest output');
    gl.viewport(0, 0, PANO_W, PANO_H);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(S360.getQuadVAO(gl));
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // -- 6. Read back through the REAL readback helper (covers its row flip) ---
    const out = S360.readFboToCanvas(gl, fbo, PANO_W, PANO_H);
    const data = out.getContext('2d').getImageData(0, 0, PANO_W, PANO_H).data;

    // -- 7. Assert: pano TOP = red (image top), pano BOTTOM = blue -------------
    // Canvas rows are top-down, so row 0 is the pano's visual TOP.
    const band = (y0, y1) => {
      let red = 0, blue = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < PANO_W; x += 2) { // stride 2: plenty of samples
          const i = (y * PANO_W + x) * 4;
          n++;
          if (data[i] > 150 && data[i + 1] < 100 && data[i + 2] < 100) red++;
          else if (data[i + 2] > 150 && data[i] < 100 && data[i + 1] < 100) blue++;
        }
      }
      return { red: red / n, blue: blue / n };
    };
    const top = band(0, Math.floor(PANO_H / 4));
    const bot = band(Math.ceil(PANO_H * 3 / 4), PANO_H);
    const pct = v => (v * 100).toFixed(1) + '%';
    const ok = top.red >= 0.6 && top.blue <= 0.2 && bot.blue >= 0.6 && bot.red <= 0.2;

    // -- 8. Cleanup + report -----------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(outTex);
    gl.deleteTexture(seamTex);
    gl.deleteTexture(srcTex);
    // Free the test context immediately — it is never needed again.
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();

    if (ok) {
      console.log(`✅ [selftest] orientation OK — pano top ${pct(top.red)} red / ${pct(top.blue)} blue, bottom ${pct(bot.blue)} blue / ${pct(bot.red)} red. The sampleSource/pyNorm inversion pair is intact.`);
    } else {
      console.error(`❌ [selftest] ORIENTATION BROKEN — pano top ${pct(top.red)} red / ${pct(top.blue)} blue, bottom ${pct(bot.blue)} blue / ${pct(bot.red)} red. One half of the vertical-inversion pair (sampleSource's 1-y/H or main()'s pyNorm = 1-v_uv.y in shaders.js) or the unflipped source upload has been changed alone.`);
    }
    S360._selftestResult = { ok, top, bot };
    return ok;
  };

  // Auto-run once when the page is opened with ?selftest in the URL.
  if (/[?&]selftest\b/.test(window.location.search)) {
    const run = () => {
      try { S360.runOrientationSelfTest(); }
      catch (e) { console.error('[selftest] crashed:', e); }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
    else run();
  }

})(window.S360);