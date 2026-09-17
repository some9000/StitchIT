// Run with: node dev-regression.cjs. No browser or third-party packages required.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert/strict');
const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
function env(extra = {}) { const x = { console, ...extra }; x.window = x; x.S360 = {}; vm.createContext(x); return x; }
function run(x, name) { vm.runInContext(read(name), x, {filename:name}); }
// Independent forward sphere-shader oracle: view pixel -> world direction.
const PI=Math.PI,TWO_PI=2*PI;
function referenceProjection(camera,x,y,w,h){
  const s=camera.proj??1,qx=(2*x/w-1)*w/h,qy=1-2*y/h,r=Math.hypot(qx,qy);
  const theta=Math.atan(r*Math.tan(s*camera.fov/2))/s;
  if(theta>=PI-1e-7)return null;
  const cy=Math.cos(camera.yaw),sy=Math.sin(camera.yaw),cp=Math.cos(camera.pitch),sp=Math.sin(camera.pitch);
  const forward=[cp*sy,sp,cp*cy],right=[-cy,0,sy],up=[-sp*sy,cp,-sp*cy];
  const k=r>1e-8?Math.sin(theta)/r:0;
  const ray=forward.map((f,i)=>f*Math.cos(theta)+(right[i]*qx+up[i]*qy)*k);
  if(camera.mirror)ray[0]=-ray[0];return ray;
}
const checks = [];
function check(name, fn) { checks.push([name, fn]); }
check('Decal changes preserve a pending settings save', () => {
  const timers=new Map(),writes=[],warnings=[];let next=0;
  const x=env({setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id),
    localStorage:{setItem:(...v)=>writes.push(v)},console:{warn:(...v)=>warnings.push(v)}});
  run(x,'settings.js');run(x,'stitch-decal.js');x.S360.getWatermarkProgram=()=>({});
  const ctx={LIVE_KEY:'live',cfg:{radius:95,outerMargin:100,blend:{seamWidth:0.5,seamShift:0}},postUniforms:{},getScaleValue:()=>1,
    getWmSize:()=>x.S360.stitchDecal.decals.bottom.size,getWmRotDeg:()=>0,getWmTopSize:()=>.3,getWmTopRotDeg:()=>0};
  x.S360.stitchDecal.init({gl:{},getViewMode:()=> '2d',scheduleRender:()=>{},scheduleLiveSave:()=>x.S360.settings.scheduleLiveSave(ctx)});
  let input;x.S360.stitchDecal.wireDecalControls(x.S360.stitchDecal.decals.bottom,{sizeSlider:{addEventListener:(e,fn)=>input=fn}});
  x.S360.settings.scheduleLiveSave(ctx);input({target:{value:'40'}});timers.forEach(fn=>fn());
  assert.equal(warnings.length,0);assert.equal(writes.length,1);
  const saved=JSON.parse(writes[0][1]);assert.equal(saved.cfg.radius,95);assert.equal(saved.cfg.outerMargin,100);assert.equal(saved.cfg.blend.seamWidth,.5);assert.equal(saved.wm.size,.4);
});
check('Preprocessing preset restores its switch and guarded source settings', () => {
  const localStorage={data:{},setItem(k,v){this.data[k]=v;},getItem(k){return this.data[k]||null;}};
  const x=env({localStorage});run(x,'settings.js');
  x.S360.stitchDecal={decals:{bottom:{size:.3,rotDeg:0},top:{size:.3,rotDeg:0}}};
  const ctx={LIVE_KEY:'live',getScaleValue:()=>1,postUniforms:{},cfg:{preprocessingEnabled:false,
    denoiseStrength:1.2,chromaCleanup:.8,caRed:1.3,caBlue:-.7,focusRecovery:.45,focusRadius:2.4}};
  x.S360.settings.savePreprocessSnapshot(ctx);
  Object.assign(ctx.cfg,{preprocessingEnabled:true,denoiseStrength:0,chromaCleanup:0,caRed:0,caBlue:0,focusRecovery:0,focusRadius:.5});
  assert.equal(x.S360.settings.loadPreprocessSnapshot(ctx),true);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.cfg)),{preprocessingEnabled:false,
    denoiseStrength:1.2,chromaCleanup:.8,caRed:1.3,caBlue:-.7,focusRecovery:0,focusRadius:.5});
  ctx.postUniforms={exposure:1};ctx.DEFAULT_POST={exposure:1};
  ctx.getPostEnabled=()=>true;ctx.setPostEnabled=()=>{};ctx.PROC_SNAPSHOT_KEY='proc';
  x.S360.settings.saveProcSnapshot(ctx);
  ctx.cfg.focusRecovery=.9;ctx.cfg.focusRadius=1;
  assert.equal(x.S360.settings.loadProcSnapshot(ctx),true);
  assert.equal(ctx.cfg.focusRecovery,.0);assert.equal(ctx.cfg.focusRadius,.5);
});
check('Focus analysis rejects flat selections and increases recovery for blurred detail', () => {
  const x=env();run(x,'focus-recovery.js');
  const make=(blurPasses,valueAt)=>{
    const n=96;let values=new Float64Array(n*n);
    for(let y=0;y<n;y++)for(let xx=0;xx<n;xx++)values[y*n+xx]=valueAt(xx,y);
    for(let pass=0;pass<blurPasses;pass++){
      const next=new Float64Array(values.length);
      for(let y=0;y<n;y++)for(let xx=0;xx<n;xx++){
        let sum=0,count=0;
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
          const sx=xx+dx,sy=y+dy;
          if(sx>=0&&sy>=0&&sx<n&&sy<n){sum+=values[sy*n+sx];count++;}
        }
        next[y*n+xx]=sum/count;
      }
      values=next;
    }
    const data=new Uint8ClampedArray(n*n*4);
    for(let i=0;i<values.length;i++)data.set([values[i],values[i],values[i],255],i*4);
    return {data,n};
  };
  const pattern=(xx,y)=>((xx>>3)+(y>>3))%2?255:0;
  const crisp=make(0,pattern),blurred=make(3,pattern),flat=make(0,()=>128);
  const a=x.S360.focusRecovery.analyzeBlur(crisp,crisp.n,crisp.n);
  const b=x.S360.focusRecovery.analyzeBlur(blurred,blurred.n,blurred.n);
  const c=x.S360.focusRecovery.analyzeBlur(flat,flat.n,flat.n);
  assert.ok(a.confidence>=.2);assert.ok(b.confidence>=.2);assert.ok(c.confidence<.2);
  assert.ok(b.estimatedBlurRadius>a.estimatedBlurRadius);
  assert.ok(b.estimatedBlurRadius>1.5,'blurred detail must not saturate at the minimum radius');
  assert.ok(b.estimatedRecovery>a.estimatedRecovery);
  assert.ok(Number.isInteger(b.estimatedBlurRadius*10));
  assert.ok(Number.isInteger(b.estimatedRecovery*100));
});
check('Live settings preserve the Processing ON/OFF switch', () => {
  const localStorage={data:{},setItem(k,v){this.data[k]=v;},getItem(k){return this.data[k]||null;},removeItem(){}};
  const x=env({localStorage});run(x,'settings.js');
  x.S360.stitchDecal={decals:{bottom:{size:.3,rotDeg:0},top:{size:.3,rotDeg:0}}};
  let enabled=false;
  const ctx={LIVE_KEY:'live',cfg:{},postUniforms:{exposure:1},DEFAULT_POST:{exposure:1},
    getScaleValue:()=>1,setScaleValue:()=>{},getPostEnabled:()=>enabled,setPostEnabled:v=>enabled=v};
  x.S360.settings.saveLiveConfig(ctx);enabled=true;x.S360.settings.loadLiveConfig(ctx);
  assert.equal(enabled,false);
});
check('Canvas and geometry presets restore only their owned settings', () => {
  const localStorage={data:{},setItem(k,v){this.data[k]=v;},getItem(k){return this.data[k]||null;}};
  const x=env({localStorage});run(x,'settings.js');
  x.S360.stitchDecal={decals:{bottom:{size:.3,rotDeg:0},top:{size:.3,rotDeg:0}}};
  const ctx={LIVE_KEY:'live',SNAPSHOT_KEY:'geometry',getScaleValue:()=>1,setScaleValue:()=>{},
    postUniforms:{exposure:1},DEFAULT_POST:{exposure:1},cfg:{outerMargin:91,radius:94,mirror3D:false,
      blend:{seamWidth:.5,seamShift:0},centers:{left:[.25,.5],right:[.75,.5]},rollDeg:{left:0,right:0},
      width:{left:0,right:0},height:{left:0,right:0},angle:{left:0,right:0},
      drawSize:18,drawFeather:4,drawOpacity:80}};
  x.S360.settings.saveSnapshot(ctx);x.S360.settings.saveCanvasSnapshot(ctx);x.S360.settings.saveAlignmentSnapshot(ctx);
  Object.assign(ctx.cfg,{outerMargin:99,drawSize:7,drawFeather:1,drawOpacity:20});ctx.postUniforms.exposure=2;
  assert.equal(x.S360.settings.loadCanvasSnapshot(ctx),true);
  assert.equal(ctx.cfg.outerMargin,99);assert.equal(ctx.postUniforms.exposure,2);
  assert.deepEqual([ctx.cfg.drawSize,ctx.cfg.drawFeather,ctx.cfg.drawOpacity],[18,4,80]);
  ctx.cfg.drawSize=9;ctx.cfg.width.left=2;assert.equal(x.S360.settings.loadSnapshot(ctx),true);
  assert.equal(ctx.cfg.outerMargin,91);assert.equal(ctx.cfg.width.left,2);assert.equal(ctx.cfg.drawSize,9);assert.equal(ctx.postUniforms.exposure,2);
  ctx.cfg.outerMargin=97;assert.equal(x.S360.settings.loadAlignmentSnapshot(ctx),true);
  assert.equal(ctx.cfg.width.left,0);assert.equal(ctx.cfg.outerMargin,97);assert.equal(ctx.cfg.drawSize,9);
});
check('Decal loads reject stale completions after replacement, removal, and context loss',()=>{
  const images=[],revoked=[],released=[],uploads=[],warnings=[];let saves=0,renders=0,lost=false,next=0;
  const x=env({Image:function(){this.width=8;this.height=4;images.push(this);},
    URL:{createObjectURL:()=>`blob:${++next}`,revokeObjectURL:url=>revoked.push(url)},
    console:{warn:(...args)=>warnings.push(args)}});
  run(x,'webgl-utils.js');run(x,'render-target.js');run(x,'stitch-decal.js');x.S360.releaseImage=img=>released.push(img);
  x.S360.getWatermarkProgram=()=>({});
  const gl=new Proxy({isContextLost:()=>lost,createTexture:()=>({}),
    texImage2D:(...args)=>uploads.push(args.at(-1))},{get:(o,k)=>k in o?o[k]:()=>{}});
  const {bottom,top}=x.S360.stitchDecal.init({gl,getViewMode:()=> '2d',
    scheduleRender:()=>renders++,scheduleLiveSave:()=>saves++});
  const start=slot=>{slot.loadFile({name:'decal.png'});const img=images.at(-1);return {img,done:img.onload,fail:img.onerror};};
  const a=start(bottom),b=start(bottom),t=start(top);
  b.done();const selected=bottom.tex;a.done();t.done();
  assert.equal(bottom.tex,selected);assert.deepEqual(uploads,[b.img,t.img]);
  assert.equal(saves,2);assert.equal(renders,2);
  assert.equal(a.img.onload,null);assert.equal(a.img.onerror,null);
  const removed=start(bottom);bottom.remove(gl);removed.done();
  assert.equal(bottom.active,false);assert.equal(uploads.length,2);
  const failed=start(top);failed.fail();
  assert.equal(top.loaded,true);assert.equal(warnings.length,1);
  const dead=start(top);lost=true;top.clearForContextLoss();lost=false;dead.done();
  assert.equal(top.active,false);assert.equal(uploads.length,2);
  // A callback can arrive after the GPU is lost but before its event handler runs.
  const early=start(bottom);lost=true;early.done();lost=false;
  assert.equal(bottom.active,false);assert.equal(uploads.length,2);
  const fresh=start(bottom);fresh.done();
  assert.equal(bottom.loaded,true);assert.equal(uploads.length,3);
  assert.equal(new Set(revoked).size,images.length);assert.equal(revoked.length,images.length);
  assert.equal(released.length,images.length);assert.equal(new Set(released).size,images.length);
});
check('Repeated scheduling always leaves a final frame, and cancellation clears both handles',()=>{
  const timers=new Map(),frames=new Map(),renders=[];let id=0;
  const x=env({setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:i=>timers.delete(i),
    requestAnimationFrame:fn=>{frames.set(++id,fn);return id;},cancelAnimationFrame:i=>frames.delete(i)});
  run(x,'render-scheduler.js');const scheduler=x.S360.createRenderScheduler({render:c=>renders.push(c),hasSource:()=>true});
  scheduler.schedule();scheduler.schedule();assert.equal(frames.size,1);assert.equal(timers.size,1);
  frames.forEach(fn=>fn());timers.forEach(fn=>fn());assert.deepEqual(renders,[false]);
  frames.clear();timers.clear();scheduler.schedule();scheduler.cancel();assert.equal(frames.size+timers.size,0);
});
check('Cancelled render jobs do not execute queued stale callbacks',()=>{
  const timers=new Map(),frames=new Map(),renders=[];let id=0;
  const x=env({setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:i=>timers.delete(i),
    requestAnimationFrame:fn=>{frames.set(++id,fn);return id;},cancelAnimationFrame:i=>frames.delete(i)});
  run(x,'render-scheduler.js');
  const scheduler=x.S360.createRenderScheduler({render:c=>renders.push(c),hasSource:()=>true});
  scheduler.schedule();
  const frameId = [...frames.keys()][0];
  const staleFrame = frames.get(frameId);
  scheduler.cancel();
  assert.equal(frames.size,0);
  assert.equal(timers.size,0);
  staleFrame();
  assert.deepEqual(renders,[]);
  scheduler.schedule();
  const laterFrame = [...frames.keys()][0];
  frames.get(laterFrame)();
  assert.deepEqual(renders,[true]);
});
check('Render scheduler exposes pending-state diagnostics',()=>{
  const timers=new Map(),frames=new Map();let id=0;
  const x=env({setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:i=>timers.delete(i),
    requestAnimationFrame:fn=>{frames.set(++id,fn);return id;},cancelAnimationFrame:i=>frames.delete(i)});
  run(x,'render-scheduler.js');
  const scheduler=x.S360.createRenderScheduler({render:()=>{},hasSource:()=>true});
  scheduler.schedule();
  const summary = scheduler.summary();
  assert.equal(summary.frame, true);
  assert.equal(summary.fine, true);
  assert.equal(summary.queued, true);
  scheduler.cancel();
  const reset = scheduler.summary();
  assert.equal(reset.frame, false);
  assert.equal(reset.fine, false);
  assert.equal(reset.queued, false);
});
check('Native patch registration recovers fractional source-pixel shifts',()=>{
  const x=env();run(x,'frame-registration.js');const w=128,h=128,dx=1.35,dy=-.72;
  const pattern=(px,py)=>Math.sin(px*.173)+.7*Math.cos(py*.137)+.45*Math.sin((px+py)*.091)+.2*Math.cos((px-py)*.23);
  const ref=new Float32Array(w*h),cur=new Float32Array(w*h);
  for(let y=0;y<h;y++)for(let col=0;col<w;col++){
    ref[y*w+col]=pattern(col,y);cur[y*w+col]=pattern(col-dx,y-dy);
  }
  const fit=x.S360.frameRegistration.refinePatch(ref,cur,w,h);
  assert.equal(fit.rejected,undefined);assert.ok(Math.abs(fit.dx-dx)<.18,`dx ${fit.dx}`);assert.ok(Math.abs(fit.dy-dy)<.18,`dy ${fit.dy}`);
});
check('Viewer interaction state survives GPU-resource reset',()=>{
  const events={},local={};const x=env({addEventListener:(e,fn)=>events[e]=fn,cancelAnimationFrame:()=>{}});run(x,'viewer.js');
  x.S360.renderSphere=()=>{};
  const canvas={style:{},clientHeight:100,addEventListener:(e,fn)=>local[e]=fn};
  const ctx={getViewMode:()=> '3d',getSphereInteractionEnabled:()=>true};
  const original=x.S360.initSphereViewer({},canvas,ctx);original.yaw=.2;
  x.S360.invalidateViewerResources();const restored=x.S360.initSphereViewer({},canvas,ctx);
  local.mousedown({clientX:0,clientY:0});events.mousemove({clientX:20,clientY:0});
  assert.equal(original,restored);assert.ok(restored.yaw>.2);
});
check('Seam results invalidate the stitch; source reset terminates pending work',()=>{
  let worker,dirty=0,scheduled=0,terminated=0;
  const x=env({Worker:function(){worker=this;this.postMessage=()=>{};this.terminate=()=>terminated++;}});run(x,'webgl-utils.js');run(x,'render-target.js');run(x,'stitch-seam.js');
  const gl=new Proxy({createTexture:()=>({}),isContextLost:()=>false},{get:(o,k)=>k in o?o[k]:()=>{}});
  x.S360.stitchSeam.init({gl,cfg:{radius:95,outerMargin:100},getGainR:()=>({gain:[1,1,1]}),getCurrentImg:()=>({width:10,height:5,isGpuImage:true}),
    getCurrentTexture:()=>({}),scheduleRender:()=>scheduled++,markStitchDirty:()=>dirty++,
    makeProxy:()=>({w:10,h:5,data:new Uint8Array(200),scale:1}),gpuImageToProxyCanvas:()=>({width:10,height:5}),
    resolveAnalysisSource:x.S360.resolveAnalysisSource});
  assert.ok(x.S360.stitchSeam.getSeamTexture(),'fallback seam curve is bound right after init');
  x.S360.stitchSeam.updateContentAwareSeam();worker.onmessage({data:{type:'result',curve:new Uint8Array(256)}});
  assert.equal(scheduled,1);assert.equal(dirty,1);x.S360.stitchSeam.clearForContextLoss();
  assert.ok(x.S360.stitchSeam.getSeamTexture(),'clearForContextLoss rebinds the fallback curve with a live context');assert.equal(terminated,1);assert.equal(worker.onmessage,null);
  x.S360.stitchSeam.updateContentAwareSeam();x.S360.stitchSeam.reset();assert.equal(terminated,2);
});
check('Stale seam jobs are ignored when a newer source request supersedes them',()=>{
  const timers=new Map(),posts=[];let next=0;
  const x=env({setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id),
    Worker:function(){this.postMessage=(payload)=>posts.push(payload);this.terminate=()=>{};},
    location:{protocol:'https:'}});
  run(x,'webgl-utils.js');run(x,'render-target.js');run(x,'stitch-seam.js');
  const gl=new Proxy({createTexture:()=>({}),isContextLost:()=>false,texParameteri:()=>{},texImage2D:()=>{},texSubImage2D:()=>{},activeTexture:()=>{},bindTexture:()=>{},deleteTexture:()=>{}},{get:(o,k)=>k in o?o[k]:()=>{}});
  let scheduleCalls=0;
  x.S360.stitchSeam.init({gl,cfg:{radius:95,outerMargin:100},getGainR:()=>({gain:[1,1,1]}),getCurrentImg:()=>({width:10,height:5,isGpuImage:true}),
    getCurrentTexture:()=>({}),scheduleRender:()=>scheduleCalls++,markStitchDirty:()=>{},
    makeProxy:()=>({w:10,h:5,data:new Uint8Array(200),scale:1}),gpuImageToProxyCanvas:()=>({width:10,height:5}),
    resolveAnalysisSource:x.S360.resolveAnalysisSource});
  x.S360.stitchSeam.scheduleContentAwareSeam();
  x.S360.stitchSeam.scheduleContentAwareSeam();
  assert.equal(timers.size,1);
  const only = [...timers.values()][0];
  only();
  assert.equal(posts.length,1);
  assert.equal(posts[0].requestId,2);
  assert.equal(scheduleCalls,1);
});
check('Single-flight workers replay the latest queued job after worker failure',()=>{
  const workers=[];let dispatched=0,received=[];
  const x=env({location:{protocol:'https:'},Worker:function(){
    this.postMessage=()=>{dispatched++;};
    this.terminate=()=>{};
    workers.push(this);
  }});run(x,'webgl-utils.js');
  const worker=x.S360.createSingleFlightWorker({url:'test-worker.js',label:'Test worker',onMessage:msg=>received.push(msg.type)});
  assert.equal(worker.request(()=>worker.post({job:1})),true);
  assert.equal(worker.request(()=>worker.post({job:2})),true);
  workers[0].onerror({message:'crashed'});
  assert.equal(workers.length,2);
  assert.equal(dispatched,2);
  assert.deepEqual(received,['error']);
});
check('GPU memory tracker exposes a structured diagnostics summary',()=>{
  const x=env({console:{group:()=>{},table:()=>{},groupEnd:()=>{},log:()=>{}}});
  run(x,'gpu-memory.js');
  x.S360.gpuMem.init({ getParameter: () => 4096 });
  x.S360.gpuMem.track('a', 1024, 'First');
  x.S360.gpuMem.track('b', 2048, 'Second');
  const summary = x.S360.gpuMem.summary();
  assert.equal(summary.count, 2);
  assert.equal(summary.total, 3072);
  assert.equal(summary.entries[0].label, 'Second');
  assert.ok(summary.headroom >= 0);
  assert.equal(typeof x.S360.gpuMem.log, 'function');
});
check('UI chrome publishes only defined startup methods',()=>{
  const x=env();run(x,'ui-chrome.js');
  assert.equal(typeof x.S360.uiChrome.init,'function');
  assert.equal(typeof x.S360.uiChrome.setLoading,'function');
});
check('Error messages auto-dismiss and their close button removes them',()=>{
  const timers=[];
  const makeElement=()=>{
    const classes=new Set(),handlers={};
    return {children:[],parentNode:null,className:'',textContent:'',
      classList:{add:v=>classes.add(v),contains:v=>classes.has(v)},
      setAttribute(){},addEventListener:(type,fn)=>handlers[type]=fn,
      appendChild(child){child.parentNode=this;this.children.push(child);},
      removeChild(child){this.children=this.children.filter(x=>x!==child);child.parentNode=null;},
      _handlers:handlers,_classes:classes};
  };
  const container=makeElement();
  const x=env({document:{getElementById:id=>id==='toastContainer'?container:null,createElement:makeElement},
    setTimeout:(fn,delay)=>{timers.push({fn,delay});return timers.length;}});
  run(x,'ui-chrome.js');
  const automatic=x.S360.uiChrome.showToast('failed');
  assert.equal(timers[0].delay,7000);
  timers.shift().fn();assert.ok(automatic._classes.has('toast-exit'));
  timers.shift().fn();assert.equal(automatic.parentNode,null);
  const manual=x.S360.uiChrome.showToast('persistent',{persistent:true});
  const close=manual.children.at(-1);
  assert.equal(close.type,'button');close._handlers.click();
  timers.shift().fn();assert.equal(manual.parentNode,null);
});
check('Lens alignment preserves original coordinates for GPU proxies',async()=>{
  const x=env({location:{protocol:'file:'},setTimeout,clearTimeout});
  run(x,'webgl-utils.js');
  let observed=null;
  x.S360.lensAlignmentKernel={optimizeAsync:async(proxy,w,h)=>{
    observed={scale:proxy.scale,w,h};
    return {params:{},baselineValue:1,optimizedValue:1,evaluations:1};
  }};
  run(x,'lens-alignment.js');
  const cfg={centers:{left:[.25,.5],right:[.75,.5]},width:{left:0,right:0},height:{left:0,right:0},angle:{left:0,right:0},radius:95,outerMargin:100,rollDeg:{left:0,right:0}};
  x.S360.lensAlignment.init({gl:{},cfg,getCurrentImg:()=>({isGpuImage:true,width:4000,height:2000}),getCurrentTexture:()=>({}),getGainR:()=>({gain:[1,1,1]}),
    resolveAnalysisSource:(img,texture)=>({...img,texture}),gpuImageToProxyCanvas:()=>({width:1000,height:500}),
    makeProxy:()=>({w:1000,h:500,data:new Uint8ClampedArray(4),scale:1})});
  await x.S360.lensAlignment.autoAlign();
  assert.deepEqual(observed,{scale:.25,w:4000,h:2000});
});
check('Lens alignment applies calibration gain to the right lens only',()=>{
  const x=env();run(x,'geometry.js');run(x,'lens-alignment-kernel.js');
  x.S360.lensParams=()=>({halfFov:2,radiusOuter:1,f:1});
  x.S360.lensBasis=isRight=>({isRight,axis:[isRight?1:-1,0,0],up:[0,0,1],right:[0,1,0]});
  x.S360.sourcePoint=(_v,basis)=>({x:basis.isRight?1:0,y:0});
  x.S360.sampleBilinear=(_proxy,x,_y,out)=>{const v=x ? .25 : .5;out[0]=v;out[1]=v;out[2]=v;return out;};
  const cfg={centers:{left:[.25,.5],right:[.75,.5]},width:{left:0,right:0},height:{left:0,right:0},angle:{left:0,right:0},radius:95,outerMargin:100,rollDeg:{left:0,right:0}};
  const objective=x.S360.lensAlignmentKernel.makeObjective({scale:1},4,2,cfg,[2,2,2]);
  assert.equal(objective([.25,.75,0,0,0,0,0,0]),0);
});
check('Lens alignment kernel optimises seam continuity',()=>{
  const x=env({Worker:function(){this.postMessage=()=>{};this.terminate=()=>{};}});
  run(x,'webgl-utils.js');run(x,'render-target.js');run(x,'geometry.js');run(x,'lens-alignment-kernel.js');
  // Build a synthetic dual-fisheye-like proxy: 2:1 image with two halves.
  const W=400,H=200;
  const proxy={w:W,h:H,data:new Uint8ClampedArray(W*H*4),scale:1};
  // Left half = gradient, right half = mirrored gradient (seam in middle).
  for(let y=0;y<H;y++){for(let x=0;x<W;x++){
    const i=(y*W+x)*4;
    const lum=(x/W*255);
    const r=lum,g=lum,b=255-lum;
    proxy.data[i]=r;proxy.data[i+1]=g;proxy.data[i+2]=b;proxy.data[i+3]=255;
  }}
  const cfg={centers:{left:[0.25,0.5],right:[0.75,0.5]},width:{left:0,right:0},height:{left:0,right:0},angle:{left:0,right:0},radius:95,outerMargin:100,rollDeg:{left:0,right:0}};
  const result=x.S360.lensAlignmentKernel.optimize(proxy,W,H,cfg,[1,1,1]);
  assert.ok(result.params,'kernel returns params');
  assert.ok(result.iterations>0,'kernel ran iterations');
  assert.ok(result.confidence>=0&&result.confidence<=1,'confidence in range');
  assert.equal(Math.round(result.params.centerL*1000),result.params.centerL*1000,'center result follows its 0.001 UI step');
  for(const key of ['widthL','widthR','heightL','heightR','angleL','angleR'])
    assert.equal(Math.round(result.params[key]*20),result.params[key]*20,`${key} follows its 0.05 UI step`);
});
check('Automatic lens geometry recovers a synthetic 180-degree ring and overlap',()=>{
  const x=env();run(x,'geometry.js');run(x,'lens-geometry-kernel.js');const S=x.S360;
  const W=400,H=200,base=100;
  const truth={radius:92,outerMargin:98,centers:{left:[.25,.5],right:[.75,.5]},
    width:{left:0,right:0},height:{left:0,right:0},angle:{left:0,right:0},rollDeg:{left:0,right:0}};
  const lens=S.lensParams(truth,base),data=new Uint8ClampedArray(W*H*4);
  for(let y=0;y<H;y++)for(let px=0;px<W;px++){
    const isRight=px>=W/2,basis=S.lensBasis(isRight,truth),center=[W*(isRight?.75:.25),H*.5];
    const v=S.sourceDirection(px,y,basis,center,lens.radiusOuter,lens.halfFov,lens.f,1,0,1);
    const i=(y*W+px)*4;
    if(v){
      const q=.5+.18*Math.sin(17*v[0]+9*v[1]-5*v[2])+.16*Math.sin(11*v[2]+4*v[0])+.12*Math.cos(19*v[1]-3*v[2]);
      const value=Math.max(4,Math.min(251,Math.round(q*255)));
      data[i]=data[i+1]=data[i+2]=value;
    }else{
      const az=Math.atan2(y-center[1],px-center[0]);
      const edge=Math.hypot(px-center[0],y-center[1])/base;
      if(Math.cos(az)>.72){
        const spill=Math.round(38+Math.max(0,1-edge)*1500);
        data[i]=data[i+1]=data[i+2]=Math.min(90,spill);
      }
    }
    data[i+3]=255;
  }
  const cfg={...truth,radius:96,outerMargin:100};
  const result=S.lensGeometryKernel.optimize({w:W,h:H,data,scale:1},W,H,cfg);
  assert.ok(Math.abs(result.params.radius-truth.radius)<=.7,`radius ${result.params.radius}`);
  assert.ok(result.params.outerMargin>=result.params.radius);
  assert.ok(result.params.outerMargin-result.params.radius>=.9999);
  assert.ok(Math.abs(result.params.outerMargin-truth.outerMargin)<=.5,`outer margin ${result.params.outerMargin}`);
  assert.ok(result.params.outerMargin<=100);
  assert.ok(result.params.outerMargin-result.params.radius<=10.0001);
  assert.ok(result.params.seamWidth>=20&&result.params.seamWidth<=90);
  assert.ok(result.matches>=8&&result.confidence>=.12);
  const local=S.lensGeometryKernel.optimize({w:W,h:H,data,scale:1},W,H,
    {...cfg,radius:94,outerMargin:97,blend:{seamWidth:.5}},
    {local:true,radiusMin:92.5,radiusMax:95.5,outerMin:95.5,outerMax:98.5,seamMin:49,seamMax:51});
  assert.ok(local.params.radius>=92.5&&local.params.radius<=95.5);
  assert.ok(local.params.outerMargin>=95.5&&local.params.outerMargin<=98.5);
  assert.ok(local.params.seamWidth>=49&&local.params.seamWidth<=51);
});
check('Clean exports redraw diagnostic content even at unchanged size',()=>{
  const source=read('stitcher.js');const fn=source.slice(source.indexOf('  function stitchIfNeeded('),source.indexOf('  function renderWithPostProcessing('));
  const x=env();vm.runInContext(`let renderTexture={width:100,height:50},framebuffer={};
    const gl={isTexture:()=>true,viewport:()=>{}};let _fboValid=true,_stitchDirty=false,_stitchVariant=null,_renderRevision=0;
    let schematicMode=false,showSeam=true,schematicGuideX=-1,isStitched=false,currentImg={width:100,height:50};
    let calls=[];function stitchWebGL(...args){calls.push(args)}function reapplyDrawingBake(){};
    ${fn};stitchIfNeeded(100,50,false);stitchIfNeeded(100,50,true);`,x);
  assert.equal(vm.runInContext('calls.length',x),2);assert.equal(vm.runInContext('calls[1][5]',x),true);
  vm.runInContext('stitchIfNeeded(100,50,true)',x);assert.equal(vm.runInContext('calls.length',x),2);
});
check('Luminance blur updates when the same texture receives new pixels',()=>{
  let draws=0;const gl=new Proxy({FRAMEBUFFER_COMPLETE:36053,createTexture:()=>({}),createFramebuffer:()=>({}),
    checkFramebufferStatus:()=>36053,getParameter:()=>[0,0,100,50],drawArrays:()=>draws++},{get:(o,k)=>k in o?o[k]:()=>{}});
  const x=env();run(x,'webgl-utils.js');run(x,'render-target.js');x.S360.createProgram=()=>({});x.S360.getQuadVAO=()=>({});const tex={contentRevision:1};
  x.S360.ensureLumBlur(gl,tex,100,50,1,1);assert.equal(draws,2);
  x.S360.ensureLumBlur(gl,tex,100,50,1,1);assert.equal(draws,2);
  tex.contentRevision++;x.S360.ensureLumBlur(gl,tex,100,50,1,1);assert.equal(draws,4);
});
check('Independent output targets leave pooled live input allocated',()=>{
  const deleted=[];const gl=new Proxy({createTexture:()=>({}),createFramebuffer:()=>({}),deleteTexture:t=>deleted.push(t)}, {get:(o,k)=>k in o?o[k]:()=>{}});
  const x=env();run(x,'webgl-utils.js');run(x,'render-target.js');x.S360.validateTextureSize=()=>{};x.S360.assertFramebufferComplete=()=>{};
  const input=x.S360.getPooledFBO(gl,8192,4096);const output=x.S360.createRenderTarget(gl,1024,1024,'Little planet');
  assert.ok(!deleted.includes(input.tex));output.dispose();assert.ok(!deleted.includes(input.tex));
});
check('GPU allocations reserve budget and preserve accounting across ownership transfer',()=>{
  let created=0,shed=0;const gl={TEXTURE_2D:3553,MAX_TEXTURE_SIZE:3379,NO_ERROR:0,
    getParameter:()=>4096,createTexture:()=>({id:++created}),bindTexture:()=>{},getError:()=>0,isContextLost:()=>false,deleteTexture:()=>{}};
  const quiet={log(){},warn(){},group(){},table(){},groupEnd(){}};
  const x=env({console:quiet});run(x,'gpu-memory.js');run(x,'webgl-utils.js');run(x,'render-target.js');
  x.S360.gpuMem.init(gl);x.S360.gpuMem.setBudget(100);x.S360.gpuMem.onShed(()=>shed++);
  assert.throws(()=>x.S360.createTrackedTexture(gl,{width:10,height:10,label:'Too large'},()=>{}),/safely available/);
  assert.equal(created,0);assert.equal(shed,1);assert.equal(x.S360.gpuMem.total(),0);
  x.S360.gpuMem.setBudget(1000);
  assert.throws(()=>x.S360.createTrackedTexture(gl,{width:5,height:5,label:'Failed upload'},()=>{throw new Error('upload failed');}),/upload failed/);
  assert.equal(x.S360.gpuMem.total(),0);
  const tex=x.S360.createTrackedTexture(gl,{width:10,height:10,label:'Merge output'},()=>{});
  assert.equal(x.S360.gpuMem.total(),400);
  const image=x.S360.createGpuImage(gl,tex,null,10,10),taken=image.takeTexture();
  x.S360.relabelTrackedTexture(taken,'Source texture');
  assert.equal(x.S360.gpuMem.total(),400);assert.equal(x.S360.gpuMem.log().entries[0].label,'Source texture');
  x.S360.deleteTrackedTexture(gl,taken);image.dispose();assert.equal(x.S360.gpuMem.total(),0);
});
check('Source edits match the forward sphere oracle across zoom, wrap, poles and fisheye',()=>{
  const x=env();run(x,'geometry.js');run(x,'drawing-projection.js');
  const w=200,h=100,W=512,H=256;
  for(const proj of [1,.75,.5,.1,.05])for(const pitch of [-1.55,.3,1.55])for(const mirror of [false,true])for(const mark of [[40,30],[100,50],[185,65]]){
    const camera={proj,pitch,mirror,yaw:2.9,fov:2.2},overlayPixels=new Uint8ClampedArray(w*h*4);
    for(const [px,py]of [mark])for(let yy=py-4;yy<=py+4;yy++)for(let xx=px-4;xx<=px+4;xx++)overlayPixels.set([180,90,60,255],(yy*w+xx)*4);
    const args={...camera,overlayPixels,overlayW:w,overlayH:h,source:{stitched:true,width:W,height:H}};
    const patches=x.S360.drawingProjection.projectPatches(args).patches;
    for(const [px,py]of [mark]){
      const ray=referenceProjection(camera,px+.5,py+.5,w,h);if(!ray)continue;
      const sx=Math.floor((.5+Math.atan2(ray[0],ray[2])/TWO_PI)*W)%W,sy=Math.min(H-1,Math.floor((.5-Math.asin(ray[1])/PI)*H));
      const tile=patches.find(t=>sx>=t.x&&sx<t.x+t.width&&sy>=t.y&&sy<t.y+t.height);
      assert.ok(tile,'projected location exists '+JSON.stringify(camera));
      const i=((sy-tile.y)*tile.width+sx-tile.x)*4;assert.ok(tile.data[i+3]>100);assert.equal(tile.data[i],180);
    }
  }
});
check('Lens inverse preserves width, height, angle and roll for source edits',()=>{
  const x=env();run(x,'geometry.js');const S=x.S360;
  for(const side of [false,true])for(const angle of [-.08,0,.08])for(const scale of [.95,1,1.05]){
    const basis=S.lensBasis(side,{rollDeg:{left:23,right:-17}}),theta=1.2,az=.9;
    const ray=basis.axis.map((v,i)=>v*Math.cos(theta)+(basis.up[i]*Math.cos(az)+basis.right[i]*Math.sin(az))*Math.sin(theta));
    const p=S.sourcePoint(ray,basis,[100,100],100,1.8,55,.97,angle,scale);
    const inverse=S.sourceDirection(p.x,p.y,basis,[100,100],100,1.8,55,.97,angle,scale);
    assert.ok(inverse.every((v,i)=>Math.abs(v-ray[i])<1e-12));
  }
});
check('Global horizon pitch and roll rotate both lens bases as one rigid sphere',()=>{
  const x=env();run(x,'geometry.js');const S=x.S360,cfg={rollDeg:{left:13,right:-9},horizon:{pitch:17,roll:-11}};
  for(const side of [false,true]){
    const local=S.lensBasis(side,{rollDeg:cfg.rollDeg});
    const leveled=S.lensBasis(side,cfg);
    for(const key of ['axis','up','right']){
      const expected=S.rotateAroundAxis(S.rotateAroundAxis(local[key],[0,1,0],17*PI/180),[1,0,0],-11*PI/180);
      for(let i=0;i<3;i++)assert.ok(Math.abs(leveled[key][i]-expected[i])<1e-12);
    }
  }
});
check('Horizon analysis recovers a synthetic full-width great circle',()=>{
  const x=env();run(x,'geometry.js');run(x,'horizon-leveling.js');const W=360,H=180,data=new Uint8ClampedArray(W*H*4);
  const n=x.S360.horizonLeveling.requiredNormal(12,-8);
  for(let yy=0;yy<H;yy++)for(let xx=0;xx<W;xx++){
    const lon=(xx/W*2-1)*PI,c=n[0]*Math.cos(lon)+n[1]*Math.sin(lon);
    const hy=(.5-Math.atan2(-c,n[2])/PI)*H,v=yy>=hy?220:25,i=(yy*W+xx)*4;
    data[i]=data[i+1]=data[i+2]=v;data[i+3]=255;
  }
  const canvas={width:W,height:H,getContext:()=>({getImageData:()=>({data})})};
  const result=x.S360.horizonLeveling.analyze(canvas,{pitch:0,roll:0});
  assert.equal(result.success,true);assert.ok(Math.abs(result.pitch-12)<1);assert.ok(Math.abs(result.roll+8)<1);
});
check('Worker and fallback produce identical source-edit patches for both source modes',()=>{
  const x=env();run(x,'geometry.js');run(x,'drawing-projection.js');let response;
  x.self={postMessage:r=>response=r};x.importScripts=()=>{};run(x,'bake-worker.js');
  const cfg={radius:95,outerMargin:100,centers:{left:[.25,.5],right:[.75,.5]},width:{left:2,right:-1},height:{left:-2,right:3},angle:{left:1,right:2},rollDeg:{left:0,right:5}};
  for(const stitched of [false,true]){
    const args={type:'bake',overlayPixels:new Uint8ClampedArray(16*8*4).fill(180),overlayW:16,overlayH:8,
      source:{width:64,height:32,stitched,cfg,gain:[.8,1,1.2]},yaw:.7,pitch:.3,fov:2.2,proj:.05,mirror:true};
    x.self.onmessage({data:args});assert.equal(response.type,'result');
    assert.equal(JSON.stringify(response.patches),JSON.stringify(x.S360.drawingProjection.projectPatches(args).patches));
  }
});
check('Source edit patches preserve native dimensions without a full-image patch allocation',()=>{
  let projected=0;const math=Object.create(Math);math.acos=v=>{projected++;return Math.acos(v);};
  const x=env({Math:math});run(x,'geometry.js');run(x,'drawing-projection.js');
  const overlayPixels=new Uint8ClampedArray(100*50*4);overlayPixels.set([255,255,255,255],(25*100+50)*4);
  const result=x.S360.drawingProjection.projectPatches({overlayPixels,overlayW:100,overlayH:50,source:{width:8192,height:4096,stitched:true},yaw:0,pitch:0,fov:1,proj:1,mirror:false});
  assert.ok(result.patches.length>0);assert.ok(result.patches.reduce((s,t)=>s+t.data.byteLength,0)<1024*1024);
  assert.ok(projected<8192*4096/100,'a small 8K stroke projects less than 1% of source pixels');
});
check('Warp preview advances each pointer segment once',()=>{
  const x=env();run(x,'warp-projection.js');let steps=0;
  x.S360.warpGpu={begin:()=>({}),step:()=>steps++,current:()=>({tex:{}}),dispose:()=>{}};
  x.S360.sourceEdit={snapshot:()=>({})};run(x,'view-warp.js');
  const image={width:40,height:20},ctx={gl:{isContextLost:()=>false},getCurrentImg:()=>image};
  x.S360.viewWarp.init({ctx,getSource:()=>({image}),getCamera:()=>({yaw:0,pitch:0,fov:1,proj:1}),getCurrentImg:()=>image});
  assert.equal(x.S360.viewWarp.begin({view:{w:20,h:20},radius:10,strength:1,lens:'left'}),true);
  x.S360.viewWarp.move({x:5,y:10});x.S360.viewWarp.move({x:6,y:10});x.S360.viewWarp.move({x:7,y:10});
  assert.equal(steps,2);x.S360.viewWarp.cancel();
});
check('Sparse warp evaluation matches the dense deformation oracle',()=>{
  const x=env();run(x,'warp-projection.js');const S=x.S360.warpProjection,w=31,h=19;
  const steps=S.decompose([{x:4,y:6},{x:15,y:9},{x:22,y:14}],{radius:8,strength:.7});
  let map=S.makeMap(w,h);for(const step of steps)map=S.applyStep(map,w,h,step);
  for(const [px,py]of [[2,3],[8.2,7.7],[15,10],[24.4,15.1]]){
    const dense=S.sample(map,w,h,px,py),sparse=S.sampleSteps(steps,px,py);
    assert.ok(Math.abs(dense[0]-sparse[0])<.6&&Math.abs(dense[1]-sparse[1])<.6);
  }
});
check('Warp bake removes redundant pointer density while preserving curved paths',()=>{
  const x=env();run(x,'warp-projection.js');const S=x.S360.warpProjection;
  const straight=Array.from({length:201},(_,i)=>({x:i*.5,y:20}));
  assert.equal(S.simplifyPoints(straight,.75).length,2);
  const curve=[{x:0,y:0},{x:10,y:0},{x:20,y:8},{x:30,y:8}];
  const simplified=S.simplifyPoints(curve,.75);
  assert.ok(simplified.length>2&&simplified.some(p=>p.x===20&&p.y===8));
});
check('Warp bake changes only the selected raw fisheye lens',()=>{
  const x=env();run(x,'geometry.js');run(x,'warp-projection.js');run(x,'drawing-projection.js');
  const W=40,H=20,w=20,h=20,cfg={radius:95,outerMargin:100,centers:{left:[.25,.5],right:[.75,.5]},
    width:{left:0,right:0},height:{left:0,right:0},angle:{left:0,right:0},rollDeg:{left:0,right:0}};
  const sourcePixels=new Uint8ClampedArray(W*H*4);
  for(let y=0;y<H;y++)for(let col=0;col<W;col++)sourcePixels.set([col*6,y*10,30,255],(y*W+col)*4);
  let map=x.S360.warpProjection.makeMap(w,h);
  map=x.S360.warpProjection.applyStroke(map,w,h,[{x:9,y:10},{x:12,y:10}],{radius:5,strength:1});
  const common={map,mapW:w,mapH:h,source:{width:W,height:H,stitched:false,cfg},sourcePixels,yaw:0,pitch:0,fov:1,proj:1,mirror:false};
  const left=[...x.S360.drawingProjection.warpTiles({...common,lens:'left'})].filter(Boolean);
  const right=[...x.S360.drawingProjection.warpTiles({...common,lens:'right'})].filter(Boolean);
  assert.ok(left.length>0);assert.ok(left.every(p=>p.x<20));assert.equal(right.length,0);
});
check('Whole-seam warp anchors the selected lens centre',()=>{
  const x=env();run(x,'geometry.js');run(x,'warp-projection.js');run(x,'drawing-projection.js');
  const W=40,H=20,w=40,h=20,cfg={radius:95,outerMargin:100,centers:{left:[.25,.5],right:[.75,.5]},
    width:{left:0,right:0},height:{left:0,right:0},angle:{left:0,right:0},rollDeg:{left:0,right:0}};
  const sourcePixels=new Uint8ClampedArray(W*H*4);for(let i=3;i<sourcePixels.length;i+=4)sourcePixels[i]=255;
  const map=x.S360.warpProjection.makeMap(w,h);for(let i=0;i<map.length;i+=2)map[i]+=2;
  const patches=[...x.S360.drawingProjection.warpTiles({map,mapW:w,mapH:h,mapProjection:'equirect',taperToLensCenter:true,
    source:{width:W,height:H,stitched:false,cfg},sourcePixels,lens:'left',yaw:0,pitch:0,fov:1,proj:1,mirror:false})].filter(Boolean);
  const alphaAt=(px,py)=>{const p=patches.find(q=>px>=q.x&&px<q.x+q.width&&py>=q.y&&py<q.y+q.height);return p?p.data[((py-p.y)*p.width+px-p.x)*4+3]:0;};
  assert.equal(alphaAt(10,10),0,'optical centre remains anchored');
  assert.equal(alphaAt(17,10),255,'outer lens receives the seam correction');
});
check('Automatic warp builds a smooth inverse map from local lens motion',async()=>{
  const x=env();run(x,'frame-registration.js');run(x,'auto-warp.js');
  const W=512,H=256;
  const layer=shift=>{const data=new Uint8ClampedArray(W*H*4);for(let y=0;y<H;y++)for(let px=0;px<W;px++){
    const sx=px-shift,v=128+45*Math.sin(sx*.13)+35*Math.cos(y*.17)+30*Math.sin((sx+y)*.071),i=(y*W+px)*4;
    data[i]=v;data[i+1]=128+40*Math.cos((sx-y)*.093);data[i+2]=255-v;data[i+3]=255;
  }return {width:W,height:H,data};};
  const result=await x.S360.autoWarp.buildMap({selected:layer(4),other:layer(0),fullPanorama:true});
  assert.ok(result.moved&&result.matches>=4,`matches ${result.matches}`);
  const cx=result.width>>1,cy=result.height>>1,i=(cy*result.width+cx)*2;
  assert.ok(Math.hypot(result.map[i]-cx,result.map[i+1]-cy)>.25,'map carries a local correction');
  const dx0=result.map[i]-cx,dx1=result.map[i+2]-(cx+1);
  assert.ok(Math.abs(dx1-dx0)<.2,'neighboring displacement is smooth');
  const focused=await x.S360.autoWarp.buildMap({selected:layer(4),other:layer(0),camera:{yaw:0,pitch:0,fov:1.4,proj:1,mirror:false},
    viewW:320,viewH:180,focus:{x:160,y:90,radiusX:64,radiusY:32}});
  assert.ok(focused.moved&&focused.overlap,'marker finds the local overlap');
  assert.equal(focused.map[0],0);assert.equal(focused.map[1],0);
  const marked=(90*focused.width+160)*2;
  assert.ok(Math.abs(focused.map[marked]-160)>.1,'marker retains correction inside its brush');
  const outsideY=((90+34)*focused.width+160)*2,outsideX=(90*focused.width+226)*2;
  assert.ok(Math.abs(focused.map[outsideY]-160)<.01&&Math.abs(focused.map[outsideX]-226)<.01,'marker correction stays inside its ellipse');
});
check('Automatic morph keeps opposite seam-half corrections independent',async()=>{
  const x=env();run(x,'frame-registration.js');run(x,'auto-warp.js');const W=512,H=256;
  const base=new Uint8ClampedArray(W*H*4);let seed=98765;
  for(let i=0;i<base.length;i+=4){seed=(1664525*seed+1013904223)>>>0;const v=seed>>>24;base[i]=v;base[i+1]=(v*3)&255;base[i+2]=255-v;base[i+3]=255;}
  const layer=split=>{if(!split)return {width:W,height:H,data:new Uint8ClampedArray(base)};const data=new Uint8ClampedArray(W*H*4);
    for(let y=0;y<H;y++)for(let px=0;px<W;px++){
      const shift=px<W/2?4:-4,lo=px<W/2?0:W/2,hi=px<W/2?W/2-1:W-1,sx=Math.max(lo,Math.min(hi,px-shift));
      data.set(base.subarray((y*W+sx)*4,(y*W+sx)*4+4),(y*W+px)*4);
    }return {width:W,height:H,data};};
  const result=await x.S360.autoWarp.buildMap({selected:layer(true),other:layer(false),fullPanorama:true});
  assert.ok(result.moved,`half shifts ${result.dominants[0].dx},${result.dominants[1].dx}`);
  const y=result.height>>1,a=(y*result.width+(result.width>>2))*2,b=(y*result.width+3*(result.width>>2))*2;
  const da=result.map[a]-(result.width>>2),db=result.map[b]-3*(result.width>>2);
  assert.ok(da>.2&&db<-.2,`seam halves retain opposite corrections ${da},${db}`);
});
check('Automatic morph refuses a destructive distant lens shift',async()=>{
  const x=env();run(x,'frame-registration.js');run(x,'auto-warp.js');const W=256,H=128,shift=36;
  const base=new Uint8ClampedArray(W*H*4);let seed=24681357;
  for(let i=0;i<base.length;i+=4){seed=(1664525*seed+1013904223)>>>0;const v=seed>>>24;base[i]=v;base[i+1]=255-v;base[i+2]=(v*5)&255;base[i+3]=255;}
  const other={width:W,height:H,data:base},data=new Uint8ClampedArray(W*H*4);
  for(let y=0;y<H;y++)for(let px=shift;px<W;px++)data.set(base.subarray((y*W+px-shift)*4,(y*W+px-shift)*4+4),(y*W+px)*4);
  const result=await x.S360.autoWarp.buildMap({selected:{width:W,height:H,data},other,fullPanorama:true});
  assert.equal(result.moved,false,`distant shift must not deform the lens (${result.matches} matches)`);
});
check('Automatic warp recovers motion normal to a thin line',()=>{
  const x=env();run(x,'frame-registration.js');run(x,'auto-warp.js');
  const w=64,h=64,ref=new Float32Array(w*h),cur=new Float32Array(w*h);
  for(let y=0;y<h;y++)for(let px=0;px<w;px++){
    ref[y*w+px]=Math.exp(-.5*((px-30)/1.4)**2)*(.7+.3*Math.sin(y*.37));
    cur[y*w+px]=Math.exp(-.5*((px-33)/1.4)**2)*(.7+.3*Math.sin(y*.37));
  }
  const fit=x.S360.autoWarp.matchDetailPatch(ref,cur,w,h,32,32,32,6);
  assert.ok(fit&&Math.abs(fit.dx-3)<=.5&&Math.abs(fit.dy)<=.5,`detail ${fit?.dx},${fit?.dy}`);
});
check('Automatic warp scans a third-width range and prefers a strong vertical match',async()=>{
  const x=env();run(x,'frame-registration.js');run(x,'auto-warp.js');
  const w=180,h=120,shiftY=34,grayOther=new Float32Array(w*h),graySelected=new Float32Array(w*h);
  const alphaOther=new Float32Array(w*h).fill(1),alphaSelected=new Float32Array(w*h);
  let seed=1234567;for(let i=0;i<grayOther.length;i++){seed=(1664525*seed+1013904223)>>>0;grayOther[i]=seed/4294967296;}
  for(let pass=0;pass<5;pass++){
    const src=new Float32Array(grayOther);
    for(let y=1;y<h-1;y++)for(let px=1;px<w-1;px++)grayOther[y*w+px]=
      (src[y*w+px]*4+src[y*w+px-1]+src[y*w+px+1]+src[(y-1)*w+px]+src[(y+1)*w+px])/8;
  }
  for(let y=shiftY;y<h;y++)for(let px=0;px<w;px++){
    graySelected[y*w+px]=grayOther[(y-shiftY)*w+px];alphaSelected[y*w+px]=1;
  }
  const found=await x.S360.autoWarp.estimateDominantShift(
    {width:w,height:h,grayOther,graySelected,alphaOther,alphaSelected});
  assert.equal(found.reach,60);
  assert.ok(Math.abs(found.dx)<=1&&Math.abs(found.dy-shiftY)<=1,`dominant ${found.dx},${found.dy}`);
});
check('Source publication failure rolls back pixels and preserves the last Undo',()=>{
  class ImageData {constructor(data,width,height){this.data=data;this.width=width;this.height=height;}}
  function canvas(){
    const c={width:4,height:2,pixels:null};const data=()=>c.pixels||(c.pixels=new Uint8ClampedArray(c.width*c.height*4));
    const paint={drawImage(image){c.pixels=new Uint8ClampedArray(image.pixels);},
      getImageData(x,y,w,h){const out=new Uint8ClampedArray(w*h*4);for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++)out.set(data().subarray(((y+yy)*c.width+x+xx)*4,((y+yy)*c.width+x+xx)*4+4),(yy*w+xx)*4);return new ImageData(out,w,h);},
      putImageData(p,x,y){for(let yy=0;yy<p.height;yy++)for(let xx=0;xx<p.width;xx++)data().set(p.data.subarray((yy*p.width+xx)*4,(yy*p.width+xx)*4+4),((y+yy)*c.width+x+xx)*4);}};
    c.getContext=()=>paint;return c;
  }
  let current=canvas(),fail=false;current.pixels=new Uint8ClampedArray(32).fill(80);
  for(let i=3;i<32;i+=4)current.pixels[i]=255;
  const original=new Uint8ClampedArray(current.pixels);
  const x=env({ImageData,document:{createElement:canvas}});run(x,'source-edit.js');
  x.S360.releaseImage=()=>{};x.S360.loaders={replaceEditedSource(c){if(fail)throw Error('GPU preparation failed');current=c;}};
  x.S360.sourceEdit.init({ctx:{gl:{isContextLost:()=>false},getCurrentImg:()=>current,renderPano(){}},getSource:()=>({image:current})});
  const patch={x:1,y:0,width:1,height:1,data:new Uint8ClampedArray([200,100,50,255])};
  x.S360.sourceEdit.commit({image:current},[patch]);const first=new Uint8ClampedArray(current.pixels);
  fail=true;assert.throws(()=>x.S360.sourceEdit.commit({image:current},[{...patch,data:new Uint8ClampedArray([0,0,0,255])}]),/GPU preparation/);
  assert.deepEqual(current.pixels,first);assert.ok(x.S360.sourceEdit.canUndo);
  fail=false;x.S360.sourceEdit.undo();assert.deepEqual(current.pixels,original);assert.equal(x.S360.sourceEdit.canUndo,false);
  const stale=current;current=canvas();current.pixels=new Uint8ClampedArray(32);
  assert.equal(x.S360.sourceEdit.commit({image:stale},[patch]),false);
});
check('Failed and superseded loads cannot replace the active source',async()=>{
  const events={},previous={width:100,height:50};let current=previous,stitched=true,name='old',resolveOld,uploadedStitched=null;
  const x=env({DOMException,document:{getElementById:id=>({addEventListener:(e,fn)=>events[id+':'+e]=fn})},alert:()=>{},console:{error:()=>{},warn:()=>{}}});
  x.S360.uiChrome={showToast:()=>{}};
  x.S360.releaseImage=()=>{};x.S360.scaleSource=(_g,img)=>img;
  x.S360.loadImageFromFile=()=>Promise.reject(new Error('decode failed'));
  run(x,'loaders.js');
  x.S360.settings={updateUIFromConfig:()=>{},scheduleLiveSave:()=>{}};x.S360.schematic={releaseSchematicBg:()=>{},drawLensSchematic:()=>{}};
  const ctx={gl:{isContextLost:()=>false},setStitched:v=>stitched=v,setLastBaseName:v=>name=v,getScaleValue:()=>1,MAX_TEX_SIZE:4096,renderPano:()=>{}};
  x.S360.loaders.init({ctx,uploadTexture:(img,_a,_b,_c,mode)=>{current=img;uploadedStitched=mode;},updateStitchedUI:()=>{},setActionsVisible:()=>{},setLoading:()=>{}});
  const load=files=>events['openStitchedLoader:change']({target:{files}});
  await load([{name:'bad.jpg'}]);assert.equal(current,previous);assert.equal(stitched,true);assert.equal(name,'old');
  x.S360.loadImageFromFile=file=>file.name==='slow.jpg'?new Promise(r=>resolveOld=r):Promise.resolve({width:20,height:10});
  const slow=load([{name:'slow.jpg'}]);await load([{name:'new.jpg'}]);const newest=current;
  assert.equal(uploadedStitched,true);
  resolveOld({width:30,height:15});await slow;assert.equal(current,newest);assert.equal(name,'new');
});
check('Source preparation releases candidate allocations on failure',()=>{
  const deleted=[];const gl=new Proxy({createTexture:()=>({}),deleteTexture:t=>deleted.push(t)}, {get:(o,k)=>k in o?o[k]:()=>{}});
  const x=env();run(x,'webgl-utils.js');run(x,'render-target.js');run(x,'source-texture.js');x.S360.validateTextureSize=()=>{};x.S360.estimateGainRFromSource=()=>({gain:[1,1,1]});
  x.S360.createRenderTarget=()=>{throw new Error('allocation failed')};
  assert.throws(()=>x.S360.prepareSourceTexture(gl,{width:10,height:5},{}),/allocation failed/);assert.equal(deleted.length,1);
});
check('Lens height scales its own axis and equal width/height gives uniform zoom',()=>{
  const x=env();run(x,'geometry.js');const S=x.S360;
  const basis=S.lensBasis(false,{rollDeg:{left:0,right:0}}),center=[100,100];
  const theta=.7,az=.6;
  const v=basis.axis.map((a,i)=>a*Math.cos(theta)+(basis.up[i]*Math.cos(az)+basis.right[i]*Math.sin(az))*Math.sin(theta));
  const p=(w,h,angle=0)=>S.sourcePoint(v,basis,center,100,2,60,w,angle,h);
  const base=p(1,1),height=p(1,.95);
  assert.equal(height.x,base.x);assert.ok(Math.abs(height.y-100-(base.y-100)*.95)<1e-10);
  for(const angle of [0,.08,-.08]){const a=p(1,1,angle),b=p(.95,.95,angle);
    assert.ok(Math.abs(b.x-100-(a.x-100)*.95)<1e-10);assert.ok(Math.abs(b.y-100-(a.y-100)*.95)<1e-10);}
});
check('Height survives calibration profiles and old profiles reset it to neutral',()=>{
  const x=env();run(x,'settings.js');const S=x.S360.settings;
  const cfg={radius:95,outerMargin:100,centers:{left:[.25,.5],right:[.75,.5]},rollDeg:{left:0,right:0},
    width:{left:0,right:0},height:{left:2,right:-3},angle:{left:0,right:0}};
  const profile=S.createCalibrationProfile(cfg);cfg.height={left:0,right:0};S.applyCalibrationProfile(cfg,profile);
  assert.equal(cfg.height.left,2);assert.equal(cfg.height.right,-3);
  profile.geometry.height={left:100,right:-100};S.applyCalibrationProfile(cfg,profile);
  assert.equal(cfg.height.left,5);assert.equal(cfg.height.right,-5);
  delete profile.geometry.height;S.applyCalibrationProfile(cfg,profile);
  assert.equal(cfg.height.left,0);assert.equal(cfg.height.right,0);
});
check('Signed seam shift favours either lens continuously at every width',()=>{
  const x=env();run(x,'geometry.js');
  for(const width of [0,.1,.5,1])for(const base of [.1,.5,.9]){
    const band=shift=>x.S360.seamBand({blend:{seamWidth:width,seamShift:shift}},base);
    assert.ok(band(-1).lo>=1-1e-12);assert.ok(band(1).hi<=1e-12);
    assert.ok(band(-.5).center>band(0).center);assert.ok(band(.5).center<band(0).center);
    assert.ok(Math.abs(band(-1e-7).center-band(1e-7).center)<1e-6);
  }
});
check('Content-aware seam can choose either half of the overlap',()=>{
  const x=env();run(x,'geometry.js');run(x,'seam-analysis.js');
  const cfg={radius:90,outerMargin:100,centers:{left:[.25,.5],right:[.75,.5]},
    width:{left:0,right:0},angle:{left:0,right:0},rollDeg:{left:0,right:0}};
  const lens=x.S360.lensParams(cfg,100), delta=lens.halfFov-Math.PI/2;
  for(const side of [-1,1]){
    const target=Math.PI/2+side*delta*.55;
    x.S360.sampleBilinear=(_proxy,px,py)=>{
      const value=px<200?Math.min(1,Math.abs(Math.hypot(px-100,py-100)/lens.f-target)*8):0;
      return [value,value,value];
    };
    const result=x.S360.seamAnalysis.analyzeSeam({w:400,h:200,scale:1},400,200,cfg);
    assert.ok(result);const mean=result.curve.reduce((a,b)=>a+b,0)/result.curve.length/255;
    assert.ok(side<0?mean<.4:mean>.6,'seam follows matching content on side '+side+': '+mean);
  }
});
check('UI-handler paths render settings changes and repaint 3D after failed focus analysis', async () => {
  const elements = {};
  const el = (id) => {
    if (!elements[id]) {
      elements[id] = {
        addEventListener: (type, fn) => { elements[id].handlers[type] = fn; },
        handlers: {},
        classList: { toggle: () => {}, add: () => {}, remove: () => {} },
        style: {},
        disabled: false,
        value: '',
        textContent: '',
        checked: false,
        setAttribute: () => {}
      };
    }
    return elements[id];
  };
  let dirty = 0, renderPanoCalls = 0, seamScheduleCalls = 0;
  let viewMode = '2d', sphere = null, sphereRenders = 0;

  const mockFile = {
    text: async () => JSON.stringify({
      schema: 'stitchit-camera-profile', version: 1, name: 'Test',
      geometry: {
        outerMargin: 90, radius: 95,
        centers: { left: [0.25, 0.5], right: [0.75, 0.5] },
        rollDeg: { left: 0, right: 0 },
        width: { left: 0, right: 0 },
        height: { left: 0, right: 0 },
        angle: { left: 0, right: 0 }
      }
    })
  };

  const localStorage = {
    data: {},
    getItem: (k) => localStorage.data[k] || null,
    setItem: (k, v) => { localStorage.data[k] = v; },
    removeItem: (k) => { delete localStorage.data[k]; }
  };

  localStorage.data['snapshot'] = JSON.stringify({
    cfg: {
      outerMargin: 90, radius: 95, mirror3D: false,
      blend: { seamWidth: 0.5, seamShift: 0 },
      centers: { left: [0.25, 0.5], right: [0.75, 0.5] },
      rollDeg: { left: 0, right: 0 },
      width: { left: 0, right: 0 },
      height: { left: 0, right: 0 },
      angle: { left: 0, right: 0 }
    },
    post: {}
  });

  const x = env({
    localStorage,
    Blob: class { constructor() {} },
    setTimeout: () => 1,
    clearTimeout: () => {},
    document: {
      getElementById: (id) => {
        if (id === 'profileLoader') {
          const e = el(id);
          e.files = [mockFile];
          return e;
        }
        return el(id);
      }
    },
    alert: () => {}
  });

  run(x, 'settings.js');
  run(x, 'stitch-ui.js');

  x.S360.downloads = { triggerDownload: () => {} };
  x.S360.stitchDecal = {
    decals: {
      bottom: { size: 0.1, rotDeg: 0, active: false },
      top: { size: 0.1, rotDeg: 0, active: false }
    },
    wireDecalControls: () => {}
  };
  x.S360.viewer = { getSphere: () => sphere, setProj: () => {}, setPitch: () => false };
  x.S360.renderSphere = () => sphereRenders++;
  x.S360.focusRecovery = { autoFocus: async () => { throw new Error('low contrast'); } };
  x.S360.uiChrome = { setLoading: () => {}, showToast: () => {} };
  x.S360.setViewMode = () => {};
  x.S360.stitchSeam = { scheduleContentAwareSeam: () => seamScheduleCalls++ };
  x.S360.settings.updatePostUI = () => {};
  x.S360.settings.updateWmUI = () => {};
  x.S360.settings.saveLiveConfig = () => {};
  x.S360.settings.scheduleLiveSave = () => {};

  const ctx = {
    getViewMode: () => viewMode,
    getCurrentImg: () => ({ width: 100, height: 50 }),
    markStitchDirty: () => dirty++,
    renderPano: () => renderPanoCalls++,
    getPostEnabled: () => false,
    setPostEnabled: () => {},
    getScaleValue: () => 1,
    setScaleValue: () => {},
    cfg: {
      mirror3D: false,
      centers: { left: [0.25, 0.5], right: [0.75, 0.5] },
      rollDeg: { left: 0, right: 0 },
      width: { left: 0, right: 0 },
      height: { left: 0, right: 0 },
      angle: { left: 0, right: 0 },
      blend: { seamWidth: 0.5, seamShift: 0 }
    },
    getLastBaseName: () => 'test',
    gl: { isContextLost: () => false },
    getSchematicMode: () => false,
    sliderMap: [],
    postUniforms: {},
    LIVE_KEY: 'live',
    SNAPSHOT_KEY: 'snapshot',
    EXPOSURE_FUSION_SNAPSHOT_KEY: 'ef',
    PROC_SNAPSHOT_KEY: 'proc',
    WM_SNAPSHOT_KEY: 'wm',
    DEFAULT_POST: {}
  };

  x.S360.stitchUI.init({
    ctx,
    scheduleRender: () => {},
    showSeam: () => false,
    setShowSeam: () => {},
    uploadTexture: () => {},
    renderOffscreenPixels: () => ({}),
    estimateCurrentGain: () => ({ gain: [1, 1, 1] }),
    currentGainR: () => {},
    drawLensSchematic: () => {},
    yieldToUI: async () => {}
  });

  elements['exportProfileBtn'].handlers.click();

  const changeHandler = elements['profileLoader'].handlers.change;
  assert.ok(changeHandler, 'profileLoader change handler is registered');
  await changeHandler({ target: { files: [mockFile] } });
  assert.equal(dirty, 1, 'profile import marks dirty');
  assert.equal(renderPanoCalls, 1, 'profile import renders pano');
  assert.equal(seamScheduleCalls, 1, 'profile import schedules seam');

  elements['loadGeoBtn'].handlers.click();
  assert.ok(dirty >= 2, 'load geo marks dirty');
  assert.ok(renderPanoCalls >= 2, 'load geo renders pano');
  viewMode='3d';sphere={};
  await elements['autoFocusBtn'].handlers.click();
  assert.equal(sphereRenders,1,'failed focus analysis immediately repaints the 3D framebuffer');
});
(async()=>{
  let count=0;for(const file of fs.readdirSync(__dirname).filter(f=>/\.(c?js)$/.test(f))){new vm.Script(read(file),{filename:file});count++;}
  console.log(`Syntax: ${count} JavaScript files passed`);
  for(const [name,fn] of checks){await fn();console.log('PASS '+name);}
  console.log(`${checks.length} regression checks passed`);
})().catch(error=>{console.error(error);process.exitCode=1});
