// settings.js
window.S360 = window.S360 || {};
(function (S360) {
  S360.settings = {};

  S360.settings.applySettings = function (ctx, parsed) {
    const { cfg, postUniforms, DEFAULT_CFG, DEFAULT_POST } = ctx;
    if (parsed.cfg) {
      const c = parsed.cfg;
      if (typeof c.fovDeg === 'number') cfg.fovDeg = c.fovDeg;
      if (typeof c.radiusScale === 'number') cfg.radiusScale = c.radiusScale;
      if (typeof c.mirror3D === 'boolean') cfg.mirror3D = c.mirror3D;
      if (c.blend) cfg.blend = { ...DEFAULT_CFG.blend, ...c.blend };
      if (c.hdr) cfg.hdr = { ...DEFAULT_CFG.hdr, ...c.hdr };
      if (c.centers) {
        if (Array.isArray(c.centers.left)) cfg.centers.left = [...c.centers.left];
        if (Array.isArray(c.centers.right)) cfg.centers.right = [...c.centers.right];
      }
      if (c.rollDeg) cfg.rollDeg = { ...cfg.rollDeg, ...c.rollDeg };
      if (c.height) cfg.height = { ...DEFAULT_CFG.height, ...c.height };
      if (c.centerOffset) cfg.centerOffset = { ...DEFAULT_CFG.centerOffset, ...c.centerOffset };
    }
    if (parsed.post) {
      Object.keys(DEFAULT_POST).forEach(key => {
        if (parsed.post[key] !== undefined) postUniforms[key] = parsed.post[key];
      });
    }
    if (typeof parsed.scale === 'number') ctx.setScaleValue(parsed.scale === 2 ? 2 : 1);
    if (parsed.wm) {
      if (typeof parsed.wm.size === 'number') ctx.setWmSize(parsed.wm.size);
      if (typeof parsed.wm.rot === 'number') ctx.setWmRotDeg(parsed.wm.rot);
    }
  };

  S360.settings.serialize = function (ctx) {
    const { cfg, postUniforms } = ctx;
    return JSON.stringify({ cfg, post: postUniforms, scale: ctx.getScaleValue(), wm: { size: ctx.getWmSize(), rot: ctx.getWmRotDeg() } });
  };

  S360.settings.createCalibrationProfile = function (cfg, name = 'StitchIT Camera Profile') {
    return {
      schema: 'stitchit-camera-profile', version: 1, name,
      projection: 'dual-fisheye-equisolid-compatible',
      geometry: {
        fovDeg: cfg.fovDeg, radiusScale: cfg.radiusScale,
        centers: JSON.parse(JSON.stringify(cfg.centers)),
        height: { ...cfg.height },
        centerOffset: { ...cfg.centerOffset },
        rollDeg: { ...cfg.rollDeg },
      }
    };
  };

  S360.settings.applyCalibrationProfile = function (cfg, profile) {
    if (!profile || profile.schema !== 'stitchit-camera-profile' || profile.version !== 1 || !profile.geometry) {
      throw new Error('Unsupported or invalid StitchIT camera profile.');
    }
    const g = profile.geometry;
    if (Number.isFinite(g.fovDeg)) cfg.fovDeg = g.fovDeg;
    if (Number.isFinite(g.radiusScale)) cfg.radiusScale = g.radiusScale;
    if (Array.isArray(g.centers?.left) && g.centers.left.length === 2) cfg.centers.left = [...g.centers.left];
    if (Array.isArray(g.centers?.right) && g.centers.right.length === 2) cfg.centers.right = [...g.centers.right];
    if (g.rollDeg) cfg.rollDeg = { ...cfg.rollDeg, ...g.rollDeg };
    if (g.height) cfg.height = { ...cfg.height, ...g.height };
    if (g.centerOffset) cfg.centerOffset = { ...cfg.centerOffset, ...g.centerOffset };
    // Backward-compat: silently ignore removed stretch/distortion keys in old profiles.
  };

  let _liveSaveTimer = null;
  function saveLiveConfig(ctx) {
    try { localStorage.setItem(ctx.LIVE_KEY, S360.settings.serialize(ctx)); } catch (e) { console.warn("[settings] save failed:", e); }
  }
  S360.settings.saveLiveConfig = function (ctx) { saveLiveConfig(ctx); };
  S360.settings.scheduleLiveSave = function (ctx) {
    if (_liveSaveTimer) clearTimeout(_liveSaveTimer);
    _liveSaveTimer = setTimeout(() => saveLiveConfig(ctx), 250);
  };
  S360.settings.loadLiveConfig = function (ctx) {
    try {
      const saved = localStorage.getItem(ctx.LIVE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        S360.settings.applySettings(ctx, parsed);
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        console.warn(`[settings] Corrupt live config in localStorage (${ctx.LIVE_KEY}); clearing it.`, e);
        try { localStorage.removeItem(ctx.LIVE_KEY); } catch (_) {}
      } else {
        console.warn("[settings] load failed:", e);
      }
    }
  };

  S360.settings.saveSnapshot = function (ctx) {
    const { cfg, postUniforms } = ctx;
    try {
      const geomCfg = {
        fovDeg: cfg.fovDeg,
        radiusScale: cfg.radiusScale,
        mirror3D: cfg.mirror3D,
        blend: cfg.blend,
        centers: cfg.centers,
        rollDeg: cfg.rollDeg,
        height: cfg.height,
        centerOffset: cfg.centerOffset,
      };
      localStorage.setItem(ctx.SNAPSHOT_KEY, JSON.stringify({ cfg: geomCfg, post: postUniforms }));
    } catch (e) { console.warn("[settings] save failed:", e); }
  };
  S360.settings.loadSnapshot = function (ctx) {
    try {
      const saved = localStorage.getItem(ctx.SNAPSHOT_KEY);
      if (!saved) return false;
      const parsed = JSON.parse(saved);
      // The geometry slot never owns HDR — drop it so loading Geometry can't move
      // the hdrSigma / hdrBellCenter / hdrBase sliders (stale or otherwise).
      if (parsed.cfg) delete parsed.cfg.hdr;
      S360.settings.applySettings(ctx, parsed);
      saveLiveConfig(ctx);
      return true;
    } catch (e) { console.warn("[settings] load failed:", e); return false; }
  };

  S360.settings.saveHdrSnapshot = function (ctx) {
    const { cfg } = ctx;
    try { localStorage.setItem(ctx.HDR_SNAPSHOT_KEY, JSON.stringify(cfg.hdr)); } catch (e) { console.warn("[settings] save failed:", e); }
  };
  S360.settings.loadHdrSnapshot = function (ctx) {
    const { cfg, DEFAULT_CFG } = ctx;
    try {
      const saved = localStorage.getItem(ctx.HDR_SNAPSHOT_KEY);
      if (!saved) return false;
      cfg.hdr = { ...DEFAULT_CFG.hdr, ...JSON.parse(saved) };
      saveLiveConfig(ctx);
      return true;
    } catch (e) { console.warn("[settings] load failed:", e); return false; }
  };

  S360.settings.saveProcSnapshot = function (ctx) {
    const { postUniforms } = ctx;
    try {
      localStorage.setItem(ctx.PROC_SNAPSHOT_KEY, JSON.stringify({ post: postUniforms, postEnabled: ctx.getPostEnabled() }));
    } catch (e) { console.warn("[settings] save failed:", e); }
  };
  S360.settings.loadProcSnapshot = function (ctx) {
    const { postUniforms, DEFAULT_POST } = ctx;
    try {
      const saved = localStorage.getItem(ctx.PROC_SNAPSHOT_KEY);
      if (!saved) return false;
      const parsed = JSON.parse(saved);
      if (parsed.post) {
        Object.keys(DEFAULT_POST).forEach(key => {
          if (parsed.post[key] !== undefined) postUniforms[key] = parsed.post[key];
        });
      }
      if (typeof parsed.postEnabled === 'boolean') ctx.setPostEnabled(parsed.postEnabled);
      saveLiveConfig(ctx);
      return true;
    } catch (e) { console.warn("[settings] load failed:", e); return false; }
  };

  S360.settings.saveWmSnapshot = function (ctx) {
    try {
      localStorage.setItem(ctx.WM_SNAPSHOT_KEY, JSON.stringify({ size: ctx.getWmSize(), rot: ctx.getWmRotDeg() }));
    } catch (e) { console.warn("[settings] save failed:", e); }
  };
  S360.settings.loadWmSnapshot = function (ctx) {
    try {
      const saved = localStorage.getItem(ctx.WM_SNAPSHOT_KEY);
      if (!saved) return false;
      const parsed = JSON.parse(saved);
      if (typeof parsed.size === 'number') ctx.setWmSize(parsed.size);
      if (typeof parsed.rot === 'number') ctx.setWmRotDeg(parsed.rot);
      saveLiveConfig(ctx);
      return true;
    } catch (e) { console.warn("[settings] load failed:", e); return false; }
  };

  S360.settings.updateWmUI = function (ctx) {
    const { wmSizeSlider, wmSizeVal, wmRotSlider, wmRotVal } = ctx;
    if (wmSizeSlider) wmSizeSlider.value = ctx.getWmSize();
    if (wmSizeVal) wmSizeVal.textContent = ctx.getWmSize().toFixed(2);
    if (wmRotSlider) wmRotSlider.value = ctx.getWmRotDeg();
    if (wmRotVal) wmRotVal.textContent = String(Math.round(ctx.getWmRotDeg()));
  };

  S360.settings.updateUIFromConfig = function (ctx) {
    const { sliderMap } = ctx;
    sliderMap.forEach(item => {
      const input = document.getElementById(item.id);
      const valSpan = document.getElementById(`${item.id}Val`);
      if (!input) return;
      const val = item.get();
      if (input.type === 'checkbox') {
        input.checked = val;
      } else {
        input.value = val;
      }
      if (valSpan) {
        if (input.type === 'checkbox') {
          valSpan.textContent = val ? 'ON' : 'OFF';
        } else {
          const step = input.step || '1';
          const decimals = step.includes('.') ? step.split('.')[1].length : 0;
          valSpan.textContent = Number(val).toFixed(decimals);
        }
      }
    });
  };

  S360.settings.updatePostUI = function (ctx) {
    const { tempSlider, tempVal, exposureSlider, gammaPPSlider, sharpenSlider, saturationSlider, contrastSlider, enablePostBtn, postUniforms } = ctx;
    if (tempSlider) {
      tempSlider.value = postUniforms.temperature;
      if (tempVal) tempVal.textContent = String(Math.round(postUniforms.temperature));
    }
    if (exposureSlider) {
      exposureSlider.value = postUniforms.exposure;
      if (document.getElementById('exposureVal')) document.getElementById('exposureVal').textContent = postUniforms.exposure.toFixed(2);
    }
    if (gammaPPSlider) {
      gammaPPSlider.value = postUniforms.gamma;
      if (document.getElementById('gammaPPVal')) document.getElementById('gammaPPVal').textContent = postUniforms.gamma.toFixed(2);
    }
    if (sharpenSlider) {
      sharpenSlider.value = postUniforms.sharpen;
      if (document.getElementById('sharpenVal')) document.getElementById('sharpenVal').textContent = postUniforms.sharpen.toFixed(2);
    }
    if (saturationSlider) {
      saturationSlider.value = postUniforms.saturation;
      if (document.getElementById('saturationVal')) document.getElementById('saturationVal').textContent = postUniforms.saturation.toFixed(2);
    }
    if (contrastSlider) {
      contrastSlider.value = postUniforms.contrast;
      if (document.getElementById('contrastVal')) document.getElementById('contrastVal').textContent = postUniforms.contrast.toFixed(2);
    }
    if (enablePostBtn) {
      enablePostBtn.textContent = ctx.getPostEnabled() ? 'ON' : 'OFF';
      enablePostBtn.classList.toggle('active', ctx.getPostEnabled());
    }
  };

  S360.settings.drawHdrBellChart = function (ctx) {
    const { cfg } = ctx;
    const canvas = document.getElementById('hdrBellChart');
    if (!canvas) return;
    const c = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    c.clearRect(0, 0, W, H);
    c.fillStyle = '#0e0e10';
    c.fillRect(0, 0, W, H);
    const yFor = (v) => H - 2 - v * (H - 4);

    // Unity guide (solid grey): "no change" reference for the brightness curve.
    c.beginPath();
    c.strokeStyle = 'rgba(255,255,255,0.30)';
    c.lineWidth = 1;
    c.moveTo(0, yFor(0)); c.lineTo(W, yFor(1)); c.stroke();

    // Tone-mapping response (blue): ACES at the current exposure setting.
    // Shifts left/right as the Exposure slider moves so the chart always
    // shows the actual input→output curve the merge will apply.
    const exposure = cfg.hdr.brightness || 0;
    c.beginPath();
    c.strokeStyle = '#38bdf8';
    c.lineWidth = 2;
    for (let x = 0; x <= W; x++) {
      const v = x / W;
      const ev = v * Math.pow(2, exposure);
      const num = ev * (2.51 * ev + 0.03);
      const den = ev * (2.43 * ev + 0.59) + 0.14;
      const out = Math.min(1, Math.max(0, num / den));
      if (x === 0) c.moveTo(x, yFor(out)); else c.lineTo(x, yFor(out));
    }
    c.stroke();

    // Merge-weight bell (orange): per-channel well-exposedness curve.
    // For a neutral gray pixel (r=g=b=v), the weight is
    // base + (1-base) * exp(-3*(v-center)²/(2σ²)).
    const sigma = cfg.hdr.sigma;
    const center = cfg.hdr.bellCenter;
    const base = cfg.hdr.base;
    const inv2Sig2 = 1.0 / (2.0 * sigma * sigma);
    c.beginPath();
    c.strokeStyle = '#f59e0b';
    c.lineWidth = 2;
    for (let x = 0; x <= W; x++) {
      const v = x / W;
      const diff = v - center;
      const w = base + (1.0 - base) * Math.exp(-3 * diff * diff * inv2Sig2);
      if (x === 0) c.moveTo(x, yFor(w)); else c.lineTo(x, yFor(w));
    }
    c.stroke();

    // Centre marker (where the bell peaks).
    const cx = center * W;
    c.strokeStyle = 'rgba(255,255,255,0.25)';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(cx, 0); c.lineTo(cx, H); c.stroke();
  };
})(window.S360);
