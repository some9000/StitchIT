// Owns the two-line 3D manual horizon tool, its overlay, magnifier, camera flip,
// and input lifetime. init({ctx}) maps view drags onto the panorama sphere.
window.S360 = window.S360 || {};
S360.manualHorizon = (() => {
  'use strict';
  const PI=Math.PI;
  let ctx,button,overlay,info,panorama;
  let active=false,dragging=false,start=null,cursor=null;
  let planes=[],previousView='2d',previousCamera=null,previousInteraction=true;

  const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  function normalize(v){const n=Math.hypot(v[0],v[1],v[2]);return n>1e-8?[v[0]/n,v[1]/n,v[2]/n]:null;}
  function canonical(v,preferUp=false){
    const n=normalize(v);if(!n)return null;
    if(preferUp&&Math.abs(n[2])>1e-7)return n[2]<0?n.map(q=>-q):n;
    let major=0;if(Math.abs(n[1])>Math.abs(n[major]))major=1;if(Math.abs(n[2])>Math.abs(n[major]))major=2;
    return n[major]<0?n.map(q=>-q):n;
  }

  function pointFromEvent(e){
    const r=overlay.getBoundingClientRect();
    return{x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};
  }
  function resize(){
    if(!overlay||!panorama)return;
    const r=panorama.getBoundingClientRect(),p=overlay.parentElement.getBoundingClientRect();
    overlay.style.left=`${r.left-p.left}px`;overlay.style.top=`${r.top-p.top}px`;
    overlay.style.width=`${r.width}px`;overlay.style.height=`${r.height}px`;
    overlay.width=panorama.width;overlay.height=panorama.height;draw();
  }
  function drawLine(g,a,b,color){
    const w=overlay.width,h=overlay.height;
    g.strokeStyle=color;g.lineWidth=Math.max(2,w/700);g.lineCap='round';
    g.beginPath();g.moveTo(a.x*w,a.y*h);g.lineTo(b.x*w,b.y*h);g.stroke();
    for(const p of[a,b]){g.fillStyle=color;g.beginPath();g.arc(p.x*w,p.y*h,Math.max(4,w/350),0,PI*2);g.fill();}
  }
  function drawMagnifier(g){
    if(!cursor||!active)return;
    const w=overlay.width,h=overlay.height,x=cursor.x*w,y=cursor.y*h;
    const r=Math.max(42,Math.min(90,Math.min(w,h)*.14)),srcR=Math.max(8,r/2);
    g.save();g.beginPath();g.arc(x,y,r,0,PI*2);g.clip();
    g.drawImage(panorama,x-srcR,y-srcR,srcR*2,srcR*2,x-r,y-r,r*2,r*2);g.restore();
    g.strokeStyle='#fff';g.lineWidth=2;g.beginPath();g.arc(x,y,r,0,PI*2);g.stroke();
    g.fillStyle='#fff';g.beginPath();g.arc(x,y,Math.max(2.5,w/700),0,PI*2);g.fill();
  }
  function draw(){
    if(!overlay)return;const g=overlay.getContext('2d');g.clearRect(0,0,overlay.width,overlay.height);
    drawMagnifier(g);
    if(dragging&&start&&cursor)drawLine(g,start,cursor,planes.length?'#fb923c':'#22d3ee');
  }
  function setInfo(text){info.textContent=text;info.classList.toggle('visible',active);}

  // getPanoramaUvAt mirrors the exact live camera and projection shader. Convert
  // its GL texture coordinate back to the canonical stitch sphere direction.
  function sphereDirection(p){
    const uv=S360.viewer.getPanoramaUvAt(p.x,p.y);if(!uv)return null;
    const lon=uv.u*PI*2,lat=PI*.5-uv.v*PI,cl=Math.cos(lat);
    return[cl*Math.cos(lon),cl*Math.sin(lon),Math.sin(lat)];
  }
  function analyzeLine(a,b){
    const ra=sphereDirection(a),rb=sphereDirection(b);if(!ra||!rb)return null;
    const separation=Math.acos(Math.max(-1,Math.min(1,dot(ra,rb))));
    if(separation<3*PI/180)return null;
    const normal=canonical(cross(ra,rb));return normal?{normal,separation}:null;
  }
  function fittedUp(){
    if(planes.length!==2)return null;
    if(Math.abs(dot(planes[0].normal,planes[1].normal))>.985)return null;
    return canonical(cross(planes[0].normal,planes[1].normal),true);
  }
  function restoreView(){
    const camera=S360.viewer.getSphere();
    if(camera&&previousCamera)Object.assign(camera,previousCamera);
    ctx.setSphereInteractionEnabled(previousInteraction);
    if(previousView==='3d')S360.renderSphere(ctx);else S360.setViewMode('2d',ctx);
    ctx.updateCanvasCursor?.();
  }
  function stop(restore=true){
    if(!active)return;
    active=false;dragging=false;start=null;cursor=null;planes=[];
    overlay.classList.remove('active');button.classList.remove('active');button.setAttribute('aria-pressed','false');info.classList.remove('visible');
    overlay.getContext('2d').clearRect(0,0,overlay.width,overlay.height);
    if(restore)restoreView();
  }
  function apply(){
    const up=fittedUp();
    if(!up){
      S360.uiChrome.showToast('The two vertical references describe nearly the same direction. Try lines at different horizontal positions.',{type:'warning'});
      const camera=S360.viewer.getSphere();
      if(camera&&previousCamera)Object.assign(camera,previousCamera);
      S360.renderSphere(ctx);
      planes=[];start=null;cursor=null;
      setInfo('Try again: draw a vertical line, then another after the 180° turn. ESC cancels.');draw();return;
    }
    const correction=S360.horizonLeveling.correctionFromOutputNormal(up,ctx.cfg.horizon);
    ctx.cfg.horizon.pitch=Math.round(correction.pitch*10)/10;ctx.cfg.horizon.roll=Math.round(correction.roll*10)/10;
    S360.settings.updateUIFromConfig(ctx);S360.settings.scheduleLiveSave(ctx);
    const summary=`Pitch ${ctx.cfg.horizon.pitch.toFixed(1)}°, Roll ${ctx.cfg.horizon.roll.toFixed(1)}°`;
    stop(true);S360.uiChrome.showToast('Manual horizon applied: '+summary,{type:'success'});
  }
  function flipCamera(){
    const camera=S360.viewer.getSphere();if(!camera)return;
    camera.yaw=((camera.yaw+PI)%(PI*2)+PI*2)%(PI*2);S360.renderSphere(ctx);
  }
  function acceptLine(a,b){
    const line=analyzeLine(a,b);
    if(!line){S360.uiChrome.showToast('Draw a longer vertical line inside the 3D view.',{type:'warning'});draw();return;}
    planes.push(line);start=null;cursor=null;draw();
    if(planes.length===1){flipCamera();setInfo('View rotated 180°. Draw a second vertical line at a different horizontal position. ESC cancels.');}
    else apply();
  }
  function startTool(){
    if(active){stop(true);return;}
    if(!ctx.getCurrentImg()){S360.uiChrome.showToast('Load an image before marking vertical references.',{type:'warning'});return;}
    if(S360.compare?.isActive){S360.uiChrome.showToast('Close Compare before using Manual Horizon.',{type:'warning'});return;}
    S360.drawing?.beforeViewChange();previousView=ctx.getViewMode();
    if(previousView!=='3d')S360.setViewMode('3d',ctx);
    const camera=S360.viewer.getSphere();if(!camera)return;
    previousCamera={yaw:camera.yaw,pitch:camera.pitch,fov:camera.fov};
    previousInteraction=ctx.getSphereInteractionEnabled();ctx.setSphereInteractionEnabled(false);
    active=true;planes=[];button.classList.add('active');button.setAttribute('aria-pressed','true');overlay.classList.add('active');
    setInfo('Draw one vertical line in the 3D view. Releasing rotates the view 180°. ESC cancels.');
    resize();requestAnimationFrame(resize);
  }
  function init(deps){
    ctx=deps.ctx;button=document.getElementById('manualHorizonBtn');overlay=document.getElementById('manualHorizonCanvas');
    info=document.getElementById('manualHorizonInfo');panorama=document.getElementById('panoramaCanvas');
    button?.addEventListener('click',startTool);
    overlay?.addEventListener('pointerdown',e=>{
      if(!active||e.button!==0)return;start=pointFromEvent(e);cursor=start;dragging=true;overlay.setPointerCapture(e.pointerId);draw();e.preventDefault();
    });
    overlay?.addEventListener('pointermove',e=>{if(active){cursor=pointFromEvent(e);draw();}});
    overlay?.addEventListener('pointerup',e=>{
      if(!active||!dragging)return;const end=pointFromEvent(e);dragging=false;cursor=end;acceptLine(start,end);
    });
    overlay?.addEventListener('pointercancel',()=>{if(active){dragging=false;start=null;cursor=null;draw();}});
    overlay?.addEventListener('pointerleave',()=>{if(active&&!dragging){cursor=null;draw();}});
    document.addEventListener('keydown',e=>{if(active&&e.key==='Escape'){e.preventDefault();stop(true);}});
    window.addEventListener('resize',()=>{if(active)resize();});
  }
  return{init,cancel:()=>stop(true),get active(){return active;}};
})();
