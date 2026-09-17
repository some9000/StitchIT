/**
 * StitchIT: WebGL2 dual-fisheye -> equirectangular stitcher
 * Features: frequency-split seam blending, real-time post-processing,
 * full-resolution export with XMP metadata, interactive 3D spherical viewer,
 * native-resolution exposure fusion.
 */
'use strict';
const S360 = window.S360 || {};
const { getQuadVAO, getPooledFBO, resetPools } = S360;
const { clampToGpuLimits, getSafeRenderSize, injectXMPMetadata, renderFullAndExport } = S360;
const { compositeWatermark, getWatermarkProgram } = S360;
const { LANCZOS_VS, LANCZOS_H_FS, LANCZOS_V_FS, LITTLE_PLANET_VS, LITTLE_PLANET_FS } = S360;
const { loadImageFromFile, estimateGainR, estimateGainRFromSource, scaleSource, processAndBlendFiles, resolveAnalysisSource } = S360;

document.addEventListener('DOMContentLoaded', () => {
  const panoramaCanvas  = document.getElementById('panoramaCanvas');

  if (!panoramaCanvas) {
    console.error('❌ Canvas element #panoramaCanvas missing from DOM.');
    return;
  }

  const gl = panoramaCanvas.getContext('webgl2', { antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });

  if (!gl) {
    S360.uiChrome.showToast('WebGL2 is required but not supported in this browser.', { type: 'error', persistent: true });
    return;
  }

  const MAX_TEX_SIZE = gl.getParameter(gl.MAX_TEXTURE_SIZE);

  // ---- WebGL program cache ----
  S360.progs.init(gl);

  // ---- GPU memory budget ----
  if (S360.gpuMem) {
    S360.gpuMem.init(gl);
    S360.gpuMem.onShed((gl, needed) => _shedNonEssentials(gl, needed));
    S360.gpuMem.onWarn(msg => console.warn('⚠️ ' + msg));
  }

  function handleContextLost(e) {
    e.preventDefault();
    if (gainEstimateTimer) { clearTimeout(gainEstimateTimer); gainEstimateTimer = null; }
    gainEstimateGeneration++;
    S360.loaders.cancelAllJobs();
    S360.stitchDecal.decals.bottom.clearForContextLoss();
    S360.stitchDecal.decals.top.clearForContextLoss();
    resetPools(gl); // Drop dead wrappers while the context is still lost.
    renderScheduler.cancel();
    stopGpuWatchdog();
    S360.stitchSeam.clearForContextLoss();
    S360.invalidateViewerResources();
    console.warn('⚠️ WebGL context lost, will attempt recovery...');
    S360.uiChrome.setLoading(true, 'WebGL context lost - attempting recovery...');
  }
  function handleContextRestored() {
    gl.getError(); // Consume the context-loss notification before validating new work.
    _renderFence = null;
    startGpuWatchdog();
    currentTexture = null;
    renderTexture = null;
    framebuffer = null;
    lfTex = null;
    sourceResource = null;
    S360.progs.invalidateAll();
    S360.lpModal.invalidateProgram();
    S360.invalidateViewerResources();
    compositor.invalidate();
    if (S360.gpuMem) S360.gpuMem.reset();
    S360.invalidateSharedVAO();
    S360.invalidateWatermarkPrograms();
    S360.invalidateBlurCache();
    S360.invalidateExposureFusionPrograms(gl);
    S360.invalidateGpuImagePrograms();
    S360.invalidateLanczosPrograms();
    S360.stitchDecal.decals.bottom.clearForContextLoss();
    S360.stitchDecal.decals.top.clearForContextLoss();
    S360.stitchSeam.clearForContextLoss();
    releaseSchematicBg();
    S360.stitchDecal.restoreWmProg();
    resetPools(gl);
    if (currentImg?.isGpuImage && currentImg.consumed) {
      currentImg = null;
      S360.uiChrome.setActionsVisible(false);
      S360.uiChrome.showToast('The GPU connection was lost. Please reload or re-merge your source images.', { type: 'error', persistent: true });
    } else if (currentImg) {
      uploadTexture(currentImg, true);
      renderPano();
    }
    S360.uiChrome.setLoading(false);
  }
  panoramaCanvas.addEventListener('webglcontextlost', handleContextLost, false);
  panoramaCanvas.addEventListener('webglcontextrestored', handleContextRestored, false);

  // GPU watchdog — polls the pending render fence so a hung GPU can force a
  // context loss and recovery. Stopped on context loss, restarted on restore.
  let _gpuWatchdogInterval = null;
  function stopGpuWatchdog() {
    if (_gpuWatchdogInterval) { clearInterval(_gpuWatchdogInterval); _gpuWatchdogInterval = null; }
  }
  function startGpuWatchdog() {
    if (typeof gl.fenceSync !== 'function') return;
    stopGpuWatchdog();
    _gpuWatchdogInterval = setInterval(() => {
      if (gl.isContextLost() || !_renderFence) return;
      const wait = gl.clientWaitSync(_renderFence, gl.SYNC_FLUSH_COMMANDS_BIT, 0);
      if (wait === gl.CONDITION_SATISFIED || wait === gl.ALREADY_SIGNALED) {
        gl.deleteSync(_renderFence);
        _renderFence = null;
      } else if (performance.now() - _renderStartTime > GPU_SPIN_THRESHOLD_MS) {
        console.warn(`⚠️ GPU blocked for >${GPU_SPIN_THRESHOLD_MS}ms — forcing context loss for recovery`);
        _renderFence = null;
        const ext = gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      }
    }, 2000);
  }
  startGpuWatchdog();

  // DOM refs still needed here. stitch-ui.js, settings.js, schematic.js, and
  // stitch-decal.js each fetch and wire their own controls.
  const viewModeBtn     = document.getElementById('viewModeBtn');
  const schematicBtn    = document.getElementById('schematicBtn');
  const viewerContainer = document.getElementById('panoramaViewerContainer');

  let lastBaseName = 'panorama';
  let currentImg = null;
  let currentTexture = null;
  let currentGainR = { gain: [1, 1, 1] };
  let gainEstimateTimer = null;
  let gainEstimateGeneration = 0;
  let _gainCache = null;
  let _gainCacheKey = null;
  let showSeam = false;
  let isStitched = false;
  let sphereInteractionEnabled = true;
  let postEnabled = true;

  function estimateCurrentGain() {
    if (!currentImg) return { gain: [1, 1, 1] };
    const c = cfg;
    // Gain samples depend on the complete lens mapping, not only the lens
    // centres and capture circles. Keep every geometry input in the cache key
    // so alignment, lens-shape, roll, or horizon changes cannot reuse a gain
    // measured against stale source pixels.
    const key = [
      `${currentImg.width}x${currentImg.height}`,
      c.centers.left[0], c.centers.left[1], c.centers.right[0], c.centers.right[1],
      c.radius, c.outerMargin,
      c.width.left, c.width.right, c.height.left, c.height.right,
      c.angle.left, c.angle.right,
      c.rollDeg.left, c.rollDeg.right,
      c.horizon?.pitch || 0, c.horizon?.roll || 0,
    ].join(':');
    if (key === _gainCacheKey) return _gainCache;
    _gainCache = estimateGainRFromSource(gl, resolveAnalysisSource(currentImg, currentTexture), cfg);
    _gainCacheKey = key;
    return _gainCache;
  }

  function scheduleGainEstimate() {
    if (!currentImg) return;
    if (gainEstimateTimer) clearTimeout(gainEstimateTimer);
    const generation = ++gainEstimateGeneration;
    gainEstimateTimer = setTimeout(() => {
      gainEstimateTimer = null;
      if (generation !== gainEstimateGeneration || gl.isContextLost() || !currentImg) return;
      currentGainR = estimateCurrentGain();
      markStitchDirty();
      scheduleRender();
    }, 160);
  }

  const DEFAULT_POST = Object.freeze({
    temperature: 6500,
    exposure: 1,
    gamma: 1,
    sharpen: 0.20,
    clarity: 0,
    saturation: 1,
    contrast: 1,
  });
  let postUniforms = { ...DEFAULT_POST };

  let framebuffer = null;
  let renderTexture = null;
  let _boundFbo = null;

  let lfTex = null;
  let sourceResource = null;

  // Cached lens basis for stitchWebGL (perf optimization)
  let _cachedRollL = null, _cachedRollR = null, _cachedHorizonPitch = null,
    _cachedHorizonRoll = null, _cachedLb = null, _cachedRb = null;


  S360.stitchDecal.init({
    gl,
    getViewMode: () => viewMode,
    refreshView: () => S360.renderSphere(ctx),
    scheduleRender,
    scheduleLiveSave: () => S360.settings.scheduleLiveSave(ctx),
  });
  let viewMode = '2d';
  let scaleValue = 1;
  let schematicMode = false;
  let schematicGuideX = -1.0;
  let schematicGuideY = -1.0;
  let wbSampling = false;

  let _stitchDirty = true;
  let _fboValid = false;
  let _stitchVariant = null, _renderRevision = 0;

  const PROGRESSIVE_COARSE_DIV = 4;

  let _renderFence = null;
  let _renderStartTime = 0;
  const GPU_SPIN_THRESHOLD_MS = 8000;

  // Preview size limit for 2D view
  const PREVIEW_MAX_W = 4096;

  const ctx = {
    gl, panoramaCanvas, MAX_TEX_SIZE,
    getCurrentImg: () => currentImg,
    getLastBaseName: () => lastBaseName,
    setLastBaseName: (v) => { lastBaseName = v; },
    setStitched: (v) => { isStitched = v; },
    getStitched: () => isStitched,
    getCfg: () => cfg,
    getMirror3D: () => cfg.mirror3D,
    getRenderTexture: () => renderTexture,
    getPanoramaCanvas: () => panoramaCanvas,
    setSphereInteractionEnabled: (enabled) => { sphereInteractionEnabled = enabled; },
    getSphereInteractionEnabled: () => sphereInteractionEnabled,
    getGL: () => gl,
    getFramebuffer: () => framebuffer,
    getPostEnabled: () => postEnabled,
    getViewMode: () => viewMode,
    setViewModeValue: (v) => { viewMode = v; },
    getViewModeBtn: () => viewModeBtn,
    getViewerContainer: () => viewerContainer,
    getScaleValue: () => scaleValue,
    setScaleValue: (v) => { scaleValue = v; },
    setPostEnabled: (v) => { postEnabled = v; },
    getSchematicMode: () => schematicMode,
    setSchematicMode: (v) => { schematicMode = v; },
    getWbSampling: () => wbSampling,
    setWbSampling: (v) => { wbSampling = v; },
    disableSchematic: () => {
      schematicMode = false;
      if (schematicBtn) schematicBtn.classList.remove('active');
      S360.schematic.updateCanvasCursor();
    },
    updateCanvasCursor: () => S360.schematic.updateCanvasCursor(),
    renderPano,
    stitchIfNeeded,
    markStitchDirty,
    get cfg() { return cfg; },
    get postUniforms() { return postUniforms; },
    get DEFAULT_CFG() { return DEFAULT_CFG; },
    get DEFAULT_POST() { return DEFAULT_POST; },
    get sliderMap() { return sliderMap; },
    get LIVE_KEY() { return LIVE_KEY; },
    get SNAPSHOT_KEY() { return SNAPSHOT_KEY; },
    get EXPOSURE_FUSION_SNAPSHOT_KEY() { return EXPOSURE_FUSION_SNAPSHOT_KEY; },
    get PROC_SNAPSHOT_KEY() { return PROC_SNAPSHOT_KEY; },
    get WM_SNAPSHOT_KEY() { return WM_SNAPSHOT_KEY; },
  };

  S360.getTextureRevision = (tex) => _texRevisions.get(tex) || 0;

  const drawLensSchematic = (t) => S360.schematic.drawLensSchematic(t);
  const releaseSchematicBg = () => S360.schematic.releaseSchematicBg();
  const invalidateSchematicBgCache = () => S360.schematic.invalidateSchematicBgCache();

  function readWbSampleAt(nx, ny) {
    const ps = computePreviewSize();
    const safe = getSafeRenderSize(gl, panoramaCanvas, ps.w, ps.h);
    stitchIfNeeded(safe.w, safe.h, true);
    const fw = renderTexture.width, fh = renderTexture.height;
    if (viewMode === '3d') {
      const uv = S360.viewer.getPanoramaUvAt(nx, ny);
      if (!uv) return null;
      nx = uv.u;
      ny = uv.v;
    }

    const R = 8; // sample radius in pixels
    const bw = 2 * R + 1, bh = 2 * R + 1;
    // Keep the whole read window inside the framebuffer: clamping just the
    // centre lets a click near an edge read with a negative origin (or past
    // the far edge), which some GPUs reject or fill with garbage. Tiny previews
    // fall back to reading the visible area — applyWbFromSample averages
    // whatever-sized buffer it receives.
    const w = Math.min(bw, fw), h = Math.min(bh, fh);
    const loX = fw >= bw ? R : 0, hiX = fw - w + loX;
    const loY = fh >= bh ? R : 0, hiY = fh - h + loY;
    const px = Math.max(loX, Math.min(hiX, Math.round(nx * fw)));
    const py = Math.max(loY, Math.min(hiY, Math.round((viewMode === '3d' ? ny : 1 - ny) * fh)));
    const buf = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.readPixels(px - loX, py - loY, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return buf;
  }

  // Reads a stable equirectangular patch from the retained stitch target. The
  // browser may discard the visible default framebuffer after compositing, so
  // analysis tools must not sample panoramaCanvas directly.
  function readFocusRegionAt(nx, ny, requestedSize) {
    const ps = computePreviewSize();
    const safe = getSafeRenderSize(gl, panoramaCanvas, ps.w, ps.h);
    stitchIfNeeded(safe.w, safe.h, true);
    const fw = renderTexture.width, fh = renderTexture.height;
    if (viewMode === '3d') {
      const uv = S360.viewer.getPanoramaUvAt(nx, ny);
      if (!uv) return null;
      nx = uv.u;
      ny = uv.v;
    }
    const w = Math.min(fw, Math.max(8, Math.round(requestedSize || 256)));
    const h = Math.min(fh, Math.max(8, Math.round(requestedSize || 256)));
    const cx = Math.round(Math.max(0, Math.min(1, nx)) * fw);
    const cy = Math.round(Math.max(0, Math.min(1, viewMode === '3d' ? ny : 1 - ny)) * fh);
    const left = Math.max(0, Math.min(fw - w, cx - Math.floor(w / 2)));
    const bottom = Math.max(0, Math.min(fh - h, cy - Math.floor(h / 2)));
    const pixels = new Uint8Array(w * h * 4);
    gl.getError();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.readPixels(left, bottom, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`Panorama readback failed (WebGL error ${error})`);
    return { pixels, width: w, height: h };
  }

  const DEFAULT_CFG = Object.freeze({
    outerMargin: 100,
    radius: 95,
    centers: { left: [0.25, 0.50], right: [0.75, 0.50] },
    rollDeg: { left: 0.0, right: 0.0 },
    width: { left: 0.0, right: 0.0 },
    height: { left: 0.0, right: 0.0 },
    angle: { left: 0.0, right: 0.0 },
    horizon: { pitch: 0.0, roll: 0.0 },
    blend: { seamWidth: 0.5, seamShift: 0 },
    exposureFusion: { contrast: 1, saturation: 1, wellExposed: 1 },
    mirror3D: false,
    drawSize: 8,
    drawFeather: 5,
    drawOpacity: 100,
    denoiseStrength: 0,
    chromaCleanup: 0,
    caRed: 0,
    caBlue: 0,
    focusRecovery: 0,
    focusRadius: 1.5,
    preprocessingEnabled: true,
  });

  let cfg = JSON.parse(JSON.stringify(DEFAULT_CFG));

  S360.stitchSeam.init({
    gl,
    cfg,
    getGainR: () => currentGainR,
    getCurrentImg: () => currentImg,
    getCurrentTexture: () => currentTexture,
    scheduleRender,
    markStitchDirty,
    makeProxy: S360.makeProxy,
    gpuImageToProxyCanvas: S360.gpuImageToProxyCanvas,
    analyzeContentAwareSeam: S360.analyzeContentAwareSeam,
    resolveAnalysisSource,
  });

  S360.lensAlignment.init({
    gl,
    cfg,
    getCurrentImg: () => currentImg,
    getCurrentTexture: () => currentTexture,
    getGainR: () => currentGainR,
    makeProxy: S360.makeProxy,
    gpuImageToProxyCanvas: S360.gpuImageToProxyCanvas,
    resolveAnalysisSource,
  });

  S360.focusRecovery.init({
    cfg,
    getCurrentImg: () => currentImg,
    readRegion: readFocusRegionAt,
  });


  const seamPolicy = { live: true, onInput: () => {
    if (currentImg) S360.stitchSeam.scheduleContentAwareSeam();
  } };
  const blendPolicy = { live: true }; // width/shift never change the overlap belt, so no re-analysis
  const centerPolicy = { live: true, onInput: () => {
    scheduleGainEstimate();
    seamPolicy.onInput();
  } };
  const exposureFusionPolicy = { live: false };
  const cleanupPolicy = { live: true };
  const horizonPolicy = { live: true };

  const pct = { suffix: '%' };
const sliderMap = [
     { id: 'outerMargin', get: () => cfg.outerMargin,        set: v => cfg.outerMargin = v, policy: seamPolicy, label: pct, undoGroup: 'geometry' },
     { id: 'radius',      get: () => cfg.radius,             set: v => cfg.radius = v,      policy: seamPolicy, label: pct, undoGroup: 'geometry' },
     { id: 'seamWidth',   get: () => Math.round(cfg.blend.seamWidth * 100), set: v => cfg.blend.seamWidth = v / 100, policy: blendPolicy, label: pct, undoGroup: 'geometry' },
     { id: 'seamShift',   get: () => Math.round(cfg.blend.seamShift * 100), set: v => cfg.blend.seamShift = v / 100, policy: blendPolicy, label: pct, undoGroup: 'geometry' },
     { id: 'horizonPitch', get: () => cfg.horizon.pitch, set: v => cfg.horizon.pitch = v, policy: horizonPolicy, label: { suffix: '°' }, undoGroup: 'geometry' },
     { id: 'horizonRoll',  get: () => cfg.horizon.roll,  set: v => cfg.horizon.roll = v,  policy: horizonPolicy, label: { suffix: '°' }, undoGroup: 'geometry' },
     { id: 'fusionContrast',    get: () => cfg.exposureFusion.contrast,    set: v => cfg.exposureFusion.contrast = v, policy: exposureFusionPolicy },
     { id: 'fusionSaturation',  get: () => cfg.exposureFusion.saturation,  set: v => cfg.exposureFusion.saturation = v, policy: exposureFusionPolicy },
     { id: 'fusionWellExposed', get: () => cfg.exposureFusion.wellExposed, set: v => cfg.exposureFusion.wellExposed = v, policy: exposureFusionPolicy, label: { decimals: 0, suffix: '%', scale: 50 } },
     { id: 'denoiseStrength', get: () => cfg.denoiseStrength, set: v => cfg.denoiseStrength = v, policy: cleanupPolicy },
     { id: 'chromaCleanup',   get: () => cfg.chromaCleanup,   set: v => cfg.chromaCleanup = v,   policy: cleanupPolicy },
     { id: 'caRed', get: () => cfg.caRed, set: v => cfg.caRed = v, policy: cleanupPolicy, label: { suffix: ' px' } },
     { id: 'caBlue', get: () => cfg.caBlue, set: v => cfg.caBlue = v, policy: cleanupPolicy, label: { suffix: ' px' } },
     { id: 'focusRecovery', get: () => Math.round(cfg.focusRecovery * 100), set: v => cfg.focusRecovery = v / 100, policy: cleanupPolicy, label: pct },
     { id: 'focusRadius', get: () => cfg.focusRadius, set: v => cfg.focusRadius = v, policy: cleanupPolicy, label: { decimals: 1, suffix: ' px' } },
     { id: 'centerL',     get: () => cfg.centers.left[0],  set: v => cfg.centers.left[0] = v, policy: centerPolicy, undoGroup: 'alignment' },
    { id: 'widthL',      get: () => cfg.width.left,        set: v => cfg.width.left = v,       policy: centerPolicy, undoGroup: 'alignment' },
    { id: 'heightL', get: () => cfg.height.left, set: v => cfg.height.left = v, policy: centerPolicy, undoGroup: 'alignment' },
    { id: 'angleL',      get: () => cfg.angle.left,        set: v => cfg.angle.left = v,       policy: centerPolicy, undoGroup: 'alignment' },
    { id: 'centerR',     get: () => cfg.centers.right[0], set: v => cfg.centers.right[0] = v, policy: centerPolicy, undoGroup: 'alignment' },
    { id: 'widthR',      get: () => cfg.width.right,       set: v => cfg.width.right = v,      policy: centerPolicy, undoGroup: 'alignment' },
    { id: 'heightR', get: () => cfg.height.right, set: v => cfg.height.right = v, policy: centerPolicy, undoGroup: 'alignment' },
    { id: 'angleR',      get: () => cfg.angle.right,       set: v => cfg.angle.right = v,      policy: centerPolicy, undoGroup: 'alignment' },
  ];

  const LIVE_KEY = 'stitch360_settings_live';
  const SNAPSHOT_KEY = 'stitch360_settings_snapshot';

  const EXPOSURE_FUSION_SNAPSHOT_KEY = 'stitch360_exposure_fusion_snapshot';
  const PROC_SNAPSHOT_KEY = 'stitch360_proc_snapshot';
  const WM_SNAPSHOT_KEY = 'stitch360_wm_snapshot';

  const renderScheduler = S360.createRenderScheduler({
    render: coarse => renderPano(null, null, coarse),
    hasSource: () => !!currentImg && !gl.isContextLost(),
  });
  S360.renderStatusSummary = () => renderScheduler.summary();
  setInterval(() => {
    if (!S360.uiChrome?.updateConsoleStatus) return;
    S360.uiChrome.updateConsoleStatus();
  }, 2000);
  const compositor = S360.createPanoramaCompositor(gl, {
    stitch: stitchIfNeeded,
    getTarget: () => ({ tex: renderTexture, fbo: framebuffer }),
    post: renderWithPostProcessing,
  });

  // ---- Module init ----
  S360.settings.init(); // captures the post/watermark DOM refs before any UI wiring
  S360.uiChrome.init({ ctx, scheduleRender });
  S360.compare.init({ ctx });
  S360.downloads.init({
    ctx,
    renderOffscreenPixels,
    streamOffscreenPixels,
    shedNonEssentials: () => _shedNonEssentials(gl, 0),
  });

  S360.lpModal.init({
    ctx,
    stitchIfNeeded,
    renderWithPostProcessing,
    triggerDownload: S360.downloads.triggerDownload,
    shedNonEssentials: () => _shedNonEssentials(gl, 0),
  });

  S360.schematic.init({ ctx, markStitchDirty, readWbSampleAt });
  S360.manualHorizon.init({ ctx });

  S360.loaders.init({
    ctx,
    uploadTexture,
    setLoading: S360.uiChrome.setLoading,
    setActionsVisible: S360.uiChrome.setActionsVisible,
    updateStitchedUI: S360.uiChrome.updateStitchedUI,
  });

  S360.sourceEdit.init({ ctx, getSource: () => ({ image: currentImg, texture: currentTexture, gain: currentGainR }) });
  S360.warpGpu.init({ gl: ctx.gl });
  S360.viewWarp.init({
    ctx,
    getSource: () => ({ image: currentImg, texture: currentTexture, gain: currentGainR }),
    getCamera: () => {
      const s = S360.viewer.getSphere();
      return s ? { yaw: s.yaw, pitch: s.pitch, fov: s.fov, proj: S360.viewer.getProj(), mirror: ctx.getMirror3D() } : null;
    },
    getCalibration: () => {
      const c = ctx.cfg;
      return {
        outerMargin: c.outerMargin,
        radius: c.radius,
        centers: { left: [c.centers.left[0], c.centers.left[1]], right: [c.centers.right[0], c.centers.right[1]] },
        rollDeg: { ...c.rollDeg },
        width: { ...c.width },
        height: { ...c.height },
        angle: { ...c.angle },
        horizon: { ...c.horizon },
        blend: { ...c.blend },
        exposureFusion: { ...c.exposureFusion },
        mirror3D: c.mirror3D,
      };
    },
    getCurrentImg: () => currentImg,
    preparePreview: (lensName, view) => {
      if (isStitched || !currentImg) return null;
      const requested=view.outputWidth||Math.round(view.w*3);
      const width=Math.min(MAX_TEX_SIZE,Math.max(1024,requested)),height=Math.max(1,Math.round(width/2));
      const selected=S360.createRenderTarget(gl,width,height,`Warp ${lensName} lens preview`);
      let other=null;
      try {
        other=S360.createRenderTarget(gl,width,height,'Warp reference lens preview');
        stitchWebGL(currentImg.width,currentImg.height,width,height,selected,true,lensName==='right'?2:1);
        stitchWebGL(currentImg.width,currentImg.height,width,height,other,true,lensName==='right'?1:2);
        return {selected,other,dispose(){selected.dispose();other.dispose();}};
      } catch(error){selected.dispose();other?.dispose();throw error;}
    },
    onMove: () => { S360.renderSphere(ctx); },
  });
  S360.drawing.init({ ctx });

  S360.settings.loadLiveConfig(ctx);
  S360.stitchUI.init({
    ctx, scheduleRender, showSeam: () => showSeam, setShowSeam: (v) => { showSeam = v; },
    uploadTexture, renderOffscreenPixels, estimateCurrentGain,
    currentGainR: (v) => { currentGainR = v; },
    drawLensSchematic, yieldToUI: S360.yieldToUI,
  });
  S360.uiChrome.updateStitchedUI();
  S360.settings.updateUIFromConfig(ctx);
  S360.settings.updatePreprocessUI(ctx);
  S360.settings.updatePostUI(ctx);
  S360.settings.updateWmUI(ctx);
   if (S360.drawing) S360.drawing.syncCanvasSliders();
   drawLensSchematic();

  // -- WEBGL PIPELINE --
  function computePreviewSize() {
    if (!currentImg) return { w: 2, h: 1 };
    let maxW = PREVIEW_MAX_W;
    if (S360.gpuMem && currentImg) {
      const srcBytes = currentImg.width * currentImg.height * 4;
      const lfBytes = Math.max(1, currentImg.width >> 1) * Math.max(1, currentImg.height >> 1) * 8;
      let previewW = maxW;
      while (previewW > 512) {
        const previewH = Math.round(previewW / 2);
        const stitchBytes = previewW * previewH * 4;
        const lumBytes = (previewW >> 1) * (previewH >> 1) * 4 * 2;
        const workingSet = srcBytes + lfBytes + stitchBytes + lumBytes;
        if (workingSet <= S360.gpuMem.budget() * 0.80) break;
        previewW = Math.round(previewW / 2);
      }
      maxW = previewW;
    }
    const w = Math.min(Math.round(currentImg.width), maxW);
    const h = Math.round(w / 2);
    return { w, h };
  }

  function renderPano(requestedW = null, requestedH = null, coarse = false) {
    if (!currentImg || gl.isContextLost()) return;
    if (!coarse) renderScheduler.cancelFine();
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
      const fullW0 = Math.min(Math.round(currentImg.width), MAX_TEX_SIZE);
      const fullH0 = Math.round(fullW0 / 2);
      const { w, h } = clampToGpuLimits(gl, fullW0, fullH0);
      // stitchIfNeeded re-stitches on any size change, so entering 3D forces
      // the full-resolution stitch (the 2D preview left it at PREVIEW_MAX_W).
      // Seam diagnostics are useful while inspecting the sphere too. Keep the
      // clean variant for normal 3D, but bake the diagnostic when Seam is on.
      stitchIfNeeded(w, h, !showSeam);
      S360.scheduleViewerUpdate(ctx);
      return;
    }

    // Ensure canvas is at full target resolution (stays fixed across coarse/fine
    // passes so there is no resize flicker between them).
    const safe = getSafeRenderSize(gl, panoramaCanvas, panoW, panoH);
    panoW = safe.w;
    panoH = safe.h;

    const w = coarse ? Math.max(256, Math.round(panoW / PROGRESSIVE_COARSE_DIV)) : panoW;
    const h = Math.round(w / 2);
    const result = compositor.render(w, h, { processing: postEnabled && !schematicMode, clean: false });
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, result.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, panoW, panoH, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (coarse) return;

    // GPU spin watchdog: insert a fence after the last draw call so the
    // periodic timer can detect a hung GPU.
    if (gl.fenceSync) {
      if (_renderFence) gl.deleteSync(_renderFence);
      _renderFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      _renderStartTime = performance.now();
    }

    S360.scheduleViewerUpdate(ctx);
  }

  function scheduleRender() { renderScheduler.schedule(); }

  // ---- GPU memory pressure response ----
  function _shedNonEssentials(_gl, _needed) {
    let freed = 0;
    // 1. Lum blur cache — cheapest to rebuild (just re-renders two blur passes).
    //    invalidateBlurCache is defined in webgl-utils.js's closure and handles
    //    its own slot tracking + deletion; it returns the tracked bytes freed
    //    across all cached slots.
    if (S360.invalidateBlurCache) {
      freed += S360.invalidateBlurCache(_gl) || 0;
    }
    if (freed > 0) {
      S360.debugLog(`🎮 Total shed: ${(freed / 1048576).toFixed(1)} MiB`);
    }
  }

  // Marks the cached offscreen stitch as invalid so the next render re-stitches.
  function markStitchDirty() {
    _stitchDirty = true;
    _fboValid = false;
  }

  function allocateStitchTarget(panoW, panoH) {
    const pooled = getPooledFBO(gl, panoW, panoH);
    renderTexture = pooled.tex;
    framebuffer = pooled.fbo;
    renderTexture.width = panoW;
    renderTexture.height = panoH;
  }

  // 1:1 copy of an already-stitched (equirectangular) source into the stitch
  // target. No fisheye projection — just a Y-flip so the equirect matches the
  // orientation the sphere/export expect (north pole at the top of the FBO, see
  // readFboToCanvas()'s flip). Used when isStitched is true.
  function copyStitched(panoW, panoH, targetFbo) {
    const prog = S360.progs.getCopyProgram();
    gl.useProgram(prog);
    gl.bindVertexArray(getQuadVAO(gl));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, currentTexture);
    gl.uniform1i(prog._u.u_tex, 0);
    gl.uniform1f(prog._u.u_grainStrength, cfg.preprocessingEnabled ? (cfg.denoiseStrength ?? 0) : 0);
    gl.uniform1f(prog._u.u_chromaCleanup, cfg.preprocessingEnabled ? (cfg.chromaCleanup ?? 0) : 0);
    gl.uniform1f(prog._u.u_focusRecovery, cfg.preprocessingEnabled ? (cfg.focusRecovery ?? 0) : 0);
    gl.uniform1f(prog._u.u_focusRadius, cfg.focusRadius ?? 1.5);
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo || null);
    gl.viewport(0, 0, panoW, panoH);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function stitchIfNeeded(panoW, panoH, forceNormal = false) {
     const variant = [!forceNormal && schematicMode, !forceNormal && showSeam && !schematicMode,
       !forceNormal && schematicGuideX >= 0].join(':');
     const needRealloc = !renderTexture || renderTexture.width !== panoW || renderTexture.height !== panoH || !gl.isTexture(renderTexture);
     if (needRealloc || !_fboValid || _stitchDirty || variant !== _stitchVariant) {
       if (needRealloc) allocateStitchTarget(panoW, panoH);
       gl.viewport(0, 0, panoW, panoH);
      if (isStitched) copyStitched(panoW, panoH, framebuffer);
      else stitchWebGL(currentImg.width, currentImg.height, panoW, panoH, { fbo: framebuffer }, forceNormal);
       _fboValid = true;
       _stitchDirty = false;
       _stitchVariant = variant;
       renderTexture.contentRevision = ++_renderRevision;
     }
   }

  function renderWithPostProcessing(panoW, panoH, targetFbo = null, forceNormal = false) {
     stitchIfNeeded(panoW, panoH, forceNormal);

    const prevFb = _boundFbo;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
    _boundFbo = targetFbo;
    gl.viewport(0, 0, panoW, panoH);

    const prog = S360.progs.getPostProgram();
    gl.useProgram(prog);
    gl.bindVertexArray(getQuadVAO(gl));

    const u = prog._u;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, renderTexture);
    gl.uniform1i(u.u_texture, 0);
    gl.uniform1f(u.u_temp, postUniforms.temperature);
    gl.uniform1f(u.u_exposure, postUniforms.exposure);
    gl.uniform1f(u.u_gamma, postUniforms.gamma);
    gl.uniform1f(u.u_sharpen, postUniforms.sharpen);
    gl.uniform1f(u.u_clarity, postUniforms.clarity);
    gl.uniform1f(u.u_saturation, postUniforms.saturation);
    gl.uniform1f(u.u_contrast, postUniforms.contrast);
    let blurTex = renderTexture;
    if (postUniforms.sharpen > 0 || postUniforms.clarity > 0) {
      blurTex = S360.ensureLumBlur(gl, renderTexture, panoW, panoH, postUniforms.exposure, postUniforms.gamma).tex;
    } else {
      S360.invalidateBlurCache(gl);
    }
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, blurTex);
    gl.uniform1i(u.u_blurLum, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, renderTexture);
    gl.uniform1i(u.u_texture, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    _boundFbo = prevFb;
  }

  function uploadTexture(img, preserveDrawing = false, preserveCalibration = false, edits = null, sourceStitched = isStitched) {
    S360.manualHorizon?.cancel();
    const incremental=edits && sourceResource && img.width===currentImg.width && img.height===currentImg.height;
    if(incremental)sourceResource.updateEdits(edits);
    const next = incremental ? sourceResource : S360.prepareSourceTexture(gl, img, cfg,
      preserveDrawing ? currentGainR : undefined, { lowFrequency: !sourceStitched });
    renderScheduler.cancel();
    if(!incremental)compositor.release();
    // Source replacement: cancel pending analysis but keep the previous seam
    // curve/texture live until the new one arrives (context loss drops them —
    // see stitchSeam.clearForContextLoss).
    if (!preserveCalibration) S360.stitchSeam.reset();
    const previous = sourceResource, previousImage = currentImg;
    sourceResource = next;
    next.image = img;
    currentImg = img;
    currentTexture = next.texture;
    // Sparse edits update the already-adopted source resource. Keep the live
    // calibration: geometry changes may have recomputed it since that resource
    // was first prepared, and an edit must not restore the older gain object.
    if (!incremental) currentGainR = next.gain;
    lfTex = next.lfTex;
    if(previous!==next)previous?.dispose();
    if (previousImage !== img && !previousImage?.isGpuImage) S360.releaseImage(previousImage);
    S360.invalidateBlurCache(gl);
    _gainCache = null; _gainCacheKey = null;
    if(!incremental){resetPools(gl);renderTexture = framebuffer = null;}
    schematicGuideX = schematicGuideY = -1;
    invalidateSchematicBgCache();
    if (!preserveDrawing) { S360.drawing.reset(); S360.sourceEdit.reset(); }
    markStitchDirty();
    try { if (!preserveCalibration && !sourceStitched) S360.stitchSeam.updateContentAwareSeam(); }
    catch (error) { console.warn('Seam preparation failed:', error); }
    S360.uiChrome.updateWelcome();
  }

  function stitchWebGL(srcW, srcH, panoW, panoH, renderTarget = null, forceNormal = false, outputLens = 0) {
    const prog = S360.progs.getGlProgram();
    gl.useProgram(prog);

    gl.bindVertexArray(getQuadVAO(gl));

    const prevFb = _boundFbo;
    const outputFbo=renderTarget?(renderTarget.fbo||framebuffer):null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFbo);
    _boundFbo = outputFbo;

    // Bind textures to units
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, currentTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lfTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, S360.stitchSeam.getSeamTexture());

    const u = prog._u;
    gl.uniform1i(u.u_image, 0);
    gl.uniform1i(u.u_imageLF, 1);
    gl.uniform1i(u.u_seamCurve, 2);

    const gainR = currentGainR?.gain || [1, 1, 1];
    const cxL = srcW * cfg.centers.left[0];
    const cxR = srcW * cfg.centers.right[0];
    const cyL = srcH * cfg.centers.left[1];
    const cyR = srcH * cfg.centers.right[1];
    const base = Math.min(srcW * 0.25, srcH * 0.5);
    const lens = S360.lensParams(cfg, base);

    // Cached lens bases: rebuilt only when a local or global rotation changes.
    const rollL = cfg.rollDeg.left, rollR = cfg.rollDeg.right;
    const horizonPitch = cfg.horizon?.pitch || 0, horizonRoll = cfg.horizon?.roll || 0;
    if (rollL !== _cachedRollL || rollR !== _cachedRollR ||
        horizonPitch !== _cachedHorizonPitch || horizonRoll !== _cachedHorizonRoll) {
      _cachedLb = S360.lensBasis(false, cfg);
      _cachedRb = S360.lensBasis(true, cfg);
      _cachedRollL = rollL; _cachedRollR = rollR;
      _cachedHorizonPitch = horizonPitch; _cachedHorizonRoll = horizonRoll;
    }
    const Rb = _cachedRb, Lb = _cachedLb;

    gl.uniform3fv(u.u_gainR, gainR);
    gl.uniform1f(u.u_grainStrength, cfg.preprocessingEnabled ? (cfg.denoiseStrength ?? 0) : 0);
    gl.uniform1f(u.u_chromaCleanup, cfg.preprocessingEnabled ? (cfg.chromaCleanup ?? 0) : 0);
    gl.uniform1f(u.u_caRed, cfg.preprocessingEnabled ? (cfg.caRed ?? 0) : 0);
    gl.uniform1f(u.u_caBlue, cfg.preprocessingEnabled ? (cfg.caBlue ?? 0) : 0);
    gl.uniform1f(u.u_focusRecovery, cfg.preprocessingEnabled ? (cfg.focusRecovery ?? 0) : 0);
    gl.uniform1f(u.u_focusRadius, cfg.focusRadius ?? 1.5);
    gl.uniform1i(u.u_showSeam, showSeam && !schematicMode && !forceNormal ? 1 : 0);
    gl.uniform2f(u.u_srcSize, srcW, srcH);
    gl.uniform2f(u.u_centersL, cxL, cyL);
    gl.uniform2f(u.u_centersR, cxR, cyR);
    gl.uniform1f(u.u_radius, lens.radiusOuter);
    gl.uniform1f(u.u_halfFov, lens.halfFov);
    gl.uniform1f(u.u_f, lens.f);
    gl.uniform1f(u.u_matchNorm, lens.matchNorm);
    gl.uniform1f(u.u_beltNorm, lens.beltNorm);
    gl.uniform1f(u.u_seamWidth, cfg.blend.seamWidth);
    gl.uniform1f(u.u_seamShift, cfg.blend.seamShift);
    gl.uniform3fv(u.u_axisL, Lb.axis);
    gl.uniform3fv(u.u_upL, Lb.up);
    gl.uniform3fv(u.u_rightL, Lb.right);
    gl.uniform3fv(u.u_axisR, Rb.axis);
    gl.uniform3fv(u.u_upR, Rb.up);
    gl.uniform3fv(u.u_rightR, Rb.right);
    gl.uniform1i(u.u_schematicMode, (!forceNormal && schematicMode) ? 1 : 0);
    gl.uniform1f(u.u_rollL, cfg.rollDeg.left * Math.PI / 180.0);
    gl.uniform1f(u.u_rollR, cfg.rollDeg.right * Math.PI / 180.0);
    gl.uniform1f(u.u_widthL, 1.0 - cfg.width.left / 100.0);
    gl.uniform1f(u.u_heightL, 1.0 - cfg.height.left / 100.0);
    gl.uniform1f(u.u_angleL, cfg.angle.left * Math.PI / 180.0);
    gl.uniform1f(u.u_widthR, 1.0 - cfg.width.right / 100.0);
    gl.uniform1f(u.u_heightR, 1.0 - cfg.height.right / 100.0);
    gl.uniform1f(u.u_angleR, cfg.angle.right * Math.PI / 180.0);
    gl.uniform1i(u.u_guideOn, !forceNormal && schematicGuideX >= 0 ? 1 : 0);
    gl.uniform2f(u.u_guidePos, schematicGuideX >= 0 ? schematicGuideX : 0.0, schematicGuideY >= 0 ? schematicGuideY : 0.0);
    gl.uniform1i(u.u_outputLens, outputLens);

    gl.viewport(0, 0, panoW, panoH);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    _boundFbo = prevFb;
  }

  // -- EXPORT --
  function renderOffscreenPixels(panoW, panoH, skipPost = false) {
    const result = compositor.render(panoW, panoH, {
      processing: !skipPost && postEnabled, clean: true, decals: !skipPost,
    });
    return S360.readFboToCanvas(gl, result.fbo, panoW, panoH);
  }

  function streamOffscreenPixels(panoW, panoH, skipPost = false) {
    const result = compositor.render(panoW, panoH, {
      processing: !skipPost && postEnabled, clean: true, decals: !skipPost,
    });
    return S360.streamFboToPng(gl, result.fbo, panoW, panoH);
  }

});



