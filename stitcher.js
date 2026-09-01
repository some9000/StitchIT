/**
 * StitchIT: WebGL2 dual-fisheye -> equirectangular stitcher
 * Impossible to exist without inspiration from https://github.com/sanriomisintaro/stitch-360
 * Features:
 *  - Frequency-Split Seam Blending (Parallax & Ghost Reduction in WebGL2)
 *  - Photometric Feathering & Real-Time Post-Processing (CAS/Sharpen, Gamma, Contrast, Exposure)
 *  - Full-resolution Exporting with Google Photo Sphere XMP Metadata Injection
 *  - Interactive 360° Spherical WebGL2 Viewer (in-place texture updates, no flash)
 *  - Exposure Weighted HDR Exposure Fusion Pipeline
 *  - Full-resolution rendering with WebGL2 VAO and immutable textures
 *
 * FILE STRUCTURE (approximate line ranges — for future refactoring):
 *   1–115    : Shader sources (COPY_VS/FS, LITTLE_PLANET, WB_LUT)
 *   121–560  : DOM bindings, state variables, config defaults, ctx object
 *   560–1090 : UI event handlers (sliders, buttons, HDR bell, schematic, WB)
 *   1092–1170: Welcome overlay, resize handler, setLoading/setActionsVisible
 *   1170–1340: File loading orchestration (onFile, loadDualFisheye, loadBlend, loadHdr, loadStitched)
 *   1341–1395: Preview size computation (computePreviewSize)
 *   1396–1610: Core render pipeline (renderPano, progressive rendering, scheduleRender)
 *   1611–1770: WebGL stitch pipeline (buildLFTexture, allocateStitchTarget, stitchWebGL, renderWithPostProcessing)
 *   1771–1920: Lens schematic preview, uploadTexture, white-balance sampling
 *   1920–2100: Stitch shader setup & uniform upload
 *   2100–2400: Export functions (readFboToCanvas, renderOffscreenPixels, little planet, downloads)
 *   2400–2603: Additional file loaders and event wiring
 */

// ===========================================================================
//  APPLICATION INITIALIZATION & DOM BINDINGS
// ===========================================================================

