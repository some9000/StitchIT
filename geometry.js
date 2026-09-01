// geometry.js — Shared fisheye-projection geometry helpers (main thread only)
// Canonical source for functions duplicated across seam.js, seam-worker.js,
// and calibrate-worker.js.  Workers keep their own inline copies because
// classic <script> workers cannot import modules; when editing these
// functions, update ALL copies and leave a note in the worker file.
window.S360 = window.S360 || {};
(function (S360) {
  const PI = Math.PI;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  S360.geomClamp = clamp;

  /** Lens local-basis vectors for one hemisphere (left or right). */
  S360.lensBasis = function (isRight, cfg) {
    const axis = isRight ? [1, 0, 0] : [-1, 0, 0];
    const roll = (isRight ? cfg.rollDeg.right : cfg.rollDeg.left) * PI / 180;
    return {
      axis,
      up: S360.rotateAroundAxis([0, 0, 1], axis, roll),
      right: S360.rotateAroundAxis(isRight ? [0, 1, 0] : [0, -1, 0], axis, roll)
    };
  };

  /**
   * Equidistant fisheye projection: map a 3-D direction vector to source-pixel
   * coordinates.  Returns {x, y} or null if the direction falls outside the
   * lens field of view or the projected radius.
   */
  S360.sourcePoint = function (v, basis, center, radius, halfFov, focal,
      heightL, heightR, centerOffL, centerOffR, srcH) {
    const dot = clamp(v[0] * basis.axis[0] + v[1] * basis.axis[1] + v[2] * basis.axis[2], -1, 1);
    const theta = Math.acos(dot);
    if (theta > halfFov) return null;
    const vu = v[0] * basis.up[0] + v[1] * basis.up[1] + v[2] * basis.up[2];
    const vr = v[0] * basis.right[0] + v[1] * basis.right[1] + v[2] * basis.right[2];
    const az = Math.atan2(vr, vu);
    const dist = focal * theta;
    const ht = (Math.sin(az) + 1) * 0.5;
    const hf = heightL * (1 - ht) + heightR * ht;
    const rawL = Math.max(0, 1 - 2 * ht);
    const rawR = Math.max(0, 2 * ht - 1);
    const wL = rawL * rawL * rawL;
    const wR = rawR * rawR * rawR;
    const co = (centerOffL * wL + centerOffR * wR) * srcH * 0.01;
    const radialFade = (theta / halfFov);
    const dx = dist * Math.sin(az), dy = -dist * Math.cos(az) / hf + co * radialFade * radialFade;
    if (dx * dx + dy * dy > radius * radius) return null;
    return { x: center[0] + dx, y: center[1] + dy };
  };

  /**
   * Bilinear interpolation on a proxy image.  Writes into `out` if provided
   * (avoids per-call allocation in hot loops).
   */
  S360.sampleBilinear = function (proxy, x, y, out) {
    x = clamp(x, 0, proxy.w - 1); y = clamp(y, 0, proxy.h - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(proxy.w - 1, x0 + 1), y1 = Math.min(proxy.h - 1, y0 + 1);
    const tx = x - x0, ty = y - y0, d = proxy.data;
    const at = (xx, yy, c) => d[(yy * proxy.w + xx) * 4 + c] / 255;
    if (!out) out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const a = at(x0, y0, c) * (1 - tx) + at(x1, y0, c) * tx;
      const b = at(x0, y1, c) * (1 - tx) + at(x1, y1, c) * tx;
      out[c] = a * (1 - ty) + b * ty;
    }
    return out;
  };

  /** Quadratic distance transform (Felzenszwalb & Huttenlocher). */
  S360.distanceTransformQuadratic = function (f, s, argmin) {
    const n = f.length;
    const d = new Float64Array(n);
    const v = new Int32Array(n);
    const z = new Float64Array(n + 1);

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
      d[q] = s * (q - v[k]) * (q - v[k]) + f[v[k]];
      if (argmin) argmin[q] = v[k];
    }

    return d;
  };

})(window.S360);
