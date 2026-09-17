// All source operations prepare privately, then publish through one commit boundary.
window.S360 = window.S360 || {};
(function (S360) {
'use strict';
  let ctx, uploadTexture, setLoading, setActionsVisible, updateStitchedUI;
  let activeJobId = 0;
  const cancelled = id => id !== activeJobId || ctx.gl.isContextLost();
  function check(id) {
    if (cancelled(id)) throw new DOMException('Processing cancelled.', 'AbortError');
  }
  function release(image) {
    if (image?.isGpuImage) image.dispose();
    else S360.releaseImage(image);
  }
  async function prepare(files, operation, stitched, id) {
    let image = null, background = null;
    const progress = (...args) => { check(id); setLoading(...args); };
    const inputScale = ctx.getScaleValue();
    const loadScaled = async file => {
      const decoded = await S360.loadImageFromFile(file);
      try {
        check(id);
        const scaled = S360.scaleSource(ctx.gl, decoded, inputScale, ctx.MAX_TEX_SIZE);
        if (scaled !== decoded) release(decoded);
        return scaled;
      } catch (error) { release(decoded); throw error; }
    };
    try {
      if (operation === 'open') {
        image = await loadScaled(files[0]);
      } else {
        const analysis = await S360.analyzeFrameFiles(files, loadScaled, progress, () => cancelled(id), stitched, ctx.getCfg());
        check(id);
        image = operation === 'fusion'
          ? await S360.processAndMergeExposureFusion(ctx.gl, ctx.getCfg(), files, progress, img => img,
              loadScaled, 64, 'Exposure Fusion', () => cancelled(id), analysis)
          : await S360.processAndBlendFiles(ctx.gl, files, img => img, loadScaled, progress, () => cancelled(id), analysis);
        check(id);
        if (!stitched) {
          try { background = await S360.loadImageFromFile(files[analysis.referenceIndex]); }
          catch (error) { console.warn('Schematic reference could not be decoded:', error); }
        }
      }
      check(id);
      if (!image) throw new Error('The source operation produced no image.');
      const base = files[0].name.replace(/\.[^.]+$/, '');
      const outputStitched = stitched;
      const kind = operation === 'fusion' ? 'fused' : 'blended';
      const suffix = operation === 'open' ? '' : `_${kind}${outputStitched ? '_stitched' : ''}_${files.length}x`;
      return { image, background, stitched: outputStitched, name: base + suffix };
    } catch (error) { release(image); release(background); throw error; }
  }
  async function load(files, operation, stitched) {
    if (!files.length) return;
    if (operation !== 'open' && (files.length < 2 || files.length > 64)) {
      S360.uiChrome.showToast('Please select between 2 and 64 frames to merge.', { type: 'warning' });
      return;
    }
    const id = ++activeJobId;
    let pending = null;
    setLoading(true, 'Preparing source images...');
    try {
      pending = await prepare(files, operation, stitched, id);
      check(id);
      uploadTexture(pending.image, false, false, null, pending.stitched);
      ctx.setStitched(pending.stitched);
      ctx.setLastBaseName(pending.name);
      S360.schematic.setSchematicBg(pending.background); // ownership transfers
      pending = null; // ownership transferred; there are no async gaps in this commit
      updateStitchedUI();
      S360.settings.updateUIFromConfig(ctx);
      S360.settings.scheduleLiveSave(ctx);
      S360.schematic.drawLensSchematic();
      ctx.renderPano();
      setActionsVisible(true);
    } catch (error) {
      if (error?.name !== 'AbortError' && !cancelled(id)) {
        console.error('Source load failed:', error);
        S360.uiChrome.showToast('Loading failed: ' + (error?.message || error), { type: 'error' });
      }
    } finally {
      if (pending) { release(pending.image); release(pending.background); }
      if (!cancelled(id)) setLoading(false);
    }
  }
  // Publishes an already-decoded panorama as if it had been loaded as a stitched file
  // (the same commit boundary as prepare/load, minus file decoding).
  async function loadStitchedFromImage(decoded, name) {
    const id = ++activeJobId;
    setLoading(true, 'Preparing source images...');
    let pending = null;
    try {
      const image = S360.scaleSource(ctx.gl, decoded, 1, ctx.MAX_TEX_SIZE);
      if (image !== decoded) release(decoded);
      pending = { image, background: null, stitched: true, name };
      check(id);
      uploadTexture(pending.image, false, false, null, pending.stitched);
      ctx.setStitched(pending.stitched);
      ctx.setLastBaseName(pending.name);
      S360.schematic.setSchematicBg(pending.background); // ownership transfers
      pending = null;
      updateStitchedUI();
      S360.settings.updateUIFromConfig(ctx);
      S360.settings.scheduleLiveSave(ctx);
      S360.schematic.drawLensSchematic();
      ctx.renderPano();
      setActionsVisible(true);
    } catch (error) {
      if (error?.name !== 'AbortError' && !cancelled(id)) {
        console.error('Source load failed:', error);
        S360.uiChrome.showToast('Loading failed: ' + (error?.message || error), { type: 'error' });
      }
    } finally {
      if (pending) release(pending.image);
      if (!cancelled(id)) setLoading(false);
    }
    return !cancelled(id);
  }
  function init(deps) {
    ({ ctx, uploadTexture, setLoading, setActionsVisible, updateStitchedUI } = deps);
    const entries = [
      ['chooseBtn', 'imageLoader', 'open', false],
      ['openStitchedBtn', 'openStitchedLoader', 'open', true],
      ['blendBtn', 'blendImageLoader', 'blend', false],
      ['blendStitchedBtn', 'stitchedBlendLoader', 'blend', true],
      ['exposureFusionBtn', 'exposureFusionImageLoader', 'fusion', false],
      ['exposureFusionStitchedBtn', 'stitchedExposureFusionLoader', 'fusion', true],
    ];
    for (const [buttonId, inputId, operation, stitched] of entries) {
      const button = document.getElementById(buttonId), input = document.getElementById(inputId);
      if (!input) continue;
      button?.addEventListener('click', () => input.click());
      input.addEventListener('change', async event => {
        const files = Array.from(event.target.files || []);
        input.value = '';
        await load(files, operation, stitched);
      });
    }
  }
  function replaceEditedSource(image, expected, edits) {
    if (ctx.gl.isContextLost() || ctx.getCurrentImg() !== expected) throw new DOMException('Source changed.', 'AbortError');
    uploadTexture(image, true, true, edits);
    S360.schematic.setSchematicBg(null);
    S360.schematic.drawLensSchematic();
  }
  S360.loaders = { init, replaceEditedSource, loadStitchedFromImage, cancelAllJobs() { activeJobId++; } };
})(window.S360);
