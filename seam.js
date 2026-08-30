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
        const next = new Float64Array(levels); next.fill(Infinity);
        // Adaptive smoothness: in regions with strong edges (high average
        // gradient), reduce the penalty so the seam can make sharper turns
        // to route around objects.  In smooth regions, increase it.
        const normEdge = Math.min(1, azEdgeStrength[a] / 0.3);
        const localSmooth = baseSmoothness * (1.0 + 1.5 * (1.0 - normEdge));
        for (let level = 0; level < levels; level++) {
          let value = Infinity, parent = 0;
          for (let prior = 0; prior < levels; prior++) {
            const candidate = previous[prior] + localSmooth * (level - prior) * (level - prior);
            if (candidate < value) { value = candidate; parent = prior; }
          }
          next[level] = value + costs[a][level];
          parents[a][level] = parent;
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

  // =========================================================================
  //  AUTO-CALIBRATE LENS PARAMETERS VIA OVERLAP OPTIMISATION
  // =========================================================================
  // Coordinate-descent over 6 parameters: height and centre-Y for each lens,
  // plus shared FOV and radius-scale.  The cost is the mean squared RGB
  // difference between the two views across the overlap zone, evaluated on
  // the same 640 px proxy the seam analysis uses, with a lightweight
  // regularisation penalty to keep the solution conservative.
  //
  // If the initial overlap MSE is already very low the lenses are
  // well-aligned and calibration is skipped entirely.
  S360.autoCalibrateOverlap = function (img, cfg) {
    if (!img?.width || !img?.height) return;

    const proxy = makeProxy(img, 640);

    function evalCost() {
      const hf = cfg.fovDeg * PI / 360;
      const f  = proxy.w / (2 * hf);
      const r  = proxy.w * cfg.radiusScale / 2;
      const L  = lensBasis(false, cfg);
      const R  = lensBasis(true, cfg);
      const cL = [cfg.centers.left[0]  * proxy.scale, cfg.centers.left[1]  * proxy.scale];
      const cR = [cfg.centers.right[0] * proxy.scale, cfg.centers.right[1] * proxy.scale];
      const hLL = cfg.height.ll / 100, hLR = cfg.height.lr / 100;
      const hRL = cfg.height.rl / 100, hRR = cfg.height.rr / 100;
      const cLL = cfg.centerOffset.ll, cLR = cfg.centerOffset.lr;
      const cRL = cfg.centerOffset.rl, cRR = cfg.centerOffset.rr;
      const seamExtra = (cfg.blend && cfg.blend.hfBandWidth) || 0;
      const tMin = Math.max(0.01, PI - hf - seamExtra);
      const tMax = Math.min(hf + seamExtra, PI - 0.01);
      let err = 0, n = 0;
      for (let a = 0; a < 128; a++) {
        const az = -PI + (a + 0.5) * TAU / 128;
        for (let t = 0; t < 16; t++) {
          const theta = tMin + t * (tMax - tMin) / 15;
          const st = Math.sin(theta), ct = Math.cos(theta);
          const v = [
            L.axis[0]*ct + L.up[0]*st*Math.cos(az) + L.right[0]*st*Math.sin(az),
            L.axis[1]*ct + L.up[1]*st*Math.cos(az) + L.right[1]*st*Math.sin(az),
            L.axis[2]*ct + L.up[2]*st*Math.cos(az) + L.right[2]*st*Math.sin(az)
          ];
          const pL = sourcePoint(v, L, cL, r, hf, f, hLL, hLR, cLL, cLR, proxy.h);
          const pR = sourcePoint(v, R, cR, r, hf, f, hRL, hRR, cRL, cRR, proxy.h);
          if (!pL || !pR) continue;
          const sL = sampleBilinear(proxy, pL.x, pL.y);
          const sR = sampleBilinear(proxy, pR.x, pR.y);
          const d0 = sL[0]-sR[0], d1 = sL[1]-sR[1], d2 = sL[2]-sR[2];
          err += d0*d0 + d1*d1 + d2*d2;
          n++;
        }
      }
      return n > 0 ? err / n : 1e10;
    }

    const initCost = evalCost();

    // If the overlap is already very tight, don't touch anything — the
    // optimizer would just be fitting to content differences / parallax.
    if (initCost < 0.001) {
      return;
    }

    // Snapshot original values for regularisation.
    const orig = {
      ll: cfg.height.ll, lr: cfg.height.lr,
      rl: cfg.height.rl, rr: cfg.height.rr,
      cll: cfg.centerOffset.ll, clr: cfg.centerOffset.lr,
      crl: cfg.centerOffset.rl, crr: cfg.centerOffset.rr,
      cL: cfg.centers.left[0], cR: cfg.centers.right[0],
      fov: cfg.fovDeg, radius: cfg.radiusScale
    };

    // Regularised cost: raw MSE + penalty for deviating from original values.
    function evalRegCost() {
      const raw = evalCost();
      const reg = 0.1 * (
        Math.pow((cfg.height.ll     - orig.ll), 2) +
        Math.pow((cfg.height.lr     - orig.lr), 2) +
        Math.pow((cfg.height.rl     - orig.rl), 2) +
        Math.pow((cfg.height.rr     - orig.rr), 2) +
        Math.pow((cfg.centerOffset.ll - orig.cll), 2) +
        Math.pow((cfg.centerOffset.lr - orig.clr), 2) +
        Math.pow((cfg.centerOffset.rl - orig.crl), 2) +
        Math.pow((cfg.centerOffset.rr - orig.crr), 2) +
        Math.pow((cfg.centers.left[0] - orig.cL) * 100, 2) +
        Math.pow((cfg.centers.right[0]- orig.cR) * 100, 2) +
        Math.pow((cfg.fovDeg          - orig.fov)   * 5, 2) +
        Math.pow((cfg.radiusScale     - orig.radius) * 100, 2)
      );
      return raw + reg;
    }

    function g(path) { let o = cfg; for (const p of path) o = o[p]; return o; }
    function s(path, v) {
      let o = cfg; for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
      o[path[path.length - 1]] = v;
    }

    // Optimise the 6 geometry parameters.  Centre X and roll stay at
    // defaults — they are not exposed in the UI and don't meaningfully
    // affect vertical seam alignment.
    const params = [
      { p: ['height','ll'],         d: [-3,-1,-0.5, 0, 0.5, 1, 3] },
      { p: ['height','lr'],         d: [-3,-1,-0.5, 0, 0.5, 1, 3] },
      { p: ['height','rl'],         d: [-3,-1,-0.5, 0, 0.5, 1, 3] },
      { p: ['height','rr'],         d: [-3,-1,-0.5, 0, 0.5, 1, 3] },
      { p: ['centerOffset','ll'],   d: [-1,-0.3,-0.1, 0, 0.1, 0.3, 1] },
      { p: ['centerOffset','lr'],   d: [-1,-0.3,-0.1, 0, 0.1, 0.3, 1] },
      { p: ['centerOffset','rl'],   d: [-1,-0.3,-0.1, 0, 0.1, 0.3, 1] },
      { p: ['centerOffset','rr'],   d: [-1,-0.3,-0.1, 0, 0.1, 0.3, 1] },
      { p: ['centers','left', 0],   d: [-0.005,-0.002,-0.001, 0, 0.001, 0.002, 0.005] },
      { p: ['centers','right', 0],  d: [-0.005,-0.002,-0.001, 0, 0.001, 0.002, 0.005] },
      { p: ['fovDeg'],              d: [-1,-0.3,-0.1, 0, 0.1, 0.3, 1] },
      { p: ['radiusScale'],         d: [-0.01,-0.003,-0.001, 0, 0.001, 0.003, 0.01] },
    ];

    let bestCost = evalRegCost();

    for (let pass = 0; pass < 3; pass++) {
      for (const { p, d } of params) {
        const origVal = g(p);
        let bestVal = origVal;
        for (const delta of d) {
          s(p, origVal + delta);
          const cost = evalRegCost();
          if (cost < bestCost) { bestCost = cost; bestVal = origVal + delta; }
        }
        s(p, bestVal);
      }
    }

  };
})(window.S360);
