/**
 * StitchIT: WebGL2 dual-fisheye -> equirectangular stitcher
 * Impossible to exist without inspiration from https://github.com/sanriomisintaro/stitch-360
 * Features:
 *  - Frequency-Split Seam Blending (Parallax & Ghost Reduction in WebGL2)
 *  - Photometric Feathering & Real-Time Post-Processing (Film Grain, CAS/Sharpen, Gamma, Contrast, Exposure)
 *  - Full-resolution Exporting with Google Photo Sphere XMP Metadata Injection
 *  - Interactive 360° Spherical WebGL2 Viewer (in-place texture updates, no flash)
 *  - Exposure Weighted HDR Exposure Fusion Pipeline
 *  - Full-resolution rendering with WebGL2 VAO and immutable textures
 */

// ===========================================================================
//  APPLICATION INITIALIZATION & DOM BINDINGS
// ===========================================================================

document.addEventListener('DOMContentLoaded', () => {
  const imageLoader     = document.getElementById('imageLoader');
  const panoramaCanvas  = document.getElementById('panoramaCanvas');

  if (!panoramaCanvas) {
    console.error('❌ Canvas element #panoramaCanvas missing from DOM.');
    return;
  }

  const gl = panoramaCanvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, powerPreference: 'high-performance' });

  if (!gl) {
    alert('WebGL2 is required but not supported in this browser.');
    return;
  }

  const MAX_TEX_SIZE = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const MAX_HDR_FRAMES = 12; // hard cap on fused exposures (GPU sampler-array size)
  console.log('📐 GPU MAX_TEXTURE_SIZE:', MAX_TEX_SIZE);
  console.log('🔧 WebGL2 active — using optimized pipeline');

  // WebGL context loss recovery
  function handleContextLost(e) {
    e.preventDefault();
    console.warn('⚠️ WebGL context lost, will attempt recovery...');
    setLoading(true, 'WebGL context lost — attempting recovery...');
  }
  function handleContextRestored() {
    console.log('✅ WebGL context restored, reinitializing...');
    // Recreate all WebGL resources
    currentTexture = null;
    renderTexture = null;
    framebuffer = null;
    lfTex = lfFbo = lfTmpTex = lfTmpFbo = lfProg = null;
    glProgram = null;
    postProgram = null;
    sphereProgram = null;
    sphere = null;
    _quadVAO = null;
    panoFullTex = null; panoFullFbo = null; panoFullW = 0; panoFullH = 0;
    panoWMTex = null; panoWMFbo = null;
    wmTex = null; wmFbo = null; wmFboTex = null; wmFboW = 0; wmFboH = 0;
    fboPool.clear();
    postFboPool.clear();
    lfPool.clear();
    wmFbo = null; wmFboTex = null; wmFboW = 0; wmFboH = 0;
    if (currentImg) {
      uploadTexture(currentImg);
      renderPano();
    }
    setLoading(false);
  }
  panoramaCanvas.addEventListener('webglcontextlost', handleContextLost, false);
  panoramaCanvas.addEventListener('webglcontextrestored', handleContextRestored, false);

  const loaderEl        = document.getElementById('loader');
  const loaderMsgEl     = document.getElementById('loaderMsg');
  const actionsEl       = document.getElementById('actions');
  const downloadBtn     = document.getElementById('downloadBtn');
  const downloadJpgBtn  = document.getElementById('downloadJpgBtn');
  const viewModeBtn     = document.getElementById('viewModeBtn');
  const x2Btn           = document.getElementById('x2Btn');
  const diffBtn         = document.getElementById('diffBtn');
  const mirror3DBtn     = document.getElementById('mirror3DBtn');
  const snapViewBtn     = document.getElementById('snapViewBtn');
  const viewerContainer = document.getElementById('panoramaViewerContainer');

  // Watermark (nadir decal) UI elements
  const wmBtn           = document.getElementById('wmBtn');
  const wmRemoveBtn     = document.getElementById('wmRemoveBtn');
  const wmImageLoader   = document.getElementById('wmImageLoader');
  const wmSizeSlider    = document.getElementById('wmSize');
  const wmSizeVal       = document.getElementById('wmSizeVal');
  const wmRotSlider     = document.getElementById('wmRot');
  const wmRotVal        = document.getElementById('wmRotVal');
  const saveWmBtn       = document.getElementById('saveWmBtn');
  const loadWmBtn       = document.getElementById('loadWmBtn');

  // Post-processing UI elements
  const enablePostBtn         = document.getElementById('enablePostBtn');
  const grainSlider         = document.getElementById('grain');
  const exposureSlider        = document.getElementById('exposure');
  const gammaPPSlider         = document.getElementById('gammaPP');
  const sharpenSlider         = document.getElementById('sharpen');
  const saturationSlider      = document.getElementById('saturation');
  const contrastSlider        = document.getElementById('contrast');

  const saveGeoBtn   = document.getElementById('saveGeoBtn');
  const loadGeoBtn   = document.getElementById('loadGeoBtn');
  const saveHdrBtn   = document.getElementById('saveHdrBtn');
  const loadHdrBtn   = document.getElementById('loadHdrBtn');
  const saveProcBtn  = document.getElementById('saveProcBtn');
  const loadProcBtn  = document.getElementById('loadProcBtn');


  let lastBaseName = 'panorama';
  let glProgram = null;
  let postProgram = null;
  let hdrFuseProgram = null;
  let sphereProgram = null;

  let currentImg = null;
  let currentTexture = null;
  let currentGainR = 1.0;

  let postEnabled = true;
  let postUniforms = {
    grain: 0,
    exposure: 1,
    gamma: 1,
    sharpen: 0.20,
    saturation: 1,
    contrast: 1,
  };

  let framebuffer = null;
  let renderTexture = null;

  // FBO/Texture pool to avoid repeated allocation during slider interaction
  const fboPool = new Map(); // key: `${width}x${height}`
  function getPooledFBO(w, h) {
    const key = `${w}x${h}`;
    if (!fboPool.has(key)) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      fboPool.set(key, { tex, fbo, width: w, height: h });
    }
    return fboPool.get(key);
  }

  // Offscreen pool for the fully-processed (stitch + post-FX) output, used by
  // full-resolution export and the 3D viewer. Kept separate from the visible
  // <canvas> so those paths are never subject to the browser's on-screen
  // "drawing buffer" size cap (see renderOffscreenPixels() below for why that
  // matters).
  const postFboPool = new Map(); // key: `${width}x${height}`
  function getPooledPostFBO(w, h) {
    const key = `${w}x${h}`;
    if (!postFboPool.has(key)) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      postFboPool.set(key, { tex, fbo, width: w, height: h });
    }
    return postFboPool.get(key);
  }

  // LF Texture pool for low-frequency blurred source
  const lfPool = new Map(); // key: `${width}x${height}`
  function getPooledLF(lfW, lfH) {
    const key = `${lfW}x${lfH}`;
    if (!lfPool.has(key)) {
      const mkTex = () => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, lfW, lfH);
        return t;
      };
      const lfTmpTex = mkTex();
      const lfTmpFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, lfTmpFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, lfTmpTex, 0);
      const lfTex = mkTex();
      const lfFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, lfFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, lfTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      lfPool.set(key, { lfTex, lfFbo, lfTmpTex, lfTmpFbo, width: lfW, height: lfH });
    }
    return lfPool.get(key);
  }

  // Drops every cached FBO/texture in the size-keyed pools. Called when a new
  // source image is loaded: those pools are keyed by source dimensions, so a
  // different image would otherwise keep every previous size's textures alive
  // (several full-resolution RGBA8 surfaces each) until the page reloads —
  // repeated loads OOM the browser and trigger a context loss / blank screen.
  function resetPools() {
    function clearMap(map) {
      map.forEach(entry => {
        if (entry.tex) gl.deleteTexture(entry.tex);
        if (entry.fbo) gl.deleteFramebuffer(entry.fbo);
        if (entry.lfTex) gl.deleteTexture(entry.lfTex);
        if (entry.lfFbo) gl.deleteFramebuffer(entry.lfFbo);
        if (entry.lfTmpTex) gl.deleteTexture(entry.lfTmpTex);
        if (entry.lfTmpFbo) gl.deleteFramebuffer(entry.lfTmpFbo);
      });
      map.clear();
    }
    clearMap(fboPool);
    clearMap(postFboPool);
    clearMap(lfPool);
  }

  // Precomputed low-frequency (blurred source) texture used by the stitch shader
  // so the per-pixel cost drops from a 13-tap in-shader blur to a single fetch.
  let lfTex = null, lfFbo = null, lfTmpTex = null, lfTmpFbo = null, lfProg = null;

  let sphere = null;
  let sphereRaf = null;
  let sphereFullTimer = null;
  // Full-resolution (source-res) post-processed texture, built entirely on the GPU
  // in the main context so the 3D viewer can sample it directly — no readback.
  let panoFullTex = null, panoFullFbo = null, panoFullW = 0, panoFullH = 0;
  let panoWMTex = null, panoWMFbo = null; // watermarked full-res equirect (3D view)
  let wmTex = null;            // watermark image texture (main context)
  let wmLoaded = false;
  let wmSize = 0.3;            // nadir decal angular radius (tangent-plane)
  let wmRotDeg = 0;          // nadir decal rotation (degrees)
  let wmAlpha = 1.0;
  let wmProgram = null;
  let wmFbo = null, wmFboTex = null, wmFboW = 0, wmFboH = 0; // reusable FBO for export compositing
  let panoFullDirty = true;
  let viewMode = '2d';
  let scaleValue = 1; // 1 = off, 2 = 2x scale
  let diffMode = false; // difference overlay for alignment

  // Render scheduling / caching state (items 1-4).
  let _stitchDirty = true;     // source geometry/lens/size changed -> FBO re-stitch needed
  let _fboValid = false;       // offscreen stitch texture currently reflects the source
  let _renderScheduled = false; // rAF coalescing flag for slider-driven renders

  const DEFAULT_CFG = Object.freeze({
    fovDeg: 190.0,
    radiusScale: 0.97,
    centers: { left: [0.25, 0.50], right: [0.75, 0.50] },
    rollDeg: { left: 0.0, right: 0.0 },
    stretch: { left: 1.0, right: 1.0 },
    blend: { hfBandWidth: 0.15 },
    hdr: { sigma: 0.18, bellCenter: 1.0 / 3.0, base: 0.02 },
    mirror3D: false,
  });

  const DEFAULT_POST = Object.freeze({
    grain: 0,
    exposure: 1,
    gamma: 1,
    sharpen: 0.20,
    saturation: 1,
    contrast: 1,
  });

  let cfg = JSON.parse(JSON.stringify(DEFAULT_CFG));

