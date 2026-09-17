// slice-upscale.js — perspective-tile super-resolution round trip.
// ============================================================================
// Owns the "Slice Upscale" panel: exporting the stitched sphere as a set of
// rectilinear slice tiles (fibonacci-sphere cell cameras), and baking an
// externally upscaled tile atlas back into an upscaled source image.
//
// Pipeline: Export renders each cell camera through the sphere shader
// (renderSphereInline, proj s = 1, mirror off) into an offscreen target and
// packs the tiles into one atlas PNG plus a manifest JSON.  The atlas is
// upscaled outside the app (any SR tool); Import & Bake validates the
// manifest against the current calibration, uploads the tiles as a
// TEXTURE_2D_ARRAY and runs SLICE_BAKE_FS: every output pixel inverts the
// lens projection (pixel -> sphere direction), blends the covering tiles
// with normalized smoothstep weights over a bilinear base, and the result is
// published as a replacement source through S360.loaders.
//
// init({ ctx }): ctx only — every DOM ref is fetched here and kept in this
// closure.  The stitch->viewer world transform and the bake shader's inverse
// lens are documented at the SLICE_BAKE_FS / invertSourcePoint sites.
// ============================================================================
window.S360 = window.S360 || {};
(function (S360) {
'use strict';
  const MAX_CELLS = 32;
  const MAX_SLICE_PX = 4096;
  const MAX_SLICE_HALF_FOV = 85 * Math.PI / 180;
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));

  let ctx = null;
  let els = null;
  let bakeProgram = null;
  let jobId = 0;

  // ---- cell layout (pure; exercised by dev-regression.cjs) -----------------
  // Fibonacci-sphere cell centers; reach = blend% of the nearest-neighbour
  // angular distance.  The bake shader normalizes the smoothstep weights, so
  // wherever any tile reaches, the blend is a convex partition with no base
  // leakage; the base shows only where no tile reaches (rim gaps at low
  // blend, or fov-capped corners).
  S360.sliceUpscalePlan = function (count, blendPct) {
    const cells = [];
    for (let i = 0; i < count; i++) {
      const y = 1 - 2 * (i + 0.5) / count;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const g = i * GOLDEN;
      // dir = (cp*sin(yaw), sin(pitch), cp*cos(yaw)) — the sphere shader's fwd
      cells.push({ fwd: [Math.cos(g) * r, y, Math.sin(g) * r] });
    }
    const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
    const blend = Math.max(0.05, Math.min(1.5, blendPct));
    for (let i = 0; i < count; i++) {
      let dnn = Infinity;
      for (let j = 0; j < count; j++) if (j !== i) dnn = Math.min(dnn, ang(cells[i].fwd, cells[j].fwd));
      cells[i].reach = blend * dnn;
      cells[i].halfFov = Math.min(Math.atan(Math.tan(cells[i].reach) * 1.05), MAX_SLICE_HALF_FOV);
    }
    return cells;
  };

  // ---- helpers --------------------------------------------------------------
  function setStatus(text) { if (els?.status) els.status.textContent = text; }

  function lensParams(cfg, scale) {
    const srcW = ctx.getCurrentImg().width, srcH = ctx.getCurrentImg().height;
    const base = Math.min(srcW * 0.25, srcH * 0.5);
    const lens = S360.lensParams(cfg, base);
    return {
      srcW, srcH,
      centerL: [srcW * cfg.centers.left[0] * scale, srcH * cfg.centers.left[1] * scale],
      centerR: [srcW * cfg.centers.right[0] * scale, srcH * cfg.centers.right[1] * scale],
      radius: lens.radiusOuter * scale, halfFov: lens.halfFov, f: lens.f * scale,
      basisL: S360.lensBasis(false, cfg), basisR: S360.lensBasis(true, cfg),
      widthL: 1.0 - cfg.width.left / 100.0, angleL: cfg.angle.left * Math.PI / 180.0,
      widthR: 1.0 - cfg.width.right / 100.0, angleR: cfg.angle.right * Math.PI / 180.0,
    };
  }

  // Calibration fingerprint baked into the manifest: an atlas exported with
  // one lens geometry is worthless after the geometry changes.
  function lensDigest(cfg) {
    return {
      outerMargin: cfg.outerMargin, radius: cfg.radius,
      centers: { left: [...cfg.centers.left], right: [...cfg.centers.right] },
      rollDeg: { left: cfg.rollDeg.left, right: cfg.rollDeg.right },
      width: { left: cfg.width.left, right: cfg.width.right },
      angle: { left: cfg.angle.left, right: cfg.angle.right },
      horizon: { pitch: cfg.horizon?.pitch || 0, roll: cfg.horizon?.roll || 0 },
    };
  }

  function guard() {
    if (!ctx.getCurrentImg()) { setStatus('Load an image first.'); return false; }
    if (ctx.getGL().isContextLost()) { setStatus('GL context lost.'); return false; }
    return true;
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }

  // Restitches at (near) full resolution so tiles sample the best available
  // sphere content, mirroring the 3D-mode stitch sizing.
  function ensureFullStitch() {
    const img = ctx.getCurrentImg();
    const maxTex = Math.min(ctx.MAX_TEX_SIZE, ctx.getGL().getParameter(ctx.getGL().MAX_TEXTURE_SIZE));
    const w = Math.min(img.width, maxTex);
    ctx.stitchIfNeeded(w, Math.round(w / 2), true);
  }

  // ---- export: stitched sphere -> slice atlas + manifest --------------------
  async function exportSlices() {
    if (!guard()) return;
    const id = ++jobId;
    const gl = ctx.getGL();
    const cfg = ctx.cfg;
    const img = ctx.getCurrentImg();
    const count = parseInt(els.count.value, 10) || 20;
    const blendPct = (parseInt(els.blend.value, 10) || 100) / 100;
    const upscale = parseFloat(els.scale.value) || 2;
    const cells = S360.sliceUpscalePlan(count, blendPct);
    const maxHalfFov = Math.max(...cells.map(c => c.halfFov));

    const params = lensParams(cfg, 1);
    let sliceW = Math.ceil(2 * Math.tan(maxHalfFov) * params.f * upscale);
    // VRAM guard: the tile array is baked in one pass, so cap it at half the
    // GPU budget and tell the user if the effective resolution was reduced.
    if (S360.gpuMem) {
      const cap = Math.sqrt(S360.gpuMem.budget() * 0.5 / (count * 4));
      if (sliceW > cap) { sliceW = Math.floor(cap); }
    }
    sliceW = Math.max(64, Math.min(sliceW, MAX_SLICE_PX,
      gl.getParameter(gl.MAX_TEXTURE_SIZE)));

    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    setStatus(`Rendering ${count} slices at ${sliceW}px…`);
    S360.uiChrome.setLoading(true, 'Rendering slices...');
    let sliceTarget = null;
    try {
      ensureFullStitch();
      if (gl.isContextLost()) throw new Error('GL context lost.');
      await S360.yieldToUI();
      sliceTarget = S360.createRenderTarget(gl, sliceW, sliceW, 'slice-tile');
      const atlas = makeCanvas(sliceW * cols, sliceW * rows);
      const atlasCtx = atlas.getContext('2d');
      for (let i = 0; i < count; i++) {
        if (id !== jobId || gl.isContextLost()) throw new Error('Processing cancelled.');
        const cell = cells[i];
        const yaw = Math.atan2(cell.fwd[0], cell.fwd[2]);
        const pitch = Math.asin(Math.max(-1, Math.min(1, cell.fwd[1])));
        S360.renderSphereInline(gl, ctx.getPanoramaCanvas(), {
          tex: ctx.getRenderTexture(), yaw, pitch, fov: 2 * cell.halfFov,
          proj: 1, mirror: false,
          target: { fbo: sliceTarget.fbo, width: sliceW, height: sliceW },
        });
        const tile = S360.readFboToCanvas(gl, sliceTarget.fbo, sliceW, sliceW);
        atlasCtx.drawImage(tile, (i % cols) * sliceW, Math.floor(i / cols) * sliceW);
        setStatus(`Rendered slice ${i + 1}/${count}…`);
        await S360.yieldToUI();
      }
      if (id !== jobId) throw new Error('Processing cancelled.');
      const manifest = {
        app: 'StitchIT', kind: 'slice-atlas', version: 1,
        srcW: params.srcW, srcH: params.srcH,
        sliceW, cols, rows, cellCount: count, blendPct,
        lens: lensDigest(cfg),
        cells: cells.map(c => ({
          yawDeg: Math.atan2(c.fwd[0], c.fwd[2]) * 180 / Math.PI,
          pitchDeg: Math.asin(c.fwd[1]) * 180 / Math.PI,
          halfFovDeg: c.halfFov * 180 / Math.PI,
          reachDeg: c.reach * 180 / Math.PI,
        })),
      };
      const png = await new Promise((res, rej) => atlas.toBlob(
        b => b ? res(b) : rej(new Error('Atlas encode failed.')), 'image/png'));
      const name = `${ctx.getLastBaseName() || 'source'}_slices${count}`;
      S360.downloads.triggerDownload(png, `${name}.png`);
      S360.downloads.triggerDownload(
        new Blob([JSON.stringify(manifest)], { type: 'application/json' }), `${name}.json`);
      setStatus(`Exported ${count} slices. Upscale the PNG, then import it with the manifest to bake.`);
    } catch (error) {
      if (id === jobId) { console.error('Slice export failed:', error); setStatus('Export failed: ' + (error?.message || error)); }
    } finally {
      sliceTarget?.dispose();
      if (id === jobId) S360.uiChrome.setLoading(false);
    }
  }

  // ---- import & bake: upscaled atlas -> replacement source ------------------
  async function importAndBake(files) {
    if (!guard()) return;
    const id = ++jobId;
    const gl = ctx.getGL();
    try {
      const jsonFile = files.find(f => /\.json$/i.test(f.name));
      const atlasFile = files.find(f => !/\.json$/i.test(f.name));
      if (!jsonFile || !atlasFile) throw new Error('Select the manifest JSON together with its (upscaled) atlas image.');
      const manifest = JSON.parse(await jsonFile.text());
      if (manifest.kind !== 'slice-atlas' || !manifest.cells?.length) throw new Error('Not a slice atlas manifest.');
      if (JSON.stringify(manifest.lens) !== JSON.stringify(lensDigest(ctx.cfg)))
        throw new Error('Lens calibration changed since export - re-export the slices.');
      const count = manifest.cellCount;
      const atlasW = manifest.sliceW * manifest.cols, atlasH = manifest.sliceW * manifest.rows;
      const atlas = await S360.loadImageFromFile(atlasFile);
      if (atlas.width < atlasW || atlas.height < atlasH) throw new Error('Atlas image is smaller than the manifest describes.');
      const scale = atlas.width / atlasW;
      const sW = Math.round(manifest.sliceW * scale);

      // VRAM guards: tile array and bake target must both fit.
      let outW = Math.round(manifest.srcW * scale);
      let outH = Math.round(manifest.srcH * scale);
      const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      if (sW > maxTex) throw new Error(`Upscaled slice (${sW}px) exceeds the GPU texture limit (${maxTex}px).`);
      if (outW > maxTex) {
        const capped = maxTex / manifest.srcW;
        setStatus(`Output capped at ${maxTex}px wide (requested ${scale.toFixed(2)}x).`);
        outW = maxTex; outH = Math.round(manifest.srcH * capped);
      }

      setStatus(`Uploading ${count} tiles (${sW}px)…`);
      S360.uiChrome.setLoading(true, 'Baking upscaled slices...');
      await S360.yieldToUI();

      const maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
      if (count > maxLayers) throw new Error(`Slice count ${count} exceeds this GPU's ${maxLayers}-layer texture-array limit.`);
      let slicesTex = null;
      let baseTex = null, bakeTarget = null, scratch = null;
      try {
        slicesTex = S360.createTrackedTexture(gl, {
          target: gl.TEXTURE_2D_ARRAY, width: sW, height: sW, depth: count,
          label: 'Upscaled slice array', bytesPerPixel: 4,
        }, () => gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, sW, sW, count));
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        scratch = makeCanvas(sW, sW);
        const sctx = scratch.getContext('2d');
        for (let i = 0; i < count; i++) {
          if (id !== jobId || gl.isContextLost()) throw new Error('Processing cancelled.');
          sctx.clearRect(0, 0, sW, sW);
          sctx.drawImage(atlas, (i % manifest.cols) * sW, Math.floor(i / manifest.cols) * sW, sW, sW, 0, 0, sW, sW);
          gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, sW, sW, 1, gl.RGBA, gl.UNSIGNED_BYTE, scratch);
        }

        // Base layer: bilinear fallback for rim pixels the capped tiles miss.
        const img = ctx.getCurrentImg();
        const base = img.isGpuImage
          ? S360.gpuImageToProxyCanvas(gl, img, img.width)
          : img;
        baseTex = S360.createTrackedTexture(gl, {
          width: base.width, height: base.height, label: 'Slice bake base texture', bytesPerPixel: 4,
        }, () => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, base));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        if (!bakeProgram) {
          bakeProgram = S360.createProgram(gl, S360.SLICE_BAKE_VS, S360.SLICE_BAKE_FS);
          bakeProgram._u = {};
          for (const name of ['u_slices', 'u_base', 'u_outSize', 'u_centerL', 'u_centerR',
            'u_radius', 'u_halfFov', 'u_f', 'u_axisL', 'u_upL', 'u_rightL',
            'u_axisR', 'u_upR', 'u_rightR',
            'u_widthL', 'u_angleL', 'u_widthR', 'u_angleR',
            'u_cellCount', 'u_cellFwd[0]',
            'u_cellReach[0]', 'u_cellTanHalf[0]']) {
            bakeProgram._u[name] = gl.getUniformLocation(bakeProgram, name);
          }
        }
        bakeTarget = S360.createRenderTarget(gl, outW, outH, 'slice-bake-out');

        const cfg = ctx.cfg;
        const params = lensParams(cfg, outW / manifest.srcW);
        const cells = S360.sliceUpscalePlan(count, manifest.blendPct);
        const fwd = new Float32Array(count * 3), reach = new Float32Array(count), tanHalf = new Float32Array(count);
        cells.forEach((c, i) => {
          fwd.set(c.fwd, i * 3);
          reach[i] = c.reach;
          tanHalf[i] = Math.tan(c.halfFov);
        });

        gl.useProgram(bakeProgram);
        gl.bindVertexArray(S360.getQuadVAO(gl));
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, slicesTex);
        gl.uniform1i(bakeProgram._u['u_slices'], 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, baseTex);
        gl.uniform1i(bakeProgram._u['u_base'], 1);
        gl.uniform2f(bakeProgram._u['u_outSize'], outW, outH);
        gl.uniform2fv(bakeProgram._u['u_centerL'], params.centerL);
        gl.uniform2fv(bakeProgram._u['u_centerR'], params.centerR);
        gl.uniform1f(bakeProgram._u['u_radius'], params.radius);
        gl.uniform1f(bakeProgram._u['u_halfFov'], params.halfFov);
        gl.uniform1f(bakeProgram._u['u_f'], params.f);
        gl.uniform3fv(bakeProgram._u['u_axisL'], params.basisL.axis);
        gl.uniform3fv(bakeProgram._u['u_upL'], params.basisL.up);
        gl.uniform3fv(bakeProgram._u['u_rightL'], params.basisL.right);
        gl.uniform3fv(bakeProgram._u['u_axisR'], params.basisR.axis);
        gl.uniform3fv(bakeProgram._u['u_upR'], params.basisR.up);
        gl.uniform3fv(bakeProgram._u['u_rightR'], params.basisR.right);
        gl.uniform1f(bakeProgram._u['u_widthL'], params.widthL);
        gl.uniform1f(bakeProgram._u['u_angleL'], params.angleL);
        gl.uniform1f(bakeProgram._u['u_widthR'], params.widthR);
        gl.uniform1f(bakeProgram._u['u_angleR'], params.angleR);
        gl.uniform1i(bakeProgram._u['u_cellCount'], count);
        gl.uniform3fv(bakeProgram._u['u_cellFwd[0]'], fwd);
        gl.uniform1fv(bakeProgram._u['u_cellReach[0]'], reach);
        gl.uniform1fv(bakeProgram._u['u_cellTanHalf[0]'], tanHalf);
        gl.bindFramebuffer(gl.FRAMEBUFFER, bakeTarget.fbo);
        gl.viewport(0, 0, outW, outH);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        if (gl.isContextLost()) throw new Error('GL context lost during bake.');
        const baked = S360.readFboToCanvas(gl, bakeTarget.fbo, outW, outH);
        setStatus('Publishing baked source…');
        await S360.yieldToUI();
        const blob = await new Promise((res, rej) => baked.toBlob(
          b => b ? res(b) : rej(new Error('Bake encode failed.')), 'image/png'));
        const file = new File([blob],
          `${ctx.getLastBaseName() || 'source'}_sliceupscale${scale >= 1 ? scale.toFixed(2).replace(/\.?0+$/, '') + 'x' : ''}.png`,
          { type: 'image/png' });
        S360.uiChrome.setLoading(false);
        await S360.loaders.load([file], 'open', false);
        setStatus(`Baked at ${scale.toFixed(2)}x from ${count} slices.`);
      } finally {
        if (baseTex) S360.deleteTrackedTexture(gl, baseTex);
        if (slicesTex) S360.deleteTrackedTexture(gl, slicesTex);
        bakeTarget?.dispose();
      }
    } catch (error) {
      if (id === jobId) {
        console.error('Slice bake failed:', error);
        setStatus('Bake failed: ' + (error?.message || error));
        S360.uiChrome.showToast('Slice bake failed: ' + (error?.message || error), { type: 'error' });
        S360.uiChrome.setLoading(false);
      }
    }
  }

  // ---- panel wiring ----------------------------------------------------------
  function init(deps) {
    ctx = deps.ctx;
    els = {
      count: document.getElementById('sliceCount'),
      countVal: document.getElementById('sliceCountVal'),
      blend: document.getElementById('sliceBlend'),
      blendVal: document.getElementById('sliceBlendVal'),
      scale: document.getElementById('sliceScale'),
      exportBtn: document.getElementById('sliceExportBtn'),
      bakeBtn: document.getElementById('sliceBakeBtn'),
      importInput: document.getElementById('sliceImportInput'),
      status: document.getElementById('sliceStatus'),
    };
    if (!els.exportBtn) return;
    els.count.addEventListener('input', () => { els.countVal.textContent = els.count.value; });
    els.blend.addEventListener('input', () => { els.blendVal.textContent = els.blend.value + '%'; });
    els.exportBtn.addEventListener('click', async () => {
      els.exportBtn.disabled = true; els.bakeBtn.disabled = true;
      try { await exportSlices(); }
      finally { els.exportBtn.disabled = false; els.bakeBtn.disabled = false; }
    });
    els.bakeBtn.addEventListener('click', () => els.importInput.click());
    els.importInput.addEventListener('change', async event => {
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      if (!files.length) return;
      els.exportBtn.disabled = true; els.bakeBtn.disabled = true;
      try { await importAndBake(files); }
      finally { els.exportBtn.disabled = false; els.bakeBtn.disabled = false; }
    });
    ctx.getPanoramaCanvas().addEventListener('webglcontextlost', () => {
      jobId++; bakeProgram = null;
      setStatus('GL context lost - re-export slices after restore.');
    });
  }

  S360.sliceUpscale = { init };
})(window.S360);
