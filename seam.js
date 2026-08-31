// seam.js - content-aware seam selection for dual-fisheye sources
window.S360 = window.S360 || {};
(function (S360) {
  const PI = Math.PI;
  const TAU = PI * 2;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // rotateAroundAxis lives on S360 — shared with stitcher.js.

  function lensBasis(isRight, cfg) {
    const axis = isRight ? [1, 0, 0] : [-1, 0, 0];
    const roll = (isRight ? cfg.rollDeg.right : cfg.rollDeg.left) * PI / 180;
    return {
      axis,
      up: S360.rotateAroundAxis([0, 0, 1], axis, roll),
      right: S360.rotateAroundAxis(isRight ? [0, 1, 0] : [0, -1, 0], axis, roll)
    };
  }

  function makeProxy(img, maxWidth) {
    // Dynamic proxy resolution: scale up to 1920 px for large sources so the
    // seam analysis has enough detail to evaluate fine features (hair, text,
    // thin branches).  Small sources are not upscaled beyond their native size.
    // The default (no argument) uses this adaptive sizing.
    const defaultMax = maxWidth || Math.min(1920, Math.max(640, img.width / 3));
    const w = Math.min(defaultMax, img.width);
    const h = Math.max(1, Math.round(img.height * w / img.width));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    return { w, h, data: ctx.getImageData(0, 0, w, h).data, scale: w / img.width };
  }

  S360.makeProxy = makeProxy;

  function sampleBilinear(proxy, x, y) {
    x = clamp(x, 0, proxy.w - 1); y = clamp(y, 0, proxy.h - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(proxy.w - 1, x0 + 1), y1 = Math.min(proxy.h - 1, y0 + 1);
    const tx = x - x0, ty = y - y0, d = proxy.data;
    const at = (xx, yy, c) => d[(yy * proxy.w + xx) * 4 + c] / 255;
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const a = at(x0, y0, c) * (1 - tx) + at(x1, y0, c) * tx;
      const b = at(x0, y1, c) * (1 - tx) + at(x1, y1, c) * tx;
      out[c] = a * (1 - ty) + b * ty;
    }
    return out;
  }

  function sourcePoint(v, basis, center, radius, halfFov, focal, heightL, heightR, centerOffL, centerOffR, srcH) {
    const dot = clamp(v[0] * basis.axis[0] + v[1] * basis.axis[1] + v[2] * basis.axis[2], -1, 1);
    const theta = Math.acos(dot);
    if (theta > halfFov) return null;
    const vu = v[0] * basis.up[0] + v[1] * basis.up[1] + v[2] * basis.up[2];
    const vr = v[0] * basis.right[0] + v[1] * basis.right[1] + v[2] * basis.right[2];
    const az = Math.atan2(vr, vu);
    const dist = focal * theta;
    const ht = (Math.sin(az) + 1) * 0.5;
    const hf = heightL * (1 - ht) + heightR * ht;
    // Power curve: centre barely moves, edges move most.
    const rawL = Math.max(0, 1 - 2 * ht);
    const rawR = Math.max(0, 2 * ht - 1);
    const wL = rawL * rawL * rawL;
    const wR = rawR * rawR * rawR;
    const co = (centerOffL * wL + centerOffR * wR) * srcH * 0.01;
    // Radial falloff: zero at lens centre, grows quadratically toward edge.
    const radialFade = (theta / halfFov);
    const dx = dist * Math.sin(az), dy = -dist * Math.cos(az) / hf + co * radialFade * radialFade;
    if (dx * dx + dy * dy > radius * radius) return null;
    return { x: center[0] + dx, y: center[1] + dy };
  }

  function luma(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }

  function gradient(proxy, point) {
    // Sobel edge detector — 3×3 kernel gives directional gradient magnitude.
    // Much more stable than the old 2-tap difference and correctly identifies
    // edge strength regardless of orientation.
    const sample = (dx, dy) => luma(sampleBilinear(proxy, point.x + dx, point.y + dy));
    const tl = sample(-1, -1), t = sample(0, -1), tr = sample(1, -1);
    const ml = sample(-1,  0),                    mr = sample(1,  0);
    const bl = sample(-1,  1), b = sample(0,  1), br = sample(1,  1);
    const gx = -tl - 2*ml - bl + tr + 2*mr + br;
    const gy = -tl - 2*t  - tr + bl + 2*b  + br;
    return Math.sqrt(gx * gx + gy * gy);
  }

  function distanceTransformQuadratic(f, s, argmin) {
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
  }

  // Finds a smooth closed path through the overlap belt. The result is one
  // normalised left-lens angle for every azimuth sample around the seam.
  S360.analyzeContentAwareSeam = function (img, cfg, gain = [1, 1, 1]) {
    if (!img?.width || !img?.height) return null;
    const halfFov = cfg.fovDeg * PI / 360;
    // Seam width extends the overlap detection zone beyond the strict
    // geometric intersection so the DP seam search has more room.
    const seamExtra = (cfg.blend && cfg.blend.hfBandWidth) || 0;
    const thetaMin = Math.max(0.01, PI - halfFov - seamExtra);
    const thetaMax = Math.min(halfFov + seamExtra, PI - 0.01);
    if (thetaMax <= thetaMin) return null;

    const proxy = makeProxy(img);
    const scale = proxy.scale;
    const radius = Math.min(img.width * 0.25, img.height * 0.5) * cfg.radiusScale * scale;
    const focal = radius / halfFov;
    const centers = {
      left: [img.width * cfg.centers.left[0] * scale, img.height * cfg.centers.left[1] * scale],
      right: [img.width * cfg.centers.right[0] * scale, img.height * cfg.centers.right[1] * scale]
    };
    const left = lensBasis(false, cfg), right = lensBasis(true, cfg);
    // Higher resolution: 512 azimuth samples (was 256) × 48 theta levels (was
    // 28).  The proxy is small enough that this stays under 100 ms on mobile.
    const angles = 512, levels = 48;
    const step = (thetaMax - thetaMin) / (levels - 1);
    const costs = Array.from({ length: angles }, () => new Float64Array(levels));
    const azEdgeStrength = new Float32Array(angles);

    for (let a = 0; a < angles; a++) {
      const az = -PI + (a + 0.5) * TAU / angles;
      let edgeSum = 0;
      for (let level = 0; level < levels; level++) {
        const theta = thetaMin + level * step;
        const sinTheta = Math.sin(theta), cosTheta = Math.cos(theta);
        const v = [
          left.axis[0] * cosTheta + left.up[0] * sinTheta * Math.cos(az) + left.right[0] * sinTheta * Math.sin(az),
          left.axis[1] * cosTheta + left.up[1] * sinTheta * Math.cos(az) + left.right[1] * sinTheta * Math.sin(az),
          left.axis[2] * cosTheta + left.up[2] * sinTheta * Math.cos(az) + left.right[2] * sinTheta * Math.sin(az)
        ];
        const pL = sourcePoint(v, left, centers.left, radius, halfFov, focal,
          cfg.height.ll / 100, cfg.height.lr / 100, cfg.centerOffset.ll, cfg.centerOffset.lr, img.height);
        const pR = sourcePoint(v, right, centers.right, radius, halfFov, focal,
          cfg.height.rl / 100, cfg.height.rr / 100, cfg.centerOffset.rl, cfg.centerOffset.rr, img.height);
        if (!pL || !pR) { costs[a][level] = 1e6; continue; }
        const cL = sampleBilinear(proxy, pL.x, pL.y);
        const rawR = sampleBilinear(proxy, pR.x, pR.y);
        const cR = [rawR[0] * gain[0], rawR[1] * gain[1], rawR[2] * gain[2]];
        // Perceptual colour distance (simplified CIE 76): weight blue less
        // because the human eye is less sensitive to blue detail.
        const colour = Math.sqrt(
          2 * (cL[0] - cR[0]) * (cL[0] - cR[0]) +
          4 * (cL[1] - cR[1]) * (cL[1] - cR[1]) +
          3 * (cL[2] - cR[2]) * (cL[2] - cR[2])
        );
        const lum = Math.abs(luma(cL) - luma(cR));
        const gradL = gradient(proxy, pL), gradR = gradient(proxy, pR);
        const mismatch = Math.abs(gradL - gradR);
        const edge = gradL + gradR;
        edgeSum += edge;
        const centre = (theta - PI * 0.5) / Math.max(0.001, (thetaMax - thetaMin) * 0.5);
        // Stronger centre penalty (was 0.025): keeps the seam inside the
        // overlap zone where alignment is most reliable.
        costs[a][level] = colour * 0.55 + lum * 0.55 + mismatch * 0.50 + edge * 0.10 + centre * centre * 0.08;
      }
      azEdgeStrength[a] = edgeSum / levels;
    }

    let bestScore = Infinity, bestPath = null;
    const baseSmoothness = 0.020;
    for (let start = 0; start < levels; start++) {
      let previous = new Float64Array(levels); previous.fill(Infinity);
      previous[start] = costs[0][start];
      const parents = Array.from({ length: angles }, () => new Int16Array(levels));
      for (let a = 1; a < angles; a++) {
        const next = new Float64Array(levels);
        // Adaptive smoothness: in regions with strong edges (high average
        // gradient), reduce the penalty so the seam can make sharper turns
        // to route around objects.  In smooth regions, increase it.
        const normEdge = Math.min(1, azEdgeStrength[a] / 0.3);
        const localSmooth = baseSmoothness * (1.0 + 1.5 * (1.0 - normEdge));
        if (a === 1) {
          // First transition: only 'start' is reachable in previous.
          for (let level = 0; level < levels; level++) {
            next[level] = previous[start] + localSmooth * (level - start) * (level - start);
            parents[a][level] = start;
          }
        } else {
          const argmin = parents[a];
          const dt = distanceTransformQuadratic(previous, localSmooth, argmin);
          for (let level = 0; level < levels; level++) {
            next[level] = dt[level];
          }
        }
        for (let level = 0; level < levels; level++) {
          next[level] += costs[a][level];
        }
        previous = next;
      }
      for (let end = 0; end < levels; end++) {
        const score = previous[end] + baseSmoothness * (end - start) * (end - start);
        if (score >= bestScore) continue;
        const path = new Int16Array(angles);
        path[angles - 1] = end;
        for (let a = angles - 1; a > 0; a--) path[a - 1] = parents[a][path[a]];
        bestScore = score; bestPath = path;
      }
    }
    if (!bestPath || !Number.isFinite(bestScore)) return null;
    const curve = new Uint8Array(angles);
    for (let a = 0; a < angles; a++) {
      const theta = thetaMin + bestPath[a] * step;
      curve[a] = Math.round(clamp(theta / halfFov, 0, 1) * 255);
    }

    return { curve, angles, score: bestScore / angles };
  };
})(window.S360);
