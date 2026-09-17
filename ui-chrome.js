// ui-chrome.js — passive UI chrome: tooltips, welcome overlay, resize,
// loading overlay, actions visibility, stitched-source UI
// ============================================================================
// This module owns:
//   - the two tooltip batches (hover text for every control, applied via
//     the `title` attribute)
//   - the welcome overlay shown on the canvas when no image is loaded
//   - the debounced window-resize re-render
//   - setLoading (loading overlay + export-button disabling) and
//     setActionsVisible (the export toolbar row)
//   - updateWelcome and updateStitchedUI
//
// Injected at init(): ctx (app accessors) and scheduleRender (the core
// debounced render entry). Classic-script build: plain <script> tag loaded
// before stitcher.js (file://-safe).
// ============================================================================
window.S360 = window.S360 || {};
(function (S360) {
'use strict';

  // ---- injected at init() ----------------------------------------------------
  let ctx = null;
  let scheduleRender = null;

  // ---- DOM refs --------------------------------------------------------------
  let loaderEl = null;
  let loaderMsgEl = null;
  let actionsEl = null;
  let downloadBtn = null;
  let downloadJpgBtn = null;
  let mirror3DBtn = null;
  let consoleEl = null;
  let actionButtons = [];

  // ---- module state ----------------------------------------------------------
  let welcomeEl = null;
  let _resizeTimer = null;
  let consoleStatusEl = null;
  const consoleLines = [];
  const MAX_CONSOLE_LINES = 40;

  // ---- tooltip batches, applied via the title attribute in init ------------
  const tooltips = {
    chooseBtn:       'Load a dual-fisheye image (OO format) for stitching.',
    openStitchedBtn: 'Load an already-stitched equirectangular panorama (skips alignment).',
    exposureFusionBtn:         'Blend the best-exposed detail from multiple aligned photographs before stitching.',
    exposureFusionStitchedBtn: 'Exposure-fuse already-stitched equirectangular panoramas.',
    blendBtn:        'Stack multiple frames for noise reduction, then stitch.',
    blendStitchedBtn:'Stack already-stitched equirectangular panoramas for noise reduction.',
    x2Btn:           'HD mode for the next load: upscale each source 2× before alignment, fusion and stitching. Enable before opening images; reload to change an existing result.',
    convertToStitchedBtn: 'Bake the current adjusted image as a new stitched source for further editing.',
    downloadBtn:     'Export the stitched panorama as a lossless PNG.',
    downloadJpgBtn:  'Export as JPEG with Google Photo Sphere XMP metadata for 360° viewers.',
    compareBtn:      'Load a stitched panorama as a synchronized 3D reference beside the current result. Click again to close it.',
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
    enablePreprocessBtn: 'Toggle source-image preprocessing on or off.',
    savePreprocessBtn: 'Save the current preprocessing settings as a preset.',
    loadPreprocessBtn: 'Load a previously saved preprocessing preset.',
    pickGrayBtn:     'Click a neutral-grey point on the panorama to auto white-balance.',
  };
  // Second batch — exposure fusion, lens geometry, watermark, and profiles.
  const tooltips2 = {
    fusionContrast:          'Edge-aware detail retention. Zero strongly removes ISO/JPEG texture, the middle keeps restrained structure, and the maximum enhances protected detail.',
    denoiseStrength:         'Reduces fine luminance grain while protecting edges.',
    chromaCleanup:           'Suppresses yellow/cyan JPEG blocks and coarse color noise, especially in gray areas.',
    caRed:                   'Move the red channel radially at the outside of each fisheye lens. Adjust until red/cyan edge fringes overlap the green detail.',
    caBlue:                  'Move the blue channel radially at the outside of each fisheye lens. Adjust until blue/yellow edge fringes overlap the green detail.',
    focusRecovery:           'Restores restrained edge detail in native source pixels before the fisheye image is stretched into the panorama.',
    focusRadius:             'Approximate source-image blur radius. Start near 1.5 px and increase only when the capture is visibly softer.',
    autoFocusBtn:            'Click a region that should be sharp (text, edges, patterns) to automatically estimate the optimal blur radius and focus recovery amount.',
    autoGeometryBtn:         'Reset lens alignment, then compare structural patches around both fisheye boundaries to estimate Radius, Outer Margin, and Seam Width.',
    improveGeometryBtn:      'Refine Radius and Outer Margin within 1.5% of their current values, while preserving the current lens alignment.',
    levelHorizonBtn:         'Analyze long edges across the full panorama and rotate the sphere to make the best-supported horizon level.',
    resetHorizonBtn:         'Reset Horizon Pitch and Horizon Roll to zero.',
    manualHorizonBtn:        'Draw a vertical line in the 3D view, then another after the automatic 180° turn.',
    horizonPitch:            'Tilt the full stitched sphere up or down without changing the lens-to-lens alignment.',
    horizonRoll:             'Rotate the full stitched sphere sideways to straighten the horizon.',
    fusionSaturation:        'Recovered Color controls saturation borrowed from alternate exposures without importing their fine chroma noise.',
    fusionWellExposed:       'How strongly clipped highlights and shadows are replaced from alternate exposures. 100% is the previous maximum; 200% gives stronger recovery.',
    saveExposureFusionBtn:   'Save the current exposure-fusion settings as a preset.',
    loadExposureFusionBtn:   'Load a saved exposure-fusion preset.',
    outerMargin:     'Outer usable edge of the lens circle as % of image height (100% = image height). Sets how far the captured image extends beyond 180°.',
    radius:          'Radius of the lens circle that maps to 180° (the perfect-sphere meet ring), as % of image height. Real FOV becomes 180° x outerMargin / radius.',
    centerL:         'Horizontal position of the left lens centre (0-1 normalised).',
    heightL: 'Vertical lens scale (-5 to 5%). Match Width L and Height L for uniform zoom; positive values zoom in.',
    widthL:          'Horizontal stretch of the left lens (-5 to 5%). Reads from a wider/narrower oval and stretches back to a circle.',
    angleL:          'Rotation of the left lens content around its centre (-135 to 135 degrees).',
    centerR:         'Horizontal position of the right lens centre (0-1 normalised).',
    heightR: 'Vertical lens scale (-5 to 5%). Match Width R and Height R for uniform zoom; positive values zoom in.',
    widthR:          'Horizontal stretch of the right lens (-5 to 5%). Reads from a wider/narrower oval and stretches back to a circle.',
    angleR:          'Rotation of the right lens content around its centre (-135 to 135 degrees).',
    seamWidth:       'Feather width across the overlap on both sides of the 180-degree meeting ring. 100% spans the full overlap.',
    seamShift:       'Negative values favour the left lens; positive values favour the right lens. At -100 or +100 the selected lens fills the overlap. Zero uses the content-aware seam.',
         seamBtn:         'Highlight the seam blend zone in the stitched output.',
     autoLensBtn:     'Automatically adjust all eight lens alignment sliders to minimise colour discontinuity across the seam.',
     resetLensBtn:    'Reset lens alignment to defaults (centres at 0.25/0.75, all other values at zero).',
    mirror3DBtn:     'Mirror the 3D spherical view horizontally.',
    projSlider:      'Blend the 3D view: bottom = flat perspective lines, top = round fisheye.',
    exportProfileBtn:'Export the current lens calibration as a JSON file.',
    importProfileBtn:'Import a lens calibration JSON file.',
    wmBtn:           'Load a watermark image to overlay on the nadir (bottom) of the panorama.',
    wmRemoveBtn:     'Remove the loaded watermark.',
    wmSize:          'Watermark decal angular radius - how large the nadir decal appears.',
    wmRot:           'Watermark rotation angle in degrees.',
    saveWmBtn:       'Save the current watermark settings as a preset.',
    loadWmBtn:       'Load a previously saved watermark preset.',
    saveGeoBtn:      'Save the current lens geometry as a preset.',
    loadGeoBtn:      'Load a previously saved lens geometry preset.',
    saveAlignmentBtn:'Save the eight lens alignment values as a preset.',
    loadAlignmentBtn:'Load the saved lens alignment preset.',
  };

  // ---- functions (currentImg reads via ctx) ----------------------------------
  function updateWelcome() { if (welcomeEl) welcomeEl.style.display = ctx.getCurrentImg() ? 'none' : 'flex'; }

  function setLoading(isOn, message) {
    if (loaderEl) loaderEl.classList.toggle('hidden', !isOn);
    if (loaderMsgEl) loaderMsgEl.textContent = message || (isOn ? 'Working…' : '');
    actionButtons.forEach(button => { button.disabled = !!isOn; });
  }

  function showToast(message, options = {}) {
    const { type = 'error', retry = null, persistent = false,
      duration = type === 'error' ? 7000 : 4000 } = options;
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast toast-' + type;

    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message;
    toast.appendChild(text);

    if (typeof retry === 'function') {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'toast-retry';
      retryBtn.textContent = 'Retry';
      retryBtn.addEventListener('click', () => { retry(); dismissToast(toast); });
      toast.appendChild(retryBtn);
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Dismiss message');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => dismissToast(toast));
    toast.appendChild(closeBtn);

    container.appendChild(toast);

    if (!persistent) {
      setTimeout(() => dismissToast(toast), duration);
    }
    return toast;
  }

  function dismissToast(toast) {
    if (!toast || !toast.parentNode || toast.classList.contains('toast-exit')) return;
    toast.classList.add('toast-exit');
    setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
  }

  function setActionsVisible(isOn) {
    if (actionsEl) actionsEl.classList.toggle('hidden', !isOn);
  }

  function appendConsoleLine(message, type = 'info') {
    if (!consoleEl) return;
    const line = document.createElement('div');
    line.className = 'sidebar-console-line ' + (type === 'warn' ? 'warn' : type === 'error' ? 'error' : type === 'ok' ? 'ok' : '');
    line.textContent = message;
    consoleEl.appendChild(line);
    while (consoleEl.childElementCount > MAX_CONSOLE_LINES) {
      consoleEl.removeChild(consoleEl.firstChild);
    }
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function writeConsole(message, type = 'info') {
    if (!consoleEl) return;
    const safe = String(message ?? '').trim();
    if (!safe) return;
    consoleLines.push({ message: safe, type });
    if (consoleLines.length > MAX_CONSOLE_LINES) consoleLines.shift();
    consoleEl.innerHTML = '';
    consoleLines.forEach(entry => {
      const line = document.createElement('div');
      line.className = 'sidebar-console-line ' + (entry.type === 'warn' ? 'warn' : entry.type === 'error' ? 'error' : entry.type === 'ok' ? 'ok' : '');
      line.textContent = entry.message;
      consoleEl.appendChild(line);
    });
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function updateConsoleStatus() {
    if (!consoleEl) return;
    const gpu = S360.gpuMem?.summary?.() || null;
    const renderState = S360.renderStatusSummary ? S360.renderStatusSummary() : null;
    const line = renderState
      ? `render ${renderState.queued ? 'queued' : 'idle'} • ${renderState.fine ? 'settle' : 'frame'}`
      : 'render idle';
    const gpuLine = gpu ? `gpu ${gpu.count} allocs • ${(gpu.total / 1048576).toFixed(1)} MiB` : 'gpu unavailable';
    if (!consoleStatusEl) {
      consoleStatusEl = document.createElement('div');
      consoleStatusEl.className = 'sidebar-console-line';
      consoleEl.appendChild(consoleStatusEl);
    }
    consoleStatusEl.textContent = `${line} • ${gpuLine}`;
  }

  // Lock lens geometry and calibration when the current source is
  // an already-stitched equirectangular pano (no fisheye projection is applied).
  // The groups are locked (disabled) in this mode.
  // The Mirror toggle is a 3D-view preference, not lens geometry, so it stays on.
  const LOCKED_GROUPS = ['lensGeoGroup', 'lensAlignmentGroup'];
  function updateStitchedUI() {
    const stitched = ctx ? ctx.getStitched() : false;
    LOCKED_GROUPS.forEach(id => {
      const g = document.getElementById(id);
      if (!g) return;
      g.classList.toggle('group-locked', stitched);
      // The class alone is cosmetic; actually disable inputs/buttons so the
      // locked lens state cannot be changed from a stitched source. The
      // Mirror toggle is a 3D-view preference, not lens geometry.
      g.querySelectorAll('input, button').forEach(ctrl => {
        if (ctrl.id === 'mirror3DBtn') return;
        ctrl.disabled = stitched;
      });
    });
    // Drawing owns availability for either source type in the current view.
    if (S360.drawing?.refreshToolbar) S360.drawing.refreshToolbar();
    if (mirror3DBtn) mirror3DBtn.disabled = false;
  }

  // ---- init: capture deps, fetch DOM, apply tooltips, build welcome ----------
  function init(deps) {
    ctx = deps.ctx;
    scheduleRender = deps.scheduleRender;
    loaderEl = document.getElementById('loader');
    loaderMsgEl = document.getElementById('loaderMsg');
    actionsEl = document.getElementById('actions');
    downloadBtn = document.getElementById('downloadBtn');
    downloadJpgBtn = document.getElementById('downloadJpgBtn');
    mirror3DBtn = document.getElementById('mirror3DBtn');
    consoleEl = document.getElementById('sidebarConsole');
    actionButtons = actionsEl ? [...actionsEl.querySelectorAll('button')] : [];

    // Tooltips: two batches, applied via the title attribute.
    Object.entries(tooltips).forEach(([id, tip]) => {
      const el = document.getElementById(id);
      if (el) el.title = tip;
    });
    Object.entries(tooltips2).forEach(([id, tip]) => {
      const el = document.getElementById(id);
      if (el) el.title = tip;
    });

    // Welcome overlay — shown on the canvas when no image is loaded.
    welcomeEl = document.createElement('div');
    welcomeEl.id = 'welcomeOverlay';
    welcomeEl.innerHTML = `
    <div class="welcome-inner">
      <div class="welcome-hero">
        <h1 class="welcome-title">StitchIT</h1>
        <p class="welcome-tagline">Locally run <strong>Browser-based dual-fisheye to equirectangular 360° Stitcher</strong></p>
      </div>

      <div class="welcome-workflow">
        <div class="workflow-steps">
          <div class="workflow-step">
            <span class="step-heading"><span class="step-num">1</span><span class="step-divider">-</span><span class="step-icon" aria-hidden="true">📂</span><span class="step-label">LOAD</span></span>
            <span class="step-desc">Open your dual-fisheye images or an already-stitched panorama</span>
          </div>
          <div class="workflow-arrow">→</div>
          <div class="workflow-step">
            <span class="step-heading"><span class="step-num">2</span><span class="step-divider">-</span><span class="step-icon" aria-hidden="true">🧭</span><span class="step-label">ALIGN</span></span>
            <span class="step-desc">Adjust lens geometry, seam, and horizon for a perfect stitch</span>
          </div>
          <div class="workflow-arrow">→</div>
          <div class="workflow-step">
            <span class="step-heading"><span class="step-num">3</span><span class="step-divider">-</span><span class="step-icon" aria-hidden="true">📤</span><span class="step-label">EXPORT</span></span>
            <span class="step-desc">Apply post-processing and export as PNG, JPG, or Little Planet</span>
          </div>
        </div>
      </div>

      <div class="welcome-cards">
        <div class="welcome-card">
          <h3>📷 Input Formats</h3>
          <ul>
            <li><strong>Open OO</strong> - Load a dual-fisheye image pair for stitching</li>
            <li><strong>Stitched</strong> - Open an already-stitched equirectangular panorama</li>
            <li><strong>Exposure Fusion</strong> - Blend multiple exposures before stitching</li>
            <li><strong>Merge</strong> - Stack frames for noise reduction, then stitch</li>
          </ul>
        </div>
        <div class="welcome-card">
          <h3>🔧 Key Features</h3>
          <ul>
            <li><strong>Auto Geometry</strong> - Estimate lens parameters automatically</li>
            <li><strong>Auto Alignment</strong> - Minimise colour seams across the stitch</li>
            <li><strong>Auto Horizon</strong> - Level the panorama horizon</li>
            <li><strong>Auto Focus</strong> - Restore detail with one click</li>
            <li><strong>Drawing Tools</strong> - Brush, Line, Polygon, Heal, Warp</li>
            <li><strong>Watermarks</strong> - Add top/bottom decal overlays</li>
          </ul>
        </div>
        <div class="welcome-card">
          <h3>🖥️ 3D Viewer</h3>
          <ul>
            <li><strong>Drag</strong> to pan around the sphere</li>
            <li><strong>Scroll</strong> to zoom in and out</li>
            <li><strong>Double-click</strong> to toggle 2D/3D view</li>
            <li><strong>Projection slider</strong> - blend flat to fisheye</li>
            <li><strong>Pitch presets</strong> - look up, level, or down</li>
            <li><strong>Compare</strong> - split-view against a reference</li>
          </ul>
        </div>
        <div class="welcome-card">
          <h3>💾 Presets & Export</h3>
          <ul>
            <li><strong>Save/Load</strong> presets for every control group</li>
            <li><strong>Export Profile</strong> - save lens calibration as JSON</li>
            <li><strong>Export PNG</strong> - lossless stitched panorama</li>
            <li><strong>Export JPG</strong> - with XMP metadata for 360° viewers</li>
            <li><strong>Little Planet</strong> - fun stereographic projection</li>
          </ul>
        </div>
      </div>

      <div class="welcome-tips">
        <p><strong>💡 Tip:</strong> Hover over any control in the sidebar for detailed tooltips. Use <kbd>Esc</kbd> to cancel any active tool.</p>
        <p><strong>💡 Tip:</strong> Start with a dual-fisheye image pair for the full stitching experience, or load an already-stitched panorama to skip straight to editing.</p>
      </div>
    </div>
  `;
    const resultContainer = document.getElementById('resultContainer');
    if (resultContainer) resultContainer.appendChild(welcomeEl);

    // Welcome overlay navigation — make cards interactive with hover feedback
    const welcomeCards = welcomeEl.querySelectorAll('.welcome-card');
    welcomeCards.forEach(card => {
      card.addEventListener('mouseenter', () => {
        card.style.borderColor = 'var(--accent)';
        card.style.transform = 'translateY(-2px)';
      });
      card.addEventListener('mouseleave', () => {
        card.style.borderColor = '';
        card.style.transform = '';
      });
    });

    // Keyboard shortcut hints
    const welcomeTips = welcomeEl.querySelectorAll('.welcome-tips p');
    welcomeTips.forEach(p => {
      const kbd = p.querySelector('kbd');
      if (kbd) {
        kbd.style.background = 'var(--border)';
        kbd.style.padding = '0.1rem 0.4rem';
        kbd.style.borderRadius = '3px';
        kbd.style.fontFamily = 'monospace';
        kbd.style.fontSize = '0.85em';
      }
    });

    updateWelcome();
    if (consoleEl) {
      writeConsole('console ready • render idle • gpu idle', 'ok');
      writeConsole('StitchIT ready', 'info');
      updateConsoleStatus();
    }
    // Re-apply with the freshly fetched mirror3DBtn (the startup call in
    // stitcher.js runs before init fetched the elements; this is idempotent).
    updateStitchedUI();

    // Re-render at the new on-screen size when the layout changes (the preview is
    // sized to the viewport, not the source). Debounced so a drag-resize doesn't
    // thrash the GPU.
    window.addEventListener('resize', () => {
      if (!ctx.getCurrentImg()) return;
      if (_resizeTimer) clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(() => scheduleRender(), 150);
    });
  }

  S360.uiChrome = {
    init,
    setLoading,
    setActionsVisible,
    updateStitchedUI,
    updateWelcome,
    showToast,
    dismissToast,
    appendConsoleLine,
    writeConsole,
    updateConsoleStatus,
  };
})(window.S360);
