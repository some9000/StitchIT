// Owns control listeners. init receives ctx plus the pipeline entries that are not on ctx; no ctx member is re-passed as a dependency.
window.S360 = window.S360 || {};
S360.stitchUI = (() => {
  'use strict';
  function flashButton(btn) {
    btn.classList.add('flash');
    setTimeout(() => btn.classList.remove('flash'), 300);
  }

  function init({ ctx, scheduleRender, showSeam, setShowSeam,
      uploadTexture, renderOffscreenPixels, estimateCurrentGain, currentGainR,
      drawLensSchematic, yieldToUI }) {

    // This module owns the DOM refs it wires; other modules fetch their own.
    const el = (id) => document.getElementById(id);
    const viewModeBtn = el('viewModeBtn'),
      x2Btn = el('x2Btn'),
      seamBtn = el('seamBtn'),
      autoLensBtn = el('autoLensBtn'),
      autoGeometryBtn = el('autoGeometryBtn'),
      improveGeometryBtn = el('improveGeometryBtn'),
      levelHorizonBtn = el('levelHorizonBtn'),
      resetHorizonBtn = el('resetHorizonBtn'),
      autoFocusBtn = el('autoFocusBtn'),
      resetLensBtn = el('resetLensBtn'),
      mirror3DBtn = el('mirror3DBtn'),
      sidebarToggle = el('sidebarToggle'),
      projSlider = el('projSlider'),
      projVal = el('projVal'),
      exportProfileBtn = el('exportProfileBtn'),
      importProfileBtn = el('importProfileBtn'),
      profileLoader = el('profileLoader'),
      convertToStitchedBtn = el('convertToStitchedBtn'),
      wmBtn = el('wmBtn'),
      wmRemoveBtn = el('wmRemoveBtn'),
      wmImageLoader = el('wmImageLoader'),
      wmSizeSlider = el('wmSize'),
      wmSizeVal = el('wmSizeVal'),
      wmRotSlider = el('wmRot'),
      wmRotVal = el('wmRotVal'),
      saveWmBtn = el('saveWmBtn'),
      loadWmBtn = el('loadWmBtn'),
      wmTopBtn = el('wmTopBtn'),
      wmTopRemoveBtn = el('wmTopRemoveBtn'),
      wmTopImageLoader = el('wmTopImageLoader'),
      wmTopSizeSlider = el('wmTopSize'),
      wmTopSizeVal = el('wmTopSizeVal'),
      wmTopRotSlider = el('wmTopRot'),
      wmTopRotVal = el('wmTopRotVal'),
      enablePostBtn = el('enablePostBtn'),
      enablePreprocessBtn = el('enablePreprocessBtn'),
      savePreprocessBtn = el('savePreprocessBtn'),
      loadPreprocessBtn = el('loadPreprocessBtn'),
      tempSlider = el('temperature'),
      exposureSlider = el('exposure'),
      gammaPPSlider = el('gammaPP'),
      sharpenSlider = el('sharpen'),
      saturationSlider = el('saturation'),
      contrastSlider = el('contrast'),
      saveGeoBtn = el('saveGeoBtn'),
      loadGeoBtn = el('loadGeoBtn'),
      undoGeoBtn = el('undoGeoBtn'),
      saveAlignmentBtn = el('saveAlignmentBtn'),
      loadAlignmentBtn = el('loadAlignmentBtn'),
      undoAlignmentBtn = el('undoAlignmentBtn'),
      saveExposureFusionBtn = el('saveExposureFusionBtn'),
      loadExposureFusionBtn = el('loadExposureFusionBtn'),
      saveProcBtn = el('saveProcBtn'),
      loadProcBtn = el('loadProcBtn'),
      panoramaCanvas = el('panoramaCanvas');

    const undoGesture = { geometry: false, alignment: false };
    const updateUndoButtons = () => {
      if (undoGeoBtn) undoGeoBtn.disabled = !S360.settings.hasGeometryUndo();
      if (undoAlignmentBtn) undoAlignmentBtn.disabled = !S360.settings.hasAlignmentUndo();
    };
    const captureUndo = (group) => {
      if (!group || undoGesture[group]) return;
      if (group === 'geometry') S360.settings.captureGeometryUndo(ctx);
      if (group === 'alignment') S360.settings.captureAlignmentUndo(ctx);
      undoGesture[group] = true;
      updateUndoButtons();
    };

    if (sidebarToggle) {
      const main = document.getElementById('appMain');
      const updateSidebarToggle = (collapsed) => {
        main?.classList.toggle('sidebar-collapsed', collapsed);
        sidebarToggle.textContent = collapsed ? '◀' : '▶';
        sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
        sidebarToggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
        sidebarToggle.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
      };
      sidebarToggle.addEventListener('click', () => {
        updateSidebarToggle(!main?.classList.contains('sidebar-collapsed'));
      });
    }

    ctx.sliderMap.forEach(item => {
      const input = document.getElementById(item.id);
      const valSpan = document.getElementById(`${item.id}Val`);
      if (!input) return;
      input.addEventListener(input.type === 'checkbox' ? 'change' : 'input', () => {
        const val = input.type === 'checkbox' ? input.checked : parseFloat(input.value);
        captureUndo(item.undoGroup);
        item.set(val);
        S360.settings.updateSliderLabel(input, valSpan, val, item.label);
        S360.settings.scheduleLiveSave(ctx);
        item.policy.onInput?.(val);
        if (item.policy.live && ctx.getCurrentImg()) { ctx.markStitchDirty(); scheduleRender(); }
        drawLensSchematic();
      });
      if (item.undoGroup && input.type !== 'checkbox') {
        input.addEventListener('change', () => { undoGesture[item.undoGroup] = false; });
      }
    });

    const postSliders = [
      { el: tempSlider, key: 'temperature' },
      { el: exposureSlider, key: 'exposure' },
      { el: gammaPPSlider, key: 'gamma' },
      { el: sharpenSlider, key: 'sharpen' },
      { el: document.getElementById('clarity'), key: 'clarity' },
      { el: saturationSlider, key: 'saturation' },
      { el: contrastSlider, key: 'contrast' }
    ];

    postSliders.forEach(({el, key}) => {
      if (!el) return;
      el.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        ctx.postUniforms[key] = val;
        S360.settings.updatePostUI(ctx);
        S360.settings.scheduleLiveSave(ctx);
        if (ctx.getCurrentImg() && ctx.getPostEnabled()) scheduleRender();
      });
    });

    if (enablePostBtn) {
      enablePostBtn.addEventListener('click', () => {
        ctx.setPostEnabled(!ctx.getPostEnabled());
        S360.settings.updatePostUI(ctx);
        S360.settings.scheduleLiveSave(ctx);
        if (ctx.getCurrentImg()) ctx.renderPano();
      });
    }

    if (enablePreprocessBtn) enablePreprocessBtn.addEventListener('click', () => {
      ctx.cfg.preprocessingEnabled = !ctx.cfg.preprocessingEnabled;
      S360.settings.updatePreprocessUI(ctx);
      S360.settings.scheduleLiveSave(ctx);
      if (ctx.getCurrentImg()) {
        ctx.markStitchDirty();
        ctx.renderPano();
      }
    });
    if (savePreprocessBtn) savePreprocessBtn.addEventListener('click', () => {
      S360.settings.savePreprocessSnapshot(ctx);
      flashButton(savePreprocessBtn);
    }, false);
    if (loadPreprocessBtn) loadPreprocessBtn.addEventListener('click', () => {
      if (S360.settings.loadPreprocessSnapshot(ctx)) {
        S360.settings.updateUIFromConfig(ctx);
        S360.settings.updatePreprocessUI(ctx);
        if (ctx.getCurrentImg()) {
          ctx.markStitchDirty();
          ctx.renderPano();
        }
      }
      flashButton(loadPreprocessBtn);
    }, false);

    if (saveGeoBtn) saveGeoBtn.addEventListener('click', () => {
      S360.settings.saveSnapshot(ctx);
      flashButton(saveGeoBtn);
    }, false);
    if (loadGeoBtn) loadGeoBtn.addEventListener('click', () => {
      captureUndo('geometry');
      if (S360.settings.loadSnapshot(ctx)) {
        S360.settings.updateUIFromConfig(ctx);
        S360.settings.updatePostUI(ctx);
        if (mirror3DBtn) mirror3DBtn.classList.toggle('active', ctx.cfg.mirror3D);
        if (ctx.getCurrentImg()) {
          currentGainR(estimateCurrentGain());
          S360.stitchSeam.scheduleContentAwareSeam();
          ctx.markStitchDirty();
          ctx.renderPano();
        }
        if (S360.viewer.getSphere()) S360.renderSphere(ctx);
        if (S360.drawing) S360.drawing.syncCanvasSliders();
      }
      flashButton(loadGeoBtn);
    }, false);
    if (undoGeoBtn) undoGeoBtn.addEventListener('click', () => {
      if (S360.settings.undoGeometry(ctx)) {
        undoGesture.geometry = false;
        S360.settings.updateUIFromConfig(ctx);
        drawLensSchematic();
        if (ctx.getCurrentImg()) {
          currentGainR(estimateCurrentGain());
          S360.stitchSeam.scheduleContentAwareSeam();
          ctx.markStitchDirty();
          ctx.renderPano();
        }
        if (S360.viewer.getSphere()) S360.renderSphere(ctx);
      }
      updateUndoButtons();
      flashButton(undoGeoBtn);
    }, false);

    if (saveAlignmentBtn) saveAlignmentBtn.addEventListener('click', () => {
      S360.settings.saveAlignmentSnapshot(ctx);
      flashButton(saveAlignmentBtn);
    }, false);
    if (loadAlignmentBtn) loadAlignmentBtn.addEventListener('click', () => {
      captureUndo('alignment');
      if (S360.settings.loadAlignmentSnapshot(ctx)) {
        S360.settings.updateUIFromConfig(ctx);
        drawLensSchematic();
        if (ctx.getCurrentImg()) {
          currentGainR(estimateCurrentGain());
          S360.stitchSeam.scheduleContentAwareSeam();
          ctx.markStitchDirty();
          ctx.renderPano();
        }
      }
      flashButton(loadAlignmentBtn);
    }, false);
    if (undoAlignmentBtn) undoAlignmentBtn.addEventListener('click', () => {
      if (S360.settings.undoAlignment(ctx)) {
        undoGesture.alignment = false;
        S360.settings.updateUIFromConfig(ctx);
        drawLensSchematic();
        if (ctx.getCurrentImg()) {
          currentGainR(estimateCurrentGain());
          S360.stitchSeam.scheduleContentAwareSeam();
          ctx.markStitchDirty();
          ctx.renderPano();
        }
        if (S360.viewer.getSphere()) S360.renderSphere(ctx);
      }
      updateUndoButtons();
      flashButton(undoAlignmentBtn);
    }, false);

    if (saveExposureFusionBtn) saveExposureFusionBtn.addEventListener('click', () => {
      S360.settings.saveExposureFusionSnapshot(ctx);
      flashButton(saveExposureFusionBtn);
    }, false);
    if (loadExposureFusionBtn) loadExposureFusionBtn.addEventListener('click', () => {
      if (S360.settings.loadExposureFusionSnapshot(ctx)) {
        S360.settings.updateUIFromConfig(ctx);
      }
      flashButton(loadExposureFusionBtn);
    }, false);

    if (saveProcBtn) saveProcBtn.addEventListener('click', () => {
      S360.settings.saveProcSnapshot(ctx);
      flashButton(saveProcBtn);
    }, false);
    if (loadProcBtn) loadProcBtn.addEventListener('click', () => {
      if (S360.settings.loadProcSnapshot(ctx)) {
        S360.settings.updatePostUI(ctx);
        S360.settings.updateUIFromConfig(ctx);
        if (ctx.getCurrentImg()) ctx.renderPano();
      }
      flashButton(loadProcBtn);
    }, false);

    const saveCanvasBtn = document.getElementById('saveCanvasBtn');
    const loadCanvasBtn = document.getElementById('loadCanvasBtn');
    if (saveCanvasBtn) saveCanvasBtn.addEventListener('click', () => {
      S360.settings.saveCanvasSnapshot(ctx);
      flashButton(saveCanvasBtn);
    }, false);
    if (loadCanvasBtn) loadCanvasBtn.addEventListener('click', () => {
      if (S360.settings.loadCanvasSnapshot(ctx)) {
        S360.settings.updateUIFromConfig(ctx);
        if (S360.drawing) S360.drawing.syncCanvasSliders();
      }
      flashButton(loadCanvasBtn);
    }, false);

    if (viewModeBtn) viewModeBtn.addEventListener('click', () => {
      S360.setViewMode(ctx.getViewMode() === '3d' ? '2d' : '3d', ctx);
    });

    // Projection blend slider: 0 = flat perspective lines (s = 1), 100 = round
    // fisheye (s = 0.05, visually the equidistant projection). The value maps
    // linearly onto the shader/kernel blend.
    if (projSlider) {
      const projLabel = (v) => v === 0 ? 'Flat' : v === 100 ? 'Fisheye' : v + '%';
      if (projVal) projVal.textContent = projLabel(parseInt(projSlider.value, 10) || 0);
      projSlider.addEventListener('input', () => {
        const v = parseInt(projSlider.value, 10) || 0;
        S360.viewer.setProj(1 - 0.95 * v / 100);
        if (projVal) projVal.textContent = projLabel(v);
        if (S360.viewer.getSphere()) S360.renderSphere(ctx);
      });
    }

    if (convertToStitchedBtn) {
      convertToStitchedBtn.addEventListener('click', async () => {
        if (!ctx.getCurrentImg() || ctx.gl.isContextLost()) {
          S360.uiChrome.showToast('Please load an image first.', { type: 'warning' });
          return;
        }
        try {
          await S360.drawing.flush();
          S360.uiChrome.setLoading(true, 'Converting to stitched source...');
          if (convertToStitchedBtn) convertToStitchedBtn.disabled = true;
          const fullW = Math.round(ctx.getCurrentImg().width);
          const fullH = Math.round(fullW / 2);
          const bakedCanvas = renderOffscreenPixels(fullW, fullH, true);
          uploadTexture(bakedCanvas, false, false, null, true);
          // Preprocessing is now baked into the converted source. Disable the
          // live pass so the stitched copy does not apply it a second time.
          ctx.cfg.preprocessingEnabled = false;
          S360.settings.updatePreprocessUI(ctx);
          S360.settings.scheduleLiveSave(ctx);
          ctx.setStitched(true);
          await yieldToUI();
          ctx.renderPano();
          S360.uiChrome.updateStitchedUI();
          if (ctx.getViewMode() === '3d' && S360.drawing) S360.drawing.showControls(true);
          flashButton(convertToStitchedBtn);
        } catch (err) {
          console.error('Convert to Stitched failed:', err);
          S360.uiChrome.showToast('Conversion failed: ' + (err?.message || err), { type: 'error' });
          S360.uiChrome.updateStitchedUI();
        } finally {
          S360.uiChrome.setLoading(false);
          if (convertToStitchedBtn) convertToStitchedBtn.disabled = false;
        }
      }, false);
    }

    panoramaCanvas.addEventListener('dblclick', e => {
      e.preventDefault();
      if (ctx.getViewMode() === '3d') {
        S360.setViewMode('2d', ctx);
        return;
      }
      const rect = panoramaCanvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      const yaw = (nx - 0.5) * Math.PI * 2 * (ctx.cfg.mirror3D ? -1 : 1);
      const pitch = Math.max(-(Math.PI / 2 - 0.001), Math.min(Math.PI / 2 - 0.001, (0.5 - ny) * Math.PI));

      S360.setViewMode('3d', ctx);
      const sphere = S360.viewer.getSphere();
      if (sphere) {
        sphere.yaw = yaw;
        sphere.pitch = pitch;
        S360.renderSphere(ctx);
      }
    });

    // Pitch presets: ↑ looks straight up, ● levels at the horizon, ↓ looks
    // straight down. Yaw is preserved; the viewer clamps to its pole margin.
    const viewUpBtn = el('viewUpBtn'), viewLevelBtn = el('viewLevelBtn'), viewDownBtn = el('viewDownBtn');
    const setViewPitch = (pitch) => { if (S360.viewer.setPitch(pitch)) S360.renderSphere(ctx); };
    if (viewUpBtn) viewUpBtn.addEventListener('click', () => setViewPitch(Math.PI / 2));
    if (viewLevelBtn) viewLevelBtn.addEventListener('click', () => setViewPitch(0));
    if (viewDownBtn) viewDownBtn.addEventListener('click', () => setViewPitch(-Math.PI / 2));

    if (x2Btn) {
      x2Btn.addEventListener('click', () => {
        ctx.setScaleValue(ctx.getScaleValue() === 1 ? 2 : 1);
        x2Btn.classList.toggle('active', ctx.getScaleValue() === 2);
        x2Btn.setAttribute('aria-pressed', String(ctx.getScaleValue() === 2));
        S360.settings.saveLiveConfig(ctx);
      });
    }
    if (seamBtn) {
      seamBtn.addEventListener('click', () => {
        setShowSeam(!showSeam());
        seamBtn.classList.toggle('active', showSeam());
        seamBtn.setAttribute('aria-pressed', String(showSeam()));
        if (ctx.getCurrentImg()) { ctx.markStitchDirty(); ctx.renderPano(); }
      });
    }
    function resetLensAlignment() {
      captureUndo('alignment');
      ctx.cfg.centers.left[0] = 0.25;
      ctx.cfg.centers.right[0] = 0.75;
      ctx.cfg.width.left = 0;
      ctx.cfg.width.right = 0;
      ctx.cfg.height.left = 0;
      ctx.cfg.height.right = 0;
      ctx.cfg.angle.left = 0;
      ctx.cfg.angle.right = 0;
      S360.settings.updateUIFromConfig(ctx);
      S360.settings.scheduleLiveSave(ctx);
      drawLensSchematic();
      currentGainR(estimateCurrentGain());
      S360.stitchSeam.scheduleContentAwareSeam();
      ctx.markStitchDirty();
      ctx.renderPano();
    }

    if (autoLensBtn) {
      let autoRunning = false;
      autoLensBtn.addEventListener('click', async () => {
        if (!ctx.getCurrentImg() || ctx.getStitched() || autoRunning) return;
        autoRunning = true;
        autoLensBtn.classList.add('active');
        autoLensBtn.disabled = true;
        S360.uiChrome.setLoading(true, 'Auto-aligning lenses... 0%');
        // Let the loading overlay paint before the synchronous proxy build.
        await new Promise(r => setTimeout(r, 30));
        try {
          const result = await S360.lensAlignment.autoAlign((f) => {
            const pct = Math.round(Math.max(0, Math.min(1, f || 0)) * 100);
            autoLensBtn.textContent = `Aligning ${pct}%`;
            S360.uiChrome.setLoading(true, `Auto-aligning lenses... ${pct}%`);
          });
          if (result?.error) throw new Error(result.error);
          autoLensBtn.classList.remove('active');
          autoLensBtn.textContent = 'Auto Alignment';
          if (result && result.params) {
            captureUndo('alignment');
            const p = result.params;
            ctx.cfg.centers.left[0] = p.centerL;
            ctx.cfg.centers.right[0] = p.centerR;
            ctx.cfg.width.left = p.widthL;
            ctx.cfg.width.right = p.widthR;
            ctx.cfg.height.left = p.heightL;
            ctx.cfg.height.right = p.heightR;
            ctx.cfg.angle.left = p.angleL;
            ctx.cfg.angle.right = p.angleR;
            S360.settings.updateUIFromConfig(ctx);
            S360.settings.scheduleLiveSave(ctx);
            drawLensSchematic();
            currentGainR(estimateCurrentGain());
            S360.stitchSeam.scheduleContentAwareSeam();
            ctx.markStitchDirty();
            ctx.renderPano();
            S360.uiChrome.showToast(`Lens alignment auto-adjusted (improved ${result.improvementPct.toFixed(1)}%, tested ${result.evaluations} variants)`, { type: 'success' });
          } else {
            const detail = result && result.explored
              ? ` - tested ${result.explored} variants, best matched current`
              : '';
            S360.uiChrome.showToast('Auto-alignment could not improve the current values' + detail, { type: 'warning' });
          }
        } catch (err) {
          autoLensBtn.classList.remove('active');
          autoLensBtn.textContent = 'Auto Alignment';
          S360.uiChrome.showToast('Auto-alignment failed: ' + (err?.message || err), { type: 'error' });
        } finally {
          autoRunning = false;
          autoLensBtn.disabled = false;
          S360.uiChrome.setLoading(false);
        }
      });
    }
    function wireGeometryButton(button, improve) {
      if (!button) return;
      let geometryRunning = false;
      const idleLabel = improve ? 'Improve Geometry' : 'Auto Geometry';
      button.addEventListener('click', async () => {
        if (!ctx.getCurrentImg() || ctx.getStitched() || geometryRunning) return;
        geometryRunning = true;
        button.classList.add('active');
        button.disabled = true;
        if (!improve) resetLensAlignment();
        const action = improve ? 'Improving' : 'Calibrating';
        S360.uiChrome.setLoading(true, `${action} lens geometry... 0%`);
        await new Promise(r => setTimeout(r, 30));
        try {
          const analyze = improve ? S360.lensAlignment.improveGeometry : S360.lensAlignment.autoGeometry;
          const result = await analyze((fraction) => {
            const pct = Math.round(Math.max(0, Math.min(1, fraction || 0)) * 100);
            button.textContent = `${action} ${pct}%`;
            S360.uiChrome.setLoading(true, `${action} lens geometry... ${pct}%`);
          });
          if (result?.error) throw new Error(result.error);
          if (!result?.params) {
            S360.uiChrome.showToast('Auto Geometry could not find enough shared edge detail around the lens boundary.', { type: 'warning' });
          } else {
            captureUndo('geometry');
            ctx.cfg.radius = result.params.radius;
            ctx.cfg.outerMargin = result.params.outerMargin;
            ctx.cfg.blend.seamWidth = result.params.seamWidth / 100;
            S360.settings.updateUIFromConfig(ctx);
            S360.settings.scheduleLiveSave(ctx);
            drawLensSchematic();
            currentGainR(estimateCurrentGain());
            S360.stitchSeam.scheduleContentAwareSeam();
            ctx.markStitchDirty();
            ctx.renderPano();
            S360.uiChrome.showToast(
              `${idleLabel} applied: Radius ${result.params.radius.toFixed(1)}%, Margin ${result.params.outerMargin.toFixed(1)}%, Seam ${result.params.seamWidth}% (${result.matches} matches)`,
              { type: 'success' }
            );
          }
        } catch (err) {
          S360.uiChrome.showToast(idleLabel + ' failed: ' + (err?.message || err), { type: 'error' });
        } finally {
          geometryRunning = false;
          button.classList.remove('active');
          button.disabled = false;
          button.textContent = idleLabel;
          S360.uiChrome.setLoading(false);
        }
      });
    }
    wireGeometryButton(autoGeometryBtn, false);
    wireGeometryButton(improveGeometryBtn, true);
    if (levelHorizonBtn) {
      let leveling = false;
      levelHorizonBtn.addEventListener('click', async () => {
        if (leveling) return;
        if (!ctx.getCurrentImg() || ctx.getStitched()) {
          S360.uiChrome.showToast('Load a dual-fisheye image before leveling its horizon.', { type: 'warning' });
          return;
        }
        leveling = true;
        levelHorizonBtn.disabled = true;
        levelHorizonBtn.classList.add('active');
        levelHorizonBtn.textContent = 'Leveling...';
        S360.uiChrome.setLoading(true, 'Analyzing the full panorama horizon...');
        await new Promise(r => setTimeout(r, 30));
        try {
          const preview = renderOffscreenPixels(768, 384, true);
          const result = S360.horizonLeveling.analyze(preview, ctx.cfg.horizon);
          if (!result.success) {
            S360.uiChrome.showToast('Horizon leveling could not find a continuous horizon or long structural edge.', { type: 'warning' });
          } else {
            captureUndo('geometry');
            ctx.cfg.horizon.pitch = Math.round(result.pitch * 10) / 10;
            ctx.cfg.horizon.roll = Math.round(result.roll * 10) / 10;
            S360.settings.updateUIFromConfig(ctx);
            S360.settings.scheduleLiveSave(ctx);
            ctx.markStitchDirty();
            ctx.renderPano();
            S360.uiChrome.showToast(
              `Horizon leveled: Pitch ${ctx.cfg.horizon.pitch.toFixed(1)}°, Roll ${ctx.cfg.horizon.roll.toFixed(1)}°`,
              { type: 'success' }
            );
          }
        } catch (err) {
          S360.uiChrome.showToast('Horizon leveling failed: ' + (err?.message || err), { type: 'error' });
        } finally {
          leveling = false;
          levelHorizonBtn.disabled = false;
          levelHorizonBtn.classList.remove('active');
          levelHorizonBtn.textContent = 'Level Horizon';
          S360.uiChrome.setLoading(false);
          if (ctx.getCurrentImg() && ctx.getViewMode() === '3d' && S360.viewer.getSphere()) S360.renderSphere(ctx);
        }
      });
    }
    if (resetHorizonBtn) resetHorizonBtn.addEventListener('click', () => {
      captureUndo('geometry');
      ctx.cfg.horizon.pitch = 0;
      ctx.cfg.horizon.roll = 0;
      S360.settings.updateUIFromConfig(ctx);
      S360.settings.scheduleLiveSave(ctx);
      if (ctx.getCurrentImg()) {
        ctx.markStitchDirty();
        ctx.renderPano();
        if (ctx.getViewMode() === '3d' && S360.viewer.getSphere()) S360.renderSphere(ctx);
      }
      flashButton(resetHorizonBtn);
    });
    if (resetLensBtn) {
      resetLensBtn.addEventListener('click', () => {
        if (!ctx.getCurrentImg() || ctx.getStitched()) return;
        resetLensAlignment();
      });
    }
    if (autoFocusBtn) {
      let autoRunning = false;
      autoFocusBtn.addEventListener('click', async () => {
        if (!ctx.getCurrentImg() || autoRunning) return;
        autoRunning = true;
        autoFocusBtn.classList.add('active');
        autoFocusBtn.disabled = true;
        autoFocusBtn.textContent = 'Select region...';
        try {
          const result = await S360.focusRecovery.autoFocus((fraction) => {
            const pct = Math.round(Math.max(0, Math.min(1, fraction || 0)) * 100);
            S360.uiChrome.setLoading(true, `Analyzing region... ${pct}%`);
          });
          if (result?.success) {
            const { applied } = result;
            S360.settings.updateUIFromConfig(ctx);
            S360.settings.scheduleLiveSave(ctx);
            ctx.markStitchDirty();
            ctx.renderPano();
            S360.uiChrome.showToast(
              `Auto Focus applied: Radius ${applied.focusRadius.toFixed(1)}px, Recovery ${(applied.focusRecovery * 100).toFixed(0)}%`,
              { type: 'success' }
            );
          } else if (result?.cancelled) {
            // User cancelled with ESC, no error toast
          }
        } catch (err) {
          S360.uiChrome.showToast('Auto Focus failed: ' + (err?.message || err), { type: 'error' });
        } finally {
          autoRunning = false;
          autoFocusBtn.classList.remove('active');
          autoFocusBtn.disabled = false;
          autoFocusBtn.textContent = 'Auto Focus';
          S360.uiChrome.setLoading(false);
          // Focus readback uses the retained offscreen panorama target. In 3D
          // that can leave the disposable display framebuffer empty, including
          // on rejection/cancellation, so repaint the sphere synchronously.
          if (ctx.getCurrentImg() && ctx.getViewMode() === '3d' && S360.viewer.getSphere()) {
            S360.renderSphere(ctx);
          }
        }
      });
    }
    if (mirror3DBtn) {
      mirror3DBtn.addEventListener('click', () => {
        S360.drawing?.beforeViewChange();
        ctx.cfg.mirror3D = !ctx.cfg.mirror3D;
        mirror3DBtn.classList.toggle('active', ctx.cfg.mirror3D);
        mirror3DBtn.setAttribute('aria-pressed', String(ctx.cfg.mirror3D));
        if (S360.viewer.getSphere()) S360.renderSphere(ctx);
      });
    }

    S360.stitchDecal.wireDecalControls(S360.stitchDecal.decals.bottom, {
      btn: wmBtn, loader: wmImageLoader, removeBtn: wmRemoveBtn,
      sizeSlider: wmSizeSlider, sizeVal: wmSizeVal, rotSlider: wmRotSlider, rotVal: wmRotVal,
    });
    S360.stitchDecal.wireDecalControls(S360.stitchDecal.decals.top, {
      btn: wmTopBtn, loader: wmTopImageLoader, removeBtn: wmTopRemoveBtn,
      sizeSlider: wmTopSizeSlider, sizeVal: wmTopSizeVal, rotSlider: wmTopRotSlider, rotVal: wmTopRotVal,
    });

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
          if (S360.stitchDecal.decals.bottom.active) {
            if (ctx.getViewMode() === '3d') S360.renderSphere(ctx);
            else scheduleRender();
          }
        }
      });
    }

    if (exportProfileBtn) exportProfileBtn.addEventListener('click', () => {
      const profile = S360.settings.createCalibrationProfile(ctx.cfg);
      const blob = new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' });
      S360.downloads.triggerDownload(blob, `${ctx.getLastBaseName() || 'camera'}-profile.json`);
    });
    if (importProfileBtn && profileLoader) importProfileBtn.addEventListener('click', () => profileLoader.click());
    if (profileLoader) profileLoader.addEventListener('change', async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const profile = JSON.parse(await file.text());
        captureUndo('geometry');
        captureUndo('alignment');
        S360.settings.applyCalibrationProfile(ctx.cfg, profile);
        S360.settings.updateUIFromConfig(ctx);
        S360.settings.scheduleLiveSave(ctx);
        drawLensSchematic();
        if (ctx.getCurrentImg()) { currentGainR(estimateCurrentGain()); S360.stitchSeam.scheduleContentAwareSeam(); ctx.markStitchDirty(); ctx.renderPano(); }
      } catch (err) {
        S360.uiChrome.showToast('Profile import failed: ' + (err?.message || err), { type: 'error' });
      } finally {
        profileLoader.value = '';
      }
    });

    if (mirror3DBtn) mirror3DBtn.classList.toggle('active', ctx.cfg.mirror3D);
    if (seamBtn) {
      seamBtn.classList.toggle('active', showSeam());
      seamBtn.setAttribute('aria-pressed', String(showSeam()));
    }
    updateUndoButtons();
  }

  return { init };
})();
