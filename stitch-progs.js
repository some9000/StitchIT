/**
 * Centralized lazy WebGL program cache for the stitch pipeline.
 *
 * Programs are created on first access and cached — context loss invalidates
 * all of them via invalidateAll().
 *
 * Each program caches its uniform locations on program._u after creation.
 */
window.S360 = window.S360 || {};
S360.progs = (() => {
  'use strict';
  let _gl = null;

  let _glProgram = null;
  let _postProgram = null;
  let _copyProgram = null;
  let _lfProgram = null;
  function getGlProgram() {
    if (!_glProgram) {
      _glProgram = S360.createProgram(_gl, S360.VS_SOURCE, S360.FS_SOURCE);
      _glProgram._u = {
        u_image:       _gl.getUniformLocation(_glProgram, 'u_image'),
        u_imageLF:     _gl.getUniformLocation(_glProgram, 'u_imageLF'),
        u_seamCurve:   _gl.getUniformLocation(_glProgram, 'u_seamCurve'),
        u_gainR:       _gl.getUniformLocation(_glProgram, 'u_gainR'),
        u_showSeam:    _gl.getUniformLocation(_glProgram, 'u_showSeam'),
        u_srcSize:     _gl.getUniformLocation(_glProgram, 'u_srcSize'),
        u_centersL:    _gl.getUniformLocation(_glProgram, 'u_centersL'),
        u_centersR:    _gl.getUniformLocation(_glProgram, 'u_centersR'),
        u_radius:      _gl.getUniformLocation(_glProgram, 'u_radius'),
        u_halfFov:     _gl.getUniformLocation(_glProgram, 'u_halfFov'),
        u_f:           _gl.getUniformLocation(_glProgram, 'u_f'),
        u_matchNorm:   _gl.getUniformLocation(_glProgram, 'u_matchNorm'),
        u_beltNorm:    _gl.getUniformLocation(_glProgram, 'u_beltNorm'),
        u_seamWidth:   _gl.getUniformLocation(_glProgram, 'u_seamWidth'),
        u_seamShift:   _gl.getUniformLocation(_glProgram, 'u_seamShift'),
        u_axisL:       _gl.getUniformLocation(_glProgram, 'u_axisL'),
        u_upL:         _gl.getUniformLocation(_glProgram, 'u_upL'),
        u_rightL:      _gl.getUniformLocation(_glProgram, 'u_rightL'),
        u_axisR:       _gl.getUniformLocation(_glProgram, 'u_axisR'),
        u_upR:         _gl.getUniformLocation(_glProgram, 'u_upR'),
        u_rightR:      _gl.getUniformLocation(_glProgram, 'u_rightR'),
        u_schematicMode: _gl.getUniformLocation(_glProgram, 'u_schematicMode'),
        u_rollL:       _gl.getUniformLocation(_glProgram, 'u_rollL'),
        u_rollR:       _gl.getUniformLocation(_glProgram, 'u_rollR'),
        u_widthL:      _gl.getUniformLocation(_glProgram, 'u_widthL'),
        u_heightL: _gl.getUniformLocation(_glProgram, 'u_heightL'),
        u_angleL:      _gl.getUniformLocation(_glProgram, 'u_angleL'),
        u_widthR:      _gl.getUniformLocation(_glProgram, 'u_widthR'),
        u_heightR: _gl.getUniformLocation(_glProgram, 'u_heightR'),
        u_angleR:      _gl.getUniformLocation(_glProgram, 'u_angleR'),
        u_guideOn:     _gl.getUniformLocation(_glProgram, 'u_guideOn'),
        u_guidePos:    _gl.getUniformLocation(_glProgram, 'u_guidePos'),
        u_outputLens:  _gl.getUniformLocation(_glProgram, 'u_outputLens'),
        u_grainStrength: _gl.getUniformLocation(_glProgram, 'u_grainStrength'),
        u_chromaCleanup: _gl.getUniformLocation(_glProgram, 'u_chromaCleanup'),
        u_caRed: _gl.getUniformLocation(_glProgram, 'u_caRed'),
        u_caBlue: _gl.getUniformLocation(_glProgram, 'u_caBlue'),
        u_focusRecovery: _gl.getUniformLocation(_glProgram, 'u_focusRecovery'),
        u_focusRadius: _gl.getUniformLocation(_glProgram, 'u_focusRadius'),
      };
    }
    return _glProgram;
  }

function getPostProgram() {
    if (!_postProgram) {
      _postProgram = S360.createPostProgram(_gl);
      _postProgram._u = {
        u_texture:       _gl.getUniformLocation(_postProgram, 'u_texture'),
        u_blurLum:       _gl.getUniformLocation(_postProgram, 'u_blurLum'),
        u_exposure:      _gl.getUniformLocation(_postProgram, 'u_exposure'),
        u_gamma:         _gl.getUniformLocation(_postProgram, 'u_gamma'),
        u_sharpen:       _gl.getUniformLocation(_postProgram, 'u_sharpen'),
        u_clarity:       _gl.getUniformLocation(_postProgram, 'u_clarity'),
        u_saturation:    _gl.getUniformLocation(_postProgram, 'u_saturation'),
        u_contrast:      _gl.getUniformLocation(_postProgram, 'u_contrast'),
        u_temp:          _gl.getUniformLocation(_postProgram, 'u_temp'),
      };
    }
    return _postProgram;
  }

  function getCopyProgram() {
    if (!_copyProgram) {
      _copyProgram = S360.createProgram(_gl, S360.COPY_VS, S360.COPY_FS);
      _copyProgram._u = {
        u_tex: _gl.getUniformLocation(_copyProgram, 'u_tex'),
        u_grainStrength: _gl.getUniformLocation(_copyProgram, 'u_grainStrength'),
        u_chromaCleanup: _gl.getUniformLocation(_copyProgram, 'u_chromaCleanup'),
        u_focusRecovery: _gl.getUniformLocation(_copyProgram, 'u_focusRecovery'),
        u_focusRadius: _gl.getUniformLocation(_copyProgram, 'u_focusRadius'),
      };
    }
    return _copyProgram;
  }

  function getLfProgram() {
    if (!_lfProgram) {
      _lfProgram = S360.createProgram(_gl, S360.BLUR_VS, S360.BLUR_FS);
      _lfProgram._u = {
        u_tex:   _gl.getUniformLocation(_lfProgram, 'u_tex'),
        u_texel: _gl.getUniformLocation(_lfProgram, 'u_texel'),
        u_dir:   _gl.getUniformLocation(_lfProgram, 'u_dir'),
      };
    }
    return _lfProgram;
  }

  function invalidateAll() {
    _glProgram = null;
    _postProgram = null;
    _copyProgram = null;
    _lfProgram = null;
  }

  return {
    init(gl) { _gl = gl; },
    getGlProgram,
    getPostProgram,
    getCopyProgram,
    getLfProgram,
    invalidateAll,
  };
})();
