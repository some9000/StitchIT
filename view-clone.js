// Two-step view-space cloning: mark a destination, then place its source.
window.S360 = window.S360 || {};
(function (S360) {
'use strict';
  function canvas(w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }

  // ---- Multiband (Laplacian pyramid) blending helpers ---------------------
  const GAUSS_K = [1, 4, 6, 4, 1];

  function gaussianDownsample(src, w, h, c) {
    const w2 = Math.max(1, w >> 1), h2 = Math.max(1, h >> 1);
    const tmp = new Float32Array(w * h * c);
    for (let y = 0; y < h; y++) {
      const yo = y * w;
      for (let x = 0; x < w; x++) {
        for (let ch = 0; ch < c; ch++) {
          let sum = 0;
          for (let k = -2; k <= 2; k++) {
            const xx = x + k < 0 ? 0 : x + k >= w ? w - 1 : x + k;
            sum += GAUSS_K[k + 2] * src[(yo + xx) * c + ch];
          }
          tmp[(yo + x) * c + ch] = sum / 16;
        }
      }
    }
    const dst = new Float32Array(w2 * h2 * c);
    for (let y = 0; y < h2; y++) {
      for (let x = 0; x < w2; x++) {
        for (let ch = 0; ch < c; ch++) {
          let sum = 0;
          for (let k = -2; k <= 2; k++) {
            const yy = 2 * y + k;
            const yc = yy < 0 ? 0 : yy >= h ? h - 1 : yy;
            sum += GAUSS_K[k + 2] * tmp[(yc * w + 2 * x) * c + ch];
          }
          dst[(y * w2 + x) * c + ch] = sum / 16;
        }
      }
    }
    return { w: w2, h: h2, data: dst };
  }

  function upsample(src, sw, sh, dw, dh, c) {
    const dst = new Float32Array(dw * dh * c);
    const scaleX = dw > 1 ? (sw - 1) / (dw - 1) : 0;
    const scaleY = dh > 1 ? (sh - 1) / (dh - 1) : 0;
    for (let y = 0; y < dh; y++) {
      const fy = y * scaleY, y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < dw; x++) {
        const fx = x * scaleX, x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
        for (let ch = 0; ch < c; ch++) {
          const v00 = src[(y0 * sw + x0) * c + ch], v10 = src[(y0 * sw + x1) * c + ch];
          const v01 = src[(y1 * sw + x0) * c + ch], v11 = src[(y1 * sw + x1) * c + ch];
          dst[(y * dw + x) * c + ch] =
            (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
        }
      }
    }
    return dst;
  }

  function gaussianPyramid(data, w, h, c, levels) {
    const g = [{ w, h, data }];
    for (let k = 0; k < levels; k++) {
      const prev = g[k];
      g.push(gaussianDownsample(prev.data, prev.w, prev.h, c));
    }
    return g;
  }

  function laplacianPyramid(g, levels, c) {
    const lap = [];
    for (let k = 0; k < levels; k++) {
      const up = upsample(g[k + 1].data, g[k + 1].w, g[k + 1].h, g[k].w, g[k].h, c);
      const data = new Float32Array(g[k].w * g[k].h * c);
      for (let i = 0; i < data.length; i++) data[i] = g[k].data[i] - up[i];
      lap.push({ w: g[k].w, h: g[k].h, data });
    }
    return lap;
  }

  function create({ ctx, overlay, radius, commit }) {
    const paint = overlay.getContext('2d');
    // Private accumulation layer: the selection is painted at full opacity here and
    // composited onto the overlay at 50% so overlapping strokes stay uniform.
    const markLayer = canvas(overlay.width || 1, overlay.height || 1);
    const markCtx = markLayer.getContext('2d');
    // Feathered copy of markLayer: blur-applied before compositing so the green
    // preview reflects the feather slider (soft edge) just like the Blur tool.
    const featheredLayer = canvas(overlay.width || 1, overlay.height || 1);
    const featheredCtx = featheredLayer.getContext('2d');
    const preview = canvas(1, 1), display = preview.getContext('2d');
    preview.id = 'clonePreviewCanvas';
    preview.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5';
    overlay.parentElement.appendChild(preview);
    const controls = document.getElementById('cloneControls'); // May be null if removed from HTML
    const feather = document.getElementById('cloneFeather');
    const adapt = document.getElementById('cloneAdapt');
    const hint = document.getElementById('cloneHint');
    let stroke = null, session = null, frame = 0;

    function cancel() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (stroke || session) paint.clearRect(0, 0, overlay.width, overlay.height);
      stroke = session = null;
      markCtx.clearRect(0, 0, markLayer.width, markLayer.height);
      featheredCtx.clearRect(0, 0, featheredLayer.width, featheredLayer.height);
      display.clearRect(0, 0, preview.width, preview.height);
      hint.textContent = '';
      hint.hidden = true;
    }

    function point(e, w = overlay.width, h = overlay.height) {
      const r = overlay.getBoundingClientRect();
      return { x: (e.clientX - r.left) * w / r.width, y: (e.clientY - r.top) * h / r.height };
    }

    function mark(p, from = p) {
      if (markLayer.width !== overlay.width || markLayer.height !== overlay.height) {
        markLayer.width = overlay.width; markLayer.height = overlay.height;
      }
      // Accumulate the raw selection at full opacity on the private layer, then
      // composite it onto the overlay at 50% so the visible base stays uniform.
      markCtx.strokeStyle = '#00ff00'; markCtx.fillStyle = '#00ff00';
      markCtx.lineWidth = radius() * 2; markCtx.lineCap = 'round'; markCtx.lineJoin = 'round';
      markCtx.beginPath(); markCtx.moveTo(from.x, from.y); markCtx.lineTo(p.x, p.y); markCtx.stroke();
      markCtx.beginPath(); markCtx.arc(p.x, p.y, radius(), 0, Math.PI * 2); markCtx.fill();
      paint.clearRect(0, 0, overlay.width, overlay.height);
      const f = featherRadius(overlay.width);
      if (f > 0) {
        // Feather > 0: blur the accumulated selection before compositing so the
        // green preview shows the soft edge that the actual mask will have.
        if (featheredLayer.width !== overlay.width || featheredLayer.height !== overlay.height) {
          featheredLayer.width = overlay.width; featheredLayer.height = overlay.height;
        }
        featheredCtx.clearRect(0, 0, featheredLayer.width, featheredLayer.height);
        featheredCtx.filter = `blur(${f}px)`;
        featheredCtx.drawImage(markLayer, 0, 0);
        featheredCtx.filter = 'none';
        paint.globalAlpha = 0.5;
        paint.drawImage(featheredLayer, 0, 0);
      } else {
        paint.globalAlpha = 0.5;
        paint.drawImage(markLayer, 0, 0);
      }
      paint.globalAlpha = 1.0;
    }

    function featherRadius(w) {
      // Feather 0-10 is a fraction of the brush size: 10 = 20% of the brush width
      // on each side (width = 2 x radius), 0 = a hard edge. Converted to device
      // pixels for the blur.
      const v = Math.max(0, Number(feather.value));
      const cssPx = (v / 10) * (0.2 * radius() * 2);
      return cssPx * w / Math.max(1, overlay.width);
    }

    function rebuildMask() {
      const s = session, m = s.mask.getContext('2d');
      m.clearRect(0, 0, s.mask.width, s.mask.height);
      // Blur WITHOUT clipping inward: a proper feather must soften outward into
      // the surrounding pixels too, otherwise the outer edge stays a hard cut.
      m.filter = `blur(${featherRadius(s.w)}px)`;
      m.drawImage(s.hardMask, 0, 0); m.filter = 'none';
    }

    function capture(e) {
      const gl = ctx.getGL(), main = ctx.getPanoramaCanvas();
      const { yaw, pitch, fov } = S360.viewer.getSphere();
      const camera = { yaw, pitch, fov, mirror: ctx.getMirror3D(), proj: S360.viewer.getProj() };
      S360.renderSphere(ctx);
      const shown = S360.readFboToCanvas(gl, null, main.width, main.height);
      let raw;
      try {
        S360.renderSphereInline(gl, main, { tex: ctx.getRenderTexture(), ...camera });
        raw = S360.readFboToCanvas(gl, null, main.width, main.height);
      } finally { S360.renderSphere(ctx); }
      const w = raw.width, h = raw.height;
      const fullMask = canvas(w, h), m = fullMask.getContext('2d');
      m.drawImage(overlay, 0, 0, w, h);
      const imageData = m.getImageData(0, 0, w, h);
      const pixels = imageData.data;
      let left = w, top = h, right = -1, bottom = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const a = (y * w + x) * 4 + 3;
        if (pixels[a]) {
          // The overlay shows the selection at 50% opacity, but the mask must stay
          // binary so feathering and the final clone result are unchanged.
          pixels[a] = 255;
          left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
        }
      }
      m.putImageData(imageData, 0, 0);
      if (right < left) { cancel(); return; }
      // Pad the crop so the blurred mask can soften outward into the surrounding
      // pixels (the Gaussian tail needs room beyond the raw selection boundary).
      const pad = Math.ceil(featherRadius(w) * 2);
      left = Math.max(0, left - pad); right = Math.min(w - 1, right + pad);
      top = Math.max(0, top - pad); bottom = Math.min(h - 1, bottom + pad);
      const bw = right - left + 1, bh = bottom - top + 1;
      const hardMask = canvas(bw, bh);
      hardMask.getContext('2d').drawImage(fullMask, -left, -top);
      session = { raw, shown, camera, w, h, left, top, bw, bh, hardMask,
        mask: canvas(bw, bh), patch: canvas(bw, bh), source: point(e, w, h) };
      stroke = null;
      preview.width = w; preview.height = h;
      paint.clearRect(0, 0, overlay.width, overlay.height);
      rebuildMask(); render();
      hint.textContent = 'Move to choose a source. Click to apply. Esc cancels.';
      hint.hidden = false;
    }

    function valid() {
      if (!session) return false;
      const c = S360.viewer.getSphere(), s = session.camera;
      if (ctx.getGL().isContextLost() || ctx.getViewMode() !== '3d' ||
        c.yaw !== s.yaw || c.pitch !== s.pitch || c.fov !== s.fov || ctx.getMirror3D() !== s.mirror ||
        S360.viewer.getProj() !== s.proj) {
        cancel(); return false;
      }
      return true;
    }

    function sourceRect() {
      const s = session;
      const zoom = s._zoom || 1;
      const bw = s.bw * zoom;
      const bh = s.bh * zoom;
      const x = Math.max(0, Math.min(s.w - bw, Math.round(s.source.x - bw / 2)));
      const y = Math.max(0, Math.min(s.h - bh, Math.round(s.source.y - bh / 2)));
      return { x, y, bw, bh };
    }

    function stamp(source) {
      const s = session, p = s.patch.getContext('2d');
      const { x, y, bw, bh } = sourceRect();
      p.clearRect(0, 0, s.bw, s.bh);
      p.drawImage(source, x, y, bw, bh, 0, 0, s.bw, s.bh);
      p.globalCompositeOperation = 'destination-in'; p.drawImage(s.mask, 0, 0);
      p.globalCompositeOperation = 'source-over';
      return { x, y };
    }

    // Match the clone's luminance and colour to the surrounding destination using
    // mean/standard-deviation transfer (Reinhard-style) in a luminance/chrominance
    // space. This shifts the WHOLE clone — not just its edge — toward the
    // surrounding exposure and white balance so the pasted region sits naturally.
    function matchCloneTone(s, cloneCtx) {
      if (Number(feather.value) <= 0) return; // feather 0 = exact copy, no tone blending
      // Adapt (0-100%) scales how strongly the clone adopts the destination's
      // exposure and colour. 0 = paste as-is, 100 = full tone transfer.
      const adaptAmount = adapt ? Math.max(0, Math.min(1, Number(adapt.value) / 100)) : 1;
      if (adaptAmount <= 0) return;
      const patch = cloneCtx.getImageData(0, 0, s.bw, s.bh);
      const mask = s.mask.getContext('2d').getImageData(0, 0, s.bw, s.bh).data;
      const hard = s.hardMask.getContext('2d').getImageData(0, 0, s.bw, s.bh).data;
      const raw = s.raw.getContext('2d').getImageData(s.left, s.top, s.bw, s.bh).data;

      const toYcc = (r, g, b) => [
        0.299 * r + 0.587 * g + 0.114 * b,
        -0.168736 * r - 0.331264 * g + 0.5 * b,
        0.5 * r - 0.418688 * g - 0.081312 * b,
      ];
      // First pass: per-channel means for the destination ring and clone interior.
      let sy = 0, scb = 0, scr = 0, sn = 0;
      let cy = 0, ccb = 0, ccr = 0, cn = 0;
      for (let i = 0; i < mask.length; i += 4) {
        if (hard[i + 3] === 0) {
          if (mask[i + 3] > 0) {
            const [y, cb, cr] = toYcc(raw[i], raw[i + 1], raw[i + 2]);
            sy += y; scb += cb; scr += cr; sn++;
          }
        } else if (mask[i + 3] > 200) {
          const [y, cb, cr] = toYcc(patch.data[i], patch.data[i + 1], patch.data[i + 2]);
          cy += y; ccb += cb; ccr += cr; cn++;
        }
      }
      if (sn < 4 || cn < 4) return;
      const syM = sy / sn, scbM = scb / sn, scrM = scr / sn;
      const cyM = cy / cn, ccbM = ccb / cn, ccrM = ccr / cn;
      // Second pass: standard deviations.
      let syV = 0, scbV = 0, scrV = 0;
      let cyV = 0, ccbV = 0, ccrV = 0;
      for (let i = 0; i < mask.length; i += 4) {
        if (hard[i + 3] === 0) {
          if (mask[i + 3] > 0) {
            const [y, cb, cr] = toYcc(raw[i], raw[i + 1], raw[i + 2]);
            syV += (y - syM) ** 2; scbV += (cb - scbM) ** 2; scrV += (cr - scrM) ** 2;
          }
        } else if (mask[i + 3] > 200) {
          const [y, cb, cr] = toYcc(patch.data[i], patch.data[i + 1], patch.data[i + 2]);
          cyV += (y - cyM) ** 2; ccbV += (cb - ccbM) ** 2; ccrV += (cr - ccrM) ** 2;
        }
      }
      const std = (v, n) => Math.sqrt(v / n);
      const gainY  = clampGain(std(syV, sn)  / Math.max(std(cyV, cn), 1));
      const gainCb = clampGain(std(scbV, sn) / Math.max(std(ccbV, cn), 1));
      const gainCr = clampGain(std(scrV, sn) / Math.max(std(ccrV, cn), 1));
      // Apply the transfer to the whole clone region (every pixel contributes to
      // the multiband blend, so the entire source must be tone-matched).
      for (let i = 0; i < mask.length; i += 4) {
        const r0 = patch.data[i], g0 = patch.data[i + 1], b0 = patch.data[i + 2];
        let [y, cb, cr] = toYcc(r0, g0, b0);
        y = (y - cyM) * gainY + syM;
        cb = (cb - ccbM) * gainCb + scbM;
        cr = (cr - ccrM) * gainCr + scrM;
        let r = y + 1.402 * cr;
        let g = y - 0.344136 * cb - 0.714136 * cr;
        let b = y + 1.772 * cb;
        // Blend between the original and the fully-adapted tone.
        r = r0 + (r - r0) * adaptAmount;
        g = g0 + (g - g0) * adaptAmount;
        b = b0 + (b - b0) * adaptAmount;
        patch.data[i]     = r < 0 ? 0 : r > 255 ? 255 : r;
        patch.data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
        patch.data[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      }
      cloneCtx.putImageData(patch, 0, 0);
    }

    function clampGain(v) { return v < 0.5 ? 0.5 : v > 2 ? 2 : v; }

    // Multiband (Laplacian pyramid) blending: split the destination and the
    // tone-matched clone into frequency bands and blend each band with the mask
    // pyramid, so coarse brightness/colour differences merge over a wide smooth
    // region while fine detail keeps a tight, sharp seam.
    function multibandBlend(s, cloneCtx) {
      const w = s.bw, h = s.bh;
      const dest = s.raw.getContext('2d').getImageData(s.left, s.top, w, h).data;
      const clone = cloneCtx.getImageData(0, 0, w, h).data;
      const mask = s.mask.getContext('2d').getImageData(0, 0, w, h).data;

      const levels = Math.max(1, Math.min(6, Math.floor(Math.log2(Math.min(w, h)))));
      const A = new Float32Array(w * h * 3);
      const B = new Float32Array(w * h * 3);
      const M = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const d = i * 4, s3 = i * 3;
        A[s3] = dest[d]; A[s3 + 1] = dest[d + 1]; A[s3 + 2] = dest[d + 2];
        B[s3] = clone[d]; B[s3 + 1] = clone[d + 1]; B[s3 + 2] = clone[d + 2];
        M[i] = mask[d + 3] / 255;
      }

      const gA = gaussianPyramid(A, w, h, 3, levels);
      const gB = gaussianPyramid(B, w, h, 3, levels);
      const gM = gaussianPyramid(M, w, h, 1, levels);
      const lA = laplacianPyramid(gA, levels, 3);
      const lB = laplacianPyramid(gB, levels, 3);

      // Blend each Laplacian band with the mask pyramid at that level.
      const blend = new Array(levels);
      for (let k = 0; k < levels; k++) {
        const n = lA[k].w * lA[k].h, m = gM[k].data;
        const d = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          const t = m[i], p = i * 3;
          d[p]     = t * lB[k].data[p]     + (1 - t) * lA[k].data[p];
          d[p + 1] = t * lB[k].data[p + 1] + (1 - t) * lA[k].data[p + 1];
          d[p + 2] = t * lB[k].data[p + 2] + (1 - t) * lA[k].data[p + 2];
        }
        blend[k] = { w: lA[k].w, h: lA[k].h, data: d };
      }

      // Blend the top residual, then collapse the pyramid back to full resolution.
      const tA = gA[levels], tB = gB[levels], tM = gM[levels];
      const top = new Float32Array(tA.w * tA.h * 3);
      for (let i = 0; i < tA.w * tA.h; i++) {
        const t = tM.data[i], p = i * 3;
        top[p]     = t * tB.data[p]     + (1 - t) * tA.data[p];
        top[p + 1] = t * tB.data[p + 1] + (1 - t) * tA.data[p + 1];
        top[p + 2] = t * tB.data[p + 2] + (1 - t) * tA.data[p + 2];
      }
      let cur = { w: tA.w, h: tA.h, data: top };
      for (let k = levels - 1; k >= 0; k--) {
        const up = upsample(cur.data, cur.w, cur.h, blend[k].w, blend[k].h, 3);
        const out = new Float32Array(blend[k].w * blend[k].h * 3);
        for (let i = 0; i < out.length; i++) out[i] = blend[k].data[i] + up[i];
        cur = { w: blend[k].w, h: blend[k].h, data: out };
      }

      // Final RGBA: multiband RGB with the feathered mask as alpha.
      const out = canvas(w, h).getContext('2d').createImageData(w, h);
      for (let i = 0; i < w * h; i++) {
        const s3 = i * 3, d = i * 4;
        out.data[d]     = cur.data[s3]     < 0 ? 0 : cur.data[s3]     > 255 ? 255 : cur.data[s3];
        out.data[d + 1] = cur.data[s3 + 1] < 0 ? 0 : cur.data[s3 + 1] > 255 ? 255 : cur.data[s3 + 1];
        out.data[d + 2] = cur.data[s3 + 2] < 0 ? 0 : cur.data[s3 + 2] > 255 ? 255 : cur.data[s3 + 2];
        out.data[d + 3] = mask[d + 3];
      }
      return out;
    }

    // Selection contour outline: hardMask dilated by the feather radius — the
    // point where the feathered mask reaches 0% alpha — minus the mask itself,
    // tinted green. Computed on a downscaled scratch canvas (never full-image)
    // and cached per session size + feather; position and zoom are applied at
    // draw time. Offsets approximate a disc dilation of the binary mask.
    let ring = null, ringSession = null, ringKey = '';
    function contourRing() {
      const s = session;
      const feather = featherRadius(s.w);
      const key = `${s.bw}x${s.bh}:${feather}`;
      if (ringSession === s && ringKey === key) return ring;
      ringSession = s; ringKey = key;
      const k = Math.min(1, 256 / Math.max(s.bw, s.bh));
      const w = Math.max(1, Math.round(s.bw * k)), h = Math.max(1, Math.round(s.bh * k));
      const lineWidth = 2 * s.w / overlay.width; // brush-size-2 thickness: 2 CSS px in raw device px
      const R = Math.max(feather, lineWidth) * k;  // ring radius in scratch px
      const m = Math.ceil(R) + 1;                  // scratch margin so dilation isn't clipped
      const mask = canvas(w, h), mc = mask.getContext('2d');
      mc.drawImage(s.hardMask, 0, 0, w, h);
      const out = canvas(w + 2 * m, h + 2 * m), oc = out.getContext('2d');
      for (let a = 0; a < 16; a++) {
        const t = a / 16 * 2 * Math.PI;
        oc.drawImage(mask, m + Math.cos(t) * R, m + Math.sin(t) * R);
      }
      oc.globalCompositeOperation = 'destination-out';
      oc.drawImage(mask, m, m);
      oc.globalCompositeOperation = 'source-in';
      oc.fillStyle = 'rgba(0, 255, 0, 0.5)';
      oc.fillRect(0, 0, out.width, out.height);
      ring = { canvas: out, m: m / k }; // m back in mask (raw) px
      return ring;
    }

    function render() {
      frame = 0;
      if (!valid()) return;
      const s = session;
      stamp(s.shown);
      display.clearRect(0, 0, preview.width, preview.height);
      display.drawImage(s.patch, s.left, s.top);
      const zoom = s._zoom || 1;
      // Trace the selection's 0%-opacity contour around the sampled source
      // region. sourceRect() is centred on the chosen source point, so the
      // outline grows from the centre when the scroll-wheel zoom changes.
      const { x, y } = sourceRect();
      const r = contourRing();
      const pad = r.m * zoom;
      display.drawImage(r.canvas, x - pad, y - pad, (s.bw + 2 * r.m) * zoom, (s.bh + 2 * r.m) * zoom);
    }

    function apply(e) {
      if (!valid()) return;
      const s = session;
      s.source = point(e, s.w, s.h);
      let result;
      if (Number(feather.value) <= 0) {
        // Feather 0 = exact copy: no blending, no tone transfer.
        stamp(s.raw);
        const resolved = canvas(s.bw, s.bh), r = resolved.getContext('2d');
        r.drawImage(s.raw, -s.left, -s.top); r.drawImage(s.patch, 0, 0);
        result = r.getImageData(0, 0, s.bw, s.bh);
        const soft = s.mask.getContext('2d').getImageData(0, 0, s.bw, s.bh).data;
        for (let i = 3; i < result.data.length; i += 4) result.data[i] = soft[i];
      } else {
        // Tone-match the full clone source, then multiband-blend it into the
        // destination: coarse differences merge widely, detail stays sharp.
        const clone = canvas(s.bw, s.bh), cc = clone.getContext('2d');
        const { x, y, bw, bh } = sourceRect();
        cc.drawImage(s.raw, x, y, bw, bh, 0, 0, s.bw, s.bh);
        matchCloneTone(s, cc);
        result = multibandBlend(s, cc);
      }
      const full = canvas(s.w, s.h), f = full.getContext('2d');
      f.putImageData(result, s.left, s.top);
      commit(f.getImageData(0, 0, s.w, s.h).data, s.w, s.h, s.camera);
      cancel();
    }

    function down(e) {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      if (session) { apply(e); return; }
      stroke = point(e); mark(stroke);
      if (e.isTrusted) overlay.setPointerCapture(e.pointerId);
    }
    function move(e) {
      if (session) {
        session.source = point(e, session.w, session.h);
        if (!frame) frame = requestAnimationFrame(render);
      } else if (stroke) {
        const p = point(e); mark(p, stroke); stroke = p;
      }
    }
    function up(e) {
      if (!stroke) return;
      if (overlay.hasPointerCapture(e.pointerId)) overlay.releasePointerCapture(e.pointerId);
      try { capture(e); } catch (error) { cancel(); console.error('Clone preview failed:', error); }
    }
    feather.addEventListener('input', () => {
      S360.settings.updateSliderLabel(feather, document.getElementById('cloneFeatherVal'), Number(feather.value));
      if (session) { rebuildMask(); render(); }
    });
    if (adapt) adapt.addEventListener('input', () => {
      S360.settings.updateSliderLabel(adapt, document.getElementById('cloneAdaptVal'), Number(adapt.value));
    });
    window.addEventListener('keydown', e => { if (e.key === 'Escape') cancel(); });
    window.addEventListener('resize', cancel);
    ctx.getPanoramaCanvas().addEventListener('webglcontextlost', cancel);
    return { down, move, up, cancel, get pending() { return !!(stroke || session); },
      get sessionActive() { return !!session; },
      activate(active) { cancel(); if (controls) controls.hidden = !active; overlay.style.cursor = active ? 'none' : ''; },
      handleWheel(e) {
        if (!session) return;
        e.preventDefault();
        // Session active: zoom source uniformly from center. Scroll down
        // (deltaY > 0) zooms in — inverted from the previous behavior.
        const delta = e.deltaY > 0 ? 1 : -1;
        session._zoom = (session._zoom || 1) * (1 + delta * 0.02);
        session._zoom = Math.max(0.25, Math.min(4, session._zoom));
        if (!frame) frame = requestAnimationFrame(render);
      } };
  }

  S360.viewClone = { create };
})(window.S360);
