// align.js - bounded-memory proxy analysis for multi-frame fusion
window.S360 = window.S360 || {};
(function (S360) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const srgbToLinear = v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);

  function proxyFromImage(img, maxWidth = 640) {
    const w = Math.min(maxWidth, img.width);
    const h = Math.max(1, Math.round(img.height * w / img.width));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    const values = [];
    let sharpness = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x, i = p * 4;
      const r = rgba[i] / 255, g = rgba[i + 1] / 255, b = rgba[i + 2] / 255;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      gray[p] = lum;
      if (lum > 0.03 && lum < 0.97 && (x + y) % 5 === 0) values.push(lum);
    }
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const lap = 4 * gray[p] - gray[p - 1] - gray[p + 1] - gray[p - w] - gray[p + w];
      sharpness += lap * lap;
    }
    values.sort((a, b) => a - b);
    const median = values.length ? values[values.length >> 1] : 0.5;
    return { gray, w, h, sourceW: img.width, sourceH: img.height,
      sharpness: sharpness / Math.max(1, (w - 2) * (h - 2)), median };
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
        // Use both gradient axes. Horizontal-only correlation produced strong
        // false peaks in scenes dominated by vertical edges and repeated detail.
        const rp = y * w + x, cp = cy * w + cx;
        const rgx = ref.gray[rp + 1] - ref.gray[rp - 1];
        const rgy = ref.gray[rp + w] - ref.gray[rp - w];
        const cgx = cur.gray[cp + 1] - cur.gray[cp - 1];
        const cgy = cur.gray[cp + w] - cur.gray[cp - w];
        // Correlate gradient vectors as two independent samples.
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

  function register(ref, cur, wrapX) {
    const forward = registerOneWay(ref, cur, wrapX);
    const reverse = registerOneWay(cur, ref, wrapX);
    const zeroScore = scoreShift(ref, cur, 0, 0, 1, wrapX);
    const consistency = Math.hypot(forward.dx + reverse.dx, forward.dy + reverse.dy);
    const movement = Math.hypot(forward.dx, forward.dy);

    // Registration is optional: only move a frame when the candidate clearly
    // beats leaving it untouched and the reverse solve independently agrees.
    // This conservative gate prevents repeated textures/noise from creating a
    // destructive multi-pixel shift.
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
  }

  async function registerInWorker(proxies, referenceIndex, stitched) {
    if (typeof Worker === 'undefined') return null;
    let worker;
    try { worker = new Worker('align-worker.js'); } catch (_) { return null; }
    const payload = proxies.map(p => ({ w: p.w, h: p.h, buffer: p.gray.slice().buffer }));
    const transfers = payload.map(p => p.buffer);
    return new Promise(resolve => {
      const timer = setTimeout(() => { worker.terminate(); resolve(null); }, 30000);
      worker.onmessage = e => {
        clearTimeout(timer); worker.terminate();
        resolve(e.data?.error ? null : e.data.registrations);
      };
      worker.onerror = () => { clearTimeout(timer); worker.terminate(); resolve(null); };
      worker.postMessage({ proxies: payload, referenceIndex, wrap: stitched }, transfers);
    });
  }

  S360.analyzeFrameFiles = async function (files, loadImage, setLoading, shouldCancel, stitched = false) {
    const proxies = [];
    for (let i = 0; i < files.length; i++) {
      if (shouldCancel && shouldCancel()) throw new DOMException('Processing cancelled.', 'AbortError');
      setLoading(true, `Analysing frame ${i + 1} of ${files.length}...`);
      let img = null;
      try { img = await loadImage(files[i]); proxies.push(proxyFromImage(img)); }
      finally { S360.releaseImage(img); }
      await new Promise(requestAnimationFrame);
    }
    const ranked = proxies.map((p, i) => ({ i, score: p.sharpness * (0.5 + Math.min(p.median, 1 - p.median)) }))
      .sort((a, b) => b.score - a.score);
    const referenceIndex = ranked[0].i, ref = proxies[referenceIndex];
    const workerRegs = await registerInWorker(proxies, referenceIndex, stitched);
    const frames = proxies.map((p, i) => {
      const reg = workerRegs?.[i] || (i === referenceIndex ? { dx: 0, dy: 0, confidence: 1 } : register(ref, p, stitched));
      // Multiplicative normalization in linear-light fusion; clamp extreme estimates.
      const exposureGain = clamp(srgbToLinear(ref.median) / Math.max(0.002, srgbToLinear(p.median)), 0.25, 4);
      return {
        // scoreShift compares reference(x,y) with current(x+dx,y+dy), so the
        // fusion shader must sample the current frame at that SAME positive
        // displacement. The previous negation shifted X in the wrong direction.
        offset: [reg.dx * p.sourceW / p.w, reg.dy * p.sourceH / p.h],
        sourceSize: [p.sourceW, p.sourceH], exposureGain,
        confidence: reg.confidence, sharpness: p.sharpness
      };
    });
    return { referenceIndex, frames, stitched };
  };
})(window.S360);
