// lens-alignment-kernel.js — shared Nelder-Mead optimiser for lens alignment.
// Loaded by lens-alignment-worker.js (importScripts) and lens-alignment.js
// (main-thread fallback). Pure math, no DOM, no WebGL.
globalThis.S360 = globalThis.S360 || {};
(function (S360) {
  'use strict';
  const PI = Math.PI, TAU = PI * 2;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const PARAM_STEPS = [0.001, 0.001, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05];
  const AZIMUTH_SAMPLES = 96;
  const OVERLAP_SAMPLES = 12;

  function snapToUi(params, bounds) {
    return params.map((value, i) => {
      const step = PARAM_STEPS[i];
      const snapped = Math.round(value / step) * step;
      return clamp(Number(snapped.toFixed(i < 2 ? 3 : 2)), bounds[i][0], bounds[i][1]);
    });
  }

  // Nelder-Mead simplex with bounds. Returns {params, value, iterations}.
  // `onProgress(startFraction, endFraction)` is called per iteration when
  // provided (worker progress heartbeats / main-thread UI updates).
  function nelderMead(f, x0, bounds, options, onProgress) {
    const maxIter = options.maxIter || 200;
    const tol = options.tol || 1e-5;
    const n = x0.length;
    const simplex = [x0.slice()];
    const scales = options.scales || x0.map(v => Math.max(0.01, Math.abs(v) * 0.05));
    for (let i = 0; i < n; i++) {
      const v = x0.slice();
      v[i] = clamp(v[i] + scales[i], bounds[i][0], bounds[i][1]);
      simplex.push(v);
    }
    const values = simplex.map(p => f(p));
    let done = 0;
    for (let iter = 0; iter < maxIter; iter++) {
      done = iter + 1;
      if (onProgress && (iter & 3) === 0) onProgress(iter / maxIter);
      const idx = simplex.map((_, i) => i).sort((a, b) => values[a] - values[b]);
      const ss = idx.map(i => simplex[i]);
      const sv = idx.map(i => values[i]);
      simplex.splice(0, n + 1, ...ss);
      values.splice(0, n + 1, ...sv);
      if (values[n] - values[0] < tol) break;
      const cen = new Array(n).fill(0);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cen[j] += simplex[i][j];
      for (let j = 0; j < n; j++) cen[j] /= n;
      const worst = simplex[n];
      const xr = new Array(n);
      for (let j = 0; j < n; j++) xr[j] = clamp(cen[j] + (cen[j] - worst[j]), bounds[j][0], bounds[j][1]);
      const fr = f(xr);
      if (fr < values[0]) {
        const xe = new Array(n);
        for (let j = 0; j < n; j++) xe[j] = clamp(cen[j] + 2 * (xr[j] - cen[j]), bounds[j][0], bounds[j][1]);
        const fe = f(xe);
        if (fe < fr) { simplex[n] = xe; values[n] = fe; }
        else { simplex[n] = xr; values[n] = fr; }
      } else if (fr < values[n - 1]) {
        simplex[n] = xr; values[n] = fr;
      } else {
        const xc = new Array(n);
        if (fr < values[n]) {
          for (let j = 0; j < n; j++) xc[j] = clamp(cen[j] + 0.5 * (xr[j] - cen[j]), bounds[j][0], bounds[j][1]);
        } else {
          for (let j = 0; j < n; j++) xc[j] = clamp(cen[j] + 0.5 * (worst[j] - cen[j]), bounds[j][0], bounds[j][1]);
        }
        const fc = f(xc);
        if (fc < Math.min(fr, values[n])) { simplex[n] = xc; values[n] = fc; }
        else {
          for (let i = 1; i <= n; i++) {
            for (let j = 0; j < n; j++) simplex[i][j] = clamp(simplex[0][j] + 0.5 * (simplex[i][j] - simplex[0][j]), bounds[j][0], bounds[j][1]);
            values[i] = f(simplex[i]);
          }
        }
      }
    }
            let bi = 0;
    for (let i = 1; i <= n; i++) if (values[i] < values[bi]) bi = i;
    return { params: simplex[bi], value: values[bi], iterations: done };
  }

  // Objective: sum of luminance-weighted colour differences in the overlap
  // belt (the band between the 180° match ring and the capture edge), where
  // the final panorama actually blends left and right captures.
  function makeObjective(proxy, imgWidth, imgHeight, cfg, gain) {
    const scale = proxy.scale;
    const base = Math.min(imgWidth * 0.25, imgHeight * 0.5);
    const bufL = [0, 0, 0], bufR = [0, 0, 0];
    const nAz = AZIMUTH_SAMPLES, nTheta = OVERLAP_SAMPLES;
    return function (params) {
      const wCfg = {
        centers: { left: [params[0], cfg.centers.left[1]], right: [params[1], cfg.centers.right[1]] },
        width: { left: params[2], right: params[3] },
        height: { left: params[4], right: params[5] },
        angle: { left: params[6], right: params[7] },
        radius: cfg.radius, outerMargin: cfg.outerMargin, rollDeg: cfg.rollDeg,
        horizon: cfg.horizon,
      };
      const lens = S360.lensParams(wCfg, base);
      const halfFov = lens.halfFov;
      const thetaMin = Math.max(0.01, PI - halfFov);
      const thetaMax = Math.min(halfFov, PI - 0.01);
      if (thetaMax <= thetaMin) return 1e6;
      const radius = lens.radiusOuter * scale;
      const focal = lens.f * scale;
      const centers = {
        left: [imgWidth * wCfg.centers.left[0] * scale, imgHeight * wCfg.centers.left[1] * scale],
        right: [imgWidth * wCfg.centers.right[0] * scale, imgHeight * wCfg.centers.right[1] * scale],
      };
      const lb = S360.lensBasis(false, wCfg), rb = S360.lensBasis(true, wCfg);
      const wL = 1.0 - wCfg.width.left / 100.0, wR = 1.0 - wCfg.width.right / 100.0;
      const hL = 1.0 - (wCfg.height?.left ?? 0) / 100.0, hR = 1.0 - (wCfg.height?.right ?? 0) / 100.0;
      const aL = wCfg.angle.left * PI / 180.0, aR = wCfg.angle.right * PI / 180.0;
      const tStep = (thetaMax - thetaMin) / (nTheta - 1);
      let total = 0, samples = 0;
      for (let ia = 0; ia < nAz; ia++) {
        const az = -PI + (ia + 0.5) * TAU / nAz;
        const cAz = Math.cos(az), sAz = Math.sin(az);
        for (let it = 0; it < nTheta; it++) {
          const theta = thetaMin + it * tStep;
          const sT = Math.sin(theta), cT = Math.cos(theta);
          const v = [
            lb.axis[0] * cT + lb.up[0] * sT * cAz + lb.right[0] * sT * sAz,
            lb.axis[1] * cT + lb.up[1] * sT * cAz + lb.right[1] * sT * sAz,
            lb.axis[2] * cT + lb.up[2] * sT * cAz + lb.right[2] * sT * sAz,
          ];
          const pL = S360.sourcePoint(v, lb, centers.left, radius, halfFov, focal, wL, aL, hL);
          const pR = S360.sourcePoint(v, rb, centers.right, radius, halfFov, focal, wR, aR, hR);
          if (!pL || !pR) continue;
          // NOTE: sampleBilinear writes into the provided buffer and returns
          // it, so left/right must use separate buffers or cL aliases cR and
          // every difference reads zero.
          const cL = S360.sampleBilinear(proxy, pL.x, pL.y, bufL);
          const cR = S360.sampleBilinear(proxy, pR.x, pR.y, bufR);
          const rL = cL[0], gL = cL[1], bL = cL[2];
          const rR = cR[0] * gain[0], gR = cR[1] * gain[1], bR = cR[2] * gain[2];
          const dR = rL - rR, dG = gL - gR, dB = bL - bR;
          const lumL = 0.2126 * rL + 0.7152 * gL + 0.0722 * bL;
          const lumR = 0.2126 * rR + 0.7152 * gR + 0.0722 * bR;
          const w = 0.5 + Math.min(lumL, lumR);
          total += w * (dR * dR + dG * dG + dB * dB) + (lumL - lumR) * (lumL - lumR) * 2.0;
          samples++;
        }
      }
      return samples > 0 ? total / samples : 1e6;
    };
  }

  // `bounds` defaults to the UI slider ranges; `onProgress` receives 0..1 for
  // the whole two-pass run (worker progress messages / main-thread UI).
  function optimize(proxy, imgWidth, imgHeight, cfg, gain, bounds, onProgress) {
    // Slider ranges from index.html: centers 0.2–0.3 / 0.7–0.8, scale ±5, angle ±135.
    // Searching outside these ranges could return values the UI clamps away.
    bounds = bounds || [
      [0.2, 0.3], [0.7, 0.8],
      [-5, 5], [-5, 5], [-5, 5], [-5, 5], [-135, 135], [-135, 135],
    ];
    const x0 = [
      cfg.centers.left[0], cfg.centers.right[0],
      cfg.width.left, cfg.width.right,
      cfg.height.left, cfg.height.right,
      cfg.angle.left, cfg.angle.right,
    ];
    const objective = makeObjective(proxy, imgWidth, imgHeight, cfg, gain);
    // Count every belt evaluation so the UI can report "tested N variants"
    // even when the search concludes the current values are already best.
    let evaluations = 0;
    const counted = (p) => { evaluations++; return objective(p); };
    const baselineValue = counted(x0);
    // Two-pass: coarse global search first so a single poor local basin does
    // not trap the 8-D simplex; then a tight refine around the coarse best.
    const coarse = nelderMead(counted, x0, bounds, {
      maxIter: 150, tol: 1e-6,
      scales: [0.02, 0.02, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
    }, onProgress && ((t) => onProgress(t * 0.5)));
    const tight = bounds.map((b, i) => {
      const span = (b[1] - b[0]) * 0.125;
      return [Math.max(b[0], coarse.params[i] - span), Math.min(b[1], coarse.params[i] + span)];
    });
    const result = nelderMead(counted, coarse.params, tight, {
      maxIter: 150, tol: 1e-7,
      scales: [0.005, 0.005, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25],
    }, onProgress && ((t) => onProgress(0.5 + t * 0.5)));
    if (onProgress) onProgress(1);
    result.iterations = coarse.iterations + result.iterations;
    result.evaluations = evaluations;
    const snapped = snapToUi(result.params, bounds);
    const optimizedValue = counted(snapped);
    const improvement = baselineValue > 0 ? (baselineValue - optimizedValue) / baselineValue : 0;
    return {
      params: {
        centerL: snapped[0], centerR: snapped[1],
        widthL: snapped[2], widthR: snapped[3],
        heightL: snapped[4], heightR: snapped[5],
        angleL: snapped[6], angleR: snapped[7],
      },
      confidence: Math.max(0, Math.min(1, improvement * 5)),
      iterations: result.iterations,
      baselineValue, optimizedValue,
      evaluations,
    };
  }

  // Async twin of optimize for the main-thread fallback: identical two-pass
  // search, but yields to the event loop every few iterations so the loading
  // overlay repaints and the progress % actually moves on screen.
  async function optimizeAsync(proxy, imgWidth, imgHeight, cfg, gain, bounds, onProgress, yieldFn) {
    bounds = bounds || [
      [0.2, 0.3], [0.7, 0.8],
      [-5, 5], [-5, 5], [-5, 5], [-5, 5], [-135, 135], [-135, 135],
    ];
    const x0 = [
      cfg.centers.left[0], cfg.centers.right[0],
      cfg.width.left, cfg.width.right,
      cfg.height.left, cfg.height.right,
      cfg.angle.left, cfg.angle.right,
    ];
    const objective = makeObjective(proxy, imgWidth, imgHeight, cfg, gain);
    let evaluations = 0;
    const counted = (p) => { evaluations++; return objective(p); };
    const baselineValue = counted(x0);
    const coarse = await nelderMeadAsync(counted, x0, bounds, {
      maxIter: 150, tol: 1e-6,
      scales: [0.02, 0.02, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
    }, onProgress && ((t) => onProgress(t * 0.5)), yieldFn);
    const tight = bounds.map((b, i) => {
      const span = (b[1] - b[0]) * 0.125;
      return [Math.max(b[0], coarse.params[i] - span), Math.min(b[1], coarse.params[i] + span)];
    });
    const result = await nelderMeadAsync(counted, coarse.params, tight, {
      maxIter: 150, tol: 1e-7,
      scales: [0.005, 0.005, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25],
    }, onProgress && ((t) => onProgress(0.5 + t * 0.5)), yieldFn);
    if (onProgress) onProgress(1);
    const snapped = snapToUi(result.params, bounds);
    const optimizedValue = counted(snapped);
    const improvement = baselineValue > 0 ? (baselineValue - optimizedValue) / baselineValue : 0;
    return {
      params: {
        centerL: snapped[0], centerR: snapped[1],
        widthL: snapped[2], widthR: snapped[3],
        heightL: snapped[4], heightR: snapped[5],
        angleL: snapped[6], angleR: snapped[7],
      },
      confidence: Math.max(0, Math.min(1, improvement * 5)),
      iterations: coarse.iterations + result.iterations,
      baselineValue, optimizedValue,
      evaluations,
    };
  }

  // ---- async twins for the main-thread fallback ----
  // Identical math to nelderMead/optimize, but they await `yieldFn` every few
  // iterations so the loading overlay can repaint while the search runs. The
  // worker always uses the sync versions (no DOM/event loop to service).
  async function nelderMeadAsync(f, x0, bounds, options, onProgress, yieldFn) {
    const maxIter = options.maxIter || 200;
    const tol = options.tol || 1e-5;
    const n = x0.length;
    const simplex = [x0.slice()];
    const scales = options.scales || x0.map(v => Math.max(0.01, Math.abs(v) * 0.05));
    for (let i = 0; i < n; i++) {
      const v = x0.slice();
      v[i] = clamp(v[i] + scales[i], bounds[i][0], bounds[i][1]);
      simplex.push(v);
    }
    const values = simplex.map(p => f(p));
    let done = 0;
    for (let iter = 0; iter < maxIter; iter++) {
      done = iter + 1;
      if ((iter & 3) === 0) {
        if (onProgress) onProgress(iter / maxIter);
        if (yieldFn) await yieldFn();
      }
      const idx = simplex.map((_, i) => i).sort((a, b) => values[a] - values[b]);
      const ss = idx.map(i => simplex[i]);
      const sv = idx.map(i => values[i]);
      simplex.splice(0, n + 1, ...ss);
      values.splice(0, n + 1, ...sv);
      if (values[n] - values[0] < tol) break;
      const cen = new Array(n).fill(0);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cen[j] += simplex[i][j];
      for (let j = 0; j < n; j++) cen[j] /= n;
      const worst = simplex[n];
      const xr = new Array(n);
      for (let j = 0; j < n; j++) xr[j] = clamp(cen[j] + (cen[j] - worst[j]), bounds[j][0], bounds[j][1]);
      const fr = f(xr);
      if (fr < values[0]) {
        const xe = new Array(n);
        for (let j = 0; j < n; j++) xe[j] = clamp(cen[j] + 2 * (xr[j] - cen[j]), bounds[j][0], bounds[j][1]);
        const fe = f(xe);
        if (fe < fr) { simplex[n] = xe; values[n] = fe; }
        else { simplex[n] = xr; values[n] = fr; }
      } else if (fr < values[n - 1]) {
        simplex[n] = xr; values[n] = fr;
      } else {
        const xc = new Array(n);
        if (fr < values[n]) {
          for (let j = 0; j < n; j++) xc[j] = clamp(cen[j] + 0.5 * (xr[j] - cen[j]), bounds[j][0], bounds[j][1]);
        } else {
          for (let j = 0; j < n; j++) xc[j] = clamp(cen[j] + 0.5 * (worst[j] - cen[j]), bounds[j][0], bounds[j][1]);
        }
        const fc = f(xc);
        if (fc < Math.min(fr, values[n])) { simplex[n] = xc; values[n] = fc; }
        else {
          for (let i = 1; i <= n; i++) {
            for (let j = 0; j < n; j++) simplex[i][j] = clamp(simplex[0][j] + 0.5 * (simplex[i][j] - simplex[0][j]), bounds[j][0], bounds[j][1]);
            values[i] = f(simplex[i]);
          }
        }
      }
    }
    let bi = 0;
    for (let i = 1; i <= n; i++) if (values[i] < values[bi]) bi = i;
    return { params: simplex[bi], value: values[bi], iterations: done };
  }

  S360.lensAlignmentKernel = { optimize, optimizeAsync, nelderMead, makeObjective };
})(globalThis.S360);
