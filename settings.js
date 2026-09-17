// Owns settings persistence, validation, and control value rendering. init() captures UI refs.
window.S360 = window.S360 || {};
(function (S360) {
'use strict';
  S360.settings = {};

  S360.settings.updateSliderLabel = function (input, label, value, { decimals, suffix = '', scale = 1 } = {}) {
    if (!label) return;
    if (input?.type === 'checkbox') {
      label.textContent = value ? 'ON' : 'OFF';
      return;
    }
    const step = input?.step || '1';
    const precision = decimals ?? (step.includes('.') ? step.split('.')[1].length : 0);
    label.textContent = (Number(value)*scale).toFixed(precision) + suffix;
  };

  // Post / watermark UI element refs, captured once in init(). Owned here so
  // updatePostUI/updateWmUI never reach through a shared ctx grab-bag or
  // re-query the DOM on every call.
  let _postEls = null;
  let _preprocessEls = null;
  let _wmEls = null;
  S360.settings.init = function () {
    _postEls = {
      tempSlider: document.getElementById('temperature'),
      tempVal: document.getElementById('temperatureVal'),
      exposureSlider: document.getElementById('exposure'),
      exposureVal: document.getElementById('exposureVal'),
      gammaPPSlider: document.getElementById('gammaPP'),
      gammaPPVal: document.getElementById('gammaPPVal'),
      sharpenSlider: document.getElementById('sharpen'),
      sharpenVal: document.getElementById('sharpenVal'),
      claritySlider: document.getElementById('clarity'),
      clarityVal: document.getElementById('clarityVal'),
      saturationSlider: document.getElementById('saturation'),
      saturationVal: document.getElementById('saturationVal'),
      contrastSlider: document.getElementById('contrast'),
      contrastVal: document.getElementById('contrastVal'),
      enablePostBtn: document.getElementById('enablePostBtn'),
    };
    _preprocessEls = {
      enablePreprocessBtn: document.getElementById('enablePreprocessBtn'),
    };
    _wmEls = {
      wmSizeSlider: document.getElementById('wmSize'),
      wmSizeVal: document.getElementById('wmSizeVal'),
      wmRotSlider: document.getElementById('wmRot'),
      wmRotVal: document.getElementById('wmRotVal'),
      wmTopSizeSlider: document.getElementById('wmTopSize'),
      wmTopSizeVal: document.getElementById('wmTopSizeVal'),
      wmTopRotSlider: document.getElementById('wmTopRot'),
      wmTopRotVal: document.getElementById('wmTopRotVal'),
    };
  };

  // ---- numeric guards for restores / imported profiles (QW#11) ----
  // Everything applied below comes from untrusted JSON: localStorage written
  // by an older version, a hand-edited file, or a foreign tool. One bad number
  // poisons the pipeline: fovDeg <= 0 makes every lens miss (black pano) and
  // divides by zero in radialFade, height <= 0 divides by zero in the stitch
  // shader's 1/hf term, NaN centers poison every u_centers, and a non-number post value crashes
  // updateUIFromConfig's .toFixed. So: every numeric is clamped to the range
  // its slider can produce — KEEP IN SYNC WITH index.html — and non-numbers
  // are skipped, leaving the current value untouched.
  //
  // Persistence map (what survives a reload):
  //   Saved in cfg (live + geometry snapshot): outerMargin, radius, mirror3D,
  //     blend, centers, rollDeg, width, height, angle. Drawing settings use a
  //     separate Canvas snapshot. Saved in cfg (live only): exposureFusion, denoiseStrength,
  //     chromaCleanup. Saved separately: post, scale, wm, wmTop.
  //   NOT persisted (live-only, reset to default on load): drawWarpStrength,
  //     cloneAdapt — these are session controls, not document settings.
  const LENS_RANGES = { // top-level cfg scalars that pin the lens geometry
    outerMargin: [80, 100],
    radius:      [80, 100],
  };
  const BLEND_RANGES  = { seamWidth: [0, 1], seamShift: [-1, 1] };
  const EXPOSURE_FUSION_RANGES = { contrast: [0, 2], saturation: [0, 2], wellExposed: [0, 4] };
  const PREPROCESS_RANGES = {
    denoiseStrength: [0, 2], chromaCleanup: [0, 2],
    caRed: [-4, 4], caBlue: [-4, 4],
    focusRecovery: [0, 1], focusRadius: [0.5, 4],
  };
  const ROLL_RANGES   = { left: [-180, 180], right: [-180, 180] };        // no slider; semantic bound
  const SCALE_RANGES  = { left: [-5, 5], right: [-5, 5] };
  const ANGLE_RANGES  = { left: [-135, 135], right: [-135, 135] };
  const HORIZON_RANGES = { pitch: [-90, 90], roll: [-180, 180] };
  const POST_RANGES   = {
    temperature: [2000, 12000], exposure: [0.2, 3.0], gamma: [0.2, 2.5],
    sharpen: [0.0, 2.0], clarity: [0.0, 1.0], saturation: [0.0, 2.0], contrast: [0.5, 2.0],
  };
  const WM_SIZE_RANGE = [0.01, 1.0];  // internal fraction; slider shows 1–100%
  const WM_ROT_RANGE  = [0, 360];
  const CENTER_RANGE  = [0.0, 1.0];  // centers are normalised source coords
  const DRAW_SIZE_RANGE = [2, 64];
  const DRAW_FEATHER_RANGE = [0, 10];
  const DRAW_OPACITY_RANGE = [0, 100];

  function clampNum(v, min, max) {
    return (typeof v === 'number' && Number.isFinite(v)) ? Math.min(max, Math.max(min, v)) : null;
  }
  // Sets target[key] only when the value is a finite number (clamped in range).
  function applyClamped(target, key, v, range) {
    const c = clampNum(v, range[0], range[1]);
    if (c !== null) target[key] = c;
  }
  // Overlays only the known, valid numeric keys of a group; junk keys and
  // non-numbers are dropped instead of being copied into cfg.
  function applyGroup(target, src, ranges) {
    if (!src || typeof src !== 'object') return;
    Object.keys(ranges).forEach(k => applyClamped(target, k, src[k], ranges[k]));
  }
  // Validates a normalised [x, y] pair; returns a fresh clamped pair or null.
  function clampCenter(v) {
    if (!Array.isArray(v) || v.length !== 2) return null;
    const x = clampNum(v[0], CENTER_RANGE[0], CENTER_RANGE[1]);
    const y = clampNum(v[1], CENTER_RANGE[0], CENTER_RANGE[1]);
    return (x !== null && y !== null) ? [x, y] : null;
  }
  // Post-uniform restore shared by applySettings and loadProcSnapshot.
  function applyPostGuarded(postUniforms, src, DEFAULT_POST) {
    Object.keys(DEFAULT_POST).forEach(key => {
      if (src[key] === undefined) return;
      applyClamped(postUniforms, key, src[key], POST_RANGES[key] || [-Infinity, Infinity]);
    });
  }

  S360.settings.applySettings = function (ctx, parsed) {
    const { cfg, postUniforms, DEFAULT_POST } = ctx;
    if (parsed.cfg) {
      const c = parsed.cfg;
      applyGroup(cfg, c, LENS_RANGES);
      applyGroup(cfg, c, PREPROCESS_RANGES);
      // Backward-compat for pre-belt configs: radiusScale -> radius and
      // fovDeg -> outerMargin (so the same 180° ring & capture edge result).
      if (c.radius === undefined && typeof c.radiusScale === 'number' && Number.isFinite(c.radiusScale)) {
        cfg.radius = Math.min(100, Math.max(80, c.radiusScale * 100));
      }
      if (c.outerMargin === undefined && typeof c.fovDeg === 'number' && Number.isFinite(c.fovDeg)) {
        cfg.outerMargin = Math.min(100, Math.max(80, c.fovDeg * cfg.radius / 180));
      }
      if (typeof c.mirror3D === 'boolean') cfg.mirror3D = c.mirror3D;
      if (typeof c.preprocessingEnabled === 'boolean') cfg.preprocessingEnabled = c.preprocessingEnabled;
      if (c.blend) {
        applyGroup(cfg.blend, c.blend, BLEND_RANGES);
        // Legacy seam configs carry hfBandWidth (0..0.1 of halfFov) and shift in
        // -0.02..0.02 units; remap to belt-relative seamWidth : 0..1 and shift.
        if (c.blend.seamWidth === undefined && typeof c.blend.hfBandWidth === 'number' && Number.isFinite(c.blend.hfBandWidth)) {
          cfg.blend.seamWidth = Math.min(1, Math.max(0, c.blend.hfBandWidth * 10));
          if (typeof c.blend.seamShift === 'number' && Number.isFinite(c.blend.seamShift)) {
            cfg.blend.seamShift = Math.min(1, Math.max(-1, c.blend.seamShift * 50));
          }
        }
      }
      if (c.exposureFusion) applyGroup(cfg.exposureFusion, c.exposureFusion, EXPOSURE_FUSION_RANGES);
      if (c.preprocessing) applyGroup(cfg, c.preprocessing, PREPROCESS_RANGES);
      if (c.centers) {
        const l = clampCenter(c.centers.left);
        if (l) cfg.centers.left = l;
        const r = clampCenter(c.centers.right);
        if (r) cfg.centers.right = r;
      }
      if (c.rollDeg) applyGroup(cfg.rollDeg, c.rollDeg, ROLL_RANGES);
      if (c.width) applyGroup(cfg.width, c.width, SCALE_RANGES);
      cfg.height ??= { left: 0, right: 0 };
      applyGroup(cfg.height, c.height ?? { left: 0, right: 0 }, SCALE_RANGES);
      if (c.angle) applyGroup(cfg.angle, c.angle, ANGLE_RANGES);
      cfg.horizon ??= { pitch: 0, roll: 0 };
      if (c.horizon) applyGroup(cfg.horizon, c.horizon, HORIZON_RANGES);
      // Drawing settings
      if (typeof c.drawSize === 'number') {
        const v = clampNum(c.drawSize, DRAW_SIZE_RANGE[0], DRAW_SIZE_RANGE[1]);
        if (v !== null) cfg.drawSize = v;
      }
      if (typeof c.drawFeather === 'number') {
        const v = clampNum(c.drawFeather, DRAW_FEATHER_RANGE[0], DRAW_FEATHER_RANGE[1]);
        if (v !== null) cfg.drawFeather = v;
      }
      if (typeof c.drawOpacity === 'number') {
        const v = clampNum(c.drawOpacity, DRAW_OPACITY_RANGE[0], DRAW_OPACITY_RANGE[1]);
        if (v !== null) cfg.drawOpacity = v;
      }
    }
    if (parsed.post) applyPostGuarded(postUniforms, parsed.post, DEFAULT_POST);
    if (typeof parsed.postEnabled === 'boolean' && ctx.setPostEnabled) ctx.setPostEnabled(parsed.postEnabled);
    if (typeof parsed.scale === 'number') ctx.setScaleValue(parsed.scale === 2 ? 2 : 1);
    const bottom = S360.stitchDecal.decals.bottom, top = S360.stitchDecal.decals.top;
    if (parsed.wm) {
      const size = clampNum(parsed.wm.size, WM_SIZE_RANGE[0], WM_SIZE_RANGE[1]);
      if (size !== null) bottom.size = size;
      const rot = clampNum(parsed.wm.rot, WM_ROT_RANGE[0], WM_ROT_RANGE[1]);
      if (rot !== null) bottom.rotDeg = rot;
    }
    if (parsed.wmTop) { // zenith (top) watermark slot — mirrors `wm` above
      const size = clampNum(parsed.wmTop.size, WM_SIZE_RANGE[0], WM_SIZE_RANGE[1]);
      if (size !== null) top.size = size;
      const rot = clampNum(parsed.wmTop.rot, WM_ROT_RANGE[0], WM_ROT_RANGE[1]);
      if (rot !== null) top.rotDeg = rot;
    }
  };

  S360.settings.serialize = function (ctx) {
    const { cfg, postUniforms } = ctx;
    const { bottom, top } = S360.stitchDecal.decals;
    return JSON.stringify({ cfg, post: postUniforms,
      postEnabled: ctx.getPostEnabled ? ctx.getPostEnabled() : true, scale: ctx.getScaleValue(),
      wm: { size: bottom.size, rot: bottom.rotDeg }, wmTop: { size: top.size, rot: top.rotDeg } });
  };

  S360.settings.createCalibrationProfile = function (cfg, name = 'StitchIT Camera Profile') {
    return {
      schema: 'stitchit-camera-profile', version: 1, name,
      projection: 'dual-fisheye-equidistant',
      geometry: {
        outerMargin: cfg.outerMargin, radius: cfg.radius,
        centers: { left: [...cfg.centers.left], right: [...cfg.centers.right] },
        rollDeg: { ...cfg.rollDeg },
        width: { ...cfg.width },
        height: { ...cfg.height },
        angle: { ...cfg.angle },
        horizon: { ...cfg.horizon },
      }
    };
  };

  S360.settings.applyCalibrationProfile = function (cfg, profile) {
    if (!profile || profile.schema !== 'stitchit-camera-profile' || profile.version !== 1 || !profile.geometry) {
      throw new Error('Unsupported or invalid StitchIT camera profile.');
    }
    const g = profile.geometry;
    // Numeric guards (QW#11): clamp to the slider domains and drop non-finite
    // values.  Legacy profiles store radiusScale/fovDeg; map them onto the new
    // belt model (radius/outerMargin) when the new keys are absent.
    applyGroup(cfg, g, LENS_RANGES);
    if (g.radius === undefined && typeof g.radiusScale === 'number' && Number.isFinite(g.radiusScale)) {
      cfg.radius = Math.min(100, Math.max(80, g.radiusScale * 100));
    }
    if (g.outerMargin === undefined && typeof g.fovDeg === 'number' && Number.isFinite(g.fovDeg)) {
      cfg.outerMargin = Math.min(100, Math.max(80, g.fovDeg * cfg.radius / 180));
    }
    const l = clampCenter(g.centers?.left);
    if (l) cfg.centers.left = l;
    const r = clampCenter(g.centers?.right);
    if (r) cfg.centers.right = r;
    applyGroup(cfg.rollDeg, g.rollDeg, ROLL_RANGES);
    applyGroup(cfg.width, g.width, SCALE_RANGES);
    cfg.height ??= { left: 0, right: 0 };
    applyGroup(cfg.height, g.height ?? { left: 0, right: 0 }, SCALE_RANGES);
    applyGroup(cfg.angle, g.angle, ANGLE_RANGES);
    cfg.horizon ??= { pitch: 0, roll: 0 };
    applyGroup(cfg.horizon, g.horizon, HORIZON_RANGES);
    // Backward-compat: silently ignore removed stretch/distortion keys in old profiles.
  };

  let _liveSaveTimer = null;
  // Snapshot-slot primitives: every save/load below shares this JSON-in-
  // localStorage skeleton; load failures warn and read back as null.
  function writeSlot(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.warn("[settings] save failed:", e); }
  }
  function readSlot(key) {
    try {
      const saved = localStorage.getItem(key);
      return saved ? JSON.parse(saved) : null;
    } catch (e) { console.warn("[settings] load failed:", e); return null; }
  }
  const PREPROCESS_SNAPSHOT_KEY = 'stitch360_preprocess_snapshot';
  const CANVAS_SNAPSHOT_KEY = 'stitch360_canvas_snapshot';
  const ALIGNMENT_SNAPSHOT_KEY = 'stitch360_alignment_snapshot';
  let geometryUndo = null;
  let alignmentUndo = null;
  function saveLiveConfig(ctx) {
    // serialize() already produces the stored JSON string, so this slot writes
    // directly instead of through writeSlot (which stringifies objects).
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
    const { cfg } = ctx;
    // Geometry snapshots never own exposure-fusion settings.
    const geomCfg = {
      outerMargin: cfg.outerMargin,
      radius: cfg.radius,
      blend: cfg.blend,
      horizon: cfg.horizon,
    };
    writeSlot(ctx.SNAPSHOT_KEY, { cfg: geomCfg });
  };
  S360.settings.loadSnapshot = function (ctx) {
    const parsed = readSlot(ctx.SNAPSHOT_KEY);
    if (!parsed) return false;
    const c = parsed.cfg || {};
    // Read only geometry fields so older broad snapshots cannot restore post
    // or Canvas values through the Lens Geometry controls.
    S360.settings.applySettings(ctx, { cfg: {
      outerMargin: c.outerMargin, radius: c.radius, blend: c.blend, horizon: c.horizon,
    }});
    saveLiveConfig(ctx);
    return true;
  };

  function copyGeometry(cfg) {
    return JSON.parse(JSON.stringify({
      outerMargin: cfg.outerMargin,
      radius: cfg.radius,
      blend: cfg.blend,
      horizon: cfg.horizon,
    }));
  }
  function copyAlignment(cfg) {
    return JSON.parse(JSON.stringify({
      centers: cfg.centers,
      rollDeg: cfg.rollDeg,
      width: cfg.width,
      height: cfg.height,
      angle: cfg.angle,
    }));
  }
  S360.settings.captureGeometryUndo = function (ctx) { geometryUndo = copyGeometry(ctx.cfg); };
  S360.settings.captureAlignmentUndo = function (ctx) { alignmentUndo = copyAlignment(ctx.cfg); };
  S360.settings.hasGeometryUndo = function () { return !!geometryUndo; };
  S360.settings.hasAlignmentUndo = function () { return !!alignmentUndo; };
  S360.settings.undoGeometry = function (ctx) {
    if (!geometryUndo) return false;
    const restore = geometryUndo;
    geometryUndo = null;
    S360.settings.applySettings(ctx, { cfg: restore });
    saveLiveConfig(ctx);
    return true;
  };
  S360.settings.undoAlignment = function (ctx) {
    if (!alignmentUndo) return false;
    const restore = alignmentUndo;
    alignmentUndo = null;
    S360.settings.applySettings(ctx, { cfg: restore });
    saveLiveConfig(ctx);
    return true;
  };

  S360.settings.saveAlignmentSnapshot = function (ctx) {
    const { cfg } = ctx;
    writeSlot(ALIGNMENT_SNAPSHOT_KEY, {
      centers: cfg.centers,
      rollDeg: cfg.rollDeg,
      width: cfg.width,
      height: cfg.height,
      angle: cfg.angle,
    });
  };
  S360.settings.loadAlignmentSnapshot = function (ctx) {
    const parsed = readSlot(ALIGNMENT_SNAPSHOT_KEY);
    if (!parsed) return false;
    S360.settings.applySettings(ctx, { cfg: {
      centers: parsed.centers,
      rollDeg: parsed.rollDeg,
      width: parsed.width,
      height: parsed.height,
      angle: parsed.angle,
    }});
    saveLiveConfig(ctx);
    return true;
  };

  S360.settings.saveCanvasSnapshot = function (ctx) {
    const { cfg } = ctx;
    writeSlot(CANVAS_SNAPSHOT_KEY, {
      drawSize: cfg.drawSize,
      drawFeather: cfg.drawFeather,
      drawOpacity: cfg.drawOpacity,
    });
  };
  S360.settings.loadCanvasSnapshot = function (ctx) {
    const parsed = readSlot(CANVAS_SNAPSHOT_KEY);
    if (!parsed) return false;
    applyClamped(ctx.cfg, 'drawSize', parsed.drawSize, DRAW_SIZE_RANGE);
    applyClamped(ctx.cfg, 'drawFeather', parsed.drawFeather, DRAW_FEATHER_RANGE);
    applyClamped(ctx.cfg, 'drawOpacity', parsed.drawOpacity, DRAW_OPACITY_RANGE);
    saveLiveConfig(ctx);
    return true;
  };

  S360.settings.saveExposureFusionSnapshot = function (ctx) {
    writeSlot(ctx.EXPOSURE_FUSION_SNAPSHOT_KEY, ctx.cfg.exposureFusion);
  };
  S360.settings.loadExposureFusionSnapshot = function (ctx) {
    const { cfg, DEFAULT_CFG } = ctx;
    const parsed = readSlot(ctx.EXPOSURE_FUSION_SNAPSHOT_KEY);
    if (!parsed) return false;
    cfg.exposureFusion = { ...DEFAULT_CFG.exposureFusion };
    applyGroup(cfg.exposureFusion, parsed, EXPOSURE_FUSION_RANGES);
    saveLiveConfig(ctx);
    return true;
  };

  S360.settings.savePreprocessSnapshot = function (ctx) {
    const { cfg } = ctx;
    writeSlot(PREPROCESS_SNAPSHOT_KEY, {
      preprocessingEnabled: cfg.preprocessingEnabled,
      denoiseStrength: cfg.denoiseStrength,
      chromaCleanup: cfg.chromaCleanup,
      caRed: cfg.caRed,
      caBlue: cfg.caBlue,
    });
  };
  S360.settings.loadPreprocessSnapshot = function (ctx) {
    const parsed = readSlot(PREPROCESS_SNAPSHOT_KEY);
    if (!parsed) return false;
    applyGroup(ctx.cfg, parsed, PREPROCESS_RANGES);
    if (typeof parsed.preprocessingEnabled === 'boolean') ctx.cfg.preprocessingEnabled = parsed.preprocessingEnabled;
    saveLiveConfig(ctx);
    return true;
  };

  S360.settings.saveProcSnapshot = function (ctx) {
    writeSlot(ctx.PROC_SNAPSHOT_KEY, {
      post: ctx.postUniforms,
      postEnabled: ctx.getPostEnabled(),
      focusRecovery: ctx.cfg.focusRecovery,
      focusRadius: ctx.cfg.focusRadius,
    });
  };
  S360.settings.loadProcSnapshot = function (ctx) {
    const { postUniforms, DEFAULT_POST } = ctx;
    const parsed = readSlot(ctx.PROC_SNAPSHOT_KEY);
    if (!parsed) return false;
    if (parsed.post) applyPostGuarded(postUniforms, parsed.post, DEFAULT_POST);
    if (typeof parsed.postEnabled === 'boolean') ctx.setPostEnabled(parsed.postEnabled);
    applyClamped(ctx.cfg, 'focusRecovery', parsed.focusRecovery, PREPROCESS_RANGES.focusRecovery);
    applyClamped(ctx.cfg, 'focusRadius', parsed.focusRadius, PREPROCESS_RANGES.focusRadius);
    saveLiveConfig(ctx);
    return true;
  };

  S360.settings.saveWmSnapshot = function (ctx) {
    const bottom = S360.stitchDecal.decals.bottom;
    writeSlot(ctx.WM_SNAPSHOT_KEY, { size: bottom.size, rot: bottom.rotDeg });
  };
  S360.settings.loadWmSnapshot = function (ctx) {
    const bottom = S360.stitchDecal.decals.bottom;
    const parsed = readSlot(ctx.WM_SNAPSHOT_KEY);
    if (!parsed) return false;
    const size = clampNum(parsed.size, WM_SIZE_RANGE[0], WM_SIZE_RANGE[1]);
    if (size !== null) bottom.size = size;
    const rot = clampNum(parsed.rot, WM_ROT_RANGE[0], WM_ROT_RANGE[1]);
    if (rot !== null) bottom.rotDeg = rot;
    saveLiveConfig(ctx);
    return true;
  };

  S360.settings.updateWmUI = function (ctx) {
    const e = _wmEls || {};
    const { wmSizeSlider, wmSizeVal, wmRotSlider, wmRotVal, wmTopSizeSlider, wmTopSizeVal, wmTopRotSlider, wmTopRotVal } = e;
    const { bottom, top } = S360.stitchDecal.decals;
    if (wmSizeSlider) wmSizeSlider.value = Math.round(bottom.size * 100);
    S360.settings.updateSliderLabel(wmSizeSlider, wmSizeVal, Math.round(bottom.size * 100), { decimals: 0, suffix: '%' });
    if (wmRotSlider) wmRotSlider.value = bottom.rotDeg;
    S360.settings.updateSliderLabel(wmRotSlider, wmRotVal, bottom.rotDeg, { decimals: 0, suffix: '°' });
    if (wmTopSizeSlider) wmTopSizeSlider.value = Math.round(top.size * 100);
    S360.settings.updateSliderLabel(wmTopSizeSlider, wmTopSizeVal, Math.round(top.size * 100), { decimals: 0, suffix: '%' });
    if (wmTopRotSlider) wmTopRotSlider.value = top.rotDeg;
    S360.settings.updateSliderLabel(wmTopRotSlider, wmTopRotVal, top.rotDeg, { decimals: 0, suffix: '°' });
  };

  S360.settings.updateUIFromConfig = function (ctx) {
    const hd = document.getElementById('x2Btn');
    if (hd) {
      hd.classList.toggle('active', ctx.getScaleValue() === 2);
      hd.setAttribute('aria-pressed', String(ctx.getScaleValue() === 2));
    }
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
      S360.settings.updateSliderLabel(input, valSpan, val, item.label);
    });
  };

  // Post-processing sliders: [element id, label id, uniform key, label decimals].
  const POST_SLIDERS = [
    ['tempSlider', 'tempVal', 'temperature', 0],
    ['exposureSlider', 'exposureVal', 'exposure', 2],
    ['gammaPPSlider', 'gammaPPVal', 'gamma', 2],
    ['sharpenSlider', 'sharpenVal', 'sharpen', 2],
    ['claritySlider', 'clarityVal', 'clarity', 2],
    ['saturationSlider', 'saturationVal', 'saturation', 2],
    ['contrastSlider', 'contrastVal', 'contrast', 2],
  ];

  S360.settings.updatePostUI = function (ctx) {
    const e = _postEls || {};
    for (const [id, valId, key, decimals] of POST_SLIDERS) {
      const slider = e[id], val = e[valId];
      if (!slider) continue;
      slider.value = ctx.postUniforms[key];
      S360.settings.updateSliderLabel(slider, val, ctx.postUniforms[key], { decimals });
    }
    if (e.enablePostBtn) {
      e.enablePostBtn.textContent = ctx.getPostEnabled() ? 'ON' : 'OFF';
      e.enablePostBtn.classList.toggle('active', ctx.getPostEnabled());
      e.enablePostBtn.setAttribute('aria-pressed', String(ctx.getPostEnabled()));
    }
  };

  S360.settings.updatePreprocessUI = function (ctx) {
    const button = _preprocessEls?.enablePreprocessBtn;
    if (!button) return;
    button.textContent = ctx.cfg.preprocessingEnabled ? 'ON' : 'OFF';
    button.classList.toggle('active', ctx.cfg.preprocessingEnabled);
    button.setAttribute('aria-pressed', String(ctx.cfg.preprocessingEnabled));
  };

})(window.S360);
