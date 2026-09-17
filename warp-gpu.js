// warp-gpu.js — GPU deformation map double-buffer.
// The map lives at session VIEW resolution (not the full 13824x6912 source):
// each pixel stores normalized source UV in [0,1], packed to 16 bits per axis
// across RG and BA. The CPU oracle uses view pixels; conversion happens only at
// this GPU boundary. Packed maps use nearest filtering and decode/interpolate
// explicitly so byte carries cannot corrupt hardware-linear samples.
// same math as the CPU oracle (warp-projection.js) applies and the two share an
// oracle/comparison contract. Two explicitly-owned RGBA8 targets ping-pong:
// each step reads the previous map
// as TEXTURE0 and writes the other, so there is never a simultaneous read/write
// on one texture. A step redraws the FULL map, so "next" is always a complete,
// self-consistent map and both buffers stay in sync by construction (local,
// partial updates are a later optimization and not required for correctness).
//
// API: init({ gl }), begin(width, height), step(handle, step), current(handle),
//      dispose(handle), invalidate()  (context loss: drop the program; maps are
//      the session owner's responsibility and must be disposed too).
window.S360 = window.S360 || {};
(function (S360) {
'use strict';
  const WARP_VS = S360.QUAD_VS;

  const PACK_GLSL =
    `vec2 pack16(float value) {
       float n = floor(clamp(value, 0.0, 1.0) * 65535.0 + 0.5);
       return vec2(floor(n / 256.0), mod(n, 256.0)) / 255.0;
     }
     float unpack16(vec2 packed) {
       vec2 bytes = floor(packed * 255.0 + 0.5);
       return (bytes.x * 256.0 + bytes.y) / 65535.0;
     }
     vec4 packMap(vec2 value) { return vec4(pack16(value.x), pack16(value.y)); }
     vec2 unpackMap(vec4 value) { return vec2(unpack16(value.rg), unpack16(value.ba)); }`;

  // Compose one brush step per pixel: result pixel p sources from
  // viewPoint = p - delta*strength*falloff(p), sampled from the PREVIOUS map.
  // falloff = 1 - smoothstep(dist/radius) — identical to warp-projection.js's
  // falloff, so the GPU reproduces the CPU oracle exactly (modulo half-float
  // storage of the view coordinates).
  const WARP_STEP_FS =
    `#version 300 es
     precision highp float;
     in vec2 v_uv;
     out vec4 fragColor;
     uniform sampler2D u_prev;
     uniform vec2 u_dim;    // map size in pixels
     uniform vec2 u_center; // brush centre in view pixels
     uniform vec2 u_delta;  // this step's cursor movement
     uniform float u_radius;
     uniform float u_strength;
     ${PACK_GLSL}
     vec2 fetchMap(ivec2 coord) {
       coord = clamp(coord, ivec2(0), ivec2(u_dim) - ivec2(1));
       return unpackMap(texelFetch(u_prev, coord, 0));
     }
     vec2 sampleMap(vec2 pixel) {
       vec2 q = clamp(pixel - 0.5, vec2(0.0), u_dim - 1.0);
       ivec2 lo = ivec2(floor(q));
       ivec2 hi = min(lo + ivec2(1), ivec2(u_dim) - ivec2(1));
       vec2 f = fract(q);
       vec2 top = mix(fetchMap(lo), fetchMap(ivec2(hi.x, lo.y)), f.x);
       vec2 bottom = mix(fetchMap(ivec2(lo.x, hi.y)), fetchMap(hi), f.x);
       return mix(top, bottom, f.y);
     }
     void main() {
       vec2 p = v_uv * u_dim;
       vec2 d = p - u_center;
       float dist = length(d);
       float t = clamp(dist / u_radius, 0.0, 1.0);
       float f = 1.0 - t * t * (3.0 - 2.0 * t);
       vec2 src = p - u_delta * u_strength * f;
       fragColor = packMap(sampleMap(src));
     }`;

  // Reset a map to identity: W(p) = p.
  const WARP_RESET_FS =
    `#version 300 es
     precision highp float;
     in vec2 v_uv;
     out vec4 fragColor;
     uniform vec2 u_dim;
     ${PACK_GLSL}
     void main() { fragColor = packMap(v_uv); }`;

  let _gl = null, _stepProg = null, _resetProg = null, _pending = null;
  function gl() { return _gl; }

  function getProgram() {
    if (!_stepProg) {
      _stepProg = S360.createProgram(_gl, WARP_VS, WARP_STEP_FS);
      _stepProg._u = {
        u_prev:    _gl.getUniformLocation(_stepProg, 'u_prev'),
        u_dim:     _gl.getUniformLocation(_stepProg, 'u_dim'),
        u_center:  _gl.getUniformLocation(_stepProg, 'u_center'),
        u_delta:   _gl.getUniformLocation(_stepProg, 'u_delta'),
        u_radius:  _gl.getUniformLocation(_stepProg, 'u_radius'),
        u_strength: _gl.getUniformLocation(_stepProg, 'u_strength'),
      };
      _resetProg = S360.createProgram(_gl, WARP_VS, WARP_RESET_FS);
      _resetProg._u = { u_dim: _gl.getUniformLocation(_resetProg, 'u_dim') };
    }
    return _stepProg;
  }

  // Ping-pong: `current` points at the last fully-written map (initially A,
  // reset to identity by begin()). Each step reads the current map on TEXTURE0
  // and writes the OTHER, then flips `current` so the freshly written map is
  // the only one ever returned by current() — the two buffers stay in lockstep.
  function step(state, stepParams) {
    if (!state) return null;
    const { center, delta, strength, radius } = stepParams;
    const from = state.current, to = 1 - state.current;
    const read = state.maps[from], write = state.maps[to];
    const prog = getProgram(), u = prog._u;
    gl().useProgram(prog);
    gl().bindVertexArray(S360.getQuadVAO(gl()));
    gl().activeTexture(gl().TEXTURE0);
    gl().bindTexture(gl().TEXTURE_2D, read.tex);
    gl().uniform1i(u.u_prev, 0);
    gl().uniform2f(u.u_dim, write.width, write.height);
    gl().uniform2f(u.u_center, center.x, center.y);
    gl().uniform2f(u.u_delta, delta[0], delta[1]);
    gl().uniform1f(u.u_radius, radius);
    gl().uniform1f(u.u_strength, strength);
    gl().bindFramebuffer(gl().FRAMEBUFFER, write.fbo);
    gl().viewport(0, 0, write.width, write.height);
    gl().drawArrays(gl().TRIANGLES, 0, 6);
    state.current = to;
    return write;
  }

  function current(state) { return state ? state.maps[state.current] : null; }

  function dispose(state) {
    if (!state) return;
    for (const m of state.maps) { if (m?.dispose) m.dispose(); }
    state.maps = [];
    state.current = 0;
  }

  // Context loss: drop the cached programs (maps are the session owner's and
  // are also dead — call dispose() on them).
  function invalidate() {
    _stepProg = null; _resetProg = null;
  }

  function begin(width, height) {
    if (!_gl) throw new Error('warpGpu.init() must run before begin().');
    const nearest = { filter: _gl.NEAREST };
    const mapA = S360.createRenderTarget(_gl, width, height, 'Warp deformation map A', _gl.CLAMP_TO_EDGE, nearest);
    const mapB = S360.createRenderTarget(_gl, width, height, 'Warp deformation map B', _gl.CLAMP_TO_EDGE, nearest);
    const state = { maps: [mapA, mapB], current: 0, width, height };
    try {
      getProgram();
      drawIdentity(state, 0);
      drawIdentity(state, 1);
      const error = gl().getError && gl().getError();
      if (gl().isContextLost?.() || (error && error !== gl().NO_ERROR)) throw new Error(`Warp map preparation failed on the GPU (${error}).`);
    } catch (error) {
      dispose(state);
      throw error;
    } finally {
      gl().bindFramebuffer(gl().FRAMEBUFFER, null);
    }
    return state;
  }

  function drawIdentity(state, idx) {
    const target = state.maps[idx];
    gl().useProgram(_resetProg);
    gl().bindVertexArray(S360.getQuadVAO(gl()));
    gl().bindFramebuffer(gl().FRAMEBUFFER, target.fbo);
    gl().viewport(0, 0, target.width, target.height);
    gl().uniform2f(_resetProg._u.u_dim, target.width, target.height);
    gl().drawArrays(gl().TRIANGLES, 0, 6);
  }

  S360.warpGpu = {
    init(deps) { _gl = deps?.gl; },
    begin, step, current, dispose, invalidate,
  };
})(window.S360);
