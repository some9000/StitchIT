// watermark.js
window.S360 = window.S360 || {};
(function (S360) {
'use strict';
  // Watermark (pole decal) shaders. The same decal can be composited at the
  // NADIR (bottom half of the equirect, dir.y < 0) or the ZENITH (top half,
  // dir.y > 0). The `top` uniform selects which pole: 0 = nadir (bottom),
  // 1 = zenith (top). Both use an identical stereographic projection on the
  // tangent plane at the chosen pole, oriented so that image-north maps to the
  // top of the decal at either pole.

  // Shared nadir/zenith decal math, injected into any equirect fragment shader
  // (3D viewer, little planet, and the baked path below) so every path
  // composites identically. `uv` is an equirectangular coordinate; the decal is
  // stereographically projected onto the tangent plane at the chosen pole, so
  // `size` is the tangent-plane radius = tan(θ/2) where θ is the angular
  // distance from the pole. The whole visible hemisphere maps inside a radius
  // of 1, therefore size = 1.0 spans the full 90° from pole to equator — i.e.
  // 50% of the 180° image height. (Conformal, so logo shapes stay true.)
  const WM_COMPOSITE_FN = `
    vec3 s360CompositeWM(vec3 color, sampler2D wmTex, vec2 uv,
                         float size, float alpha, float rot, float top) {
      const float PI = 3.14159265358979323846;
      float lon = (uv.x - 0.5) * 2.0 * PI;
      float lat = (uv.y - 0.5) * PI;
      float cl = cos(lat);
      vec3 dir = vec3(cl * sin(lon), sin(lat), cl * cos(lon));
      // signPole: -1 places on the nadir (dir.y < 0), +1 on the zenith (dir.y > 0).
      float signPole = top > 0.5 ? 1.0 : -1.0;
      if (dir.y * signPole > 0.001) {
        // ay = cos(θ), 1 at the pole, 0 at the equator (θ = angular distance
        // from the pole). Stereographic projection from the antipode maps the
        // point to tan(θ/2) = sin(θ)/(1 + cos(θ)) in the tangent plane: the
        // entire hemisphere lands inside a radius of 1, so size = 1.0 reaches
        // 90° from the pole (= 50% of the equirect image height). The Y sign
        // flip for the zenith keeps the decal upright (image-north = top of the
        // decal) at BOTH poles.
        float ay = signPole * dir.y;
        vec2 local = vec2(dir.x, (top > 0.5 ? -dir.z : dir.z)) / (1.0 + ay);
        float c = cos(rot), s = sin(rot);
        local = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
        if (dot(local, local) < size * size) {
          vec2 wuv = local / (2.0 * size) + 0.5;
          if (wuv.x >= 0.0 && wuv.x <= 1.0 && wuv.y >= 0.0 && wuv.y <= 1.0) {
            vec4 wm = texture(wmTex, wuv);
            return mix(color, wm.rgb, wm.a * alpha);
          }
        }
      }
      return color;
    }
  `;

  const WM_VS = S360.QUAD_VS;

  const WM_FS = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 fragColor;
    uniform sampler2D u_src;
    uniform sampler2D u_wm;
    uniform float u_size;
    uniform float u_alpha;
    uniform float u_rot;
    uniform float u_top;
    ${WM_COMPOSITE_FN}
    void main() {
      vec4 src = texture(u_src, v_uv);
      vec3 color = s360CompositeWM(src.rgb, u_wm, v_uv, u_size, u_alpha, u_rot, u_top);
      fragColor = vec4(color, src.a);
    }`;

  // All watermark-program caches created via getWatermarkProgram(). The program
  // is compiled against a specific WebGL context; when that context is lost and
  // restored, the cached program is dead, so stitcher's restore handler calls
  // invalidateWatermarkPrograms() to drop every cache (they lazily recompile).
  const wmProgramCaches = [];

  S360.getWatermarkProgram = function (gl) {
      const state = { prog: null };
      wmProgramCaches.push(state);
      return function () {
          if (!state.prog) {
              state.prog = S360.createProgram(gl, WM_VS, WM_FS);
              state.prog._u = {
                  u_src:   gl.getUniformLocation(state.prog, 'u_src'),
                  u_wm:    gl.getUniformLocation(state.prog, 'u_wm'),
                  u_size:  gl.getUniformLocation(state.prog, 'u_size'),
                  u_alpha: gl.getUniformLocation(state.prog, 'u_alpha'),
                  u_rot:   gl.getUniformLocation(state.prog, 'u_rot'),
                  u_top:   gl.getUniformLocation(state.prog, 'u_top'),
              };
          }
          return state.prog;
      };
  };

  // Drops all cached watermark programs (context-loss recovery).
  S360.invalidateWatermarkPrograms = function () {
    wmProgramCaches.length = 0;
  };

  // ---------------------------------------------------------------------------
  // Shared pole-decal GLSL. Inject into any equirect fragment shader that has
  // the decal texture bound; mirrors the math of WM_FS above exactly, so the
  // live 3D view / little planet composite identically to the baked path.
  // ---------------------------------------------------------------------------
  S360.WM_GLSL = WM_COMPOSITE_FN;

  // Bakes a watermark decal from srcTex (equirect) into targetFbo. `top`
  // selects the pole: true = zenith (top of the image), false = nadir (bottom).
  S360.compositeWatermark = function (gl, getWatermarkProgramFn, srcTex, w, h, targetFbo, wmTex, wmSize, wmAlpha, wmRotDeg, top) {
      const wmProgram = getWatermarkProgramFn();
      gl.useProgram(wmProgram);
      gl.bindVertexArray(S360.getQuadVAO(gl));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(wmProgram._u.u_src, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, wmTex);
      gl.uniform1i(wmProgram._u.u_wm, 1);
      gl.uniform1f(wmProgram._u.u_size, wmSize);
      gl.uniform1f(wmProgram._u.u_alpha, wmAlpha);
      gl.uniform1f(wmProgram._u.u_rot, wmRotDeg * Math.PI / 180.0);
      gl.uniform1f(wmProgram._u.u_top, top ? 1.0 : 0.0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
      gl.viewport(0, 0, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };
})(window.S360);