// stitcher.js (top) — classic-script build: shared helpers live on the global S360
// namespace (defined by webgl-utils.js / watermark.js / hdr.js / exporter.js, which
// must be loaded before this file via plain <script> tags). This keeps the code
// split across separate files while still running from a file:// URL.
const S360 = window.S360 || {};
const { createProgram, getQuadVAO, getPooledFBO, resetPools, getPooledPostFBO, getPooledLF } = S360;
const { processAndMergeHDR } = S360;
const { clampToGpuLimits, getSafeRenderSize, injectXMPMetadata, renderFullAndExport } = S360;
const { compositeWatermark, getWatermarkProgram } = S360;
const { BLUR_VS, BLUR_FS, LANCZOS_VS, LANCZOS_H_FS, LANCZOS_V_FS, VS_SOURCE, FS_SOURCE, createPostProgram } = S360;
  const { loadImageFromFile, estimateGainR, estimateGainRFromSource, scaleSource, processAndBlendFiles } = S360;

  // Precomputed white-balance lookup table (Helland approximation).
  // Matches the UI slider step of 50 K over 2000..12000.
  const WB_LUT = (() => {
    const lut = [];
    for (let k = 2000; k <= 12000; k += 50) {
      const t = k / 100.0;
      let wr, wg, wb;
      if (t <= 66.0) {
        wr = 255.0;
        wg = 99.4708025861 * Math.log(t) - 161.1195681661;
      } else {
        wr = 329.698727446 * Math.pow(t - 60.0, -0.1332047592);
        wg = 288.1221695283 * Math.pow(t - 60.0, -0.0755148492);
      }
      if (t >= 66.0) wb = 255.0;
      else if (t <= 19.0) wb = 0.0;
      else wb = 138.5177312231 * Math.log(t - 10.0) - 305.0447927307;
      lut.push({ k, wr: Math.max(wr, 1e-3), wg: Math.max(wg, 1e-3), wb: Math.max(wb, 1e-3) });
    }
    return lut;
  })();

  function wbLookup(k) {
    const idx = Math.round((k - 2000) / 50);
    return (idx >= 0 && idx < WB_LUT.length) ? WB_LUT[idx] : WB_LUT[100];
  }

  // Passthrough copy shader for already-stitched (equirectangular) sources.
  // Flips Y so north pole lands at the top of the FBO (matching readFboToCanvas).
  const COPY_VS = `#version 300 es
    layout(location = 0) in vec2 a_pos;
    out vec2 v_uv;
    void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;
  const COPY_FS = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 fragColor;
    uniform sampler2D u_tex;
    void main() { fragColor = texture(u_tex, vec2(v_uv.x, 1.0 - v_uv.y)); }`;

  // Equidistant "little planet" projection: equirectangular -> square.
  const LITTLE_PLANET_VS = `#version 300 es
    layout(location = 0) in vec2 a_position;
    out vec2 v_uv;
    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }`;

  const LITTLE_PLANET_FS = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 fragColor;
    uniform sampler2D u_tex;
    uniform float u_zoom;
    uniform float u_yaw;
    uniform float u_aspect;
    uniform float u_mirror;
    // Watermark (nadir decal) uniforms
    uniform float u_wmOn;
    uniform sampler2D u_wm;
    uniform float u_wmSize;
    uniform float u_wmAlpha;
    uniform float u_wmRot;
    // Use LP_PI instead of #define PI to avoid the preprocessor expanding PI
    // inside WM_GLSL's own const-float-PI declaration.
    const float LP_PI = 3.14159265358979323846;

    ${S360.WM_GLSL}

    void main() {
      // Normalized canvas coords in [-1, 1].
      vec2 c_norm = (v_uv - 0.5) * 2.0;

      // Projection coords (aspect-corrected, mirrored).
      vec2 c = vec2(c_norm.x * u_aspect, c_norm.y);
      if (u_mirror > 0.0) c.x = -c.x;

      // rn: 0 at centre, 1.0 at the canvas corners (circle edge).
      float rn = length(c) * 0.7071067811865475;

      // Ease-out zoom from centre: (1-rn)^2 scaled to 50% effect.
      // Centre gets half zoom, edges stay glued to the corners.
      float blend = 0.5 * (1.0 - rn) * (1.0 - rn);
      float rnZ = rn * mix(1.0, 1.0 / u_zoom, blend);

      // Latitude: nadir (v=1) at centre, zenith (v=0) at circle edge.
      float v = 1.0 - rnZ;

      // Azimuth.
      float theta = atan(c.x, -c.y);
      float u = fract((theta + LP_PI + u_yaw) / (2.0 * LP_PI));

      vec4 color = texture(u_tex, vec2(u, 1.0 - v));

      // Watermark: fixed size, uses un-zoomed rn so it does not scale.
      if (u_wmOn > 0.5) {
        float wm_u = fract((theta + LP_PI) / (2.0 * LP_PI));
        float wm_v = 1.0 - rn;
        vec2 wm_uv = vec2(wm_u, 1.0 - wm_v);
        color = vec4(s360CompositeWM(color.rgb, u_wm, wm_uv, u_wmSize, u_wmAlpha, u_wmRot), color.a);
      }

      fragColor = color;
    }`;

  // Little planet preview modal state
  let _lpZoom = 0.5;
  let _lpYaw = 0.0;
  let _lpDragging = false;
  let _lpInitialYaw = 0.0;
  let _lpPrevAngle = 0;
  let _lpWheelTimer = null;
  let _lpModalRaf = null;
  let _lpFineTimer = null;
  let _lpCanvasSize = 600;
  const LP_SETTLE_MS = 150;


document.addEventListener('DOMContentLoaded', () => {
  const imageLoader     = document.getElementById('imageLoader');
  const panoramaCanvas  = document.getElementById('panoramaCanvas');

  if (!panoramaCanvas) {
    console.error('❌ Canvas element #panoramaCanvas missing from DOM.');
    return;
  }

  const gl = panoramaCanvas.getContext('webgl2', { antialias: false, powerPreference: 'high-performance' });

  if (!gl) {
    alert('WebGL2 is required but not supported in this browser.');
    return;
  }

  const MAX_TEX_SIZE = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const MAX_HDR_FRAMES = 64;    // max frames accepted (processed in MERGE_BATCH chunks)
  const MERGE_BATCH = 4;        // frames decoded/held in memory at once per merge pass

  // ---- GPU memory budget ----
  if (S360.gpuMem) {
    S360.gpuMem.init(gl);
    S360.gpuMem.onShed((gl, needed) => _shedNonEssentials(gl, needed));
    S360.gpuMem.onWarn(msg => console.warn('⚠️ ' + msg));
  }
  let activeJobId = 0;
  const beginJob = () => ++activeJobId;
  const isJobCancelled = jobId => jobId !== activeJobId || gl.isContextLost();
  function throwIfJobCancelled(jobId) {
    if (isJobCancelled(jobId)) throw new DOMException('Processing cancelled.', 'AbortError');
  }

  // WebGL context loss recovery
  function handleContextLost(e) {
    e.preventDefault();
    activeJobId++;
    // Cancel any pending progressive renders — the GPU context is gone.
    if (_progressiveFineTimer) { clearTimeout(_progressiveFineTimer); _progressiveFineTimer = null; }
    console.warn('⚠️ WebGL context lost, will attempt recovery...');
    setLoading(true, 'WebGL context lost — attempting recovery...');
  }
  function handleContextRestored() {
    // Recreate all WebGL resources
    currentTexture = null;
    renderTexture = null;
    framebuffer = null;
    lfTex = lfFbo = lfTmpTex = lfTmpFbo = lfProg = null;
    glProgram = null;
    postProgram = null;
    _littlePlanetProg = null;
    S360.viewerShared.sphereProgram = null;
    S360.viewerShared.sphere = null;
    S360.viewerShared.sphereRaf = null;
    S360.viewerShared.sphereFullTimer = null;
    // Reset the memory tracker — all GPU resources died with the old context.
    if (S360.gpuMem) S360.gpuMem.reset();
    // Shared cached GL objects that live in module closures must be invalidated
    // explicitly (an outside `_quadVAO = null` cannot reach webgl-utils' closure
    // variable, and the watermark program cache has the same problem).
    S360.invalidateSharedVAO();
    S360.invalidateWatermarkPrograms();
    S360.invalidateBlurCache();
    S360.invalidateHdrPrograms(gl);
    S360.invalidateGpuImagePrograms();
    S360.invalidateLanczosPrograms();
    S360.viewerShared.panoFullTex = null; S360.viewerShared.panoFullFbo = null; S360.viewerShared.panoFullW = 0; S360.viewerShared.panoFullH = 0;
    S360.viewerShared.panoWMTex = null; S360.viewerShared.panoWMFbo = null;
    wmTex = null; wmFbo = null; wmFboTex = null; wmFboW = 0; wmFboH = 0;
    releaseSchematicBg(); // free the cached 2D canvas ImageBitmap from the old context
    getWmProg = getWatermarkProgram(gl);
    resetPools(gl);
    if (currentImg?.isGpuImage && currentImg.consumed) {
      // GPU-only merged results deliberately have no hundreds-of-megabytes CPU
      // duplicate. A lost context destroys their sole pixel copy.
      currentImg = null;
      setActionsVisible(false);
      alert('The GPU context was reset. Please reopen or re-merge the source images.');
    } else if (currentImg) {
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
  const downloadLittlePlanetBtn = document.getElementById('downloadLittlePlanetBtn');
  const lpModal = document.getElementById('lpModal');
  const lpModalCanvas = document.getElementById('lpModalCanvas');
  const lpCancelBtn = document.getElementById('lpCancelBtn');
  const lpExportJpgBtn = document.getElementById('lpExportJpgBtn');
  const lpExportPngBtn = document.getElementById('lpExportPngBtn');
  const viewModeBtn     = document.getElementById('viewModeBtn');
  const x2Btn           = document.getElementById('x2Btn');
  const schematicBtn    = document.getElementById('schematicBtn');
  const seamBtn         = document.getElementById('seamBtn');
  const mirror3DBtn     = document.getElementById('mirror3DBtn');
  const exportProfileBtn = document.getElementById('exportProfileBtn');
  const importProfileBtn = document.getElementById('importProfileBtn');
  const profileLoader    = document.getElementById('profileLoader');
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
  const tempSlider            = document.getElementById('temperature');
  const tempVal               = document.getElementById('temperatureVal');
  const pickGrayBtn           = document.getElementById('pickGrayBtn');
  const exposureSlider        = document.getElementById('exposure');
  const gammaPPSlider         = document.getElementById('gammaPP');
  const sharpenSlider         = document.getElementById('sharpen');
  const saturationSlider      = document.getElementById('saturation');
  const contrastSlider        = document.getElementById('contrast');

  const saveGeoBtn   = document.getElementById('saveGeoBtn');
  const loadGeoBtn   = document.getElementById('loadGeoBtn');
  const resetTrapBtn = document.getElementById('resetTrapBtn');
  const lensSchematicCanvas = document.getElementById('lensSchematicCanvas');
  const saveHdrBtn   = document.getElementById('saveHdrBtn');
  const loadHdrBtn   = document.getElementById('loadHdrBtn');
  const saveProcBtn  = document.getElementById('saveProcBtn');
  const loadProcBtn  = document.getElementById('loadProcBtn');


  let lastBaseName = 'panorama';
  let glProgram = null;
  let postProgram = null;

  let currentImg = null;
  let currentTexture = null;
  let currentGainR = { gain: [1, 1, 1], seamPhase: 0 };
  let currentSeam = null;
  let seamTexture = null;
  let seamAnalysisTimer = null;
  let seamWorker = null;
  let seamWorkerBusy = false;
  let seamWorkerPending = null;

  function getSeamWorker() {
    if (!seamWorker) {
      try {
        seamWorker = new Worker('seam-worker.js');
        seamWorker.onmessage = function(e) {
          const msg = e.data;
          if (msg.type === 'result') {
            currentSeam = msg.curve ? { curve: msg.curve, angles: msg.angles, score: msg.score } : null;
            seamWorkerBusy = false;
            uploadSeamCurve();
            scheduleRender();
            if (seamWorkerPending) {
              const pending = seamWorkerPending;
              seamWorkerPending = null;
              runSeamAnalysis(pending.analysisSource, pending.proxy, pending.imgWidth, pending.imgHeight);
            }
          } else if (msg.type === 'error') {
            console.warn('Seam analysis worker failed:', msg.message);
            currentSeam = null;
            seamWorkerBusy = false;
            uploadSeamCurve();
            scheduleRender();
            if (seamWorkerPending) {
              const pending = seamWorkerPending;
              seamWorkerPending = null;
              runSeamAnalysis(pending.analysisSource, pending.proxy, pending.imgWidth, pending.imgHeight);
            }
          }
        };
        seamWorker.onerror = function(err) {
          console.warn('Seam analysis worker error:', err);
          seamWorker = null;
          seamWorkerBusy = false;
          seamWorkerPending = null;
        };
      } catch (e) {
        console.warn('Web Worker not available for seam analysis:', e);
        seamWorker = null;
      }
    }
    return seamWorker;
  }

  function runSeamAnalysis(analysisSource, proxy, imgWidth, imgHeight) {
    const worker = seamWorker;
    if (!worker) return;
    const buffer = proxy.data.buffer.slice(0);
    seamWorkerBusy = true;
    worker.postMessage({
      type: 'analyze',
      proxy: {
        w: proxy.w,
        h: proxy.h,
        data: buffer,
        scale: proxy.scale
      },
      imgWidth: imgWidth,
      imgHeight: imgHeight,
      cfg: cfg,
      gain: currentGainR?.gain || [1, 1, 1]
    }, [buffer]);
  }
  let showSeam = false;
  let isStitched = false;     // true when currentImg is already an equirectangular pano (skip fisheye stitch)

  let postEnabled = true;

  function estimateCurrentGain() {
    if (!currentImg) return { gain: [1, 1, 1], seamPhase: 0 };
    if (currentImg.isGpuImage && currentTexture) {
      return estimateGainRFromSource(gl, {
        isGpuImage: true, texture: currentTexture,
        width: currentImg.width, height: currentImg.height
      }, cfg);
    }
    return estimateGainRFromSource(gl, currentImg, cfg);
  }

  function fallbackSeamCurve() {
    // With antipodal lenses the neutral seam is the 90-degree great circle.
    const halfFov = cfg.fovDeg * Math.PI / 360;
    const value = Math.round(Math.max(0, Math.min(1, (Math.PI * 0.5) / halfFov)) * 255);
    return new Uint8Array(256).fill(value);
  }

  function uploadSeamCurve() {
    const curve = currentSeam?.curve || fallbackSeamCurve();
    const pixels = new Uint8Array(curve.length * 4);
    for (let i = 0; i < curve.length; i++) {
      pixels[i * 4] = curve[i]; pixels[i * 4 + 3] = 255;
    }
    if (!seamTexture) seamTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, seamTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, curve.length, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // Repeat makes the first and final samples meet smoothly at the seam loop.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  function updateContentAwareSeam(source = null) {
    if (!currentImg) return;

    const worker = getSeamWorker();
    if (!worker) {
      if (!S360.analyzeContentAwareSeam) return;
      let analysisSource = source || currentImg;
      if (!source && currentImg.isGpuImage && currentTexture) {
        analysisSource = S360.gpuImageToProxyCanvas(gl, {
          isGpuImage: true, texture: currentTexture,
          width: currentImg.width, height: currentImg.height
        }, 640);
      } else if (source?.isGpuImage) {
        analysisSource = S360.gpuImageToProxyCanvas(gl, source, 640);
      }
      try {
        currentSeam = S360.analyzeContentAwareSeam(analysisSource, cfg, currentGainR?.gain);
      } catch (error) {
        console.warn('Content-aware seam analysis failed; using the neutral seam.', error);
        currentSeam = null;
      }
      uploadSeamCurve();
      return;
    }

    let analysisSource = source || currentImg;
    if (!source && currentImg.isGpuImage && currentTexture) {
      analysisSource = S360.gpuImageToProxyCanvas(gl, {
        isGpuImage: true, texture: currentTexture,
        width: currentImg.width, height: currentImg.height
      }, 640);
    } else if (source?.isGpuImage) {
      analysisSource = S360.gpuImageToProxyCanvas(gl, source, 640);
    }

    const maxWidth = analysisSource.isGpuImage ? 640 : undefined;
    const proxy = S360.makeProxy(analysisSource, maxWidth);

    if (seamWorkerBusy) {
      seamWorkerPending = { analysisSource, proxy, imgWidth: analysisSource.width, imgHeight: analysisSource.height };
      return;
    }

    runSeamAnalysis(analysisSource, proxy, analysisSource.width, analysisSource.height);
  }

  function scheduleContentAwareSeam() {
    if (!currentImg) return;
    if (seamAnalysisTimer) clearTimeout(seamAnalysisTimer);
    seamAnalysisTimer = setTimeout(() => {
      seamAnalysisTimer = null;
      updateContentAwareSeam();
      markStitchDirty();
      scheduleRender();
    }, 160);
  }
  let postUniforms = {
    temperature: 6500,
    exposure: 1,
    gamma: 1,
    sharpen: 0.20,
    saturation: 1,
    contrast: 1,
  };

  let framebuffer = null;
  let renderTexture = null;
  // Tracked framebuffer binding — avoids gl.getParameter(GL_FRAMEBUFFER_BINDING)
  // pipeline stalls in hot render paths.
  let _boundFbo = null;



  // Offscreen pool for the fully-processed (stitch + post-FX) output, used by
  // full-resolution export and the 3D viewer. Kept separate from the visible
// <canvas> so those paths are never subject to the browser's on-screen
   // "drawing buffer" size cap (see renderOffscreenPixels() below for why that
   // matters).
  // FBO pools (postFboPool, lfPool) now live in webgl-utils.js

   // Drops every cached FBO/texture in the size-keyed pools. Called when a new
// source image is loaded: those pools are keyed by source dimensions, so a
   // different image would otherwise keep every previous size's textures alive
   // (several full-resolution RGBA8 surfaces each) until the page reloads —
   // repeated loads OOM the browser and trigger a context loss / blank screen.

  // Precomputed low-frequency (blurred source) texture used by the stitch shader
  // so the per-pixel cost drops from a 13-tap in-shader blur to a single fetch.
  let lfTex = null, lfFbo = null, lfTmpTex = null, lfTmpFbo = null, lfProg = null;

  // Full-resolution post-processed texture + sphere viewer state now live in
  // S360.viewerShared (see viewer.js), which owns them.
  let wmTex = null;            // watermark image texture (main context)
  let wmLoaded = false;
  let wmSize = 0.3;            // nadir decal angular radius (tangent-plane)
  let wmRotDeg = 0;          // nadir decal rotation (degrees)
  let wmAlpha = 1.0;
  let wmProgram = null;
  let getWmProg = getWatermarkProgram(gl);
  let wmFbo = null, wmFboTex = null, wmFboW = 0, wmFboH = 0; // reusable FBO for export compositing
  let viewMode = '2d';
  let scaleValue = 1; // 1 = off, 2 = 2x scale
  let schematicMode = false; // schematic overlay for lens geometry
  let schematicGuideX = -1.0; // persistent guide point X (-1 = off)
  let schematicGuideY = -1.0; // persistent guide point Y
  let schematicBgCache = null;   // offscreen canvas with static background + grid
  let schematicBgCacheValid = false;
  let wbSampling = false;    // white-balance point-sampling mode

  // Render scheduling / caching state (items 1-4).
  let _stitchDirty = true;     // source geometry/lens/size changed -> FBO re-stitch needed
  let _fboValid = false;       // offscreen stitch texture currently reflects the source
  let _renderScheduled = false; // rAF coalescing flag for slider-driven renders

  // Progressive rendering: show a fast low-res preview immediately during
  // slider interaction, then refine to full preview resolution after settling.
  let _progressiveFineTimer = null;  // settle timer for the full-quality render
  const PROGRESSIVE_COARSE_DIV = 4;  // coarse = target / 4  (1/16th the pixels)
  const PROGRESSIVE_SETTLE_MS = 200; // ms after last input before fine render

  // Shared application context handed to the settings.js and viewer.js modules,
  // which now own all settings/viewer behaviour. Getters/setters expose this
  // file's local state so there is a single source of truth.
  const ctx = {
    gl, panoramaCanvas, MAX_TEX_SIZE,
    getCurrentImg: () => currentImg,
    getCfg: () => cfg,
    getRenderTexture: () => renderTexture,
    getPostEnabled: () => postEnabled,
    getWmLoaded: () => wmLoaded,
    getWmTex: () => wmTex,
    getWmAlpha: () => wmAlpha,
    getWmRotDeg: () => wmRotDeg,
    getWmProg: () => getWmProg,
    getViewMode: () => viewMode,
    setViewModeValue: (v) => { viewMode = v; },
    getViewModeBtn: () => viewModeBtn,
    getViewerContainer: () => viewerContainer,
    getScaleValue: () => scaleValue,
    setScaleValue: (v) => { scaleValue = v; },
    getWmSize: () => wmSize,
    setWmSize: (v) => { wmSize = v; },
    setWmRotDeg: (v) => { wmRotDeg = v; },
    setPostEnabled: (v) => { postEnabled = v; },
    getSchematicMode: () => schematicMode,
    setSchematicMode: (v) => { schematicMode = v; },
    getSchematicBtn: () => schematicBtn,
    disableSchematic: () => {
      schematicMode = false;
      if (schematicBtn) schematicBtn.classList.remove('active');
      updateCanvasCursor();
    },
    updateCanvasCursor,
    renderPano,
    drawLensSchematic,
    stitchIfNeeded,
    renderWithPostProcessing,
    get cfg() { return cfg; },
    get postUniforms() { return postUniforms; },
    get DEFAULT_CFG() { return DEFAULT_CFG; },
    get DEFAULT_POST() { return DEFAULT_POST; },
    get sliderMap() { return sliderMap; },
    get LIVE_KEY() { return LIVE_KEY; },
    get SNAPSHOT_KEY() { return SNAPSHOT_KEY; },
    get HDR_SNAPSHOT_KEY() { return HDR_SNAPSHOT_KEY; },
    get PROC_SNAPSHOT_KEY() { return PROC_SNAPSHOT_KEY; },
    get WM_SNAPSHOT_KEY() { return WM_SNAPSHOT_KEY; },
    get wmSizeSlider() { return wmSizeSlider; },
    get wmSizeVal() { return wmSizeVal; },
    get wmRotSlider() { return wmRotSlider; },
    get wmRotVal() { return wmRotVal; },
    get tempSlider() { return tempSlider; },
    get tempVal() { return tempVal; },
    get pickGrayBtn() { return pickGrayBtn; },
    get exposureSlider() { return exposureSlider; },
    get gammaPPSlider() { return gammaPPSlider; },
    get sharpenSlider() { return sharpenSlider; },
    get saturationSlider() { return saturationSlider; },
    get contrastSlider() { return contrastSlider; },
    get enablePostBtn() { return enablePostBtn; },
  };

  const DEFAULT_CFG = Object.freeze({
    fovDeg: 186.8,
    radiusScale: 0.95,
    centers: { left: [0.25, 0.50], right: [0.75, 0.50] },
    rollDeg: { left: 0.0, right: 0.0 },
    height: { ll: 100.0, lr: 100.0, rl: 100.0, rr: 100.0 },
    centerOffset: { ll: 0, lr: 0, rl: 0, rr: 0 },
    blend: { hfBandWidth: 0.05, seamShift: 0 },
    hdr: { sigma: 0.30, bellCenter: 0.30, base: 0.30, brightness: -0.30 },
    mirror3D: false,
  });

  const DEFAULT_POST = Object.freeze({
    temperature: 6500,
    exposure: 1,
    gamma: 1,
    sharpen: 0.50,
    saturation: 0.85,
    contrast: 1,
  });

  let cfg = JSON.parse(JSON.stringify(DEFAULT_CFG));

const sliderMap = [
     { id: 'fovDeg',       get: () => cfg.fovDeg,             set: v => cfg.fovDeg = v },
     { id: 'radiusScale',  get: () => cfg.radiusScale,        set: v => cfg.radiusScale = v },
     { id: 'seamWidth',    get: () => Math.round(cfg.blend.hfBandWidth * 1000), set: v => cfg.blend.hfBandWidth = v / 1000 },
     { id: 'seamShift',    get: () => cfg.blend.seamShift * 100, set: v => cfg.blend.seamShift = v / 100 },
      { id: 'hdrSigma',     get: () => cfg.hdr.sigma,          set: v => cfg.hdr.sigma = v,          live: false },
     { id: 'hdrBellCenter',get: () => cfg.hdr.bellCenter,     set: v => cfg.hdr.bellCenter = v,     live: false },
     { id: 'hdrBase',       get: () => cfg.hdr.base,           set: v => cfg.hdr.base = v,           live: false },
     { id: 'hdrEV',         get: () => cfg.hdr.brightness,     set: v => cfg.hdr.brightness = v,     live: false },
    { id: 'RightLensRight',       get: () => cfg.height.rr - 100,       set: v => cfg.height.rr = v + 100 },
    { id: 'RightLensRightCenterV',get: () => cfg.centerOffset.rr,       set: v => cfg.centerOffset.rr = v },
    { id: 'LeftLensLeft',         get: () => cfg.height.ll - 100,       set: v => cfg.height.ll = v + 100 },
    { id: 'LeftLensLeftCenterV',  get: () => cfg.centerOffset.ll,       set: v => cfg.centerOffset.ll = v },
    { id: 'LeftLenRight',         get: () => cfg.height.lr - 100,       set: v => cfg.height.lr = v + 100 },
    { id: 'LeftLensRightCenterV', get: () => cfg.centerOffset.lr,       set: v => cfg.centerOffset.lr = v },
    { id: 'RightLensLeft',        get: () => cfg.height.rl - 100,       set: v => cfg.height.rl = v + 100 },
    { id: 'RightLensLeftCenterV', get: () => cfg.centerOffset.rl,       set: v => cfg.centerOffset.rl = v },
    { id: 'centerL',     get: () => cfg.centers.left[0],  set: v => cfg.centers.left[0] = v },
    { id: 'centerR',     get: () => cfg.centers.right[0], set: v => cfg.centers.right[0] = v },
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

  function flashButton(btn) {
    btn.classList.add('flash');
    setTimeout(() => btn.classList.remove('flash'), 300);
  }

  // HDR snapshot slot (Save / Load buttons in the HDR Settings group). Mirrors the
  // geometry slot but scopes the persisted state to the exposure-fusion bell
  // (sigma, bellCenter, base). HDR values are also folded into the live config by
  // the shared slider handler, so they restore on the next launch too.
  const HDR_SNAPSHOT_KEY = 'stitch360_hdr_snapshot';
  // Storage keys for the Processing and Watermark Save/Load snapshot slots.
  // These were previously referenced without ever being declared, so every
  // access threw a ReferenceError that the snapshot helpers' silent try/catch
  // swallowed — making those buttons appear to do nothing.
  const PROC_SNAPSHOT_KEY = 'stitch360_proc_snapshot';
  const WM_SNAPSHOT_KEY = 'stitch360_wm_snapshot';



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
          S360.settings.scheduleLiveSave(ctx);
          if (item.live !== false && currentImg) { markStitchDirty(); scheduleRender(); }
        });
      } else {
        input.addEventListener('input', (e) => {
          const val = parseFloat(e.target.value);
          item.set(val);
          const step = input.step || '1';
          const decimals = step.includes('.') ? step.split('.')[1].length : 0;
                    if (valSpan) valSpan.textContent = val.toFixed(decimals);
          S360.settings.scheduleLiveSave(ctx);
          // Lens-centre changes move the R-lens reference circles — refresh the
          // photometric gain so seam brightness stays consistent.
          if (currentImg && (item.id === 'centerL' || item.id === 'centerR')) {
            currentGainR = estimateCurrentGain();
          }
          if (currentImg && ['fovDeg', 'radiusScale', 'seamWidth',
            'RightLensRight', 'RightLensRightCenterV',
            'LeftLensLeft', 'LeftLensLeftCenterV',
            'LeftLenRight', 'LeftLensRightCenterV',
            'RightLensLeft', 'RightLensLeftCenterV',
            'centerL', 'centerR'].includes(item.id)) scheduleContentAwareSeam();
          if (item.live !== false && currentImg) { markStitchDirty(); scheduleRender(); }
          if (item.id === 'hdrSigma' || item.id === 'hdrBellCenter' || item.id === 'hdrBase' ||
              item.id === 'hdrEV') S360.settings.drawHdrBellChart(ctx);
          drawLensSchematic();
        });
      }
    });

    const postSliders = [
      { el: tempSlider, id: 'temperatureVal', key: 'temperature' },
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
        if (span) span.textContent = (key === 'temperature') ? String(Math.round(val)) : val.toFixed(2);
        S360.settings.scheduleLiveSave(ctx);
        // When Post-FX is off the effect isn't shown, so don't trigger an
        // expensive re-stitch — just let the slider move smoothly. The redraw
        // happens once when Post-FX is toggled back on.
        if (currentImg && postEnabled) scheduleRender();
      });
    });

    // "Sample": enter a picking mode, then the user clicks any point of the
    // stitched (pre-post) panorama. That neighbourhood is averaged and treated as
    // the illuminant; the colour temperature that makes the spot neutral grey
    // removes the colour cast, after which the slider refines it by eye.
    function setWbSampling(on) {
      wbSampling = on;
      if (pickGrayBtn) pickGrayBtn.classList.toggle('active', on);
      updateCanvasCursor();
    }

    if (pickGrayBtn) {
      pickGrayBtn.addEventListener('click', () => {
        if (!currentImg) { alert('Please load an image first.'); return; }
        if (viewMode === '3d') {
          alert('Switch to the 2D view to sample a white-balance point.');
          return;
        }
        if (wbSampling) { setWbSampling(false); return; }
        setWbSampling(true);
      });
    }

    // Apply a white-balance temperature from a sampled pixel-average buffer.
    function applyWbFromSample(buf) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < buf.length; i += 4) {
        r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; n++;
      }
      r /= n; g /= n; b /= n;
      if (g <= 0) return;

      // Neutralise: solve for the Kelvin whose white point has the same r:g:b ratio
      // as the sampled cast. We search the precomputed LUT for the best match.
      let bestK = 6500, bestErr = Infinity;
      for (let i = 0; i < WB_LUT.length; i++) {
        const { wr, wg, wb } = WB_LUT[i];
        const err = Math.abs(r / g - wr / wg) + Math.abs(b / g - wb / wg);
        if (err < bestErr) { bestErr = err; bestK = WB_LUT[i].k; }
      }

      postUniforms.temperature = bestK;
      if (tempSlider) tempSlider.value = bestK;
      if (tempVal) tempVal.textContent = String(Math.round(bestK));
      S360.settings.scheduleLiveSave(ctx);
      if (currentImg) renderPano();
    }

    // Map a canvas click to the stitched FBO and white-balance from that spot.
    panoramaCanvas.addEventListener('click', (e) => {
      if (!currentImg || viewMode === '3d') return;

      if (!wbSampling) return;
      setWbSampling(false);

      // Normalised click position across the displayed (2:1 equirect) canvas.
      const rect = panoramaCanvas.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width;
      const ny = (e.clientY - rect.top) / rect.height;

      // Ensure the latest stitch is in the offscreen FBO at preview resolution.
      const ps = computePreviewSize();
      const safe = getSafeRenderSize(gl, panoramaCanvas, ps.w, ps.h);
      stitchIfNeeded(safe.w, safe.h, true);
      const fw = renderTexture.width, fh = renderTexture.height;

      const px = Math.max(1, Math.min(fw - 2, Math.round(nx * fw)));
      const py = Math.max(1, Math.min(fh - 2, Math.round((1 - ny) * fh)));
      const R = 8; // sample radius in pixels
      const bw = 2 * R + 1, bh = 2 * R + 1;
      const buf = new Uint8Array(bw * bh * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.readPixels(px - R, py - R, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      applyWbFromSample(buf);
    });

    if (enablePostBtn) {
      enablePostBtn.addEventListener('click', () => {
        postEnabled = !postEnabled;
        S360.settings.updatePostUI(ctx);
        S360.settings.scheduleLiveSave(ctx);
        if (currentImg) renderPano();
      });
    }

    if (saveGeoBtn) saveGeoBtn.addEventListener('click', () => {
      S360.settings.saveSnapshot(ctx);
      flashButton(saveGeoBtn);
    }, false);
    if (loadGeoBtn) loadGeoBtn.addEventListener('click', () => {
      if (S360.settings.loadSnapshot(ctx)) {
        S360.settings.updateUIFromConfig(ctx);
        S360.settings.updatePostUI(ctx);
        S360.settings.drawHdrBellChart(ctx);
        if (mirror3DBtn) mirror3DBtn.classList.toggle('active', cfg.mirror3D);
        if (currentImg) { scheduleContentAwareSeam(); markStitchDirty(); renderPano(); }
        if (S360.viewerShared.sphere) S360.renderSphere(ctx);
      }
      flashButton(loadGeoBtn);
    }, false);

    // Reset all trapezoid sliders to zero.
    const trapIds = [
      'RightLensRight','RightLensRightCenterV',
      'LeftLensLeft','LeftLensLeftCenterV',
      'LeftLenRight','LeftLensRightCenterV',
      'RightLensLeft','RightLensLeftCenterV'
    ];
    if (resetTrapBtn) resetTrapBtn.addEventListener('click', () => {
      for (const id of trapIds) {
        const el = document.getElementById(id);
        if (el) { el.value = 0; el.dispatchEvent(new Event('input')); }
      }
      flashButton(resetTrapBtn);
    }, false);

    if (saveHdrBtn) saveHdrBtn.addEventListener('click', () => {
      S360.settings.saveHdrSnapshot(ctx);
      flashButton(saveHdrBtn);
    }, false);
    if (loadHdrBtn) loadHdrBtn.addEventListener('click', () => {
      if (S360.settings.loadHdrSnapshot(ctx)) {
        S360.settings.updateUIFromConfig(ctx);
        S360.settings.drawHdrBellChart(ctx);
      }
      flashButton(loadHdrBtn);
    }, false);

    if (saveProcBtn) saveProcBtn.addEventListener('click', () => {
      S360.settings.saveProcSnapshot(ctx);
      flashButton(saveProcBtn);
    }, false);
    if (loadProcBtn) loadProcBtn.addEventListener('click', () => {
      if (S360.settings.loadProcSnapshot(ctx)) {
        S360.settings.updatePostUI(ctx);
        if (currentImg) renderPano();
      }
      flashButton(loadProcBtn);
    }, false);

    if (viewModeBtn) viewModeBtn.addEventListener('click', () => {
      S360.setViewMode(viewMode === '3d' ? '2d' : '3d', ctx);
    });
    panoramaCanvas.addEventListener('dblclick', e => {
      e.preventDefault();
      if (viewMode === '3d') {
        S360.setViewMode('2d', ctx);
        return;
      }

      // Convert the clicked point in the displayed 2:1 equirectangular image to
      // the sphere viewer's longitude/latitude convention. Top is north (+pitch).
      const rect = panoramaCanvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      const yaw = (nx - 0.5) * Math.PI * 2 * (cfg.mirror3D ? -1 : 1);
      const pitch = Math.max(-1.4, Math.min(1.4, (0.5 - ny) * Math.PI));

      S360.setViewMode('3d', ctx);
      const sphere = S360.viewerShared.sphere;
      if (sphere) {
        sphere.yaw = yaw;
        sphere.pitch = pitch;
        S360.renderSphere(ctx);
      }
    });

    if (x2Btn) {
      x2Btn.addEventListener('click', () => {
        scaleValue = scaleValue === 1 ? 2 : 1;
        x2Btn.classList.toggle('active', scaleValue === 2);
        S360.settings.saveLiveConfig(ctx);
      });
    }
    if (schematicBtn) {
      schematicBtn.addEventListener('click', () => {
        schematicMode = !schematicMode;
        schematicBtn.classList.toggle('active', schematicMode);
        updateCanvasCursor();
        if (currentImg) {
          markStitchDirty();
          if (schematicMode && viewMode === '3d') {
            S360.setViewMode('2d', ctx);
          } else {
            renderPano();
          }
        }
      });
    }
    // Clicking the lens schematic canvas toggles the large overlay.
    if (lensSchematicCanvas) {
      lensSchematicCanvas.style.cursor = 'zoom-in';
      lensSchematicCanvas.addEventListener('click', () => {
        const existing = document.getElementById('schematicOverlay');
        if (existing) {
          S360._schematicOverlayTarget = null;
          existing.remove();
          return;
        }
        const container = document.getElementById('resultContainer') || document.body;
        const overlay = document.createElement('div');
        overlay.id = 'schematicOverlay';
        // Style like the viewport content: sits inside the container, black bg.
        overlay.style.cssText = 'position:absolute;inset:0;z-index:100;background:#000;display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
        const bigCanvas = document.createElement('canvas');
        // Fill container width like panoramaCanvas does.
        bigCanvas.style.cssText = 'max-width:100%;height:auto;display:block;';
        const srcAspect = lensSchematicCanvas.width / lensSchematicCanvas.height;
        // Set internal resolution from container width × devicePixelRatio.
        const containerW = container.clientWidth || 800;
        const dpr = window.devicePixelRatio || 1;
        bigCanvas.width = Math.round(containerW * dpr);
        bigCanvas.height = Math.round(containerW / srcAspect * dpr);
        bigCanvas.style.width = containerW + 'px';
        bigCanvas.style.height = Math.round(containerW / srcAspect) + 'px';
        overlay.appendChild(bigCanvas);
        // Store reference so drawLensSchematic can update it live.
        const bCtx = bigCanvas.getContext('2d');
        S360._schematicOverlayTarget = { canvas: bigCanvas, ctx: bCtx };
        drawLensSchematic(S360._schematicOverlayTarget);
        overlay.addEventListener('click', () => {
          S360._schematicOverlayTarget = null;
          overlay.remove();
        });
        container.appendChild(overlay);
      });
    }
    if (seamBtn) {
      seamBtn.addEventListener('click', () => {
        showSeam = !showSeam;
        seamBtn.classList.toggle('active', showSeam);
        if (currentImg) { markStitchDirty(); renderPano(); }
      });
    }
    if (mirror3DBtn) {
      mirror3DBtn.addEventListener('click', () => {
        cfg.mirror3D = !cfg.mirror3D;
        mirror3DBtn.classList.toggle('active', cfg.mirror3D);
        if (S360.viewerShared.sphere) S360.renderSphere(ctx);
      });
    }

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
          if (viewMode === '3d') { S360.viewerShared.panoFullDirty = true; S360.refreshSphereFromTexture(ctx); }
          S360.settings.scheduleLiveSave(ctx);
        };
        img.src = URL.createObjectURL(file);
        wmImageLoader.value = '';
      });
    }

    if (wmRemoveBtn) {
      wmRemoveBtn.addEventListener('click', () => {
        wmLoaded = false;
        if (wmTex) { gl.deleteTexture(wmTex); wmTex = null; }
        if (viewMode === '3d') { S360.viewerShared.panoFullDirty = true; S360.refreshSphereFromTexture(ctx); }
        S360.settings.scheduleLiveSave(ctx);
      });
    }

    if (wmSizeSlider) {
      wmSizeSlider.addEventListener('input', (e) => {
        wmSize = parseFloat(e.target.value);
        if (wmSizeVal) wmSizeVal.textContent = wmSize.toFixed(2);
        if (wmLoaded && viewMode === '3d') { S360.viewerShared.panoFullDirty = true; S360.refreshSphereFromTexture(ctx); }
        S360.settings.scheduleLiveSave(ctx);
      });
    }

    if (wmRotSlider) {
      wmRotSlider.addEventListener('input', (e) => {
        wmRotDeg = parseFloat(e.target.value);
        if (wmRotVal) wmRotVal.textContent = String(Math.round(wmRotDeg));
        if (wmLoaded && viewMode === '3d') { S360.viewerShared.panoFullDirty = true; S360.refreshSphereFromTexture(ctx); }
        S360.settings.scheduleLiveSave(ctx);
      });
    }

    if (saveWmBtn) {
      saveWmBtn.addEventListener('click', () => {
        S360.settings.saveWmSnapshot(ctx);
        flashButton(saveWmBtn);
      });
    }
    if (loadWmBtn) {
      loadWmBtn.addEventListener('click', () => {
        if (S360.settings.loadWmSnapshot(ctx)) {
          S360.settings.updateWmUI(ctx);
          if (viewMode === '3d' && wmLoaded) { S360.viewerShared.panoFullDirty = true; S360.refreshSphereFromTexture(ctx); }
        }
      });
    }

    // Update toggle buttons (not part of sliderMap)
    if (mirror3DBtn) mirror3DBtn.classList.toggle('active', cfg.mirror3D);
    if (schematicBtn) schematicBtn.classList.toggle('active', schematicMode);
    if (seamBtn) seamBtn.classList.toggle('active', showSeam);
  }

  S360.settings.loadLiveConfig(ctx);
  initControlListeners();
  updateStitchedUI();
  S360.settings.updateUIFromConfig(ctx);
  S360.settings.updatePostUI(ctx);
  S360.settings.updateWmUI(ctx);
  S360.settings.drawHdrBellChart(ctx);
  drawLensSchematic();
  if (x2Btn) x2Btn.classList.toggle('active', scaleValue === 2);

  // ==========================================================================
  //  TOOLTIPS — descriptive hover text for every interactive control
  // ==========================================================================
  const tooltips = {
    chooseBtn:       'Load a dual-fisheye image (OO format) for stitching.',
    openStitchedBtn: 'Load an already-stitched equirectangular panorama (skips alignment).',
    hdrBtn:          'Merge multiple exposures into a single HDR image before stitching.',
    hdrStitchedBtn:  'HDR-merge already-stitched equirectangular panoramas.',
    blendBtn:        'Stack multiple frames for noise reduction, then stitch.',
    blendStitchedBtn:'Stack already-stitched equirectangular panoramas for noise reduction.',
    x2Btn:           'Toggle 2x upscaling - doubles the stitch resolution for sharper output.',
    downloadBtn:     'Export the stitched panorama as a lossless PNG.',
    downloadJpgBtn:  'Export as JPEG with Google Photo Sphere XMP metadata for 360° viewers.',
    viewModeBtn:     'Switch between 2D equirectangular and 3D spherical viewer.',
    exposure:        'Multiply all pixel values. 1.0 = no change; >1 brightens, <1 darkens.',
    gammaPP:         'Apply a gamma curve. 1.0 = linear; <1 brightens shadows, >1 darkens shadows.',
    contrast:        'Stretch or compress the tonal range around mid-grey.',
    saturation:      'Adjust colour intensity. 0 = greyscale, 1 = original, >1 = vivid.',
    sharpen:         'Unsharp mask strength. Adds edge contrast for perceived sharpness.',
    temperature:     'White-balance colour temperature in Kelvin. 6500 = neutral daylight.',
    enablePostBtn:   'Toggle the entire post-processing pipeline on or off.',
    saveProcBtn:     'Save the current post-processing settings as a preset.',
    loadProcBtn:     'Load a previously saved post-processing preset.',
    pickGrayBtn:     'Click a neutral-grey point on the panorama to auto white-balance.',
  };
  Object.entries(tooltips).forEach(([id, tip]) => {
    const el = document.getElementById(id);
    if (el) el.title = tip;
  });
  // Second batch — HDR, lens geometry, watermark, trapezoid, and profile controls.
  const tooltips2 = {
    hdrSigma:        'Width of the bell curve that weights well-exposed pixels. Smaller = tighter selection.',
    hdrBellCenter:   'Target brightness for the bell curve centre. 0.5 = mid-grey.',
    hdrBase:         'Minimum weight for every frame. 0 = only well-exposed pixels, 1 = equal average.',
    hdrEV:           'Exposure-value offset applied before fusion. Adjust if the merge looks too bright or dark.',
    saveHdrBtn:      'Save the current HDR settings as a preset.',
    loadHdrBtn:      'Load a previously saved HDR preset.',
    fovDeg:          'Lens field of view in degrees. Typically 180-220 for dual-fisheye lenses.',
    radiusScale:     'Lens radius as a fraction of the source image width. Adjust if the lens circle is cropped or loose.',
    centerL:         'Horizontal position of the left lens centre (0-1 normalised).',
    centerR:         'Horizontal position of the right lens centre (0-1 normalised).',
    seamWidth:       'Width of the seam blend zone (0-100). Wider = smoother transition but more ghosting risk.',
    seamShift:       'Manual offset of the automatic seam position. Positive shifts toward the left lens.',
    schematicBtn:    'Show the lens geometry overlay on the source image.',
    seamBtn:         'Highlight the seam blend zone in the stitched output.',
    mirror3DBtn:     'Mirror the 3D spherical view horizontally.',
    resetTrapBtn:    'Reset all trapezoid alignment sliders to zero.',
    exportProfileBtn:'Export the current lens calibration as a JSON file.',
    importProfileBtn:'Import a lens calibration JSON file.',
    RightLensRight:        'Right lens, right edge - raise/lower the trapezoid at the outer edge.',
    RightLensRightCenterV: 'Right lens, right edge - vertical offset of the centre point.',
    LeftLensLeft:          'Left lens, left edge - raise/lower the trapezoid at the outer edge.',
    LeftLensLeftCenterV:   'Left lens, left edge - vertical offset of the centre point.',
    LeftLenRight:          'Left lens, right edge (overlap side) - raise/lower the trapezoid.',
    LeftLensRightCenterV:  'Left lens, right edge - vertical offset of the centre point.',
    RightLensLeft:         'Right lens, left edge (overlap side) - raise/lower the trapezoid.',
    RightLensLeftCenterV:  'Right lens, left edge - vertical offset of the centre point.',
    wmBtn:           'Load a watermark image to overlay on the nadir (bottom) of the panorama.',
    wmRemoveBtn:     'Remove the loaded watermark.',
    wmSize:          'Watermark decal angular radius - how large the nadir decal appears.',
    wmRot:           'Watermark rotation angle in degrees.',
    saveWmBtn:       'Save the current watermark settings as a preset.',
    loadWmBtn:       'Load a previously saved watermark preset.',
    saveGeoBtn:      'Save the current lens geometry as a preset.',
    loadGeoBtn:      'Load a previously saved lens geometry preset.',
  };
  Object.entries(tooltips2).forEach(([id, tip]) => {
    const el = document.getElementById(id);
    if (el) el.title = tip;
  });

  // ==========================================================================
  //  WELCOME OVERLAY — shown on the canvas when no image is loaded
  // ==========================================================================
  const welcomeEl = document.createElement('div');
  welcomeEl.id = 'welcomeOverlay';
  welcomeEl.innerHTML = `
    <div style="text-align:center; padding:2rem;">
      <h2 style="margin:0 0 0.5rem; font-size:4rem; color:#e4e4e7;">StitchIT</h2>
      <p style="margin:0 0 1rem; font-size:1rem; color:#a1a1aa; line-height:1.5;">
        Browser-based dual-fisheye to equirectangular 360° stitcher.<br>
        All processing runs on the GPU - no upload to any server.
      </p>
      <p style="margin:0 0 1rem; font-size:1rem; color:#a1a1aa; line-height:1.5;">
        <button class="active">Open OO</button> - load a dual-fisheye source image<br><br>
        <button class="hdr-btn">HDR Merge OO</button> - merge multiple exposures first<br><br>
        <button class="primary">Merge OO</button> - stack frames for noise reduction
      </p>
      <p style="margin:0 0 0.5rem; font-size:1rem; color:#a1a1aa; line-height:1.5;">
        <button>Stitched</button> - use already stitched images instead of dual-fisheye ones
      </p>
      <p style="margin:0; font-size:1rem; color:#a1a1aa;">
        Double-click result to toggle 2D/3D. Drag to pan in 3D view.<br>
        Hover over any control for a tooltip explaining what it does.
      </p>
    </div>
  `;
  const resultContainer = document.getElementById('resultContainer');
  if (resultContainer) resultContainer.appendChild(welcomeEl);
  function updateWelcome() { if (welcomeEl) welcomeEl.style.display = currentImg ? 'none' : 'flex'; }
  updateWelcome();

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

  // Release the stored schematic background bitmap (ImageBitmap → .close()).
  function releaseSchematicBg() {
    if (S360._schematicBg && typeof S360._schematicBg.close === 'function') {
      try { S360._schematicBg.close(); } catch (_) {}
    }
    S360._schematicBg = null;
    invalidateSchematicBgCache();
  }

  // Disable lens-geometry / lens-calibration controls when the current source is
  // an already-stitched equirectangular pano (no fisheye projection is applied).
  // The Mirror toggle is a 3D-view preference, not lens geometry, so it stays on.
  function updateStitchedUI() {
    ['lensGeoGroup', 'leftLensGroup', 'rightLensGroup'].forEach(id => {
      const g = document.getElementById(id);
      if (!g) return;
      g.querySelectorAll('input, button').forEach(el => { el.disabled = isStitched; });
    });
    if (mirror3DBtn) mirror3DBtn.disabled = false;
  }

  if (imageLoader) imageLoader.addEventListener('change', onFile, false);
  if (downloadBtn) downloadBtn.addEventListener('click', onDownloadPng, false);
  if (downloadJpgBtn) downloadJpgBtn.addEventListener('click', onDownloadJpg, false);
  if (downloadLittlePlanetBtn) downloadLittlePlanetBtn.addEventListener('click', onDownloadLittlePlanet, false);
  if (lpModal) {
    lpModal.addEventListener('click', e => {
      if (e.target === lpModal) _closeLpModal();
    });
  }
  if (lpCancelBtn) {
    lpCancelBtn.addEventListener('click', _closeLpModal);
    lpCancelBtn.addEventListener('touchstart', e => { e.preventDefault(); _closeLpModal(); });
  }
  if (lpExportJpgBtn) {
    lpExportJpgBtn.addEventListener('click', _lpDoExportJpg);
    lpExportJpgBtn.addEventListener('touchstart', e => { e.preventDefault(); _lpDoExportJpg(); });
    if (lpExportPngBtn) {
      lpExportPngBtn.addEventListener('click', _lpDoExportPng);
      lpExportPngBtn.addEventListener('touchstart', e => { e.preventDefault(); _lpDoExportPng(); });
    }
  }
  if (lpModalCanvas) {
    lpModalCanvas.addEventListener('wheel', e => {
      e.preventDefault();
      if (_lpWheelTimer) clearTimeout(_lpWheelTimer);
      _lpWheelTimer = setTimeout(() => { _lpWheelTimer = null; _scheduleLpPreview(); }, 300);
      const rect = lpModalCanvas.getBoundingClientRect();
      const relY = (e.clientY - rect.top) / rect.height;
      const t = Math.max(0, Math.min(1, (relY - 0.4) / 0.2));
      const invert = 1 - 2 * t;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        _lpYaw += e.deltaX * 0.005 * invert;
      } else {
        const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
        _lpZoom *= factor;
        _lpZoom = Math.max(0.15, Math.min(1.5, _lpZoom));
      }
      _updateLpPreview();
    }, { passive: false });
    lpModalCanvas.addEventListener('mousedown', e => {
      _lpDragging = true;
      const rect = lpModalCanvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      _lpPrevAngle = Math.atan2(e.clientX - cx, -(e.clientY - cy));
      _lpInitialYaw = _lpYaw;
      lpModalCanvas.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', e => {
      if (!_lpDragging) return;
      const rect = lpModalCanvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const currentAngle = Math.atan2(e.clientX - cx, -(e.clientY - cy));
      let delta = currentAngle - _lpPrevAngle;
      if (delta > Math.PI) delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;
      _lpYaw -= delta;
      _lpPrevAngle = currentAngle;
      _updateLpPreview();
    });
    window.addEventListener('mouseup', () => {
      if (_lpDragging) {
        _lpDragging = false;
        if (lpModalCanvas) lpModalCanvas.style.cursor = 'grab';
        _scheduleLpPreview();
      }
    });
    lpModalCanvas.addEventListener('touchstart', e => {
      if (e.touches.length === 1) {
        _lpDragging = true;
        const rect = lpModalCanvas.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const t = e.touches[0];
        _lpPrevAngle = Math.atan2(t.clientX - cx, -(t.clientY - cy));
        _lpInitialYaw = _lpYaw;
      }
    }, { passive: true });
    lpModalCanvas.addEventListener('touchmove', e => {
      if (!_lpDragging || e.touches.length !== 1) return;
      const rect = lpModalCanvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const t = e.touches[0];
      const currentAngle = Math.atan2(t.clientX - cx, -(t.clientY - cy));
      let delta = currentAngle - _lpPrevAngle;
      if (delta > Math.PI) delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;
      _lpYaw -= delta;
      _lpPrevAngle = currentAngle;
      _updateLpPreview();
    }, { passive: true });
    lpModalCanvas.addEventListener('touchend', () => { _lpDragging = false; _scheduleLpPreview(); });
  }
  if (exportProfileBtn) exportProfileBtn.addEventListener('click', () => {
    const profile = S360.settings.createCalibrationProfile(cfg);
    const blob = new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' });
    triggerDownload(blob, `${lastBaseName || 'camera'}-profile.json`);
  });
  if (importProfileBtn && profileLoader) importProfileBtn.addEventListener('click', () => profileLoader.click());
  if (profileLoader) profileLoader.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const profile = JSON.parse(await file.text());
      S360.settings.applyCalibrationProfile(cfg, profile);
      S360.settings.updateUIFromConfig(ctx);
      S360.settings.scheduleLiveSave(ctx);
      drawLensSchematic();
      if (currentImg) currentGainR = estimateCurrentGain();
      if (currentImg) scheduleContentAwareSeam();
      markStitchDirty(); renderPano();
    } catch (err) {
      alert('Profile import failed: ' + (err?.message || err));
    } finally {
      profileLoader.value = '';
    }
  });

  // ===========================================================================
  //  IMAGE LOADING & STITCHING ENTRYPOINT
  // ===========================================================================

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const jobId = beginJob();
    isStitched = false;
    updateStitchedUI();
    setActionsVisible(false);
    lastBaseName = (file.name || 'panorama').replace(/\.[^.]+$/, '');
    
    try {
      setLoading(true, 'Reading source image file...');
      let img = await loadImageFromFile(file);
      throwIfJobCancelled(jobId);
      img = scaleSource(gl, img, scaleValue, MAX_TEX_SIZE); // 2x upscale if X2 is on
      throwIfJobCancelled(jobId);

      // Clamp the longest side to the GPU max so neither width nor height can
      // overflow MAX_TEX_SIZE (the old check only guarded width).
      const MAX_SOURCE_DIM = MAX_TEX_SIZE;
      const longest = Math.max(img.width, img.height);
      if (longest > MAX_SOURCE_DIM) {
        const scale = MAX_SOURCE_DIM / longest;
         const off = document.createElement('canvas');
         off.width = Math.round(img.width * scale);
         off.height = Math.round(img.height * scale);
         const ctx2d = off.getContext('2d');
         ctx2d.drawImage(img, 0, 0, off.width, off.height);
         img = off;
      }

      setLoading(true, 'Stitching panorama in WebGL...');
      currentImg = img;
      releaseSchematicBg();

      S360.settings.updateUIFromConfig(ctx);
      S360.settings.scheduleLiveSave(ctx);
      drawLensSchematic();

      setLoading(true, 'Stitching panorama in WebGL...');
      uploadTexture(img);
      await new Promise(requestAnimationFrame);
      renderPano();
      setActionsVisible(true);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      console.error(err);
      alert('Stitching failed: ' + (err?.message || err));
    } finally {
      if (!isJobCancelled(jobId)) setLoading(false);
    }
  }

  // ===========================================================================
  //  WEBGL PIPELINE & SHADERS
  // ===========================================================================

  // Pure size math: clamps to the GPU's max texture/viewport dimensions and
  // keeps a 2:1 equirect aspect with even edges. No canvas side effects, so
  // this is safe to reuse for off-screen render targets too.


  // Clamps the requested size to the GPU's max render-target dimensions and sets
  // the *visible* canvas to that size.
  //
  // IMPORTANT: MAX_TEXTURE_SIZE / MAX_VIEWPORT_DIMS describe the GPU's texture
  // limits, but NOT what the browser will actually allocate as the on-screen
  // canvas's backing store ("drawing buffer"). Per the WebGL spec, drawingBufferWidth/
  // drawingBufferHeight "may differ" from canvas.width/height whenever the
  // implementation can't satisfy the requested size (this is common for very
  // large canvases). When that happens,
  // gl.viewport(0,0,w,h) sized off the *requested* dimensions only fills the
  // browser-granted bottom-left drawingBufferWidth x drawingBufferHeight portion
  // of the canvas, leaving the rest blank — which is exactly the "~60-70% of
  // the image, anchored at the bottom-left" artifact seen exporting/opening the
  // 3D view at HD (2x) resolution. Re-clamping against the real drawing buffer
  // here closes that gap for the on-screen canvas. Full-resolution export and
  // the 3D viewer now additionally avoid the on-screen canvas entirely (see
  // renderOffscreenPixels) so they aren't limited by this cap at all.


  // The live 2D preview is capped so dragging sliders stays responsive on very
  // large sources; the 3D viewer and export still render at full source resolution.
  const PREVIEW_MAX_W = 4096;
  function computePreviewSize() {
    if (!currentImg) return { w: 2, h: 1 };
    let maxW = PREVIEW_MAX_W;
    // Dynamically reduce preview resolution when memory is tight.
    // Estimate the working set: source + LF + stitch(preview) + lumBlur(preview).
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
    const w = Math.min(currentImg.width, maxW);
    const h = Math.round(w / 2);
    return { w, h };
  }

  function renderPano(requestedW = null, requestedH = null, coarse = false) {
    if (!currentImg) return;
    // A direct full-resolution render supersedes any pending progressive fine pass.
    if (!coarse && _progressiveFineTimer) { clearTimeout(_progressiveFineTimer); _progressiveFineTimer = null; }
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
      // 3D view always renders at full source resolution — skip progressive.
      const fullW0 = Math.min(currentImg.width, MAX_TEX_SIZE);
      const fullH0 = Math.round(fullW0 / 2);
      const { w, h } = clampToGpuLimits(gl, fullW0, fullH0);
      const needRealloc = !renderTexture ||
                          renderTexture.width !== w ||
                          renderTexture.height !== h ||
                          !gl.isTexture(renderTexture);
      if (needRealloc) { markStitchDirty(); }
      stitchIfNeeded(w, h, true);
      S360.viewerShared.panoFullDirty = true;
      S360.scheduleViewerUpdate(ctx);
      return;
    }

    // Ensure canvas is at full target resolution (stays fixed across coarse/fine
    // passes so there is no resize flicker between them).
    const safe = getSafeRenderSize(gl, panoramaCanvas, panoW, panoH);
    panoW = safe.w;
    panoH = safe.h;

    if (coarse) {
      // ---- PROGRESSIVE COARSE PASS ----
      // Stitch at 1/4 the target resolution (1/16th the pixels) for instant
      // feedback, then draw it upscaled to the full canvas.  The GPU's bilinear
      // texture filtering produces a clean upscale at near-zero cost.
      const cw = Math.max(256, Math.round(panoW / PROGRESSIVE_COARSE_DIV));
      const ch = Math.round(cw / 2);

      // Stitch at coarse resolution into the offscreen FBO.
      stitchIfNeeded(cw, ch);

      if (postEnabled && !schematicMode) {
        // Apply post-processing: read from the coarse stitch texture (LINEAR
        // filtering upscales to full viewport) and write to the full canvas.
        if (!postProgram) {
          postProgram = createPostProgram(gl);
          postProgram._u = {
            u_texture:    gl.getUniformLocation(postProgram, 'u_texture'),
            u_temp:       gl.getUniformLocation(postProgram, 'u_temp'),
            u_exposure:   gl.getUniformLocation(postProgram, 'u_exposure'),
            u_gamma:      gl.getUniformLocation(postProgram, 'u_gamma'),
            u_sharpen:    gl.getUniformLocation(postProgram, 'u_sharpen'),
            u_saturation: gl.getUniformLocation(postProgram, 'u_saturation'),
            u_contrast:   gl.getUniformLocation(postProgram, 'u_contrast'),
            u_blurLum:    gl.getUniformLocation(postProgram, 'u_blurLum'),
          };
        }
        gl.useProgram(postProgram);
        gl.bindVertexArray(getQuadVAO(gl));
        const u = postProgram._u;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, renderTexture);
        gl.uniform1i(u.u_texture, 0);
        gl.uniform1f(u.u_temp, postUniforms.temperature);
        gl.uniform1f(u.u_exposure, postUniforms.exposure);
        gl.uniform1f(u.u_gamma, postUniforms.gamma);
        gl.uniform1f(u.u_sharpen, postUniforms.sharpen);
        gl.uniform1f(u.u_saturation, postUniforms.saturation);
        gl.uniform1f(u.u_contrast, postUniforms.contrast);
        const blur = S360.ensureLumBlur(gl, renderTexture, cw, ch, postUniforms.exposure, postUniforms.gamma);
        gl.useProgram(postProgram);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, blur.tex);
        gl.uniform1i(u.u_blurLum, 1);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, renderTexture);
        gl.uniform1i(u.u_texture, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, panoW, panoH); // full canvas — GPU upscales the coarse texture
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      } else {
        // No post-processing: blit the coarse stitch FBO directly to the canvas.
        // gl.blitFramebuffer with LINEAR gives hardware-accelerated bilinear
        // upscale with no Y-flip (unlike the copy shader which is source-oriented).
        const prevVp = gl.getParameter(gl.VIEWPORT);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
        gl.blitFramebuffer(0, 0, cw, ch, 0, 0, panoW, panoH, gl.COLOR_BUFFER_BIT, gl.LINEAR);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(prevVp[0], prevVp[1], prevVp[2], prevVp[3]);
      }

      // The fine pass will re-stitch at full resolution because stitchIfNeeded()
      // detects the size mismatch (renderTexture.width !== fullW).  Just return;
      // the settle timer triggers the fine render shortly.
      return;
    }

     // ---- FULL RESOLUTION PASS ----
     if (postEnabled && !schematicMode) {
       renderWithPostProcessing(panoW, panoH);
     } else if (isStitched) {
       copyStitched(panoW, panoH, null);
       _fboValid = false; // post-off path draws straight to canvas; FBO is now stale
     } else {
       // Ensure the LF texture is available before the stitch shader binds it.
       if (!lfTex && currentTexture && currentImg) buildLFTexture();
        stitchWebGL(currentImg.width, currentImg.height, panoW, panoH, null, false);
        _fboValid = false; // post-off path draws straight to canvas; FBO is now stale
      }

    S360.scheduleViewerUpdate(ctx);
  }

  // Coalesces rapid slider-driven renders: the first frame shows a fast low-res
  // preview (coarse pass), then after PROGRESSIVE_SETTLE_MS of inactivity the
  // full-resolution result is rendered (fine pass).  Each new input cancels the
  // pending fine render so only the latest state is refined.
  function scheduleRender() {
    // Cancel any pending fine render — new input invalidates it.
    if (_progressiveFineTimer) { clearTimeout(_progressiveFineTimer); _progressiveFineTimer = null; }
    if (_renderScheduled) return;
    _renderScheduled = true;
    requestAnimationFrame(() => {
      _renderScheduled = false;
      renderPano(null, null, true); // coarse pass — fast preview
    });
    // Schedule the full-quality render after the user stops interacting.
    _progressiveFineTimer = setTimeout(() => {
      _progressiveFineTimer = null;
      if (currentImg) renderPano(null, null, false); // fine pass — full preview
    }, PROGRESSIVE_SETTLE_MS);
  }

  // Sets the canvas cursor based on the current interaction mode.
  function updateCanvasCursor() {
    if (!panoramaCanvas) return;
    if (viewMode === '3d') {
      panoramaCanvas.style.cursor = 'grab';
    } else if (schematicMode || wbSampling) {
      panoramaCanvas.style.cursor = 'crosshair';
    } else {
      panoramaCanvas.style.cursor = '';
    }
  }

  // ---- GPU memory pressure response ----
  // Called by the global memory tracker when a large allocation would exceed the
  // VRAM budget.  Cascade through non-essential caches, cheapest-to-rebuild
  // first, to free GPU memory without destroying the source or stitch textures.
  function _shedNonEssentials(_gl, _needed) {
    let freed = 0;
    let stitchDirty = false;
    // 1. Lum blur cache — cheapest to rebuild (just re-renders two blur passes).
    //    invalidateBlurCache is defined in webgl-utils.js's closure and handles
    //    its own _lumBlur tracking + deletion.
    if (S360.invalidateBlurCache) {
      const e = S360.gpuMem ? S360.gpuMem.getEntry('lumBlur') : null;
      if (e) freed += e.bytes;
      S360.invalidateBlurCache(_gl);
    }
    // 2. LF texture — force a rebuild on the next stitch so stale data is
    //    discarded.  The pool still owns the GPU textures (no bytes freed yet);
    //    pool LRU eviction handles the actual deallocation.
   if (lfTex) {
       lfTex = null; lfFbo = null;
       lfTmpTex = null; lfTmpFbo = null;
       stitchDirty = true;
       console.log(`🎮 Shed LF texture refs (will rebuild on next stitch)`);
     }
    // 3. Watermark FBO (export compositing target) — only needed during export.
    if (wmFbo) {
      const bytes = wmFboW * wmFboH * 4;
      _gl.deleteTexture(wmFboTex); _gl.deleteFramebuffer(wmFbo);
      wmFbo = null; wmFboTex = null; wmFboW = 0; wmFboH = 0;
      if (S360.gpuMem) S360.gpuMem.untrack('wmExportFBO');
      freed += bytes;
      console.log(`🎮 Shed watermark export FBO: freed ${(bytes / 1048576).toFixed(1)} MiB`);
    }
   // 4. Viewer full-res textures — only needed while in 3D view with watermark.
     if (S360.viewerShared) {
       const S = S360.viewerShared;
       const wmW = S.panoFullW || 0;
       const wmH = S.panoFullH || 0;
       if (S.panoFullTex) {
         const bytes = wmW * wmH * 4;
         _gl.deleteTexture(S.panoFullTex); _gl.deleteFramebuffer(S.panoFullFbo);
         S.panoFullTex = null; S.panoFullFbo = null; S.panoFullW = 0; S.panoFullH = 0;
         freed += bytes;
         stitchDirty = true;
         console.log(`🎮 Shed viewer full-res: freed ${(bytes / 1048576).toFixed(1)} MiB`);
       }
       if (S.panoWMTex) {
         // panoFullW/H may have been zeroed above, so use the snapshot captured
         // before that block.
         const bytes = wmW * wmH * 4;
         _gl.deleteTexture(S.panoWMTex); _gl.deleteFramebuffer(S.panoWMFbo);
         S.panoWMTex = null; S.panoWMFbo = null;
         freed += bytes;
         console.log(`🎮 Shed viewer watermarked: freed ${(bytes / 1048576).toFixed(1)} MiB`);
       }
    }
    if (stitchDirty) {
      _stitchDirty = true; // force re-stitch only when stitch-relevant caches were shed
    }
    if (freed > 0) {
      console.log(`🎮 Total shed: ${(freed / 1048576).toFixed(1)} MiB`);
    }
  }

  // Marks the cached offscreen stitch as invalid so the next render re-stitches.
  function markStitchDirty() {
    _stitchDirty = true;
    _fboValid = false;
  }

  // Builds a half-resolution blurred copy of the source texture (two separable
  // passes) so the stitch shader can fetch the LF layer with one texture read
  // instead of performing a 13-tap blur per pixel.
  function buildLFTexture() {
    if (!currentTexture || !currentImg) return;
    const lfW = Math.max(1, currentImg.width >> 1);
    const lfH = Math.max(1, currentImg.height >> 1);

    const pooled = getPooledLF(gl, lfW, lfH);
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
    gl.bindVertexArray(getQuadVAO(gl));
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
    // Untrack old stitch FBO before overwriting (the pooled entry handles its
    // own lifecycle, but we track the *active* stitch target separately).
    if (S360.gpuMem) S360.gpuMem.untrack('stitchFBO');
    const pooled = getPooledFBO(gl, panoW, panoH);
    renderTexture = pooled.tex;
    framebuffer = pooled.fbo;
    renderTexture.width = panoW;
    renderTexture.height = panoH;
    if (S360.gpuMem) S360.gpuMem.track('stitchFBO', panoW * panoH * 4, `Stitch target ${panoW}×${panoH}`);
  }

  // 1:1 copy of an already-stitched (equirectangular) source into the stitch
  // target. No fisheye projection — just a Y-flip so the equirect matches the
  // orientation the sphere/export expect (north pole at the top of the FBO, see
  // readFboToCanvas()'s flip). Used when isStitched is true.
  let copyProgram = null;
  let _littlePlanetProg = null;
  function copyStitched(panoW, panoH, targetFbo) {
    if (!copyProgram) {
      copyProgram = createProgram(gl, COPY_VS, COPY_FS);
      copyProgram._u = { u_tex: gl.getUniformLocation(copyProgram, 'u_tex') };
    }
    gl.useProgram(copyProgram);
    gl.bindVertexArray(getQuadVAO(gl));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, currentTexture);
    gl.uniform1i(copyProgram._u.u_tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo || null);
    gl.viewport(0, 0, panoW, panoH);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Re-stitches the source into the offscreen FBO only when geometry/lens/size
  // changed, so cheap post-processing passes never pay for a full re-stitch.
  function stitchIfNeeded(panoW, panoH, forceNormal = false) {
     const needRealloc = !renderTexture || renderTexture.width !== panoW || renderTexture.height !== panoH || !gl.isTexture(renderTexture);
     if (needRealloc || !_fboValid || _stitchDirty) {
       if (needRealloc) allocateStitchTarget(panoW, panoH);
       // Rebuild the LF (low-frequency blur) texture if it was shed by the memory
       // manager or never built — the stitch shader binds it as a required sampler.
       if (!lfTex && currentTexture && currentImg) buildLFTexture();
       gl.viewport(0, 0, panoW, panoH);
      if (isStitched) copyStitched(panoW, panoH, framebuffer);
      else stitchWebGL(currentImg.width, currentImg.height, panoW, panoH, true, forceNormal);
      _fboValid = true;
      _stitchDirty = false;
    }
  }

  function renderWithPostProcessing(panoW, panoH, targetFbo = null, forceNormal = false) {
    stitchIfNeeded(panoW, panoH, forceNormal);

    const prevFb = _boundFbo;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
    _boundFbo = targetFbo;
    gl.viewport(0, 0, panoW, panoH);

    if (!postProgram) {
      postProgram = createPostProgram(gl);
      // Cache uniform locations once
      postProgram._u = {
        u_texture:    gl.getUniformLocation(postProgram, 'u_texture'),
        u_temp:       gl.getUniformLocation(postProgram, 'u_temp'),
        u_exposure:   gl.getUniformLocation(postProgram, 'u_exposure'),
        u_gamma:      gl.getUniformLocation(postProgram, 'u_gamma'),
        u_sharpen:    gl.getUniformLocation(postProgram, 'u_sharpen'),
        u_saturation: gl.getUniformLocation(postProgram, 'u_saturation'),
        u_contrast:   gl.getUniformLocation(postProgram, 'u_contrast'),
        u_blurLum:    gl.getUniformLocation(postProgram, 'u_blurLum'),
      };
    }
    gl.useProgram(postProgram);
    gl.bindVertexArray(getQuadVAO(gl));

    const u = postProgram._u;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, renderTexture);
    gl.uniform1i(u.u_texture, 0);
    gl.uniform1f(u.u_temp, postUniforms.temperature);
    gl.uniform1f(u.u_exposure, postUniforms.exposure);
    gl.uniform1f(u.u_gamma, postUniforms.gamma);
    gl.uniform1f(u.u_sharpen, postUniforms.sharpen);
    gl.uniform1f(u.u_saturation, postUniforms.saturation);
    gl.uniform1f(u.u_contrast, postUniforms.contrast);

    // Bind the cached half-res luminance blur used by the unsharp mask.
    const blur = S360.ensureLumBlur(gl, renderTexture, panoW, panoH, postUniforms.exposure, postUniforms.gamma);
    // ensureLumBlur binds its own blur program — re-select the post program
    // before touching its uniforms or drawing.
    gl.useProgram(postProgram);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, blur.tex);
    gl.uniform1i(u.u_blurLum, 1);
    // Defence-in-depth: assert the colour-sampler binding and viewport RIGHT
    // before the draw (a previous leak let the blur helper's intermediate
    // texture linger on unit 0, producing a blurry grayscale frame).
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, renderTexture);
        gl.uniform1i(u.u_texture, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    _boundFbo = prevFb;
  }

  // -------------------------------------------------------------------------
  //  LENS SCHEMATIC PREVIEW
  //  Small canvas under Lens Geometry showing the dual-fisheye source with
  //  line-art overlays: lens circles, trapezoid edges, and seam lines.
  // -------------------------------------------------------------------------
  function invalidateSchematicBgCache() {
    schematicBgCacheValid = false;
    if (schematicBgCache) {
      const c = schematicBgCache;
      schematicBgCache = null;
      c.width = 0; c.height = 0;
    }
  }

  function buildSchematicBgCache(W, H) {
    const cache = document.createElement('canvas');
    cache.width = W; cache.height = H;
    const ctx2d = cache.getContext('2d');
    ctx2d.fillStyle = '#000';
    ctx2d.fillRect(0, 0, W, H);

    const bgImg = (currentImg && currentImg.width > 0 && currentImg.height > 0 && !currentImg.isGpuImage)
      ? currentImg : S360._schematicBg;
    if (bgImg && bgImg.width > 0 && bgImg.height > 0) {
      const srcAspect = bgImg.width / bgImg.height;
      const cvsAspect = W / H;
      let dw, dh, dx, dy;
      if (srcAspect > cvsAspect) { dw = W; dh = W / srcAspect; dx = 0; dy = (H - dh) / 2; }
      else { dh = H; dw = H * srcAspect; dx = (W - dw) / 2; dy = 0; }
      ctx2d.drawImage(bgImg, dx, dy, dw, dh);
    }

    // Grid lines at 0.25 and 0.75 (static).
    ctx2d.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx2d.lineWidth = 1;
    ctx2d.setLineDash([4, 4]);
    ctx2d.beginPath();
    ctx2d.moveTo(W * 0.25, 0); ctx2d.lineTo(W * 0.25, H);
    ctx2d.moveTo(W * 0.75, 0); ctx2d.lineTo(W * 0.75, H);
    ctx2d.stroke();
    ctx2d.setLineDash([]);

    schematicBgCache = cache;
    schematicBgCacheValid = true;
  }

  function drawLensSchematic(target) {
    const c = target ? target.canvas : lensSchematicCanvas;
    if (!c) return;
    const ctx2d = target ? target.ctx : c.getContext('2d');
    const W = c.width, H = c.height;

    if (!schematicBgCacheValid || !schematicBgCache || schematicBgCache.width !== W || schematicBgCache.height !== H) {
      buildSchematicBgCache(W, H);
    }

    ctx2d.clearRect(0, 0, W, H);
    if (schematicBgCache) ctx2d.drawImage(schematicBgCache, 0, 0);

    // Source-image geometry (normalised 0-1).
    const cxL = cfg.centers.left[0],  cyL = cfg.centers.left[1];
    const cxR = cfg.centers.right[0], cyR = cfg.centers.right[1];
    const rNorm = cfg.radiusScale * 0.25;  // normalised radius (width fraction)

    const sx = W, sy = H;
    const lw = 1 + (W / 280 - 1) * 0.15;  // thumbnail=1, overlay scaled to ~¼
    const toX = nx => nx * sx;
    const toY = ny => (1 - ny) * sy;

    function drawLens(cx, cy, hLL, hLR, cLL, cLR) {
      // Outer circle (green = radius scale).
      ctx2d.strokeStyle = '#22c55e';
      ctx2d.lineWidth = 2 * lw;
      ctx2d.beginPath();
      ctx2d.arc(toX(cx), toY(cy), rNorm * sx, 0, Math.PI * 2);
      ctx2d.stroke();

      // FOV reference circle (orange = FOV).
      const fovR = rNorm * sx * (cfg.fovDeg / 180);
      ctx2d.strokeStyle = '#f59e0b';
      ctx2d.setLineDash([3 * lw, 3 * lw]);
      ctx2d.beginPath();
      ctx2d.arc(toX(cx), toY(cy), fovR, 0, Math.PI * 2);
      ctx2d.stroke();
      ctx2d.setLineDash([]);

      // Trapezoid edges — top and bottom outlines.
      const trapR = fovR * 1.01;  // slightly larger than FOV circle
      const nSegs = 64;
      const topPts = [], botPts = [];
      for (let i = 0; i <= nSegs; i++) {
        const az = -Math.PI / 2 + Math.PI * i / nSegs;
        const sinAz = Math.sin(az), cosAz = Math.cos(az);
        const ht = (sinAz + 1) * 0.5;
        const rawHf = (1 - ht) * hLL + ht * hLR;
        const hf = 1.0 + (rawHf - 1.0) * 4;  // 4× amplified
        const wL = Math.pow(Math.max(0, 1 - 2 * ht), 3);
        const wR = Math.pow(Math.max(0, 2 * ht - 1), 3);
        const co = cLL * wL + cLR * wR;
        const dx = sinAz * trapR;
        const dyTop = -(cosAz * trapR / hf) + co * trapR * 0.01;
        const dyBot = (cosAz * trapR / hf) + co * trapR * 0.01;
        topPts.push([toX(cx) + dx, toY(cy) + dyTop]);
        botPts.push([toX(cx) + dx, toY(cy) + dyBot]);
      }

      // Trapezoid outline (accent blue).
      ctx2d.strokeStyle = '#3b82f6';
      ctx2d.lineWidth = 2 * lw;
      ctx2d.beginPath();
      topPts.forEach((p, i) => i === 0 ? ctx2d.moveTo(p[0], p[1]) : ctx2d.lineTo(p[0], p[1]));
      ctx2d.stroke();
      ctx2d.beginPath();
      botPts.forEach((p, i) => i === 0 ? ctx2d.moveTo(p[0], p[1]) : ctx2d.lineTo(p[0], p[1]));
      ctx2d.stroke();
    }

    drawLens(cxL, cyL, cfg.height.ll / 100, cfg.height.lr / 100,
             cfg.centerOffset.ll, cfg.centerOffset.lr);
    drawLens(cxR, cyR, cfg.height.rl / 100, cfg.height.rr / 100,
             cfg.centerOffset.rl, cfg.centerOffset.rr);

    // Also render to the overlay if it's open (live updates when sliders change).
    // Only recurse from the thumbnail draw, not from the overlay draw itself.
    if (!target && S360._schematicOverlayTarget) drawLensSchematic(S360._schematicOverlayTarget);
  }

  function uploadTexture(img) {
    // Release the luminance-blur cache FIRST — while its objects are guaranteed
    // alive and before resetPools()' deletions can let WebGL recycle their
    // names onto newly created textures (which would make a later delete-by-
    // cached-wrapper destroy the new stitch texture).
    if (S360.invalidateBlurCache) S360.invalidateBlurCache(gl);
    // New source: drop the size-keyed FBO/texture pools so a different image
    // doesn't accumulate several full-resolution RGBA8 surfaces per size.
    resetPools(gl);
    // Untrack the old source texture and stitch FBO.
    if (S360.gpuMem) {
      S360.gpuMem.untrack('srcTexture');
      S360.gpuMem.untrack('stitchFBO');
    }
    renderTexture = null;
    framebuffer = null;
    schematicGuideX = -1.0; // guide is per-file/session
    schematicGuideY = -1.0;
    invalidateSchematicBgCache();
    // Recreate texture at correct size — texStorage2D allocates immutable storage
    // so we must re-create if dimensions change.
    if (currentTexture) gl.deleteTexture(currentTexture);
    currentGainR = estimateGainRFromSource(gl, img, cfg);
    updateContentAwareSeam(img);
    if (img?.isGpuImage) {
      currentTexture = img.takeTexture();
    } else {
      currentTexture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, currentTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, img.width, img.height);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, img);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, currentTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Register the source texture with the global memory tracker.
    if (S360.gpuMem) {
      const srcBytes = img.width * img.height * 4;
      S360.gpuMem.track('srcTexture', srcBytes, `Source ${img.width}×${img.height}`);
    }
    buildLFTexture();
    _stitchDirty = true;
    _fboValid = false;
    S360.viewerShared.panoFullDirty = true; // full-res sphere texture must be rebuilt for the new source
    // A new source invalidates the cached watermarked full-res texture — its
    // pixels now belong to the previous image.
    if (S360.viewerShared.panoWMTex) { gl.deleteTexture(S360.viewerShared.panoWMTex); S360.viewerShared.panoWMTex = null; }
    if (S360.viewerShared.panoWMFbo) { gl.deleteFramebuffer(S360.viewerShared.panoWMFbo); S360.viewerShared.panoWMFbo = null; }
    if (S360.viewerShared.panoFullTex) { gl.deleteTexture(S360.viewerShared.panoFullTex); S360.viewerShared.panoFullTex = null; }
    if (S360.viewerShared.panoFullFbo) { gl.deleteFramebuffer(S360.viewerShared.panoFullFbo); S360.viewerShared.panoFullFbo = null; }
    S360.viewerShared.panoFullW = 0; S360.viewerShared.panoFullH = 0;
    // Log memory usage after source upload.
    if (S360.gpuMem) {
      const pressure = S360.gpuMem.pressure();
      console.log(`🎮 After upload: ${(S360.gpuMem.total() / 1048576).toFixed(0)} MiB / ${(S360.gpuMem.budget() / 1048576).toFixed(0)} MiB (${(pressure * 100).toFixed(0)}%)`);
      if (pressure > 0.85) console.warn(`⚠️ GPU memory at ${(pressure * 100).toFixed(0)}% — context loss risk. Consider reducing source resolution.`);
    }
    updateWelcome();
  }

  // Cached lens-basis vectors — only recomputed when roll angles change.
  let _cachedRollL = null, _cachedRollR = null, _cachedLb = null, _cachedRb = null;

  function stitchWebGL(srcW, srcH, panoW, panoH, renderTarget = null, forceNormal = false) {
    if (!glProgram) {
      glProgram = createProgram(gl, VS_SOURCE, FS_SOURCE);
      // Cache uniform locations once at program creation
      glProgram._u = {
        u_image:       gl.getUniformLocation(glProgram, 'u_image'),
        u_imageLF:     gl.getUniformLocation(glProgram, 'u_imageLF'),
        u_seamCurve:   gl.getUniformLocation(glProgram, 'u_seamCurve'),
        u_gainR:       gl.getUniformLocation(glProgram, 'u_gainR'),
        u_showSeam:    gl.getUniformLocation(glProgram, 'u_showSeam'),
        u_srcSize:     gl.getUniformLocation(glProgram, 'u_srcSize'),
        u_centersL:    gl.getUniformLocation(glProgram, 'u_centersL'),
        u_centersR:    gl.getUniformLocation(glProgram, 'u_centersR'),
        u_radius:      gl.getUniformLocation(glProgram, 'u_radius'),
        u_halfFov:     gl.getUniformLocation(glProgram, 'u_halfFov'),
        u_f:           gl.getUniformLocation(glProgram, 'u_f'),
        u_hfBandWidth: gl.getUniformLocation(glProgram, 'u_hfBandWidth'),
        u_seamShift:       gl.getUniformLocation(glProgram, 'u_seamShift'),
        u_axisL:       gl.getUniformLocation(glProgram, 'u_axisL'),
        u_upL:         gl.getUniformLocation(glProgram, 'u_upL'),
        u_rightL:      gl.getUniformLocation(glProgram, 'u_rightL'),
        u_axisR:       gl.getUniformLocation(glProgram, 'u_axisR'),
        u_upR:         gl.getUniformLocation(glProgram, 'u_upR'),
        u_rightR:      gl.getUniformLocation(glProgram, 'u_rightR'),
        u_heightLL:      gl.getUniformLocation(glProgram, 'u_heightLL'),
        u_heightLR:      gl.getUniformLocation(glProgram, 'u_heightLR'),
        u_heightRL:      gl.getUniformLocation(glProgram, 'u_heightRL'),
        u_heightRR:      gl.getUniformLocation(glProgram, 'u_heightRR'),
        u_centerLL:      gl.getUniformLocation(glProgram, 'u_centerLL'),
        u_centerLR:      gl.getUniformLocation(glProgram, 'u_centerLR'),
        u_centerRL:      gl.getUniformLocation(glProgram, 'u_centerRL'),
        u_centerRR:      gl.getUniformLocation(glProgram, 'u_centerRR'),
        u_schematicMode: gl.getUniformLocation(glProgram, 'u_schematicMode'),
        u_rollL:         gl.getUniformLocation(glProgram, 'u_rollL'),
        u_rollR:         gl.getUniformLocation(glProgram, 'u_rollR'),
        u_guideOn:       gl.getUniformLocation(glProgram, 'u_guideOn'),
        u_guidePos:      gl.getUniformLocation(glProgram, 'u_guidePos'),
      };
    }
    gl.useProgram(glProgram);

    // Bind VAO once — includes quad vertex data
    gl.bindVertexArray(getQuadVAO(gl));

    const prevFb = _boundFbo;
    gl.bindFramebuffer(gl.FRAMEBUFFER, renderTarget ? framebuffer : null);
    _boundFbo = renderTarget ? framebuffer : null;

    // Bind textures to units
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, currentTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lfTex);
    if (!seamTexture) uploadSeamCurve();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, seamTexture);

    const u = glProgram._u;
    gl.uniform1i(u.u_image, 0);
    gl.uniform1i(u.u_imageLF, 1);
    gl.uniform1i(u.u_seamCurve, 2);

    const gainR = currentGainR?.gain || [1, 1, 1];
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
    // Use cached basis vectors when roll hasn't changed (avoids array
    // allocation and Rodrigues rotation on every frame).
    const rollL = cfg.rollDeg.left, rollR = cfg.rollDeg.right;
    if (rollL !== _cachedRollL || rollR !== _cachedRollR) {
      const rotateAroundAxis = S360.rotateAroundAxis;
      function makeBasis(isRight) {
        const AXIS = isRight ? AXIS_R : AXIS_L;
        let up = [...UP];
        let right = isRight ? [...RIGHT] : [0,-1,0];
        const totalRoll = (isRight ? rollR : rollL) * Math.PI / 180.0;
        if (totalRoll !== 0) {
          up = rotateAroundAxis(up, AXIS, totalRoll);
          right = rotateAroundAxis(right, AXIS, totalRoll);
        }
        return { AXIS, up, right };
      }
      _cachedRb = makeBasis(true); _cachedLb = makeBasis(false);
      _cachedRollL = rollL; _cachedRollR = rollR;
    }
    const Rb = _cachedRb, Lb = _cachedLb;

    gl.uniform3fv(u.u_gainR, gainR);
    // The overlay is preview-only: `forceNormal` is used by offscreen export,
    // 3D texture generation, and pixel sampling, where guide pixels must never
    // become part of the image data.
    gl.uniform1i(u.u_showSeam, showSeam && !schematicMode && !forceNormal ? 1 : 0);
    gl.uniform2f(u.u_srcSize, srcW, srcH);
    gl.uniform2f(u.u_centersL, cxL, cyL);
    gl.uniform2f(u.u_centersR, cxR, cyR);
    gl.uniform1f(u.u_radius, radius);
    gl.uniform1f(u.u_halfFov, halfFov);
    gl.uniform1f(u.u_f, f);
    gl.uniform1f(u.u_hfBandWidth, cfg.blend.hfBandWidth);
    gl.uniform1f(u.u_seamShift, cfg.blend.seamShift);
    gl.uniform3fv(u.u_axisL, Lb.AXIS);
    gl.uniform3fv(u.u_upL, Lb.up);
    gl.uniform3fv(u.u_rightL, Lb.right);
    gl.uniform3fv(u.u_axisR, Rb.AXIS);
    gl.uniform3fv(u.u_upR, Rb.up);
    gl.uniform3fv(u.u_rightR, Rb.right);
    gl.uniform1f(u.u_heightLL, cfg.height.ll);
    gl.uniform1f(u.u_heightLR, cfg.height.lr);
    gl.uniform1f(u.u_heightRL, cfg.height.rl);
    gl.uniform1f(u.u_heightRR, cfg.height.rr);
    gl.uniform1f(u.u_centerLL, cfg.centerOffset.ll);
    gl.uniform1f(u.u_centerLR, cfg.centerOffset.lr);
    gl.uniform1f(u.u_centerRL, cfg.centerOffset.rl);
    gl.uniform1f(u.u_centerRR, cfg.centerOffset.rr);
    gl.uniform1i(u.u_schematicMode, (!forceNormal && schematicMode) ? 1 : 0);
    gl.uniform1f(u.u_rollL, cfg.rollDeg.left * Math.PI / 180.0);
    gl.uniform1f(u.u_rollR, cfg.rollDeg.right * Math.PI / 180.0);
    gl.uniform1i(u.u_guideOn, schematicGuideX >= 0 ? 1 : 0);
    gl.uniform2f(u.u_guidePos, schematicGuideX >= 0 ? schematicGuideX : 0.0, schematicGuideY >= 0 ? schematicGuideY : 0.0);

    gl.viewport(0, 0, panoW, panoH);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    // Restore previous framebuffer so off-screen renders don't leak state.
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    _boundFbo = prevFb;
  }

  // ===========================================================================
  //  EXPORT & SPHERE VIEWER HELPERS
  // ===========================================================================


  // Renders the full pipeline (stitch, then post-FX if enabled) entirely into an
  // off-screen, texture-backed framebuffer at the exact requested size (already
  // clamped to GPU limits by the caller) and reads the pixels back. Unlike
  // rendering to the visible <canvas>, this is governed only by
  // MAX_TEXTURE_SIZE / MAX_VIEWPORT_DIMS — NOT by the browser's on-screen
  // drawing-buffer size cap (see getSafeRenderSize for details). Full-resolution
  // export and the 3D viewer both go through this so HD (2x) output is never
  // silently cropped.
  function renderOffscreenPixels(panoW, panoH) {
    stitchIfNeeded(panoW, panoH, true);

let srcTex, srcFbo = framebuffer; // raw stitched result, already off-screen
     if (postEnabled) {
       const pooled = getPooledPostFBO(gl, panoW, panoH);
       renderWithPostProcessing(panoW, panoH, pooled.fbo, true);
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
        if (S360.gpuMem) S360.gpuMem.track('wmExportFBO', panoW * panoH * 4, `WM export ${panoW}×${panoH}`);
      }
      compositeWatermark(gl, getWmProg, srcTex, panoW, panoH, wmFbo, wmTex, wmSize, wmAlpha, wmRotDeg);
      readFbo = wmFbo;
      srcTex = wmFboTex;
    }

    // Read the finished full-resolution output off-screen in horizontal bands
    // (tiles) rather than one giant panoW*panoH*4 allocation - that single block
    // is the typical OOM / context-loss trigger for very large (2x, 8K+) exports.
    return S360.readFboToCanvas(gl, readFbo, panoW, panoH);
  }

  function renderLittlePlanetPixels(panoW, panoH, outW, outH, zoom, yaw, mirror) {
    stitchIfNeeded(panoW, panoH, true);

    let srcTex = renderTexture;
    let readFbo = framebuffer;

    if (postEnabled) {
      const pooled = getPooledPostFBO(gl, panoW, panoH);
      renderWithPostProcessing(panoW, panoH, pooled.fbo, true);
      readFbo = pooled.fbo;
      srcTex = pooled.tex;
    }

    // Watermark is now composited inside the little planet shader (yaw-free
    // UVs keep the decal centred at the nadir regardless of rotation), so
    // the old pre-shader compositeWatermark() call is no longer needed here.

    const maxDim = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0]);
    const size = Math.min(outW || Math.round((panoW + panoH) / 1.5), maxDim);
    const aspect = outW ? (outW / Math.max(1, outH)) : 1.0;

    if (!_littlePlanetProg) {
      _littlePlanetProg = createProgram(gl, LITTLE_PLANET_VS, LITTLE_PLANET_FS);
    }

    const lpEntry = getPooledFBO(gl, size, size);
    gl.bindFramebuffer(gl.FRAMEBUFFER, lpEntry.fbo);
    gl.viewport(0, 0, size, size);
    gl.useProgram(_littlePlanetProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(gl.getUniformLocation(_littlePlanetProg, 'u_tex'), 0);
    if (_littlePlanetProg._uZoom === undefined) {
      _littlePlanetProg._uZoom = gl.getUniformLocation(_littlePlanetProg, 'u_zoom');
      _littlePlanetProg._uYaw = gl.getUniformLocation(_littlePlanetProg, 'u_yaw');
      _littlePlanetProg._uAspect = gl.getUniformLocation(_littlePlanetProg, 'u_aspect');
      _littlePlanetProg._uMirror = gl.getUniformLocation(_littlePlanetProg, 'u_mirror');
      _littlePlanetProg._uWmOn = gl.getUniformLocation(_littlePlanetProg, 'u_wmOn');
      _littlePlanetProg._uWm = gl.getUniformLocation(_littlePlanetProg, 'u_wm');
      _littlePlanetProg._uWmSize = gl.getUniformLocation(_littlePlanetProg, 'u_wmSize');
      _littlePlanetProg._uWmAlpha = gl.getUniformLocation(_littlePlanetProg, 'u_wmAlpha');
      _littlePlanetProg._uWmRot = gl.getUniformLocation(_littlePlanetProg, 'u_wmRot');
    }
    gl.uniform1f(_littlePlanetProg._uZoom, zoom || 1.0);
    gl.uniform1f(_littlePlanetProg._uYaw, yaw || 0.0);
    gl.uniform1f(_littlePlanetProg._uAspect, aspect);
    gl.uniform1f(_littlePlanetProg._uMirror, mirror ? -1.0 : 1.0);
    // Watermark uniforms — the shader composites the decal at yaw-free UVs
    // so it stays centred at the nadir regardless of rotation.
    if (wmLoaded && wmTex) {
      gl.uniform1f(_littlePlanetProg._uWmOn, 1.0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, wmTex);
      gl.uniform1i(_littlePlanetProg._uWm, 1);
      gl.uniform1f(_littlePlanetProg._uWmSize, wmSize);
      gl.uniform1f(_littlePlanetProg._uWmAlpha, wmAlpha);
      gl.uniform1f(_littlePlanetProg._uWmRot, wmRotDeg * Math.PI / 180.0);
    } else {
      gl.uniform1f(_littlePlanetProg._uWmOn, 0.0);
    }
    gl.bindVertexArray(S360.getQuadVAO(gl));
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Read back WITHOUT the vertical flip that readFboToCanvas applies.
    // The little planet shader already outputs in canvas orientation (the
    // flip would rotate the result 180 degrees).
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx2d = canvas.getContext('2d');
    gl.bindFramebuffer(gl.FRAMEBUFFER, lpEntry.fbo);
    const rowBytes = size * 4;
    for (let y = 0; y < size; y += 1024) {
      const th = Math.min(1024, size - y);
      const pixels = new Uint8Array(rowBytes * th);
      gl.readPixels(0, y, size, th, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      ctx2d.putImageData(new ImageData(new Uint8ClampedArray(pixels), size, th), 0, y);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return canvas;
  }











  async function onDownloadPng() {
    try {
      if (downloadBtn) downloadBtn.disabled = true;
      if (downloadJpgBtn) downloadJpgBtn.disabled = true;
      // Shed non-essential caches before export to maximise available VRAM for
      // the full-resolution render target.
      _shedNonEssentials(gl, 0);
      const { blob } = await renderFullAndExport(gl, panoramaCanvas, currentImg, renderOffscreenPixels, injectXMPMetadata, 'image/png', 0.92, false);
      triggerDownload(blob, `${lastBaseName}-stitched.png`);
    } catch (err) {
      console.error(err);
      alert('Download failed: ' + (err?.message || err));
    } finally {
      if (downloadBtn) downloadBtn.disabled = false;
      if (downloadJpgBtn) downloadJpgBtn.disabled = false;
      renderPano();
    }
  }

  async function onDownloadJpg() {
    try {
      if (downloadBtn) downloadBtn.disabled = true;
      if (downloadJpgBtn) downloadJpgBtn.disabled = true;
      // Shed non-essential caches before export to maximise available VRAM.
      _shedNonEssentials(gl, 0);
      const { blob } = await renderFullAndExport(gl, panoramaCanvas, currentImg, renderOffscreenPixels, injectXMPMetadata, 'image/jpeg', 0.95, true);
      triggerDownload(blob, `${lastBaseName}-stitched.jpg`);
    } catch (err) {
      console.error(err);
      alert('Download failed: ' + (err?.message || err));
    } finally {
      if (downloadBtn) downloadBtn.disabled = false;
      if (downloadJpgBtn) downloadJpgBtn.disabled = false;
      renderPano();
    }
  }

  function _sizeLpCanvas() {
    if (!lpModalCanvas) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const size = Math.max(200, Math.floor(Math.min(vw * 0.9, vh * 0.9)));
    _lpCanvasSize = size;
    lpModalCanvas.width = size;
    lpModalCanvas.height = size;
  }

  async function onDownloadLittlePlanet() {
    if (!currentImg) return;
    _lpZoom = 0.25;
    _lpYaw = 0.0;
    _lpDragging = false;
    if (lpModal) lpModal.classList.remove('hidden');
    _sizeLpCanvas();
    _scheduleLpPreview();
  }

  // Progressive rendering for the little planet modal, mirroring the main view's
  // pattern: coarse pass stitches at 1/4 source res for instant feedback during
  // interaction; fine pass stitches at full source res after a short settle delay.
  // Both passes output at display size (_lpCanvasSize) — the GPU's bilinear
  // filtering produces a clean upscale of the coarse stitch at near-zero cost.
  const LP_COARSE_DIV = 4;

  function _renderLpPreview(highRes = false) {
    if (!lpModalCanvas || !currentImg) return;
    const fullW = currentImg.width;
    const fullH = Math.round(fullW / 2);
    const s = _lpCanvasSize;
    if (highRes) {
      // Fine pass: stitch at full source res, render at 2× display size for
      // supersampled anti-aliasing, then downscale to the canvas via drawImage
      // which applies bilinear filtering — eliminates the pixellation artefacts
      // caused by the little planet's non-linear projection sampling.
      const hq = s * 2;
      const canvas = renderLittlePlanetPixels(fullW, fullH, hq, hq, _lpZoom, _lpYaw, cfg.mirror3D);
      const ctx2d = lpModalCanvas.getContext('2d');
      ctx2d.drawImage(canvas, 0, 0, s, s);
    } else {
      // Coarse pass: stitch at 1/4 source res (1/16th the pixels) for instant
      // feedback, then upscale to display size via canvas drawImage.
      const cw = Math.max(256, Math.round(fullW / LP_COARSE_DIV));
      const ch = Math.round(cw / 2);
      const canvas = renderLittlePlanetPixels(cw, ch, s, s, _lpZoom, _lpYaw, cfg.mirror3D);
      const ctx2d = lpModalCanvas.getContext('2d');
      ctx2d.drawImage(canvas, 0, 0, s, s);
    }
  }

  function _closeLpModal() {
    if (lpModal) lpModal.classList.add('hidden');
    if (_lpModalRaf) { cancelAnimationFrame(_lpModalRaf); _lpModalRaf = null; }
    if (_lpFineTimer) { clearTimeout(_lpFineTimer); _lpFineTimer = null; }
    if (_lpWheelTimer) { clearTimeout(_lpWheelTimer); _lpWheelTimer = null; }
  }

  function _scheduleLpPreview() {
    _updateLpPreview();
  }

  function _updateLpPreview() {
    if (_lpModalRaf) return;
    _lpModalRaf = requestAnimationFrame(() => {
      _lpModalRaf = null;
      _renderLpPreview(false);
    });
    if (_lpFineTimer) clearTimeout(_lpFineTimer);
    _lpFineTimer = setTimeout(() => {
      _lpFineTimer = null;
      _renderLpPreview(true);
    }, LP_SETTLE_MS);
  }

  async function _lpDoExportJpg() {
    if (!currentImg) return;
    try {
      if (downloadBtn) downloadBtn.disabled = true;
      if (downloadJpgBtn) downloadJpgBtn.disabled = true;
      _shedNonEssentials(gl, 0);
      const fullW = currentImg.width;
      const fullH = Math.round(fullW / 2);
      const size = scaleValue === 2 ? Math.round(fullW / 2) : fullW;
      const exportCanvas = renderLittlePlanetPixels(fullW, fullH, size, size, _lpZoom, _lpYaw, cfg.mirror3D);
      const blob = await new Promise((resolve, reject) => {
        exportCanvas.toBlob(b => b ? resolve(b) : reject(new Error('Export failed')), 'image/jpeg', 0.92);
      });
      triggerDownload(blob, `${lastBaseName}-little-planet.jpg`);
    } catch (err) {
      console.error(err);
      alert('Download failed: ' + (err?.message || err));
    } finally {
      if (downloadBtn) downloadBtn.disabled = false;
      if (downloadJpgBtn) downloadJpgBtn.disabled = false;
      _closeLpModal();
      renderPano();
    }
  }

  async function _lpDoExportPng() {
    if (!currentImg) return;
    try {
      if (downloadBtn) downloadBtn.disabled = true;
      if (downloadJpgBtn) downloadJpgBtn.disabled = true;
      _shedNonEssentials(gl, 0);
      const fullW = currentImg.width;
      const fullH = Math.round(fullW / 2);
      const size = scaleValue === 2 ? Math.round(fullW / 2) : fullW;
      const exportCanvas = renderLittlePlanetPixels(fullW, fullH, size, size, _lpZoom, _lpYaw, cfg.mirror3D);
      const blob = await new Promise((resolve, reject) => {
        exportCanvas.toBlob(b => b ? resolve(b) : reject(new Error('Export failed')), 'image/png');
      });
      triggerDownload(blob, `${lastBaseName}-little-planet.png`);
    } catch (err) {
      console.error(err);
      alert('Download failed: ' + (err?.message || err));
    } finally {
      if (downloadBtn) downloadBtn.disabled = false;
      if (downloadJpgBtn) downloadJpgBtn.disabled = false;
      _closeLpModal();
      renderPano();
    }
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.body.appendChild(document.createElement('a'));
    a.href = url;
    a.download = filename;
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
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
      const jobId = beginJob();
      isStitched = false;
      updateStitchedUI();
      setActionsVisible(false);

      try {
        lastBaseName = `${files[0].name.replace(/\.[^.]+$/, '')}_blended_${files.length}x`;
        setLoading(true, 'Blending images for noise reduction...');
        const analysis = await S360.analyzeFrameFiles(files, loadImageFromFile, setLoading, () => isJobCancelled(jobId), false);
        const blendedCanvas = await processAndBlendFiles(gl, files, img => scaleSource(gl, img, scaleValue, MAX_TEX_SIZE), loadImageFromFile, setLoading, () => isJobCancelled(jobId), analysis);
        throwIfJobCancelled(jobId);

        currentImg = blendedCanvas;
        uploadTexture(blendedCanvas);
        try { releaseSchematicBg(); S360._schematicBg = await loadImageFromFile(files[analysis.referenceIndex]); } catch (_) {}

        await new Promise(requestAnimationFrame);
        renderPano();
        drawLensSchematic();
        setActionsVisible(true);
      } catch (err) {
        if (err?.name === 'AbortError') return;
        console.error('Stacking Error:', err);
        alert('Multi-frame blending failed: ' + (err?.message || err));
      } finally {
        if (!isJobCancelled(jobId)) setLoading(false);
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
      const jobId = beginJob();
      isStitched = false;
      updateStitchedUI();
      setActionsVisible(false);

      try {
        lastBaseName = `${files[0].name.replace(/\.[^.]+$/, '')}_hdr_${files.length}x`;
        setLoading(true, 'Merging HDR exposures...');
        const analysis = await S360.analyzeFrameFiles(files, loadImageFromFile, setLoading, () => isJobCancelled(jobId), false);
        const hdrCanvas = await processAndMergeHDR(gl, cfg, panoramaCanvas, files, setLoading, img => scaleSource(gl, img, scaleValue, MAX_TEX_SIZE), loadImageFromFile, MAX_HDR_FRAMES, MERGE_BATCH, 'HDR', () => isJobCancelled(jobId), analysis);
        throwIfJobCancelled(jobId);

        currentImg = hdrCanvas;
        uploadTexture(hdrCanvas);
        // Use the analysis reference frame for schematic background (avoids
        // blown-out first exposures in HDR sequences).
        try { releaseSchematicBg(); S360._schematicBg = await loadImageFromFile(files[analysis.referenceIndex]); } catch (_) {}

        await new Promise(requestAnimationFrame);
        renderPano();
        drawLensSchematic();
        setActionsVisible(true);
      } catch (err) {
        if (err?.name === 'AbortError') return;
        console.error('HDR Merge Error:', err);
        alert('HDR merging failed: ' + (err?.message || err));
      } finally {
        if (!isJobCancelled(jobId)) setLoading(false);
        hdrImageLoader.value = '';
      }
    });
  }

  // --- Already-stitched (equirectangular) panorama loaders --------------------
  // These skip the dual-fisheye alignment/stitch entirely: the loaded frames are
  // already equirectangular, so they are fused/blended in pano space and copied
  // 1:1 into the render target (see copyStitched). Lens-geometry controls are
  // disabled because they no longer apply.
  const stitchedBlendBtn  = document.getElementById('blendStitchedBtn');
  const stitchedBlendLoader = document.getElementById('stitchedBlendLoader');
  const stitchedHdrBtn    = document.getElementById('hdrStitchedBtn');
  const stitchedHdrLoader = document.getElementById('stitchedHdrLoader');

  async function loadStitched(files, mode) {
    if (!files || files.length < 1) return;
    const jobId = beginJob();
    isStitched = true;
    updateStitchedUI();
    setActionsVisible(false);
    const verb = mode === 'hdr' ? 'Merging HDR exposures (stitched)...' : 'Blending frames (stitched)...';
    const suffix = mode === 'hdr' ? '_hdr_stitched' : '_blended_stitched';
    try {
      lastBaseName = `${files[0].name.replace(/\.[^.]+$/, '')}${suffix}_${files.length}x`;
      setLoading(true, verb);
      const analysis = await S360.analyzeFrameFiles(files, loadImageFromFile, setLoading, () => isJobCancelled(jobId), true);
      const canvas = mode === 'hdr'
        ? await processAndMergeHDR(gl, cfg, panoramaCanvas, files, setLoading, img => scaleSource(gl, img, scaleValue, MAX_TEX_SIZE), loadImageFromFile, MAX_HDR_FRAMES, MERGE_BATCH, 'HDR', () => isJobCancelled(jobId), analysis)
        : await processAndBlendFiles(gl, files, img => scaleSource(gl, img, scaleValue, MAX_TEX_SIZE), loadImageFromFile, setLoading, () => isJobCancelled(jobId), analysis);
      throwIfJobCancelled(jobId);
      currentImg = canvas;
      uploadTexture(canvas);
      await new Promise(requestAnimationFrame);
      renderPano();
      drawLensSchematic();
      setActionsVisible(true);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      console.error('Stitched load error:', err);
      alert('Loading stitched panorama(s) failed: ' + (err?.message || err));
      isStitched = false;
      updateStitchedUI();
    } finally {
      if (!isJobCancelled(jobId)) setLoading(false);
    }
  }

  if (stitchedBlendBtn && stitchedBlendLoader) {
    stitchedBlendBtn.addEventListener('click', () => stitchedBlendLoader.click());
    stitchedBlendLoader.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      await loadStitched(files, 'blend');
      stitchedBlendLoader.value = '';
    });
  }

  if (stitchedHdrBtn && stitchedHdrLoader) {
    stitchedHdrBtn.addEventListener('click', () => stitchedHdrLoader.click());
    stitchedHdrLoader.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      await loadStitched(files, 'hdr');
      stitchedHdrLoader.value = '';
    });
  }

  // "+ Stitched" next to Open: load a single already-stitched (equirectangular)
  // pano as the source to process/upscale — no alignment, no merge.
  const openStitchedBtn = document.getElementById('openStitchedBtn');
  const openStitchedLoader = document.getElementById('openStitchedLoader');

  if (openStitchedBtn && openStitchedLoader) {
    openStitchedBtn.addEventListener('click', () => openStitchedLoader.click());
    openStitchedLoader.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) { openStitchedLoader.value = ''; return; }
      const jobId = beginJob();
      isStitched = true;
      updateStitchedUI();
      setActionsVisible(false);
      try {
        lastBaseName = (file.name || 'panorama').replace(/\.[^.]+$/, '');
        setLoading(true, 'Loading stitched panorama...');
        let img = await loadImageFromFile(file);
        throwIfJobCancelled(jobId);
        img = scaleSource(gl, img, scaleValue, MAX_TEX_SIZE);
        throwIfJobCancelled(jobId);
        const longest = Math.max(img.width, img.height);
        if (longest > MAX_TEX_SIZE) {
          const scale = MAX_TEX_SIZE / longest;
          const off = document.createElement('canvas');
          off.width = Math.round(img.width * scale);
          off.height = Math.round(img.height * scale);
          const ctx2d = off.getContext('2d');
          ctx2d.drawImage(img, 0, 0, off.width, off.height);
          img = off;
        }
        currentImg = img;
        releaseSchematicBg();
        uploadTexture(img);
        await new Promise(requestAnimationFrame);
        renderPano();
        drawLensSchematic();
        setActionsVisible(true);
      } catch (err) {
        if (err?.name === 'AbortError') return;
        console.error(err);
        alert('Loading stitched panorama failed: ' + (err?.message || err));
        isStitched = false;
        updateStitchedUI();
      } finally {
        if (!isJobCancelled(jobId)) setLoading(false);
        openStitchedLoader.value = '';
      }
    });
  }
});
