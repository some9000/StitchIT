// seam.js - content-aware seam selection for dual-fisheye sources
window.S360 = window.S360 || {};
(function (S360) {
  const PI = Math.PI;
  const TAU = PI * 2;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // lensBasis, sourcePoint, sampleBilinear, distanceTransformQuadratic are
  // defined in geometry.js (S360 namespace).  Workers keep their own copies.

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

  // Preallocated buffer for bilinear samples — avoids per-call GC in hot loops.
  const _sampleBuf = [0, 0, 0];

  function luma(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }

  function gradient(proxy, point) {
    // Sobel edge detector — 3×3 kernel gives directional gradient magnitude.
    const sample = (dx, dy) => luma(S360.sampleBilinear(proxy, point.x + dx, point.y + dy, _sampleBuf));
    const tl = sample(-1, -1), t = sample(0, -1), tr = sample(1, -1);
    const ml = sample(-1,  0),                    mr = sample(1,  0);
    const bl = sample(-1,  1), b = sample(0,  1), br = sample(1,  1);
    const gx = -tl - 2*ml - bl + tr + 2*mr + br;
    const gy = -tl - 2*t  - tr + bl + 2*b  + br;
    return Math.sqrt(gx * gx + gy * gy);
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
    const left = S360.lensBasis(false, cfg), right = S360.lensBasis(true, cfg);
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
        const pL = S360.sourcePoint(v, left, centers.left, radius, halfFov, focal,
          cfg.height.ll / 100, cfg.height.lr / 100, cfg.centerOffset.ll, cfg.centerOffset.lr, img.height);
        const pR = S360.sourcePoint(v, right, centers.right, radius, halfFov, focal,
          cfg.height.rl / 100, cfg.height.rr / 100, cfg.centerOffset.rl, cfg.centerOffset.rr, img.height);
        if (!pL || !pR) { costs[a][level] = 1e6; continue; }
        const cL = S360.sampleBilinear(proxy, pL.x, pL.y);
        const rawR = S360.sampleBilinear(proxy, pR.x, pR.y);
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
    // Precompute the minimum possible remaining cost (from the last azimuth)
    // to enable branch-and-bound pruning across starting levels.
    const minCostLast = (() => { let m = Infinity; for (let l = 0; l < levels; l++) if (costs[angles - 1][l] < m) m = costs[angles - 1][l]; return m; })();
    for (let start = 0; start < levels; start++) {
      // Pruning: if the seed cost alone already exceeds the best known
      // total, this starting level cannot win — skip the entire forward pass.
      if (costs[0][start] >= bestScore) continue;
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
          const dt = S360.distanceTransformQuadratic(previous, localSmooth, argmin);
          for (let level = 0; level < levels; level++) {
            next[level] = dt[level];
          }
        }
        for (let level = 0; level < levels; level++) {
          next[level] += costs[a][level];
        }
        previous = next;
        // Mid-pass pruning: if even the cheapest level at this azimuth
        // already exceeds the best total, abandon this starting level.
        if (a === angles - 2) {
          let runMin = Infinity;
          for (let l = 0; l < levels; l++) if (previous[l] < runMin) runMin = previous[l];
          if (runMin + minCostLast >= bestScore) { previous = null; break; }
        }
      }
      if (previous) for (let end = 0; end < levels; end++) {
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
