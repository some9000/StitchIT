// geometry.js — shared fisheye-projection geometry helpers.
// Canonical source for seam.js, seam-analysis.js, and stitcher.js's CPU-side
// lens math. Worker-safe: seam-worker.js loads this file with importScripts(),
// so it is plain math published on globalThis.S360 (which is window on the
// main thread).
globalThis.S360 = globalThis.S360 || {};
(function (S360) {
'use strict';
  const PI = Math.PI;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Rodrigues rotation — shared by lensBasis and stitcher.js's roll basis.
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

  /** Lens local-basis vectors for one hemisphere (left or right). */
  S360.lensBasis = function (isRight, cfg) {
    const axis = isRight ? [1, 0, 0] : [-1, 0, 0];
    const roll = (isRight ? cfg.rollDeg.right : cfg.rollDeg.left) * PI / 180;
    const horizonPitch = (cfg.horizon?.pitch || 0) * PI / 180;
    const horizonRoll = (cfg.horizon?.roll || 0) * PI / 180;
    const level = function (v) {
      const pitched = S360.rotateAroundAxis(v, [0, 1, 0], horizonPitch);
      return S360.rotateAroundAxis(pitched, [1, 0, 0], horizonRoll);
    };
    return {
      axis: level(axis),
      up: level(S360.rotateAroundAxis([0, 0, 1], axis, roll)),
      right: level(S360.rotateAroundAxis(isRight ? [0, 1, 0] : [0, -1, 0], axis, roll))
    };
  };

  /**
   * Canonical lens geometry from the UI's two percentage sliders.  Both are
   * percentages of the "reference" half-diameter `base` (= min(w*0.25, h*0.5),
   * i.e. 100% == image height for a 2:1 source):
   *   radius      — the 180° / perfect-sphere ring (where the two hemispheres
   *                 meet).  Pins the focal length: f = radiusMatch / (PI/2).
   *   outerMargin — the outer usable capture edge of the lens circle.
   * The derived capture half-angle is halfFov = (PI/2) * outer/radius, so the
   * 180° ring always falls on radiusMatch *inside* the capture circle.
   * This is the single source of truth used by stitcher.js, seam-analysis.js,
   * image.js, slice-upscale.js and the shader CPU mirrors.  Worker-safe.
   */
  S360.lensParams = function (cfg, base) {
    const radiusPct = clamp(cfg.radius, 80, 100) / 100;
    const outerPct = clamp(cfg.outerMargin, 80, 100) / 100;
    const radiusMatch = radiusPct * base;
    const radiusOuter = Math.max(radiusMatch, outerPct * base); // outer >= match
    const halfFov = (PI / 2) * (radiusOuter / radiusMatch);
    const f = radiusMatch / (PI / 2);
    const matchNorm = radiusMatch / radiusOuter;
    return { radiusMatch, radiusOuter, halfFov, f, matchNorm, beltNorm: 1 - matchNorm };
  };

  /**
   * Feather-band geometry for the right-lens seam gradient, expressed in
   * full-overlap units (0 = right capture edge, 1 = left capture edge). Given the
   * per-azimuth base centerline `centerBelt` (0..1) and the belt-relative seam
   * width/shift:
   *   bandWidth = seamWidth            (full feather width, 100% = whole belt)
   * Negative shift favours left, positive favours right. Extremes move the
   * gradient beyond the overlap, selecting one lens even at 100% width.
   * Returns the unclipped [lo, hi] positions and the band center.
   */
  S360.seamBand = function (cfg, centerBelt, out) {
    const bandWidth = Math.max(0.001, cfg.blend.seamWidth);
    const halfBand = bandWidth * 0.5;
    const base = clamp(centerBelt, halfBand, 1.0 - halfBand);
    const shift = clamp(cfg.blend.seamShift, -1, 1);
    const edge = shift < 0 ? 1 + halfBand : -halfBand;
    const center = base + (edge - base) * Math.abs(shift);
    if (!out) out = {};
    out.lo = center - halfBand;
    out.hi = center + halfBand;
    out.center = center;
    out.halfBand = halfBand;
    out.bandWidth = bandWidth;
    return out;
  };

  /**
   * Equidistant fisheye projection: map a 3-D direction vector to source-pixel
   * coordinates.  Returns {x, y} or null if the direction falls outside the
   * lens field of view or the projected radius.
   */
  S360.sourcePoint = function (v, basis, center, radius, halfFov, focal, width, angle, height = 1) {
    const dot = clamp(v[0] * basis.axis[0] + v[1] * basis.axis[1] + v[2] * basis.axis[2], -1, 1);
    const theta = Math.acos(dot);
    if (theta > halfFov) return null;
    const vu = v[0] * basis.up[0] + v[1] * basis.up[1] + v[2] * basis.up[2];
    const vr = v[0] * basis.right[0] + v[1] * basis.right[1] + v[2] * basis.right[2];
    const az = Math.atan2(vr, vu);
    const dist = focal * theta;
    let dx = dist * Math.sin(az);
    let dy = -dist * Math.cos(az);
    dx *= width;
    dy *= height;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const rdx = dx * c - dy * s;
    const rdy = dx * s + dy * c;
    if (rdx * rdx + rdy * rdy > radius * radius) return null;
    return { x: center[0] + rdx, y: center[1] + rdy };
  };

  // Inverse of sourcePoint. Coordinates use the shader's lens-pixel space.
  S360.sourceDirection = function (x, y, basis, center, radius, halfFov, focal, width, angle, height = 1, out = []) {
    const dx = x - center[0], dy = y - center[1];
    if (dx * dx + dy * dy > radius * radius) return null;
    const c = Math.cos(angle), s = Math.sin(angle);
    const safeW = Math.max(1e-6, width);
    const safeH = Math.max(1e-6, height);
    const px = (dx * c + dy * s) / safeW, py = (-dx * s + dy * c) / safeH;
    const dist = Math.hypot(px, py), theta = dist / focal;
    if (theta > halfFov) return null;
    const sin = Math.sin(theta), cos = Math.cos(theta);
    const across = dist > 1e-12 ? px / dist : 0, up = dist > 1e-12 ? -py / dist : 0;
    for (let i = 0; i < 3; i++) out[i] = basis.axis[i] * cos + (basis.right[i] * across + basis.up[i] * up) * sin;
    return out;
  };

  /**
   * Bilinear interpolation on a proxy image.  Writes into `out` if provided
   * (avoids per-call allocation in hot loops).
   */
  S360.sampleBilinear = function (proxy, x, y, out) {
    x = clamp(x, 0, proxy.w - 1); y = clamp(y, 0, proxy.h - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(proxy.w - 1, x0 + 1), y1 = Math.min(proxy.h - 1, y0 + 1);
    const tx = x - x0, ty = y - y0;
    const d = proxy.data, w = proxy.w;
    if (!out) out = [0, 0, 0];
    // Precompute base addresses and inverse interpolation weights to avoid
    // repeated closure allocation and per-channel address arithmetic.
    const b00 = (y0 * w + x0) * 4, b10 = (y0 * w + x1) * 4;
    const b01 = (y1 * w + x0) * 4, b11 = (y1 * w + x1) * 4;
    const omtx = 1 - tx, omtY = 1 - ty;
    for (let c = 0; c < 3; c++) {
      const a = d[b00 + c] * omtx + d[b10 + c] * tx;
      const b = d[b01 + c] * omtx + d[b11 + c] * tx;
      out[c] = (a * omtY + b * ty) / 255;
    }
    return out;
  };

  /** Quadratic distance transform (Felzenszwalb & Huttenlocher).
   *  If `out` is provided, writes results there (avoids allocating a new
   *  Float64Array each call).  Internal scratch buffers (v, z) are cached
   *  at module scope and resized on demand. */
  let _dtV = null, _dtVLen = 0;
  let _dtZ = null, _dtZLen = 0;
  S360.distanceTransformQuadratic = function (f, s, argmin, out) {
    const n = f.length;
    if (!out || out.length < n) out = new Float64Array(n);
    // v stores parabola indices (0..n-1, always ≤255 for seam levels) → Uint8.
    // z stores parabola intersection points (≤n, ~7 digits suffice) → Float32.
    // Both save bandwidth vs Int32/Float64 when n is small (48 levels).
    if (!_dtV || _dtVLen < n) { _dtV = new Uint8Array(n); _dtVLen = n; }
    if (!_dtZ || _dtZLen < n + 1) { _dtZ = new Float32Array(n + 1); _dtZLen = n + 1; }
    const v = _dtV, z = _dtZ;

    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;

    for (let q = 1; q < n; q++) {
      let sVal = (f[q] - f[v[k]]) / (2 * s * (q - v[k])) + (q + v[k]) / 2;
      while (sVal <= z[k]) {
        k--;
        sVal = (f[q] - f[v[k]]) / (2 * s * (q - v[k])) + (q + v[k]) / 2;
      }
      k++;
      v[k] = q;
      z[k] = sVal;
      z[k + 1] = Infinity;
    }

    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      out[q] = s * (q - v[k]) * (q - v[k]) + f[v[k]];
      if (argmin) argmin[q] = v[k];
    }

    return out;
  };

})(globalThis.S360);
