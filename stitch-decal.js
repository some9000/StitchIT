/**
 * stitch-decal.js — the nadir (bottom) and zenith (top) watermark slots.
 *
 * Owns decal parameters, textures, pending image loads, and control wiring.
 * Consumers read decal state through S360.stitchDecal.decals.bottom / .top.
 *
 * Behaviour is identical to the original: UNPACK_FLIP_Y = true on the decal
 * upload (deliberately opposite to the source upload, because the decal is
 * sampled with screen-space v_uv with v up).
 *
 * init({ gl, getViewMode, refreshView, scheduleRender, scheduleLiveSave })
 *   - gl: WebGL2 context
 *   - getViewMode: () => '2d'|'3d'
 *   - refreshView: () => void — re-renders the live 3D sphere (3D mode only)
 *   - scheduleRender: () => void
 *   - scheduleLiveSave: () => void
 */
window.S360 = window.S360 || {};
(function (S360) {
  'use strict';

  let _gl, _getViewMode, _refreshView, _scheduleRender, _scheduleLiveSave;
  let getWmProg = null;

  // Each slot owns only its decal image and parameters.
  function makeDecalSlot(displayName) {
    let tex = null, loaded = false, size = 0.3, rotDeg = 0, alpha = 1.0;
    let pending = null;
    function cancelPending() {
      if (!pending) return;
      const { img, url } = pending;
      pending = null;
      img.onload = img.onerror = null;
      URL.revokeObjectURL(url);
      S360.releaseImage(img);
    }
    return {
      displayName,
      get tex() { return tex; },
      get loaded() { return loaded; },
      get active() { return loaded && tex; },
      get size() { return size; },
      set size(v) { size = v; },
      get rotDeg() { return rotDeg; },
      set rotDeg(v) { rotDeg = v; },
      get alpha() { return alpha; },

      loadFile(file) {
        cancelPending();
        if (_gl.isContextLost()) return;
        const img = new Image(), url = URL.createObjectURL(file);
        const job = pending = { img, url };
        img.onload = () => {
          if (pending !== job) return;
          try {
            if (_gl.isContextLost()) return;
            this.upload(_gl, img);
            refreshDecalView(this);
            _scheduleLiveSave();
          } finally { cancelPending(); }
        };
        img.onerror = () => {
          if (pending !== job) return;
          cancelPending();
          console.warn(`⚠️ ${displayName} image failed to load:`, file.name);
        };
        img.src = url;
      },

      upload(gl, img) {
        if (tex) S360.deleteTrackedTexture(gl, tex);
        try {
          tex = S360.createTrackedTexture(gl, {
            width: img.width, height: img.height, label: `${displayName} texture`, bytesPerPixel: 4,
          }, () => {
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          });
        } finally {
          // Always reset even if the upload throws, or a later texImage2D/texSubImage2D
          // (source, warp map, luminance blur) inherits the flipped state.
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        loaded = true;
      },
      remove(gl) {
        cancelPending();
        loaded = false;
        if (tex) { S360.deleteTrackedTexture(gl, tex); tex = null; }
      },
      clearForContextLoss() {
        cancelPending();
        loaded = false; S360.forgetTrackedTexture(tex); tex = null;
      },
    };
  }

  const decals = {
    bottom: makeDecalSlot('watermark'),
    top: makeDecalSlot('top watermark'),
  };

  function refreshDecalView(d, guarded = false) {
    if (guarded && !d.loaded) return;
    if (_getViewMode() === '3d' && _refreshView) _refreshView();
    if (_getViewMode() === '2d') _scheduleRender();
  }

  function wireDecalControls(d, ids) {
    const { btn, loader, removeBtn, sizeSlider, sizeVal, rotSlider, rotVal } = ids;
    if (btn && loader) {
      btn.addEventListener('click', () => loader.click());
      loader.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        d.loadFile(file);
        loader.value = '';
      });
    }
    if (removeBtn) {
      removeBtn.addEventListener('click', () => {
        d.remove(_gl);
        refreshDecalView(d);
        _scheduleLiveSave();
      });
    }
    if (sizeSlider) {
      sizeSlider.addEventListener('input', (e) => {
        const pct = parseInt(e.target.value, 10);
        d.size = pct / 100;
        S360.settings.updateSliderLabel(sizeSlider, sizeVal, pct, { decimals: 0, suffix: '%' });
        refreshDecalView(d, true);
        _scheduleLiveSave();
      });
    }
    if (rotSlider) {
      rotSlider.addEventListener('input', (e) => {
        d.rotDeg = parseFloat(e.target.value);
        S360.settings.updateSliderLabel(rotSlider, rotVal, d.rotDeg, { decimals: 0, suffix: '°' });
        refreshDecalView(d, true);
        _scheduleLiveSave();
      });
    }
  }

  S360.stitchDecal = {
    init({ gl, getViewMode, refreshView, scheduleRender, scheduleLiveSave }) {
      _gl = gl;
      _getViewMode = getViewMode;
      _refreshView = refreshView;
      _scheduleRender = scheduleRender;
      _scheduleLiveSave = scheduleLiveSave;
      getWmProg = S360.getWatermarkProgram(gl);
      return decals;
    },

    get decals() { return decals; },
    get getWmProg() { return getWmProg; },

    restoreWmProg() {
      getWmProg = S360.getWatermarkProgram(_gl);
    },

    refreshDecalView,
    wireDecalControls,
  };
})(window.S360);
