// watermark.js
window.S360 = window.S360 || {};
(function (S360) {
  // Watermark (nadir decal) shaders
  const WM_VS = `#version 300 es
    layout(location = 0) in vec2 a_position;
    out vec2 v_uv;
    void main() { v_uv = a_position * 0.5 + 0.5; gl_Position = vec4(a_position, 0.0, 1.0); }`;

  const WM_FS = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 fragColor;
    uniform sampler2D u_src;
    uniform sampler2D u_wm;
    uniform float u_size;
    uniform float u_alpha;
    uniform float u_rot;
    const float PI = 3.14159265358979323846;
    void main() {
      vec4 base = texture(u_src, v_uv);
      float lon = (v_uv.x - 0.5) * 2.0 * PI;
      float lat = (v_uv.y - 0.5) * PI;
      float cl = cos(lat);
      vec3 dir = vec3(cl * sin(lon), sin(lat), cl * cos(lon));
      if (dir.y < -0.001) {
        vec2 local = vec2(-dir.x / dir.y, -dir.z / dir.y);
        float c = cos(u_rot), s = sin(u_rot);
        local = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
        if (dot(local, local) < u_size * u_size) {
          vec2 wuv = local / (2.0 * u_size) + 0.5;
          if (wuv.x >= 0.0 && wuv.x <= 1.0 && wuv.y >= 0.0 && wuv.y <= 1.0) {
            vec4 wm = texture(u_wm, wuv);
            float a = wm.a * u_alpha;
            fragColor = vec4(mix(base.rgb, wm.rgb, a), base.a);
            return;
          }
        }
      }
      fragColor = base;
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
  // Shared nadir-decal GLSL. Inject into any equirect fragment shader that has
  // the decal texture bound; mirrors the math of WM_FS above exactly, so the
  // live 3D view composites identically to the baked/exported path.
  // ---------------------------------------------------------------------------
  S360.WM_GLSL = `
    vec3 s360CompositeWM(vec3 color, sampler2D wmTex, vec2 uv,
                         float size, float alpha, float rot) {
      const float PI = 3.14159265358979323846;
      float lon = (uv.x - 0.5) * 2.0 * PI;
      float lat = (uv.y - 0.5) * PI;
      float cl = cos(lat);
      vec3 dir = vec3(cl * sin(lon), sin(lat), cl * cos(lon));
      if (dir.y < -0.001) {
        vec2 local = vec2(-dir.x / dir.y, -dir.z / dir.y);
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

  // Bakes the watermark decal from srcTex (equirect) into targetFbo.
  S360.compositeWatermark = function (gl, getWatermarkProgramFn, srcTex, w, h, targetFbo, wmTex, wmSize, wmAlpha, wmRotDeg) {
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
      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
      gl.viewport(0, 0, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };
})(window.S360);