const sliderMap = [
     { id: 'fovDeg',       get: () => cfg.fovDeg,             set: v => cfg.fovDeg = v },
     { id: 'radiusScale',  get: () => cfg.radiusScale,        set: v => cfg.radiusScale = v },
     { id: 'blendGamma',   get: () => cfg.blend.hfBandWidth, set: v => cfg.blend.hfBandWidth = v },
      { id: 'hdrSigma',     get: () => cfg.hdr.sigma,          set: v => cfg.hdr.sigma = v,          live: false },
     { id: 'hdrBellCenter',get: () => cfg.hdr.bellCenter,     set: v => cfg.hdr.bellCenter = v,     live: false },
     { id: 'hdrBase',       get: () => cfg.hdr.base,           set: v => cfg.hdr.base = v,           live: false },
    { id: 'centerLx',     get: () => cfg.centers.left[0],    set: v => cfg.centers.left[0] = v },
    { id: 'centerLy',     get: () => cfg.centers.left[1],    set: v => cfg.centers.left[1] = v },
    { id: 'rollL',        get: () => cfg.rollDeg.left,       set: v => cfg.rollDeg.left = v },
    { id: 'stretchL',     get: () => cfg.stretch.left,       set: v => cfg.stretch.left = v },
    { id: 'centerRx',     get: () => cfg.centers.right[0],   set: v => cfg.centers.right[0] = v },
    { id: 'centerRy',     get: () => cfg.centers.right[1],   set: v => cfg.centers.right[1] = v },
    { id: 'rollR',        get: () => cfg.rollDeg.right,      set: v => cfg.rollDeg.right = v },
    { id: 'stretchR',     get: () => cfg.stretch.right,      set: v => cfg.stretch.right = v },
  ];

  // ---------------------------------------------------------------------------
  //  SETTINGS PERSISTENCE
  //  Two independent slots:
  //   - LIVE_KEY: the session state, auto-saved on every change and restored on
  //     the next launch, so you always pick up where you left off.
  //   - SNAPSHOT_KEY: a manual safety slot driven by the Save/Load buttons. Save
  //     freezes the current state; Load recalls it even after you've gone too far.
  //  applySettings() is the shared deserialiser used by both restore paths.
  // ---------------------------------------------------------------------------
  const LIVE_KEY = 'stitch360_settings_live';
  const SNAPSHOT_KEY = 'stitch360_settings_snapshot';

  function applySettings(parsed) {
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
      if (c.rollDeg) cfg.rollDeg = { ...c.rollDeg };
      if (c.stretch) cfg.stretch = { ...DEFAULT_CFG.stretch, ...c.stretch };
    }
    if (parsed.post) {
      Object.keys(DEFAULT_POST).forEach(key => {
        if (parsed.post[key] !== undefined) postUniforms[key] = parsed.post[key];
      });
    }
    if (typeof parsed.scale === 'number') scaleValue = parsed.scale === 2 ? 2 : 1;
    if (parsed.wm) {
      if (typeof parsed.wm.size === 'number') wmSize = parsed.wm.size;
      if (typeof parsed.wm.rot === 'number') wmRotDeg = parsed.wm.rot;
    }
  }

  function serialize() {
    return JSON.stringify({ cfg, post: postUniforms, scale: scaleValue, wm: { size: wmSize, rot: wmRotDeg } });
  }

  // Live session state -------------------------------------------------------
  // Synchronous localStorage writes are expensive, so the per-slider call sites
  // go through scheduleLiveSave() (debounced) while deliberate actions (Load,
  // HDR snapshot) call saveLiveConfig() directly for an immediate flush.
  let _liveSaveTimer = null;
  function saveLiveConfig() {
    try { localStorage.setItem(LIVE_KEY, serialize()); } catch (e) {}
  }
  function scheduleLiveSave() {
    if (_liveSaveTimer) clearTimeout(_liveSaveTimer);
    _liveSaveTimer = setTimeout(saveLiveConfig, 250);
  }

  function loadLiveConfig() {
    try {
      const saved = localStorage.getItem(LIVE_KEY);
      if (saved) applySettings(JSON.parse(saved));
    } catch (e) {}
  }

  // Manual snapshot slot (Save / Load buttons) --------------------------------
  // Geometry snapshot: saves the lens geometry/alignment state plus post-FX, but
  // deliberately EXCLUDES cfg.hdr so loading Geometry never clobbers the HDR
  // sliders — those are owned solely by the HDR Settings Save/Load pair.
  function saveSnapshot() {
    try {
      const geomCfg = {
        fovDeg: cfg.fovDeg,
        radiusScale: cfg.radiusScale,
        mirror3D: cfg.mirror3D,
        blend: cfg.blend,
        centers: cfg.centers,
        rollDeg: cfg.rollDeg,
        stretch: cfg.stretch,
      };
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ cfg: geomCfg, post: postUniforms }));
    } catch (e) {}
  }

  function loadSnapshot() {
    try {
      const saved = localStorage.getItem(SNAPSHOT_KEY);
      if (!saved) return false;
      const parsed = JSON.parse(saved);
      // The geometry slot never owns HDR — drop it so loading Geometry can't move
      // the hdrSigma / hdrBellCenter / hdrBase sliders (stale or otherwise).
      if (parsed.cfg) delete parsed.cfg.hdr;
      applySettings(parsed);
      // Sync the live slot to the recalled snapshot so a later reload keeps it.
      saveLiveConfig();
      return true;
    } catch (e) {
      return false;
    }
  }

  function flashButton(btn) {
    btn.classList.add('flash');
    setTimeout(() => btn.classList.remove('flash'), 300);
  }

  // HDR snapshot slot (Save / Load buttons in the HDR Settings group). Mirrors the
  // geometry slot but scopes the persisted state to the exposure-fusion bell
  // (sigma, bellCenter, base). HDR values are also folded into the live config by
  // the shared slider handler, so they restore on the next launch too.
  const HDR_SNAPSHOT_KEY = 'stitch360_hdr_snapshot';

  function saveHdrSnapshot() {
    try { localStorage.setItem(HDR_SNAPSHOT_KEY, JSON.stringify(cfg.hdr)); } catch (e) {}
  }

  function loadHdrSnapshot() {
    try {
      const saved = localStorage.getItem(HDR_SNAPSHOT_KEY);
      if (!saved) return false;
      cfg.hdr = { ...DEFAULT_CFG.hdr, ...JSON.parse(saved) };
      saveLiveConfig();
      return true;
    } catch (e) {
      return false;
    }
  }

  // Processing (post-processing) snapshot slot. Mirrors the HDR slot but scopes the
  // persisted state to the post-FX uniforms (grain, exposure, gamma, sharpen,
  // saturation, contrast) plus the ON/OFF enable flag. Values are also folded into
  // the live config by the post slider handler, so they restore on next launch too.
  const PROC_SNAPSHOT_KEY = 'stitch360_proc_snapshot';

  function saveProcSnapshot() {
    try {
      localStorage.setItem(PROC_SNAPSHOT_KEY, JSON.stringify({ post: postUniforms, postEnabled }));
    } catch (e) {}
  }

  function loadProcSnapshot() {
    try {
      const saved = localStorage.getItem(PROC_SNAPSHOT_KEY);
      if (!saved) return false;
      const parsed = JSON.parse(saved);
      if (parsed.post) {
        Object.keys(DEFAULT_POST).forEach(key => {
          if (parsed.post[key] !== undefined) postUniforms[key] = parsed.post[key];
        });
      }
      if (typeof parsed.postEnabled === 'boolean') postEnabled = parsed.postEnabled;
      saveLiveConfig();
      return true;
    } catch (e) {
      return false;
    }
  }

  // Watermark snapshot slot. Persists the decal geometry (size + rotation) — the
  // image itself cannot be serialized, so it must be re-loaded by the user. The
  // values are also folded into the live config by the watermark handlers.
  const WM_SNAPSHOT_KEY = 'stitch360_wm_snapshot';

  function saveWmSnapshot() {
    try { localStorage.setItem(WM_SNAPSHOT_KEY, JSON.stringify({ size: wmSize, rot: wmRotDeg })); } catch (e) {}
  }

  function loadWmSnapshot() {
    try {
      const saved = localStorage.getItem(WM_SNAPSHOT_KEY);
      if (!saved) return false;
      const parsed = JSON.parse(saved);
      if (typeof parsed.size === 'number') wmSize = parsed.size;
      if (typeof parsed.rot === 'number') wmRotDeg = parsed.rot;
      saveLiveConfig();
      return true;
    } catch (e) {
      return false;
    }
  }

  function updateWmUI() {
    if (wmSizeSlider) wmSizeSlider.value = wmSize;
    if (wmSizeVal) wmSizeVal.textContent = wmSize.toFixed(2);
    if (wmRotSlider) wmRotSlider.value = wmRotDeg;
    if (wmRotVal) wmRotVal.textContent = String(Math.round(wmRotDeg));
  }

  function updateUIFromConfig() {
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
  }

  function updatePostUI() {
    if (grainSlider) {
      grainSlider.value = postUniforms.grain;
      if (document.getElementById('grainVal')) document.getElementById('grainVal').textContent = postUniforms.grain.toFixed(2);
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
      enablePostBtn.textContent = postEnabled ? 'ON' : 'OFF';
      enablePostBtn.classList.toggle('active', postEnabled);
    }
  }

  // Draws the current HDR well-exposedness bell curve (Gaussian) so the user can
  // see how σ (width) and Bell Center shape the blend before running a merge.
  function drawHdrBellChart() {
    const canvas = document.getElementById('hdrBellChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0e0e10';
    ctx.fillRect(0, 0, W, H);
    const sigma = cfg.hdr.sigma;
    const center = cfg.hdr.bellCenter;
    const base = cfg.hdr.base;
    const inv2Sig2 = 1.0 / (2.0 * sigma * sigma);
    // Effective weight = base + (1 - base) * Gaussian, so the curve sits on a
    // baseline floor (base) and the bell adds on top up to 1.0 at the centre.
    ctx.beginPath();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    for (let x = 0; x <= W; x++) {
      const lum = x / W;
      const w = base + (1.0 - base) * Math.exp(-((lum - center) * (lum - center)) * inv2Sig2);
      const y = H - 2 - w * (H - 4);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // Centre marker (where the bell peaks).
    const cx = center * W;
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
  }

  function initControlListeners() {
    sliderMap.forEach(item => {
      const input = document.getElementById(item.id);
      const valSpan = document.getElementById(`${item.id}Val`);
      if (!input) return;
      if (input.type === 'checkbox') {
        input.addEventListener('change', (e) => {
          const val = e.target.checked;
          item.set(val);
          if (valSpan) valSpan.textContent = val ? 'ON' : 'OFF';
          scheduleLiveSave();
          if (item.live !== false && currentImg) { markStitchDirty(); scheduleRender(); }
        });
      } else {
        input.addEventListener('input', (e) => {
          const val = parseFloat(e.target.value);
          item.set(val);
          const step = input.step || '1';
          const decimals = step.includes('.') ? step.split('.')[1].length : 0;
          if (valSpan) valSpan.textContent = val.toFixed(decimals);
          scheduleLiveSave();
          if (item.live !== false && currentImg) { markStitchDirty(); scheduleRender(); }
          if (item.id === 'hdrSigma' || item.id === 'hdrBellCenter' || item.id === 'hdrBase') drawHdrBellChart();
        });
      }
    });

    const postSliders = [
      { el: grainSlider, id: 'grainVal', key: 'grain' },
      { el: exposureSlider, id: 'exposureVal', key: 'exposure' },
      { el: gammaPPSlider, id: 'gammaPPVal', key: 'gamma' },
      { el: sharpenSlider, id: 'sharpenVal', key: 'sharpen' },
      { el: saturationSlider, id: 'saturationVal', key: 'saturation' },
      { el: contrastSlider, id: 'contrastVal', key: 'contrast' }
    ];

    postSliders.forEach(({el, id, key}) => {
      if (!el) return;
      el.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        postUniforms[key] = val;
        const span = document.getElementById(id);
        if (span) span.textContent = val.toFixed(2);
        scheduleLiveSave();
        // When Post-FX is off the effect isn't shown, so don't trigger an
        // expensive re-stitch — just let the slider move smoothly. The redraw
        // happens once when Post-FX is toggled back on.
        if (currentImg && postEnabled) scheduleRender();
      });
    });

    if (enablePostBtn) {
      enablePostBtn.addEventListener('click', () => {
        postEnabled = !postEnabled;
        updatePostUI();
        scheduleLiveSave();
        if (currentImg) renderPano();
      });
    }

    if (saveGeoBtn) saveGeoBtn.addEventListener('click', () => {
      saveSnapshot();
      flashButton(saveGeoBtn);
    }, false);
    if (loadGeoBtn) loadGeoBtn.addEventListener('click', () => {
      if (loadSnapshot()) {
        updateUIFromConfig();
        updatePostUI();
        drawHdrBellChart();
        if (mirror3DBtn) mirror3DBtn.classList.toggle('active', cfg.mirror3D);
        if (currentImg) { markStitchDirty(); renderPano(); }
        if (sphere) renderSphere();
      }
      flashButton(loadGeoBtn);
    }, false);

    if (saveHdrBtn) saveHdrBtn.addEventListener('click', () => {
      saveHdrSnapshot();
      flashButton(saveHdrBtn);
    }, false);
    if (loadHdrBtn) loadHdrBtn.addEventListener('click', () => {
      if (loadHdrSnapshot()) {
        updateUIFromConfig();
        drawHdrBellChart();
      }
      flashButton(loadHdrBtn);
    }, false);

    if (saveProcBtn) saveProcBtn.addEventListener('click', () => {
      saveProcSnapshot();
      flashButton(saveProcBtn);
    }, false);
    if (loadProcBtn) loadProcBtn.addEventListener('click', () => {
      if (loadProcSnapshot()) {
        updatePostUI();
        if (currentImg) renderPano();
      }
      flashButton(loadProcBtn);
    }, false);

    if (viewModeBtn) viewModeBtn.addEventListener('click', () => {
      setViewMode(viewMode === '3d' ? '2d' : '3d');
    });

    if (x2Btn) {
      x2Btn.addEventListener('click', () => {
        scaleValue = scaleValue === 1 ? 2 : 1;
        x2Btn.classList.toggle('active', scaleValue === 2);
        saveLiveConfig();
      });
    }
    if (diffBtn) {
      diffBtn.addEventListener('click', () => {
        diffMode = !diffMode;
        diffBtn.classList.toggle('active', diffMode);
        if (currentImg) {
          markStitchDirty();
          renderPano();
          if (sphere) renderSphere();
        }
      });
    }
    if (mirror3DBtn) {
      mirror3DBtn.addEventListener('click', () => {
        cfg.mirror3D = !cfg.mirror3D;
        mirror3DBtn.classList.toggle('active', cfg.mirror3D);
        if (sphere) renderSphere();
      });
    }

    if (snapViewBtn) {
      snapViewBtn.addEventListener('click', () => {
        if (viewMode !== '3d') setViewMode('3d');
        if (sphere) {
          const step = Math.PI / 6.0;
          sphere.yaw = Math.round(sphere.yaw / step) * step;
          sphere.pitch = 0.0;
          renderSphere();
      }
    });
    if (wmBtn && wmImageLoader) {
      wmBtn.addEventListener('click', () => wmImageLoader.click());
      wmImageLoader.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const img = new Image();
        img.onload = () => {
          if (wmTex) gl.deleteTexture(wmTex);
          wmTex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, wmTex);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          wmLoaded = true;
          if (viewMode === '3d') { panoFullDirty = true; refreshSphereFromTexture(); }
          scheduleLiveSave();
        };
        img.src = URL.createObjectURL(file);
        wmImageLoader.value = '';
      });
    }

    if (wmRemoveBtn) {
      wmRemoveBtn.addEventListener('click', () => {
        wmLoaded = false;
        if (wmTex) { gl.deleteTexture(wmTex); wmTex = null; }
        if (viewMode === '3d') { panoFullDirty = true; refreshSphereFromTexture(); }
        scheduleLiveSave();
      });
    }

    if (wmSizeSlider) {
      wmSizeSlider.addEventListener('input', (e) => {
        wmSize = parseFloat(e.target.value);
        if (wmSizeVal) wmSizeVal.textContent = wmSize.toFixed(2);
        if (wmLoaded && viewMode === '3d') { panoFullDirty = true; refreshSphereFromTexture(); }
        scheduleLiveSave();
      });
    }

    if (wmRotSlider) {
      wmRotSlider.addEventListener('input', (e) => {
        wmRotDeg = parseFloat(e.target.value);
        if (wmRotVal) wmRotVal.textContent = String(Math.round(wmRotDeg));
        if (wmLoaded && viewMode === '3d') { panoFullDirty = true; refreshSphereFromTexture(); }
        scheduleLiveSave();
      });
    }

    if (saveWmBtn) {
      saveWmBtn.addEventListener('click', () => {
        saveWmSnapshot();
        flashButton(saveWmBtn);
      });
    }
    if (loadWmBtn) {
      loadWmBtn.addEventListener('click', () => {
        if (loadWmSnapshot()) {
          updateWmUI();
          if (viewMode === '3d' && wmLoaded) { panoFullDirty = true; refreshSphereFromTexture(); }
        }
      });
    }

    // Update toggle buttons (not part of sliderMap)
    if (mirror3DBtn) mirror3DBtn.classList.toggle('active', cfg.mirror3D);
    if (diffBtn) diffBtn.classList.toggle('active', diffMode);
  }
  }

  loadLiveConfig();
  initControlListeners();
  updateUIFromConfig();
  updatePostUI();
  updateWmUI();
  drawHdrBellChart();
  if (x2Btn) x2Btn.classList.toggle('active', scaleValue === 2);

  // Re-render at the new on-screen size when the layout changes (the preview is
  // sized to the viewport, not the source). Debounced so a drag-resize doesn't
  // thrash the GPU.
  let _resizeTimer = null;
  window.addEventListener('resize', () => {
    if (!currentImg) return;
    if (_resizeTimer) clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => scheduleRender(), 150);
  });

  function setLoading(isOn, message) {
    if (loaderEl) loaderEl.classList.toggle('hidden', !isOn);
    if (loaderMsgEl) loaderMsgEl.textContent = message || (isOn ? 'Working…' : '');
    if (downloadBtn) downloadBtn.disabled = !!isOn;
    if (downloadJpgBtn) downloadJpgBtn.disabled = !!isOn;
  }

  function setActionsVisible(isOn) {
    if (actionsEl) actionsEl.classList.toggle('hidden', !isOn);
  }

  if (imageLoader) imageLoader.addEventListener('change', onFile, false);
  if (downloadBtn) downloadBtn.addEventListener('click', onDownloadPng, false);
  if (downloadJpgBtn) downloadJpgBtn.addEventListener('click', onDownloadJpg, false);

  // ===========================================================================
  //  IMAGE LOADING & STITCHING ENTRYPOINT
  // ===========================================================================

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setActionsVisible(false);
    lastBaseName = (file.name || 'panorama').replace(/\.[^.]+$/, '');
    
    try {
      setLoading(true, 'Reading source image file...');
      let img = await loadImageFromFile(file);
      img = scaleSource(img); // 2x upscale if X2 is on

      // Clamp the longest side to the GPU max so neither width nor height can
      // overflow MAX_TEX_SIZE (the old check only guarded width).
      const MAX_SOURCE_DIM = MAX_TEX_SIZE;
      const longest = Math.max(img.width, img.height);
      if (longest > MAX_SOURCE_DIM) {
        const scale = MAX_SOURCE_DIM / longest;
        const off = document.createElement('canvas');
        off.width = Math.round(img.width * scale);
        off.height = Math.round(img.height * scale);
        const ctx = off.getContext('2d');
        ctx.drawImage(img, 0, 0, off.width, off.height);
        img = off;
      }

      setLoading(true, 'Stitching panorama in WebGL...');
      currentImg = img;
      uploadTexture(img);
      await new Promise(requestAnimationFrame);
      renderPano();
      setActionsVisible(true);
    } catch (err) {
      console.error(err);
      alert('Stitching failed: ' + (err?.message || err));
    } finally {
      setLoading(false);
    }
  }

  // ===========================================================================
  //  WEBGL PIPELINE & SHADERS
  // ===========================================================================

  // Pure size math: clamps to the GPU's max texture/viewport dimensions and
  // keeps a 2:1 equirect aspect with even edges. No canvas side effects, so
  // this is safe to reuse for off-screen render targets too.
  function clampToGpuLimits(desiredW, desiredH) {
    const maxDim = Math.min(MAX_TEX_SIZE, gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0]);
    const w = Math.min(desiredW, maxDim) - (Math.min(desiredW, maxDim) % 2);
    const h = Math.min(desiredH, Math.floor(w / 2));
    return { w: h * 2, h };
  }

  // Clamps the requested size to the GPU's max render-target dimensions and sets
  // the *visible* canvas to that size.
  //
  // IMPORTANT: MAX_TEXTURE_SIZE / MAX_VIEWPORT_DIMS describe the GPU's texture
  // limits, but NOT what the browser will actually allocate as the on-screen
  // canvas's backing store ("drawing buffer"). Per the WebGL spec, drawingBufferWidth/
  // drawingBufferHeight "may differ" from canvas.width/height whenever the
  // implementation can't satisfy the requested size (this is common for very
  // large canvases, especially with preserveDrawingBuffer:true, which this
  // context uses so exports can read back the canvas). When that happens,
  // gl.viewport(0,0,w,h) sized off the *requested* dimensions only fills the
  // browser-granted bottom-left drawingBufferWidth x drawingBufferHeight portion
  // of the canvas, leaving the rest blank — which is exactly the "~60-70% of
  // the image, anchored at the bottom-left" artifact seen exporting/opening the
  // 3D view at HD (2x) resolution. Re-clamping against the real drawing buffer
  // here closes that gap for the on-screen canvas. Full-resolution export and
  // the 3D viewer now additionally avoid the on-screen canvas entirely (see
  // renderOffscreenPixels) so they aren't limited by this cap at all.
  function getSafeRenderSize(desiredW, desiredH) {
    let { w: finalW, h } = clampToGpuLimits(desiredW, desiredH);
    panoramaCanvas.width = finalW;
    panoramaCanvas.height = h;

    if (gl.drawingBufferWidth < finalW || gl.drawingBufferHeight < h) {
      h = Math.min(h, gl.drawingBufferHeight, Math.floor(gl.drawingBufferWidth / 2));
      finalW = h * 2;
      panoramaCanvas.width = finalW;
      panoramaCanvas.height = h;
    }

    const clamped = finalW !== desiredW || h !== desiredH;
    return { w: finalW, h, clamped };
  }

  // The live 2D preview is capped so dragging sliders stays responsive on very
  // large sources; the 3D viewer and export still render at full source resolution.
  const PREVIEW_MAX_W = 4096;
  function computePreviewSize() {
    if (!currentImg) return { w: 2, h: 1 };
    const w = Math.min(currentImg.width, PREVIEW_MAX_W);
    const h = Math.round(w / 2);
    return { w, h };
  }

  function renderPano(requestedW = null, requestedH = null) {
    if (!currentImg) return;
    let panoW = requestedW;
    let panoH = requestedH;
    if (panoW === null) {
      const ps = computePreviewSize();
      panoW = ps.w;
      panoH = ps.h;
    } else {
      panoH = panoH || Math.round(panoW / 2);
    }

    if (viewMode === '3d') {
      // 3D view samples the offscreen stitched FBO directly (single context), so
      // keep it in sync at FULL source resolution without drawing the equirect to
      // the visible canvas. No readback — the sphere samples the GPU texture.
      const fullW0 = Math.min(currentImg.width, MAX_TEX_SIZE);
      const fullH0 = Math.round(fullW0 / 2);
      const { w, h } = clampToGpuLimits(fullW0, fullH0);
      if (postEnabled) stitchIfNeeded(w, h);
      else stitchIfNeeded(w, h);
      panoFullDirty = true;
      scheduleViewerUpdate();
      return;
    }

    const safe = getSafeRenderSize(panoW, panoH);
    panoW = safe.w;
    panoH = safe.h;

    if (postEnabled) {
      renderWithPostProcessing(panoW, panoH);
    } else {
      stitchWebGL(currentImg.width, currentImg.height, panoW, panoH, null);
      _fboValid = false; // post-off path draws straight to canvas; FBO is now stale
    }

    scheduleViewerUpdate();
  }

  // Coalesces rapid slider-driven renders into a single rAF callback so a single
  // drag (dozens of 'input' events) triggers at most one GPU render per frame.
  function scheduleRender() {
    if (_renderScheduled) return;
    _renderScheduled = true;
    requestAnimationFrame(() => {
      _renderScheduled = false;
      renderPano();
    });
  }

  // Marks the cached offscreen stitch as invalid so the next render re-stitches.
  function markStitchDirty() {
    _stitchDirty = true;
    _fboValid = false;
  }

  // Separable Gaussian blur used to precompute the low-frequency source layer.
  const BLUR_VS = `#version 300 es
    layout(location = 0) in vec2 a_position;
    out vec2 v_uv;
    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  const BLUR_FS = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 fragColor;
    uniform sampler2D u_tex;
    uniform vec2 u_texel;
    uniform vec2 u_dir;
    void main() {
      float w0 = 0.227027, w1 = 0.194595, w2 = 0.121621, w3 = 0.054054, w4 = 0.016216;
      vec3 c = texture(u_tex, v_uv).rgb * w0;
      c += texture(u_tex, v_uv + u_dir * u_texel * 1.0).rgb * w1;
      c += texture(u_tex, v_uv - u_dir * u_texel * 1.0).rgb * w1;
      c += texture(u_tex, v_uv + u_dir * u_texel * 2.0).rgb * w2;
      c += texture(u_tex, v_uv - u_dir * u_texel * 2.0).rgb * w2;
      c += texture(u_tex, v_uv + u_dir * u_texel * 3.0).rgb * w3;
      c += texture(u_tex, v_uv - u_dir * u_texel * 3.0).rgb * w3;
      c += texture(u_tex, v_uv + u_dir * u_texel * 4.0).rgb * w4;
      c += texture(u_tex, v_uv - u_dir * u_texel * 4.0).rgb * w4;
      fragColor = vec4(c, 1.0);
    }
  `;

  // Builds a half-resolution blurred copy of the source texture (two separable
  // passes) so the stitch shader can fetch the LF layer with one texture read
  // instead of performing a 13-tap blur per pixel.
  function buildLFTexture() {
    if (!currentTexture || !currentImg) return;
    const lfW = Math.max(1, currentImg.width >> 1);
    const lfH = Math.max(1, currentImg.height >> 1);

    const pooled = getPooledLF(lfW, lfH);
    lfTex = pooled.lfTex;
    lfFbo = pooled.lfFbo;
    lfTmpTex = pooled.lfTmpTex;
    lfTmpFbo = pooled.lfTmpFbo;

    if (!lfProg) {
      lfProg = createProgram(gl, BLUR_VS, BLUR_FS);
      // Cache uniform locations once
      lfProg._u = {
        u_tex:   gl.getUniformLocation(lfProg, 'u_tex'),
        u_texel: gl.getUniformLocation(lfProg, 'u_texel'),
        u_dir:   gl.getUniformLocation(lfProg, 'u_dir'),
      };
    }
    gl.useProgram(lfProg);
    gl.bindVertexArray(getQuadVAO());
    const u = lfProg._u;
    gl.uniform1i(u.u_tex, 0);

    // Horizontal pass: source -> tmp
    gl.bindFramebuffer(gl.FRAMEBUFFER, lfTmpFbo);
    gl.viewport(0, 0, lfW, lfH);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, currentTexture);
    gl.uniform2f(u.u_texel, 1.0 / lfW, 1.0 / lfH);
    gl.uniform2f(u.u_dir, 1.0, 0.0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Vertical pass: tmp -> lf
    gl.bindFramebuffer(gl.FRAMEBUFFER, lfFbo);
    gl.bindTexture(gl.TEXTURE_2D, lfTmpTex);
    gl.uniform2f(u.u_dir, 0.0, 1.0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function allocateStitchTarget(panoW, panoH) {
    const pooled = getPooledFBO(panoW, panoH);
    renderTexture = pooled.tex;
    framebuffer = pooled.fbo;
    renderTexture.width = panoW;
    renderTexture.height = panoH;
  }

  // Re-stitches the source into the offscreen FBO only when geometry/lens/size
  // changed, so cheap post-processing passes never pay for a full re-stitch.
  function stitchIfNeeded(panoW, panoH) {
    const needRealloc = !renderTexture || renderTexture.width !== panoW || renderTexture.height !== panoH;
    if (needRealloc || !_fboValid || _stitchDirty) {
      if (needRealloc) allocateStitchTarget(panoW, panoH);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(0, 0, panoW, panoH);
      stitchWebGL(currentImg.width, currentImg.height, panoW, panoH, true);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      _fboValid = true;
      _stitchDirty = false;
    }
  }

  function renderWithPostProcessing(panoW, panoH, targetFbo = null) {
    stitchIfNeeded(panoW, panoH);

    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
    gl.viewport(0, 0, panoW, panoH);

    if (!postProgram) {
      postProgram = createPostProgram();
      // Cache uniform locations once
      postProgram._u = {
        u_texture:    gl.getUniformLocation(postProgram, 'u_texture'),
        u_texSize:    gl.getUniformLocation(postProgram, 'u_texSize'),
        u_grain:      gl.getUniformLocation(postProgram, 'u_grain'),
        u_exposure:   gl.getUniformLocation(postProgram, 'u_exposure'),
        u_gamma:      gl.getUniformLocation(postProgram, 'u_gamma'),
        u_sharpen:    gl.getUniformLocation(postProgram, 'u_sharpen'),
        u_saturation: gl.getUniformLocation(postProgram, 'u_saturation'),
        u_contrast:   gl.getUniformLocation(postProgram, 'u_contrast'),
      };
    }
    gl.useProgram(postProgram);
    gl.bindVertexArray(getQuadVAO());

    const u = postProgram._u;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, renderTexture);
    gl.uniform1i(u.u_texture, 0);
    gl.uniform2f(u.u_texSize, panoW, panoH);
    gl.uniform1f(u.u_grain, postUniforms.grain);
    gl.uniform1f(u.u_exposure, postUniforms.exposure);
    gl.uniform1f(u.u_gamma, postUniforms.gamma);
    gl.uniform1f(u.u_sharpen, postUniforms.sharpen);
    gl.uniform1f(u.u_saturation, postUniforms.saturation);
    gl.uniform1f(u.u_contrast, postUniforms.contrast);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  const VS_SOURCE = `#version 300 es
  layout(location = 0) in vec2 a_position;
  out vec2 v_uv;
  void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
  }
  `;

  const FS_SOURCE = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  out vec4 fragColor;
  uniform sampler2D u_image;
  uniform sampler2D u_imageLF;
  uniform float u_gainR;
  uniform vec2 u_srcSize;
  uniform vec2 u_centersL;
  uniform vec2 u_centersR;
  uniform float u_radius;
  uniform float u_halfFov;
  uniform float u_f;
   uniform float u_hfBandWidth;
  uniform vec3 u_axisL;
  uniform vec3 u_upL;
  uniform vec3 u_rightL;
  uniform vec3 u_axisR;
  uniform vec3 u_upR;
  uniform vec3 u_rightR;
  uniform float u_stretchL;
  uniform float u_stretchR;
  uniform int u_diffMode;

  #define PI 3.14159265358979323846

  struct LensResult {
      vec2 sxsy;
      float w;
      bool hit;
  };

  LensResult mapLens(vec3 v, vec3 axis, vec3 up, vec3 right, vec2 center, float stretch) {
      LensResult res;
      res.hit = false;
      res.w = 0.0;
      res.sxsy = vec2(0.0);

      float dotAxis = dot(v, axis);
      float theta = acos(clamp(dotAxis, -1.0, 1.0));
      if (theta > u_halfFov) return res;
      float vu = dot(v, up);
      float vr = dot(v, right);
      float az = atan(vr, vu);
      float dist = u_f * theta;
      vec2 d = vec2(dist * sin(az) / stretch, -dist * cos(az));
      vec2 s = center + d;
      if (dot(d, d) > u_radius * u_radius) return res;
      res.sxsy = s;
      res.w = clamp(1.0 - (theta / u_halfFov), 0.0, 1.0);
      res.hit = true;
      return res;
  }

  vec4 sampleSource(vec2 pixelCoord) {
      vec2 texCoord = vec2(pixelCoord.x / u_srcSize.x, 1.0 - (pixelCoord.y / u_srcSize.y));
      return texture(u_image, texCoord);
  }

  vec3 sampleSourceLF(vec2 pixelCoord) {
      vec2 texCoord = vec2(pixelCoord.x / u_srcSize.x, 1.0 - (pixelCoord.y / u_srcSize.y));
      return texture(u_imageLF, texCoord).rgb;
  }

  void main() {
      float pxNorm = v_uv.x;
      float pyNorm = 1.0 - v_uv.y;

      float vLat = pyNorm * PI - (PI / 2.0);
      float vLon = pxNorm * 2.0 * PI;
      float cosLat = cos(vLat);
      vec3 v = vec3(cosLat * cos(vLon), cosLat * sin(vLon), sin(vLat));

      LensResult resR = mapLens(v, u_axisR, u_upR, u_rightR, u_centersR, u_stretchR);
      LensResult resL = mapLens(v, u_axisL, u_upL, u_rightL, u_centersL, u_stretchL);

      // Difference overlay: show abs difference between lenses in overlap region.
      // Bright = misaligned, dark = well aligned. Helps tune stretch/center/roll.
      // Softened: threshold suppresses high-frequency noise (grass, dirt, texture)
      // and shows only strong differences (edges, lines, misalignment).
                  if (u_diffMode == 1 && resL.hit && resR.hit) {
          vec2 texel = 1.0 / u_srcSize;
          vec3 blurredDiff = vec3(0.0);
          float total = 0.0;
          // ~9px gaussian blur for strong noise suppression. Kept at a 7x7 tap
          // (down from 11x11) so the diagnostic overlay stays responsive at full
          // preview resolution.
          for (int dx = -3; dx <= 3; dx++) {
              for (int dy = -3; dy <= 3; dy++) {
                  vec2 off = vec2(float(dx), float(dy)) * texel * 3.0;
                  vec3 l = sampleSource(resL.sxsy + off).rgb;
                  vec3 r = clamp(sampleSource(resR.sxsy + off).rgb * u_gainR, 0.0, 1.0);
                  float d2 = float(dx*dx + dy*dy);
                  float w = exp(-d2 * 0.15);
                  blurredDiff += abs(l - r) * w;
                  total += w;
              }
          }
          blurredDiff /= total;
          blurredDiff *= 8.0;
          fragColor = vec4(clamp(blurredDiff, 0.0, 1.0), 1.0);
          return;
      }

      float totalWeight = resL.w + resR.w;
      float ratio = (totalWeight > 0.0) ? (resL.w / totalWeight) : 0.5;

      float halfW = max(0.005, u_hfBandWidth);
      float w = smoothstep(0.5 - halfW, 0.5 + halfW, ratio);
      float wHF = w;
      float wLF = w;

      vec3 colorL_raw = resL.hit ? sampleSource(resL.sxsy).rgb : vec3(0.0);
      vec3 colorR_raw = resR.hit ? clamp(sampleSource(resR.sxsy).rgb * u_gainR, 0.0, 1.0) : vec3(0.0);

      if (resL.hit && resR.hit) {
          vec3 colorL_lf = sampleSourceLF(resL.sxsy);
          vec3 colorR_lf = clamp(sampleSourceLF(resR.sxsy) * u_gainR, 0.0, 1.0);

          vec3 colorL_hf = colorL_raw - colorL_lf;
          vec3 colorR_hf = colorR_raw - colorR_lf;

          vec3 blendedLF = mix(colorR_lf, colorL_lf, wLF);
          vec3 blendedHF = mix(colorR_hf, colorL_hf, wHF);

          fragColor = vec4(clamp(blendedLF + blendedHF, 0.0, 1.0), 1.0);
      } else if (resL.hit) {
          fragColor = vec4(colorL_raw, 1.0);
      } else if (resR.hit) {
          fragColor = vec4(colorR_raw, 1.0);
      } else {
          bool useRight = v.x >= 0.0;
          vec3 axis = useRight ? u_axisR : u_axisL;
          vec3 up = useRight ? u_upR : u_upL;
          vec3 right = useRight ? u_rightR : u_rightL;
          vec2 center = useRight ? u_centersR : u_centersL;

          float vu = dot(v, up);
          float vr = dot(v, right);
          float theta = acos(clamp(dot(v, axis), -1.0, 1.0));
          float az = atan(vr, vu);
          float dist = u_f * theta;
          float stretch = useRight ? u_stretchR : u_stretchL;
          vec2 d = vec2(dist * sin(az) / stretch, -dist * cos(az));
          vec2 s = center + d;
          vec3 color = sampleSource(s).rgb;
          if (useRight) color = clamp(color * u_gainR, 0.0, 1.0);
          fragColor = vec4(color, 1.0);
      }
  }
  `;

  function createProgram(gl, vsSource, fsSource) {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSource);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.error('❌ Vertex shader compile error:', gl.getShaderInfoLog(vs));
      console.error('Shader source:', vsSource);
    }

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSource);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error('❌ Fragment shader compile error:', gl.getShaderInfoLog(fs));
      console.error('Shader source:', fsSource);
    }

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('❌ Shader program link error:', gl.getProgramInfoLog(prog));
    }
    // Shaders can be deleted after linking — frees GPU memory immediately.
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return prog;
  }

  function createPostProgram() {
    const vsSource = `#version 300 es
      layout(location = 0) in vec2 a_position;
      out vec2 v_uv;
      void main() {
        v_uv = a_position * 0.5 + 0.5;
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;

    const fsSource = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      out vec4 fragColor;
      uniform sampler2D u_texture;
      uniform vec2 u_texSize;
      uniform float u_exposure;
      uniform float u_gamma;
      uniform float u_sharpen;
      uniform float u_saturation;
      uniform float u_contrast;
      uniform float u_grain;

      float luminance(vec3 color) {
        return dot(color, vec3(0.299, 0.587, 0.114));
      }

      float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      // Samples the texture in the same post-exposure/gamma space used by the
      // sharpening luminance so the detail term is computed consistently.
      float gaussianBlurLum(sampler2D tex, vec2 uv, vec2 texelSize, bool horizontal) {
        float w0 = 0.227027, w1 = 0.194595, w2 = 0.121621, w3 = 0.054054, w4 = 0.016216;
        vec3 c = texture(tex, uv).rgb * u_exposure;
        c = pow(c, vec3(u_gamma));
        float sum = luminance(c) * w0;
        if (horizontal) {
          sum += luminance(pow(texture(tex, uv + vec2( texelSize.x, 0.0)).rgb * u_exposure, vec3(u_gamma))) * w1;
          sum += luminance(pow(texture(tex, uv + vec2(-texelSize.x, 0.0)).rgb * u_exposure, vec3(u_gamma))) * w1;
          sum += luminance(pow(texture(tex, uv + vec2( 2.0*texelSize.x, 0.0)).rgb * u_exposure, vec3(u_gamma))) * w2;
          sum += luminance(pow(texture(tex, uv + vec2(-2.0*texelSize.x, 0.0)).rgb * u_exposure, vec3(u_gamma))) * w2;
          sum += luminance(pow(texture(tex, uv + vec2( 3.0*texelSize.x, 0.0)).rgb * u_exposure, vec3(u_gamma))) * w3;
          sum += luminance(pow(texture(tex, uv + vec2(-3.0*texelSize.x, 0.0)).rgb * u_exposure, vec3(u_gamma))) * w3;
          sum += luminance(pow(texture(tex, uv + vec2( 4.0*texelSize.x, 0.0)).rgb * u_exposure, vec3(u_gamma))) * w4;
          sum += luminance(pow(texture(tex, uv + vec2(-4.0*texelSize.x, 0.0)).rgb * u_exposure, vec3(u_gamma))) * w4;
        } else {
          sum += luminance(pow(texture(tex, uv + vec2(0.0,  texelSize.y)).rgb * u_exposure, vec3(u_gamma))) * w1;
          sum += luminance(pow(texture(tex, uv + vec2(0.0, -texelSize.y)).rgb * u_exposure, vec3(u_gamma))) * w1;
          sum += luminance(pow(texture(tex, uv + vec2(0.0,  2.0*texelSize.y)).rgb * u_exposure, vec3(u_gamma))) * w2;
          sum += luminance(pow(texture(tex, uv + vec2(0.0, -2.0*texelSize.y)).rgb * u_exposure, vec3(u_gamma))) * w2;
          sum += luminance(pow(texture(tex, uv + vec2(0.0,  3.0*texelSize.y)).rgb * u_exposure, vec3(u_gamma))) * w3;
          sum += luminance(pow(texture(tex, uv + vec2(0.0, -3.0*texelSize.y)).rgb * u_exposure, vec3(u_gamma))) * w3;
          sum += luminance(pow(texture(tex, uv + vec2(0.0,  4.0*texelSize.y)).rgb * u_exposure, vec3(u_gamma))) * w4;
          sum += luminance(pow(texture(tex, uv + vec2(0.0, -4.0*texelSize.y)).rgb * u_exposure, vec3(u_gamma))) * w4;
        }
        return sum;
      }

      void main() {
        vec3 color = texture(u_texture, v_uv).rgb;

        color *= u_exposure;
        color = pow(color, vec3(u_gamma));

        if (u_sharpen > 0.0) {
          vec2 texelSize = 1.0 / u_texSize;
          float origLum = luminance(color);
          // Average the two separable 1D passes into one isotropic low-frequency
          // estimate so sharpening isn't biased to a single axis (the previous
          // code discarded the horizontal pass and kept only the vertical one).
          float blurH = gaussianBlurLum(u_texture, v_uv, texelSize, true);
          float blurV = gaussianBlurLum(u_texture, v_uv, texelSize, false);
          float blurLum = 0.5 * (blurH + blurV);
          float detail = origLum - blurLum;
          float newLum = clamp(origLum + detail * u_sharpen, 0.0, 1.0);
          color *= newLum / max(origLum, 0.0001);
        }

        float gray = luminance(color);
        color = mix(vec3(gray), color, u_saturation);
        color = clamp((color - 0.5) * u_contrast + 0.5, 0.0, 1.0);

        if (u_grain > 0.0) {
          float n = hash12(gl_FragCoord.xy) - 0.5;
          color += n * u_grain;
        }

        fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
      }
    `;

    return createProgram(gl, vsSource, fsSource);
  }

  function estimateGainR(img) {
    try {
      const sw = Math.min(img.width, 512);
      const sh = Math.max(1, Math.round(sw * (img.height / img.width)));
      const c = document.createElement('canvas');
      c.width = sw; c.height = sh;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, sw, sh);
      const data = ctx.getImageData(0, 0, sw, sh).data;
      const s = sw / img.width; // uniform scale (aspect preserved)
      const cxL = img.width * cfg.centers.left[0] * s;
      const cyL = img.height * cfg.centers.left[1] * s;
      const cxR = img.width * cfg.centers.right[0] * s;
      const cyR = img.height * cfg.centers.right[1] * s;
      const r = Math.min(img.width * 0.25, img.height * 0.5) * cfg.radiusScale * s;
      let sumL = 0, nL = 0, sumR = 0, nR = 0;
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          const idx = (y * sw + x) * 4;
          const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
          const dL2 = (x - cxL) * (x - cxL) + (y - cyL) * (y - cyL);
          const dR2 = (x - cxR) * (x - cxR) + (y - cyR) * (y - cyR);
          if (dL2 <= r * r) { sumL += lum; nL++; }
          if (dR2 <= r * r) { sumR += lum; nR++; }
        }
      }
      if (nL > 0 && nR > 0 && sumR > 0) {
        const g = (sumL / nL) / (sumR / nR);
        return Math.min(2.0, Math.max(0.5, g));
      }
    } catch (e) {
      console.warn('⚠️ gainR estimate failed:', e);
    }
    return 1.0;
  }

  function uploadTexture(img) {
    // New source: drop the size-keyed FBO/texture pools so a different image
    // doesn't accumulate several full-resolution RGBA8 surfaces per size.
    resetPools();
    renderTexture = null;
    framebuffer = null;
    // Recreate texture at correct size — texStorage2D allocates immutable storage
    // so we must re-create if dimensions change.
    if (currentTexture) gl.deleteTexture(currentTexture);
    currentTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, currentTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // Use texStorage2D for immutable allocation (faster driver path, no re-allocation)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, img.width, img.height);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, img);
    currentGainR = estimateGainR(img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    buildLFTexture();
    _stitchDirty = true;
    _fboValid = false;
    panoFullDirty = true; // full-res sphere texture must be rebuilt for the new source
    // A new source invalidates the cached watermarked full-res texture — its
    // pixels now belong to the previous image.
    if (panoWMTex) { gl.deleteTexture(panoWMTex); panoWMTex = null; }
    if (panoWMFbo) { gl.deleteFramebuffer(panoWMFbo); panoWMFbo = null; }
    if (panoFullTex) { gl.deleteTexture(panoFullTex); panoFullTex = null; }
    if (panoFullFbo) { gl.deleteFramebuffer(panoFullFbo); panoFullFbo = null; }
    panoFullW = 0; panoFullH = 0;
  }

  // VAO for the fullscreen quad — core in WebGL2, avoids re-binding every draw.
  let _quadVAO = null;
  function getQuadVAO() {
    if (!_quadVAO) {
      _quadVAO = gl.createVertexArray();
      gl.bindVertexArray(_quadVAO);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1,-1,  1,-1, -1,1,
        -1,1,   1,-1,  1,1
      ]), gl.STATIC_DRAW);
      // Location 0 for a_position (matches shader layout if specified, otherwise bound via attrib location)
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
    }
    return _quadVAO;
  }

  function stitchWebGL(srcW, srcH, panoW, panoH, renderTarget = null) {
    if (!glProgram) {
      glProgram = createProgram(gl, VS_SOURCE, FS_SOURCE);
      // Cache uniform locations once at program creation
      glProgram._u = {
        u_image:       gl.getUniformLocation(glProgram, 'u_image'),
        u_imageLF:     gl.getUniformLocation(glProgram, 'u_imageLF'),
        u_gainR:       gl.getUniformLocation(glProgram, 'u_gainR'),
        u_srcSize:     gl.getUniformLocation(glProgram, 'u_srcSize'),
        u_centersL:    gl.getUniformLocation(glProgram, 'u_centersL'),
        u_centersR:    gl.getUniformLocation(glProgram, 'u_centersR'),
        u_radius:      gl.getUniformLocation(glProgram, 'u_radius'),
        u_halfFov:     gl.getUniformLocation(glProgram, 'u_halfFov'),
        u_f:           gl.getUniformLocation(glProgram, 'u_f'),
        u_hfBandWidth: gl.getUniformLocation(glProgram, 'u_hfBandWidth'),
        u_axisL:       gl.getUniformLocation(glProgram, 'u_axisL'),
        u_upL:         gl.getUniformLocation(glProgram, 'u_upL'),
        u_rightL:      gl.getUniformLocation(glProgram, 'u_rightL'),
        u_axisR:       gl.getUniformLocation(glProgram, 'u_axisR'),
        u_upR:         gl.getUniformLocation(glProgram, 'u_upR'),
        u_rightR:      gl.getUniformLocation(glProgram, 'u_rightR'),
        u_stretchL:    gl.getUniformLocation(glProgram, 'u_stretchL'),
        u_stretchR:    gl.getUniformLocation(glProgram, 'u_stretchR'),
        u_diffMode:    gl.getUniformLocation(glProgram, 'u_diffMode'),
      };
    }
    gl.useProgram(glProgram);

    // Bind VAO once — includes quad vertex data
    gl.bindVertexArray(getQuadVAO());

    gl.bindFramebuffer(gl.FRAMEBUFFER, renderTarget ? framebuffer : null);

    // Bind textures to units
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, currentTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lfTex);

    const u = glProgram._u;
    gl.uniform1i(u.u_image, 0);
    gl.uniform1i(u.u_imageLF, 1);

    const gainR = currentGainR;
    const cxL = srcW * cfg.centers.left[0];
    const cxR = srcW * cfg.centers.right[0];
    const cyL = srcH * cfg.centers.left[1];
    const cyR = srcH * cfg.centers.right[1];
    const radius = Math.min(srcW * 0.25, srcH * 0.5) * cfg.radiusScale;
    const fovRad = (cfg.fovDeg * Math.PI) / 180.0;
    const halfFov = fovRad / 2.0;
    const f = radius / halfFov;

    const AXIS_R = [1,0,0], AXIS_L = [-1,0,0];
    const UP = [0,0,1], RIGHT = [0,1,0];
    function rotateAroundAxis(v, axis, ang) {
      const c = Math.cos(ang), s = Math.sin(ang);
      const [ax, ay, az] = axis;
      const dot = v[0] * ax + v[1] * ay + v[2] * az;
      return [
        v[0] * c + s * (ay * v[2] - az * v[1]) + (1 - c) * ax * dot,
        v[1] * c + s * (az * v[0] - ax * v[2]) + (1 - c) * ay * dot,
        v[2] * c + s * (ax * v[1] - ay * v[0]) + (1 - c) * az * dot
      ];
    }
    function lensBasis(isRight) {
      const AXIS = isRight ? AXIS_R : AXIS_L;
      let up = [...UP];
      let right = isRight ? [...RIGHT] : [0,-1,0];
      const totalRoll = (isRight ? cfg.rollDeg.right : cfg.rollDeg.left) * Math.PI / 180.0;
      if (totalRoll !== 0) {
        up = rotateAroundAxis(up, AXIS, totalRoll);
        right = rotateAroundAxis(right, AXIS, totalRoll);
      }
      return { AXIS, up, right };
    }
    const Rb = lensBasis(true), Lb = lensBasis(false);

    gl.uniform1f(u.u_gainR, gainR);
    gl.uniform2f(u.u_srcSize, srcW, srcH);
    gl.uniform2f(u.u_centersL, cxL, cyL);
    gl.uniform2f(u.u_centersR, cxR, cyR);
    gl.uniform1f(u.u_radius, radius);
    gl.uniform1f(u.u_halfFov, halfFov);
    gl.uniform1f(u.u_f, f);
    gl.uniform1f(u.u_hfBandWidth, cfg.blend.hfBandWidth);
    gl.uniform3fv(u.u_axisL, Lb.AXIS);
    gl.uniform3fv(u.u_upL, Lb.up);
    gl.uniform3fv(u.u_rightL, Lb.right);
    gl.uniform3fv(u.u_axisR, Rb.AXIS);
    gl.uniform3fv(u.u_upR, Rb.up);
    gl.uniform3fv(u.u_rightR, Rb.right);
    gl.uniform1f(u.u_stretchL, cfg.stretch.left);
    gl.uniform1f(u.u_stretchR, cfg.stretch.right);
    gl.uniform1i(u.u_diffMode, diffMode ? 1 : 0);

    gl.viewport(0, 0, panoW, panoH);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // ===========================================================================
  //  EXPORT & SPHERE VIEWER HELPERS
  // ===========================================================================

  // Scale source image by the user-selected factor (1-2x). Applied to ALL modes
  // at load time — single, HDR, and merge. No further scaling happens downstream.
  function scaleSource(img) {
    if (scaleValue <= 1) return img;
    // Use ONE uniform factor for both axes (derived from whichever dimension
    // would hit MAX_TEX_SIZE first), not two independent per-axis clamps —
    // clamping width and height separately can apply different effective scale
    // factors to each axis once either exceeds MAX_TEX_SIZE, stretching the
    // source non-uniformly and throwing off the circular fisheye geometry the
    // stitcher assumes.
    const factor = Math.min(scaleValue, MAX_TEX_SIZE / img.width, MAX_TEX_SIZE / img.height);
    const w = Math.round(img.width * factor);
    const h = Math.round(img.height * factor);
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const ctx = off.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    return off;
  }

  // Renders the full pipeline (stitch, then post-FX if enabled) entirely into an
  // off-screen, texture-backed framebuffer at the exact requested size (already
  // clamped to GPU limits by the caller) and reads the pixels back. Unlike
  // rendering to the visible <canvas>, this is governed only by
  // MAX_TEXTURE_SIZE / MAX_VIEWPORT_DIMS — NOT by the browser's on-screen
  // drawing-buffer size cap (see getSafeRenderSize for details). Full-resolution
  // export and the 3D viewer both go through this so HD (2x) output is never
  // silently cropped.
  function renderOffscreenPixels(panoW, panoH) {
    stitchIfNeeded(panoW, panoH);

    let srcTex, srcFbo = framebuffer; // raw stitched result, already off-screen
    if (postEnabled) {
      const pooled = getPooledPostFBO(panoW, panoH);
      renderWithPostProcessing(panoW, panoH, pooled.fbo);
      srcFbo = pooled.fbo;
      srcTex = pooled.tex;
    } else {
      srcTex = renderTexture;
    }

    let readFbo = srcFbo;
    if (wmLoaded && wmTex) {
      if (!wmFbo || wmFboW !== panoW || wmFboH !== panoH) {
        if (wmFbo) { gl.deleteTexture(wmFboTex); gl.deleteFramebuffer(wmFbo); }
        wmFboTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, wmFboTex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, panoW, panoH);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        wmFbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, wmFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, wmFboTex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        wmFboW = panoW; wmFboH = panoH;
      }
      compositeWatermark(srcTex, panoW, panoH, wmFbo);
      readFbo = wmFbo;
    }

    const buf = new Uint8Array(panoW * panoH * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, readFbo);
    gl.readPixels(0, 0, panoW, panoH, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return buf;
  }

  // Writes a bottom-left-origin RGBA pixel buffer (as returned by gl.readPixels)
  // into a 2D canvas, flipping rows so row 0 of the canvas is the top of the
  // image — matching the orientation the rest of the app expects.
  function rgbaBufferToCanvas(buf, w, h, outCanvas) {
    const canvas = outCanvas || document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const id = new ImageData(w, h);
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4;
      id.data.set(buf.subarray(src, src + w * 4), y * w * 4);
    }
    canvas.getContext('2d').putImageData(id, 0, 0);
    return canvas;
  }

  // Renders the panorama at the requested size into an offscreen canvas, fully
  // decoupled from the visible <canvas>. The requested size is clamped to the
  // GPU's max texture size; the output canvas is sized to the ACTUAL resolution
  // produced so the pixels and any embedded XMP dimensions always agree.
  function generateExportCanvas(targetWidth, targetHeight) {
    const { w, h } = clampToGpuLimits(targetWidth, targetHeight);
    const buf = renderOffscreenPixels(w, h);
    return rgbaBufferToCanvas(buf, w, h);
  }

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = ev => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = ev.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ---- Custom spherical WebGL viewer ----
  // Renders the stitched equirectangular canvas onto the inside of a view via a
  // fullscreen ray-march fragment shader. Updates are in-place (texture re-upload +
  // redraw), so there is no recreate, no flash, and the view is always full-res.

  const SPHERE_VS = `#version 300 es
    layout(location = 0) in vec2 a_pos;
    out vec2 v_ndc;
    void main() {
      v_ndc = a_pos;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

const SPHERE_FS = `#version 300 es
    precision highp float;
    in vec2 v_ndc;
    out vec4 fragColor;
    uniform sampler2D u_tex;
    uniform vec2 u_res;
    uniform float u_yaw;
    uniform float u_pitch;
    uniform float u_fov;
    uniform bool u_mirror;
    const float PI = 3.14159265358979323846;
    void main() {
      float aspect = u_res.x / max(u_res.y, 1.0);
      float t = tan(u_fov * 0.5);
      float cy = cos(u_yaw), sy = sin(u_yaw);
      float cp = cos(u_pitch), sp = sin(u_pitch);
      vec3 fwd = vec3(cp * sy, sp, cp * cy);
      vec3 worldUp = vec3(0.0, 1.0, 0.0);
      vec3 right = normalize(cross(fwd, worldUp));
      vec3 up = cross(right, fwd);
      vec3 ray = normalize(fwd + v_ndc.x * t * aspect * right + v_ndc.y * t * up);
      float lon = atan(ray.x, ray.z);
      float lat = asin(clamp(ray.y, -1.0, 1.0));
      float u = u_mirror ? (0.5 - lon / (2.0 * PI)) : (0.5 + lon / (2.0 * PI));
      float v = 0.5 + lat / PI;
      fragColor = texture(u_tex, vec2(u, v));
    }
  `;

  // ---- Main-context spherical renderer ----
  // Compiles the same equirect->sphere ray-march shader against the MAIN gl
  // context (instead of the sphere viewer's separate context) so the 3D view can
  // sample the stitched FBO texture directly — no readback / re-upload / CPU flip.
  // Wired in during Steps 2-3; added here as scaffolding.
  function getSphereProgram() {
    if (!sphereProgram) {
      sphereProgram = createProgram(gl, SPHERE_VS, SPHERE_FS);
      sphereProgram._u = {
        u_res:    gl.getUniformLocation(sphereProgram, 'u_res'),
        u_yaw:    gl.getUniformLocation(sphereProgram, 'u_yaw'),
        u_pitch:  gl.getUniformLocation(sphereProgram, 'u_pitch'),
        u_fov:    gl.getUniformLocation(sphereProgram, 'u_fov'),
        u_tex:    gl.getUniformLocation(sphereProgram, 'u_tex'),
        u_mirror: gl.getUniformLocation(sphereProgram, 'u_mirror'),
      };
    }
    return sphereProgram;
  }

  // Renders the sphere view into the MAIN canvas using the given equirect texture.
  // `opts`: { tex, yaw, pitch, fov, mirror }. Pure GPU path; no CPU readback.
  function renderSphereInline(opts) {
    getSphereProgram();
    const dpr = window.devicePixelRatio || 1;
    const dw = Math.max(1, Math.round(panoramaCanvas.clientWidth * dpr));
    const dh = Math.max(1, Math.round(panoramaCanvas.clientHeight * dpr));
    if (panoramaCanvas.width !== dw || panoramaCanvas.height !== dh) {
      panoramaCanvas.width = dw;
      panoramaCanvas.height = dh;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, panoramaCanvas.width, panoramaCanvas.height);
    gl.useProgram(sphereProgram);
    const u = sphereProgram._u;
    gl.uniform2f(u.u_res, panoramaCanvas.width, panoramaCanvas.height);
    gl.uniform1f(u.u_yaw, opts.yaw || 0);
    gl.uniform1f(u.u_pitch, opts.pitch || 0);
    gl.uniform1f(u.u_fov, opts.fov != null ? opts.fov : Math.PI / 2);
    gl.uniform1i(u.u_mirror, opts.mirror ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, opts.tex);
    gl.uniform1i(u.u_tex, 0);
    gl.bindVertexArray(getQuadVAO());
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // ---- Watermark (nadir decal) compositing ----
  // Composites a watermark image onto the BOTTOM (nadir) of an equirectangular
  // texture using a tangent-plane projection, so the decal is a flat, undistorted
  // disc at the south pole rather than pinched like a rectangle pasted on the
  // equirect's bottom row. Runs entirely on the GPU in the main context; used by
  // both the 3D viewer texture and the export path.
  const WM_VS = `#version 300 es
    layout(location = 0) in vec2 a_position;
    out vec2 v_uv;
    void main() { v_uv = a_position * 0.5 + 0.5; gl_Position = vec4(a_position, 0.0, 1.0); }
  `;

  const WM_FS = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 fragColor;
    uniform sampler2D u_src;
    uniform sampler2D u_wm;
    uniform float u_size;
    uniform float u_alpha;
    uniform float u_rot;
    const float PI = 3.14159265358979323846;
    void main() {
      vec4 base = texture(u_src, v_uv);
      float lon = (v_uv.x - 0.5) * 2.0 * PI;
      float lat = (v_uv.y - 0.5) * PI;
      float cl = cos(lat);
      vec3 dir = vec3(cl * sin(lon), sin(lat), cl * cos(lon));
      if (dir.y < -0.001) {
        vec2 local = vec2(-dir.x / dir.y, -dir.z / dir.y);
        float c = cos(u_rot), s = sin(u_rot);
        local = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
        if (dot(local, local) < u_size * u_size) {
          vec2 wuv = local / (2.0 * u_size) + 0.5;
          if (wuv.x >= 0.0 && wuv.x <= 1.0 && wuv.y >= 0.0 && wuv.y <= 1.0) {
            vec4 wm = texture(u_wm, wuv);
            float a = wm.a * u_alpha;
            fragColor = vec4(mix(base.rgb, wm.rgb, a), base.a);
            return;
          }
        }
      }
      fragColor = base;
    }
  `;

  function getWatermarkProgram() {
    if (!wmProgram) {
      wmProgram = createProgram(gl, WM_VS, WM_FS);
      wmProgram._u = {
        u_src:   gl.getUniformLocation(wmProgram, 'u_src'),
        u_wm:    gl.getUniformLocation(wmProgram, 'u_wm'),
        u_size:  gl.getUniformLocation(wmProgram, 'u_size'),
        u_alpha: gl.getUniformLocation(wmProgram, 'u_alpha'),
        u_rot:   gl.getUniformLocation(wmProgram, 'u_rot'),
      };
    }
    return wmProgram;
  }

  // Bakes the watermark decal from srcTex (equirect) into targetFbo.
  function compositeWatermark(srcTex, w, h, targetFbo) {
    getWatermarkProgram();
    gl.useProgram(wmProgram);
    gl.bindVertexArray(getQuadVAO());
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(wmProgram._u.u_src, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, wmTex);
    gl.uniform1i(wmProgram._u.u_wm, 1);
    gl.uniform1f(wmProgram._u.u_size, wmSize);
    gl.uniform1f(wmProgram._u.u_alpha, wmAlpha);
    gl.uniform1f(wmProgram._u.u_rot, wmRotDeg * Math.PI / 180.0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Single-context sphere viewer: the sphere is drawn into the MAIN panoramaCanvas
  // using the main gl context (see renderSphereInline / getSphereProgram). No
  // separate WebGL context, canvas, or texture upload is needed — the stitched
  // FBO texture is sampled directly.
  function initSphereViewer() {
    const s = { yaw: 0, pitch: 0, fov: Math.PI / 2 };

    let dragging = false, lx = 0, ly = 0;
    const onDown = (x, y) => { dragging = true; lx = x; ly = y; panoramaCanvas.style.cursor = 'grabbing'; };
    const onMove = (x, y) => {
      if (!dragging || viewMode !== '3d') return;
      const dx = x - lx, dy = y - ly;
      lx = x; ly = y;
      const k = s.fov / Math.max(1, panoramaCanvas.clientHeight);
      // Grab-style panning: dragging right pulls the panorama right (scene
      // follows the cursor), matching the vertical drag behaviour.
      s.yaw += dx * k;
      s.pitch = Math.max(-1.4, Math.min(1.4, s.pitch + dy * k));
      renderSphere();
    };
    const onUp = () => { dragging = false; panoramaCanvas.style.cursor = 'grab'; };

    panoramaCanvas.addEventListener('mousedown', e => onDown(e.clientX, e.clientY));
    window.addEventListener('mousemove', e => onMove(e.clientX, e.clientY));
    window.addEventListener('mouseup', onUp);
    panoramaCanvas.addEventListener('wheel', e => {
      e.preventDefault();
      s.fov *= (1 + Math.sign(e.deltaY) * 0.1);
      s.fov = Math.max(0.35, Math.min(2.2, s.fov));
      renderSphere();
    }, { passive: false });
    panoramaCanvas.addEventListener('touchstart', e => {
      if (e.touches.length === 1) onDown(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    panoramaCanvas.addEventListener('touchmove', e => {
      if (e.touches.length === 1) onMove(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    panoramaCanvas.addEventListener('touchend', onUp);

    return s;
  }

  function renderSphere() {
    if (!sphere || viewMode !== '3d') return;
    const tex = getSphereSourceTexture();
    if (!tex) return;
    renderSphereInline({ tex, yaw: sphere.yaw, pitch: sphere.pitch, fov: sphere.fov, mirror: cfg.mirror3D });
  }

  // Builds the full-resolution, post-processed equirect entirely on the GPU in the
  // main context (no readback, no CPU flip, no re-upload). The result lives in
  // panoFullTex/panoFullFbo and is sampled directly by the 3D viewer.
  function buildFullResPano() {
    if (!currentImg) return;
    const fullW0 = Math.min(currentImg.width, MAX_TEX_SIZE);
    const fullH0 = Math.round(fullW0 / 2);
    const { w, h } = clampToGpuLimits(fullW0, fullH0);

    if (postEnabled && (!panoFullTex || panoFullW !== w || panoFullH !== h)) {
      if (panoFullTex) { gl.deleteTexture(panoFullTex); gl.deleteFramebuffer(panoFullFbo); }
      panoFullTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, panoFullTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      panoFullFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, panoFullFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, panoFullTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      panoFullW = w; panoFullH = h;
    }

    // Ensure the shared stitch FBO is at full resolution.
    stitchIfNeeded(w, h);

    if (postEnabled) renderWithPostProcessing(w, h, panoFullFbo);

    if (wmLoaded && wmTex) {
      if (!panoWMTex || panoFullW !== w || panoFullH !== h) {
        if (panoWMTex) { gl.deleteTexture(panoWMTex); gl.deleteFramebuffer(panoWMFbo); }
        panoWMTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, panoWMTex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        panoWMFbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, panoWMFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, panoWMTex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      const srcTex = postEnabled ? panoFullTex : renderTexture;
      compositeWatermark(srcTex, w, h, panoWMFbo);
    }

    panoFullW = w; panoFullH = h;
    panoFullDirty = false;
  }

  // Step 3: the 3D view samples the full-resolution, post-processed texture built
  // on the GPU. While it's being rebuilt (e.g. mid-drag) the fresher (pre-post)
  // stitch FBO is used so interaction stays responsive.
  function getSphereSourceTexture() {
    if (panoFullDirty) return renderTexture;
    if (wmLoaded && panoWMTex) return panoWMTex;
    if (postEnabled && panoFullTex) return panoFullTex;
    return renderTexture;
  }

  // Rebuilds the full-res post-processed texture once interaction settles.
  function refreshSphereFromTexture() {
    buildFullResPano();
    renderSphere();
  }

  function scheduleSphereFullResRefresh() {
    if (viewMode !== '3d' || !sphere || !currentImg) return;
    if (sphereFullTimer) clearTimeout(sphereFullTimer);
    sphereFullTimer = setTimeout(() => {
      sphereFullTimer = null;
      refreshSphereFromTexture();
    }, 350);
  }

  function scheduleViewerUpdate() {
    if (viewMode !== '3d' || !sphere || !currentImg) return;
    if (sphereRaf) return;
    sphereRaf = requestAnimationFrame(() => {
      sphereRaf = null;
      renderSphere();
    });
    scheduleSphereFullResRefresh();
  }

  function setViewMode(mode) {
    viewMode = mode;
    if (mode === '3d') {
      if (!currentImg) {
        alert('Please load an image first.');
        viewMode = '2d';
        return;
      }
      if (viewerContainer) viewerContainer.classList.add('hidden');
      panoramaCanvas.classList.add('viewer-3d');
      panoramaCanvas.style.cursor = 'grab';
      if (!sphere) sphere = initSphereViewer();
      panoFullDirty = true;
      refreshSphereFromTexture();
      if (viewModeBtn) viewModeBtn.textContent = '2D';
    } else {
      if (viewerContainer) viewerContainer.classList.add('hidden');
      panoramaCanvas.classList.remove('viewer-3d');
      panoramaCanvas.style.cursor = '';
      if (viewModeBtn) viewModeBtn.textContent = '3D';
      renderPano(); // redraw the equirect onto the canvas
    }
  }

  function injectXMPMetadata(blob, width, height) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = function(e) {
        const uint8Array = new Uint8Array(e.target.result);
        if (uint8Array[0] !== 0xFF || uint8Array[1] !== 0xD8) {
          return reject(new Error('File is not a valid JPEG.'));
        }

        const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:GPano="http://ns.google.com/photos/1.0/panorama/">
      <GPano:UsePanoramaViewer>True</GPano:UsePanoramaViewer>
      <GPano:ProjectionType>equirectangular</GPano:ProjectionType>
      <GPano:CroppedAreaLeftPixels>0</GPano:CroppedAreaLeftPixels>
      <GPano:CroppedAreaTopPixels>0</GPano:CroppedAreaTopPixels>
      <GPano:CroppedAreaImageWidthPixels>${width}</GPano:CroppedAreaImageWidthPixels>
      <GPano:CroppedAreaImageHeightPixels>${height}</GPano:CroppedAreaImageHeightPixels>
      <GPano:FullPanoWidthPixels>${width}</GPano:FullPanoWidthPixels>
      <GPano:FullPanoHeightPixels>${height}</GPano:FullPanoHeightPixels>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

        const xmpBytes = new TextEncoder().encode(xmp);
        const xmpHeader = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0');
        
        const totalLen = 2 + xmpHeader.length + xmpBytes.length;
        const marker = new Uint8Array([0xFF, 0xE1, (totalLen >> 8) & 0xFF, totalLen & 0xFF]);

        const combined = new Uint8Array(marker.length + xmpHeader.length + xmpBytes.length);
        combined.set(marker, 0);
        combined.set(xmpHeader, marker.length);
        combined.set(xmpBytes, marker.length + xmpHeader.length);

        // Insert XMP as APP1 immediately after SOI (standard, robust placement).
        // This avoids fragile scanning for the "right" insertion point and works
        // with any JPEG marker ordering.
        let insertOffset = 2;

        const newData = new Uint8Array(uint8Array.length + combined.length);
        newData.set(uint8Array.subarray(0, insertOffset), 0);
        newData.set(combined, insertOffset);
        newData.set(uint8Array.subarray(insertOffset), insertOffset + combined.length);

        resolve(new Blob([newData], { type: 'image/jpeg' }));
      };

      reader.onerror = reject;
      reader.readAsArrayBuffer(blob);
    });
  }

  // Export at source resolution (which is already scaled by scaleSource if X2 is on).
  // Renders to an offscreen canvas at full resolution and saves it. The exported
  // dimensions reported to XMP are the ACTUAL pixels produced (see generateExportCanvas).
  async function renderFullAndExport(mime, quality, injectXMP = false) {
    const fullW = currentImg.width;
    const fullH = Math.round(fullW / 2);

    const exportCanvas = generateExportCanvas(fullW, fullH);
    const actualW = exportCanvas.width;
    const actualH = exportCanvas.height;

    const blob = await new Promise((resolve, reject) => {
      exportCanvas.toBlob(b => b ? resolve(b) : reject(new Error('Export failed')), mime, quality);
    });

    if (injectXMP && mime === 'image/jpeg') {
      return { blob: await injectXMPMetadata(blob, actualW, actualH), actualW, actualH };
    }
    return { blob, actualW, actualH };
  }

  async function onDownloadPng() {
    try {
      if (downloadBtn) downloadBtn.disabled = true;
      if (downloadJpgBtn) downloadJpgBtn.disabled = true;
      const { blob } = await renderFullAndExport('image/png', 0.92);
      triggerDownload(blob, `${lastBaseName}-stitched.png`);
    } catch (err) {
      console.error(err);
      alert('Download failed: ' + (err?.message || err));
    } finally {
      if (downloadBtn) downloadBtn.disabled = false;
      if (downloadJpgBtn) downloadJpgBtn.disabled = false;
    }
  }

  async function onDownloadJpg() {
    try {
      if (downloadBtn) downloadBtn.disabled = true;
      if (downloadJpgBtn) downloadJpgBtn.disabled = true;
      const { blob } = await renderFullAndExport('image/jpeg', 0.95, true);
      triggerDownload(blob, `${lastBaseName}-stitched.jpg`);
    } catch (err) {
      console.error(err);
      alert('Download failed: ' + (err?.message || err));
    } finally {
      if (downloadBtn) downloadBtn.disabled = false;
      if (downloadJpgBtn) downloadJpgBtn.disabled = false;
    }
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.body.appendChild(document.createElement('a'));
    a.href = url;
    a.download = filename;
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ===========================================================================
  // MULTI-FRAME STACKING ENGINE (NOISE REDUCTION & HDR MERGING)
  // ===========================================================================

  // NOTE: Input images are already scaled by scaleSource() before reaching
  // these functions. No additional scaling is done here — we just blend.

  async function processAndBlendFiles(fileList) {
    if (!fileList || fileList.length === 0) return;

    const totalFiles = fileList.length;
    
    // Load all images and scale them
    const images = [];
    for (let i = 0; i < totalFiles; i++) {
      setLoading(true, `Loading frame ${i + 1} of ${totalFiles}...`);
      await new Promise(requestAnimationFrame);
      let img = await loadImageFromFile(fileList[i]);
      img = scaleSource(img); // 2x upscale if X2 is on
      images.push(img);
    }

    const refImg = images[0];
    const w = refImg.width;
    const h = refImg.height;

    // Average all frames at their (already-scaled) resolution
    const outCanvas = document.createElement('canvas');
    outCanvas.width = w;
    outCanvas.height = h;
    const octx = outCanvas.getContext('2d');
    octx.fillStyle = '#000000';
    octx.fillRect(0, 0, w, h);
    octx.globalCompositeOperation = 'lighter';

    for (let i = 0; i < totalFiles; i++) {
      setLoading(true, `Blending frame ${i + 1} of ${totalFiles}...`);
      await new Promise(requestAnimationFrame);
      octx.globalAlpha = 1.0 / totalFiles;
      octx.drawImage(images[i], 0, 0, w, h);
    }
    
    octx.globalAlpha = 1.0;
    octx.globalCompositeOperation = 'source-over';
    return outCanvas;
  }

  // Builds the exposure-fusion program once. A single fragment shader samples
  // every frame texture, applies the well-exposedness bell weight, and accumulates
  // — the entire fusion runs on the GPU instead of a per-pixel CPU loop.
  // The loop is unrolled with constant sampler indices because some WebGL2
  // drivers forbid dynamically-indexed sampler arrays.
  function createHdrFuseProgram() {
    const vs = `#version 300 es
      layout(location = 0) in vec2 a_position;
      out vec2 v_uv;
      void main() { v_uv = a_position * 0.5 + 0.5; gl_Position = vec4(a_position, 0.0, 1.0); }`;

    let body = '';
    for (let i = 0; i < MAX_HDR_FRAMES; i++) {
      body += `
      if (${i} < u_count) {
        vec3 c${i} = texture(u_frames[${i}], uv).rgb;
        float lum${i} = dot(c${i}, vec3(0.299, 0.587, 0.114));
        float d${i} = lum${i} - u_center;
        float w${i} = u_base + (1.0 - u_base) * exp(-d${i} * d${i} * inv2Sig2);
        acc += c${i} * w${i};
        wsum += w${i};
      }`;
    }

    const fs = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      out vec4 fragColor;
      uniform sampler2D u_frames[${MAX_HDR_FRAMES}];
      uniform int u_count;
      uniform float u_sigma;
      uniform float u_center;
      uniform float u_base;
      void main() {
        float inv2Sig2 = 1.0 / (2.0 * u_sigma * u_sigma);
        vec3 acc = vec3(0.0);
        float wsum = 0.0;
        // Sample with a flipped V so the fused output keeps the source's top-row
        // orientation, matching what uploadTexture expects upstream.
        vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
        ${body}
        acc /= max(wsum, 1e-6);
        fragColor = vec4(clamp(acc, 0.0, 1.0), 1.0);
      }`;

    return createProgram(gl, vs, fs);
  }

  async function processAndMergeHDR(fileList) {
    if (!fileList || fileList.length === 0) return;

    const totalFiles = fileList.length;
    if (totalFiles > MAX_HDR_FRAMES) {
      alert(`HDR merge supports up to ${MAX_HDR_FRAMES} frames; ${totalFiles} were selected.`);
      return;
    }

    // Load + scale every frame (same pipeline as a single load).
    const images = [];
    for (let i = 0; i < totalFiles; i++) {
      setLoading(true, `Loading HDR frame ${i + 1} of ${totalFiles}...`);
      await new Promise(requestAnimationFrame);
      let img = await loadImageFromFile(fileList[i]);
      img = scaleSource(img); // 2x upscale if X2 is on
      images.push(img);
    }

    const w = images[0].width;
    const h = images[0].height;

    // Upload each frame as a GL texture (sampled by normalised UV, so equally
    // sized bracketed exposures stay pixel-aligned).
    const frameTex = [];
    for (let i = 0; i < totalFiles; i++) {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, images[i]);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      frameTex.push(t);
    }

    if (!hdrFuseProgram) hdrFuseProgram = createHdrFuseProgram();
    gl.useProgram(hdrFuseProgram);
    gl.bindVertexArray(getQuadVAO());

    for (let i = 0; i < totalFiles; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, frameTex[i]);
      gl.uniform1i(gl.getUniformLocation(hdrFuseProgram, `u_frames[${i}]`), i);
    }
    gl.uniform1i(gl.getUniformLocation(hdrFuseProgram, 'u_count'), totalFiles);
    gl.uniform1f(gl.getUniformLocation(hdrFuseProgram, 'u_sigma'), cfg.hdr.sigma);
    gl.uniform1f(gl.getUniformLocation(hdrFuseProgram, 'u_center'), cfg.hdr.bellCenter);
    gl.uniform1f(gl.getUniformLocation(hdrFuseProgram, 'u_base'), cfg.hdr.base);

    // Render the fusion into an offscreen RGBA8 target at the source resolution.
    const outTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + totalFiles);
    gl.bindTexture(gl.TEXTURE_2D, outTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex, 0);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Read back and flip rows (GL framebuffer origin is bottom-left) so the canvas
    // keeps the source's top-row-first orientation.
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    for (let i = 0; i < totalFiles; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.deleteTexture(frameTex[i]);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(outTex);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = w;
    outCanvas.height = h;
    const id = new ImageData(w, h);
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4;
      id.data.set(buf.subarray(src, src + w * 4), y * w * 4);
    }
    outCanvas.getContext('2d').putImageData(id, 0, 0);
    return outCanvas;
  }

  // ===========================================================================
  // TOOLBAR ACTION BINDINGS
  // ===========================================================================

  const chooseBtn = document.getElementById('chooseBtn');
  if (chooseBtn && imageLoader) {
    chooseBtn.addEventListener('click', () => imageLoader.click());
  }

  const blendBtn = document.getElementById('blendBtn');
  const blendImageLoader = document.getElementById('blendImageLoader');

  if (blendBtn && blendImageLoader) {
    blendBtn.addEventListener('click', () => blendImageLoader.click());

    blendImageLoader.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length < 2) {
        if (files.length === 1) alert('Please select 2 or more files to perform multi-frame blending.');
        return;
      }

      setActionsVisible(false);

      try {
        lastBaseName = `${files[0].name.replace(/\.[^.]+$/, '')}_blended_${files.length}x`;
        setLoading(true, 'Blending images for noise reduction...');
        const blendedCanvas = await processAndBlendFiles(files);

        currentImg = blendedCanvas;
        uploadTexture(blendedCanvas);

        await new Promise(requestAnimationFrame);
        renderPano();
        setActionsVisible(true);
      } catch (err) {
        console.error('Stacking Error:', err);
        alert('Multi-frame blending failed: ' + (err?.message || err));
      } finally {
        setLoading(false);
        blendImageLoader.value = '';
      }
    });
  }

  const hdrBtn = document.getElementById('hdrBtn');
  const hdrImageLoader = document.getElementById('hdrImageLoader');

  if (hdrBtn && hdrImageLoader) {
    hdrBtn.addEventListener('click', () => hdrImageLoader.click());

    hdrImageLoader.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length < 2) {
        if (files.length === 1) alert('Please select 2 or more exposure files to perform HDR merging.');
        return;
      }

      setActionsVisible(false);

      try {
        lastBaseName = `${files[0].name.replace(/\.[^.]+$/, '')}_hdr_${files.length}x`;
        setLoading(true, 'Merging HDR exposures...');
        const hdrCanvas = await processAndMergeHDR(files);

        currentImg = hdrCanvas;
        uploadTexture(hdrCanvas);

        await new Promise(requestAnimationFrame);
        renderPano();
        setActionsVisible(true);
      } catch (err) {
        console.error('HDR Merge Error:', err);
        alert('HDR merging failed: ' + (err?.message || err));
      } finally {
        setLoading(false);
        hdrImageLoader.value = '';
      }
    });
  }
});