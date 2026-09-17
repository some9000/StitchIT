// frame-registration.js — pure gradient-correlation registration for
// multi-frame fusion. Shared by align.js (main-thread fallback) and
// align-worker.js (importScripts); no DOM and no WebGL.
globalThis.S360 = globalThis.S360 || {};
(function (S360) {
'use strict';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Central-difference gradients on every interior pixel; borders stay 0.
  // scoreShift samples at least 12 px inside the frame, so border values never
  // contribute. Precomputing once beats recomputing inside the search loops.
  function computeGradients(gray, w, h) {
    const gradX = new Float32Array(w * h);
    const gradY = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        gradX[p] = gray[p + 1] - gray[p - 1];
        gradY[p] = gray[p + w] - gray[p - w];
      }
    }
    return { gradX, gradY };
  }

  function scoreShift(ref, cur, dx, dy, step = 3, wrapX = false) {
    const margin = 12, w = ref.w, h = ref.h;
    let sum = 0, sumR = 0, sumC = 0, sumRR = 0, sumCC = 0, n = 0;
    for (let y = margin; y < h - margin; y += step) {
      const cy = y + dy; if (cy < 1 || cy >= h - 1) continue;
      for (let x = margin; x < w - margin; x += step) {
        let cx = x + dx;
        if (wrapX) cx = ((cx % w) + w) % w;
        if (cx < 1 || cx >= w - 1) continue;
        const rp = y * w + x, cp = cy * w + cx;
        const rgx = ref.gradX[rp], rgy = ref.gradY[rp];
        const cgx = cur.gradX[cp], cgy = cur.gradY[cp];
        sum += rgx * cgx + rgy * cgy;
        sumR += rgx + rgy; sumC += cgx + cgy;
        sumRR += rgx * rgx + rgy * rgy;
        sumCC += cgx * cgx + cgy * cgy; n += 2;
      }
    }
    const cov = sum - sumR * sumC / Math.max(1, n);
    const den = Math.sqrt(Math.max(1e-12, (sumRR - sumR * sumR / Math.max(1, n)) *
      (sumCC - sumC * sumC / Math.max(1, n))));
    return cov / den;
  }

  function registerOneWay(ref, cur, wrapX) {
    if (ref.w !== cur.w || ref.h !== cur.h) return { dx: 0, dy: 0, confidence: 0 };
    let best = { dx: 0, dy: 0, score: -Infinity };
    // Coarse-to-fine search, bounded to roughly 5% of proxy width.
    const radius = Math.min(32, Math.max(8, Math.round(ref.w * 0.05)));
    for (let dy = -radius; dy <= radius; dy += 2) for (let dx = -radius; dx <= radius; dx += 2) {
      const s = scoreShift(ref, cur, dx, dy, 3, wrapX); if (s > best.score) best = { dx, dy, score: s };
    }
    for (const stride of [2, 1]) {
      const start = { ...best };
      for (let dy = start.dy - stride * 2; dy <= start.dy + stride * 2; dy += stride)
        for (let dx = start.dx - stride * 2; dx <= start.dx + stride * 2; dx += stride) {
          const s = scoreShift(ref, cur, dx, dy, 2, wrapX); if (s > best.score) best = { dx, dy, score: s };
        }
    }
    // Parabolic subpixel interpolation around the integer maximum.
    // Re-evaluate the final peak and its neighborhood at the same dense sampling.
    const sx1 = scoreShift(ref, cur, best.dx, best.dy, 1, wrapX);
    const sx0 = scoreShift(ref, cur, best.dx - 1, best.dy, 1, wrapX);
    const sx2 = scoreShift(ref, cur, best.dx + 1, best.dy, 1, wrapX);
    const sy0 = scoreShift(ref, cur, best.dx, best.dy - 1, 1, wrapX);
    const sy2 = scoreShift(ref, cur, best.dx, best.dy + 1, 1, wrapX);
    const sub = (a, b, c) => {
      const curvature = a - 2 * b + c;
      return curvature < -1e-6 ? clamp(0.5 * (a - c) / curvature, -0.5, 0.5) : 0;
    };
    return { dx: best.dx + sub(sx0, sx1, sx2), dy: best.dy + sub(sy0, sx1, sy2), confidence: sx1 };
  }

  // Dense native-resolution patch refinement around an already-known coarse
  // displacement. The bounded search is intentionally small; align.js supplies
  // crops centred at the proxy estimate, so this measures only its residual.
  function refinePatch(refGray, curGray, w, h, radius = 6) {
    if (!refGray || !curGray || refGray.length !== w*h || curGray.length !== w*h) {
      return { dx: 0, dy: 0, confidence: 0, rejected: true };
    }
    const proxy = gray => ({ gray, w, h, ...computeGradients(gray, w, h) });
    const ref = proxy(refGray), cur = proxy(curGray);
    function oneWay(a, b) {
      let best = { dx: 0, dy: 0, score: -Infinity };
      for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
        const score = scoreShift(a, b, dx, dy, 3, false);
        if (score > best.score) best = { dx, dy, score };
      }
      const center = scoreShift(a, b, best.dx, best.dy, 1, false);
      const xm = scoreShift(a, b, best.dx-1, best.dy, 1, false);
      const xp = scoreShift(a, b, best.dx+1, best.dy, 1, false);
      const ym = scoreShift(a, b, best.dx, best.dy-1, 1, false);
      const yp = scoreShift(a, b, best.dx, best.dy+1, 1, false);
      const sub = (lo, mid, hi) => {
        const curvature = lo - 2*mid + hi;
        return curvature < -1e-6 ? clamp(.5*(lo-hi)/curvature, -.5, .5) : 0;
      };
      return { dx: best.dx+sub(xm,center,xp), dy: best.dy+sub(ym,center,yp), confidence:center,
        boundary: Math.abs(best.dx) === radius || Math.abs(best.dy) === radius };
    }
    const forward = oneWay(ref, cur), reverse = oneWay(cur, ref);
    const consistency = Math.hypot(forward.dx+reverse.dx, forward.dy+reverse.dy);
    if (!Number.isFinite(forward.confidence) || forward.confidence < .22 || consistency > .8 ||
        forward.boundary || reverse.boundary) {
      return { dx: 0, dy: 0, confidence: 0, rejected: true };
    }
    return { dx:.5*(forward.dx-reverse.dx), dy:.5*(forward.dy-reverse.dy),
      confidence:forward.confidence, consistency };
  }

  S360.frameRegistration = {
    computeGradients,
    refinePatch,

    // Register `cur` against `ref`. Registration is optional: only move a frame
    // when the candidate clearly beats leaving it untouched and the reverse
    // solve independently agrees. This conservative gate prevents repeated
    // textures/noise from creating a destructive multi-pixel shift.
    register(ref, cur, wrapX) {
      const forward = registerOneWay(ref, cur, wrapX);
      const reverse = registerOneWay(cur, ref, wrapX);
      const zeroScore = scoreShift(ref, cur, 0, 0, 1, wrapX);
      const consistency = Math.hypot(forward.dx + reverse.dx, forward.dy + reverse.dy);
      const movement = Math.hypot(forward.dx, forward.dy);

      const improvement = forward.confidence - zeroScore;
      if (!Number.isFinite(forward.confidence) || forward.confidence < 0.18 ||
          consistency > 0.65 || (movement > 0.35 && improvement < 0.012)) {
        return { dx: 0, dy: 0, confidence: 0, rejected: true };
      }
      // Average the two independent estimates to reduce residual subpixel bias.
      return {
        dx: 0.5 * (forward.dx - reverse.dx),
        dy: 0.5 * (forward.dy - reverse.dy),
        confidence: forward.confidence,
        improvement
      };
    },
  };
})(globalThis.S360);
