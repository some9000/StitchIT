// blend.js
window.S360 = window.S360 || {};
(function (S360) {
'use strict';
  // NOTE: Input images are already scaled by scaleSource() before reaching
  // this function. No additional scaling is done here — we just blend.

  // Use the streaming fusion core with quality weighting disabled. Its single
  // full-resolution accumulator then becomes an equal-weight frame mean.
  S360.processAndBlendFiles = async function (gl, fileList, scaleSource, loadImageFromFile, setLoading, shouldCancel = null, analysis = null) {
    if (!fileList || fileList.length === 0) return;

    return S360.processAndMergeExposureFusion(
      gl,
      { exposureFusion: { contrast: 0, saturation: 0, wellExposed: 0 } },
      fileList,
      setLoading,
      scaleSource,
      loadImageFromFile,
      64,
      'Stack',
      shouldCancel,
      analysis
    );
  };
})(window.S360);
