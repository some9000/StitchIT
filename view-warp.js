// view-warp.js — owns one warp-stroke session lifecycle.
// begin() freezes the source identity, camera, projection, calibration and lens
// parameters at pointer-down, so a drag never re-reads live mutable controls.
// It also allocates the GPU deformation map (warp-gpu.js) at VIEW resolution —
// the exact grid the projection helpers (drawing-projection.js) and the map
// oracle (warp-projection.js) share — and move() feeds decomposed steps into it.
// init({ ctx, getSource, getCamera, getCalibration, preparePreview[, getCurrentImg, onMove] }).
window.S360 = window.S360 || {};
(function (S360) {
'use strict';
  let ctx = null, getSource = null, getCamera = null, getCalibration = null, getCurrentImg = null, preparePreview = null, onMove = null;
  let session = null, generation = 0;

  function freezeCamera() {
    const c = getCamera ? getCamera() : null;
    if (!c) return null;
    const cam = { yaw: c.yaw, pitch: c.pitch, fov: c.fov, proj: c.proj ?? 1, mirror: !!c.mirror };
    cam.basis = S360.cameraBasis ? S360.cameraBasis(cam) : null;
    return cam;
  }

  function dropGpu(state) {
    if (state && state.gpuState) {
      S360.warpGpu?.dispose(state.gpuState);
      state.gpuState = null;
    }
    state?.previewTarget?.dispose();
    if(state)state.previewTarget=null;
  }

  // Capture a fresh session. A source/context loss never stacks strokes: any
  // prior active session is dropped first. The calibration snapshot is read via
  // the injected getter, not from the live cfg, so later edits don't leak in.
  function begin(opts) {
    if (!ctx || !getSource) return false;
    cancel();
    const source = getSource();
    if (!source?.image || ctx.gl.isContextLost()) return false;
    const camera = freezeCamera();
    if (!camera) return false;
    const view = opts.view || (ctx?.panoramaCanvas ? { w: ctx.panoramaCanvas.width, h: ctx.panoramaCanvas.height } : null);
    const viewW = Math.max(1, view?.w ?? 1), viewH = Math.max(1, view?.h ?? 1);
    // The deformation map lives on the same continuous view grid as the
    // projection helpers, so its resolution is the view (overlay) resolution.
    let gpuState = null;
    if (S360.warpGpu && !opts.cpuOnly) {
      try {
        gpuState = S360.warpGpu.begin(viewW, viewH);
      } catch (error) { gpuState = null; }
    }
    let previewTarget=null;
    try{previewTarget=preparePreview?.(opts.lens ?? 'left',{w:viewW,h:viewH})||null;}
    catch(error){if(gpuState)S360.warpGpu?.dispose(gpuState);return false;}
    session = {
      id: ++generation,
      image: source.image,
      lens: opts.lens ?? 'left',
      radius: opts.radius,
      strength: opts.strength,
      camera,
      calibration: getCalibration ? getCalibration() : null,
      capture: S360.sourceEdit?.snapshot?.() || null,
      points: [], moved: false, finished: false,
      gpuState,
      previewTarget,
      view: { w: viewW, h: viewH }
    };
    const current=gpuState&&S360.warpGpu?S360.warpGpu.current(gpuState):null;
    S360.viewWarp._previewTex=current?.tex||null;
    S360.viewWarp._previewLensTex=previewTarget?.selected?.tex||null;
    S360.viewWarp._previewOtherTex=previewTarget?.other?.tex||null;
    S360.viewWarp._previewDim=[viewW,viewH];
    if(onMove)onMove(session);
    return true;
  }

  function configure(opts) {
    if(!session||session.finished)return false;
    session.radius=opts.radius;session.strength=opts.strength;
    session.points=[];session.moved=false;return true;
  }

  function move(point) {
    if (!session || session.finished) return false;
    const previous = session.points.at(-1);
    session.points.push({ x: point.x, y: point.y });
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) < 1e-9) return true;
    session.moved = true;
    if (session.gpuState && S360.warpGpu) {
      const steps = S360.warpProjection?.decompose([previous, point], {
        radius: session.radius, strength: session.strength
      });
      if (steps) for (const step of steps) S360.warpGpu.step(session.gpuState, step);
      // Publish the current GPU map for live sphere preview.
      const cur = S360.warpGpu.current(session.gpuState);
      S360.viewWarp._previewTex = cur ? cur.tex : null;
      S360.viewWarp._previewLensTex = session.previewTarget?.selected?.tex || null;
      S360.viewWarp._previewOtherTex = session.previewTarget?.other?.tex || null;
      S360.viewWarp._previewDim = [session.view.w, session.view.h];
    }
    if (onMove) onMove(session);
    return true;
  }

  // Complete the stroke and return the captured session for the commit. A
  // source swap invalidates the stroke: discard it instead (and its GPU map).
  function finish() {
    if (!session) return null;
    if ((getCurrentImg || ctx?.getCurrentImg) && (getCurrentImg?.() ?? ctx.getCurrentImg()) !== session.image) {
      cancel();
      return null;
    }
    session.finished = true;
    return session;
  }

  function cancel() {
    if (session) dropGpu(session);
    S360.viewWarp._previewTex = null;
    S360.viewWarp._previewLensTex = null;
    S360.viewWarp._previewOtherTex = null;
    session = null;
  }

  function release(finished) {
    if (!finished) return;
    dropGpu(finished);
    if (session === finished) session = null;
    S360.viewWarp._previewTex = null;
    S360.viewWarp._previewLensTex = null;
    S360.viewWarp._previewOtherTex = null;
  }

  // Camera, projection or calibration change: finish the active stroke using
  // its captured parameters, leaving the GPU map live for the commit.
  function beforeChange() {
    return finish();
  }

  function reset() {
    if (session) dropGpu(session);
    generation++;
    session = null;
    S360.viewWarp._previewTex = null;
    S360.viewWarp._previewLensTex = null;
    S360.viewWarp._previewOtherTex = null;
  }

  function dispose() {
    reset();
    onMove = null;
  }

  S360.viewWarp = {
    init(deps) {
      ctx = deps?.ctx;
      getSource = deps?.getSource;
      getCamera = deps?.getCamera;
      getCalibration = deps?.getCalibration;
      getCurrentImg = deps?.getCurrentImg;
      preparePreview = deps?.preparePreview;
      onMove = deps?.onMove;
    },
    begin, configure, move, finish, cancel, release, beforeChange, reset, dispose,
    get active() { return session; },
    /** Live warp preview state for the sphere shader. */
    _previewTex: null,
    _previewLensTex: null,
    _previewOtherTex: null,
    _previewDim: [0, 0],
  };
})(window.S360);
