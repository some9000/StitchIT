// blend.js
window.S360 = window.S360 || {};
(function (S360) {
  // NOTE: Input images are already scaled by scaleSource() before reaching
  // this function. No additional scaling is done here — we just blend.

  // Stream the frames through the GPU exposure-fusion pipeline used by HDR with
  // the per-channel well-exposedness weight pinned to a constant (base = 1), so every
  // frame contributes equally: a high-precision, batched, memory-bounded
  // multi-frame MEAN. The float accumulator keeps rounding error from piling up
  // across many frames, and each decoded bitmap is released as soon as its
  // batch is fused. This replaced the old per-frame Canvas2D 'lighter' draws,
  // which re-quantised to 8-bit and composited a full image for every frame.
  S360.processAndBlendFiles = async function (gl, fileList, scaleSource, loadImageFromFile, setLoading, shouldCancel = null, analysis = null) {
    if (!fileList || fileList.length === 0) return;

    return S360.processAndMergeHDR(
      gl,
      { hdr: { sigma: 1, bellCenter: 0.5, base: 1 } }, // base=1 => constant weight => mean
      null,                             // canvas (unused by the fusion core)
      fileList,
      setLoading,
      scaleSource,
      loadImageFromFile,
      64,    // MAX_HDR_FRAMES cap, mirrored from HDR
      4,     // MERGE_BATCH
       'Stack', // progress-message label
       shouldCancel,
       analysis
    );
  };
})(window.S360);
