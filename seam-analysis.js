// seam-analysis.js — pure content-aware seam search over a pre-built CPU proxy.
// Shared by seam.js (main-thread fallback) and seam-worker.js (importScripts);
// no DOM and no WebGL. geometry.js must load first (lensBasis, sourcePoint,
// sampleBilinear, distanceTransformQuadratic).
globalThis.S360 = globalThis.S360 || {};
(function (S360) {
'use strict';
  const PI = Math.PI;
  const TAU = PI * 2;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function luma(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }

  // Preallocated buffer for bilinear samples — avoids per-call GC in hot loops.
  const _sampleBuf = [0, 0, 0];

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

  S360.seamAnalysis = {
    // Finds a smooth closed path through the overlap belt. The result is one
    // normalised left-lens angle for every azimuth sample around the seam.
    // `proxy` is {w, h, data (RGBA), scale} as produced by S360.makeProxy.
    analyzeSeam(proxy, imgWidth, imgHeight, cfg, gain = [1, 1, 1]) {
      // Canonical lens geometry: radius pins the 180° meeting ring, outerMargin
      // the outer usable edge; overlap extends to both sides of the meeting ring.
      const base = Math.min(imgWidth * 0.25, imgHeight * 0.5);
      const lens = S360.lensParams(cfg, base);
      const halfFov = lens.halfFov;
      // Opposite axes: both captures cover [PI-halfFov, halfFov]. sourcePoint
      // additionally rejects pixels outside either lens ellipse below.
      const thetaMin = Math.max(0.01, PI - halfFov);
      const thetaMax = Math.min(halfFov, PI - 0.01);
      if (thetaMax <= thetaMin) return null;

      const scale = proxy.scale;
      const radius = lens.radiusOuter * scale;
      const focal = lens.f * scale;
      const centers = {
        left: [imgWidth * cfg.centers.left[0] * scale, imgHeight * cfg.centers.left[1] * scale],
        right: [imgWidth * cfg.centers.right[0] * scale, imgHeight * cfg.centers.right[1] * scale]
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
            1.0 - cfg.width.left / 100.0, cfg.angle.left * Math.PI / 180.0, 1 - (cfg.height?.left ?? 0) / 100);
          const pR = S360.sourcePoint(v, right, centers.right, radius, halfFov, focal,
            1.0 - cfg.width.right / 100.0, cfg.angle.right * Math.PI / 180.0, 1 - (cfg.height?.right ?? 0) / 100);
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
      // Pre-allocate reusable DP buffers outside the start loop to avoid
      // ~11.5 MB of TypedArray allocations per seam analysis.
      const _prevBuf = new Float64Array(levels);
      const _nextBuf = new Float64Array(levels);
      const parents = Array.from({ length: angles }, () => new Int16Array(levels));
      for (let start = 0; start < levels; start++) {
        // Pruning: if the seed cost alone already exceeds the best known
        // total, this starting level cannot win — skip the entire forward pass.
        if (costs[0][start] >= bestScore) continue;
        _prevBuf.fill(Infinity);
        _prevBuf[start] = costs[0][start];
        let cur = _prevBuf, nxt = _nextBuf;
        let active = true;
        for (let a = 1; a < angles; a++) {
          // Adaptive smoothness: in regions with strong edges (high average
          // gradient), reduce the penalty so the seam can make sharper turns
          // to route around objects.  In smooth regions, increase it.
          const normEdge = Math.min(1, azEdgeStrength[a] / 0.3);
          const localSmooth = baseSmoothness * (1.0 + 1.5 * (1.0 - normEdge));
          if (a === 1) {
            // First transition: only 'start' is reachable in cur.
            for (let level = 0; level < levels; level++) {
              nxt[level] = cur[start] + localSmooth * (level - start) * (level - start);
              parents[a][level] = start;
            }
          } else {
            const argmin = parents[a];
            S360.distanceTransformQuadratic(cur, localSmooth, argmin, nxt);
          }
          for (let level = 0; level < levels; level++) {
            nxt[level] += costs[a][level];
          }
          // Swap buffers: nxt becomes cur (the latest costs), cur becomes nxt (scratch).
          const tmp = cur; cur = nxt; nxt = tmp;
          // Mid-pass pruning: check every 64 azimuths (plus the final
          // positions) to abandon unpromising starting levels early.
          if (a === angles - 2 || (a > 1 && (a & 63) === 63)) {
            let runMin = Infinity;
            for (let l = 0; l < levels; l++) if (cur[l] < runMin) runMin = cur[l];
            if (runMin + minCostLast >= bestScore) { active = false; break; }
          }
        }
        if (active) for (let end = 0; end < levels; end++) {
          const score = cur[end] + baseSmoothness * (end - start) * (end - start);
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
        // Full overlap: 0 = right capture edge, 1 = left capture edge.
        curve[a] = Math.round(clamp((theta - thetaMin) / (thetaMax - thetaMin), 0, 1) * 255);
      }

      return { curve, angles, score: bestScore / angles };
    },
  };
})(globalThis.S360);
