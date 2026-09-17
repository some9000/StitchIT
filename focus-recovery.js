// focus-recovery.js — automatic focus recovery via region analysis.
// Owns region selection/readback and the pure blur estimator. Click a detailed
// region to estimate blur radius and focus recovery from the rendered pixels.
window.S360 = window.S360 || {};
S360.focusRecovery = (() => {
  'use strict';

  let _cfg, _getCurrentImg, _readRegion;
  let _cursorCanvas, _cursorCtx, _active = false;
  let _lastMousePos = { x: 0, y: 0 };
  let _onComplete = null, _onProgress = null;
  const REGION_SIZE = 256; // Analysis region size in source pixels
  const CURSOR_SIZE = 128; // Visual cursor size in canvas pixels

  function init(deps) {
    _cfg = deps.cfg;
    _getCurrentImg = deps.getCurrentImg;
    _readRegion = deps.readRegion;
    createCursorCanvas();
    return this;
  }

  function createCursorCanvas() {
    const panoramaCanvas = document.getElementById('panoramaCanvas');
    if (!panoramaCanvas) return;

    _cursorCanvas = document.createElement('canvas');
    _cursorCanvas.id = 'focusRecoveryCursor';
    _cursorCanvas.style.cssText = 'position:absolute;pointer-events:none;z-index:6;display:none;';
    panoramaCanvas.parentElement.appendChild(_cursorCanvas);

    syncCursorCanvas();
    window.addEventListener('resize', syncCursorCanvas);

    _cursorCtx = _cursorCanvas.getContext('2d');
  }

  function syncCursorCanvas() {
    const panoramaCanvas = document.getElementById('panoramaCanvas');
    if (!_cursorCanvas || !panoramaCanvas?.parentElement) return;
    const rect = panoramaCanvas.getBoundingClientRect();
    const parentRect = panoramaCanvas.parentElement.getBoundingClientRect();
    _cursorCanvas.width = Math.max(1, Math.round(rect.width));
    _cursorCanvas.height = Math.max(1, Math.round(rect.height));
    _cursorCanvas.style.left = `${rect.left - parentRect.left}px`;
    _cursorCanvas.style.top = `${rect.top - parentRect.top}px`;
    _cursorCanvas.style.width = `${rect.width}px`;
    _cursorCanvas.style.height = `${rect.height}px`;
  }

  function start(onComplete, onProgress) {
    if (!_cursorCanvas || _active) return false;
    if (!_getCurrentImg()) return false;

    const panoramaCanvas = document.getElementById('panoramaCanvas');
    syncCursorCanvas(); // The image load may have changed the canvas aspect ratio.
    _active = true;
    _onComplete = onComplete;
    _onProgress = onProgress;
    const rect = panoramaCanvas.getBoundingClientRect();
    _lastMousePos = { x: rect.width / 2, y: rect.height / 2 };
    _cursorCanvas.style.display = 'block';

    // Attach mouse handlers to panorama canvas
    panoramaCanvas.addEventListener('mousemove', onMouseMove);
    panoramaCanvas.addEventListener('click', onClick);
    panoramaCanvas.addEventListener('mouseleave', onMouseLeave);

    // ESC to cancel
    window.addEventListener('keydown', onKeyDown);

    // Initial cursor draw
    drawCursor();
    return true;
  }

  function stopSelection() {
    _active = false;

    const panoramaCanvas = document.getElementById('panoramaCanvas');
    if (panoramaCanvas) {
      panoramaCanvas.removeEventListener('mousemove', onMouseMove);
      panoramaCanvas.removeEventListener('click', onClick);
      panoramaCanvas.removeEventListener('mouseleave', onMouseLeave);
    }
    window.removeEventListener('keydown', onKeyDown);

    if (_cursorCanvas) {
      _cursorCanvas.style.display = 'none';
      _cursorCtx?.clearRect(0, 0, _cursorCanvas.width, _cursorCanvas.height);
    }
  }

  function finish(result) {
    const complete = _onComplete;
    _onComplete = null;
    _onProgress = null;
    stopSelection();
    complete?.(result);
  }

  function onMouseMove(e) {
    if (!_active) return;
    const rect = _cursorCanvas.getBoundingClientRect();
    _lastMousePos.x = e.clientX - rect.left;
    _lastMousePos.y = e.clientY - rect.top;
    drawCursor();
  }

  function onMouseLeave() {
    if (!_active) return;
    _cursorCtx?.clearRect(0, 0, _cursorCanvas.width, _cursorCanvas.height);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && _active) {
      finish(null);
    }
  }

  function onClick(e) {
    if (!_active) return;
    const rect = _cursorCanvas.getBoundingClientRect();
    analyzeAtPosition(e.clientX - rect.left, e.clientY - rect.top);
  }

  function drawCursor() {
    if (!_cursorCtx || !_active) return;
    const ctx = _cursorCtx;
    ctx.clearRect(0, 0, _cursorCanvas.width, _cursorCanvas.height);

    const { x, y } = _lastMousePos;
    const half = CURSOR_SIZE / 2;
    const left = x - half;
    const top = y - half;

    // Draw region preview square (like brush cursor)
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]);
    ctx.strokeRect(left, top, CURSOR_SIZE, CURSOR_SIZE);

    // Corner markers
    const markerSize = 14;
    ctx.setLineDash([]);
    ctx.beginPath();
    // Top-left
    ctx.moveTo(left, top + markerSize);
    ctx.lineTo(left, top);
    ctx.lineTo(left + markerSize, top);
    // Top-right
    ctx.moveTo(left + CURSOR_SIZE - markerSize, top);
    ctx.lineTo(left + CURSOR_SIZE, top);
    ctx.lineTo(left + CURSOR_SIZE, top + markerSize);
    // Bottom-left
    ctx.moveTo(left, top + CURSOR_SIZE - markerSize);
    ctx.lineTo(left, top + CURSOR_SIZE);
    ctx.lineTo(left + markerSize, top + CURSOR_SIZE);
    // Bottom-right
    ctx.moveTo(left + CURSOR_SIZE - markerSize, top + CURSOR_SIZE);
    ctx.lineTo(left + CURSOR_SIZE, top + CURSOR_SIZE);
    ctx.lineTo(left + CURSOR_SIZE, top + CURSOR_SIZE - markerSize);
    ctx.stroke();

    // Center crosshair
    ctx.beginPath();
    ctx.moveTo(x - 8, y);
    ctx.lineTo(x - 2, y);
    ctx.moveTo(x + 2, y);
    ctx.lineTo(x + 8, y);
    ctx.moveTo(x, y - 8);
    ctx.lineTo(x, y - 2);
    ctx.moveTo(x, y + 2);
    ctx.lineTo(x, y + 8);
    ctx.stroke();

    // Label
    ctx.fillStyle = '#00ff88';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Click to analyze', x, top - 8);
  }

  // Analyze the region at the given canvas position
  async function analyzeAtPosition(canvasX, canvasY) {
    const img = _getCurrentImg();
    if (!img) {
      finish({ success: false, error: 'No image loaded' });
      return;
    }

    stopSelection(); // The processing overlay may safely take pointer input now.
    let selection;
    try {
      // Read before yielding: a WebGL default framebuffer is not guaranteed to
      // retain its pixels after the browser composites the current frame.
      selection = readRegionAtCanvasPos(canvasX, canvasY);
    } catch (err) {
      finish({ success: false, error: err?.message || String(err) });
      return;
    }
    _onProgress?.(0.1);
    // Give the browser one frame to paint the overlay before readback/analysis.
    await new Promise(resolve => requestAnimationFrame(() => resolve()));

    try {
      const analysis = analyzeBlur(selection.imageData, selection.width, selection.height);
      if (analysis.confidence < 0.2) {
        throw new Error('The selected area has too little contrast. Choose text, edges, or a detailed pattern.');
      }
      _onProgress?.(0.9);
      const oldRadius = _cfg.focusRadius;
      const oldRecovery = _cfg.focusRecovery;

      _cfg.focusRadius = analysis.estimatedBlurRadius;
      _cfg.focusRecovery = analysis.estimatedRecovery;

      finish({
        success: true,
        analysis,
        previous: { focusRadius: oldRadius, focusRecovery: oldRecovery },
        applied: { focusRadius: _cfg.focusRadius, focusRecovery: _cfg.focusRecovery }
      });
    } catch (err) {
      finish({ success: false, error: err?.message || String(err) });
    }
  }

  function readRegionAtCanvasPos(canvasX, canvasY) {
    const panoramaCanvas = document.getElementById('panoramaCanvas');
    if (!panoramaCanvas) throw new Error('Panorama canvas not found');

    const rect = panoramaCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) throw new Error('Panorama preview is not visible');
    const selected = _readRegion(canvasX / rect.width, canvasY / rect.height, REGION_SIZE);
    if (!selected?.pixels || !selected.width || !selected.height) {
      throw new Error('Could not read the selected panorama region');
    }
    const { pixels, width: sampleW, height: sampleH } = selected;

    // Downsample large on-screen selections so analysis cost stays bounded.
    if (sampleW <= REGION_SIZE && sampleH <= REGION_SIZE) {
      return { imageData: { data: pixels }, width: sampleW, height: sampleH };
    }
    const outW = Math.min(REGION_SIZE, sampleW), outH = Math.min(REGION_SIZE, sampleH);
    const reduced = new Uint8ClampedArray(outW * outH * 4);
    for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
      const sx = Math.min(sampleW - 1, Math.floor((x + 0.5) * sampleW / outW));
      const sy = Math.min(sampleH - 1, Math.floor((y + 0.5) * sampleH / outH));
      const si = (sy * sampleW + sx) * 4, di = (y * outW + x) * 4;
      reduced[di] = pixels[si]; reduced[di + 1] = pixels[si + 1];
      reduced[di + 2] = pixels[si + 2]; reduced[di + 3] = pixels[si + 3];
    }
    return { imageData: { data: reduced }, width: outW, height: outH };
  }

  async function analyzeRegionAtCanvasPos(canvasX, canvasY) {
    const selection = readRegionAtCanvasPos(canvasX, canvasY);
    return analyzeBlur(selection.imageData, selection.width, selection.height);
  }

  // Analyze blur in an image region using frequency domain analysis
  function analyzeBlur(imageData, width, height) {
    const data = imageData.data;
    const gray = new Float32Array(width * height);

    // Convert to grayscale luminance
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      gray[j] = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    }

    // Compute gradient magnitude (edge strength)
    const gradients = computeGradients(gray, width, height);
    let gradientEnergy = 0, meanGradient = 0;
    for (const value of gradients) { meanGradient += value; gradientEnergy += value * value; }
    meanGradient /= Math.max(1, gradients.length);
    gradientEnergy /= Math.max(1, gradients.length);

    // Compute high-frequency energy via Laplacian
    const highFreqEnergy = computeHighFrequencyEnergy(gray, width, height);

    let mean = 0, variance = 0;
    for (const value of gray) mean += value;
    mean /= gray.length;
    for (const value of gray) variance += (value - mean) ** 2;
    const contrast = Math.sqrt(variance / gray.length);

    // Measure the width of coherent tonal transitions. Unlike a raw frequency
    // ratio, this does not mistake fine texture or sensor noise for sharp focus.
    const frequencyRatio = Math.sqrt(highFreqEnergy / Math.max(gradientEnergy, 1e-8));
    const edgeEstimate = estimateEdgeSpread(gray, width, height);
    const confidence = Math.max(0, Math.min(1, (contrast - 0.008) / 0.07)) *
      Math.max(0, Math.min(1, edgeEstimate.count / 12));

    // The sampled step-edge baseline is about 0.5 px. The shader's radius is a
    // sampling distance rather than a Gaussian sigma, so a modest scale factor
    // maps measured edge spread onto its 0.5–4.0 px control.
    const estimatedBlurRadius = edgeEstimate.spread * 1.35;
    const clampedRadius = Math.round(Math.max(0.5, Math.min(4.0, estimatedBlurRadius)) * 10) / 10;
    const sharpness = 1 - (clampedRadius - 0.5) / 3.5;

    // Estimate focus recovery amount
    const estimatedRecovery = Math.round(Math.min(0.9, (clampedRadius - 0.5) / 3.5 * 0.9) * 100) / 100;

    return {
      sharpness,
      confidence,
      estimatedBlurRadius: clampedRadius,
      estimatedRecovery,
      meanGradient,
      highFreqEnergy,
      metrics: { contrast, gradientEnergy, frequencyRatio, edgeSpread: edgeEstimate.spread, edgeCount: edgeEstimate.count }
    };
  }

  function sampleGray(gray, width, height, x, y) {
    x = Math.max(0, Math.min(width - 1, x));
    y = Math.max(0, Math.min(height - 1, y));
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const a = gray[y0 * width + x0] * (1 - fx) + gray[y0 * width + x1] * fx;
    const b = gray[y1 * width + x0] * (1 - fx) + gray[y1 * width + x1] * fx;
    return a * (1 - fy) + b * fy;
  }

  function estimateEdgeSpread(gray, width, height) {
    const margin = 7, candidates = [];
    if (width <= margin * 2 || height <= margin * 2) return { spread: 4 / 1.35, count: 0 };
    for (let y = margin; y < height - margin; y += 2) {
      for (let x = margin; x < width - margin; x += 2) {
        const i = y * width + x;
        const gx = gray[i + 1] - gray[i - 1];
        const gy = gray[i + width] - gray[i - width];
        const magnitude = Math.hypot(gx, gy);
        if (magnitude >= 0.015) candidates.push({ x, y, gx, gy, magnitude });
      }
    }
    candidates.sort((a, b) => b.magnitude - a.magnitude);
    const spreads = [];
    for (let c = 0; c < candidates.length && c < 600 && spreads.length < 96; c++) {
      const edge = candidates[c], nx = edge.gx / edge.magnitude, ny = edge.gy / edge.magnitude;
      const values = [];
      for (let t = -6; t <= 6; t++) values.push(sampleGray(gray, width, height, edge.x + nx * t, edge.y + ny * t));
      let variation = 0;
      for (let i = 0; i < values.length - 1; i++) variation += Math.abs(values[i + 1] - values[i]);
      const net = values.at(-1) - values[0];
      if (Math.abs(net) < 0.055 || Math.abs(net) / Math.max(variation, 1e-6) < 0.6) continue;
      const direction = Math.sign(net), weights = [];
      let total = 0;
      for (let i = 0; i < values.length - 1; i++) {
        const weight = Math.max(0, direction * (values[i + 1] - values[i]));
        weights.push(weight); total += weight;
      }
      if (total < 0.05) continue;
      let center = 0;
      for (let i = 0; i < weights.length; i++) center += (i - 5.5) * weights[i] / total;
      let variance = 0;
      for (let i = 0; i < weights.length; i++) variance += ((i - 5.5) - center) ** 2 * weights[i] / total;
      spreads.push(Math.sqrt(Math.max(0.14, variance)));
    }
    if (!spreads.length) return { spread: 4 / 1.35, count: 0 };
    spreads.sort((a, b) => a - b);
    // Prefer the sharper coherent edges in a mixed-depth region without letting
    // a single noise spike dictate the result.
    return { spread: spreads[Math.floor((spreads.length - 1) * 0.35)], count: spreads.length };
  }

  function computeGradients(gray, width, height) {
    const gradients = [];
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        const gx = gray[idx + 1] - gray[idx - 1];
        const gy = gray[idx + width] - gray[idx - width];
        gradients.push(Math.sqrt(gx * gx + gy * gy));
      }
    }
    return gradients;
  }

  function computeHighFrequencyEnergy(gray, width, height) {
    let energy = 0;
    let count = 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        const center = gray[idx];
        const laplacian =
          gray[idx - 1] + gray[idx + 1] +
          gray[idx - width] + gray[idx + width] -
          4 * center;
        energy += laplacian * laplacian;
        count++;
      }
    }
    return count > 0 ? energy / count : 0;
  }

  // Auto-focus: start selection mode, returns promise that resolves when user clicks
  function autoFocus(onProgress) {
    return new Promise((resolve, reject) => {
      const started = start((result) => {
        onProgress?.(1.0);
        if (result?.success) {
          resolve(result);
        } else if (result === null) {
          // User cancelled
          resolve({ success: false, cancelled: true });
        } else {
          reject(new Error(result?.error || 'Auto Focus cancelled'));
        }
      }, onProgress);
      if (!started) {
        reject(new Error('Could not start Auto Focus'));
      }
    });
  }

  return {
    init,
    autoFocus,
    cancel: () => finish(null),
    analyzeRegionAtCanvasPos,
    analyzeBlur,
    get isActive() { return _active; }
  };
})(window.S360);
