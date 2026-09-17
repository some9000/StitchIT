// Owns drawing input, captured view sessions, single-flight projection,
// and warp-stroke lifecycle. init({ctx}).
window.S360 = window.S360 || {};
(function (S360) {
'use strict';
  let ctx, controls, overlay, paint, gate, hint, cursor, cursorPaint, clone, instructionEl;
  let brushBtn, lineBtn, polygonBtn, blurBtn, healBtn, warpCenterBtn, warpSidesBtn, autoMorphBtn, morphButtons, undoBtn;
  let size, feather, adapt, warpStrength, opacitySlider, morphMarkerSize;
  let busy, busyMessage;
  let tool = null, stroke = null, pending = null, healJob = null, generation = 0;
  let warpSession = null; // active warp session flag
  let color = '#ff6666';
  let isLineDragging = false; // track dragging for line tool
  let lastMousePos = {x:0, y:0}; // track mouse for Enter key

  // Sync canvas sliders (Size, Feather, Opacity) from ctx.cfg — called after
  // loading a snapshot or live config so the UI reflects the loaded values.
  function syncCanvasSliders() {
    if (ctx && ctx.cfg && size && feather && opacitySlider) {
      size.value = ctx.cfg.drawSize;
      feather.value = ctx.cfg.drawFeather;
      opacitySlider.value = ctx.cfg.drawOpacity;
      S360.settings.updateSliderLabel(size, document.getElementById('drawBrushSizeVal'), ctx.cfg.drawSize);
      S360.settings.updateSliderLabel(feather, document.getElementById('cloneFeatherVal'), ctx.cfg.drawFeather);
      S360.settings.updateSliderLabel(opacitySlider, document.getElementById('drawOpacityVal'), ctx.cfg.drawOpacity, { suffix: '%' });
    }
  }

  const instructions = {
    brush: 'Drag to draw. Scroll wheel changes brush size. Hold Shift+Scroll for finer control. ESC to cancel.',
    line: 'Click to add points. Right-click or Enter to finish. ESC to cancel.',
    polygon: 'Click to add vertices. Right-click or Enter to close and fill polygon. ESC to cancel.',
    blur: 'Drag to blur a stroke, or click vertices and right-click or Enter to close a polygon area. Strength sets blur radius as a brush-size ratio. Scroll wheel changes size. ESC to cancel.',
    heal: 'Click to mark destination. Release, move to choose source, click to apply. Scroll wheel zooms source preview. ESC to cancel.',
    warpCenter: 'Drag to pull the left (center) lens. Hold Shift to lock zoom. ESC to cancel.',
    warpSides: 'Drag to pull the right (sides) lens. Hold Shift to lock zoom. ESC to cancel.',
    morph8x1: 'Click once over a visible overlap edge with the 8:1 morph brush. ESC to cancel.',
    morph4x1: 'Click once over a visible overlap edge with the 4:1 morph brush. ESC to cancel.',
    morph2x1: 'Click once over a visible overlap edge with the 2:1 morph brush. ESC to cancel.',
    morph1x1: 'Click once over a visible overlap edge with the 1:1 morph brush. ESC to cancel.',
    morph1x2: 'Click once over a visible overlap edge with the 1:2 morph brush. ESC to cancel.',
    morph1x4: 'Click once over a visible overlap edge with the 1:4 morph brush. ESC to cancel.',
    morph1x8: 'Click once over a visible overlap edge with the 1:8 morph brush. ESC to cancel.'
  };

  const worker = S360.createSingleFlightWorker({url:'bake-worker.js',label:'Source edit worker',onMessage(message){
    if(!pending)return;
    if(message.type==='result')complete(pending,message.patches);
    else if(!pending.fallback){pending.fallback=true;fallback(pending,pending.args);}
    else fail(new Error(message.message || 'Projection failed.'));
  }});

  function isWarp(t){return t==='warpCenter'||t==='warpSides';}
  function isMorphMarker(t){return /^morph(?:8x1|4x1|2x1|1x1|1x2|1x4|1x8)$/.test(t||'');}
  function available(){return !!ctx?.getCurrentImg() && ctx.getViewMode()==='3d' && !ctx.gl.isContextLost();}
  function radius(){return (ctx.cfg?.drawSize ?? Number(size.value))*overlay.width/Math.max(1,overlay.getBoundingClientRect().width);}
  function morphBrush(){
    const base=Number(morphMarkerSize.value)*overlay.width/Math.max(1,overlay.getBoundingClientRect().width);
    const entry=morphButtons.find(item=>item.name===tool),aspect=entry?.aspect||1;
    return aspect>=1?{radiusX:base*aspect/2,radiusY:base/2}:{radiusX:base/2,radiusY:base/(2*aspect)};
  }
  function strokeColor(){return tool==='blur'?'#d8dce0':color;} // Blur previews in a distinct frost grey
  function camera(){const s=S360.viewer.getSphere();return {yaw:s.yaw,pitch:s.pitch,fov:s.fov,proj:S360.viewer.getProj(),mirror:ctx.getMirror3D()};}
  function clear(){paint.clearRect(0,0,overlay.width,overlay.height);cursorPaint.clearRect(0,0,cursor.width,cursor.height);}
  function setInstruction(text){
    if(instructionEl){
      instructionEl.textContent = text;
      instructionEl.classList.toggle('visible', !!text);
    }
  }
  function refreshToolbar(){
    if(!gate)return;
    gate.style.display=available()?'none':'flex';
    gate.textContent=ctx.getCurrentImg()?'AVAILABLE IN 3D VIEW (any projection)':'LOAD AN IMAGE TO EDIT';
    controls.querySelector('#drawingToolsRow').inert=!available();
    const hasCommittedUndo=S360.sourceEdit.canUndo;
    undoBtn.disabled=!pending&&!stroke&&!warpSession&&!clone?.pending&&!hasCommittedUndo;
    undoBtn.classList.toggle('fusion-btn',hasCommittedUndo);
  }
  function refreshToolUI(){
    busy.classList.toggle('hidden',!pending);
    overlay.parentElement.setAttribute('aria-busy',String(!!pending));
    for(const [button,name]of [[brushBtn,'brush'],[lineBtn,'line'],[polygonBtn,'polygon'],[blurBtn,'blur'],[healBtn,'heal']]){
      button.classList.toggle('active',tool===name);button.setAttribute('aria-pressed',String(tool===name));button.disabled=!!pending;
    }
    for(const [button,name]of [[warpCenterBtn,'warpCenter'],[warpSidesBtn,'warpSides']]){
      button.classList.toggle('active',tool===name);button.setAttribute('aria-pressed',String(tool===name));button.disabled=!!pending||ctx.getStitched();
    }
    autoMorphBtn.disabled=!!pending||ctx.getStitched();
    for(const {button,name}of morphButtons){
      button.classList.toggle('active',tool===name);button.setAttribute('aria-pressed',String(tool===name));button.disabled=!!pending||ctx.getStitched()||!available();
    }
    morphMarkerSize.disabled=!!pending||!isMorphMarker(tool);
    overlay.classList.toggle('active',available()&&!!tool);
    ctx.setSphereInteractionEnabled(!tool&&!pending);
    size.disabled=!tool||isMorphMarker(tool);
    // Strength also controls the next automatic warp, so it remains available
    // for an editable OO source even when no manual Pull tool is armed.
    warpStrength.disabled=!!pending||(!isWarp(tool)&&tool!=='blur'&&!(available()&&!ctx.getStitched()));
    feather.disabled = !tool || isWarp(tool) || isMorphMarker(tool);
    adapt.disabled = tool !== 'heal';
    opacitySlider.disabled = !tool || tool === 'heal' || isWarp(tool) || isMorphMarker(tool);
    // All slider rows always visible
    const r = (ctx.cfg?.drawFeather ?? Number(feather.value))/10*.4*Number(size.value);
    overlay.style.filter = (tool==='brush'||tool==='line'||tool==='polygon'||tool==='blur') ? `blur(${r}px)` : '';
    // Instant redraw for size/feather/opacity changes
    if(stroke && (tool==='brush'||tool==='line'||tool==='polygon'||tool==='blur')){
      paint.clearRect(0,0,overlay.width,overlay.height);
      if(tool === 'brush'){
        if(stroke.last && stroke.start) draw(stroke.start, stroke.last);
      }else if(tool === 'line' || tool === 'polygon'){
        drawPolygonPath(stroke.points);
        if(stroke.points.length >= 2){
          if(stroke.last && stroke.points[stroke.points.length-1]){
            drawSegment(stroke.points[stroke.points.length-1], stroke.last);
          }
        }
        if((tool === 'polygon'||tool === 'blur') && stroke.points.length > 2){
          paint.strokeStyle=strokeColor();paint.lineWidth=radius()*2;paint.lineCap='round';paint.lineJoin='round';
          paint.beginPath();paint.moveTo(stroke.last.x, stroke.last.y);
          paint.lineTo(stroke.points[0].x, stroke.points[0].y);paint.stroke();
        }
      }
    }
    setInstruction(instructions[tool] || '');
    refreshToolbar();
  }
  function resize(){
    if(!ctx||!overlay||!cursor)return;
    const main=ctx.getPanoramaCanvas();
    const split=!!S360.compare?.isActive&&ctx.getViewMode()==='3d';
    const width=split?Math.max(1,Math.floor(main.width/2)):main.width;
    cursor.style.left=split?'50%':'0';cursor.style.right=split?'auto':'0';cursor.style.width=split?'50%':'100%';
    if(overlay.width===width&&overlay.height===main.height)return;
    beforeViewChange();overlay.width=width;overlay.height=main.height;
    cursor.width=overlay.width;cursor.height=overlay.height;
  }
  function point(e){const r=overlay.getBoundingClientRect();return {x:(e.clientX-r.left)*overlay.width/r.width,y:(e.clientY-r.top)*overlay.height/r.height};}
  function drawSegment(a,b){
    paint.strokeStyle=strokeColor();paint.fillStyle=strokeColor();paint.lineWidth=radius()*2;paint.lineCap='round';paint.lineJoin='round';
    paint.beginPath();paint.moveTo(a.x,a.y);paint.lineTo(b.x,b.y);paint.stroke();
    paint.beginPath();paint.arc(b.x,b.y,radius(),0,Math.PI*2);paint.fill();
  }
  function draw(a,b){
    paint.strokeStyle=strokeColor();paint.fillStyle=strokeColor();paint.lineWidth=radius()*2;paint.lineCap='round';paint.lineJoin='round';
    paint.beginPath();paint.moveTo(a.x,a.y);paint.lineTo(b.x,b.y);paint.stroke();
    paint.beginPath();paint.arc(b.x,b.y,radius(),0,Math.PI*2);paint.fill();
  }
  function drawPolygonPath(points, close=false){
    if(points.length === 0) return;
    if(points.length === 1){
      paint.fillStyle=strokeColor();
      paint.beginPath();
      paint.arc(points[0].x, points[0].y, radius(), 0, Math.PI*2);
      paint.fill();
      return;
    }
    paint.strokeStyle=strokeColor();paint.lineWidth=radius()*2;paint.lineCap='round';paint.lineJoin='round';
    paint.beginPath();
    paint.moveTo(points[0].x, points[0].y);
    for(let i=1;i<points.length;i++) paint.lineTo(points[i].x, points[i].y);
    if(close && points.length >= 3) paint.closePath();
    paint.stroke();
    for(let i=0;i<points.length;i++){
      paint.beginPath();paint.arc(points[i].x, points[i].y, radius(), 0, Math.PI*2);paint.fill();
    }
  }
  function fillPolygon(points){
    if(points.length < 3) return;
    paint.fillStyle=strokeColor();
    paint.beginPath();
    paint.moveTo(points[0].x, points[0].y);
    for(let i=1;i<points.length;i++) paint.lineTo(points[i].x, points[i].y);
    paint.closePath();
    paint.fill();
  }
  function showCursor(p){
    cursorPaint.clearRect(0,0,cursor.width,cursor.height);
    cursorPaint.strokeStyle=(isWarp(tool)||isMorphMarker(tool))?'#ffaa00':tool==='heal'?'#00ff00':strokeColor();cursorPaint.lineWidth=2;
    cursorPaint.beginPath();
    if(isMorphMarker(tool)){const brush=morphBrush();cursorPaint.ellipse(p.x,p.y,brush.radiusX,brush.radiusY,0,0,Math.PI*2);}
    else cursorPaint.arc(p.x,p.y,radius(),0,Math.PI*2);
    cursorPaint.stroke();
  }
  function cancelPending(){generation++;worker.cancel();const job=pending;pending=null;job?.resolve(!!job.committed);}
  function fail(error){
    cancelPending();stroke=null;clear();hint.textContent='Edit failed: '+error.message;hint.hidden=false;
    console.error('Source edit failed:',error);refreshToolUI();
  }
  async function complete(job,patches){
    if(pending!==job)return;
    busyMessage.textContent='Updating image…';
    await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
    if(pending!==job)return;
    try{
      if(job.args?.kind==='blur'){
        // Blur Area: the dispatched patches only carry the mask (their RGB is
        // the discarded preview colour); re-bake each patch from real source
        // pixels, blurred by Strength x brush radius.
        busyMessage.textContent='Blurring…';
        const blurred=await blurPatches(job,patches);
        if(pending!==job)return;
        patches=blurred||[];
      }
      job.committed=S360.sourceEdit.commit(job,patches);clear();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      if(pending!==job)return;
      pending=null;job.resolve(true);hint.hidden=true;refreshToolUI();
    }catch(error){if(pending===job)fail(error);}
  }
  async function fallback(job,args){
    const patches=[];let start=performance.now();
    try{
      for(const tile of S360.drawingProjection.tiles(args)){
        if(pending!==job)return;if(tile)patches.push(tile);
        if(performance.now()-start>8){await new Promise(resolve=>setTimeout(resolve,0));start=performance.now();}
      }
      await complete(job,patches);
    }catch(error){if(pending===job)fail(error);}
  }
  function dispatch(job,args){
    if(!job||pending||!ctx.getCurrentImg())return;
    job.args=args;job.done=new Promise(resolve=>job.resolve=resolve);
    pending=job;busyMessage.textContent='Projecting…';hint.hidden=true;refreshToolUI();
    const id=++generation;
    setTimeout(()=>{
      if(id!==generation||pending!==job)return;
      try{
        const used=worker.request(()=>{
          const pixels=args.overlayPixels.slice();
          worker.post({type:'bake',...args,overlayPixels:pixels},[pixels.buffer]);
        });
        if(!used)fallback(job,args);
      }catch(error){fail(error);}
    },0);
  }
  function applyOpacity(pixels, opacity){
    if(opacity >= 100) return pixels;
    const data = pixels.data;
    const alpha = opacity / 100;
    for(let i=3;i<data.length;i+=4){
      data[i] = Math.round(data[i] * alpha);
    }
    return pixels;
  }
  // ---- Blur Area: censor source content under the painted mask. ----
  // Overlay pixel -> viewer direction (matches the drawingProjection kernels:
  // r(theta)=tan(s*theta)/tan(s*fov/2) with the shared orientation conventions).
  function overlayDirection(x,y,args,out){
    const s=args.proj??1,edge=Math.tan(s*args.fov/2),aspect=args.overlayW/args.overlayH;
    const qx=((x+.5)/args.overlayW*2-1)*aspect,qy=1-(y+.5)/args.overlayH*2;
    const qr=Math.hypot(qx,qy),theta=qr>1e-12?Math.atan(qr*edge)/s:0,k=qr>1e-12?Math.sin(theta)/qr:0;
    const cp=Math.cos(args.pitch),sp=Math.sin(args.pitch),cy=Math.cos(args.yaw),sy=Math.sin(args.yaw);
    const c=Math.cos(theta);
    out[0]=cp*sy*c+(-cy*qx-sy*sp*qy)*k;
    out[1]=sp*c+cp*qy*k;
    out[2]=cp*cy*c+(sy*qx-cy*sp*qy)*k;
  }
  function sourcePointAt(x,y,args){
    const v=[0,0,0];overlayDirection(x,y,args,v);
    let dx=v[0];if(args.mirror)dx=-dx;
    const dy=v[1],dz=v[2],src=args.source,W=src.width,H=src.height;
    if(src.stitched){
      const lon=Math.atan2(dx,dz),lat=Math.asin(Math.max(-1,Math.min(1,dy)));
      return {x:(lon/(2*Math.PI)+.5)*W,y:(.5-lat/Math.PI)*H};
    }
    const cfg=src.cfg,geom=S360.lensParams(cfg,Math.min(W/4,H/2));
    for(const key of ['left','right']){
      const lens={basis:S360.lensBasis(key==='right',cfg),center:[cfg.centers[key][0]*W,cfg.centers[key][1]*H],
        width:1-cfg.width[key]/100,height:1-(cfg.height?.[key]??0)/100,angle:cfg.angle[key]*Math.PI/180,...geom};
      const o=S360.sourcePoint([-dz,-dx,-dy],lens.basis,lens.center,lens.radiusOuter,lens.halfFov,lens.f,lens.width,lens.angle,lens.height);
      if(o)return o;
    }
    return null;
  }
  // Blur radius in source pixels: Strength is a ratio of the brush radius,
  // converted once per commit with a local scale estimate at the stroke centre.
  function blurRadiusSourcePx(args){
    const d=Math.max(2,(args.blurRadius||8)*.25);
    const c=sourcePointAt(args.blurCx,args.blurCy,args),
      px=sourcePointAt(args.blurCx+d,args.blurCy,args),
      py=sourcePointAt(args.blurCx,args.blurCy+d,args);
    let scale=1;
    if(c&&px&&py){
      let sx=Math.abs(px.x-c.x);if(sx>args.source.width/2)sx=args.source.width-sx;
      const syp=Math.abs(py.y-c.y);
      const s=(sx+syp)/(2*d);
      if(isFinite(s)&&s>0)scale=Math.min(64,s);
    }
    return Math.max(1,Math.min(256,Math.round((args.blurRadius||8)*Number(warpStrength.value)*scale)));
  }
  async function blurPatches(job,patches){
    const args=job.args,src=job.source;
    const R=blurRadiusSourcePx(args),pad=Math.ceil(R*2)+2;
    const scratch=document.createElement('canvas'),soft=document.createElement('canvas');
    const sctx=scratch.getContext('2d',{willReadFrequently:true}),bctx=soft.getContext('2d');
    const reader=S360.sourceEdit.regionReader(job);
    const out=[];let start=performance.now();
    try{
      for(const p of patches){
        if(pending!==job)return null;
        // Read only a padded source region per patch; the pad (>= 3*sigma) keeps
        // every patch pixel's blur kernel inside the region, so adjacent tiles
        // produce identical values and no seams.
        const rx=Math.max(0,p.x-pad),ry=Math.max(0,p.y-pad);
        const rw=Math.min(src.width-rx,p.width+(p.x-rx)+pad),rh=Math.min(src.height-ry,p.height+(p.y-ry)+pad);
        if(rw<1||rh<1)continue;
        const region=reader.read(rx,ry,rw,rh);
        scratch.width=region.width;scratch.height=region.height;
        soft.width=region.width;soft.height=region.height;
        sctx.putImageData(region,0,0);
        // Edge-extend 3x3 so the blur does not pull in transparent black.
        bctx.clearRect(0,0,soft.width,soft.height);bctx.filter=`blur(${R}px)`;
        for(let ty=-1;ty<=1;ty++)for(let tx=-1;tx<=1;tx++)bctx.drawImage(scratch,tx*soft.width,ty*soft.height);
        bctx.filter='none';
        const blurred=bctx.getImageData(0,0,soft.width,soft.height).data;
        const ox=p.x-rx,oy=p.y-ry,data=new Uint8ClampedArray(p.width*p.height*4);
        let any=false;
        for(let y=0;y<p.height;y++){
          const row=y*p.width*4,brow=(oy+y)*soft.width*4+ox*4;
          for(let x=0;x<p.width;x++){
            const a=p.data[row+x*4+3];if(!a)continue;
            const bi=brow+x*4,oi=row+x*4;
            data[oi]=blurred[bi];data[oi+1]=blurred[bi+1];data[oi+2]=blurred[bi+2];data[oi+3]=a;
            any=true;
          }
        }
        // Patch alpha is the feathered, opacity-scaled mask; commit() blends the
        // blurred colour over the original at exactly that alpha.
        if(any)out.push({x:p.x,y:p.y,width:p.width,height:p.height,data});
        if(performance.now()-start>8){await new Promise(r=>setTimeout(r,0));start=performance.now();}
      }
    }finally{reader.release();S360.releaseImage(scratch);S360.releaseImage(soft);}
    return out;
  }
  function finish(){
    if(!stroke)return;
    const active=stroke;stroke=null;
    const r=active.feather;
    const brushR=active.radius;
    // Read opacity at finish time (not stroke creation) so slider changes take effect
    const opacity = Number(opacitySlider.value);
    // For polygon: fill first, then draw outline on top (like line tool)
    if(active.isPolygon && active.points && active.points.length >= 3){
      const pts = active.points[active.points.length-1].x === active.points[0].x && 
                  active.points[active.points.length-1].y === active.points[0].y
        ? active.points.slice(0, -1)
        : active.points;
      paint.clearRect(0,0,overlay.width,overlay.height);
      // Fill first
      fillPolygon(pts);
      // Draw outline with brush contour on top (like line tool), closed
      drawPolygonPath(pts, true);
    }
    let pixels=paint.getImageData(0,0,overlay.width,overlay.height);
    if(r>0){
      const pad = brushR * 2 + brushR * (r / 10);
      const minX=Math.max(0,Math.floor(active.minX - pad));
      const maxX=Math.min(overlay.width,Math.ceil(active.maxX + pad));
      const minY=Math.max(0,Math.floor(active.minY - pad));
      const maxY=Math.min(overlay.height,Math.ceil(active.maxY + pad));
      const bw=maxX-minX, bh=maxY-minY;
      if(bw>0 && bh>0){
        const srcCanvas=document.createElement('canvas');srcCanvas.width=bw;srcCanvas.height=bh;
        const srcCtx=srcCanvas.getContext('2d');
        srcCtx.putImageData(pixels, -minX, -minY);
        const blurCanvas=document.createElement('canvas');blurCanvas.width=bw;blurCanvas.height=bh;
        const blurCtx=blurCanvas.getContext('2d');
        blurCtx.filter=`blur(${r}px)`;
        blurCtx.drawImage(srcCanvas, 0, 0);
        blurCtx.filter='none';
        const blurred=blurCtx.getImageData(0,0,bw,bh);
        const dst=pixels.data;
        for(let y=0;y<bh;y++){
          const srcOff=y*bw*4, dstOff=(minY+y)*overlay.width*4+minX*4;
          dst.set(blurred.data.subarray(srcOff,srcOff+bw*4),dstOff);
        }
        S360.releaseImage(srcCanvas);
        S360.releaseImage(blurCanvas);
      }
    }
    // Apply opacity AFTER blur so it isn't overwritten
    pixels = applyOpacity(pixels, opacity);
    dispatch(active.job,{overlayPixels:pixels.data,overlayW:overlay.width,overlayH:overlay.height,source:active.job.source,...active.camera,
      kind:active.kind||'paint',blurRadius:brushR,blurCx:(active.minX+active.maxX)/2,blurCy:(active.minY+active.maxY)/2});
  }
  async function warpBake(session){
    if(!session?.moved){S360.viewWarp.release(session);return;}
    const job=session.capture;
    if(!job||(pending&&pending!==job)){S360.viewWarp.release(session);return;}
    if(!pending){job.done=new Promise(resolve=>job.resolve=resolve);pending=job;}
    busyMessage.textContent='Applying warp…';hint.hidden=true;refreshToolUI();
    await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
    const id=++generation;
    let reader=null;
    try{
      const wp=S360.warpProjection;
      if(!wp)throw new Error('Warp projection is not loaded.');
      const viewW=session.view?.w||1, viewH=session.view?.h||1;
      const points=session.map?null:wp.simplifyPoints(session.points,.75);
      const steps=session.map?null:wp.decompose(points,{radius:session.radius,strength:session.strength});
      reader=S360.sourceEdit.createReader(job);const patches=[];
      let started=performance.now();
      for(const tile of S360.drawingProjection.warpTiles({steps,map:session.map,mapW:viewW,mapH:viewH,
        source:job.source,sourceReader:reader,lens:session.lens,mapProjection:session.mapProjection,
        taperToLensCenter:session.taperToLensCenter,...session.camera})){
        if(id!==generation||pending!==job)return;
        if(tile)patches.push(tile);
        if(performance.now()-started>8){await new Promise(resolve=>setTimeout(resolve,0));started=performance.now();}
      }
      await complete(job,patches);
    }catch(error){if(id===generation&&pending===job)fail(error);}
    finally{reader?.release();S360.viewWarp.release(session);S360.renderSphere(ctx);}
  }
  async function autoWarp(lens,focus=null){
    if(!available()||ctx.getStitched()||pending)return;
    finish();if(pending)return;
    if(S360.viewWarp.active){S360.viewWarp.cancel();warpSession=null;clear();S360.renderSphere(ctx);}
    tool=null;clone.cancel();healJob=null;clear();refreshToolUI();
    const started=S360.viewWarp.begin({view:{w:overlay.width,h:overlay.height,outputWidth:focus?null:3072},lens,radius:1,strength:1,cpuOnly:true});
    const session=started?S360.viewWarp.active:null,job=session?.capture;
    if(!session||!job){hint.textContent='Automatic warp could not prepare the lens layers.';hint.hidden=false;refreshToolUI();return;}
    job.done=new Promise(resolve=>job.resolve=resolve);pending=job;
    const id=++generation;let selectedCanvas=null,otherCanvas=null;
    busyMessage.textContent='Matching lens points…';hint.hidden=true;refreshToolUI();
    await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
    try{
      const selected=session.previewTarget?.selected,other=session.previewTarget?.other;
      if(!selected||!other)throw new Error('Lens previews are unavailable.');
      selectedCanvas=S360.readFboToCanvas(ctx.gl,selected.fbo,selected.width,selected.height);
      otherCanvas=S360.readFboToCanvas(ctx.gl,other.fbo,other.width,other.height);
      const selectedPixels=selectedCanvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,selectedCanvas.width,selectedCanvas.height);
      const otherPixels=otherCanvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,otherCanvas.width,otherCanvas.height);
      const result=await S360.autoWarp.buildMap({selected:selectedPixels,other:otherPixels,camera:session.camera,
        viewW:overlay.width,viewH:overlay.height,fullPanorama:!focus,focus,strength:Number(warpStrength.value),yieldFn:()=>new Promise(resolve=>setTimeout(resolve,0)),
        onProgress:f=>{if(id===generation&&pending===job)busyMessage.textContent=`Matching lens points… ${Math.round(f*100)}%`;}});
      if(id!==generation||pending!==job)return;
      if(!result.moved){
        pending=null;job.resolve(false);S360.viewWarp.release(session);
        hint.textContent=result.overlap===false?'The marker must be placed where both lenses overlap.':`No reliable local correction found (${result.matches} matches).`;hint.hidden=false;refreshToolUI();return;
      }
      session.map=result.map;session.view={w:result.width,h:result.height};session.moved=true;
      if(!focus){session.mapProjection='equirect';session.taperToLensCenter=true;}
      session.matchCount=result.matches;
      const finished=S360.viewWarp.finish();
      if(!finished)throw new Error('Source changed during automatic warp.');
      await warpBake(finished);
      if(job.committed)S360.uiChrome?.showToast?.(`${focus?'Marker morph':'Automatic morph'} baked from ${result.matches} reliable matches`,{type:'success'});
    }catch(error){
      S360.viewWarp.release(session);
      if(id===generation&&pending===job)fail(error);
    }finally{
      if(S360.viewWarp.active===session)S360.viewWarp.release(session);
      if(selectedCanvas)S360.releaseImage(selectedCanvas);
      if(otherCanvas)S360.releaseImage(otherCanvas);
    }
  }
  async function flush(){finish();const job=pending;if(job && !await job.done)throw new DOMException('Edit cancelled.','AbortError');}
  function beforeViewChange(){
    finish();clone?.cancel();healJob=null;
    if(warpSession){
      const sess=S360.viewWarp.finish();
      if(sess&&sess.moved){warpBake(sess);}
      warpSession=null;
    }else if(S360.viewWarp.active){S360.viewWarp.cancel();S360.renderSphere(ctx);}
    if(pending)clear();
  }
  function toggle(name){
    if(!available()||pending)return;
    finish();if(pending)return;
    if(S360.viewWarp.active){S360.viewWarp.cancel();warpSession=null;clear();S360.renderSphere(ctx);}
    clone.cancel();healJob=null;clear();tool=tool===name?null:name;
    isLineDragging=false;
    clone.activate(tool==='heal');refreshToolUI();
    if(isWarp(tool)){
      const lens=tool==='warpCenter'?'left':'right';
      if(!S360.viewWarp.begin({view:{w:overlay.width,h:overlay.height},lens,radius:radius()*2,strength:Number(warpStrength.value)})){
        hint.textContent='Pull preview failed to start.';hint.hidden=false;
      }
    }
  }
  function down(e){
    if(e.button!==0||pending||!tool||!available())return;
    resize();
    if(tool==='heal'){
      if(!clone.pending)healJob=S360.sourceEdit.snapshot();
      clone.down(e);refreshToolbar();return;
    }
    e.preventDefault();e.stopPropagation();clear();hint.hidden=true;
    const p=point(e);
    if(isMorphMarker(tool)){
      autoWarp('left',{x:p.x,y:p.y,...morphBrush()});return;
    }
    
    if(isWarp(tool)){
      if(ctx.getStitched()){hint.textContent='Base-lens warp requires an unstitched dual-fisheye source.';hint.hidden=false;return;}
      const lens=tool==='warpCenter'?'left':'right';
      const active=S360.viewWarp.active;
      const ok=active?.lens===lens
        ?S360.viewWarp.configure({radius:radius()*2,strength:Number(warpStrength.value)})
        :S360.viewWarp.begin({view:{w:overlay.width,h:overlay.height},lens,radius:radius()*2,strength:Number(warpStrength.value)});
      if(!ok){hint.textContent='Warp failed to start.';hint.hidden=false;return;}
      warpSession=true;
      S360.viewWarp.move(p);
      if(e.isTrusted)overlay.setPointerCapture(e.pointerId);
      showCursor(p);refreshToolbar();
      return;
    }
    if(tool === 'line' || tool === 'polygon' || tool === 'blur'){
      if(!stroke){
        stroke={job:S360.sourceEdit.snapshot(),camera:camera(),start:p,last:p,feather:Number(feather.value)/10*.4*radius(),radius:radius(),minX:p.x,maxX:p.x,minY:p.y,maxY:p.y,points:[p], isPolygon: tool === 'polygon' || tool === 'blur', kind:tool};
        // Draw first point immediately
        paint.clearRect(0,0,overlay.width,overlay.height);
        paint.fillStyle=strokeColor();
        paint.beginPath();
        paint.arc(p.x, p.y, radius(), 0, Math.PI*2);
        paint.fill();
        if(tool === 'line') isLineDragging = true;
      }else{
        if(tool === 'line'){
          // Add point and start dragging from there
          stroke.points.push(p);
          stroke.last = p;
          if(p.x<stroke.minX)stroke.minX=p.x;
          if(p.x>stroke.maxX)stroke.maxX=p.x;
          if(p.y<stroke.minY)stroke.minY=p.y;
          if(p.y>stroke.maxY)stroke.maxY=p.y;
          isLineDragging = true;
        }else{
          // Polygon - add vertex
          stroke.points.push(p);
          stroke.last = p;
          if(p.x<stroke.minX)stroke.minX=p.x;
          if(p.x>stroke.maxX)stroke.maxX=p.x;
          if(p.y<stroke.minY)stroke.minY=p.y;
          if(p.y>stroke.maxY)stroke.maxY=p.y;
        }
        paint.clearRect(0,0,overlay.width,overlay.height);
        drawPolygonPath(stroke.points);
        // Draw closing line preview for polygon with 3+ points
        if((tool === 'polygon'||tool === 'blur') && stroke.points.length > 2){
          paint.strokeStyle=strokeColor();paint.lineWidth=radius()*2;paint.lineCap='round';paint.lineJoin='round';
          paint.beginPath();paint.moveTo(stroke.points[stroke.points.length-1].x, stroke.points[stroke.points.length-1].y);
          paint.lineTo(stroke.points[0].x, stroke.points[0].y);paint.stroke();
        }
      }
    }else{
      // Brush - freehand drawing
      stroke={job:S360.sourceEdit.snapshot(),camera:camera(),start:p,last:p,feather:Number(feather.value)/10*.4*radius(),radius:radius(),minX:p.x,maxX:p.x,minY:p.y,maxY:p.y};
    }
    if(e.isTrusted)overlay.setPointerCapture(e.pointerId);
    if(tool === 'brush' || tool === 'blur') draw(p,p);
    refreshToolbar();
  }
  function move(e){
    if(!tool||pending||!available())return;
    const p=point(e);
    lastMousePos = p;
    if(tool==='heal'&&clone.sessionActive){
      // The region outline replaces the brush circle while choosing a source;
      // clear the circle left over from the stroke phase.
      clone.move(e);
      cursorPaint.clearRect(0,0,cursor.width,cursor.height);
      return;
    }
    showCursor(p);
    if(warpSession){S360.viewWarp.move(p);return;}
    if(tool==='heal'){clone.move(e);return;}
    if(!stroke)return;
    const isRightMouseDown = (e.buttons & 2) !== 0;
    if(tool==='line'){
      paint.clearRect(0,0,overlay.width,overlay.height);
      drawPolygonPath(stroke.points);
      // Draw preview line to current mouse if dragging (left button only)
      if(isLineDragging && stroke.points.length >= 1 && !isRightMouseDown){
        drawSegment(stroke.last, p);
      }
    }else if(tool === 'polygon'){
      paint.clearRect(0,0,overlay.width,overlay.height);
      drawPolygonPath(stroke.points);
      // Draw preview lines from both first and last clicked point to cursor
      if(stroke.points.length >= 1 && !isRightMouseDown){
        drawSegment(stroke.last, p);
        drawSegment(stroke.points[0], p);
      }
      // Draw closing line preview when 3+ points
      if(stroke.points.length > 2){
        paint.strokeStyle=strokeColor();paint.lineWidth=radius()*2;paint.lineCap='round';paint.lineJoin='round';
        paint.beginPath();paint.moveTo(p.x, p.y);paint.lineTo(stroke.points[0].x, stroke.points[0].y);paint.stroke();
      }
    }else if(tool === 'blur'){
      if((e.buttons&1)&&stroke){
        // Freehand mode: accumulate a soft stroke exactly like the brush.
        stroke.dragged=true;
        const steps = 6;
        for(let i=1;i<=steps;i++){
          const t=i/steps;
          const ix=stroke.last.x+(p.x-stroke.last.x)*t;
          const iy=stroke.last.y+(p.y-stroke.last.y)*t;
          draw(stroke.last, {x:ix,y:iy});
          stroke.last={x:ix,y:iy};
        }
        if(p.x<stroke.minX)stroke.minX=p.x;
        if(p.x>stroke.maxX)stroke.maxX=p.x;
        if(p.y<stroke.minY)stroke.minY=p.y;
        if(p.y>stroke.maxY)stroke.maxY=p.y;
        return;
      }
      if(stroke){
        // Click mode: polygon-style vertex preview toward the cursor.
        paint.clearRect(0,0,overlay.width,overlay.height);
        drawPolygonPath(stroke.points);
        if(!isRightMouseDown){
          drawSegment(stroke.last, p);
          drawSegment(stroke.points[0], p);
        }
        if(stroke.points.length > 2){
          paint.strokeStyle=strokeColor();paint.lineWidth=radius()*2;paint.lineCap='round';paint.lineJoin='round';
          paint.beginPath();paint.moveTo(p.x, p.y);paint.lineTo(stroke.points[0].x, stroke.points[0].y);paint.stroke();
        }
      }
      return;
    }else{
      // Brush - continuous freehand drawing with interpolation for smoothness
      const steps = 6;
      for(let i=1;i<=steps;i++){
        const t=i/steps;
        const ix=stroke.last.x+(p.x-stroke.last.x)*t;
        const iy=stroke.last.y+(p.y-stroke.last.y)*t;
        draw(stroke.last, {x:ix,y:iy});
        stroke.last={x:ix,y:iy};
      }
      // Update bounds for brush
      if(p.x<stroke.minX)stroke.minX=p.x;
      if(p.x>stroke.maxX)stroke.maxX=p.x;
      if(p.y<stroke.minY)stroke.minY=p.y;
      if(p.y>stroke.maxY)stroke.maxY=p.y;
      return;
    }
    // For line/polygon, only update bounds, not stroke.last (keep last clicked point)
    if(p.x<stroke.minX)stroke.minX=p.x;
    if(p.x>stroke.maxX)stroke.maxX=p.x;
    if(p.y<stroke.minY)stroke.minY=p.y;
    if(p.y>stroke.maxY)stroke.maxY=p.y;
  }
  function handleLineFinish(){
    if(!stroke || stroke.points.length < 2) return false;
    if(tool === 'line'){
      // For line: redraw only the actual points (no preview line)
      paint.clearRect(0,0,overlay.width,overlay.height);
      drawPolygonPath(stroke.points);
    }
    // For polygon: finish() will handle drawing (outline + fill)
    isLineDragging=false;
    finish();
    return true;
  }
  function up(e){
    if(pending)return;
    if(warpSession){
      if(overlay.hasPointerCapture(e.pointerId))overlay.releasePointerCapture(e.pointerId);
      const sess=S360.viewWarp.finish();
      warpSession=null;
      if(sess&&sess.moved){tool=null;clone.activate(false);refreshToolUI();warpBake(sess);}
      clear();refreshToolbar();
      return;
    }
    if(tool==='heal'){clone.up(e);refreshToolbar();return;}
    if(!stroke)return;
    if(tool === 'line'){
      if(isLineDragging){
        // Add point at current position and continue dragging
        const p=point(e);
        stroke.points.push(p);
        stroke.last = p;
        if(p.x<stroke.minX)stroke.minX=p.x;
        if(p.x>stroke.maxX)stroke.maxX=p.x;
        if(p.y<stroke.minY)stroke.minY=p.y;
        if(p.y>stroke.maxY)stroke.maxY=p.y;
        paint.clearRect(0,0,overlay.width,overlay.height);
        drawPolygonPath(stroke.points);
        // Continue dragging from new point
        return;
      }
    }
    if(tool === 'polygon' || tool === 'blur'){
      if(tool === 'blur' && stroke && stroke.dragged){
        // Freehand blur finishes on pointer up like the brush; the final
        // pointermove already drew to the release position.
        if(overlay.hasPointerCapture(e.pointerId))overlay.releasePointerCapture(e.pointerId);
        finish();
        return;
      }
      // Click mode: vertices finish on right-click or Enter.
      move(e);
      return;
    }
    // Brush finishes on pointer up
    move(e);
    if(overlay.hasPointerCapture(e.pointerId))overlay.releasePointerCapture(e.pointerId);
    finish();
  }
  function handleContextMenu(e){
    if(!tool || !available() || pending) return;
    if(tool === 'line'){
      e.preventDefault();
      if(stroke){
        if(stroke.points.length === 1){
          // One point - cancel
          stroke=null;isLineDragging=false;clear();refreshToolbar();
        }else if(stroke.points.length >= 2){
          // Two or more points - finish
          handleLineFinish();
        }
      }
      return false;
    }
    if(tool === 'polygon' || tool === 'blur'){
      e.preventDefault();
      // Right-click closes the polygon at cursor position and finishes.
      // A lone blur vertex cancels instead.
      if(tool === 'blur' && stroke && stroke.points.length === 1){
        stroke=null;clear();refreshToolbar();return false;
      }
      // Right-click closes polygon at cursor position and finishes
      if(stroke && stroke.points.length >= 2){
        const p = point(e);
        // Add cursor position as final point if not already there
        const last = stroke.points[stroke.points.length-1];
        if(Math.abs(last.x - p.x) > 1 || Math.abs(last.y - p.y) > 1){
          stroke.points.push(p);
        }
        handleLineFinish();
      }
      return false;
    }
  }
  function handleKeyDown(e){
    if(e.key === 'Enter' && (tool === 'line' || tool === 'polygon' || tool === 'blur') && stroke && stroke.points.length >= 2){
      e.preventDefault();
      if(tool === 'polygon' || tool === 'blur'){
        // Add current mouse position as final point (like right-click)
        const last = stroke.points[stroke.points.length-1];
        if(Math.abs(last.x - lastMousePos.x) > 1 || Math.abs(last.y - lastMousePos.y) > 1){
          stroke.points.push(lastMousePos);
        }
      }
      handleLineFinish();
      return;
    }
    if(e.key === 'Escape'){
      cancelPending();stroke=null;isLineDragging=false;clone.cancel();
      if(S360.viewWarp.active){S360.viewWarp.cancel();warpSession=null;S360.renderSphere(ctx);}
      if(isWarp(tool))tool=null;
      clear();hint.hidden=true;refreshToolUI();
    }
  }
  function handleWheel(e){
    if(!available())return;
    if(tool === 'heal'){
      e.preventDefault();
      // Check if heal is in session phase (choosing source) vs stroke phase (drawing destination)
      // clone.pending returns true for both; we check if session exists by seeing if overlay has the preview
      const isSessionPhase = clone && clone.pending && !stroke; // stroke exists in stroke phase
      if(isSessionPhase){
        if(clone.handleWheel) clone.handleWheel(e);
      }else{
        // Stroke phase: change brush size
        const delta = e.shiftKey ? 1 : 2;
        const newSize = Math.max(2, Math.min(64, Number(size.value) - Math.sign(e.deltaY) * delta));
        size.value = newSize;
        S360.settings.updateSliderLabel(size, document.getElementById('drawBrushSizeVal'), newSize);
        refreshToolUI();
        showCursor(point(e)); // Update cursor preview immediately
      }
      return;
    }
    if(isWarp(tool))return;
    if(e.ctrlKey || e.metaKey){
      e.preventDefault();
      beforeViewChange();
      const view=S360.viewer.getSphere();
      view.fov=Math.max(.35,Math.min(2.2,view.fov*(1+Math.sign(e.deltaY)*.1)));
      S360.renderSphere(ctx);
      return;
    }
    e.preventDefault();
    beforeViewChange();
    const delta = e.shiftKey ? 1 : 2;
    const newSize = Math.max(2, Math.min(64, Number(size.value) - Math.sign(e.deltaY) * delta));
    size.value = newSize;
    S360.settings.updateSliderLabel(size, document.getElementById('drawBrushSizeVal'), newSize);
    refreshToolUI();
    if(tool==='brush'||tool==='line'||tool==='polygon'||tool==='blur') showCursor(point(e));
  }
  function undo(){
    if(pending){const committed=pending.committed;cancelPending();clear();hint.hidden=true;if(committed)S360.sourceEdit.undo();refreshToolUI();return;}
    if(warpSession||S360.viewWarp.active){S360.viewWarp.cancel();warpSession=null;clear();S360.renderSphere(ctx);refreshToolbar();return;}
    if(stroke||clone.pending){stroke=null;clone.cancel();clear();refreshToolbar();return;}
    try{S360.sourceEdit.undo();refreshToolbar();}catch(error){fail(error);}
  }
  function reset(){
    cancelPending();stroke=null;healJob=null;tool=null;isLineDragging=false;clone?.cancel();
    if(S360.viewWarp.active){S360.viewWarp.cancel();warpSession=null;}
    if(paint){clear();hint.hidden=true;refreshToolUI();}
  }
  function showControls(visible){
    if(!visible){beforeViewChange();tool=null;}else resize();
    refreshToolUI();
  }
  function init(deps){
    ctx=deps.ctx;const el=id=>document.getElementById(id);
    controls=el('drawingControls');overlay=el('drawOverlayCanvas');paint=overlay.getContext('2d',{willReadFrequently:true});
    gate=el('drawing3dOverlay');hint=el('cloneHint');
    busy=el('drawingBusy');busyMessage=el('drawingBusyMessage');
    brushBtn=el('drawBrushBtn');lineBtn=el('drawLineBtn');polygonBtn=el('drawPolygonBtn');blurBtn=el('drawBlurBtn');healBtn=el('drawHealBtn');
    warpCenterBtn=el('drawWarpCenterBtn');warpSidesBtn=el('drawWarpSidesBtn');
    autoMorphBtn=el('autoMorphBtn');
    morphButtons=[
      ['morph8x1Btn','morph8x1',8],['morph4x1Btn','morph4x1',4],['morph2x1Btn','morph2x1',2],
      ['morph1x1Btn','morph1x1',1],['morph1x2Btn','morph1x2',1/2],['morph1x4Btn','morph1x4',1/4],['morph1x8Btn','morph1x8',1/8]
    ].map(([id,name,aspect])=>({button:el(id),name,aspect}));morphMarkerSize=el('morphMarkerSize');
    undoBtn=el('drawUndoBtn');
    size=el('drawBrushSize');feather=el('cloneFeather');adapt=el('cloneAdapt');
    warpStrength=el('drawWarpStrength');opacitySlider=el('drawOpacity'); // warpStrength is the shared Strength slider (also read by Blur)
    instructionEl=el('drawingInstruction');
    cursor=document.createElement('canvas');cursor.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:6';
    overlay.parentElement.appendChild(cursor);cursorPaint=cursor.getContext('2d');
    clone=S360.viewClone.create({ctx,overlay,radius,commit(pixels,w,h,view){
      const job=healJob;healJob=null;
      dispatch(job,{overlayPixels:pixels,overlayW:w,overlayH:h,source:job?.source,...view});
      tool=null;refreshToolUI();
    }});
    brushBtn.addEventListener('click',()=>toggle('brush'));
    lineBtn.addEventListener('click',()=>toggle('line'));
    polygonBtn.addEventListener('click',()=>toggle('polygon'));
    blurBtn.addEventListener('click',()=>toggle('blur'));
    healBtn.addEventListener('click',()=>toggle('heal'));
    warpCenterBtn.addEventListener('click',()=>toggle('warpCenter'));
    warpSidesBtn.addEventListener('click',()=>toggle('warpSides'));
    autoMorphBtn.addEventListener('click',()=>autoWarp('left'));
    for(const {button,name}of morphButtons)button.addEventListener('click',()=>toggle(name));
    morphMarkerSize.addEventListener('input',()=>{S360.settings.updateSliderLabel(morphMarkerSize,el('morphMarkerSizeVal'),Number(morphMarkerSize.value));refreshToolUI();});
    undoBtn.addEventListener('click',undo);
    for(const input of [size,feather,adapt,warpStrength,opacitySlider]){
      if(input) input.addEventListener('input',()=>{
        const val = Number(input.value);
        if(input.id === 'drawBrushSize') ctx.cfg.drawSize = val;
        else if(input.id === 'cloneFeather') ctx.cfg.drawFeather = val;
        else if(input.id === 'drawOpacity') ctx.cfg.drawOpacity = val;
        S360.settings.updateSliderLabel(input,el(input.id+'Val'),val);refreshToolUI();
      });
    }
    controls.querySelectorAll('.draw-color-btn').forEach(button=>button.addEventListener('click',()=>{
      finish();color=button.dataset.color;controls.querySelectorAll('.draw-color-btn').forEach(b=>b.classList.toggle('active',b===button));
    }));
    overlay.addEventListener('pointerdown',down);
    overlay.addEventListener('pointermove',move);
    overlay.addEventListener('pointerup',up);
    overlay.addEventListener('contextmenu',handleContextMenu);
    overlay.addEventListener('pointercancel',()=>{stroke=null;clone.cancel();if(S360.viewWarp.active){S360.viewWarp.cancel();warpSession=null;S360.renderSphere(ctx);}clear();refreshToolbar();});
    overlay.addEventListener('pointerleave',()=>cursorPaint.clearRect(0,0,cursor.width,cursor.height));
    overlay.addEventListener('wheel',handleWheel,{passive:false});
    document.addEventListener('input',e=>{if(!controls.contains(e.target))beforeViewChange();},true);
    document.addEventListener('keydown',handleKeyDown);
    window.addEventListener('resize',resize);
    ctx.panoramaCanvas.addEventListener('webglcontextlost',()=>{cancelPending();stroke=null;clone.cancel();if(S360.viewWarp.active){S360.viewWarp.cancel();warpSession=null;}clear();refreshToolUI();});
    ctx.panoramaCanvas.addEventListener('webglcontextrestored',()=>{resize();refreshToolUI();});
    syncCanvasSliders();
    resize();refreshToolUI();
  }
  S360.drawing={init,reset,showControls,refreshToolbar,beforeViewChange,flush,syncViewSize:resize,syncCanvasSliders,get isBaking(){return !!pending;}};
})(window.S360);
