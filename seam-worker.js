// seam-worker.js - content-aware seam selection in a Web Worker
// Self-contained: no DOM, no WebGL, pure math + pixel sampling.
// The main thread sends a proxy {w, h, data (ArrayBuffer), scale} plus
// imgWidth/imgHeight, cfg, and gain. The worker returns {curve, angles, score}
// or null on failure.

const PI = Math.PI;
const TAU = PI * 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function rotateAroundAxis(v, axis, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const [ax, ay, az] = axis;
  const dot = v[0] * ax + v[1] * ay + v[2] * az;
  return [
    v[0] * c + s * (ay * v[2] - az * v[1]) + (1 - c) * ax * dot,
    v[1] * c + s * (az * v[0] - ax * v[2]) + (1 - c) * ay * dot,
    v[2] * c + s * (ax * v[1] - ay * v[0]) + (1 - c) * az * dot
  ];
}

function lensBasis(isRight, cfg) {
  const axis = isRight ? [1, 0, 0] : [-1, 0, 0];
  const roll = (isRight ? cfg.rollDeg.right : cfg.rollDeg.left) * PI / 180;
  return {
    axis,
    up: rotateAroundAxis([0, 0, 1], axis, roll),
    right: rotateAroundAxis(isRight ? [0, 1, 0] : [0, -1, 0], axis, roll)
  };
}

function sampleBilinear(proxy, x, y) {
  x = clamp(x, 0, proxy.w - 1); y = clamp(y, 0, proxy.h - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(proxy.w - 1, x0 + 1), y1 = Math.min(proxy.h - 1, y0 + 1);
  const tx = x - x0, ty = y - y0, d = proxy.data;
  const at = (xx, yy, c) => d[(yy * proxy.w + xx) * 4 + c];
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = at(x0, y0, c) * (1 - tx) + at(x1, y0, c) * tx;
    const b = at(x0, y1, c) * (1 - tx) + at(x1, y1, c) * tx;
    out[c] = a * (1 - ty) + b * ty;
  }
  return out;
}

function luma(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }

function gradient(proxy, point) {
  const sample = (dx, dy) => luma(sampleBilinear(proxy, point.x + dx, point.y + dy));
  const tl = sample(-1, -1), t = sample(0, -1), tr = sample(1, -1);
  const ml = sample(-1,  0),                    mr = sample(1,  0);
  const bl = sample(-1,  1), b = sample(0,  1), br = sample(1,  1);
  const gx = -tl - 2*ml - bl + tr + 2*mr + br;
  const gy = -tl - 2*t  - tr + bl + 2*b  + br;
  return Math.sqrt(gx * gx + gy * gy);
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
  const rawL = Math.max(0, 1 - 2 * ht);
  const rawR = Math.max(0, 2 * ht - 1);
  const wL = rawL * rawL * rawL;
  const wR = rawR * rawR * rawR;
  const co = (centerOffL * wL + centerOffR * wR) * srcH * 0.01;
  const radialFade = (theta / halfFov);
  const dx = dist * Math.sin(az), dy = -dist * Math.cos(az) / hf + co * radialFade * radialFade;
  if (dx * dx + dy * dy > radius * radius) return null;
  return { x: center[0] + dx, y: center[1] + dy };
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

function analyzeSeam(proxy, imgWidth, imgHeight, cfg, gain) {
  const halfFov = cfg.fovDeg * PI / 360;
  const seamExtra = (cfg.blend && cfg.blend.hfBandWidth) || 0;
  const thetaMin = Math.max(0.01, PI - halfFov - seamExtra);
  const thetaMax = Math.min(halfFov + seamExtra, PI - 0.01);
  if (thetaMax <= thetaMin) return null;

  const scale = proxy.scale;
  const radius = Math.min(imgWidth * 0.25, imgHeight * 0.5) * cfg.radiusScale * scale;
  const focal = radius / halfFov;
  const centers = {
    left: [imgWidth * cfg.centers.left[0] * scale, imgHeight * cfg.centers.left[1] * scale],
    right: [imgWidth * cfg.centers.right[0] * scale, imgHeight * cfg.centers.right[1] * scale]
  };
  const left = lensBasis(false, cfg), right = lensBasis(true, cfg);
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
        cfg.height.ll / 100, cfg.height.lr / 100, cfg.centerOffset.ll, cfg.centerOffset.lr, imgHeight);
      const pR = sourcePoint(v, right, centers.right, radius, halfFov, focal,
        cfg.height.rl / 100, cfg.height.rr / 100, cfg.centerOffset.rl, cfg.centerOffset.rr, imgHeight);
      if (!pL || !pR) { costs[a][level] = 1e6; continue; }
      const cL = sampleBilinear(proxy, pL.x, pL.y);
      const rawR = sampleBilinear(proxy, pR.x, pR.y);
      const cR = [rawR[0] * gain[0], rawR[1] * gain[1], rawR[2] * gain[2]];
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
      const normEdge = Math.min(1, azEdgeStrength[a] / 0.3);
      const localSmooth = baseSmoothness * (1.0 + 1.5 * (1.0 - normEdge));
      if (a === 1) {
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
}

self.onmessage = function(e) {
  const msg = e.data;
  if (msg.type === 'analyze') {
    try {
      const result = analyzeSeam(msg.proxy, msg.imgWidth, msg.imgHeight, msg.cfg, msg.gain);
      if (result) {
        self.postMessage({ type: 'result', curve: result.curve, angles: result.angles, score: result.score });
      } else {
        self.postMessage({ type: 'result', curve: null });
      }
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message });
    }
  }
};
