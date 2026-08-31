// align-worker.js - registration worker for frame alignment
// Self-contained: receives transferable grayscale proxy buffers, runs
// forward+reverse gradient-correlation registration, posts back results.
// Mirrors the logic in align.js (registerOneWay / register) so both paths
// stay consistent.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function score(A, B, dx, dy, step, wrap) {
  const w = A.w, h = A.h;
  let s = 0, sa = 0, sb = 0, saa = 0, sbb = 0, n = 0;
  const margin = 12;
  for (let y = margin; y < h - margin; y += step) {
    const yy = y + dy;
    if (yy < 1 || yy >= h - 1) continue;
    for (let x = margin; x < w - margin; x += step) {
      let xx = x + dx;
      if (wrap) xx = ((xx % w) + w) % w;
      if (xx < 1 || xx >= w - 1) continue;
      const p = y * w + x, q = yy * w + xx;
      const ax = A.gray[p + 1] - A.gray[p - 1];
      const ay = A.gray[p + w] - A.gray[p - w];
      const bx = B.gray[q + 1] - B.gray[q - 1];
      const by = B.gray[q + w] - B.gray[q - w];
      s  += ax * bx + ay * by;
      sa += ax + ay;
      sb += bx + by;
      saa += ax * ax + ay * ay;
      sbb += bx * bx + by * by;
      n  += 2;
    }
  }
  const cov = s - sa * sb / Math.max(1, n);
  const den = Math.sqrt(Math.max(1e-12,
    (saa - sa * sa / Math.max(1, n)) * (sbb - sb * sb / Math.max(1, n))));
  return cov / den;
}

function searchPeak(A, B, wrap) {
  let best = { dx: 0, dy: 0, score: -Infinity };
  const radius = Math.min(32, Math.max(8, Math.round(A.w * 0.05)));
  for (let dy = -radius; dy <= radius; dy += 2) {
    for (let dx = -radius; dx <= radius; dx += 2) {
      const v = score(A, B, dx, dy, 3, wrap);
      if (v > best.score) best = { dx, dy, score: v };
    }
  }
  for (const stride of [2, 1]) {
    const start = { ...best };
    for (let dy = start.dy - stride * 2; dy <= start.dy + stride * 2; dy += stride) {
      for (let dx = start.dx - stride * 2; dx <= start.dx + stride * 2; dx += stride) {
        const v = score(A, B, dx, dy, 2, wrap);
        if (v > best.score) best = { dx, dy, score: v };
      }
    }
  }
  // Parabolic subpixel refinement at unit stride.
  const c  = score(A, B, best.dx,     best.dy,     1, wrap);
  const l  = score(A, B, best.dx - 1, best.dy,     1, wrap);
  const r  = score(A, B, best.dx + 1, best.dy,     1, wrap);
  const u  = score(A, B, best.dx,     best.dy - 1, 1, wrap);
  const d  = score(A, B, best.dx,     best.dy + 1, 1, wrap);
  const sub = (a, b, c) => {
    const k = a - 2 * b + c;
    return k < -1e-6 ? clamp(0.5 * (a - c) / k, -0.5, 0.5) : 0;
  };
  return {
    dx: best.dx + sub(l, c, r),
    dy: best.dy + sub(u, c, d),
    confidence: c
  };
}

function register(A, B, wrap) {
  const forward  = searchPeak(A, B, wrap);
  const reverse  = searchPeak(B, A, wrap);
  const zeroScore = score(A, B, 0, 0, 1, wrap);
  const consistency = Math.hypot(forward.dx + reverse.dx, forward.dy + reverse.dy);
  const movement    = Math.hypot(forward.dx, forward.dy);
  const improvement = forward.confidence - zeroScore;

  if (!Number.isFinite(forward.confidence) || forward.confidence < 0.18 ||
      consistency > 0.65 || (movement > 0.35 && improvement < 0.012)) {
    return { dx: 0, dy: 0, confidence: 0, rejected: true };
  }
  return {
    dx: 0.5 * (forward.dx - reverse.dx),
    dy: 0.5 * (forward.dy - reverse.dy),
    confidence: forward.confidence,
    improvement
  };
}

self.onmessage = function (e) {
  try {
    const { proxies, referenceIndex, wrap } = e.data;
    for (const p of proxies) {
      p.gray = new Float32Array(p.buffer);
    }
    const ref = proxies[referenceIndex];
    const registrations = proxies.map((p, i) =>
      i === referenceIndex
        ? { dx: 0, dy: 0, confidence: 1 }
        : register(ref, p, wrap)
    );
    self.postMessage({ registrations });
  } catch (error) {
    self.postMessage({ error: error.message || String(error) });
  }
};
