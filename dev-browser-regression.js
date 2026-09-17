// Included only by the regression smoke page, never by index.html.
// Worker is stubbed before modules load to exercise the main-thread kernels,
// including yielding source edits. ?workers exercises native workers instead;
// kernel identity is also checked by dev-regression.cjs.
if (!new URLSearchParams(location.search).has('workers')) window.Worker = undefined;
else {
  const NativeWorker=window.Worker;window.__bakeWorkers=0;
  window.Worker=class extends NativeWorker { constructor(url,...args){super(url,...args);if(String(url).includes('bake-worker'))window.__bakeWorkers++;} };
}
window.__errs=[];
window.addEventListener('error',event=>window.__errs.push((event.error?.message||event.message)+' @ '+event.filename+':'+event.lineno));
window.addEventListener('unhandledrejection',event=>window.__errs.push(event.reason?.message||String(event.reason)));
document.addEventListener('DOMContentLoaded', () => {
  // Every run starts from defaults and leaves the user's saved settings intact.
  S360.settings.loadLiveConfig = () => {};
  S360.settings.saveLiveConfig = () => {};
  S360.settings.scheduleLiveSave = () => {};
  const original = S360.stitchUI.init;
  let ctx;
  S360.stitchUI.init = deps => { ctx = deps.ctx; return original(deps); };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(test, label, timeout = 20000) {
    const start = performance.now();
    while (!test()) { if (performance.now() - start > timeout) throw new Error('Timeout: ' + label); await pause(50); }
  }
  const results = [];
  function assert(condition, label) { if (!condition) throw new Error(label); results.push(label); }
  function pixels(gl, fbo, w, h) {
    const out = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,out);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);return out;
  }
  const equal = (a,b) => a.length === b.length && a.every((v,i)=>v===b[i]);
  (async () => {
    await until(() => ctx, 'app initialization');
    const gl=ctx.gl;
    assert(gl.getContextAttributes().preserveDrawingBuffer===false,'display framebuffer does not retain an unnecessary GPU copy');
    // HD scaling must fit within the largest two simultaneous pass textures;
    // it must not require source + horizontal + vertical all at once.
    {
      const c=document.createElement('canvas');c.width=64;c.height=32;c.getContext('2d').fillRect(0,0,64,32);
      const total=S360.gpuMem.total(),budget=S360.gpuMem.budget();let scaled;
      S360.gpuMem.setBudget(total+52*1024);
      try {
        scaled=S360.scaleSource(gl,c,2,ctx.MAX_TEX_SIZE);
        assert(scaled.width===128&&scaled.height===64,'Lanczos HD releases its input before allocating the final pass');
        assert(S360.gpuMem.total()===total,'Lanczos HD releases all temporary GPU textures');
      } finally { S360.gpuMem.setBudget(budget);S360.releaseImage(scaled); }
    }
    // Compare incremental GPU uploads and their blur halos against a fresh source.
    {
      const c=document.createElement('canvas');c.width=257;c.height=129;
      const p=c.getContext('2d'),data=p.createImageData(c.width,c.height);
      for(let i=0;i<data.data.length;i+=4)data.data.set([i%251,(i*3)%253,(i*7)%255,255],i);
      p.putImageData(data,0,0);
      const resource=S360.prepareSourceTexture(gl,c,ctx.cfg,{gain:[1,1,1]});
      function readTexture(tex,w,h){
        const target=S360.createRenderTarget(gl,w,h,'Edit regression readback');
        try{
          const prog=S360.progs.getCopyProgram();gl.useProgram(prog);gl.bindVertexArray(S360.getQuadVAO(gl));
          gl.bindFramebuffer(gl.FRAMEBUFFER,target.fbo);gl.viewport(0,0,w,h);gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D,tex);gl.uniform1i(prog._u.u_tex,0);
          gl.uniform1f(prog._u.u_grainStrength,0);gl.uniform1f(prog._u.u_chromaCleanup,0);
          gl.drawArrays(gl.TRIANGLES,0,6);
          return pixels(gl,target.fbo,w,h);
        }finally{target.dispose();}
      }
      const oldSource=readTexture(resource.texture,257,129),oldBlur=readTexture(resource.lfTex,128,64),edits=[];
      for(const [x,y]of [[0,0],[60,32],[68,36],[249,121]]){
        const previous=p.getImageData(x,y,8,8),next=new ImageData(new Uint8ClampedArray(8*8*4).fill(220),8,8);
        edits.push({x,y,pixels:next,previous});p.putImageData(next,x,y);
      }
      let full;
      try{
        resource.updateEdits(edits);full=S360.prepareSourceTexture(gl,c,ctx.cfg,{gain:[1,1,1]});
        assert(equal(readTexture(resource.texture,257,129),readTexture(full.texture,257,129)),'incremental upload matches full source pixels');
        assert(equal(readTexture(resource.lfTex,128,64),readTexture(full.lfTex,128,64)),'incremental blur matches full blur at edges and overlapping patches');
        resource.updateEdits(edits.map(e=>({...e,pixels:e.previous,previous:e.pixels})));
        assert(equal(readTexture(resource.texture,257,129),oldSource),'incremental Undo restores GPU source');
        assert(equal(readTexture(resource.lfTex,128,64),oldBlur),'incremental Undo restores GPU blur');
        const getError=gl.getError.bind(gl);let injected=false,rejected=false;
        gl.getError=()=>{if(!injected){injected=true;return gl.INVALID_OPERATION;}return getError();};
        try{resource.updateEdits(edits);}catch(error){rejected=true;}finally{gl.getError=getError;}
        assert(rejected,'GPU edit failure is reported');
        assert(equal(readTexture(resource.texture,257,129),oldSource),'failed GPU update rolls back source pixels');
        assert(equal(readTexture(resource.lfTex,128,64),oldBlur),'failed GPU update rolls back blur pixels');
      }finally{resource.dispose();full?.dispose();}
    }
    // Stitched sources use the copy shader and must not retain the dual-fisheye
    // low-frequency layer. Their sparse edits still update the source texture.
    {
      const c=document.createElement('canvas');c.width=64;c.height=32;
      const p=c.getContext('2d');p.fillStyle='#456789';p.fillRect(0,0,c.width,c.height);
      const before=S360.gpuMem.total();
      const resource=S360.prepareSourceTexture(gl,c,ctx.cfg,undefined,{lowFrequency:false});
      try {
        const readSource=()=>{
          const target=S360.createRenderTarget(gl,c.width,c.height,'Stitched source edit readback');
          try {
            const prog=S360.progs.getCopyProgram();gl.useProgram(prog);gl.bindVertexArray(S360.getQuadVAO(gl));
            gl.bindFramebuffer(gl.FRAMEBUFFER,target.fbo);gl.viewport(0,0,c.width,c.height);gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D,resource.texture);gl.uniform1i(prog._u.u_tex,0);
            gl.uniform1f(prog._u.u_grainStrength,0);gl.uniform1f(prog._u.u_chromaCleanup,0);gl.drawArrays(gl.TRIANGLES,0,6);
            return pixels(gl,target.fbo,c.width,c.height);
          } finally { target.dispose(); }
        };
        assert(resource.lfTex===null,'stitched source skips its unused low-frequency texture');
        assert(S360.gpuMem.total()-before===c.width*c.height*4,'stitched source tracks only its source texture');
        const original=readSource();
        const previous=p.getImageData(5,6,1,1),next=new ImageData(new Uint8ClampedArray([220,40,80,255]),1,1);
        resource.updateEdits([{x:5,y:6,pixels:next,previous}]);
        assert(!equal(readSource(),original),'stitched source edits work without a low-frequency texture');
      } finally {
        resource.dispose();
        assert(S360.gpuMem.total()===before,'stitched source releases its only tracked texture');
      }
    }
    // The source cleanup must reduce false chroma blocks without changing their
    // luminance. Exercise the real copy shader used for stitched panoramas.
    {
      const c=document.createElement('canvas');c.width=64;c.height=32;
      const p=c.getContext('2d'),data=p.createImageData(c.width,c.height);
      for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){
        const warm=((x>>3)+(y>>3))%2===0,q=(y*c.width+x)*4;
        data.data.set(warm?[158,128,98,255]:[98,128,158,255],q);
      }
      p.putImageData(data,0,0);
      const resource=S360.prepareSourceTexture(gl,c,ctx.cfg,{gain:[1,1,1]});
      function renderCleanup(grain,chroma,focus=0,radius=1.5){
        const target=S360.createRenderTarget(gl,c.width,c.height,'Cleanup regression');
        try{
          const prog=S360.progs.getCopyProgram();gl.useProgram(prog);gl.bindVertexArray(S360.getQuadVAO(gl));
          gl.bindFramebuffer(gl.FRAMEBUFFER,target.fbo);gl.viewport(0,0,c.width,c.height);
          gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,resource.texture);gl.uniform1i(prog._u.u_tex,0);
          gl.uniform1f(prog._u.u_grainStrength,grain);gl.uniform1f(prog._u.u_chromaCleanup,chroma);
          gl.uniform1f(prog._u.u_focusRecovery,focus);gl.uniform1f(prog._u.u_focusRadius,radius);
          gl.drawArrays(gl.TRIANGLES,0,6);return pixels(gl,target.fbo,c.width,c.height);
        }finally{target.dispose();}
      }
      function renderLowFrequencyCleanup(chroma){
        const fs=`#version 300 es
          precision highp float;in vec2 v_uv;out vec4 fragColor;
          uniform sampler2D u_tex;uniform sampler2D u_low;
          ${S360.CLEANUP_GLSL}
          void main(){fragColor=vec4(s360CleanupSample(u_tex,u_low,v_uv,
            1.0/vec2(textureSize(u_tex,0)),0.0,${chroma.toFixed(1)},1,0),1.0);}`;
        const prog=S360.createProgram(gl,S360.COPY_VS,fs),target=S360.createRenderTarget(gl,c.width,c.height,'Low-frequency cleanup regression');
        try{
          gl.useProgram(prog);gl.bindVertexArray(S360.getQuadVAO(gl));gl.bindFramebuffer(gl.FRAMEBUFFER,target.fbo);gl.viewport(0,0,c.width,c.height);
          gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,resource.texture);gl.uniform1i(gl.getUniformLocation(prog,'u_tex'),0);
          gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,resource.lfTex);gl.uniform1i(gl.getUniformLocation(prog,'u_low'),1);
          gl.drawArrays(gl.TRIANGLES,0,6);return pixels(gl,target.fbo,c.width,c.height);
        }finally{target.dispose();gl.deleteProgram(prog);}
      }
      try{
        const raw=renderCleanup(0,0),clean=renderCleanup(0,2),cleanLow=renderLowFrequencyCleanup(2),focused=renderCleanup(0,0,1,1.5);
        const chromaEnergy=px=>{let sum=0;for(let i=0;i<px.length;i+=4)sum+=Math.abs(px[i]-px[i+1])+Math.abs(px[i+2]-px[i+1]);return sum;};
        const lumaMean=px=>{let sum=0;for(let i=0;i<px.length;i+=4)sum+=(px[i]+2*px[i+1]+px[i+2])*.25;return sum/(px.length/4);};
        assert(chromaEnergy(clean)<chromaEnergy(raw)*.7,'color-block cleanup suppresses alternating yellow/cyan blocks');
        assert(Math.abs(lumaMean(clean)-lumaMean(raw))<1,'color-block cleanup preserves luminance');
        assert(chromaEnergy(cleanLow)<chromaEnergy(raw)*.7,'low-frequency cleanup suppresses alternating yellow/cyan blocks');
        assert(Math.abs(lumaMean(cleanLow)-lumaMean(raw))<1,'low-frequency cleanup preserves luminance');
        assert(!equal(focused,raw),'focus recovery changes source-space edge detail');
        assert(Math.abs(lumaMean(focused)-lumaMean(raw))<1.5,'focus recovery preserves average brightness');
        const sample=(px,x,y)=>Array.from(px.slice((y*c.width+x)*4,(y*c.width+x)*4+3));
        const a=sample(focused,4,4),b=sample(focused,12,4);
        assert((a[0]-a[2])*(b[0]-b[2])<0&&Math.min(a[0],a[2])<a[1]&&a[1]<Math.max(a[0],a[2])&&
          Math.min(b[0],b[2])<b[1]&&b[1]<Math.max(b[0],b[2]),
          'focus recovery preserves chroma ordering');
      }finally{resource.dispose();}
    }
    if(new URLSearchParams(location.search).has('large')){
      const c=document.createElement('canvas');c.width=13824;c.height=6912;
      const p=c.getContext('2d',{willReadFrequently:true});p.fillStyle='#56789a';p.fillRect(0,0,c.width,c.height);
      const before=performance.now(),resource=S360.prepareSourceTexture(gl,c,ctx.cfg,{gain:[1,1,1]});
      gl.finish();const fullMs=performance.now()-before;
      try{
        const cleanupFs=`#version 300 es
          precision highp float;in vec2 v_uv;out vec4 fragColor;
          uniform sampler2D u_tex;uniform sampler2D u_low;
          ${S360.CLEANUP_GLSL}
          void main(){fragColor=vec4(s360CleanupSample(u_tex,u_low,v_uv,
            1.0/vec2(textureSize(u_tex,0)),0.7,1.0,1,0),1.0);}`;
        const cleanupProgram=S360.createProgram(gl,S360.COPY_VS,cleanupFs);
        const cleanupTarget=S360.createRenderTarget(gl,c.width,c.height,'Large cleanup benchmark');
        let cleanupMs;
        try{
          gl.useProgram(cleanupProgram);gl.bindVertexArray(S360.getQuadVAO(gl));gl.bindFramebuffer(gl.FRAMEBUFFER,cleanupTarget.fbo);gl.viewport(0,0,c.width,c.height);
          gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,resource.texture);gl.uniform1i(gl.getUniformLocation(cleanupProgram,'u_tex'),0);
          gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,resource.lfTex);gl.uniform1i(gl.getUniformLocation(cleanupProgram,'u_low'),1);
          const cleanupStart=performance.now();gl.drawArrays(gl.TRIANGLES,0,6);gl.finish();cleanupMs=performance.now()-cleanupStart;
        }finally{gl.bindFramebuffer(gl.FRAMEBUFFER,null);cleanupTarget.dispose();gl.deleteProgram(cleanupProgram);}
        const previous=p.getImageData(6000,3000,64,64),next=new ImageData(new Uint8ClampedArray(64*64*4).fill(255),64,64);
        const start=performance.now();resource.updateEdits([{x:6000,y:3000,pixels:next,previous}]);gl.finish();
        results.push('13824×6912 GPU preparation '+Math.round(fullMs)+' ms; optimized cleanup '+Math.round(cleanupMs)+' ms; 64×64 incremental edit '+Math.round(performance.now()-start)+' ms');
      }finally{resource.dispose();c.width=c.height=1;}
    }
    // Seed the source-dependent rendering and drawing checks with a textured
    // dual-fisheye image. The harness runs from a clean application state.
    {
      const c=document.createElement('canvas');c.width=512;c.height=256;
      const p=c.getContext('2d'),data=p.createImageData(c.width,c.height);
      for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){
        const side=x<256?0:1,cx=side?384:128,dx=x-cx,dy=y-128,r=Math.hypot(dx,dy),i=(y*c.width+x)*4;
        if(r<122){
          const detail=34*Math.sin(dx*.19)+27*Math.cos(dy*.17)+18*Math.sin((dx+dy)*.11);
          data.data[i]=Math.max(8,Math.min(247,side?104+detail:156+detail));
          data.data[i+1]=Math.max(8,Math.min(247,126+detail*.65));
          data.data[i+2]=Math.max(8,Math.min(247,side?166+detail:92+detail));
        }else data.data[i]=data.data[i+1]=data.data[i+2]=12;
        data.data[i+3]=255;
      }
      p.putImageData(data,0,0);
      const blob=await new Promise(resolve=>c.toBlob(resolve,'image/png'));
      const dt=new DataTransfer();dt.items.add(new File([blob],'regression-source.png',{type:'image/png'}));
      const input=document.getElementById('imageLoader');input.files=dt.files;input.dispatchEvent(new Event('change'));
      await until(()=>ctx.getLastBaseName()==='regression-source','synthetic source load');
    }
    // Sharpen OFF must neither build nor retain the half-resolution blur cache
    // in the 2D post pass or the live 3D shader.
    {
      const originalSharpen=ctx.postUniforms.sharpen;
      ctx.postUniforms.sharpen=Math.max(.2,originalSharpen);ctx.renderPano();
      const withBlur=S360.gpuMem.total(),realEnsure=S360.ensureLumBlur;let ensureCalls=0;
      S360.ensureLumBlur=(...args)=>{ensureCalls++;return realEnsure(...args);};
      try {
        ctx.postUniforms.sharpen=0;ctx.renderPano();
        assert(ensureCalls===0,'Sharpen OFF skips the 2D luminance-blur pass');
        assert(S360.gpuMem.total()<withBlur,'Sharpen OFF releases the luminance-blur cache');
        S360.setViewMode('3d',ctx);ensureCalls=0;S360.renderSphere(ctx);
        assert(ensureCalls===0,'Sharpen OFF skips the live 3D luminance-blur pass');
      } finally {
        S360.ensureLumBlur=realEnsure;ctx.postUniforms.sharpen=originalSharpen;S360.setViewMode('2d',ctx);ctx.renderPano();
      }
    }
    // Comparison uses one sphere render and one camera for both complete views.
    {
      const sourceWidth=4100,c=document.createElement('canvas');c.width=sourceWidth;c.height=sourceWidth/2;
      const p=c.getContext('2d');
      p.fillStyle='#d94b35';p.fillRect(0,0,c.width,c.height/2);
      p.fillStyle='#153d78';p.fillRect(0,c.height/2,c.width,c.height/2);
      p.fillStyle='rgba(240,180,60,.35)';for(let x=0;x<c.width;x+=16)p.fillRect(x,0,7,c.height);
      const blob=await new Promise(resolve=>c.toBlob(resolve,'image/png'));
      c.width=c.height=1;
      const dt=new DataTransfer();dt.items.add(new File([blob],'comparison-reference.png',{type:'image/png'}));
      const input=document.getElementById('compareReferenceLoader');input.files=dt.files;input.dispatchEvent(new Event('change'));
      await until(()=>S360.compare.isActive,'comparison reference load');
      const referenceTexture=S360.compare.getTexture();
      assert(referenceTexture.width<sourceWidth&&referenceTexture.width<=4096&&Math.abs(referenceTexture.width/referenceTexture.height-2)<.01,
        'Compare caps and retains a display-sized 2:1 reference');
      assert(ctx.getViewMode()==='3d'&&document.getElementById('resultContainer').classList.contains('compare-active'),'Compare opens a split 3D view');
      const camera=S360.viewer.getSphere();camera.pitch=.7;
      S360.renderSphere(ctx);
      const shown=pixels(gl,null,ctx.panoramaCanvas.width,ctx.panoramaCanvas.height),half=ctx.panoramaCanvas.width>>1;
      let left=0,right=0,count=0;
      for(let y=0;y<ctx.panoramaCanvas.height;y+=8)for(let x=0;x<half;x+=8){
        left+=shown[(y*ctx.panoramaCanvas.width+x)*4];right+=shown[(y*ctx.panoramaCanvas.width+x+half)*4];count++;
      }
      assert(Math.abs(left-right)/count>10,'Compare shows distinct reference and current images');
      const referenceCenter=(Math.floor(ctx.panoramaCanvas.height/2)*ctx.panoramaCanvas.width+Math.floor(half/2))*4;
      assert(shown[referenceCenter]>shown[referenceCenter+2],'Compare reference preserves top-to-bottom orientation');
      camera.pitch=0;S360.renderSphere(ctx);
      const yaw=camera.yaw,rect=ctx.panoramaCanvas.getBoundingClientRect();
      ctx.panoramaCanvas.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:rect.left+rect.width*.25,clientY:rect.top+rect.height*.5}));
      window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:rect.left+rect.width*.25+24,clientY:rect.top+rect.height*.5}));
      window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
      const afterLeft=camera.yaw;
      ctx.panoramaCanvas.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:rect.left+rect.width*.75,clientY:rect.top+rect.height*.5}));
      window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:rect.left+rect.width*.75-24,clientY:rect.top+rect.height*.5}));
      window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
      assert(afterLeft!==yaw&&camera.yaw!==afterLeft,'Dragging either comparison side moves the shared camera');
      const fov=camera.fov;
      ctx.panoramaCanvas.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:rect.left+rect.width*.25,clientY:rect.top+rect.height*.5,deltaY:100}));
      const afterLeftZoom=camera.fov;
      ctx.panoramaCanvas.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:rect.left+rect.width*.75,clientY:rect.top+rect.height*.5,deltaY:-100}));
      assert(afterLeftZoom!==fov&&camera.fov!==afterLeftZoom,'Zooming either comparison side changes the shared camera');
      document.getElementById('drawBrushBtn').click();
      const overlayRect=document.getElementById('drawOverlayCanvas').getBoundingClientRect();
      assert(Math.abs(overlayRect.left-(rect.left+rect.width/2))<2&&Math.abs(overlayRect.width-rect.width/2)<2,'drawing tools stay on the current right side');
      document.getElementById('drawBrushBtn').click();
      document.getElementById('compareBtn').click();
      assert(!S360.compare.isActive&&!document.getElementById('resultContainer').classList.contains('compare-active'),'Compare button closes and releases the reference');
    }
    S360.setViewMode('2d',ctx);
    // Wait for any asynchronous seam result before comparing deterministic renders.
    await until(()=>!S360.stitchSeam.isWorkerBusy,'seam');await pause(350);
    // Real control events must change only their own lens before asynchronous gain refinement.
    const initialHeight={...ctx.cfg.height};
    ctx.cfg.height.left=0;ctx.cfg.height.right=0;ctx.markStitchDirty();ctx.stitchIfNeeded(512,256,true);
    const heightBase=pixels(gl,ctx.getFramebuffer(),512,256);
    for(const [side,key] of [['L','left'],['R','right']]){
      const input=document.getElementById('height'+side);input.value='3.2';input.dispatchEvent(new Event('input'));
      assert(ctx.cfg.height[key]===3.2,'Height '+side+' control updates geometry');
      assert(document.getElementById('height'+side+'Val').textContent==='3.20','Height '+side+' label updates');
      ctx.stitchIfNeeded(512,256,true);const changed=pixels(gl,ctx.getFramebuffer(),512,256);
      let own=0,other=0;
      for(let y=64;y<192;y++)for(let x=0;x<512;x++){
        if(Math.abs(x-128)<16||Math.abs(x-384)<16)continue;
        const i=(y*512+x)*4,d=Math.abs(changed[i]-heightBase[i])+Math.abs(changed[i+2]-heightBase[i+2]);
        const isLeft=x>128&&x<384;if(isLeft===(key==='left'))own+=d;else other+=d;
      }
      assert(own>100,'Height '+side+' changes its lens pixels');assert(other===0,'Height '+side+' preserves opposite lens pixels');
      input.value='0';input.dispatchEvent(new Event('input'));ctx.stitchIfNeeded(512,256,true);
      assert(equal(heightBase,pixels(gl,ctx.getFramebuffer(),512,256)),'Height '+side+' zero restores original pixels');
    }
    Object.assign(ctx.cfg.height,initialHeight);ctx.markStitchDirty();
    const savedCa={red:ctx.cfg.caRed,blue:ctx.cfg.caBlue},savedPreprocess=ctx.cfg.preprocessingEnabled;
    ctx.cfg.preprocessingEnabled=true;ctx.cfg.caRed=0;ctx.cfg.caBlue=0;ctx.markStitchDirty();ctx.stitchIfNeeded(512,256,true);
    const caBase=pixels(gl,ctx.getFramebuffer(),512,256);
    for(const [id,key,value]of [['caRed','caRed',2],['caBlue','caBlue',-2]]){
      const input=document.getElementById(id);input.value=String(value);input.dispatchEvent(new Event('input'));
      assert(ctx.cfg[key]===value,id+' control updates source correction');
      assert(document.getElementById(id+'Val').textContent===value.toFixed(1)+' px',id+' label updates');
      ctx.stitchIfNeeded(512,256,true);
      assert(!equal(caBase,pixels(gl,ctx.getFramebuffer(),512,256)),id+' shifts its source channel radially');
      input.value='0';input.dispatchEvent(new Event('input'));ctx.stitchIfNeeded(512,256,true);
      assert(equal(caBase,pixels(gl,ctx.getFramebuffer(),512,256)),id+' zero restores original pixels');
    }
    ctx.cfg.caRed=savedCa.red;ctx.cfg.caBlue=savedCa.blue;ctx.cfg.preprocessingEnabled=savedPreprocess;ctx.markStitchDirty();
    // Manual Horizon maps two vertical references through the live 3D camera
    // onto great-circle planes, turning the camera around between them.
    if(ctx.getViewMode()!=='2d')S360.setViewMode('2d',ctx);
    ctx.cfg.horizon.pitch=0;ctx.cfg.horizon.roll=0;ctx.cfg.mirror3D=false;ctx.markStitchDirty();ctx.renderPano();
    const desiredPitch=8,desiredRoll=-6,n=S360.horizonLeveling.requiredNormal(desiredPitch,desiredRoll);
    const manualCanvas=document.getElementById('manualHorizonCanvas'),manualRect=()=>manualCanvas.getBoundingClientRect();
    const unit=v=>{const d=Math.hypot(...v);return v.map(q=>q/d);};
    function verticalDirections(seed,span){
      const along=unit(seed.map((v,i)=>v-n[i]*(seed[0]*n[0]+seed[1]*n[1])));
      return[-span,span].map(t=>unit(along.map((q,i)=>q*Math.cos(t)+n[i]*Math.sin(t))));
    }
    function viewPoint(v){
      let d=[-v[1],-v[2],-v[0]];if(ctx.cfg.mirror3D)d[0]=-d[0];
      const c=S360.viewer.getSphere(),s=S360.viewer.getProj(),cp=Math.cos(c.pitch),sp=Math.sin(c.pitch),cy=Math.cos(c.yaw),sy=Math.sin(c.yaw);
      const f=[cp*sy,sp,cp*cy],right=[-cy,0,sy],up=[-sy*sp,cp,-cy*sp];
      const cosine=Math.max(-1,Math.min(1,d[0]*f[0]+d[1]*f[1]+d[2]*f[2])),theta=Math.acos(cosine);
      const edge=Math.tan(s*c.fov/2),k=theta<1e-7?s/edge:Math.tan(s*theta)/(Math.sin(theta)*edge);
      const aspect=manualCanvas.width/manualCanvas.height,qx=(d[0]*right[0]+d[2]*right[2])*k,qy=(d[0]*up[0]+d[1]*up[1]+d[2]*up[2])*k;
      return{x:(qx/aspect+1)/2,y:(1-qy)/2};
    }
    function dragReference(a,b){
      const r=manualRect(),event=(type,p)=>new PointerEvent(type,{bubbles:true,pointerId:41,button:0,clientX:r.left+p.x*r.width,clientY:r.top+p.y*r.height});
      manualCanvas.dispatchEvent(event('pointerdown',a));manualCanvas.dispatchEvent(event('pointermove',b));manualCanvas.dispatchEvent(event('pointerup',b));
    }
    const manualCamera=S360.viewer.getSphere();Object.assign(manualCamera,{yaw:0,pitch:0,fov:1.6});const interactionBefore=ctx.getSphereInteractionEnabled();
    document.getElementById('manualHorizonBtn').click();
    assert(S360.manualHorizon.active&&ctx.getViewMode()==='3d'&&!ctx.getSphereInteractionEnabled(),'Manual Horizon opens and locks the 3D view');
    const panoRect=ctx.getPanoramaCanvas().getBoundingClientRect(),alignedRect=manualRect();
    assert(Math.abs(alignedRect.left-panoRect.left)<1&&Math.abs(alignedRect.top-panoRect.top)<1&&Math.abs(alignedRect.width-panoRect.width)<1&&Math.abs(alignedRect.height-panoRect.height)<1,'Manual Horizon input stays aligned to the displayed image');
    assert(getComputedStyle(manualCanvas).cursor==='none','Manual Horizon hides the system cursor');
    const manualFirst=verticalDirections([-1,-.28,0],.27).map(viewPoint),magnifyPoint=manualFirst[0],mr=manualRect();
    manualCanvas.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:42,clientX:mr.left+magnifyPoint.x*mr.width,clientY:mr.top+magnifyPoint.y*mr.height}));
    assert(manualCanvas.getContext('2d').getImageData(0,0,manualCanvas.width,manualCanvas.height).data.some((v,i)=>i%4===3&&v>0),'Manual Horizon shows a cursor magnifier');
    const dot=manualCanvas.getContext('2d').getImageData(Math.round(magnifyPoint.x*manualCanvas.width),Math.round(magnifyPoint.y*manualCanvas.height),1,1).data;
    assert(dot[0]>240&&dot[1]>240&&dot[2]>240&&dot[3]>0,'Manual Horizon centers a visible spot on the zoom lens');
    const yawBefore=manualCamera.yaw;dragReference(manualFirst[0],manualFirst[1]);
    assert(S360.manualHorizon.active&&Math.abs(Math.abs(manualCamera.yaw-yawBefore)-Math.PI)<1e-6&&document.getElementById('manualHorizonInfo').textContent.includes('180°'),'Manual Horizon turns 180 degrees after the first line');
    const manualSecond=verticalDirections([1,-.28,0],.24).map(viewPoint);dragReference(manualSecond[0],manualSecond[1]);
    assert(!S360.manualHorizon.active&&ctx.getViewMode()==='2d'&&ctx.getSphereInteractionEnabled()===interactionBefore,'Manual Horizon applies and restores the prior view');
    assert(Math.abs(ctx.cfg.horizon.pitch-desiredPitch)<.2&&Math.abs(ctx.cfg.horizon.roll-desiredRoll)<.2,'Manual Horizon recovers spherical pitch and roll');
    assert(document.getElementById('horizonPitchVal').textContent===desiredPitch.toFixed(1)+'°','Manual Horizon updates slider labels');
    let directionIndependent=true;
    for(let order=0;order<4;order++){
      ctx.cfg.horizon.pitch=0;ctx.cfg.horizon.roll=0;ctx.markStitchDirty();ctx.renderPano();
      Object.assign(manualCamera,{yaw:0,pitch:0,fov:1.6});document.getElementById('manualHorizonBtn').click();
      const a=verticalDirections([-1,-.28,0],.31).map(viewPoint);if(order&1)a.reverse();dragReference(a[0],a[1]);
      const b=verticalDirections([1,-.28,0],.16).map(viewPoint);if(order&2)b.reverse();dragReference(b[0],b[1]);
      directionIndependent=directionIndependent&&!S360.manualHorizon.active&&Math.abs(ctx.cfg.horizon.pitch-desiredPitch)<.2&&Math.abs(ctx.cfg.horizon.roll-desiredRoll)<.2;
    }
    assert(directionIndependent,'3D Manual Horizon ignores endpoint order and unequal guide lengths');
    ctx.cfg.horizon.pitch=0;ctx.cfg.horizon.roll=0;Object.assign(manualCamera,{yaw:.4,pitch:.1,fov:1.4});
    document.getElementById('manualHorizonBtn').click();document.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape'}));
    assert(!S360.manualHorizon.active&&ctx.getViewMode()==='2d'&&Math.abs(manualCamera.yaw-.4)<1e-9&&Math.abs(manualCamera.pitch-.1)<1e-9,'ESC cancels Manual Horizon and restores the camera');
    const savedHorizon={...ctx.cfg.horizon};
    ctx.cfg.horizon.pitch=0;ctx.cfg.horizon.roll=0;ctx.markStitchDirty();ctx.stitchIfNeeded(512,256,true);
    const horizonBase=pixels(gl,ctx.getFramebuffer(),512,256);
    for(const [id,key,value]of [['horizonPitch','pitch',8],['horizonRoll','roll',-10]]){
      const input=document.getElementById(id);input.value=String(value);input.dispatchEvent(new Event('input'));
      assert(ctx.cfg.horizon[key]===value,id+' control updates global sphere rotation');
      assert(document.getElementById(id+'Val').textContent===value.toFixed(1)+'°',id+' label updates');
      ctx.stitchIfNeeded(512,256,true);
      assert(!equal(horizonBase,pixels(gl,ctx.getFramebuffer(),512,256)),id+' changes stitched pixels');
      input.value='0';input.dispatchEvent(new Event('input'));ctx.stitchIfNeeded(512,256,true);
      assert(equal(horizonBase,pixels(gl,ctx.getFramebuffer(),512,256)),id+' zero restores original pixels');
    }
    document.getElementById('horizonPitch').value='8';document.getElementById('horizonPitch').dispatchEvent(new Event('input'));
    document.getElementById('horizonRoll').value='-10';document.getElementById('horizonRoll').dispatchEvent(new Event('input'));
    document.getElementById('resetHorizonBtn').click();ctx.stitchIfNeeded(512,256,true);
    assert(ctx.cfg.horizon.pitch===0&&ctx.cfg.horizon.roll===0,'Reset Horizon clears both global rotations');
    assert(document.getElementById('horizonPitchVal').textContent==='0.0°'&&document.getElementById('horizonRollVal').textContent==='0.0°','Reset Horizon updates both labels');
    assert(equal(horizonBase,pixels(gl,ctx.getFramebuffer(),512,256)),'Reset Horizon restores original pixels');
    Object.assign(ctx.cfg.horizon,savedHorizon);ctx.markStitchDirty();
    // Pixel tests of the real stitch shader on both sides of both meeting meridians.
    const savedBlend={...ctx.cfg.blend};
    function seamPixels(shift,width){
      ctx.cfg.blend.seamShift=shift;ctx.cfg.blend.seamWidth=width;
      ctx.markStitchDirty();ctx.stitchIfNeeded(512,256,true);
      return pixels(gl,ctx.getFramebuffer(),512,256);
    }
    for(const width of [.1,.5,1]){
      const left=seamPixels(-1,width),right=seamPixels(1,width),mid=seamPixels(0,width);
      for(const x of [125,128,131,381,384,387]){
        const i=(128*512+x)*4;
        assert(Math.max(...[0,1,2].map(c=>Math.abs(left[i+c]-right[i+c])))>2,
          'both lens choices change pixels at x='+x+' width='+width);
        assert([0,1,2].every(c=>mid[i+c]>=Math.min(left[i+c],right[i+c])-1&&mid[i+c]<=Math.max(left[i+c],right[i+c])+1),
          'neutral seam stays between lens colours at x='+x+' width='+width);
      }
      const minus=seamPixels(-.001,width),plus=seamPixels(.001,width);
      assert(minus.reduce((m,v,i)=>Math.max(m,Math.abs(v-plus[i])),0)<5,'seam is continuous through zero at width='+width);
    }
    Object.assign(ctx.cfg.blend,savedBlend);ctx.markStitchDirty();
    ctx.stitchIfNeeded(512,256,true);const clean=pixels(gl,ctx.getFramebuffer(),512,256);
    document.getElementById('seamBtn').click();ctx.renderPano(512,256);
    const diagnostic=pixels(gl,ctx.getFramebuffer(),512,256);
    assert(!equal(clean,diagnostic),'seam diagnostic changes pixels');
    ctx.stitchIfNeeded(512,256,true);
    assert(equal(clean,pixels(gl,ctx.getFramebuffer(),512,256)),'same-size clean render excludes diagnostics');
    document.getElementById('seamBtn').click();
    ctx.stitchIfNeeded(512,256,true);let tex=ctx.getRenderTexture();
    S360.ensureLumBlur(gl,tex,512,256,1,1);
    const originalCenter=ctx.cfg.centers.left[0];ctx.cfg.centers.left[0]+=.015;ctx.markStitchDirty();ctx.stitchIfNeeded(512,256,true);
    const cached=S360.ensureLumBlur(gl,tex,512,256,1,1);const updated=pixels(gl,cached.fbo,256,128);
    S360.invalidateBlurCache(gl);const fresh=S360.ensureLumBlur(gl,tex,512,256,1,1);
    assert(equal(updated,pixels(gl,fresh.fbo,256,128)),'updated blur equals a fresh recomputation');
    ctx.cfg.centers.left[0]=originalCenter;ctx.markStitchDirty();
    document.getElementById('wmTopRemoveBtn').click();document.getElementById('wmRemoveBtn').click();
    ctx.setPostEnabled(false);ctx.renderPano();
    document.getElementById('downloadLittlePlanetBtn').click();await pause(500);
    const planet=document.getElementById('lpModalCanvas');
    const planetData=planet.getContext('2d').getImageData(0,0,planet.width,planet.height).data;
    assert(planetData.some((v,i)=>i%4!==3&&v>30),'Post OFF little planet contains image pixels');
    assert(gl.getError()===gl.NO_ERROR,'little planet has no GL errors');
    document.getElementById('lpCancelBtn').click();
    S360.setViewMode('3d',ctx);
    const camera=S360.viewer.getSphere(),overlay=document.getElementById('drawOverlayCanvas');
    let seamProbe=0,seamProbeDiff=-1;
    for(let i=0;i<clean.length;i+=4){
      const d=Math.abs(clean[i]-diagnostic[i])+Math.abs(clean[i+1]-diagnostic[i+1])+Math.abs(clean[i+2]-diagnostic[i+2]);
      if(d>seamProbeDiff){seamProbeDiff=d;seamProbe=(i/4)%512;}
    }
    camera.yaw=(seamProbe/512-.5)*Math.PI*2;camera.pitch=0;camera.fov=1.5;
    S360.renderSphere(ctx);const clean3D=pixels(gl,null,ctx.panoramaCanvas.width,ctx.panoramaCanvas.height);
    document.getElementById('seamBtn').click();ctx.renderPano();S360.renderSphere(ctx);
    assert(!equal(clean3D,pixels(gl,null,ctx.panoramaCanvas.width,ctx.panoramaCanvas.height)),'seam diagnostic is visible in 3D');
    document.getElementById('seamBtn').click();ctx.renderPano();S360.renderSphere(ctx);
    const raw=()=>{const image=ctx.getCurrentImg(),c=document.createElement('canvas');c.width=image.width;c.height=image.height;c.getContext('2d').drawImage(image,0,0);return c.getContext('2d').getImageData(0,0,c.width,c.height).data;};
    const viewPixel=(x,y)=>{S360.renderSphere(ctx);const d=pixels(gl,null,ctx.panoramaCanvas.width,ctx.panoramaCanvas.height);const i=((ctx.panoramaCanvas.height-1-Math.floor(y*ctx.panoramaCanvas.height))*ctx.panoramaCanvas.width+Math.floor(x*ctx.panoramaCanvas.width))*4;return Array.from(d.slice(i,i+3));};
    const pointer=(x,y)=>{const r=overlay.getBoundingClientRect();return {bubbles:true,clientX:r.left+r.width*x,clientY:r.top+r.height*y,pointerId:1,button:0};};
    const click=(x,y)=>{const p=pointer(x,y);overlay.dispatchEvent(new PointerEvent('pointerdown',p));overlay.dispatchEvent(new PointerEvent('pointerup',p));};
    const waitEdit=async()=>{await until(()=>!S360.drawing.isBaking,'source edit',60000);if(document.getElementById('cloneHint').textContent.startsWith('Edit failed'))throw Error(document.getElementById('cloneHint').textContent);};
    document.getElementById('cloneFeather').value='0';document.getElementById('cloneFeather').dispatchEvent(new Event('input'));
    document.getElementById('drawBrushSize').value='18';document.getElementById('drawBrushSize').dispatchEvent(new Event('input'));
    for(const [id,value]of [['widthL',-2],['heightL',3],['angleL',4],['widthR',2],['heightR',-1],['angleR',-3]]){
      const input=document.getElementById(id);input.value=String(value);input.dispatchEvent(new Event('input'));
    }
    await pause(400);await until(()=>!S360.stitchSeam.isWorkerBusy,'geometry seam');
    // The main-thread seam fallback invalidates the stitch and queues its redraw.
    // Establish the comparison baseline from that current seam immediately,
    // rather than racing the queued animation frame.
    ctx.renderPano();
    const undoButton=document.getElementById('drawUndoBtn');
    assert(undoButton.previousElementSibling?.id==='compareBtn','Undo sits after Compare in the top action bar');
    assert(!document.getElementById('canvasControlGroup').classList.contains('group-locked'),'OO drawing panel is not visually locked');
    const sidesButton=document.getElementById('drawWarpSidesBtn');sidesButton.click();
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    assert(!S360.viewWarp.active&&!sidesButton.classList.contains('active')&&sidesButton.getAttribute('aria-pressed')==='false'&&!overlay.classList.contains('active'),'ESC fully disarms Pull Sides');
    const initial=raw();camera.yaw=0;camera.pitch=.25;camera.fov=1;S360.renderSphere(ctx);
    const normalPullView=pixels(gl,null,ctx.panoramaCanvas.width,ctx.panoramaCanvas.height);
    document.getElementById('drawWarpCenterBtn').click();
    const armedPullView=pixels(gl,null,ctx.panoramaCanvas.width,ctx.panoramaCanvas.height);
    assert(!equal(normalPullView,armedPullView),'pull button immediately renders the faded reference lens');
    assert(!!S360.viewWarp.active&&!S360.viewWarp.active.moved,'pull preview is armed before pointer movement');
    const pullFov=camera.fov;overlay.dispatchEvent(new WheelEvent('wheel',{deltaY:100,bubbles:true,cancelable:true}));
    assert(camera.fov===pullFov&&!!S360.viewWarp.active&&!equal(normalPullView,pixels(gl,null,ctx.panoramaCanvas.width,ctx.panoramaCanvas.height)),'pull mode locks zoom and retains its reference lens');
    assert(document.getElementById('drawWarpCenterBtn').textContent.includes('Pull Center')&&document.getElementById('drawWarpSidesBtn').textContent.includes('Pull Sides'),'pull tools use the final labels');
    assert(!document.getElementById('warpStrengthRow').hidden&&getComputedStyle(document.getElementById('cloneFeatherRow')).display!=='none'&&getComputedStyle(document.getElementById('cloneAdaptRow')).display!=='none','drawing slider rows remain visible');
    assert(!document.getElementById('drawWarpStrength').disabled&&!document.getElementById('drawBrushSize').disabled&&document.getElementById('cloneFeather').disabled&&document.getElementById('cloneAdapt').disabled,'pull mode enables only its relevant sliders');
    const start=pointer(.42,.5),middle=pointer(.48,.5),end=pointer(.54,.5);
    overlay.dispatchEvent(new PointerEvent('pointerdown',start));
    const shownRadius=Number(document.getElementById('drawBrushSize').value)*overlay.width/overlay.getBoundingClientRect().width;
    assert(Math.abs(S360.viewWarp.active.radius-shownRadius*2)<1e-6,'warp influence radius is twice the shown circle');
    assert(!!S360.viewWarp.active.previewTarget?.selected,'warp preview isolates the selected lens layer');
    assert(!!S360.viewWarp.active.previewTarget?.other,'warp preview includes the dimmed reference lens layer');
    assert(S360.viewWarp.active.previewTarget.selected.width>=overlay.width*3-1,'warp preview uses high-resolution lens layers');
    overlay.dispatchEvent(new PointerEvent('pointermove',middle));
    overlay.dispatchEvent(new PointerEvent('pointermove',end));
    const warpMap=S360.warpGpu.current(S360.viewWarp.active.gpuState),warpProbe=new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER,warpMap.fbo);
    gl.readPixels(Math.floor(warpMap.width*.43),Math.floor(warpMap.height*.51),1,1,gl.RGBA,gl.UNSIGNED_BYTE,warpProbe);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);S360.renderSphere(ctx);
    assert(warpProbe[2]!==0&&warpProbe[3]!==255,'warp preview map retains 16-bit coordinates');
    const preview=pixels(gl,null,ctx.panoramaCanvas.width,ctx.panoramaCanvas.height);
    let lo=255,hi=0;for(let i=0;i<preview.length;i+=4){lo=Math.min(lo,preview[i],preview[i+1],preview[i+2]);hi=Math.max(hi,preview[i],preview[i+1],preview[i+2]);}
    assert(hi-lo>20,'warp preview retains visible image detail');
    assert(gl.getError()===gl.NO_ERROR,'warp preview has no GL errors');
    overlay.dispatchEvent(new PointerEvent('pointerup',end));await waitEdit();
    assert(!document.getElementById('drawWarpCenterBtn').classList.contains('active')&&document.getElementById('drawWarpCenterBtn').getAttribute('aria-pressed')==='false','pull button becomes inactive after drag');
    const warped=raw();let warpLeft=0,warpRight=0,warpW=ctx.getCurrentImg().width;
    for(let i=0;i<warped.length;i+=4)if(warped[i]!==initial[i]||warped[i+1]!==initial[i+1]||warped[i+2]!==initial[i+2]){
      if((i/4)%warpW<warpW/2)warpLeft++;else warpRight++;
    }
    assert(warpLeft>0,'center warp changes selected lens source pixels');
    assert(warpRight===0,'center warp preserves opposite lens source pixels');
    document.getElementById('drawUndoBtn').click();
    assert(equal(initial,raw()),'Undo restores pixels before center warp');
    S360.renderSphere(ctx);
    assert(equal(normalPullView,pixels(gl,null,ctx.panoramaCanvas.width,ctx.panoramaCanvas.height)),'center-warp Undo restores the exact 3D frame');
    const realAutoWarp=S360.autoWarp.buildMap;
    S360.autoWarp.buildMap=async()=>{
      const width=128,height=64,map=S360.warpProjection.makeMap(width,height);
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*2;map[i]=x+1.25;}
      return {map,width,height,matches:12,moved:true};
    };
    const autoBefore=raw();document.getElementById('autoMorphBtn').click();await waitEdit();S360.autoWarp.buildMap=realAutoWarp;
    const autoAfter=raw();let autoLeft=0,autoRight=0;warpW=ctx.getCurrentImg().width;
    for(let i=0;i<autoAfter.length;i+=4)if(autoAfter[i]!==autoBefore[i]||autoAfter[i+1]!==autoBefore[i+1]||autoAfter[i+2]!==autoBefore[i+2]){
      if((i/4)%warpW<warpW/2)autoLeft++;else autoRight++;
    }
    assert(autoLeft>0&&autoRight===0,'automatic center warp bakes only the selected lens');
    document.getElementById('drawUndoBtn').click();assert(equal(autoBefore,raw()),'one Undo restores the automatic warp');
    S360.renderSphere(ctx);
    assert(equal(normalPullView,pixels(gl,null,ctx.panoramaCanvas.width,ctx.panoramaCanvas.height)),'automatic-warp Undo restores the exact 3D frame');
    let markerArgs=null;
    S360.autoWarp.buildMap=async args=>{
      markerArgs=args;const width=128,height=64,map=S360.warpProjection.makeMap(width,height);
      for(let i=0;i<map.length;i+=2)map[i]+=1.25;
      return {map,width,height,matches:9,moved:true,overlap:true};
    };
    const markerBefore=raw();document.getElementById('morph8x1Btn').click();
    overlay.dispatchEvent(new PointerEvent('pointerdown',pointer(.5,.5)));await waitEdit();S360.autoWarp.buildMap=realAutoWarp;
    assert(markerArgs?.focus&&markerArgs.fullPanorama===false&&Math.abs(markerArgs.focus.radiusX/markerArgs.focus.radiusY-8)<.01,'8:1 morph brush sends one strictly local 8:1 region');
    assert(!equal(markerBefore,raw()),'Morph Marker bakes a local source edit');
    document.getElementById('drawUndoBtn').click();assert(equal(markerBefore,raw()),'one Undo restores the marker morph');
    S360.renderSphere(ctx);
    const pullAfter=pixels(gl,null,ctx.panoramaCanvas.width,ctx.panoramaCanvas.height);
    const pullExposureRestored=equal(normalPullView,pullAfter);
    let pullDiff=0,pullMax=0;
    for(let i=0;i<pullAfter.length;i++){const d=Math.abs(pullAfter[i]-normalPullView[i]);if(d){pullDiff++;pullMax=Math.max(pullMax,d);}}
    document.getElementById('drawWarpCenterBtn').click();
    // ?status makes the first fallback job long enough for visual inspection.
    if(new URLSearchParams(location.search).has('status')){
      const project=S360.drawingProjection.tiles;
      S360.drawingProjection.tiles=function*(args){
        S360.drawingProjection.tiles=project;
        const end=performance.now()+5000;while(performance.now()<end)yield null;
        yield*project(args);
      };
    }
    document.getElementById('drawBrushBtn').click();click(.5,.5);
    assert(!document.getElementById('drawingBusy').classList.contains('hidden'),'Projecting indicator appears on pointer release');
    await waitEdit();
    assert(!undoButton.disabled&&undoButton.classList.contains('fusion-btn'),'available Undo uses the exposure-fusion orange state');
    assert(document.getElementById('drawingBusy').classList.contains('hidden'),'Projecting indicator closes after the updated view');
    assert(!ctx.getStitched(),'painting OO does not convert it to a stitched source');
    assert(!equal(initial,raw()),'pointer release changes the actual OO source pixels');
    assert(viewPixel(.5,.5).every((v,i)=>Math.abs(v-[255,102,102][i])<5),'OO stroke returns to its exact view position');
    const first=raw();click(.65,.55);await waitEdit();const second=raw();
    assert(!equal(first,second),'armed brush commits a second independent stroke');
    document.getElementById('drawUndoBtn').click();assert(equal(first,raw()),'one Undo restores the previous source pixels');
    assert(undoButton.disabled&&!undoButton.classList.contains('fusion-btn'),'used Undo returns to its disabled neutral state');
    document.getElementById('drawUndoBtn').click();assert(equal(first,raw()),'Undo cannot remove an older stroke');
    // Seam view points at both lens rims: edits must be present in both raw halves.
    camera.yaw=Math.PI/2;camera.pitch=.15;S360.renderSphere(ctx);const seamBefore=raw();click(.5,.5);await waitEdit();const seamAfter=raw();
    let changedL=0,changedR=0,W=ctx.getCurrentImg().width;
    for(let i=0;i<seamAfter.length;i+=4)if(seamAfter[i]!==seamBefore[i]){if((i/4)%W<W/2)changedL++;else changedR++;}
    assert(changedL>0&&changedR>0,'a seam stroke is baked into both lens images');
    document.getElementById('drawBrushBtn').click();
    Object.assign(ctx.cfg,{denoiseStrength:1.1,chromaCleanup:.7,focusRecovery:.35,focusRadius:1.5});
    ctx.markStitchDirty();ctx.renderPano();await pause(100);S360.renderSphere(ctx);
    const preprocessedBeforeConversion=pixels(gl,null,ctx.panoramaCanvas.width,ctx.panoramaCanvas.height);
    document.getElementById('convertToStitchedBtn').click();await until(()=>ctx.getStitched()&&!document.getElementById('convertToStitchedBtn').disabled,'convert');
    assert(!S360.sourceEdit.canUndo,'source conversion clears stale Undo');
    S360.renderSphere(ctx);
    assert(equal(preprocessedBeforeConversion,pixels(gl,null,ctx.panoramaCanvas.width,ctx.panoramaCanvas.height)),'conversion preserves preprocessing exactly once');
    assert(pullExposureRestored,`pull completion restores normal lens exposure (diff ${pullDiff}, max ${pullMax}, preview ${!!S360.viewWarp._previewTex}/${!!S360.viewWarp._previewLensTex}/${!!S360.viewWarp._previewOtherTex})`);
    for(const [proj,yaw,pitch,fov,x,y,mirror]of [[1,.7,.3,1,.5,.5,false],[.5,-2,1.45,1.6,.6,.45,true],[.05,3,-1.4,2.2,.85,.5,false]]){
      S360.viewer.setProj(proj);camera.yaw=yaw;camera.pitch=pitch;camera.fov=fov;ctx.cfg.mirror3D=mirror;S360.renderSphere(ctx);
      const before=raw();document.getElementById('drawBrushBtn').click();click(x,y);await waitEdit();
      assert(!equal(before,raw()),'stitched source changes for projection '+proj);
      const painted=viewPixel(x,y);
      assert(painted.every((v,i)=>Math.abs(v-[255,102,102][i])<6),'stroke stays under pointer at projection '+proj+' mirror='+mirror+' (got '+painted.join(',')+')');
      document.getElementById('drawBrushBtn').click();
    }
    // A view change before pointer-up must still commit using the captured camera.
    S360.viewer.setProj(1);camera.yaw=0;camera.pitch=0;camera.fov=1;ctx.cfg.mirror3D=false;S360.renderSphere(ctx);
    document.getElementById('drawLineBtn').click();const p=pointer(.4,.5);overlay.dispatchEvent(new PointerEvent('pointerdown',p));
    overlay.dispatchEvent(new PointerEvent('pointermove',pointer(.6,.5)));S360.viewer.setProj(.5);await waitEdit();
    S360.viewer.setProj(1);S360.renderSphere(ctx);assert(viewPixel(.5,.5)[0]>245,'changing projection finishes a line in its captured view');
    document.getElementById('drawLineBtn').click();
    // Blur Area censors content under a stroke; Strength is a brush-radius ratio.
    camera.yaw=.6;camera.pitch=.2;camera.fov=1.3;S360.renderSphere(ctx);
    document.getElementById('drawBrushSize').value='64';document.getElementById('drawBrushSize').dispatchEvent(new Event('input'));
    document.getElementById('drawWarpStrength').value='2';document.getElementById('drawWarpStrength').dispatchEvent(new Event('input'));
    const tvStrip=()=>{const vs=[];for(let i=0;i<21;i++)vs.push(viewPixel(.47+i*.003,.5).reduce((a,v)=>a+v,0)/3);let tv=0;for(let i=1;i<vs.length;i++)tv+=Math.abs(vs[i]-vs[i-1]);return tv;};
    const preBlur=raw(),preTV=tvStrip();
    document.getElementById('drawBlurBtn').click();
    const dragP=(x,y)=>{const p=pointer(x,y);p.buttons=1;return p;};
    overlay.dispatchEvent(new PointerEvent('pointerdown',pointer(.45,.5)));
    overlay.dispatchEvent(new PointerEvent('pointermove',dragP(.5,.5)));
    overlay.dispatchEvent(new PointerEvent('pointermove',dragP(.55,.5)));
    overlay.dispatchEvent(new PointerEvent('pointerup',pointer(.55,.5)));
    await waitEdit();
    assert(!equal(preBlur,raw()),'Blur Area commits a source edit');
    assert(tvStrip()<preTV,'Blur Area smooths local contrast under the stroke');
    document.getElementById('drawBrushSize').value='18';document.getElementById('drawBrushSize').dispatchEvent(new Event('input'));
    document.getElementById('drawWarpStrength').value='1';document.getElementById('drawWarpStrength').dispatchEvent(new Event('input'));
    document.getElementById('drawBlurBtn').click();
    // Heal remains a two-step tool; capture only raw scene colour, without decals/post.
    camera.yaw=.6;camera.pitch=.2;camera.fov=1.3;S360.renderSphere(ctx);
    const healBefore=raw();document.getElementById('drawHealBtn').click();
    const healFov=camera.fov;overlay.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true,cancelable:true}));
    assert(camera.fov===healFov,'Heal mode locks zoom');click(.5,.5);
    assert(equal(healBefore,raw()),'Heal selection alone leaves source unchanged');
    overlay.dispatchEvent(new PointerEvent('pointermove',pointer(.7,.6)));click(.7,.6);await waitEdit();
    assert(!equal(healBefore,raw()),'Heal confirmation bakes into source');
    document.getElementById('drawUndoBtn').click();assert(equal(healBefore,raw()),'Undo restores pixels before Heal');
    // Pending work cannot commit after cancellation.
    document.getElementById('drawBrushBtn').click();const cancelBefore=raw();click(.3,.4);document.getElementById('drawUndoBtn').click();await pause(100);
    assert(equal(cancelBefore,raw()),'Undo cancels an unfinished projection');document.getElementById('drawBrushBtn').click();
    const beforeLoss=raw(),ext=gl.getExtension('WEBGL_lose_context');
    const lost=new Promise(resolve=>ctx.panoramaCanvas.addEventListener('webglcontextlost',resolve,{once:true}));
    const restored=new Promise(resolve=>ctx.panoramaCanvas.addEventListener('webglcontextrestored',resolve,{once:true}));
    ext.loseContext();await lost;await pause(100);ext.restoreContext();await restored;await pause(300);
    assert(equal(beforeLoss,raw()),'edited source pixels survive real context restoration');
    assert(S360.viewer.getSphere()===camera,'camera survives context restoration');assert(gl.getError()===gl.NO_ERROR,'edited source restores without GL errors');
    S360.setViewMode('2d',ctx);
    assert(getComputedStyle(document.getElementById('drawing3dOverlay')).display==='flex','2D tools have their blocking overlay');
    assert(document.getElementById('drawingToolsRow').inert,'2D tools also block keyboard activation');
    // Exercise every multi-frame entry point through its real file input.
    const fixture=document.createElement('canvas');fixture.width=128;fixture.height=64;
    const paint=fixture.getContext('2d');
    for(let y=0;y<64;y++)for(let x=0;x<128;x++) {
      paint.fillStyle=`rgb(${40+(x*17+y*7)%160},${40+(x*5+y*13)%160},${40+(x*11+y*3)%160})`;
      paint.fillRect(x,y,1,1);
    }
    const blob=await new Promise(resolve=>fixture.toBlob(resolve,'image/png'));
    assert(document.getElementById('fusionContrast')&&document.getElementById('fusionSaturation')&&document.getElementById('fusionWellExposed'),'Exposure Fusion exposes only its three quality measures');
    assert(document.querySelector('label[for="fusionSaturation"]').textContent.trim()==='Recovered Color','fusion colour control uses its output-facing name');
    const balanceSlider=document.getElementById('fusionWellExposed'),balanceLabel=document.getElementById('fusionWellExposedVal');
    balanceSlider.value=2;balanceSlider.dispatchEvent(new Event('input',{bubbles:true}));assert(balanceLabel.textContent==='100%','previous Exposure Balance maximum is labelled 100%');
    balanceSlider.value=4;balanceSlider.dispatchEvent(new Event('input',{bubbles:true}));assert(balanceLabel.textContent==='200%','Exposure Balance extends to 200%');
    balanceSlider.value=1;balanceSlider.dispatchEvent(new Event('input',{bubbles:true}));
    assert(!document.getElementById('hdrEV')&&!document.getElementById('hdrBase'),'legacy HDR controls are removed');
    const makeFusionExposure=async(index)=>{
      const c=document.createElement('canvas');c.width=96;c.height=48;const p=c.getContext('2d');
      for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){
        const useful=index===0?x<c.width/2:x>=c.width/2;
        const stripe=((x>>2)&1)?32:-32;
        const v=useful?128+stripe:(index===0?250:5);
        p.fillStyle=`rgb(${Math.max(0,Math.min(255,v+18))},${v},${Math.max(0,v-18)})`;p.fillRect(x,y,1,1);
      }
      const b=await new Promise(resolve=>c.toBlob(resolve,'image/png'));
      return new File([b],`fusion-${index}.png`,{type:'image/png'});
    };
    const fusionFiles=await Promise.all([makeFusionExposure(0),makeFusionExposure(1)]);
    const fusionAnalysis={stitched:true,frames:fusionFiles.map(()=>({offset:[0,0],sourceSize:[96,48],confidence:1}))};
    const fusionResult=await S360.processAndMergeExposureFusion(gl,{exposureFusion:{contrast:1,saturation:1,wellExposed:1}},fusionFiles,()=>{},img=>img,S360.loadImageFromFile,64,'Exposure Fusion',()=>false,fusionAnalysis);
    const fusionPixels=pixels(gl,fusionResult.framebuffer,fusionResult.width,fusionResult.height);let leftDetail=0,rightDetail=0;
    for(let y=0;y<fusionResult.height;y++)for(let x=1;x<fusionResult.width;x++){
      const i=(y*fusionResult.width+x)*4,d=Math.abs(fusionPixels[i]-fusionPixels[i-4]);
      if(x<fusionResult.width/2)leftDetail+=d;else rightDetail+=d;
    }
    assert(leftDetail>1000&&rightDetail>1000,'Exposure Fusion retains detail from complementary exposures');
    assert(gl.getError()===gl.NO_ERROR,'native-resolution Exposure Fusion has no GL errors');fusionResult.dispose();
    const makeCleanMergeFrame=async(noisy,name)=>{
      const c=document.createElement('canvas');c.width=64;c.height=32;const p=c.getContext('2d');
      for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){const v=noisy?(((x+y)&1)?184:72):128;p.fillStyle=`rgb(${v},${v},${v})`;p.fillRect(x,y,1,1);}
      const b=await new Promise(resolve=>c.toBlob(resolve,'image/png'));return new File([b],name,{type:'image/png'});
    };
    const cleanFiles=await Promise.all([makeCleanMergeFrame(false,'clean-reference.png'),makeCleanMergeFrame(true,'noisy-alternate.png')]);
    const cleanAnalysis={referenceIndex:0,stitched:true,frames:[0,1].map(()=>({offset:[0,0],sourceSize:[64,32],confidence:1,median:.5}))};
    const cleanResult=await S360.processAndMergeExposureFusion(gl,ctx.cfg,cleanFiles,()=>{},img=>img,S360.loadImageFromFile,64,'Exposure Fusion',()=>false,cleanAnalysis);
    const cleanPixels=pixels(gl,cleanResult.framebuffer,64,32),values=[];
    for(let y=3;y<29;y++)for(let x=3;x<61;x++)values.push(cleanPixels[(y*64+x)*4]);
    const cleanMean=values.reduce((a,b)=>a+b,0)/values.length,cleanSd=Math.sqrt(values.reduce((a,b)=>a+(b-cleanMean)**2,0)/values.length);
    assert(cleanSd<3,'reference-guided fusion rejects unmatched high-frequency noise');
    assert(cleanMean>120&&cleanMean<136,'fusion tone finish preserves a balanced midtone');
    assert(gl.getError()===gl.NO_ERROR,'reference-guided merge and tone finish have no GL errors');cleanResult.dispose();
    const makeKitchenExposure=async(level,name)=>{
      const c=document.createElement('canvas');c.width=96;c.height=48;const p=c.getContext('2d');
      const room=[75,158,205][level];p.fillStyle=`rgb(${room},${room},${room})`;p.fillRect(0,0,96,48);
      for(let x=34;x<62;x++){const window=level===0?(((x>>1)&1)?115:80):250;p.fillStyle=`rgb(${window},${window},${window})`;p.fillRect(x,9,1,30);}
      const b=await new Promise(resolve=>c.toBlob(resolve,'image/png'));return new File([b],name,{type:'image/png'});
    };
    const kitchenFiles=await Promise.all([makeKitchenExposure(0,'kitchen-dark.png'),makeKitchenExposure(1,'kitchen-base.png'),makeKitchenExposure(2,'kitchen-bright.png')]);
    const kitchenAnalysis={referenceIndex:1,stitched:true,frames:[.294,.62,.804].map(median=>({offset:[0,0],sourceSize:[96,48],confidence:1,median}))};
    const kitchenResult=await S360.processAndMergeExposureFusion(gl,ctx.cfg,kitchenFiles,()=>{},img=>img,S360.loadImageFromFile,64,'Exposure Fusion',()=>false,kitchenAnalysis);
    const kitchenPixels=pixels(gl,kitchenResult.framebuffer,96,48),roomValue=kitchenPixels[(24*96+15)*4];let windowDetail=0;
    for(let x=35;x<62;x++)windowDetail+=Math.abs(kitchenPixels[(24*96+x)*4]-kitchenPixels[(24*96+x-1)*4]);
    assert(roomValue>145&&roomValue<175,'fusion keeps an already-bright room near its balanced reference');
    assert(windowDetail>80,`gradient-guided recovery brings detail back into a clipped window (${windowDetail})`);
    assert(gl.getError()===gl.NO_ERROR,'gradient-guided highlight recovery has no GL errors');kitchenResult.dispose();
    const fusionVariant=async(files,analysis,settings)=>{
      const result=await S360.processAndMergeExposureFusion(gl,{exposureFusion:settings},files,()=>{},img=>img,S360.loadImageFromFile,64,'Exposure Fusion',()=>false,analysis);
      const out=pixels(gl,result.framebuffer,result.width,result.height);result.dispose();return out;
    };
    const pixelDifference=(a,b)=>a.reduce((sum,value,i)=>sum+(i%4===3?0:Math.abs(value-b[i])),0);
    const detailOff=await fusionVariant(fusionFiles,fusionAnalysis,{contrast:0,saturation:1,wellExposed:1});
    const detailFull=await fusionVariant(fusionFiles,fusionAnalysis,{contrast:2,saturation:1,wellExposed:1});
    assert(pixelDifference(detailOff,detailFull)>500,'Detail endpoints visibly change the fused pixels');
    const balanceOff=await fusionVariant(kitchenFiles,kitchenAnalysis,{contrast:1,saturation:1,wellExposed:0});
    const balanceFull=await fusionVariant(kitchenFiles,kitchenAnalysis,{contrast:1,saturation:1,wellExposed:2});
    assert(pixelDifference(balanceOff,balanceFull)>500,'Exposure Balance endpoints visibly change clipped-region recovery');
    const balanceDouble=await fusionVariant(kitchenFiles,kitchenAnalysis,{contrast:1,saturation:1,wellExposed:4});
    assert(pixelDifference(balanceFull,balanceDouble)>150,'Exposure Balance 200% extends recovery beyond the previous maximum');
    const makeColorExposure=async(alternate,name)=>{
      const c=document.createElement('canvas');c.width=48;c.height=24;const p=c.getContext('2d');p.fillStyle='rgb(128,128,128)';p.fillRect(0,0,48,24);
      for(let x=24;x<48;x++){p.fillStyle=alternate?(x&2?'rgb(126,82,68)':'rgb(82,126,68)'):'rgb(250,250,250)';p.fillRect(x,0,1,24);}
      const b=await new Promise(resolve=>c.toBlob(resolve,'image/png'));return new File([b],name,{type:'image/png'});
    };
    const colorFiles=await Promise.all([makeColorExposure(false,'color-reference.png'),makeColorExposure(true,'color-alternate.png')]);
    const colorAnalysis={referenceIndex:0,stitched:true,frames:[.62,.38].map(median=>({offset:[0,0],sourceSize:[48,24],confidence:1,median}))};
    const colorOff=await fusionVariant(colorFiles,colorAnalysis,{contrast:1,saturation:0,wellExposed:2});
    const colorFull=await fusionVariant(colorFiles,colorAnalysis,{contrast:1,saturation:2,wellExposed:2});
    assert(pixelDifference(colorOff,colorFull)>250,'Color endpoints visibly change recovered-region chroma');
    assert(gl.getError()===gl.NO_ERROR,'fusion control endpoint comparisons have no GL errors');
    {
      const makeRegistrationFrame=async(shifts,name)=>{
        const c=document.createElement('canvas');c.width=512;c.height=256;const p=c.getContext('2d'),data=p.createImageData(c.width,c.height);
        const signal=(x,y)=>128+42*Math.sin(x*.173)+31*Math.cos(y*.137)+24*Math.sin((x+y)*.091)+13*Math.cos((x-y)*.23);
        for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){
          const spec=x<256?shifts.left:shifts.right,shift=typeof spec==='function'?spec(x,y):spec;
          const v=Math.max(4,Math.min(251,signal(x-shift[0],y-shift[1]))),i=(y*c.width+x)*4;
          data.data[i]=v;data.data[i+1]=Math.max(0,v-12);data.data[i+2]=Math.min(255,v+9);data.data[i+3]=255;
        }
        p.putImageData(data,0,0);const b=await new Promise(resolve=>c.toBlob(resolve,'image/png'));
        return new File([b],name,{type:'image/png'});
      };
      const regFiles=await Promise.all([
        makeRegistrationFrame({left:[0,0],right:[0,0]},'registration-a.png'),
        makeRegistrationFrame({
          left:(x,y)=>[1.4+.9*(x-128)/128-.45*(y-128)/128,.65+.35*(x-128)/128],
          right:(x,y)=>[-1.35-.75*(x-384)/128+.5*(y-128)/128,-.55-.3*(y-128)/128]
        },'registration-b.png')
      ]);
      const registration=await S360.analyzeFrameFiles(regFiles,S360.loadImageFromFile,()=>{},()=>false,false,ctx.cfg);
      const moving=registration.frames[registration.referenceIndex===0?1:0],direction=registration.referenceIndex===0?1:-1;
      assert(moving.nativeRegistration.leftCount>=2&&moving.nativeRegistration.rightCount>=2,'native registration uses multiple patches from each lens');
      assert(Math.abs(moving.lensOffsets.left[0]-direction*1.4)<.35,'native registration refines the left lens to a fractional pixel');
      assert(Math.abs(moving.lensOffsets.right[0]+direction*1.35)<.35,'native registration refines the right lens independently');
      assert(Math.sign(moving.lensTransforms.left.x[1])===direction,'left lens retains spatially varying subpixel motion');
      assert(Math.sign(moving.lensTransforms.right.x[1])===-direction,'right lens retains its independent local motion');
    }
    const variants=[['blendImageLoader',false],['exposureFusionImageLoader',false],['stitchedBlendLoader',true],['stitchedExposureFusionLoader',true]];
    for(const [inputId,stitched] of variants) {
      const dt=new DataTransfer();dt.items.add(new File([blob],inputId+'-a.png',{type:'image/png'}));dt.items.add(new File([blob],inputId+'-b.png',{type:'image/png'}));
      const input=document.getElementById(inputId),realScale=S360.scaleSource;let scaleCalls=0;
      if(inputId==='exposureFusionImageLoader')S360.scaleSource=(...args)=>{scaleCalls++;return realScale(...args);};
      try {
        input.files=dt.files;input.dispatchEvent(new Event('change'));
        await until(()=>ctx.getLastBaseName().startsWith(inputId),'merge '+inputId);
      } finally { S360.scaleSource=realScale; }
      assert(ctx.getStitched()===stitched,inputId+' commits the correct projection');
      assert(gl.isTexture(ctx.getRenderTexture()),inputId+' produces a live panorama');
      assert(gl.getError()===gl.NO_ERROR,inputId+' has no GL errors');
      // OO analysis performs two proxy loads and two native-registration loads;
      // fusion adds one reference and one non-reference load. A seventh call
      // would mean the prepared reference was redundantly scaled again.
      if(inputId==='exposureFusionImageLoader')assert(scaleCalls===6,'Exposure Fusion reuses its prepared reference frame');
      if(inputId==='blendImageLoader'){
        assert(ctx.getCurrentImg().isGpuImage,'merge fixture begins as a GPU-only source');
        await until(()=>!S360.stitchSeam.isWorkerBusy,'merged source seam');
        ctx.stitchIfNeeded(128,64,true);const gpuBefore=pixels(gl,ctx.getFramebuffer(),128,64);
        S360.setViewMode('3d',ctx);camera.yaw=0;camera.pitch=.25;camera.fov=1;S360.viewer.setProj(1);S360.renderSphere(ctx);
        document.getElementById('drawBrushBtn').click();click(.5,.5);await S360.drawing.flush();
        assert(!ctx.getCurrentImg().isGpuImage,'editing adopts a recoverable CPU source from a GPU merge');
        document.getElementById('drawBrushBtn').click();document.getElementById('drawUndoBtn').click();ctx.stitchIfNeeded(128,64,true);
        assert(equal(gpuBefore,pixels(gl,ctx.getFramebuffer(),128,64)),'GPU source readback and Undo preserve exact orientation and pixels');
        S360.setViewMode('2d',ctx);
      }
    }
    {
      const sourceWidth=ctx.getCurrentImg().width,x2=document.getElementById('x2Btn');
      const orientation=document.createElement('canvas');orientation.width=32;orientation.height=16;
      const painter=orientation.getContext('2d');
      painter.fillStyle='#ff0000';painter.fillRect(0,0,16,8);
      painter.fillStyle='#00ff00';painter.fillRect(16,0,16,8);
      painter.fillStyle='#0000ff';painter.fillRect(0,8,16,8);
      painter.fillStyle='#ffffff';painter.fillRect(16,8,16,8);
      const enlarged=S360.scaleSource(gl,orientation,2,ctx.MAX_TEX_SIZE),ep=enlarged.getContext('2d').getImageData(0,0,64,32).data;
      const rgb=(x,y)=>Array.from(ep.slice((y*64+x)*4,(y*64+x)*4+3)).join(',');
      assert(rgb(16,8)==='255,0,0'&&rgb(48,8)==='0,255,0'&&rgb(16,24)==='0,0,255'&&rgb(48,24)==='255,255,255','Lanczos HD preserves colours and source orientation');
      assert(ctx.getScaleValue()===1,'HD regression begins disabled');
      assert(x2.textContent.trim()==='HD'&&!x2.classList.contains('active')&&x2.getAttribute('aria-pressed')==='false','HD uses the standard inactive button state');
      x2.click();
      assert(x2.getAttribute('aria-pressed')==='true'&&x2.classList.contains('active'),'HD visibly activates');
      assert(ctx.getCurrentImg().width===sourceWidth,'HD toggle configures subsequent loads');
      for(const inputId of ['imageLoader','exposureFusionImageLoader','blendImageLoader']){
        const dt=new DataTransfer();
        dt.items.add(new File([blob],inputId+'-hd-a.png',{type:'image/png'}));
        if(inputId!=='imageLoader')dt.items.add(new File([blob],inputId+'-hd-b.png',{type:'image/png'}));
        const input=document.getElementById(inputId);input.files=dt.files;input.dispatchEvent(new Event('change'));
        await until(()=>ctx.getLastBaseName().startsWith(inputId+'-hd'),'HD '+inputId);
        assert(ctx.getCurrentImg().width===256&&ctx.getCurrentImg().height===128,inputId+' prepares doubled sources');
        ctx.stitchIfNeeded(256,128,true);
        assert(ctx.getRenderTexture().width===256,inputId+' does not double output again');
        assert(gl.getError()===gl.NO_ERROR,inputId+' HD has no GPU errors');
      }
      x2.click();
      assert(x2.getAttribute('aria-pressed')==='false','HD visibly deactivates');
    }
    if(new URLSearchParams(location.search).has('workers'))assert(window.__bakeWorkers>0,'source edits ran in real Workers');
    if(new URLSearchParams(location.search).has('drawing'))return;
    // Processing sliders must update their value labels through the real input path.
    const exposure=document.getElementById('exposure');
    exposure.value='2';exposure.dispatchEvent(new Event('input'));
    assert(document.getElementById('exposureVal').textContent==='2.00','processing slider updates its value label');
    exposure.value='1';exposure.dispatchEvent(new Event('input'));
    assert(!window.__errs.length,'browser regression has no JavaScript errors ('+window.__errs.join(' | ')+')');
  })().then(()=>finish('PASS')).catch(error=>finish('FAIL '+error.message));
  function finish(status) {
    const pre=document.createElement('pre');pre.id='regression-result';
    pre.textContent='BROWSER-REGRESSION: '+status+'\n'+results.join('\n');document.body.appendChild(pre);
    fetch('/report',{method:'POST',body:pre.textContent}).catch(()=>{});
  }
});
