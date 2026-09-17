// Owns full-panorama horizon detection and conversion to the global lens-basis correction.
// analyze(canvas, currentHorizon) returns guarded absolute pitch/roll settings.
globalThis.S360 = globalThis.S360 || {};
(function (S360) {
'use strict';
  const PI = Math.PI;
  const RAD = PI / 180;
  const DEG = 180 / PI;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function rotate(v, axis, angle) {
    return S360.rotateAroundAxis(v, axis, angle);
  }

  function requiredNormal(pitchDeg, rollDeg) {
    const p = pitchDeg * RAD, r = rollDeg * RAD;
    return [-Math.sin(p) * Math.cos(r), Math.sin(r), Math.cos(p) * Math.cos(r)];
  }

  function sourceNormal(outputNormal, current) {
    const r = (current?.roll || 0) * RAD;
    const p = (current?.pitch || 0) * RAD;
    return rotate(rotate(outputNormal, [1, 0, 0], -r), [0, 1, 0], -p);
  }

  function absoluteCorrection(normal) {
    const pitch = Math.atan2(-normal[0], normal[2]);
    const z = Math.hypot(normal[0], normal[2]);
    const roll = Math.atan2(normal[1], z);
    return { pitch: clamp(pitch * DEG, -90, 90), roll: clamp(roll * DEG, -180, 180) };
  }

  function percentile(values, q) {
    if (!values.length) return 0;
    values.sort((a, b) => a - b);
    return values[Math.min(values.length - 1, Math.floor(q * values.length))];
  }

  function buildEdges(data, width, height) {
    const gray = new Float32Array(width * height);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = data[p] * 0.2126 + data[p + 1] * 0.7152 + data[p + 2] * 0.0722;
    }
    const gx = new Float32Array(gray.length), gy = new Float32Array(gray.length);
    const strengths = [];
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      gx[i] = (gray[i + 1] - gray[i - 1]) * 0.5;
      gy[i] = (gray[i + width] - gray[i - width]) * 0.5;
      if ((x & 3) === 0 && (y & 3) === 0) strengths.push(Math.hypot(gx[i], gy[i]));
    }
    return { gx, gy, threshold: Math.max(4, percentile(strengths, 0.72)) };
  }

  function curveScore(edges, width, height, pitch, roll) {
    const n = requiredNormal(pitch, roll);
    const values = [];
    let supported = 0, valid = 0;
    const columns = Math.min(192, Math.max(64, Math.floor(width / 3)));
    for (let k = 0; k < columns; k++) {
      const x = (k + 0.5) * width / columns;
      const lon = (x / width * 2 - 1) * PI;
      const c = n[0] * Math.cos(lon) + n[1] * Math.sin(lon);
      const lat = Math.atan2(-c, n[2]);
      const yf = (0.5 - lat / PI) * height;
      if (yf < height * 0.08 || yf > height * 0.92) continue;
      const dc = -n[0] * Math.sin(lon) + n[1] * Math.cos(lon);
      const slope = (2 * dc * n[2]) / (n[2] * n[2] + c * c);
      const norm = Math.hypot(1, slope);
      let best = 0;
      const xi = clamp(Math.round(x), 1, width - 2), yi = Math.round(yf);
      for (let oy = -2; oy <= 2; oy++) {
        const sy = clamp(yi + oy, 1, height - 2), i = sy * width + xi;
        const proximity = oy === 0 ? 1 : (Math.abs(oy) === 1 ? 0.82 : 0.58);
        best = Math.max(best, Math.abs(edges.gy[i] - slope * edges.gx[i]) / norm * proximity);
      }
      values.push(best);
      if (best >= edges.threshold) supported++;
      valid++;
    }
    if (valid < columns * 0.8) return { score: 0, coverage: 0 };
    values.sort((a, b) => a - b);
    const lo = Math.floor(values.length * 0.25), hi = Math.ceil(values.length * 0.9);
    let sum = 0;
    for (let i = lo; i < hi; i++) sum += values[i];
    return { score: sum / Math.max(1, hi - lo), coverage: supported / valid };
  }

  function search(edges, width, height, centerP, centerR, radius, step) {
    let best = { score: -Infinity, coverage: 0, pitch: centerP, roll: centerR };
    for (let p = centerP - radius; p <= centerP + radius + 1e-6; p += step) {
      if (p < -55 || p > 55) continue;
      for (let r = centerR - radius; r <= centerR + radius + 1e-6; r += step) {
        if (r < -55 || r > 55) continue;
        const scored = curveScore(edges, width, height, p, r);
        const combined = scored.score * (0.65 + 0.35 * scored.coverage);
        if (combined > best.score) best = { ...scored, score: combined, pitch: p, roll: r };
      }
    }
    return best;
  }

  S360.horizonLeveling = {
    analyze(canvas, currentHorizon = { pitch: 0, roll: 0 }) {
      const width = canvas?.width | 0, height = canvas?.height | 0;
      if (width < 64 || height < 32) throw new Error('Panorama preview is too small to analyze.');
      const image = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height);
      const edges = buildEdges(image.data, width, height);
      let best = search(edges, width, height, 0, 0, 45, 5);
      best = search(edges, width, height, best.pitch, best.roll, 5, 1);
      best = search(edges, width, height, best.pitch, best.roll, 1, 0.2);
      if (best.coverage < 0.28 || best.score < edges.threshold * 0.55) {
        return { success: false, confidence: best.coverage };
      }
      const normal = requiredNormal(best.pitch, best.roll);
      const correction = absoluteCorrection(sourceNormal(normal, currentHorizon));
      return { success: true, ...correction, confidence: best.coverage,
        detectedPitch: best.pitch, detectedRoll: best.roll };
    },
    requiredNormal,
    absoluteCorrection,
    correctionFromOutputNormal(normal, currentHorizon = { pitch: 0, roll: 0 }) {
      return absoluteCorrection(sourceNormal(normal, currentHorizon));
    },
  };
})(globalThis.S360);
